import { constants } from "node:fs";
import {
  lstat,
  open,
  realpath,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Project } from "../shared/types";
import {
  topicContextIdentitySchema,
  topicContextRefSchema,
  worktreeRecordSchema,
  worktreeContextRef,
  type TopicContextIdentity,
  type TopicContextRef,
  type WorktreeRecord,
} from "../shared/worktrees";
import { RunnerShutdownError, type Runner } from "./process";
import { CloneStore, managedCloneLocation } from "./clone-store";
import { noSymlinks } from "./settings";
import { assertReadActive } from "./read-scope";
import { assertClonePublicationOrigin } from "./context-exchange";
const unavailable = () =>
  Error(
    "Клон топика недоступен или конфликтует. Обновите контекст; основная папка не используется вместо клона.",
  );
const changed = () =>
  Error("Контекст изменён или его ревизия устарела. Выберите топик заново.");
const deleted = () =>
  Error(
    "Клон этого топика удалён. Для повторного создания требуется новая идентичность; архивные refs сохранены.",
  );
const ambiguous = () =>
  Error(
    "Подготовка клона неоднозначна. Нужна проверка; автоматический повтор запрещён.",
  );
const legacy = () =>
  Error(
    "Прежняя linked-копия требует явной миграции в автономный клон (legacy-linked).",
  );
const sameIdentity = (a: TopicContextIdentity, b: TopicContextIdentity) =>
  a.projectId === b.projectId &&
  a.year === b.year &&
  a.topic === b.topic &&
  a.branch === b.branch;
const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const createSchema = z
  .object({
    year: z.string().regex(/^\d{4}$/),
    branch: topicContextIdentitySchema.shape.branch,
    baseRef: topicContextIdentitySchema.shape.branch,
  })
  .strict();
const guardsSchema = z
  .object({ active: z.boolean(), current: z.boolean() })
  .strict();
const inodeSchema = z
  .object({ dev: z.number().int(), ino: z.number().int() })
  .strict();
const oidSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
const deletionSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
    owner: topicContextRefSchema,
    path: z.string(),
    projectPath: z.string(),
    sourceCommonDir: z.string(),
    sourceRoot: inodeSchema,
    sourceGit: inodeSchema,
    head: oidSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    archives: z
      .array(
        z
          .object({
            oid: oidSchema,
            destination: z.string(),
            verified: z.boolean(),
          })
          .strict(),
      )
      .max(100000),
    stage: z.enum([
      "prepared",
      "archiving",
      "archived",
      "removing-topic",
      "topic-removed",
      "trashing",
      "trashed",
      "completed",
    ]),
    expiresAt: z.number().int(),
    recordRevision: z.string().uuid(),
    deletionRevision: z.string().uuid(),
    tombstoneRevision: z.string().uuid(),
    deletedAt: z.string().datetime().optional(),
  })
  .strict();
export type CloneDeletionPlan = z.infer<typeof deletionSchema>;
export interface CloneDeletionResult {
  token: string;
  owner: TopicContextRef;
  status: "success" | "partial" | "failed";
  stage: CloneDeletionPlan["stage"];
  message: string;
}
export interface CloneDeletionCallbacks {
  /** Must address this prepared owner and be safe to retry after an uncertain result. */
  removeTopic?: () => Promise<void>;
  /** Must move this exact owned directory to recoverable trash, never rm recursively. */
  trashItem: (canonicalOwnedClonePath: string) => Promise<void>;
}
type Repository = { projectPath: string; sourceCommonDir: string };

