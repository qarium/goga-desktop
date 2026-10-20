import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project } from "../shared/types";
import {
  topicContextIdentitySchema,
  topicContextRefSchema,
  type TopicContextIdentity,
  type TopicContextRef,
  type WorktreeRecord,
} from "../shared/worktrees";
import type { Runner } from "./process";
import { WorktreeStore, managedWorktreeLocation } from "./worktree-store";
import { noSymlinks } from "./settings";
import { assertReadActive } from "./read-scope";

interface GitWorktree {
  path: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
}
const unavailable = () =>
  new Error(
    "Рабочая копия недоступна или конфликтует с текущей веткой. Обновите контекст.",
  );
const changed = () =>
  new Error(
    "Контекст изменён или его ревизия устарела. Выберите топик заново.",
  );
const sameIdentity = (a: TopicContextIdentity, b: TopicContextIdentity) =>
  a.projectId === b.projectId &&
  a.year === b.year &&
  a.topic === b.topic &&
  a.branch === b.branch;

/** Host resolver only; callers supply identity, never an execution path. */
export class WorktreeManager {
  readonly store: WorktreeStore;
  private readonly env: NodeJS.ProcessEnv;
  constructor(
    private readonly home: string,
    readonly runner: Pick<Runner, "command">,
  ) {
    this.store = new WorktreeStore(home);
    this.env = {
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_COMMON_DIR: undefined,
      GIT_INDEX_FILE: undefined,
      GIT_OBJECT_DIRECTORY: undefined,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
      GIT_CONFIG: undefined,
      GIT_CONFIG_COUNT: undefined,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
    for (const key of Object.keys(process.env))
      if (key.startsWith("GIT_") && !(key in this.env))
        this.env[key] = undefined;
  }
  private async git(args: string[], cwd: string) {
    await this.store.assertRoot();
    await noSymlinks(cwd);
    await noSymlinks(path.join(cwd, ".git"));
    const result = await this.runner.command(
      "git",
      ["-c", "core.hooksPath=/dev/null", ...args],
      cwd,
      this.env,
    );
    // A command can finish after the directory that was checked before it has
    // been replaced. Never publish its stale output as a ready context.
    await this.store.assertRoot();
    await noSymlinks(cwd);
    await noSymlinks(path.join(cwd, ".git"));
    return result.stdout;
  }
  private async repository(project: Project) {
    if (!project || !path.isAbsolute(project.path)) throw unavailable();
    const canonical = await realpath(project.path);
    await noSymlinks(canonical);
    const top = (
      await this.git(["rev-parse", "--show-toplevel"], canonical)
    ).trim();
    if ((await realpath(top)) !== canonical)
      throw new Error("Выберите корневую папку Git-проекта.");
    const common = (
      await this.git(
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        canonical,
      )
    ).trim();
    const gitCommonDir = await realpath(path.resolve(canonical, common));
    await noSymlinks(gitCommonDir);
    // The project root must be the primary checkout. A registered linked copy
    // must not be silently relabelled as primary or gain deletion ownership.
    const gitDir = await realpath(
      path.resolve(
        canonical,
        (await this.git(["rev-parse", "--absolute-git-dir"], canonical)).trim(),
      ),
    );
    if (gitDir !== gitCommonDir)
      throw new Error(
        "Проект указывает на внешнюю рабочую копию. Зарегистрируйте основную папку репозитория.",
      );
    return { projectPath: canonical, gitCommonDir };
  }
  private async worktrees(cwd: string): Promise<GitWorktree[]> {
    const raw = await this.git(["worktree", "list", "--porcelain", "-z"], cwd);
    const result: GitWorktree[] = [];
    let current: GitWorktree | undefined;
    for (const field of raw.split("\0")) {
      if (!field) {
        if (current) {
          result.push(current);
          current = undefined;
        }
        continue;
      }
      if (field.startsWith("worktree ")) {
        if (current) throw unavailable();
        current = { path: field.slice(9), locked: false, prunable: false };
      } else if (current && field.startsWith("branch refs/heads/"))
        current.branch = field.slice(18);
      else if (current && /^locked(?: |$)/.test(field)) current.locked = true;
      else if (current && /^prunable(?: |$)/.test(field))
        current.prunable = true;
    }
    if (current) result.push(current);
    if (!result.length || result.some((r) => !path.isAbsolute(r.path)))
      throw unavailable();
    return result;
  }
  private async validate(record: WorktreeRecord): Promise<{
    state: "ready" | "missing" | "conflict";
    reason?: WorktreeRecord["reason"];
  }> {
    await this.store.assertRoot();
    try {
      await noSymlinks(record.projectPath);
      await noSymlinks(record.gitCommonDir);
      await noSymlinks(record.path);
      const project = await this.repository({
        id: record.projectId,
        name: "",
        path: record.projectPath,
      });
      if (project.gitCommonDir !== record.gitCommonDir)
        return { state: "conflict", reason: "repository" };
      const registered = (await this.worktrees(record.projectPath)).find(
        (r) => path.resolve(r.path) === record.path,
      );
      let info;
      try {
        info = await lstat(record.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { state: "missing", reason: "missing" };
        throw error;
      }
      if (!info.isDirectory() || (await realpath(record.path)) !== record.path)
        return { state: "conflict", reason: "path" };
      if (!registered || registered.prunable || registered.locked)
        return { state: "conflict", reason: "registration" };
      if (registered.branch !== record.branch)
        return { state: "conflict", reason: "branch" };
      const common = (
        await this.git(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          record.path,
        )
      ).trim();
      if (
        (await realpath(path.resolve(record.path, common))) !==
        record.gitCommonDir
      )
        return { state: "conflict", reason: "repository" };
      const top = (
        await this.git(["rev-parse", "--show-toplevel"], record.path)
      ).trim();
      if ((await realpath(top)) !== record.path)
        return { state: "conflict", reason: "path" };
      const branch = (
        await this.git(["symbolic-ref", "--quiet", "HEAD"], record.path)
      ).trim();
      if (branch !== `refs/heads/${record.branch}`)
        return { state: "conflict", reason: "branch" };
      // Recheck symlinks after the commands, before publishing a ready record.
      await noSymlinks(record.path);
      return { state: "ready" };
    } catch {
      // Cancellation is not evidence of a Git/path conflict. Preserve the
      // existing ready record and let its read scope reject the operation.
      assertReadActive();
      return { state: "conflict", reason: "path" };
    }
  }
  private async refresh(record: WorktreeRecord): Promise<WorktreeRecord> {
    if (record.state === "deleting") return record;
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
    const next: WorktreeRecord = {
      ...record,
      ...actual,
      preparation,
      revision: randomUUID(),
    };
    if (actual.reason === undefined) delete next.reason;
    if (preparation === undefined) delete next.preparation;
    return this.store.update(next, record.revision);
  }
  async ensure(
    project: Project,
    input: TopicContextIdentity,
  ): Promise<WorktreeRecord> {
    const identity = topicContextIdentitySchema.parse(input);
    if (identity.projectId !== project.id) throw unavailable();
    const repository = await this.repository(project);
    const location = managedWorktreeLocation(
      this.home,
      { id: project.id, path: repository.projectPath },
      repository.gitCommonDir,
      identity,
    );
    return this.store.withRepositoryLock(location.repositoryKey, async () => {
      // Validate Git's branch syntax and existence without creating refs.
      await this.git(
        ["check-ref-format", `refs/heads/${identity.branch}`],
        repository.projectPath,
      );
      await this.git(
        ["show-ref", "--verify", `refs/heads/${identity.branch}`],
        repository.projectPath,
      );
      const existing = (await this.store.read()).records.find(
        (r) => r.contextId === location.contextId,
      );
      let previous: WorktreeRecord | undefined;
      if (existing) {
        previous = await this.refresh(existing);
        if (previous.state === "ready") return previous;
        if (
          previous.state !== "missing" ||
          previous.preparation ||
          previous.ownership !== "managed"
        )
          throw new Error(
            "Подготовка рабочей копии неоднозначна или конфликтует. Требуется проверка, автоматический повтор запрещён.",
          );
      }
      const branchCopies = (
        await this.worktrees(repository.projectPath)
      ).filter((r) => r.branch === identity.branch);
      if (branchCopies.length > 1) throw unavailable();
      const occupied = branchCopies[0];
      if (occupied) {
        await noSymlinks(occupied.path);
        if (
          path.resolve(occupied.path) !== repository.projectPath ||
          occupied.locked ||
          occupied.prunable
        )
          throw new Error(
            "Ветка занята другой, внешней рабочей копией. Desktop не присваивает её себе.",
          );
        const primary: WorktreeRecord = {
          ...identity,
          ...repository,
          ...location,
          path: repository.projectPath,
          ownership: "primary",
          state: "missing",
          revision: randomUUID(),
        };
        if ((await this.validate(primary)).state !== "ready")
          throw unavailable();
        primary.state = "ready";
        return this.store.update(primary, undefined);
      }
      let info;
      await noSymlinks(location.path);
      try {
        info = await lstat(location.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (info)
        throw new Error(
          "Каталог рабочей копии уже занят и не принадлежит Desktop.",
        );
      const pending: WorktreeRecord = {
        ...identity,
        ...repository,
        ...location,
        ownership: "managed",
        state: "missing",
        preparation: "pending",
        revision: randomUUID(),
      };
      await this.store.prepareParent(pending);
      await this.store.update(pending, previous?.revision);
      // Journal ownership before add. Never force, switch primary, prune or
      // recursively delete an existing path, even when add fails halfway.
      try {
        await noSymlinks(pending.path);
        await this.git(
          ["worktree", "add", "--", pending.path, identity.branch],
          repository.projectPath,
        );
      } catch {
        const reconciled = await this.refresh(pending);
        if (reconciled.state === "ready") return reconciled;
        throw new Error(
          "Результат подготовки рабочей копии неоднозначен. Выполнена проверка; автоматический повтор запрещён.",
        );
      }
      const ready = await this.refresh(pending);
      if (ready.state !== "ready") throw unavailable();
      return ready;
    });
  }
  async resolve(input: TopicContextRef): Promise<WorktreeRecord> {
    const ref = topicContextRefSchema.parse(input);
    const initial = (await this.store.read()).records.find(
      (r) => r.contextId === ref.contextId,
    );
    if (!initial || !sameIdentity(initial, ref)) throw unavailable();
    return this.store.withRepositoryLock(initial.repositoryKey, async () => {
      const record = (await this.store.read()).records.find(
        (r) => r.contextId === ref.contextId,
      );
      if (!record || !sameIdentity(record, ref)) throw unavailable();
      if (record.revision !== ref.revision) throw changed();
      const current = await this.refresh(record);
      if (current.state !== "ready") throw unavailable();
      if (current.revision !== ref.revision) throw changed();
      return current;
    });
  }
  async list(projectId?: string): Promise<WorktreeRecord[]> {
    return (await this.store.read()).records.filter(
      (r) => projectId === undefined || r.projectId === projectId,
    );
  }
  async reconcile(projectId?: string): Promise<WorktreeRecord[]> {
    const records = await this.list(projectId);
    for (const record of records)
      await this.store.withRepositoryLock(record.repositoryKey, async () => {
        const latest = (await this.store.read()).records.find(
          (r) => r.contextId === record.contextId,
        );
        if (latest) await this.refresh(latest);
      });
    return this.list(projectId);
  }
}
