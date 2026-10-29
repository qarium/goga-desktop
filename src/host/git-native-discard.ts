import path from "node:path";
import {
  createDiscardGuard,
  GitDiscardRecoveryActions,
} from "./git-discard-recovery";
import type { ScopeRef } from "../shared/context";
import type {
  GitDiscardRequest,
  GitDiscardPreview,
} from "../shared/git-discard";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fchmodSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  linkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import {
  GitDiscardActions,
  gitDiscardStateFingerprint,
  type GitDiscardState,
  type GitDiscardTicket,
} from "./git-discard-actions";
import type { GitCommitContext } from "./git-workspace-actions";
import type { NativeGitOperationResult } from "../shared/git-native-operation";
import type { GitDiscardResult } from "../shared/git-discard";
import { nativeIntent } from "./git-native-context";
import {
  assertNativeGitState,
  assertNoNativeGitLocks,
  type NativeGitState,
} from "./git-native-state";
import { assertParents, directory, regular, stat } from "./git-conflict-state";
import { ByteCommandError } from "./process";

const stale = () =>
  Error(
    "Состояние Git изменилось. Материалы восстановления сохранены; требуется проверка.",
  );
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function entries(state: NativeGitState, except: string[] = []) {
  return Buffer.from(state.indexData, "base64")
    .toString("utf8")
    .split("\0")
    .filter((row) => row && !except.includes(row.slice(row.indexOf("\t") + 1)))
    .sort();
}
function writeNew(name: string, bytes: Buffer, mode: number) {
  const fd = openSync(
    name,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(name: string) {
  const fd = openSync(
    name,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Shared admission/preview, new writer only. No binary index backup, serializer,
 * object publication or native-to-legacy fallback. Used by Host; no legacy execution path. */
export class NativeGitDiscardActions extends GitDiscardActions {
  private recoveryActions?: GitDiscardRecoveryActions;
  private recovery() {
    return (this.recoveryActions ??= new GitDiscardRecoveryActions(
      this.options.context,
      () => this.now(),
    ));
  }
  inspectRecovery(scope: ScopeRef) {
    return this.recovery().inspect(scope);
  }
  prepareRecovery(input: unknown) {
    return this.recovery().prepare(input);
  }
  executeRecovery(token: string) {
    return this.recovery().execute(token);
  }
  override async prepare(input: GitDiscardRequest): Promise<GitDiscardPreview> {
    const preview = await super.prepare(input);
    if (
      Buffer.byteLength(
        JSON.stringify(["discard", preview.paths, preview.items]),
      ) > 65536
    )
      throw Error(
        "Слишком большой список для безопасного восстановления отмены. Выберите меньше файлов и подтвердите их отдельно.",
      );
    const message = await this.recovery().bindDiscard(preview);
    return message ? { ...preview, recoveryMessage: message } : preview;
  }
  protected override async transact(
    c: GitCommitContext,
    t: GitDiscardTicket,
    s: GitDiscardState,
    onVerified: (cleanup: () => Promise<void>) => void,
  ): Promise<GitDiscardResult> {
    const names = t.preview.paths,
      snapshot = await c.snapshot();
    const protectedPaths = [
      ...new Set([
        ...names,
        ...snapshot.files.flatMap((f) => [
          f.path,
          ...(f.originalPath ? [f.originalPath] : []),
        ]),
      ]),
    ].sort();
    await this.recovery().retireForDiscard(c, t.preview.token);
    const guard = await createDiscardGuard(c, names, protectedPaths);
    const before = await guard.capture(),
      sources = await this.sources(c, s);
    if (
      gitDiscardStateFingerprint(await this.capture(c, names)) !==
        t.fingerprint ||
      t.preview.expiresAt <= this.now()
    )
      throw stale();
    assertNativeGitState(before, await guard.capture());
    const intent = nativeIntent(["discard", names, t.preview.items]);
    const details = JSON.stringify(["discard", names, t.preview.items]);
    if (Buffer.byteLength(details) > 65536)
      throw Error("Слишком большой список: выберите меньше файлов для отмены.");
    const token = guard.journal.prepare("discard", before, intent, details);
    const changedPaths: string[] = [],
      trashedPaths: string[] = [];
    let failureStep:
      | "discard-preview"
      | "discard-owner"
      | "discard-worktree"
      | "discard-index"
      | "discard-result" = "discard-preview";
    let worktreePublished = false,
      indexPublished = false,
      log = "",
      staging = "",
      stagingIdentity = "";
    const expected = new Map(s.work),
      originals = new Map<string, string>(),
      ready = new Map<string, string>();
    const stagingParents: [string, string][] = [];
    const readyIdentity = new Map<string, string>();
    const assertDisk = () => {
      assertParents(s.parents);
      assertParents(stagingParents);
      for (const [file, id] of readyIdentity)
        if (regular(file)?.identity !== id) throw stale();
      if (staging && directory(staging) !== stagingIdentity) throw stale();
      if (
        c.ownerKey !== s.owner ||
        JSON.stringify(c.scope) !== s.scope ||
        c.root !== s.root ||
        t.preview.expiresAt <= this.now()
      )
        throw stale();
      for (const [name, file] of expected)
        if (
          (regular(path.join(c.root, name))?.identity ?? null) !==
          (file?.identity ?? null)
        )
          throw stale();
      if (
        !indexPublished &&
        regular(path.join(c.root, ".git/index"))?.identity !== s.index.identity
      )
        throw stale();
      for (const [name, id] of s.attributes) {
        if (
          !names.some((n) => path.join(c.root, n) === name) &&
          (regular(name)?.identity ?? "missing") !== id
        )
          throw stale();
      }
    };
    const preserved = (a: NativeGitState, b: NativeGitState) => {
      if (
        a.head !== b.head ||
        a.headRef !== b.headRef ||
        a.refs !== b.refs ||
        a.controlFingerprint !== b.controlFingerprint ||
        a.policyFingerprint !== b.policyFingerprint ||
        !equal(a.owner, b.owner) ||
        !equal(
          a.files.filter((f) => !names.includes(f.path)),
          b.files.filter((f) => !names.includes(f.path)),
        ) ||
        !equal(entries(a, names), entries(b, names))
      )
        throw stale();
    };
    let finalize: (() => Promise<NativeGitOperationResult>) | undefined;
    const result = await guard.journal.execute({
      failureStep: () => failureStep,
      deferRecoveryCleanup: (finish) => {
        finalize = finish;
      },
      token,
      operation: "discard",
      intentFingerprint: intent,
      capture: guard.capture,
      run: async (confirmed) => {
        staging = mkdtempSync(path.join(c.root, ".git/goga-native-files-"));
        stagingIdentity = directory(staging);
        let i = 0;
        for (const name of names) {
          const sub = path.join(staging, String(i++));
          mkdirSync(sub, { mode: 0o700 });
          const savedDirectory = path.join(sub, "original");
          mkdirSync(savedDirectory, { mode: 0o700 });
          stagingParents.push(
            [sub, directory(sub)],
            [savedDirectory, directory(savedDirectory)],
          );
          originals.set(name, path.join(savedDirectory, path.basename(name)));
          const bytes = sources.get(name);
          if (bytes) {
            const file = path.join(sub, "ready"),
              mode = s.work.get(name)?.mode ?? 0o644;
            const targetMode =
              s.entries.get(name)!.mode === "100755"
                ? mode | ((mode & 0o444) >> 2) | 0o100
                : mode & ~0o111;
            writeNew(file, bytes, targetMode);
            ready.set(name, file);
            readyIdentity.set(file, regular(file)!.identity);
          }
        }
        // Retain a portable snapshot through the OUTER context-lock release too.
        // The journal also retains its payload/fence until the outer lease settles.
        writeNew(
          path.join(staging, "snapshot.json"),
          Buffer.from(
            JSON.stringify({ snapshot: confirmed, originals: [...originals] }),
          ),
          0o600,
        );
        for (const [folder] of stagingParents) syncDirectory(folder);
        syncDirectory(staging);
        syncDirectory(path.join(c.root, ".git"));
        const ref = await guard.client.run({
          policy: "local-write",
          command: "update-ref",
          args: ["--stdin"],
          stdin: Buffer.from(`start\nverify HEAD ${s.head}\nprepare\n`),
          verifyPrepared: async (assertActive) => {
            if (
              gitDiscardStateFingerprint(await this.capture(c, names)) !==
              t.fingerprint
            )
              throw stale();
            failureStep = "discard-owner";
            assertNativeGitState(confirmed, await guard.capture());
            failureStep = "discard-worktree";
            this.options.beforePublishWork?.();
            assertDisk();
            assertActive();
            for (const name of names) {
              assertDisk();
              assertActive();
              const filename = path.join(c.root, name),
                original = expected.get(name),
                saved = originals.get(name)!;
              if (stat(saved)) throw stale();
              if (original) {
                renameSync(filename, saved);
                worktreePublished = true;
                expected.set(name, null);
                const actual = regular(saved);
                if (
                  !actual ||
                  !actual.bytes.equals(original.bytes) ||
                  actual.identity.split(":").slice(0, 4).join(":") !==
                    original.identity.split(":").slice(0, 4).join(":")
                )
                  throw stale();
              }
              const source = ready.get(name);
              if (source) {
                linkSync(source, filename);
                unlinkSync(source);
                readyIdentity.delete(source);
                worktreePublished = true;
                expected.set(name, regular(filename));
              }
              changedPaths.push(name);
              syncDirectory(path.dirname(filename));
              syncDirectory(path.dirname(saved));
            }
            this.options.afterPublishWork?.();
            assertDisk();
            const afterWork = await guard.capture();
            preserved(confirmed, afterWork);
            if (afterWork.index !== confirmed.index) throw stale();
            failureStep = "discard-index";
            this.options.beforePublishIndex?.();
            assertDisk();
            assertActive();
            const zero = "0".repeat(s.head.length),
              input = names
                .map((name) => {
                  const e = s.entries.get(name);
                  return `0 ${zero}\t${name}\0${e ? `${e.mode} ${e.oid} 0\t${name}\0` : ""}`;
                })
                .join("");
            const indexed = await guard.client.run({
              policy: "local-write",
              command: "update-index",
              args: ["-z", "--index-info"],
              stdin: Buffer.from(input),
            });
            log += indexed.stdout.toString() + indexed.stderr.toString();
            if (
              indexed.exitCode !== 0 ||
              indexed.signal !== null ||
              !indexed.processSettled
            )
              throw new ByteCommandError(
                "verification",
                indexed.processSettled,
                indexed.stdout,
                indexed.stderr,
                indexed.exitCode,
                indexed.signal,
              );
            indexPublished = true;
            if (indexed.stderr.length) throw stale();
            this.options.afterPublishIndex?.();
            assertActive();
            assertDisk();
          },
        });
        log += ref.stdout.toString() + ref.stderr.toString();
        try {
          if (ref.exitCode === 0 && ref.processSettled && ref.signal === null) {
            for (const item of t.preview.items)
              if (item.action === "trash" && s.work.get(item.path)) {
                assertDisk();
                await c.verify();
                const saved = originals.get(item.path)!,
                  actual = regular(saved),
                  original = s.work.get(item.path)!;
                if (
                  !actual ||
                  !actual.bytes.equals(original.bytes) ||
                  !this.options.trashItem
                )
                  throw stale();
                await this.options.trashItem(saved);
                if (regular(saved)) throw stale();
                trashedPaths.push(item.path);
              }
            worktreePublished = true;
          }
        } catch (error) {
          // Git already returned its settled result. A rejected Trash/filesystem
          // step must not erase those facts or become an eternally live writer.
          throw new ByteCommandError(
            "verification",
            ref.processSettled &&
              (!(error instanceof ByteCommandError) || error.processSettled),
            ref.stdout,
            ref.stderr,
            ref.exitCode,
            ref.signal,
          );
        }
        return ref;
      },
      verify: async (a, b, command) => {
        failureStep = "discard-result";
        if (command.exitCode === 0 && command.stderr.length) throw stale();
        await assertNoNativeGitLocks(c.root);
        preserved(a, b);
        if (command.exitCode !== 0 || command.signal !== null) {
          assertNativeGitState(a, b);
          return {
            outcome: "rejected",
            afterHead: b.head,
            conflicts: [],
            verifiedUnrelatedData: true,
          };
        }
        assertDisk();
        const wanted = names
          .flatMap((name) => {
            const e = s.entries.get(name);
            return e ? [`${e.mode} ${e.oid} 0\t${name}`] : [];
          })
          .sort();
        if (
          !equal(
            entries(b).filter((row) =>
              names.includes(row.slice(row.indexOf("\t") + 1)),
            ),
            wanted,
          )
        )
          throw stale();
        for (const name of names) {
          const actual = regular(path.join(c.root, name)),
            bytes = sources.get(name);
          if (bytes ? !actual?.bytes.equals(bytes) : actual !== null)
            throw stale();
        }
        assertNativeGitState(b, await guard.capture());
        return {
          outcome: "completed",
          afterHead: b.head,
          conflicts: [],
          verifiedUnrelatedData: true,
        };
      },
    });
    const success = result.outcome === "completed";
    if (result.outcome === "uncertain") {
      const steps = {
        "discard-preview": "проверка выбранных файлов до записи",
        "discard-owner": "проверка владельца рабочей папки",
        "discard-worktree": "восстановление рабочих файлов",
        "discard-index": "обновление индекса",
        "discard-result": "проверка результата",
      };
      log += `\nОтмена остановилась на шаге: ${steps[failureStep]}. Состояние будет проверено без повторного выполнения отмены.`;
    }
    if (finalize)
      onVerified(async () => {
        // Do not release the durable fence before staging and outer-owner cleanup.
        if (staging) {
          assertDisk();
          if (directory(staging) !== stagingIdentity) throw stale();
          rmSync(staging, { recursive: true });
        }
        const finished = await finalize!();
        if (finished.recovery !== "removed" || finished.outcome === "uncertain")
          throw stale();
      });
    return {
      scope: t.preview.scope,
      status: success
        ? "discarded"
        : result.outcome === "rejected"
          ? "not-discarded"
          : "uncertain",
      changedPaths,
      trashedPaths,
      indexPublished,
      worktreePublished,
      ...(result.recoveryPath || staging
        ? { recoveryPath: result.recoveryPath ?? staging }
        : {}),
      message: success
        ? "Выбранные изменения отменены. Остальные файлы и подготовленные изменения сохранены."
        : "Отмена изменений требует проверки. Не повторяйте её автоматически; материалы восстановления сохранены.",
      log: log + (staging ? `\nСлужебные материалы: ${staging}` : ""),
    };
  }
}
