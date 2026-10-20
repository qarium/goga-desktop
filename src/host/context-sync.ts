import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Project } from "../shared/types";
import {
  topicContextRefSchema,
  worktreeContextRef,
  worktreeRecordSchema,
  type TopicContextRef,
  type WorktreeRecord,
} from "../shared/worktrees";
import type {
  ContextApplyPreview,
  ContextApplyResult,
  ContextSyncReason,
  ContextSyncState,
} from "../shared/context-sync";
import type { Runner } from "./process";
import { CloneStore } from "./clone-store";
import { noSymlinks } from "./settings";
export interface ContextSyncDependencies {
  resolve(ref: TopicContextRef): Promise<WorktreeRecord>;
  isActive(contextId: string): boolean;
  isProjectActive?(projectId: string): boolean;
  onChange?(state: ContextSyncState): void;
}
const oidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const stateSchema = z
  .object({
    projectId: z.string(),
    contextId: z.string().regex(/^ctx-[a-f0-9]{64}$/),
    revision: z.string().uuid(),
    status: z.enum(["new", "waiting", "syncing", "synced", "error"]),
    sourceOid: oidSchema.optional(),
    importedOid: oidSchema.optional(),
    destinationRef: z
      .string()
      .regex(/^refs\/desktop\/contexts\/ctx-[a-f0-9]{64}\/[a-f0-9-]{36}$/)
      .optional(),
    operationId: z.string().uuid().optional(),
    error: z.string().optional(),
    waitingRunIds: z.array(z.string()),
    reasons: z.array(z.enum(["manual", "automatic"])),
    updatedAt: z.string(),
  })
  .strict();
const operationSchema = z
  .object({
    id: z.string().uuid(),
    owner: worktreeRecordSchema,
    sourceOid: oidSchema,
    destinationRef: z.string(),
    primaryBefore: z.string(),
  })
  .strict();
const previewSchema = z
  .object({
    token: z.string().uuid(),
    projectId: z.string(),
    contextId: z.string(),
    revision: z.string().uuid(),
    sourceOid: oidSchema,
    targetBranch: z.string(),
    targetOid: oidSchema,
    canApply: z.boolean(),
    reason: z.string().optional(),
    files: z.array(z.string()),
  })
  .strict();
const applySchema = z
  .object({
    preview: previewSchema,
    primaryBefore: z.string(),
    phase: z.enum(["preview", "applying", "applied", "error"]),
    error: z.string().optional(),
    resultOid: oidSchema.optional(),
  })
  .strict();
const entrySchema = z
  .object({
    state: stateSchema,
    owner: worktreeRecordSchema,
    operation: operationSchema.optional(),
    apply: applySchema.optional(),
    completedRunIds: z.array(z.string()).optional(),
  })
  .strict();
const journalSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().uuid(),
    entries: z.array(entrySchema).max(100000),
  })
  .strict();
type Entry = z.infer<typeof entrySchema>;
type Journal = z.infer<typeof journalSchema>;
const tails = new Map<string, Promise<unknown>>();
const hash = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const changed = () =>
  new Error("Контекст или журнал синхронизации изменён. Обновите данные.");
