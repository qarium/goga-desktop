import { GitRebaseContinue, type RebaseOptions } from "./git-rebase-continue";
import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import {
  gitRebaseOperationRequestSchema,
  gitRebaseOperationTokenSchema,
  type GitRebaseOperationRequest,
  type GitRebaseOperationPreview,
  type GitRebaseOperationResult,
} from "../shared/git-rebase-operations";
import {
  directory,
  regular,
  stat,
  stale,
  hash,
  assertStoppedRebaseOwnership,
} from "./git-conflict-state";
import {
  args,
  capture,
  stateKey,
  raw,
  rawKey,
  assertPaths,
  assertOriginalTargets,
  matches,
  unsupported,
  type GitRebaseOperationContext,
  type RebaseState,
} from "./git-rebase-operations-state";
import { readRebaseBinding } from "./git-rebase-read-binding";
import { CommandExitError } from "./process";
import { sanitizeRepositoryLog } from "./repository-actions";

const TTL = 5 * 60 * 1000;
function sync(dir: string) {
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
function create(
  file: string,
  value: string | Buffer,
  settled?: (fd: number) => void,
) {
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    try {
      settled?.(fd);
    } finally {
      closeSync(fd);
    }
  }
}
function alternate(file: string) {
  return `"${[...Buffer.from(file)].map((b) => (b === 34 || b === 92 ? `\\${String.fromCharCode(b)}` : b < 32 || b >= 127 ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join("")}"\n`;
}
interface Ticket {
  preview: GitRebaseOperationPreview;
  request: GitRebaseOperationRequest;
  state: RebaseState;
  key: string;
}
/** Metadata-only native abort sandbox, then exact live CAS publication. This is
 * not a sequencer: no continue/skip/replay and no optimistic rollback. Native Git
 * never receives the real Git directory or permission to update its refs/index.
 * Cooperative Git writers are locked. Arbitrary same-user FS tampering after a
 * final synchronous no-follow guard cannot be made atomic by portable Node. */
