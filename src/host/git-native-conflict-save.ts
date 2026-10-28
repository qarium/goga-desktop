import path from "node:path";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fchmodSync,
  mkdtempSync,
  renameSync,
  linkSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import {
  GitConflictActions,
  type GitConflictActionContext,
  type GitConflictTicket,
} from "./git-conflict-actions";
import {
  assertParents,
  assertStoppedRebaseOwnership,
  directory,
  regular,
  stat,
  stateKey,
  stale,
} from "./git-conflict-state";
import { nativeGitGuard, nativeIntent } from "./git-native-context";
import {
  assertNativeGitState,
  assertNoNativeGitLocks,
  type NativeGitState,
} from "./git-native-state";
import {
  ByteCommandError,
  CommandExitError,
  type ByteCommandResult,
} from "./process";
import type { GitConflictSaveResult } from "../shared/git-conflict-save";

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function entries(s: NativeGitState, except?: string) {
  return Buffer.from(s.indexData, "base64")
    .toString("utf8")
    .split("\0")
    .filter((row) => row && row.slice(row.indexOf("\t") + 1) !== except)
    .sort();
}
function writeNew(file: string, bytes: Buffer, mode: number) {
  const fd = openSync(
    file,
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
function syncDirectory(dir: string) {
  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Same one-use conflict admission, native object/index writer. A resolution is
 * a child of the existing stopped receipt; it never adopts an external sequence.
 * No binary index publication, automatic rollback or native-to-legacy fallback. */
export class NativeGitConflictActions extends GitConflictActions {
  protected override async transact(
    c: GitConflictActionContext,
    t: GitConflictTicket,
    onVerified: (cleanup: () => Promise<void>) => void,
  ): Promise<GitConflictSaveResult> {
    const s = t.state,
      name = t.preview.path,
      work = path.join(c.root, name);
    // Metadata-only enumeration: neither status nor diff may invoke a late filter.
    const tracked = (await this.git(c, ["ls-files", "--stage", "-z"])).stdout;
    const dirty = (
      await this.git(c, [
        "ls-files",
        "--modified",
        "--deleted",
        "--others",
        "--exclude-standard",
        "-z",
      ])
    ).stdout;
    const staged = s.head
      ? (
          await this.git(c, [
            "diff-index",
            "--cached",
            "--name-only",
            "--no-ext-diff",
            "--no-textconv",
            "-z",
            s.head,
            "--",
          ])
        ).stdout
      : tracked
          .split("\0")
          .filter(Boolean)
          .map((row) => row.slice(row.indexOf("\t") + 1))
          .join("\0");
    const paths = [
      ...new Set([
        name,
        ...dirty.split("\0").filter(Boolean),
        ...staged.split("\0").filter(Boolean),
        ...tracked
          .split("\0")
          .filter((row) => /^[0-9]+ [a-f0-9]+ [123]\t/.test(row))
          .map((row) => row.slice(row.indexOf("\t") + 1)),
      ]),
    ].sort();
    const configuration = s.policy.raw
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const i = row.indexOf("\n");
        return [
          i < 0 ? row : row.slice(0, i),
          i < 0 ? "" : row.slice(i + 1),
        ] as const;
      });
    const guard = await nativeGitGuard({
      root: c.root,
      capability: c.native,
      configuration,
      paths,
      recoverIndex: true,
      verify: async () => {
        await c.verify();
        assertStoppedRebaseOwnership(c.stoppedRebase);
      },
      admittedStatus: async () => {
        let headRef: string | null = null;
        try {
          headRef = (
            await this.git(c, ["symbolic-ref", "--quiet", "HEAD"])
          ).stdout.trim();
        } catch (e) {
          if (!(e instanceof CommandExitError) || e.exitCode !== 1) throw e;
        }
        return {
          headRef,
          data: Buffer.from(
            (await this.git(c, ["ls-files", "--stage", "-z"])).stdout,
          ),
        };
      },
      policy: async () =>
        nativeIntent([
          (await this.git(c, ["config", "--null", "--list"])).stdout,
          (
            await this.git(c, [
              "check-attr",
              "-z",
              "filter",
              "working-tree-encoding",
              "ident",
              "text",
              "eol",
              "crlf",
              "--",
              name,
            ])
          ).stdout,
          (await this.git(c, ["ls-files", "-v", "-z"])).stdout
            .split("\0")
            .filter((row) => row && row.slice(2) !== name),
        ]),
    });
    const before = await guard.capture();
    if (
      stateKey(await this.capture(c, name, s.revision)) !== stateKey(s) ||
      t.preview.expiresAt <= this.now()
    )
      throw stale();
    const intent = nativeIntent([
      "resolve",
      name,
      t.preview.resolution,
      t.oid,
      t.mode,
      t.text,
    ]);
    const token = await guard.journal.prepareResolution(
      before,
      intent,
      name,
      t.preview.resolution === "current" || t.preview.resolution === "incoming",
    );
    let staging = "",
      stagingIdentity = "",
      readyIdentity = "",
      expected = s.disk.work;
    let worktreePublished = false,
      indexPublished = false,
      log = "";
    let originalIdentity: string | undefined;
    const recoveryFiles = new Map<string, string>();
    let finalSnapshot: NativeGitState | undefined;
    let finish:
      | (() => Promise<
          import("../shared/git-native-operation").NativeGitOperationResult
        >)
      | undefined;
    const checkDisk = () => {
      assertParents(s.disk.parents);
      assertStoppedRebaseOwnership(c.stoppedRebase);
      if (
        c.root !== s.root ||
        c.ownerKey !== s.owner ||
        JSON.stringify(c.scope) !== s.scope ||
        t.preview.expiresAt <= this.now()
      )
        throw stale();
      if (staging && directory(staging) !== stagingIdentity) throw stale();
      for (const [file, id] of recoveryFiles)
        if (regular(file)?.identity !== id) throw stale();
      if (
        originalIdentity &&
        regular(path.join(staging, "original"))?.identity !== originalIdentity
      )
        throw stale();
      if (
        readyIdentity &&
        regular(path.join(staging, "ready"))?.identity !== readyIdentity
      )
        throw stale();
      if ((regular(work)?.identity ?? null) !== (expected?.identity ?? null))
        throw stale();
      if (
        !indexPublished &&
        regular(path.join(c.root, ".git/index"))?.identity !==
          s.disk.index.identity
      )
        throw stale();
    };
    const preserved = (a: NativeGitState, b: NativeGitState) => {
      if (
        a.head !== b.head ||
        a.headRef !== b.headRef ||
        a.refs !== b.refs ||
        a.controlFingerprint !== b.controlFingerprint ||
        a.policyFingerprint !== b.policyFingerprint ||
        !equal(a.owner, b.owner) ||
        !equal(entries(a, name), entries(b, name)) ||
        !equal(
          a.files.filter((f) => f.path !== name),
          b.files.filter((f) => f.path !== name),
        )
      )
        throw stale();
    };
    const requireSuccess = (r: ByteCommandResult) => {
      log += r.stdout.toString() + r.stderr.toString();
      if (
        r.exitCode !== 0 ||
        r.signal !== null ||
        !r.processSettled ||
        r.stderr.length
      )
        throw new ByteCommandError(
          "verification",
          r.processSettled,
          r.stdout,
          r.stderr,
          r.exitCode,
          r.signal,
        );
    };
    const result = await guard.journal.execute({
      token,
      operation: "resolve",
      intentFingerprint: intent,
      capture: guard.capture,
      deferRecoveryCleanup: (fn) => {
        finish = fn;
      },
      run: async (confirmed) => {
        staging = mkdtempSync(
          path.join(c.root, ".git/goga-native-resolution-"),
        );
        stagingIdentity = directory(staging);
        const original = path.join(staging, "original"),
          ready = path.join(staging, "ready");
        writeNew(
          path.join(staging, "snapshot.json"),
          Buffer.from(JSON.stringify({ snapshot: confirmed, path: name })),
          0o600,
        );
        recoveryFiles.set(
          path.join(staging, "snapshot.json"),
          regular(path.join(staging, "snapshot.json"))!.identity,
        );
        if (t.text !== null) {
          const submitted = path.join(staging, "submitted-work");
          writeNew(submitted, Buffer.from(t.text), 0o600);
          recoveryFiles.set(submitted, regular(submitted)!.identity);
          const canonical = path.join(staging, "canonical-blob");
          writeNew(canonical, Buffer.from(t.canonical!), 0o600);
          recoveryFiles.set(canonical, regular(canonical)!.identity);
          const mode = s.disk.work?.mode ?? 0o600;
          writeNew(
            ready,
            Buffer.from(t.text),
            t.preview.resolution === "text" && s.disk.work
              ? mode
              : t.mode === "100755"
                ? mode | ((mode & 0o444) >> 2) | 0o100
                : mode & ~0o111,
          );
          readyIdentity = regular(ready)!.identity;
        }
        syncDirectory(staging);
        syncDirectory(path.join(c.root, ".git"));
        return guard.client
          .run({
            policy: "local-write",
            command: "update-ref",
            args: ["--stdin"],
            stdin: Buffer.from(
              `start\nverify HEAD ${s.head ?? "0".repeat(t.oid?.length ?? 40)}\nprepare\n`,
            ),
            verifyPrepared: async (assertActive) => {
              assertNativeGitState(confirmed, await guard.capture());
              if (t.canonical !== null) {
                const blob = await guard.client.run({
                  policy: "local-write",
                  command: "hash-object",
                  args: ["--no-filters", "-w", "--stdin"],
                  stdin: Buffer.from(t.canonical),
                });
                requireSuccess(blob);
                if (blob.stdout.toString() !== t.oid + "\n") throw stale();
              }
              this.options.beforePublishWork?.();
              checkDisk();
              assertActive();
              assertNativeGitState(confirmed, await guard.capture());
              checkDisk();
              assertActive();
              if (stat(original)) throw stale();
              if (expected) {
                const previous = expected;
                renameSync(work, original);
                worktreePublished = true;
                expected = null;
                const moved = regular(original);
                originalIdentity = moved?.identity;
                if (
                  !moved ||
                  !moved.bytes.equals(previous.bytes) ||
                  moved.identity.split(":").slice(0, 4).join(":") !==
                    previous.identity.split(":").slice(0, 4).join(":")
                )
                  throw stale();
              }
              if (t.text !== null) {
                const approved = regular(ready)!;
                linkSync(ready, work);
                worktreePublished = true;
                unlinkSync(ready);
                readyIdentity = "";
                const actual = regular(work);
                if (
                  !actual ||
                  !actual.bytes.equals(approved.bytes) ||
                  actual.identity.split(":").slice(0, 5).join(":") !==
                    approved.identity.split(":").slice(0, 5).join(":")
                )
                  throw stale();
                expected = actual;
              } else worktreePublished = true;
              syncDirectory(staging);
              syncDirectory(path.dirname(work));
              this.options.afterPublishWork?.();
              checkDisk();
              const afterWork = await guard.capture();
              preserved(confirmed, afterWork);
              if (afterWork.index !== confirmed.index) throw stale();
              this.options.beforePublishIndex?.();
              checkDisk();
              assertActive();
              assertNativeGitState(afterWork, await guard.capture());
              checkDisk();
              assertActive();
              const zero = "0".repeat(t.oid?.length ?? s.head?.length ?? 40);
              const indexed = await guard.client.run({
                policy: "local-write",
                command: "update-index",
                args: ["-z", "--index-info"],
                stdin: Buffer.from(
                  `0 ${zero}\t${name}\0${t.oid ? `${t.mode} ${t.oid} 0\t${name}\0` : ""}`,
                ),
              });
              requireSuccess(indexed);
              indexPublished = true;
              // index-info leaves stat data empty; reset --merge needs a native
              // refresh. Frozen metadata has no executable filter definitions.
              await guard.client.inTemporaryIndex(async (frozen) => {
                const refreshed = await frozen.refreshSourceIndex();
                log +=
                  refreshed.stdout.toString() + refreshed.stderr.toString();
                if (
                  ![0, 1].includes(refreshed.exitCode ?? -1) ||
                  refreshed.signal !== null ||
                  !refreshed.processSettled ||
                  refreshed.stderr.length
                )
                  throw new ByteCommandError(
                    "verification",
                    refreshed.processSettled,
                    refreshed.stdout,
                    refreshed.stderr,
                    refreshed.exitCode,
                    refreshed.signal,
                  );
                // Exit 1 may describe unrelated dirty files; verify all public
                // tuples, flags, working bytes and the selected blob below.
              }, true);
              this.options.afterPublishIndex?.();
              checkDisk();
              assertActive();
            },
          })
          .catch((error) => {
            log += "\n" + String(error);
            throw error;
          });
      },
      verify: async (a, b, command) => {
        requireSuccess(command);
        await assertNoNativeGitLocks(c.root);
        preserved(a, b);
        checkDisk();
        const selected = entries(b).filter(
          (row) => row.slice(row.indexOf("\t") + 1) === name,
        );
        if (!equal(selected, t.oid ? [`${t.mode} ${t.oid} 0\t${name}`] : []))
          throw stale();
        const actual = regular(work);
        if (
          t.text === null
            ? actual !== null
            : !actual?.bytes.equals(Buffer.from(t.text))
        )
          throw stale();
        assertNativeGitState(b, await guard.capture());
        finalSnapshot = b;
        return {
          outcome: "completed",
          afterHead: b.head,
          conflicts: [],
          verifiedUnrelatedData: true,
        };
      },
    });
    const output: GitConflictSaveResult = {
      scope: t.preview.scope,
      path: name,
      status: result.outcome === "completed" ? "saved" : "uncertain",
      worktreePublished,
      indexPublished,
      lockRetained: result.outcome !== "completed",
      recoveryPath: result.recoveryPath ?? staging,
      message:
        result.outcome === "completed"
          ? "Решение конфликта сохранено. Операцию можно продолжить после решения остальных конфликтов."
          : "Сохранение требует проверки. Материалы восстановления сохранены; не повторяйте запись автоматически.",
      log: log + (staging ? `\nМатериалы восстановления: ${staging}` : ""),
    };
    if (result.outcome === "completed")
      onVerified(async () => {
        checkDisk();
        assertNativeGitState(finalSnapshot!, await guard.capture());
        checkDisk();
        // Journal recovery remains durable until scratch cleanup and outer context
        // release both succeed. Cleanup failure must not reopen the write fence.
        rmSync(staging, { recursive: true });
        const final = await finish!();
        if (final.outcome !== "completed" || final.recovery === "unknown")
          throw stale();
        // A parent operation still owns its original recovery, not this file save.
        delete output.recoveryPath;
        output.log = output.log.replace(
          `\nМатериалы восстановления: ${staging}`,
          "",
        );
      });
    return output;
  }
}