/** Synchronization only imports commits. Explicit confirmed apply is a separate operation. */
export class ContextSyncManager {
  private readonly root: string;
  private readonly file: string;
  private readonly clones: CloneStore;
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    readonly home: string,
    readonly runner: Pick<Runner, "command">,
    readonly deps: ContextSyncDependencies,
  ) {
    if (!path.isAbsolute(home) || path.resolve(home) !== home) throw changed();
    this.root = path.join(home, ".goga", "desktop", "sync");
    this.file = path.join(this.root, "journal.json");
    this.clones = new CloneStore(home);
    this.env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    for (const key of Object.keys(process.env))
      if (key.startsWith("GIT_") && !(key in this.env))
        this.env[key] = undefined;
  }
  private async prepare() {
    await this.clones.assertRoot();
    await noSymlinks(this.root);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await noSymlinks(this.root);
    const s = await lstat(this.root);
    if (
      !s.isDirectory() ||
      (process.getuid && s.uid !== process.getuid()) ||
      (s.mode & 0o077) !== 0
    )
      throw changed();
  }
  private async text(file: string): Promise<string | undefined> {
    await noSymlinks(file);
    let fd;
    try {
      fd = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if (missing(e)) return;
      throw e;
    }
    try {
      const s = await fd.stat();
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.size > 16 * 1024 * 1024 ||
        (s.mode & 0o077) !== 0 ||
        (process.getuid && s.uid !== process.getuid())
      )
        throw changed();
      return await fd.readFile("utf8");
    } finally {
      await fd.close();
    }
  }
  private async read(): Promise<{ journal: Journal; raw: string | undefined }> {
    const raw = await this.text(this.file);
    return {
      raw,
      journal:
        raw === undefined
          ? { schemaVersion: 1, revision: randomUUID(), entries: [] }
          : journalSchema.parse(JSON.parse(raw)),
    };
  }
  private async write(journal: Journal, expected: string | undefined) {
    if ((await this.text(this.file)) !== expected) throw changed();
    const file = `${this.file}.${randomUUID()}.tmp`;
    const raw = JSON.stringify({ ...journal, revision: randomUUID() });
    try {
      const fd = await open(file, "wx", 0o600);
      try {
        await fd.writeFile(raw);
        await fd.sync();
      } finally {
        await fd.close();
      }
      if ((await this.text(this.file)) !== expected) throw changed();
      await noSymlinks(this.file);
      await rename(file, this.file);
      const dir = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await unlink(file).catch(() => {});
    }
    return raw;
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const previous = tails.get(this.root) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        await this.prepare();
        const file = path.join(this.root, "operation.lock");
        const nonce = randomUUID();
        let fd;
        try {
          fd = await open(file, "wx", 0o600);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST")
            throw new Error(
              "Синхронизация занята другим процессом; повторите или восстановите после перезапуска.",
            );
          throw e;
        }
        const raw = JSON.stringify({ pid: process.pid, nonce });
        try {
          await fd.writeFile(raw);
          await fd.sync();
          return await action();
        } finally {
          await fd.close();
          if ((await this.text(file)) === raw) await unlink(file);
        }
      });
    tails.set(this.root, next);
    try {
      return await next;
    } finally {
      if (tails.get(this.root) === next) tails.delete(this.root);
    }
  }
  private async git(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = this.env,
  ) {
    await noSymlinks(cwd);
    await noSymlinks(path.join(cwd, ".git"));
    const result = await this.runner.command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "fetch.writeCommitGraph=false",
        "-c",
        "core.fsmonitor=false",
        ...args,
      ],
      cwd,
      env,
    );
    await noSymlinks(cwd);
    await noSymlinks(path.join(cwd, ".git"));
    return result.stdout;
  }
  private async owner(project: Project, input: TopicContextRef) {
    const ref = topicContextRefSchema.parse(input);
    if (ref.projectId !== project.id) throw changed();
    const owner = worktreeRecordSchema.parse(await this.deps.resolve(ref));
    if (
      JSON.stringify(worktreeContextRef(owner)) !== JSON.stringify(ref) ||
      owner.storageKind !== "clone" ||
      owner.ownership !== "managed" ||
      owner.state !== "ready" ||
      owner.projectPath !== project.path ||
      !owner.sourceCommonDir
    )
      throw changed();
    await this.clones.assertOwned(owner);
    for (const target of [
      project.path,
      owner.path,
      owner.gitCommonDir,
      owner.sourceCommonDir,
    ]) {
      await noSymlinks(target);
      if ((await realpath(target)) !== target) throw changed();
    }
    if (
      (
        await this.git(["rev-parse", "--show-toplevel"], project.path)
      ).trim() !== project.path ||
      (
        await this.git(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          project.path,
        )
      ).trim() !== owner.sourceCommonDir ||
      (
        await this.git(["rev-parse", "--absolute-git-dir"], project.path)
      ).trim() !== owner.sourceCommonDir
    )
      throw changed();
    if (
      (await this.git(["rev-parse", "--show-toplevel"], owner.path)).trim() !==
        owner.path ||
      (
        await this.git(["rev-parse", "--absolute-git-dir"], owner.path)
      ).trim() !== owner.gitCommonDir ||
      (await this.git(["symbolic-ref", "HEAD"], owner.path)).trim() !==
        `refs/heads/${owner.branch}`
    )
      throw changed();
    return owner;
  }
  private async head(cwd: string) {
    return oidSchema.parse(
      (await this.git(["rev-parse", "--verify", "HEAD^{commit}"], cwd)).trim(),
    );
  }
  private assertEntry(
    entry: Entry,
    owner: WorktreeRecord,
    recoverCompletedRevision = false,
  ) {
    if (
      entry.state.projectId !== entry.owner.projectId ||
      entry.state.contextId !== entry.owner.contextId ||
      entry.state.revision !== entry.owner.revision
    )
      throw changed();
    if (JSON.stringify(entry.owner) === JSON.stringify(owner)) return;
    const sameOwnedClone = (previous: WorktreeRecord) =>
      JSON.stringify({ ...previous, revision: owner.revision }) ===
      JSON.stringify(owner);
    const operation = entry.operation;
    if (
      !recoverCompletedRevision ||
      entry.owner.revision === owner.revision ||
      !sameOwnedClone(entry.owner) ||
      !["synced", "new"].includes(entry.state.status) ||
      entry.state.waitingRunIds.length > 0 ||
      (entry.apply && entry.apply.phase !== "applied") ||
      (operation &&
        (!sameOwnedClone(operation.owner) ||
          operation.sourceOid !== entry.state.importedOid ||
          operation.id !== entry.state.operationId ||
          operation.destinationRef !== entry.state.destinationRef ||
          operation.destinationRef !==
            `refs/desktop/contexts/${owner.contextId}/${operation.id}`))
    )
      throw changed();
    // owner() already revalidated the original reservation's physical inodes.
    // Only completed state may follow a revision refresh of that exact clone;
    // keep captured operations/previews immutable and never resume them here.
    entry.owner = owner;
    entry.state.revision = owner.revision;
  }
  private initial(owner: WorktreeRecord): Entry {
    return {
      owner,
      state: {
        projectId: owner.projectId,
        contextId: owner.contextId,
        revision: owner.revision,
        status: "new",
        waitingRunIds: [],
        reasons: [],
        updatedAt: new Date().toISOString(),
      },
    };
  }
  private async primarySnapshot(owner: WorktreeRecord) {
    const cwd = owner.projectPath;
    const names = [
      ...new Set(
        (
          await this.git(
            ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd,
          )
        )
          .split("\0")
          .filter(Boolean),
      ),
    ].sort();
    const files = [];
    for (const name of names) {
      const target = path.resolve(cwd, name);
      if (!target.startsWith(cwd + path.sep)) throw changed();
      let value;
      try {
        await noSymlinks(path.dirname(target));
        const s = await lstat(target);
        value = s.isSymbolicLink()
          ? ["link", await readlink(target)]
          : s.isFile()
            ? ["file", s.mode, hash(await readFile(target))]
            : ["other", s.mode];
      } catch (e) {
        if (!missing(e)) throw e;
        value = ["missing"];
      }
      files.push([name, value]);
    }
    let index: string | undefined;
    try {
      index = hash(await readFile(path.join(owner.sourceCommonDir!, "index")));
    } catch (e) {
      if (!missing(e)) throw e;
    }
    return hash(
      JSON.stringify({
        head: await this.head(cwd),
        branch: await this.targetBranch(cwd),
        index,
        status: await this.git(
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          cwd,
        ),
        files,
      }),
    );
  }
  private notify(state: ContextSyncState) {
    try {
      this.deps.onChange?.(structuredClone(state));
    } catch {
      /* Notification failure cannot rewrite a durable import outcome. */
    }
  }
  async request(
    project: Project,
    ref: TopicContextRef,
    reason: ContextSyncReason = "manual",
    runId?: string,
  ): Promise<ContextSyncState> {
    return this.locked(async () => {
      const owner = await this.owner(project, ref);
      const doc = await this.read();
      let entry = doc.journal.entries.find(
        (e) => e.state.contextId === owner.contextId,
      );
      if (entry) this.assertEntry(entry, owner, true);
      if (!entry) {
        entry = this.initial(owner);
        doc.journal.entries.push(entry);
      }
      if (
        reason === "automatic" &&
        runId &&
        entry.completedRunIds?.includes(runId)
      ) {
        const current = await this.head(owner.path);
        if (
          entry.state.status === "synced" &&
          entry.state.importedOid !== current
        )
          entry.state.status = "new";
        await this.write(doc.journal, doc.raw);
        return { ...structuredClone(entry.state), sourceOid: current };
      }
      if (!entry.state.reasons.includes(reason))
        entry.state.reasons.push(reason);
      if (runId && !entry.state.waitingRunIds.includes(runId))
        entry.state.waitingRunIds.push(runId);
      if (this.deps.isActive(owner.contextId)) {
        entry.state.status = "waiting";
        entry.state.updatedAt = new Date().toISOString();
        await this.write(doc.journal, doc.raw);
        this.notify(entry.state);
        return structuredClone(entry.state);
      }
      entry.completedRunIds = [
        ...new Set([
          ...(entry.completedRunIds ?? []),
          ...entry.state.waitingRunIds,
        ]),
      ];
      const sourceOid = await this.head(owner.path);
      if (
        entry.state.importedOid === sourceOid &&
        entry.state.destinationRef &&
        (
          await this.git(
            [
              "for-each-ref",
              "--format=%(objectname)",
              entry.state.destinationRef,
            ],
            owner.projectPath,
          )
        ).trim() === sourceOid
      ) {
        entry.state.status = "synced";
        entry.state.sourceOid = sourceOid;
        entry.state.waitingRunIds = [];
        entry.state.error = undefined;
        await this.write(doc.journal, doc.raw);
        return structuredClone(entry.state);
      }
      const operationId = randomUUID();
      entry.operation = {
        id: operationId,
        owner,
        sourceOid,
        destinationRef: `refs/desktop/contexts/${owner.contextId}/${operationId}`,
        primaryBefore: await this.primarySnapshot(owner),
      };
      entry.state = {
        ...entry.state,
        status: "syncing",
        sourceOid,
        operationId,
        destinationRef: entry.operation.destinationRef,
        error: undefined,
        updatedAt: new Date().toISOString(),
      };
      const raw = await this.write(doc.journal, doc.raw);
      this.notify(entry.state);
      return this.importOperation(project, ref, doc.journal, entry, raw);
    });
  }

  private async importOperation(
    project: Project,
    ref: TopicContextRef,
    journal: Journal,
    entry: Entry,
    raw: string,
  ): Promise<ContextSyncState> {
    const operation = entry.operation!;
    const owner = operation.owner;
    try {
      this.assertEntry(entry, await this.owner(project, ref));
      if (
        JSON.stringify(entry.owner) !== JSON.stringify(owner) ||
        entry.state.operationId !== operation.id ||
        entry.state.sourceOid !== operation.sourceOid ||
        entry.state.destinationRef !== operation.destinationRef ||
        operation.destinationRef !==
          `refs/desktop/contexts/${owner.contextId}/${operation.id}`
      )
        throw changed();
      if (this.deps.isActive(owner.contextId)) {
        entry.state.status = "waiting";
        await this.write(journal, raw);
        return structuredClone(entry.state);
      }
      const before = await this.primarySnapshot(owner);
      if (before !== operation.primaryBefore)
        throw new Error(
          "Состояние основной рабочей копии изменилось; импорт не продолжен.",
        );
      const existing = (
        await this.git(
          ["for-each-ref", "--format=%(objectname)", operation.destinationRef],
          owner.projectPath,
        )
      ).trim();
      if (existing && existing !== operation.sourceOid)
        throw new Error(
          "Служебная ссылка занята другим OID; импорт не перезаписывает refs.",
        );
      if (!existing)
        await this.git(
          [
            "fetch",
            "--atomic",
            "--no-tags",
            "--no-write-fetch-head",
            "--no-recurse-submodules",
            "--no-auto-maintenance",
            "--refmap=",
            owner.path,
            `${operation.sourceOid}:${operation.destinationRef}`,
          ],
          owner.projectPath,
        );
      await this.owner(project, ref);
      if (
        (
          await this.git(
            ["rev-parse", "--verify", `${operation.destinationRef}^{commit}`],
            owner.projectPath,
          )
        ).trim() !== operation.sourceOid ||
        (await this.primarySnapshot(owner)) !== operation.primaryBefore
      )
        throw new Error(
          "OID или состояние основной рабочей копии изменились во время импорта.",
        );
      entry.state = {
        ...entry.state,
        status:
          (await this.head(owner.path)) === operation.sourceOid
            ? "synced"
            : "new",
        importedOid: operation.sourceOid,
        waitingRunIds: [],
        error: undefined,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      entry.state = {
        ...entry.state,
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "Не удалось синхронизировать коммиты.",
        updatedAt: new Date().toISOString(),
      };
    }
    await this.write(journal, raw);
    this.notify(entry.state);
    return structuredClone(entry.state);
  }
  /** Called only after the host observes real process/group termination, not a UI outcome event. */
  afterRun(project: Project, ref: TopicContextRef, runId: string) {
    return this.request(project, ref, "automatic", runId);
  }
  async status(
    project: Project,
    ref: TopicContextRef,
  ): Promise<ContextSyncState> {
    await this.prepare();
    return (async () => {
      const owner = await this.owner(project, ref),
        doc = await this.read(),
        entry =
          doc.journal.entries.find(
            (e) => e.state.contextId === owner.contextId,
          ) ?? this.initial(owner);
      this.assertEntry(entry, owner, true);
      const state = structuredClone(entry.state);
      state.sourceOid = await this.head(owner.path);
      if (state.status === "synced" || state.status === "new") {
        const imported = state.destinationRef
          ? (
              await this.git(
                [
                  "for-each-ref",
                  "--format=%(objectname)",
                  state.destinationRef,
                ],
                owner.projectPath,
              )
            ).trim()
          : "";
        state.status =
          state.importedOid === state.sourceOid && imported === state.sourceOid
            ? "synced"
            : "new";
      }
      return state;
    })();
  }
  async retry(
    project: Project,
    ref: TopicContextRef,
  ): Promise<ContextSyncState> {
    return this.locked(async () => {
      const owner = await this.owner(project, ref),
        doc = await this.read(),
        entry = doc.journal.entries.find(
          (e) => e.state.contextId === owner.contextId,
        );
      if (
        !entry?.operation ||
        entry.owner.revision !== owner.revision ||
        entry.operation.owner.revision !== owner.revision
      )
        throw new Error("Нет сохранённой операции для повтора.");
      entry.state.status = this.deps.isActive(owner.contextId)
        ? "waiting"
        : "syncing";
      entry.state.error = undefined;
      entry.state.updatedAt = new Date().toISOString();
      const raw = await this.write(doc.journal, doc.raw);
      this.notify(entry.state);
      return this.importOperation(project, ref, doc.journal, entry, raw);
    });
  }
  private async recoverLock() {
    await this.prepare();
    const file = path.join(this.root, "operation.lock"),
      raw = await this.text(file);
    if (raw === undefined) return;
    const value = z
      .object({ pid: z.number().int().positive(), nonce: z.string().uuid() })
      .strict()
      .parse(JSON.parse(raw));
    try {
      process.kill(value.pid, 0);
      throw new Error("Предыдущий процесс синхронизации ещё работает.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
    }
    // A dead owner cannot update this lock. Cooperating writers never replace an extant lock.
    if ((await this.text(file)) !== raw) throw changed();
    await unlink(file);
  }
  async recover(projects: Project[]): Promise<ContextSyncState[]> {
    await this.recoverLock();
    const rows = await this.locked(async () =>
      structuredClone((await this.read()).journal.entries),
    );
    const result: ContextSyncState[] = [];
    for (const entry of rows) {
      const project = projects.find(
        (p) =>
          p.id === entry.state.projectId && p.path === entry.owner.projectPath,
      );
      if (!project) continue;
      try {
        await this.recoverApply(project, worktreeContextRef(entry.owner));
        result.push(
          entry.state.status === "syncing" || entry.state.status === "error"
            ? await this.retry(project, worktreeContextRef(entry.owner))
            : entry.state.status === "waiting"
              ? await this.request(
                  project,
                  worktreeContextRef(entry.owner),
                  "automatic",
                )
              : await this.status(project, worktreeContextRef(entry.owner)),
        );
      } catch (error) {
        result.push({
          ...entry.state,
          status: "error",
          error:
            error instanceof Error
              ? error.message
              : "Не удалось восстановить импорт.",
        });
      }
    }
    return result;
  }

  private async targetBranch(cwd: string) {
    try {
      const ref = (
        await this.git(["symbolic-ref", "--quiet", "HEAD"], cwd)
      ).trim();
      return ref.startsWith("refs/heads/") ? ref.slice(11) : "";
    } catch {
      return "";
    }
  }
  private async applyGuard(owner: WorktreeRecord): Promise<string | undefined> {
    if (
      this.deps.isActive(owner.contextId) ||
      this.deps.isProjectActive?.(owner.projectId)
    )
      return "Сначала дождитесь завершения активных операций проекта и топика.";
    const branch = await this.targetBranch(owner.projectPath);
    if (!branch)
      return "В основной копии не выбрана целевая ветка (detached HEAD).";
    for (const name of [
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_LOG",
      "rebase-merge",
      "rebase-apply",
      "sequencer",
      "index.lock",
      "HEAD.lock",
      `refs/heads/${branch}.lock`,
    ]) {
      const file = path.join(owner.sourceCommonDir!, name);
      await noSymlinks(file);
      try {
        await lstat(file);
        return "В основной копии уже идёт операция Git. Завершите её вручную.";
      } catch (e) {
        if (!missing(e)) throw e;
      }
    }
    if (
      (
        await this.git(
          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
          owner.projectPath,
        )
      ).length
    )
      return "Основная рабочая копия содержит локальные изменения. Сначала сохраните их вручную.";
    return;
  }
  private async mergePreview(
    owner: WorktreeRecord,
    targetOid: string,
    sourceOid: string,
  ): Promise<string[]> {
    const raw = await this.git(
      ["merge-tree", "--write-tree", "--messages", targetOid, sourceOid],
      owner.projectPath,
    );
    const tree = oidSchema.parse(raw.split("\n")[0]);
    return (
      await this.git(
        ["diff", "--name-only", "-z", targetOid, tree, "--"],
        owner.projectPath,
      )
    )
      .split("\0")
      .filter(Boolean);
  }
  async previewApply(
    project: Project,
    ref: TopicContextRef,
  ): Promise<ContextApplyPreview> {
    return this.locked(async () => {
      const owner = await this.owner(project, ref),
        doc = await this.read(),
        entry = doc.journal.entries.find(
          (e) => e.state.contextId === owner.contextId,
        );
      if (!entry || !entry.state.importedOid || !entry.state.destinationRef)
        throw new Error("Сначала синхронизируйте коммиты топика.");
      this.assertEntry(entry, owner, true);
      const sourceOid = entry.state.importedOid,
        targetOid = await this.head(owner.projectPath),
        targetBranch = await this.targetBranch(owner.projectPath);
      const preview: ContextApplyPreview = {
        token: randomUUID(),
        projectId: project.id,
        contextId: owner.contextId,
        revision: owner.revision,
        sourceOid,
        targetBranch,
        targetOid,
        canApply: false,
        files: [],
      };
      let reason = await this.applyGuard(owner);
      if (
        !reason &&
        (
          await this.git(
            [
              "for-each-ref",
              "--format=%(objectname)",
              entry.state.destinationRef,
            ],
            owner.projectPath,
          )
        ).trim() !== sourceOid
      )
        reason =
          "Синхронизированная служебная ссылка изменена. Повторите синхронизацию.";
      if (!reason) {
        try {
          preview.files = await this.mergePreview(owner, targetOid, sourceOid);
        } catch {
          reason =
            "Предварительное слияние выявило конфликт или Git не поддерживает безопасный предпросмотр.";
        }
      }
      preview.canApply = !reason;
      if (reason) preview.reason = reason;
      if (preview.canApply) {
        entry.apply = {
          preview,
          phase: "preview",
          primaryBefore: await this.primarySnapshot(owner),
        };
        await this.write(doc.journal, doc.raw);
      }
      return preview;
    });
  }
  async applyProjectId(input: string): Promise<string> {
    const token = z.string().uuid().parse(input);
    await this.prepare();
    const doc = await this.read();
    const entries = doc.journal.entries.filter(
      (e) => e.apply?.preview.token === token && e.apply.phase === "preview",
    );
    if (entries.length !== 1)
      throw new Error("Предпросмотр устарел или уже использован.");
    return entries[0].state.projectId;
  }
  async apply(
    project: Project,
    input: { token: string; confirmed: true },
  ): Promise<ContextApplyResult> {
    if (input.confirmed !== true)
      throw new Error("Нужно явное подтверждение применения в целевую ветку.");
    const token = z.string().uuid().parse(input.token);
    return this.locked(async () => {
      const doc = await this.read(),
        entry = doc.journal.entries.find(
          (e) =>
            e.apply?.preview.token === token &&
            e.state.projectId === project.id,
        );
      if (
        !entry?.apply ||
        entry.apply.phase !== "preview" ||
        !entry.apply.preview.canApply
      )
        throw new Error(
          "Предпросмотр устарел или уже использован. Создайте новый.",
        );
      const owner = await this.owner(project, worktreeContextRef(entry.owner)),
        operation = entry.apply,
        preview = operation.preview;
      this.assertEntry(entry, owner);
      const guard = await this.applyGuard(owner);
      if (guard) throw new Error(guard);
      if (
        preview.revision !== owner.revision ||
        preview.contextId !== owner.contextId ||
        preview.sourceOid !== entry.state.importedOid ||
        (await this.head(owner.projectPath)) !== preview.targetOid ||
        (await this.targetBranch(owner.projectPath)) !== preview.targetBranch ||
        (await this.primarySnapshot(owner)) !== operation.primaryBefore
      )
        throw changed();
      if (
        !entry.state.destinationRef ||
        (
          await this.git(
            [
              "for-each-ref",
              "--format=%(objectname)",
              entry.state.destinationRef,
            ],
            owner.projectPath,
          )
        ).trim() !== preview.sourceOid
      )
        throw changed();
      await this.mergePreview(owner, preview.targetOid, preview.sourceOid);
      if (
        (await this.applyGuard(owner)) ||
        (await this.primarySnapshot(owner)) !== operation.primaryBefore
      )
        throw changed();
      operation.phase = "applying";
      const raw = await this.write(doc.journal, doc.raw);
      try {
        await this.git(
          [
            "-c",
            "merge.autoStash=false",
            "-c",
            "user.useConfigOnly=true",
            "-c",
            "commit.gpgSign=false",
            "-c",
            "rerere.enabled=false",
            "merge",
            "--ff",
            "--no-squash",
            "--commit",
            "--no-edit",
            "--no-gpg-sign",
            "--no-autostash",
            preview.sourceOid,
          ],
          owner.projectPath,
          {
            ...this.env,
            GIT_CONFIG_GLOBAL: undefined,
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: `branch.${preview.targetBranch}.mergeOptions`,
            GIT_CONFIG_VALUE_0: "",
          },
        );
        await this.owner(project, worktreeContextRef(owner));
        if (
          (await this.targetBranch(owner.projectPath)) !== preview.targetBranch
        )
          throw changed();
        const targetOid = await this.head(owner.projectPath);
        await this.git(
          ["merge-base", "--is-ancestor", preview.targetOid, targetOid],
          owner.projectPath,
        );
        await this.git(
          ["merge-base", "--is-ancestor", preview.sourceOid, targetOid],
          owner.projectPath,
        );
        operation.phase = "applied";
        operation.resultOid = targetOid;
        await this.write(doc.journal, raw);
        return {
          projectId: project.id,
          contextId: owner.contextId,
          sourceOid: preview.sourceOid,
          targetBranch: preview.targetBranch,
          previousTargetOid: preview.targetOid,
          targetOid,
        };
      } catch (error) {
        operation.phase = "error";
        operation.error =
          error instanceof Error
            ? error.message
            : "Слияние завершилось ошибкой.";
        await this.write(doc.journal, raw);
        throw new Error(
          "Применение не завершено. Проверьте Git вручную; Desktop не выполнял откат, reset или очистку. " +
            operation.error,
        );
      }
    });
  }

  private async recoverApply(project: Project, ref: TopicContextRef) {
    return this.locked(async () => {
      const doc = await this.read(),
        entry = doc.journal.entries.find(
          (e) => e.state.contextId === ref.contextId,
        );
      if (!entry?.apply || !["applying", "error"].includes(entry.apply.phase))
        return;
      const owner = await this.owner(project, ref),
        operation = entry.apply,
        preview = operation.preview;
      this.assertEntry(entry, owner);
      if (
        (await this.applyGuard(owner)) ||
        (await this.targetBranch(owner.projectPath)) !== preview.targetBranch
      )
        return;
      const current = await this.head(owner.projectPath);
      try {
        await this.git(
          ["merge-base", "--is-ancestor", preview.targetOid, current],
          owner.projectPath,
        );
        await this.git(
          ["merge-base", "--is-ancestor", preview.sourceOid, current],
          owner.projectPath,
        );
        operation.phase = "applied";
        operation.resultOid = current;
        operation.error = undefined;
      } catch {
        operation.phase = "error";
        operation.error =
          "Применение было прервано. Создайте новый предпросмотр; автоматический повтор слияния запрещён.";
      }
      await this.write(doc.journal, doc.raw);
    });
  }
}