/** Standalone owned repositories; never resolve a topic to the primary checkout. */
export class CloneManager {
  readonly store: CloneStore;
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    private readonly home: string,
    readonly runner: Pick<Runner, "command">,
  ) {
    this.store = new CloneStore(home);
    this.env = {
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    for (const key of Object.keys(process.env))
      if (key.startsWith("GIT_") && !(key in this.env))
        this.env[key] = undefined;
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_CONFIG",
      "GIT_CONFIG_COUNT",
    ])
      this.env[key] = undefined;
  }
  private async git(args: string[], cwd: string, owner?: WorktreeRecord) {
    await this.store.assertRoot();
    await noSymlinks(cwd);
    await noSymlinks(path.join(cwd, ".git"));
    if (owner) await this.store.assertOwned(owner);
    const result = await this.runner.command(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      cwd,
      this.env,
    );
    await this.store.assertRoot();
    await noSymlinks(cwd);
    await noSymlinks(path.join(cwd, ".git"));
    if (owner) await this.store.assertOwned(owner);
    return result.stdout;
  }
  private async repository(project: Project): Promise<Repository> {
    if (!project || !path.isAbsolute(project.path)) throw unavailable();
    const canonical = await realpath(project.path);
    await noSymlinks(canonical);
    const top = (
      await this.git(["rev-parse", "--show-toplevel"], canonical)
    ).trim();
    if ((await realpath(top)) !== canonical)
      throw Error("Выберите корневую папку Git-проекта.");
    const common = await realpath(
      (
        await this.git(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          canonical,
        )
      ).trim(),
    );
    const git = await realpath(
      (await this.git(["rev-parse", "--absolute-git-dir"], canonical)).trim(),
    );
    await noSymlinks(common);
    if (common !== git)
      throw Error(
        "Проект указывает на внешнюю linked-копию, а не основную папку.",
      );
    return { projectPath: canonical, sourceCommonDir: common };
  }
  private async legacyRecords(projectId?: string): Promise<WorktreeRecord[]> {
    const file = path.join(this.home, ".goga/desktop/worktrees/registry.json");
    await noSymlinks(file);
    let handle;
    try {
      handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 16 * 1024 * 1024 ||
        (info.mode & 0o077) !== 0
      )
        throw unavailable();
      const doc = z
        .object({
          schemaVersion: z.literal(1),
          revision: z.string().uuid(),
          records: z.array(worktreeRecordSchema).max(100000),
        })
        .strict()
        .parse(JSON.parse(await handle.readFile("utf8")));
      return doc.records
        .filter((r) => projectId === undefined || r.projectId === projectId)
        .map((r) => ({
          ...r,
          storageKind: "linked",
          compatibility: "legacy-linked",
          state: "conflict",
          reason: "legacy-linked",
        }));
    } finally {
      await handle.close();
    }
  }
  private async validate(record: WorktreeRecord): Promise<{
    state: "ready" | "missing" | "conflict";
    reason?: WorktreeRecord["reason"];
  }> {
    try {
      await this.store.assertRoot();
      try {
        await lstat(record.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { state: "missing", reason: "missing" };
        throw error;
      }
      await this.store.assertOwned(record);
      const source = await this.repository({
        id: record.projectId,
        name: "",
        path: record.projectPath,
      });
      if (source.sourceCommonDir !== record.sourceCommonDir)
        return { state: "conflict", reason: "repository" };
      for (const relative of ["objects", "objects/info", "config", "index"])
        await noSymlinks(path.join(record.gitCommonDir, relative));
      const config = await lstat(path.join(record.gitCommonDir, "config"));
      if (!config.isFile() || config.nlink !== 1)
        return { state: "conflict", reason: "repository" };
      const alternates = path.join(
        record.gitCommonDir,
        "objects/info/alternates",
      );
      await noSymlinks(alternates);
      try {
        const h = await open(
          alternates,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!(await h.stat()).isFile() || (await h.readFile("utf8")).trim())
            return { state: "conflict", reason: "repository" };
        } finally {
          await h.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const top = (
        await this.git(["rev-parse", "--show-toplevel"], record.path, record)
      ).trim();
      const common = (
        await this.git(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          record.path,
          record,
        )
      ).trim();
      const git = (
        await this.git(["rev-parse", "--absolute-git-dir"], record.path, record)
      ).trim();
      if (
        (await realpath(top)) !== record.path ||
        (await realpath(common)) !== record.gitCommonDir ||
        (await realpath(git)) !== record.gitCommonDir
      )
        return { state: "conflict", reason: "repository" };
      const branch = (
        await this.git(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          record.path,
          record,
        )
      ).trim();
      if (branch !== record.branch)
        return { state: "conflict", reason: "branch" };
      await this.git(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        record.path,
        record,
      );
      const index = await lstat(path.join(record.gitCommonDir, "index"));
      if (!index.isFile() || index.nlink !== 1)
        return { state: "conflict", reason: "repository" };
      if (
        record.preparation &&
        (
          await this.git(
            ["status", "--porcelain", "--untracked-files=all"],
            record.path,
            record,
          )
        ).trim()
      )
        return { state: "conflict", reason: "ambiguous-add" };
      const remote = (
        await this.git(
          ["remote", "get-url", "desktop-source"],
          record.path,
          record,
        )
      ).trim();
      const remotes = (await this.git(["remote"], record.path, record))
        .trim()
        .split("\n");
      const pushUrl = (
        await this.git(
          ["remote", "get-url", "--push", "desktop-source"],
          record.path,
          record,
        )
      ).trim();
      if (remote !== record.projectPath || pushUrl !== "/dev/null")
        return { state: "conflict", reason: "repository" };
      // Discovery validates persisted physical trust, not a guessed native env.
      // Exchange prepare/verify checks effective endpoints under the final child env.
      if (remotes.includes("origin"))
        await assertClonePublicationOrigin(this.home, this.runner, record);
      await this.store.assertOwned(record);
      return { state: "ready" };
    } catch (error) {
      if (error instanceof RunnerShutdownError) throw error;
      assertReadActive();
      return { state: "conflict", reason: "ownership" };
    }
  }
  private async refresh(record: WorktreeRecord): Promise<WorktreeRecord> {
    if (record.state === "deleting" || record.deletedAt) return record;
    const actual = await this.validate(record);
    assertReadActive();
    if (actual.state !== "ready" && record.preparation) {
      actual.state = "conflict";
      actual.reason = "ambiguous-add";
    }
    const preparation =
      actual.state === "ready"
        ? undefined
        : record.preparation
          ? ("ambiguous" as const)
          : undefined;
    if (
      actual.state === record.state &&
      actual.reason === record.reason &&
      preparation === record.preparation
    )
      return record;
    return this.store.update(
      {
        ...record,
        ...actual,
        reason: actual.reason,
        preparation,
        revision: randomUUID(),
      },
      record.revision,
    );
  }
  private async prepare(
    project: Project,
    identity: TopicContextIdentity,
    repository: Repository,
    oid: string,
    isNew: boolean,
  ): Promise<WorktreeRecord> {
    const location = managedCloneLocation(
      this.home,
      { id: project.id, path: repository.projectPath },
      repository.sourceCommonDir,
      identity,
    );
    const existing = (await this.store.read()).records.find(
      (r) => r.contextId === location.contextId,
    );
    if (existing) {
      if (existing.deletedAt) throw deleted();
      const current = await this.refresh(existing);
      if (current.state === "ready") return current;
      // Recreating a missing clone may lose the sole copy of unique commits.
      // Only explicit recovery can remove/reuse its ownership reservation.
      throw ambiguous();
    }
    const pending: WorktreeRecord = {
      ...identity,
      ...repository,
      ...location,
      gitCommonDir: path.join(location.path, ".git"),
      storageKind: "clone",
      ownership: "managed",
      state: "missing",
      preparation: "pending",
      revision: randomUUID(),
    };
    await this.store.reserve(pending);
    try {
      await this.store.assertOwned(pending, false);
      await this.git(
        [
          "clone",
          "--no-local",
          "--no-hardlinks",
          "--no-checkout",
          "--origin",
          "desktop-source",
          ...(!isNew ? ["--branch", identity.branch] : []),
          "--",
          repository.projectPath,
          pending.path,
        ],
        repository.projectPath,
      );
      await this.store.assertOwned(pending, false);
      await this.store.claimGit(pending);
      // desktop-source is transport-only, never a publication destination.
      await this.git(
        ["config", "--local", "remote.desktop-source.pushurl", "/dev/null"],
        pending.path,
        pending,
      );
      if (isNew)
        await this.git(
          ["checkout", "--no-track", "-b", identity.branch, oid, "--"],
          pending.path,
          pending,
        );
      else {
        const actual = (
          await this.git(
            ["rev-parse", "--verify", `refs/heads/${identity.branch}^{commit}`],
            pending.path,
            pending,
          )
        ).trim();
        if (actual !== oid) throw changed();
        await this.git(
          ["checkout", identity.branch, "--"],
          pending.path,
          pending,
        );
      }
    } catch {
      const reconciled = await this.refresh(pending);
      if (reconciled.state === "ready") return reconciled;
      throw ambiguous();
    }
    const ready = await this.refresh(pending);
    if (ready.state !== "ready") throw unavailable();
    return ready;
  }
  async ensure(
    project: Project,
    input: TopicContextIdentity,
  ): Promise<WorktreeRecord> {
    return this.ensureInternal(project, input, false);
  }
  /** Explicit opt-in only: keep the legacy linked checkout and its registry intact. */
  async migrateLegacy(
    project: Project,
    input: TopicContextIdentity,
  ): Promise<WorktreeRecord> {
    return this.ensureInternal(project, input, true);
  }
  private async ensureInternal(
    project: Project,
    input: TopicContextIdentity,
    migrate: boolean,
  ): Promise<WorktreeRecord> {
    const identity = topicContextIdentitySchema.parse(input);
    if (identity.projectId !== project.id) throw unavailable();
    const repository = await this.repository(project);
    const location = managedCloneLocation(
      this.home,
      { id: project.id, path: repository.projectPath },
      repository.sourceCommonDir,
      identity,
    );
    return this.store.withRepositoryLock(location.repositoryKey, async () => {
      const existing = (await this.store.read()).records.find(
        (r) => r.contextId === location.contextId,
      );
      if (existing) {
        if (existing.deletedAt) throw deleted();
        const row = await this.refresh(existing);
        if (row.state !== "ready") throw ambiguous();
        return row;
      }
      const hasLegacy = (await this.legacyRecords(project.id)).some(
        (r) =>
          sameIdentity(r, identity) && r.projectPath === repository.projectPath,
      );
      if ((!migrate && hasLegacy) || (migrate && !hasLegacy)) throw legacy();
      await this.git(
        ["check-ref-format", `refs/heads/${identity.branch}`],
        repository.projectPath,
      );
      const oid = (
        await this.git(
          ["rev-parse", "--verify", `refs/heads/${identity.branch}^{commit}`],
          repository.projectPath,
        )
      ).trim();
      return this.prepare(project, identity, repository, oid, false);
    });
  }
  async create(
    project: Project,
    input: { year: string; branch: string; baseRef: string },
  ): Promise<WorktreeRecord> {
    const request = createSchema.parse(input),
      topic = normalize(request.branch);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic) || topic.length > 180)
      throw Error("Имя ветки не образует допустимый топик.");
    const identity = {
      projectId: project.id,
      year: request.year,
      topic,
      branch: request.branch,
    };
    const repository = await this.repository(project);
    const location = managedCloneLocation(
      this.home,
      { id: project.id, path: repository.projectPath },
      repository.sourceCommonDir,
      identity,
    );
    return this.store.withRepositoryLock(location.repositoryKey, async () => {
      const records = [
        ...(await this.store.read()).records,
        ...(await this.legacyRecords(project.id)),
      ];
      if (
        records.some(
          (r) =>
            r.projectId === project.id &&
            r.year === request.year &&
            normalize(r.topic) === topic &&
            r.deletedAt,
        )
      )
        throw deleted();
      if (
        records.some(
          (r) =>
            r.projectId === project.id &&
            r.year === request.year &&
            normalize(r.topic) === topic,
        )
      )
        throw Error(
          "Топик с совпадающим нормализованным именем уже существует.",
        );
      await this.git(
        ["check-ref-format", `refs/heads/${request.branch}`],
        repository.projectPath,
      );
      const refs = (
        await this.git(
          [
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
          ],
          repository.projectPath,
        )
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      if (
        refs.some(
          (ref) =>
            normalize(ref) === topic ||
            (ref.includes("/") &&
              normalize(ref.slice(ref.indexOf("/") + 1)) === topic),
        )
      )
        throw Error("Топик или ветка уже существует.");
      const history = path.join(
        repository.projectPath,
        ".goga/history",
        request.year,
        topic,
      );
      await noSymlinks(history);
      try {
        await lstat(history);
        throw Error("Каталог топика уже существует.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const oid = (
        await this.git(
          [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${request.baseRef}^{commit}`,
          ],
          repository.projectPath,
        )
      ).trim();
      return this.prepare(project, identity, repository, oid, true);
    });
  }
  async resolve(input: TopicContextRef): Promise<WorktreeRecord> {
    const ref = topicContextRefSchema.parse(input);
    const initial = (await this.store.read()).records.find(
      (r) => r.contextId === ref.contextId,
    );
    if (!initial || !sameIdentity(initial, ref)) {
      if (
        (await this.legacyRecords(ref.projectId)).some(
          (r) => r.contextId === ref.contextId,
        )
      )
        throw legacy();
      throw unavailable();
    }
    return this.store.withRepositoryLock(initial.repositoryKey, async () => {
      const row = (await this.store.read()).records.find(
        (r) => r.contextId === ref.contextId,
      );
      if (!row || !sameIdentity(row, ref)) throw unavailable();
      if (row.revision !== ref.revision) throw changed();
      const current = await this.refresh(row);
      if (current.state !== "ready") throw unavailable();
      if (current.revision !== ref.revision) throw changed();
      return current;
    });
  }
  async list(projectId?: string): Promise<WorktreeRecord[]> {
    return [
      ...(await this.store.read()).records.filter(
        (r) => projectId === undefined || r.projectId === projectId,
      ),
      ...(await this.legacyRecords(projectId)),
    ];
  }
  async reconcile(projectId?: string): Promise<WorktreeRecord[]> {
    for (const record of (await this.store.read()).records.filter(
      (r) => projectId === undefined || r.projectId === projectId,
    ))
      await this.store.withRepositoryLock(record.repositoryKey, async () => {
        const latest = (await this.store.read()).records.find(
          (r) => r.contextId === record.contextId,
        );
        if (latest) await this.refresh(latest);
      });
    return this.list(projectId);
  }

  private deletionFile(token: string) {
    z.string().uuid().parse(token);
    return path.join(this.store.root, `.deletion-${token}.json`);
  }
  private async readDeletion(token: string): Promise<CloneDeletionPlan> {
    await this.store.assertRoot();
    const file = this.deletionFile(token);
    await noSymlinks(file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 16 * 1024 * 1024 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw unavailable();
      const plan = deletionSchema.parse(
        JSON.parse(await handle.readFile("utf8")),
      );
      if (
        plan.token !== token ||
        plan.archives.some(
          (entry, index) =>
            entry.destination !==
            `refs/desktop/archive/${plan.owner.contextId}/${token}/${index}`,
        )
      )
        throw unavailable();
      return plan;
    } finally {
      await handle.close();
    }
  }
  private async writeDeletion(plan: CloneDeletionPlan, create = false) {
    deletionSchema.parse(plan);
    await this.store.assertRoot();
    const file = this.deletionFile(plan.token),
      temp = `${file}.${randomUUID()}.tmp`;
    await noSymlinks(file);
    if (create) {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(plan));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      try {
        const handle = await open(temp, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(plan));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.store.assertRoot();
        await noSymlinks(file);
        await rename(temp, file);
      } finally {
        await unlink(temp).catch(() => {});
      }
    }
    const directory = await open(
      this.store.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private deletionGuards(input: { active: boolean; current: boolean }) {
    const guards = guardsSchema.parse(input);
    if (guards.active)
      throw Error("В клоне работает активный процесс; удаление запрещено.");
    if (guards.current)
      throw Error("Сначала выберите другой топик; текущий удалять нельзя.");
  }
  private async inode(target: string) {
    await noSymlinks(target);
    const info = await lstat(target);
    if (!info.isDirectory()) throw unavailable();
    return { dev: info.dev, ino: info.ino };
  }
  private async deletionSnapshot(record: WorktreeRecord) {
    if ((await this.validate(record)).state !== "ready") throw unavailable();
    const status = await this.git(
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      record.path,
      record,
    );
    if (status.trim())
      throw Error(
        "В клоне есть локальные изменения или ценные файлы, включая ignored. Удаление запрещено.",
      );
    const head = oidSchema.parse(
      (
        await this.git(
          ["rev-parse", "--verify", "HEAD^{commit}"],
          record.path,
          record,
        )
      ).trim(),
    );
    const refs = (
      await this.git(
        ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs"],
        record.path,
        record,
      )
    ).trim();
    const reflog = (
      await this.git(
        ["reflog", "show", "--all", "--format=%H"],
        record.path,
        record,
      )
    ).trim();
    const tips = new Set([head]);
    for (const line of refs.split("\n").filter(Boolean))
      tips.add(oidSchema.parse(line.slice(line.indexOf("\0") + 1)));
    for (const line of reflog.split("\n").filter(Boolean))
      tips.add(oidSchema.parse(line));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([head, refs, reflog]))
      .digest("hex");
    return {
      head,
      fingerprint,
      tips: [...tips].sort(),
      sourceRoot: await this.inode(record.projectPath),
      sourceGit: await this.inode(record.sourceCommonDir!),
    };
  }
  async prepareDeletion(
    ref: TopicContextRef,
    guards: { active: boolean; current: boolean },
  ): Promise<CloneDeletionPlan> {
    this.deletionGuards(guards);
    const initial = await this.resolve(ref);
    return this.store.withRepositoryLock(initial.repositoryKey, async () => {
      const row = (await this.store.read()).records.find(
        (r) => r.contextId === initial.contextId,
      );
      if (!row || row.revision !== ref.revision || row.state !== "ready")
        throw changed();
      const snapshot = await this.deletionSnapshot(row),
        token = randomUUID();
      const plan: CloneDeletionPlan = {
        schemaVersion: 1,
        token,
        owner: worktreeContextRef(row),
        path: row.path,
        projectPath: row.projectPath,
        sourceCommonDir: row.sourceCommonDir!,
        sourceRoot: snapshot.sourceRoot,
        sourceGit: snapshot.sourceGit,
        head: snapshot.head,
        fingerprint: snapshot.fingerprint,
        recordRevision: row.revision,
        archives: snapshot.tips.map((oid, index) => ({
          oid,
          destination: `refs/desktop/archive/${row.contextId}/${token}/${index}`,
          verified: false,
        })),
        stage: "prepared",
        expiresAt: Date.now() + 120000,
        deletionRevision: randomUUID(),
        tombstoneRevision: randomUUID(),
      };
      await this.writeDeletion(plan, true);
      return plan;
    });
  }
  private async assertDeletionSnapshot(
    plan: CloneDeletionPlan,
    row: WorktreeRecord,
  ) {
    if (
      row.revision !== plan.recordRevision ||
      row.path !== plan.path ||
      row.projectPath !== plan.projectPath ||
      row.sourceCommonDir !== plan.sourceCommonDir ||
      !sameIdentity(row, plan.owner)
    )
      throw changed();
    const fresh = await this.deletionSnapshot(row);
    if (
      fresh.head !== plan.head ||
      fresh.fingerprint !== plan.fingerprint ||
      JSON.stringify(fresh.sourceRoot) !== JSON.stringify(plan.sourceRoot) ||
      JSON.stringify(fresh.sourceGit) !== JSON.stringify(plan.sourceGit)
    )
      throw changed();
  }
  private async finishDeletion(plan: CloneDeletionPlan, row: WorktreeRecord) {
    if (!plan.deletedAt) throw changed();
    if (
      !sameIdentity(row, plan.owner) ||
      row.path !== plan.path ||
      row.projectPath !== plan.projectPath ||
      row.sourceCommonDir !== plan.sourceCommonDir
    )
      throw changed();
    if (
      JSON.stringify(await this.inode(row.projectPath)) !==
        JSON.stringify(plan.sourceRoot) ||
      JSON.stringify(await this.inode(row.sourceCommonDir!)) !==
        JSON.stringify(plan.sourceGit)
    )
      throw changed();
    try {
      await lstat(row.path);
      throw changed();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const archive of plan.archives)
      if (
        !archive.verified ||
        (
          await this.git(
            ["rev-parse", "--verify", archive.destination],
            row.projectPath,
          )
        ).trim() !== archive.oid
      )
        throw changed();
    if (row.state === "deleting" && row.revision === plan.deletionRevision)
      row = await this.store.update(
        {
          ...row,
          state: "missing",
          reason: "missing",
          revision: plan.tombstoneRevision,
          deletedAt: plan.deletedAt,
        },
        row.revision,
      );
    else if (
      row.state !== "missing" ||
      row.revision !== plan.tombstoneRevision ||
      row.deletedAt !== plan.deletedAt
    )
      throw changed();
    plan.recordRevision = row.revision;
    plan.stage = "completed";
    await this.writeDeletion(plan);
  }
  async executeDeletion(
    token: string,
    guards: { active: boolean; current: boolean },
    callbacks: CloneDeletionCallbacks,
  ): Promise<CloneDeletionResult> {
    this.deletionGuards(guards);
    const initial = await this.readDeletion(token);
    const initialRecord = (await this.store.read()).records.find(
      (r) => r.contextId === initial.owner.contextId,
    );
    if (!initialRecord) throw unavailable();
    return this.store.withRepositoryLock(
      initialRecord.repositoryKey,
      async () => {
        const plan = await this.readDeletion(token);
        let row = (await this.store.read()).records.find(
          (r) => r.contextId === plan.owner.contextId,
        );
        if (!row) throw unavailable();
        const result = (
          status: CloneDeletionResult["status"],
          message: string,
        ): CloneDeletionResult => ({
          token,
          owner: plan.owner,
          stage: plan.stage,
          status,
          message,
        });
        if (plan.stage === "completed")
          return result(
            "success",
            "Клон перемещён в корзину; все Git tips сохранены в архивных refs.",
          );
        if (plan.stage === "prepared" && Date.now() >= plan.expiresAt)
          throw changed();
        if (plan.stage === "trashed") {
          try {
            await this.finishDeletion(plan, row);
            return result(
              "success",
              "Клон перемещён в корзину; архивные refs проверены.",
            );
          } catch {
            return result(
              "partial",
              "Перемещение подтверждено, но согласование реестра не завершено. Сохранён журнал для повтора.",
            );
          }
        }
        if (
          plan.stage === "archiving" &&
          row.state === "deleting" &&
          row.revision === plan.deletionRevision &&
          plan.recordRevision !== row.revision
        ) {
          plan.recordRevision = row.revision;
          await this.writeDeletion(plan);
        }
        // A missing source after an uncertain trash callback is not proof of a
        // recoverable move. Preserve the journal; never invent success or retry rm.
        if (plan.stage === "trashing") {
          try {
            await lstat(row.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT")
              return result(
                "partial",
                "Результат перемещения в корзину неоднозначен. Нужна ручная проверка; архивные refs сохранены.",
              );
            throw error;
          }
        }
        await this.assertDeletionSnapshot(plan, row);
        try {
          if (plan.stage === "prepared") {
            plan.stage = "archiving";
            await this.writeDeletion(plan);
          }
          if (
            plan.stage === "archiving" &&
            row.state === "ready" &&
            row.revision === plan.recordRevision
          ) {
            row = await this.store.update(
              { ...row, state: "deleting", revision: plan.deletionRevision },
              row.revision,
            );
            plan.recordRevision = row.revision;
            await this.writeDeletion(plan);
          } else if (
            row.state !== "deleting" ||
            row.revision !== plan.deletionRevision
          )
            throw changed();
          if (plan.stage === "archiving") {
            for (const archive of plan.archives) {
              await this.assertDeletionSnapshot(plan, row);
              const old = (
                await this.git(
                  [
                    "for-each-ref",
                    "--format=%(objectname)",
                    archive.destination,
                  ],
                  row.projectPath,
                )
              ).trim();
              if (old && old !== archive.oid) throw changed();
              if (!old)
                await this.git(
                  [
                    "-c",
                    "gc.auto=0",
                    "fetch",
                    "--no-tags",
                    "--no-write-fetch-head",
                    "--no-auto-maintenance",
                    "--",
                    row.path,
                    `${archive.oid}:${archive.destination}`,
                  ],
                  row.projectPath,
                );
              const verified = (
                await this.git(
                  ["rev-parse", "--verify", archive.destination],
                  row.projectPath,
                )
              ).trim();
              if (verified !== archive.oid) throw changed();
              archive.verified = true;
              await this.writeDeletion(plan);
            }
            plan.stage = "archived";
            await this.writeDeletion(plan);
          }
          if (plan.stage === "archived" || plan.stage === "removing-topic") {
            await this.assertDeletionSnapshot(plan, row);
            plan.stage = "removing-topic";
            await this.writeDeletion(plan);
            await callbacks.removeTopic?.();
            plan.stage = "topic-removed";
            await this.writeDeletion(plan);
          }
          if (plan.stage === "topic-removed" || plan.stage === "trashing") {
            await this.assertDeletionSnapshot(plan, row);
            // Re-verify ALL archive destinations immediately before sole-owner loss.
            for (const archive of plan.archives)
              if (
                (
                  await this.git(
                    ["rev-parse", "--verify", archive.destination],
                    row.projectPath,
                  )
                ).trim() !== archive.oid
              )
                throw changed();
            plan.stage = "trashing";
            await this.writeDeletion(plan);
            await callbacks.trashItem(row.path);
            try {
              await lstat(row.path);
              throw Error("Корзина не убрала исходный каталог.");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            plan.stage = "trashed";
            plan.deletedAt = new Date().toISOString();
            await this.writeDeletion(plan);
            await this.finishDeletion(plan, row);
          }
          return result(
            "success",
            "Клон перемещён в корзину; все Git tips сохранены в архивных refs.",
          );
        } catch {
          assertReadActive();
          return result(
            "partial",
            "Удаление выполнено частично. Сохранён журнал этапа и архивные refs; данные не очищались принудительно.",
          );
        }
      },
    );
  }
  async deletionRecovery(projectId?: string): Promise<CloneDeletionPlan[]> {
    await this.store.assertRoot();
    const result: CloneDeletionPlan[] = [];
    for (const name of await readdir(this.store.root)) {
      const match = /^\.deletion-([a-f0-9-]{36})\.json$/.exec(name);
      if (!match) continue;
      const plan = await this.readDeletion(match[1]);
      if (
        plan.stage !== "completed" &&
        (projectId === undefined || plan.owner.projectId === projectId)
      )
        result.push(plan);
    }
    return result;
  }
}