export class GitRebaseOperations {
  private tickets = new Map<string, Ticket>();
  private continuation: GitRebaseContinue;
  constructor(private readonly options: RebaseOptions) {
    this.continuation = new GitRebaseContinue(options);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async prepare(
    input: GitRebaseOperationRequest,
  ): Promise<GitRebaseOperationPreview> {
    const request = gitRebaseOperationRequestSchema.parse(input);
    if (request.action === "continue")
      return this.continuation.prepare(request);
    return this.options.context(request.scope, async (c) => {
      const state = await capture(c, request.revision),
        key = stateKey(state);
      const preview: GitRebaseOperationPreview = {
        token: randomBytes(32).toString("hex"),
        scope: request.scope,
        root: c.root,
        operation: "rebase",
        backend: state.backend,
        action: "abort",
        branch: state.branch,
        head: state.head,
        original: state.original,
        paths: Object.keys(state.auto),
        discardedResolutionPaths: [...state.resolutionPaths].sort(),
        hooks: "disabled",
        effects:
          "Будут восстановлены исходное дерево и ветка до rebase. Сохранённые и ручные решения в подтверждённых файлах конфликтов будут удалены. Посторонние отслеживаемые правки блокируют отмену; неотслеживаемые и игнорируемые файлы сохраняются. Hooks отключены; публикации на сервер нет.",
        expiresAt: this.now() + TTL,
      };
      for (const [token, t] of this.tickets)
        if (t.preview.expiresAt <= this.now()) this.tickets.delete(token);
      while (this.tickets.size >= 8)
        this.tickets.delete(this.tickets.keys().next().value!);
      // Bound memory by retaining only identities. Fresh bytes are captured at execute.
      const retained = structuredClone(state);
      retained.disk.index.bytes = Buffer.alloc(0);
      for (const f of Object.values(retained.disk.files))
        f.bytes = Buffer.alloc(0);
      for (const f of Object.values(retained.operationFiles))
        f.bytes = Buffer.alloc(0);
      this.tickets.set(preview.token, {
        preview: structuredClone(preview),
        request: structuredClone(request),
        state: retained,
        key,
      });
      return preview;
    });
  }
  async execute(input: string): Promise<GitRebaseOperationResult> {
    const token = gitRebaseOperationTokenSchema.parse(input);
    if (this.continuation.has(token)) return this.continuation.execute(token);
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now())
      throw Error("Подтверждение истекло или уже использовано.");
    return this.options.context(ticket.request.scope, async (c) => {
      const state = await capture(c, ticket.request.revision);
      if (
        this.now() >= ticket.preview.expiresAt ||
        stateKey(state) !== ticket.key
      )
        throw stale();
      return this.abort(c, { ...ticket, state });
    });
  }
  private async abort(
    c: GitRebaseOperationContext,
    t: Ticket,
  ): Promise<GitRebaseOperationResult> {
    const s = t.state,
      operationName = `rebase-${s.backend}`,
      gd = path.join(c.root, ".git"),
      recovery = path.join(gd, `goga-abort-${randomUUID()}`),
      ref = `refs/heads/${s.branch}`;
    const locks = new Map<string, string>(),
      unchecked = new Set<string>();
    let recoveryIdentity = "",
      recoveryCreated = false,
      privateAuthority = "",
      mutationStarted = false,
      worktreeRestored = false,
      indexPublished = false,
      headPublished = false,
      metadataCleared = false;
    let status: GitRebaseOperationResult["status"] = "error",
      log = "",
      message = "Отмена не выполнялась; пользовательские данные не изменены.";
    const removed: string[] = [];
    let publishedHeadIdentity: string | undefined;
    const expectedMetadata = () => {
      const rows: [string, string][] = JSON.parse(s.disk.metadata);
      return JSON.stringify(
        rows.flatMap(([name, id]) => {
          const relative = path.relative(gd, name);
          if (relative === "HEAD" && publishedHeadIdentity)
            return [[name, publishedHeadIdentity]];
          if (relative === operationName && metadataCleared)
            return [[name, "missing"]];
          if (removed.includes(relative))
            return relative.startsWith(`${operationName}/`)
              ? []
              : [[name, "missing"]];
          return [[name, id]];
        }),
      );
    };
    const guardMetadata = () => {
      if (raw(c.root, [...locks.keys()]).metadata !== expectedMetadata())
        throw stale();
    };
    type RecoveryFacts = Pick<
      GitRebaseOperationResult,
      "recoveryStatus" | "recoveryPath" | "lastKnownRecoveryPath"
    >;
    const observeRecovery = (): RecoveryFacts => {
      if (!recoveryCreated) return { recoveryStatus: "not-created" };
      const known = { lastKnownRecoveryPath: recovery };
      try {
        if (!stat(recovery)) return { ...known, recoveryStatus: "missing" };
        if (!recoveryIdentity || directory(recovery) !== recoveryIdentity)
          return { ...known, recoveryStatus: "unverified" };
        const sameBackup = (name: string, bytes: Buffer) => {
          const parents: [string, string][] = [[recovery, recoveryIdentity]];
          let parent = recovery;
          for (const part of name.split("/").slice(0, -1)) {
            parent = path.join(parent, part);
            parents.push([parent, directory(parent)]);
          }
          const equal =
            regular(path.join(recovery, name))?.bytes.equals(bytes) === true;
          return equal && parents.every(([p, id]) => directory(p) === id);
        };
        if (
          !sameBackup("original-index", s.disk.index.bytes) ||
          !sameBackup("original-HEAD", Buffer.from(`${s.head}\n`)) ||
          !regular(path.join(recovery, "journal.json"))
        )
          return { ...known, recoveryStatus: "unverified" };
        for (const [n, f] of Object.entries(s.operationFiles))
          if (!sameBackup(`backup/${n}`, f.bytes))
            return { ...known, recoveryStatus: "unverified" };
        for (const n of Object.keys(s.auto))
          if (!sameBackup(`work/${n}`, s.disk.files[n].bytes))
            return { ...known, recoveryStatus: "unverified" };
        return { ...known, recoveryStatus: "retained", recoveryPath: recovery };
      } catch {
        // Reporting an I/O/permission failure must not discard mutation facts.
        return { ...known, recoveryStatus: "unverified" };
      }
    };
    const result = (
      recoveryFacts: RecoveryFacts,
    ): GitRebaseOperationResult => ({
      scope: t.request.scope,
      operation: "rebase",
      action: "abort",
      status,
      changed:
        mutationStarted ||
        indexPublished ||
        headPublished ||
        removed.length > 0,
      mutationStarted,
      worktreeRestored,
      indexPublished,
      headPublished,
      metadataCleared,
      ...recoveryFacts,
      lockRetained: locks.size > 0,
      retainedLocks: [...locks.keys()],
      uncheckedLocks: [...unchecked],
      message: sanitizeRepositoryLog(message),
      log: sanitizeRepositoryLog(log),
    });
    const guardRecovery = () => {
      assertPaths(s.disk);
      if (directory(recovery) !== recoveryIdentity) throw stale();
    };
    const journal = () => {
      guardRecovery();
      const candidate = path.join(recovery, `journal-${randomUUID()}`);
      create(
        candidate,
        JSON.stringify(
          {
            version: 1,
            kind: "linear-rebase-abort",
            root: c.root,
            scope: t.request.scope,
            ownerHash: hash(s.owner),
            head: s.head,
            original: s.original,
            branch: s.branch,
            mutationStarted,
            worktreeRestored,
            indexPublished,
            headPublished,
            metadataCleared,
            removed,
            status,
            retainedLocks: [...locks.keys()],
          },
          null,
          2,
        ),
      );
      renameSync(candidate, path.join(recovery, "journal.json"));
      sync(recovery);
    };
    const lockId = (n: string) => regular(path.join(gd, n))?.identity;
    const guardLocks = () => {
      for (const [n, id] of locks) if (lockId(n) !== id) throw stale();
    };
    const privateKey = () => {
      const rows: unknown[] = [];
      let count = 0;
      const visit = (file: string, depth: number) => {
        if (++count > 20000 || depth > 32) throw stale();
        const info = stat(file);
        if (!info) throw stale();
        if (info.isDirectory()) {
          rows.push([file, directory(file)]);
          for (const n of readdirSync(file).sort()) {
            if (file === recovery && n === "journal.json") continue;
            visit(path.join(file, n), depth + 1);
          }
        } else rows.push([file, regular(file)!.identity]);
      };
      visit(recovery, 0);
      return hash(JSON.stringify(rows));
    };
    const guard = async () => {
      await c.verify();
      assertStoppedRebaseOwnership(c.stoppedRebase);
      guardRecovery();
      guardLocks();
      if (privateAuthority && privateKey() !== privateAuthority) throw stale();
      const proof = await readRebaseBinding(
        { path: c.root, gitCommonDir: gd, branch: s.branch },
        async (a) => (await c.isolatedGit(args(c.root, a))).stdout,
      );
      if (proof !== s.proof) throw stale();
      assertOriginalTargets(s);
      if (
        this.now() >= t.preview.expiresAt ||
        c.ownerKey !== s.owner ||
        JSON.stringify(c.scope) !== s.scope ||
        rawKey(raw(c.root, [...locks.keys()])) !== rawKey(s.disk)
      )
        throw stale();
    };
    const originalWork = () => {
      const actual = raw(c.root, [...locks.keys()]);
      const expectedNames = new Set([
        ...Object.keys(s.originalTree),
        ...Object.keys(s.disk.files).filter((n) => !s.auto[n]),
      ]);
      if (Object.keys(actual.files).length !== expectedNames.size)
        throw stale();
      for (const n of expectedNames) {
        if (s.originalTree[n]) {
          if (!matches(actual.files[n], s.originalTree[n])) throw stale();
        } else if (actual.files[n]?.identity !== s.disk.files[n]?.identity)
          throw stale();
      }
      return actual;
    };
    const expectedStages = Object.entries(s.originalTree)
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([n, e]) => `${e.mode} ${e.oid} 0\t${n}\0`)
      .join("");
    const unchangedMetadata = () => {
      const actual = raw(c.root, [...locks.keys()]);
      if (
        actual.metadata !== s.disk.metadata ||
        actual.index.identity !== s.disk.index.identity
      )
        throw stale();
      assertPaths(s.disk);
      guardLocks();
    };
    try {
      assertPaths(s.disk);
      mkdirSync(recovery, { mode: 0o700 });
      recoveryCreated = true;
      recoveryIdentity = directory(recovery);
      mkdirSync(path.join(recovery, "backup"), { mode: 0o700 });
      mkdirSync(path.join(recovery, `backup/${operationName}`), {
        mode: 0o700,
      });
      for (const [n, f] of Object.entries(s.operationFiles))
        create(path.join(recovery, "backup", n), f.bytes);
      create(path.join(recovery, "original-index"), s.disk.index.bytes);
      create(
        path.join(recovery, "original-HEAD"),
        regular(path.join(gd, "HEAD"))!.bytes,
      );
      mkdirSync(path.join(recovery, "work"), { mode: 0o700 });
      for (const n of Object.keys(s.auto)) {
        mkdirSync(path.dirname(path.join(recovery, "work", n)), {
          recursive: true,
          mode: 0o700,
        });
        create(path.join(recovery, "work", n), s.disk.files[n].bytes);
      }
      // Private metadata, not a clone or a second worktree. All object writes go
      // to this new objects directory; the audited fallback is read-only to Git.
      for (const n of [
        "objects",
        "objects/info",
        "refs",
        "refs/heads",
        operationName,
      ])
        mkdirSync(path.join(recovery, n), { mode: 0o700 });
      mkdirSync(path.dirname(path.join(recovery, ref)), {
        recursive: true,
        mode: 0o700,
      });
      create(
        path.join(recovery, "objects/info/alternates"),
        alternate(path.join(gd, "objects")),
      );
      create(
        path.join(recovery, "config"),
        "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nlogallrefupdates = false\n",
      );
      create(path.join(recovery, "HEAD"), `${s.head}\n`);
      create(path.join(recovery, ref), `${s.original}\n`);
      create(path.join(recovery, "index"), s.disk.index.bytes);
      for (const [n, f] of Object.entries(s.operationFiles))
        create(path.join(recovery, n), f.bytes);
      for (const [n, value] of [
        ["config.lock", regular(path.join(gd, "config"))!.bytes],
        [
          "packed-refs.lock",
          regular(path.join(gd, "packed-refs"))?.bytes ?? Buffer.alloc(0),
        ],
        [`${ref}.lock`, `${s.original}\n`],
        ["index.lock", s.disk.index.bytes],
        ["HEAD.lock", `ref: ${ref}\n`],
      ] as const) {
        assertPaths(s.disk);
        create(path.join(gd, n), value, (fd) => {
          // Even a failed write/fsync created an owned lock. Track it before
          // close, but never adopt a replaced inode or foreign file contents.
          try {
            const held = fstatSync(fd, { bigint: true });
            const stamp = [
              held.dev,
              held.ino,
              held.mode,
              held.size,
              held.mtimeNs,
              held.ctimeNs,
            ].join(":");
            const observed = regular(path.join(gd, n));
            const intended = Buffer.from(value);
            if (
              !observed?.identity.startsWith(`${stamp}:`) ||
              observed.bytes.length > intended.length ||
              !observed.bytes.equals(
                intended.subarray(0, observed.bytes.length),
              )
            )
              throw stale();
            locks.set(n, observed.identity);
          } catch (error) {
            unchecked.add(n);
            throw error;
          }
        });
        sync(path.dirname(path.join(gd, n)));
      }
      journal();
      sync(gd);
      privateAuthority = privateKey();
      await guard();
      this.options.beforeNative?.();
      await guard();
      mutationStarted = true;
      journal();
      if (privateKey() !== privateAuthority) throw stale();
      let nativeError: unknown;
      try {
        const out = await c.isolatedGit(
          args(c.root, ["rebase", "--abort"], recovery),
        );
        log += out.stdout + out.stderr;
      } catch (e) {
        nativeError = e;
        const err = e as { message?: string; stdout?: string; stderr?: string };
        log += `${err.stdout ?? ""}${err.stderr ?? ""}\n${err.message ?? String(e)}`;
      }
      this.options.afterNative?.();
      // An untyped failure may be cancellation/timeout/lost ACK: do not finalize,
      // even if the first observed files happen to look complete.
      if (
        nativeError &&
        (!(nativeError instanceof CommandExitError) ||
          nativeError.exitCode === null)
      )
        throw nativeError;
      guardRecovery();
      guardLocks();
      unchangedMetadata();
      await c.verify();
      assertStoppedRebaseOwnership(c.stoppedRebase);
      originalWork();
      worktreeRestored = true;
      journal();
      if (
        regular(path.join(recovery, "HEAD"))?.bytes.toString() !==
          `ref: ${ref}\n` ||
        regular(path.join(recovery, ref))?.bytes.toString() !==
          `${s.original}\n` ||
        stat(path.join(recovery, operationName)) ||
        stat(path.join(recovery, "REBASE_HEAD")) ||
        stat(path.join(recovery, "AUTO_MERGE"))
      )
        throw stale();
      const privateStages = (
        await c.isolatedGit(
          args(c.root, ["ls-files", "--stage", "-z"], recovery),
        )
      ).stdout;
      if (privateStages !== expectedStages) throw stale();
      const ready = regular(path.join(recovery, "index"));
      if (!ready) throw stale();
      // Every publication guard remains source-bound, not the old read proof after
      // intentional HEAD/op changes. Native cannot authorize live metadata writes.
      await c.verify();
      assertStoppedRebaseOwnership(c.stoppedRebase);
      guardRecovery();
      guardLocks();
      unchangedMetadata();
      originalWork();
      // Replace our own complete index pin only; foreign/new locks never qualify.
      const readyPath = path.join(recovery, "index-ready");
      create(readyPath, ready.bytes);
      guardLocks();
      renameSync(readyPath, path.join(gd, "index.lock"));
      locks.set("index.lock", lockId("index.lock")!);
      unchangedMetadata();
      originalWork();
      guardLocks();
      renameSync(path.join(gd, "index.lock"), path.join(gd, "index"));
      locks.delete("index.lock");
      indexPublished = true;
      sync(gd);
      journal();
      this.options.afterPublish?.("index");
      // Metadata still exact; only index was intentionally changed.
      if (
        raw(c.root, [...locks.keys()]).metadata !== s.disk.metadata ||
        !regular(path.join(gd, "index"))!.bytes.equals(ready.bytes)
      )
        throw stale();
      originalWork();
      guardLocks();
      assertStoppedRebaseOwnership(c.stoppedRebase);
      renameSync(path.join(gd, "HEAD.lock"), path.join(gd, "HEAD"));
      locks.delete("HEAD.lock");
      headPublished = true;
      publishedHeadIdentity = regular(path.join(gd, "HEAD"))!.identity;
      sync(gd);
      journal();
      this.options.afterPublish?.("head");
      const operationPath = path.join(gd, operationName),
        initialNames = Object.keys(s.operationFiles).filter((n) =>
          n.startsWith(`${operationName}/`),
        );
      const guardCleanup = () => {
        guardRecovery();
        guardLocks();
        guardMetadata();
        assertStoppedRebaseOwnership(c.stoppedRebase);
        originalWork();
        if (
          regular(path.join(gd, "HEAD"))?.bytes.toString() !==
            `ref: ${ref}\n` ||
          !regular(path.join(gd, "index"))!.bytes.equals(ready.bytes)
        )
          throw stale();
        if (
          directory(operationPath) !== s.operationDirectory ||
          JSON.stringify(readdirSync(operationPath).sort()) !==
            JSON.stringify(
              initialNames
                .filter((n) => !removed.includes(n))
                .map((n) => n.slice(operationName.length + 1))
                .sort(),
            )
        )
          throw stale();
        for (const [n, f] of Object.entries(s.operationFiles))
          if (
            !removed.includes(n) &&
            regular(path.join(gd, n))?.identity !== f.identity
          )
            throw stale();
      };
      guardCleanup();
      for (const n of [
        ...initialNames,
        ...(s.backend === "merge"
          ? ["AUTO_MERGE", "REBASE_HEAD", "MERGE_MSG"]
          : ["REBASE_HEAD"]),
      ]) {
        guardCleanup();
        unlinkSync(path.join(gd, n));
        removed.push(n);
        journal();
      }
      guardCleanup();
      rmdirSync(operationPath);
      metadataCleared = true;
      sync(gd);
      journal();
      this.options.afterPublish?.("metadata");
      await c.verifyOwner();
      assertStoppedRebaseOwnership(c.stoppedRebase);
      guardLocks();
      guardMetadata();
      originalWork();
      if (
        regular(path.join(gd, "HEAD"))?.bytes.toString() !== `ref: ${ref}\n` ||
        !regular(path.join(gd, "index"))!.bytes.equals(ready.bytes)
      )
        throw stale();
      status = "success";
      message =
        "Rebase отменён; восстановлены исходная ветка и ORIGINAL дерево. Посторонние файлы сохранены. Материалы восстановления оставлены; публикации на сервер не было.";
      journal();
    } catch (e) {
      status = mutationStarted ? "uncertain" : "error";
      message = mutationStarted
        ? "Отмена выполнена частично или итог не подтверждён. Не повторяйте автоматически: сохранены исходные данные, журнал и принадлежащие операции блокировки. Отката поверх новых правок не было."
        : "Отмена не начата; ветки, индекс и рабочие файлы не опубликованы.";
      log += `\n${e instanceof Error ? e.message : String(e)}`;
      try {
        if (recoveryIdentity) journal();
      } catch {
        /* Last durable journal and backups remain. */
      }
    }
    if (status === "success" || !mutationStarted) {
      for (const [n, id] of [...locks].reverse()) {
        try {
          this.options.releaseLockFault?.(n, "before");
          if (lockId(n) !== id) throw stale();
          unlinkSync(path.join(gd, n));
          locks.delete(n);
          this.options.releaseLockFault?.(n, "after");
          sync(path.dirname(path.join(gd, n)));
        } catch (e) {
          log += `\n${String(e)}`;
          status = mutationStarted ? "uncertain" : "error";
          message =
            "Снятие блокировки не подтверждено. Проверьте журнал и фактическое состояние; автоматически не повторяйте.";
          try {
            if (lockId(n) !== id) locks.delete(n);
          } catch {
            locks.delete(n);
            unchecked.add(n);
          }
        }
      }
    }
    // Return observed ownership, never fabricated retained/absent lock facts.
    for (const [n, id] of [...locks])
      try {
        if (lockId(n) !== id) locks.delete(n);
      } catch {
        locks.delete(n);
        unchecked.add(n);
      }
    try {
      if (recoveryIdentity) journal();
    } catch (e) {
      log += `\n${String(e)}`;
      if (status === "success") {
        status = "uncertain";
        message =
          "Файлы восстановлены, но финальная запись журнала не подтверждена. Проверьте состояние; автоматически не повторяйте.";
      }
    }
    const recoveryFacts = observeRecovery();
    if (["missing", "unverified"].includes(recoveryFacts.recoveryStatus)) {
      status = mutationStarted ? "uncertain" : "error";
      message =
        recoveryFacts.recoveryStatus === "missing"
          ? "Итог операции требует проверки. Каталог восстановления по последнему известному пути отсутствует; сохранность материалов не подтверждена. Автоматически не повторяйте."
          : "Итог операции требует проверки. Наличие, владение или целостность материалов восстановления не подтверждены. Автоматически не повторяйте.";
    }
    return result(recoveryFacts);
  }
}
