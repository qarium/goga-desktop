import { parseDockerfile } from "./project-dockerfile";
import { assertTopicTaskReady } from "./topic-readiness";
import {
  RepositoryActions,
  repositoryActionFailure,
} from "./repository-actions";
import {
  repositoryActionRequestSchema,
  type RepositoryActionRequest,
  type RepositoryActionResult,
} from "../shared/repository-actions";
import { assertReadActive } from "./read-scope";
import {
  ContextExchangeManager,
  type BaseSnapshot,
  type PublicationSnapshot,
} from "./context-exchange";
import { RunRecoveryManager } from "./run-recovery";
import { createBuildRepeatSnapshot } from "./build-repeat";
import {
  buildRepeatPreparationSchema,
  type BuildRepeatPreparation,
} from "../shared/build-repeat";
import { ContextRunsStore } from "./context-runs-store";
import { ContextSyncManager } from "./context-sync";
import { CloneManager } from "./clones";
import {
  scopeProjectId,
  scopeRefSchema,
  type ScopeRef,
} from "../shared/context";
import {
  childEnvironment,
  assertContextEnvironment,
} from "./process-environment";
import { assertTopicBranchesAvailable } from "./worktree-topic-guards";
import { WorktreeManager } from "./worktrees";
import {
  topicContextIdentitySchema,
  topicContextReadinessSchema,
  topicContextRefSchema,
  type TopicContextIdentity,
  type TopicContextRef,
  type WorktreeRecord,
  worktreeContextRef,
} from "../shared/worktrees";
import {
  buildArgs,
  buildCapabilities,
  buildReviewDefault,
  buildHomeEnvironment,
  buildConfigurationSecrets,
  listBuildFiles as browseBuildFiles,
  readBuildPlan as readPlan,
} from "./build";
import {
  buildPlanProblem,
  buildRequestSchema,
  buildSelectionSchema,
  validateBuildOptions,
  type BuildContext,
  type BuildContextSelection,
  type BuildOptions,
  type BuildRequest,
} from "../shared/build";
import { TopicsDomain, type TopicsContext } from "./topics";
import type {
  TopicTarget,
  TopicOperationRequest,
  TopicCatalogSnapshot,
} from "../shared/topics";
import { topicYearSchema } from "../shared/topics-schema";
import { captureRunOutput } from "./run-output";
import { DEFAULT_STARTUP_TIMEOUT_MINUTES } from "../shared/startup-timeout";
import { stripVTControlCharacters } from "node:util";
import { DocumentDeletionTickets } from "./document-deletion";
import {
  isDeletableDocument,
  isDeletionToken,
  isDeletionVersion,
  type DeletableDocument,
  type DeletionResult,
  type DeletionTicket,
  type TrashItem,
} from "../shared/document-deletion";
import { availableWorkflowPipelines } from "../shared/workflow-suggestions";
import type { ProjectDocumentTarget } from "../shared/project-documents";
import {
  listProjectTools,
  listProjectWorkflows,
  listProjectPipelines,
  listProjectProfiles,
  readProjectDocument,
  saveProjectDocument,
  prepareSourceDeletion,
} from "./project-documents";
import { assertEnvironmentTransport } from "../shared/environment-transport";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DesktopStateStore,
  type ProjectSettingsDocument,
  validateProjectSettings,
} from "./desktop-state";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import path from "node:path";
import { realpath, readdir, lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  Project,
  Pipeline,
  Discovery,
  PipelineRequest,
  Preview,
  LaunchRequest,
  Run,
  Topic,
  TopicTaskRequest,
  TopicTaskDocument,
  ProjectSettings,
  ProjectSettingsView,
} from "../shared/types";
import { NodeRunner, type Runner, watchDashboard } from "./process";
import {
  parseCatalog,
  parseCard,
  pipelineArgs,
  peekWorkflowProfile,
  workflowName,
} from "./parsers";
import {
  SettingsStore,
  atomicWrite,
  optionalText,
  digest,
  noSymlinks,
} from "./settings";
import {
  guardedProject,
  readWorkingTask,
  readCommittedTask,
  taskPath,
  taskDocument,
  validateTaskText,
} from "./topic-task";
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
interface SavedPreview {
  metadata?: Pipeline;
  request: PipelineRequest;
  fingerprint: string;
  preview: Preview;
  created: number;
}
export class HostService extends EventEmitter {
  private bindings = new WeakMap<Project, WorktreeRecord>();
  private clones: CloneManager;
  private exchange: ContextExchangeManager;
  private exchangePlans = new Map<
    string,
    { base?: BaseSnapshot; publication?: PublicationSnapshot }
  >();
  private runStore: ContextRunsStore;
  private runSaveTail: Promise<void> = Promise.resolve();
  private lastRunSave = "";
  private initialized = false;
  private recovery?: RunRecoveryManager;
  private sync: ContextSyncManager;
  private selectedContext: TopicContextRef | null = null;
  private buildRequests = new Map<string, BuildRequest>();
  private topicDomain = new TopicsDomain();
  private deletionTickets = new DocumentDeletionTickets();
  private personalSettings: SettingsStore;
  private trashItem?: TrashItem;
  private operationTail: Promise<unknown> = Promise.resolve();
  private catalogEpoch = 0;
  private deleting = false;
  private home: string;
  private dataDir: string;
  private goga: string;
  private runner: Runner;
  private state: DesktopStateStore;
  private context = new AsyncLocalStorage<{
    projectId: string;
    document: ProjectSettingsDocument;
    catalogEpoch: number;
    binding?: WorktreeRecord;
  }>();
  private settingsLocks = new Map<string, Promise<unknown>>();
  private documentSaveRevisions = new Map<string, number>();
  private runList: Run[] = [];
  private previews = new Map<string, SavedPreview>();
  private locks = new Map<string, Promise<unknown>>();
  private children = new Map<
    string,
    {
      child: ChildProcessWithoutNullStreams;
      cancel: () => void;
      key: string;
      output: ReturnType<typeof captureRunOutput>;
      deadlineAt: number;
      timer: ReturnType<typeof setTimeout> | null;
      secrets: string[];
    }
  >();
  private closeFlights = new Map<string, Promise<boolean>>();
  private stopFlights = new Map<string, Promise<void>>();
  private activeKeys = new Map<string, Set<string>>();
  private worktrees: WorktreeManager;
  private contextPreparations = new Map<string, Promise<WorktreeRecord>>();
  private disposed = false;
  constructor(options: {
    home?: string;
    dataDir: string;
    goga?: string;
    runner?: Runner;
    settings?: SettingsStore;
    trashItem?: TrashItem;
    recovery?: RunRecoveryManager;
  }) {
    super();
    this.home = options.home ?? homedir();
    this.personalSettings = options.settings ?? new SettingsStore(this.home);
    this.trashItem = options.trashItem;
    this.dataDir = options.dataDir;
    this.goga = options.goga ?? "goga";
    this.state = new DesktopStateStore(this.home, this.dataDir);
    this.runner = options.runner ?? new NodeRunner(120000, { HOME: this.home });
    this.recovery =
      options.recovery ??
      (this.runner instanceof NodeRunner
        ? new RunRecoveryManager(this.home)
        : undefined);
    this.worktrees = new WorktreeManager(this.home, this.runner);
    this.runStore = new ContextRunsStore(this.home);
    this.clones = new CloneManager(this.home, this.runner);
    this.exchange = new ContextExchangeManager(this.home, this.runner, {
      resolve: (ref) => this.clones.resolve(ref),
      isActive: (id) => this.contextActive(id),
      isProjectActive: (id) =>
        this.runList.some(
          (r) =>
            r.projectId === id &&
            !r.context &&
            ["starting", "running"].includes(r.status),
        ),
      nativeEnvironment: (ref) =>
        this.snapshot(ref, async () =>
          childEnvironment(
            process.env,
            { HOME: this.home },
            this.invocation(await this.project(ref)).env,
          ),
        ),
    });
    this.sync = new ContextSyncManager(this.home, this.runner, {
      resolve: (ref) => this.clones.resolve(ref),
      isActive: (contextId) => this.contextActive(contextId),
      isProjectActive: (projectId) =>
        this.runList.some(
          (r) =>
            r.projectId === projectId &&
            (r.status === "starting" || r.status === "running"),
        ),
      onChange: (state) => this.emit("context-sync", state),
    });
  }
  async initialize() {
    if (this.initialized) return;
    this.runList = await this.runStore.load();
    this.initialized = true;
    for (const run of this.runList.filter((r) =>
      ["starting", "running"].includes(r.status),
    ))
      await this.reconcileStoredRun(run);
    await this.persistRuns();
    await this.sync.recover(await this.listProjects());
    for (const run of this.runList.filter(
      (r) =>
        r.syncPending &&
        r.context &&
        !["starting", "running"].includes(r.status),
    ))
      await this.syncCompletedRun(run);
  }
  private persistRuns(): Promise<void> {
    const rows = structuredClone(this.runList).map((run) =>
      this.children.has(run.id) && !["starting", "running"].includes(run.status)
        ? {
            ...run,
            status: (run.kind === "build" || run.dashboardOpened
              ? "running"
              : "starting") as Run["status"],
            endedAt: undefined,
          }
        : run,
    );
    const signature = JSON.stringify(
      rows.map(
        ({ output, url, error, persistenceError, recoveryMessage, ...row }) =>
          row,
      ),
    );
    if (signature === this.lastRunSave) return this.runSaveTail;
    this.lastRunSave = signature;
    const work = this.runSaveTail
      .catch(() => {})
      .then(() => this.runStore.save(rows));
    this.runSaveTail = work;
    void work.catch(() => {
      this.lastRunSave = "";
      for (const run of this.runList)
        run.persistenceError =
          "Не удалось сохранить историю запусков. После перезапуска состояние потребует проверки.";
      this.emit("runs", this.runs());
    });
    return work;
  }
  private activeRuns(p: Project, key: string): Run[] {
    const binding = this.binding(p);
    const members = this.activeKeys.get(key);
    return this.runList.filter(
      (run) =>
        members?.has(run.id) ||
        ((binding
          ? run.context?.contextId === binding.contextId
          : run.projectId === p.id && !run.context) &&
          (["starting", "running"].includes(run.status) ||
            this.children.has(run.id))),
    );
  }
  private assertRunAdmission(
    p: Project,
    key: string,
    kind: "pipeline" | "build",
  ) {
    const active = this.activeRuns(p, key);
    if (
      active.some(
        (run) => !this.children.has(run.id) && run.recovery !== "confirmed",
      )
    )
      throw Error(
        "Состояние процесса не подтверждено после перезапуска. Проверьте запуск перед продолжением.",
      );
    if (kind === "build" && active.some((run) => run.kind === "build"))
      throw Error("В этом репозитории уже работает сборка.");
  }
  private addActiveRun(key: string, id: string) {
    const members = this.activeKeys.get(key) ?? new Set<string>();
    members.add(id);
    this.activeKeys.set(key, members);
  }
  private removeActiveRun(key: string, id: string) {
    const members = this.activeKeys.get(key);
    members?.delete(id);
    if (!members?.size) this.activeKeys.delete(key);
  }
  private check() {
    if (this.disposed) throw new Error("Приложение завершает работу");
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.settingsLocks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.settingsLocks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.settingsLocks.get(id) === next) this.settingsLocks.delete(id);
    }
  }
  private async snapshot<T>(
    scope: ScopeRef,
    action: () => Promise<T>,
    verifyAfter = true,
  ): Promise<T> {
    const parsed = this.parseScope(scope);
    const id = scopeProjectId(parsed);
    const current = this.context.getStore();
    if (
      current?.projectId === id &&
      (typeof parsed === "string" ||
        (current.binding?.contextId === parsed.contextId &&
          current.binding.revision === parsed.revision))
    )
      return action();
    const scopedProject = await this.project(parsed);
    const binding = this.bindings.get(scopedProject);
    const epoch = this.catalogEpoch;
    this.assertCatalog(epoch);
    await this.project(id);
    const document = await this.state.read(scopeProjectId(id));
    return this.context.run(
      {
        projectId: id,
        document,
        catalogEpoch: epoch,
        ...(binding ? { binding } : {}),
      },
      async () => {
        try {
          this.assertCatalog(epoch);
          const result = await action();
          if (verifyAfter) await this.assertSettings(id);
          this.assertCatalog(epoch);
          return result;
        } catch (error) {
          let message =
            error instanceof Error
              ? error.message
              : "Операция Goga не выполнена";
          for (const entry of document.value.env)
            if (entry.value)
              message = message.split(entry.value).join("[скрыто]");
          throw new Error(message);
        }
      },
    );
  }
  private async assertSettings(id: string) {
    const ctx = this.context.getStore();
    if (
      ctx &&
      ctx.document.version !==
        (await this.state.read(scopeProjectId(id))).version
    )
      throw new Error(
        "Настройки проекта изменились. Предпросмотр устарел; обновите данные перед запуском.",
      );
  }
  private invocation(p: Project) {
    const doc = this.context.getStore();
    if (!doc || doc.projectId !== p.id)
      throw new Error("Нет снимка настроек проекта");
    const value = doc.document.value;
    if (this.bindings.has(p)) assertContextEnvironment(value.env);
    return {
      executable: value.executable === "goga" ? this.goga : value.executable,
      env: Object.fromEntries(value.env.map((e) => [e.key, e.value])),
      value,
    };
  }
  private async cmd(project: Project, args: string[], git = false) {
    this.check();
    if (this.binding(project)) await this.assertEffectiveRoot(project);
    if (git)
      return (await this.runner.command("git", args, this.root(project)))
        .stdout;
    await this.assertSettings(project.id);
    const call = this.invocation(project);
    try {
      return (
        await this.runner.command(
          call.executable,
          args,
          this.root(project),
          call.env,
        )
      ).stdout;
    } catch (error) {
      // Errors from arbitrary executable output/argv never cross the host boundary.
      if (
        /не поддерживает --profile/.test(
          error instanceof Error ? error.message : "",
        )
      )
        throw new Error(
          "Эта версия Goga не поддерживает --profile. Выбор профиля не был проигнорирован.",
        );
      throw new Error(
        "Не удалось выполнить команду Goga. Проверьте исполняемый файл, PATH и конфигурацию проекта. Значения окружения скрыты.",
      );
    }
  }
  private async profiles(p: Project) {
    const sources = new Map<string, "home" | "project">(
      (await this.names(path.join(this.home, ".goga/profiles"))).map((n) => [
        n,
        "home",
      ]),
    );
    for (const n of await this.names(path.join(this.root(p), ".goga/profiles")))
      sources.set(n, "project");
    return [...sources]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, source]) => ({ name, source }));
  }
  async readProjectSettings(id: ScopeRef): Promise<ProjectSettingsView> {
    assertReadActive();
    const p = await this.project(id);
    const result = {
      ...(await this.state.read(scopeProjectId(id))),
      profiles: await this.profiles(p),
    };
    // A settings document is project-wide; its profile catalog is owner-local.
    // Do not publish that catalog after cancellation or a changed clone owner.
    assertReadActive();
    await this.validateBinding(p);
    assertReadActive();
    return result;
  }
  async saveProjectSettings(
    id: ScopeRef,
    input: ProjectSettings,
    version: string,
  ): Promise<ProjectSettingsView> {
    return this.exclusive(scopeProjectId(id), async () => {
      const p = await this.project(id),
        value = validateProjectSettings(input);
      const profiles = await this.profiles(p);
      if (value.profile && !profiles.some((x) => x.name === value.profile))
        throw new Error(
          "Выбранный профиль отсутствует; выберите существующий профиль или Автоматически.",
        );
      await this.validateBinding(p);
      const document = await this.state.save(
        scopeProjectId(id),
        value,
        version,
      );
      for (const [key, preview] of this.previews)
        if (preview.request.projectId === scopeProjectId(id))
          this.previews.delete(key);
      return { ...document, profiles };
    });
  }
  async listProjectTools(id: ScopeRef) {
    this.check();
    return this.catalogRead(async () =>
      listProjectTools(this.root(await this.project(id))),
    );
  }
  async listProjectPipelines(id: ScopeRef) {
    this.check();
    return this.catalogRead(async () =>
      listProjectPipelines(this.root(await this.project(id))),
    );
  }
  async listProjectProfiles(id: ScopeRef) {
    this.check();
    return this.catalogRead(async () =>
      listProjectProfiles(this.root(await this.project(id))),
    );
  }
  async listProjectWorkflows(id: ScopeRef) {
    this.check();
    return this.catalogRead(async () =>
      listProjectWorkflows(this.root(await this.project(id))),
    );
  }
  async listWorkflowSuggestions(id: ScopeRef): Promise<Pipeline[]> {
    this.check();
    const revision = this.documentSaveRevisions.get(scopeProjectId(id)) ?? 0;
    const result = await this.snapshot(id, async () => {
      const p = await this.project(id);
      const pipelines = parseCatalog(
        await this.cmd(p, ["pipeline", "--list", "--info"]),
      );
      const files = await this.listProjectWorkflows(id);
      return availableWorkflowPipelines(pipelines, files);
    });
    // Check after snapshot's asynchronous settings verification as well.
    if (revision !== (this.documentSaveRevisions.get(scopeProjectId(id)) ?? 0))
      throw new Error(
        "Документы проекта изменились. Список подсказок устарел; обновите данные.",
      );
    return result;
  }
  private async dockerfile(project: Project) {
    const result = parseDockerfile(
      this.root(project),
      await this.cmd(project, ["config", "dockerfile"]),
    );
    await readProjectDocument(this.root(project), {
      kind: "dockerfile",
      path: result.relativePath,
    });
    assertReadActive();
    await this.validateBinding(project);
    return result;
  }
  async resolveProjectDockerfile(id: ScopeRef) {
    this.check();
    return this.snapshot(id, async () => {
      const { relativePath, configured } = await this.dockerfile(
        await this.project(id),
      );
      return { relativePath, configured };
    });
  }
  async readProjectDocument(id: ScopeRef, target: ProjectDocumentTarget) {
    this.check();
    if (target.kind !== "dockerfile")
      return readProjectDocument(this.root(await this.project(id)), target);
    return this.snapshot(id, async () => {
      const project = await this.project(id),
        metadata = await this.dockerfile(project);
      if (target.path !== metadata.relativePath)
        throw new Error(
          "Путь Dockerfile изменился. Откройте актуальный файл заново.",
        );
      const document = await readProjectDocument(this.root(project), target);
      const latest = await this.dockerfile(project);
      if (latest.fingerprint !== metadata.fingerprint)
        throw new Error("Конфигурация Dockerfile изменилась");
      return {
        ...document,
        version: `${metadata.fingerprint}:${document.version}`,
      };
    });
  }
  async saveProjectDocument(
    id: ScopeRef,
    target: ProjectDocumentTarget,
    text: string,
    version: string,
  ) {
    this.check();
    return this.exclusive(scopeProjectId(id), async () => {
      const project = await this.project(id);
      this.assertScopeWritable(project);
      const document =
        target.kind === "dockerfile"
          ? await this.snapshot(id, async () => {
              const metadata = await this.dockerfile(project);
              const prefix = metadata.fingerprint + ":";
              if (
                target.path !== metadata.relativePath ||
                !version.startsWith(prefix)
              )
                throw new Error(
                  "Конфигурация Dockerfile изменилась. Черновик сохранён; откройте актуальный файл заново.",
                );
              const guard = async () => {
                this.assertScopeWritable(project);
                await this.validateBinding(project);
                await this.assertSettings(project.id);
                const latest = await this.dockerfile(project);
                if (latest.fingerprint !== metadata.fingerprint)
                  throw new Error("Конфигурация Dockerfile изменилась");
                await this.validateBinding(project);
                await this.assertSettings(project.id);
                this.assertCatalog(this.context.getStore()!.catalogEpoch);
              };
              const saved = await saveProjectDocument(
                this.root(project),
                target,
                text,
                version.slice(prefix.length),
                guard,
              );
              return { ...saved, version: prefix + saved.version };
            })
          : await saveProjectDocument(
              this.root(project),
              target,
              text,
              version,
            );
      this.documentSaveRevisions.set(
        scopeProjectId(id),
        (this.documentSaveRevisions.get(scopeProjectId(id)) ?? 0) + 1,
      );
      for (const [key, preview] of this.previews)
        if (preview.request.projectId === scopeProjectId(id))
          this.previews.delete(key);
      return document;
    });
  }

  private operation<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operationTail.catch(() => {}).then(action);
    this.operationTail = next.catch(() => {});
    return next;
  }
  private assertCatalog(epoch: number) {
    if (this.deleting || epoch !== this.catalogEpoch)
      throw new Error(
        "Документы изменились. Предпросмотр или каталог устарел; обновите данные.",
      );
  }
  private async catalogRead<T>(action: () => Promise<T>): Promise<T> {
    const epoch = this.catalogEpoch;
    this.assertCatalog(epoch);
    const result = await action();
    this.assertCatalog(epoch);
    return result;
  }
  private assertDeletionIdle() {
    if (
      this.runList.some(
        (r) => r.status === "starting" || r.status === "running",
      ) ||
      this.children.size
    )
      throw new Error(
        "Удаление недоступно, пока есть запускающийся или работающий конвейер. Дождитесь завершения; запуски не будут остановлены.",
      );
  }
  async prepareDocumentDeletion(
    source: DeletableDocument,
    expectedVersion?: string,
  ): Promise<DeletionTicket> {
    this.check();
    if (
      !isDeletableDocument(source) ||
      (expectedVersion !== undefined && !isDeletionVersion(expectedVersion))
    )
      throw new Error("Недопустимый документ или версия для удаления");
    const selected = structuredClone(source);
    if (
      selected.scope === "project" &&
      selected.context &&
      selected.context.projectId !== selected.projectId
    )
      throw Error("Контекст другого проекта.");
    return this.operation(async () => {
      this.check();
      this.assertDeletionIdle();
      try {
        const guard =
          selected.scope === "project"
            ? await this.exclusive(selected.projectId, async () =>
                prepareSourceDeletion(
                  this.root(
                    await this.project(selected.context ?? selected.projectId),
                  ),
                  selected.target,
                  expectedVersion,
                ),
              )
            : await this.personalSettings.prepareProfileDeletion(
                selected.name,
                expectedVersion,
              );
        const profileFallback =
          selected.scope === "project" && selected.target.kind === "profile"
            ? (
                await this.names(path.join(this.home, ".goga/profiles"))
              ).includes(selected.target.name)
            : undefined;
        return {
          ...this.deletionTickets.issue(selected, guard),
          ...(profileFallback !== undefined ? { profileFallback } : {}),
        };
      } catch {
        // Never expose file content, filesystem errors, or settings values.
        throw new Error(
          "Документ отсутствует, изменён или не может быть безопасно удалён. Обновите список и откройте его заново.",
        );
      }
    });
  }
  async deleteDocument(token: string): Promise<DeletionResult> {
    // Consume synchronously, before waiting on any save/launch or doing any I/O.
    const pending = isDeletionToken(token)
      ? this.deletionTickets.take(token)
      : undefined;
    if (!pending)
      return {
        status: "not-trashed",
        message:
          "Подтверждение удаления истекло или уже использовано. Выберите документ заново.",
      };
    return this.operation(async () => {
      try {
        this.check();
        this.assertDeletionIdle();
      } catch (error) {
        return { status: "not-trashed", message: (error as Error).message };
      }
      if (!this.trashItem)
        return {
          status: "not-trashed",
          message: "Системная Корзина недоступна. Удаление не выполнено.",
        };
      const action = async (): Promise<DeletionResult> => {
        this.assertDeletionIdle();
        // Invalidate at both boundaries: pending requests, including ones begun
        // while the adapter is working, must never publish pre-deletion results.
        this.deleting = true;
        this.catalogEpoch++;
        this.previews.clear();
        if (pending.source.scope === "project")
          this.documentSaveRevisions.set(
            pending.source.projectId,
            (this.documentSaveRevisions.get(pending.source.projectId) ?? 0) + 1,
          );
        try {
          if (pending.source.scope === "project" && pending.source.context) {
            if (pending.source.projectId !== pending.source.context.projectId)
              throw Error("Контекст другого проекта.");
            await this.project(pending.source.context);
          }
          return await pending.guard.perform(async (absolutePath) => {
            // A valid confirmation can expire while queued behind a save.
            // Check inside the guarded save queue, immediately at adapter entry.
            if (!this.deletionTickets.isCurrent(pending))
              throw new Error("Подтверждение удаления истекло");
            this.check();
            this.assertDeletionIdle();
            await this.trashItem!(absolutePath);
          });
        } catch {
          return {
            status: "uncertain",
            message:
              "Не удалось проверить результат удаления. Проверьте Корзину и каталог; текст редактора сохранён.",
          };
        } finally {
          this.catalogEpoch++;
          this.previews.clear();
          this.deleting = false;
        }
      };
      return pending.source.scope === "project"
        ? this.exclusive(pending.source.projectId, action)
        : action();
    });
  }

  private parseScope(scope: ScopeRef) {
    const result = scopeRefSchema.safeParse(scope);
    if (!result.success) throw Error("Некорректный проект или контекст.");
    return result.data;
  }
  private root(project: Project): string {
    return this.bindings.get(project)?.path ?? project.path;
  }
  private binding(project: Project) {
    return this.bindings.get(project);
  }
  private async assertEffectiveRoot(project: Project) {
    const binding = this.binding(project);
    if (!binding) return;
    await this.clones.store.assertOwned(binding);
    // Validate the same normal HOME/system/global inputs used by real children.
    // Admission with management-only Git config is not sufficient for execution.
    const raw = (
      await this.runner.command(
        "git",
        [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
          "--absolute-git-dir",
          "--git-common-dir",
          "--git-path",
          "index",
          "--git-path",
          "objects",
        ],
        binding.path,
        { HOME: this.home },
      )
    ).stdout;
    await this.clones.store.assertOwned(binding);
    const paths = raw.trim().split("\n");
    const expected = [
      binding.path,
      binding.gitCommonDir,
      binding.gitCommonDir,
      path.join(binding.gitCommonDir, "index"),
      path.join(binding.gitCommonDir, "objects"),
    ];
    if (
      paths.length !== expected.length ||
      paths.some((p, i) => path.resolve(binding.path, p) !== expected[i])
    )
      throw Error(
        "Эффективные пути Git не соответствуют контексту. Запуск в другой папке запрещён.",
      );
  }
  private assertScopeWritable(p: Project) {
    const binding = this.binding(p);
    if (
      (binding && this.contextActive(binding.contextId)) ||
      (!binding &&
        this.runList.some(
          (r) =>
            r.projectId === p.id &&
            !r.context &&
            ["starting", "running"].includes(r.status),
        ))
    )
      throw Error(
        "Контекст занят запуском или состояние процесса не подтверждено после перезапуска.",
      );
  }
  private async validateBinding(project: Project) {
    const binding = this.binding(project);
    if (!binding) return;
    const fresh = await this.clones.resolve(worktreeContextRef(binding));
    if (
      fresh.path !== binding.path ||
      fresh.projectPath !== project.path ||
      fresh.storageKind !== "clone"
    )
      throw Error("Контекст изменился; запуск в основной папке запрещён.");
    await this.assertEffectiveRoot(project);
  }
  private async project(scope: ScopeRef): Promise<Project> {
    const parsed = this.parseScope(scope),
      id = scopeProjectId(parsed);
    const p = (await this.listProjects()).find((p) => p.id === id);
    if (!p) throw new Error("Неизвестный проект");
    const inherited = this.context.getStore();
    const binding =
      typeof parsed === "string"
        ? inherited?.projectId === id
          ? inherited.binding
          : undefined
        : await this.clones.resolve(parsed);
    if (!binding) return p;
    if (
      binding.projectId !== id ||
      binding.projectPath !== (await realpath(p.path)) ||
      binding.storageKind !== "clone" ||
      binding.state !== "ready" ||
      binding.ownership !== "managed"
    )
      throw Error("Клон недоступен или не принадлежит выбранному топику.");
    const scoped = { ...p };
    this.bindings.set(scoped, binding);
    await this.assertEffectiveRoot(scoped);
    return scoped;
  }
  async listProjects(): Promise<Project[]> {
    return this.state.listProjects();
  }
  async addProject(folder: string): Promise<Project> {
    if (typeof folder !== "string" || !path.isAbsolute(folder))
      throw new Error("Выберите локальную папку");
    const canonical = await realpath(folder);
    const root = await realpath(
      (
        await this.runner.command(
          "git",
          ["rev-parse", "--show-toplevel"],
          canonical,
        )
      ).stdout.trim(),
    );
    return this.state.addProject({
      id: digest(root).slice(0, 24),
      name: path.basename(root),
      path: root,
    });
  }
  private async names(dir: string) {
    try {
      return (await readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".yml"))
        .map((e) => e.name.slice(0, -4))
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
  private async config(project: Project) {
    const text = await optionalText(
      path.join(this.root(project), ".goga/config.yml"),
    );
    if (!text) return {};
    const doc = parseDocument(text);
    if (doc.errors.length) throw new Error("Некорректная конфигурация проекта");
    return doc.toJS({ maxAliasCount: 100 }) ?? {};
  }
  private async topics(
    project: Project,
    year = this.binding(project)?.year ?? String(new Date().getFullYear()),
  ): Promise<Topic[]> {
    let rows: unknown;
    try {
      rows = JSON.parse(
        await this.cmd(project, [
          "topics",
          "--year",
          year,
          "board",
          "--json",
          "--per-host",
        ]),
      );
    } catch (e) {
      if (e instanceof SyntaxError)
        throw new Error("Goga вернула некорректный каталог топиков");
      throw e;
    }
    if (!Array.isArray(rows)) throw new Error("Некорректный каталог топиков");
    return rows
      .map((r) => {
        if (
          typeof r.topic !== "string" ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.topic) ||
          typeof r.branch !== "string" ||
          r.branch.startsWith("-")
        )
          throw new Error("Некорректный топик Goga");
        return {
          topic: r.topic,
          branch: r.branch,
          current: r.current === true,
          remote: r.remote === true,
          todo: typeof r.todo === "string" ? r.todo : "",
          statuses: Array.isArray(r.statuses)
            ? r.statuses.filter((x: unknown) => typeof x === "string")
            : [],
        };
      })
      .filter((t) => !t.remote && t.topic === slug(t.branch));
  }
  async readTopicTask(request: TopicTaskRequest): Promise<TopicTaskDocument> {
    return this.snapshot(request?.context ?? request?.projectId, () =>
      this.readTopicTaskWithSettings(request),
    );
  }
  private async readTopicTaskWithSettings(
    request: TopicTaskRequest,
  ): Promise<TopicTaskDocument> {
    if (
      !request ||
      typeof request.projectId !== "string" ||
      typeof request.branch !== "string" ||
      request.branch.startsWith("-") ||
      request.branch.length > 256 ||
      /[\x00-\x20]/.test(request.branch) ||
      typeof request.topic !== "string" ||
      request.topic !== slug(request.branch)
    )
      throw new Error("Некорректный запрос задачи");
    if (
      request.context &&
      (request.context.projectId !== request.projectId ||
        request.context.topic !== request.topic ||
        request.context.branch !== request.branch)
    )
      throw Error("Задача относится к другому контексту.");
    const p = await this.project(request.projectId);
    await guardedProject(this.root(p));
    const inheritedOwner = this.binding(p);
    const taskOwner =
      request.context ??
      (inheritedOwner ? worktreeContextRef(inheritedOwner) : undefined);
    if (
      taskOwner &&
      (taskOwner.topic !== request.topic || taskOwner.branch !== request.branch)
    )
      throw Error("Задача относится к другому контексту.");
    const readiness = taskOwner
      ? await this.readyTopicContext(topicContextRefSchema.parse(taskOwner))
      : undefined;
    const matches = (await this.topics(p, taskOwner?.year)).filter(
      (t) => t.branch === request.branch && t.topic === request.topic,
    );
    if (matches.length > 1)
      throw new Error("Топик неоднозначен. Обновите каталог.");
    if (matches.length === 0 && !taskOwner)
      throw new Error(
        "Данные задачи выбранного топика не найдены. Обновите каталог.",
      );
    const relative = taskPath(
      request.topic,
      request.context?.year ?? this.context.getStore()?.binding?.year,
    );
    const git = (args: string[]) => this.cmd(p, args, true);
    const current = (await git(["branch", "--show-current"])).trim();
    const commit = (
      await git([
        "rev-parse",
        "--verify",
        `refs/heads/${request.branch}^{commit}`,
      ])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit))
      throw new Error("Не удалось определить ветку топика");
    const value =
      current === request.branch
        ? await readWorkingTask(this.root(p), relative)
        : await readCommittedTask(
            this.root(p),
            commit,
            relative,
            git,
            childEnvironment(process.env, { HOME: this.home }),
          );
    if (
      (await git(["branch", "--show-current"])).trim() !== current ||
      (
        await git([
          "rev-parse",
          "--verify",
          `refs/heads/${request.branch}^{commit}`,
        ])
      ).trim() !== commit ||
      taskPath(
        request.topic,
        request.context?.year ?? this.context.getStore()?.binding?.year,
      ) !== relative
    )
      throw new Error(
        "Ветка или задача изменились во время чтения. Откройте задачу заново.",
      );
    await readiness?.verify();
    assertReadActive();
    if (taskOwner) await this.resolveTopicContext(taskOwner);
    assertReadActive();
    return taskDocument(this.root(p), request.branch, commit, relative, {
      ...value,
      ...(!matches.length
        ? { catalogState: "missing-local-metadata" as const }
        : {}),
    });
  }
  /** Metadata preparation is a write: never route it through cancel-read. */
  ensureTopicContext(input: TopicContextIdentity): Promise<WorktreeRecord> {
    let identity: TopicContextIdentity;
    try {
      identity = topicContextIdentitySchema.parse(input);
    } catch {
      return Promise.reject(Error("Некорректная идентичность топика"));
    }
    const key = JSON.stringify(identity);
    const pending = this.contextPreparations.get(key);
    if (pending) return pending;
    const flight = this.operation(() =>
      this.exclusive(identity.projectId, async () => {
        this.check();
        const project = await this.project(identity.projectId);
        const repositoryKey = await this.key(project);
        if (this.activeKeys.has(repositoryKey))
          throw Error(
            "Подготовка рабочей копии недоступна во время активного запуска. Существующая защита репозитория сохранена.",
          );
        const board = await this.readTopicBoard(project.id, identity.year);
        if (
          board.projectId !== identity.projectId ||
          board.year !== identity.year ||
          ![...board.entries, ...board.records].some(
            (r) =>
              !r.remote &&
              r.topic === identity.topic &&
              r.branch === identity.branch,
          )
        )
          throw Error(
            "Топик отсутствует в актуальном локальном каталоге. Обновите список; новая ветка не создаётся.",
          );
        return this.clones.ensure(project, identity);
      }),
    );
    this.contextPreparations.set(key, flight);
    void flight
      .finally(() => {
        if (this.contextPreparations.get(key) === flight)
          this.contextPreparations.delete(key);
      })
      .catch(() => {});
    return flight;
  }
  private async assertTaskReady(
    identity: TopicContextIdentity,
    source: string,
    clone?: WorktreeRecord,
  ) {
    return assertTopicTaskReady({
      identity,
      source,
      ...(clone ? { clone: clone.path } : {}),
      git: async (root, args) =>
        (
          await this.runner.command("git", args, root, {
            HOME: this.home,
            GIT_OPTIONAL_LOCKS: "0",
          })
        ).stdout,
      catalog: () =>
        clone
          ? this.snapshot(worktreeContextRef(clone), async () => {
              const rows = await this.topics(
                await this.project(worktreeContextRef(clone)),
                identity.year,
              );
              return rows;
            })
          : this.snapshot(identity.projectId, async () => {
              const primary = (await this.listProjects()).find(
                (project) =>
                  project.id === identity.projectId && project.path === source,
              );
              if (!primary)
                throw Error(
                  "Основная папка проекта изменилась. Выберите контекст заново.",
                );
              return this.topics(primary, identity.year);
            }),
      env: childEnvironment(process.env, {
        HOME: this.home,
        GIT_OPTIONAL_LOCKS: "0",
      }),
    });
  }
  /** Explicit working intent only; physical resolve/list/view/sync stay independent. */
  async checkTopicContextReadiness(
    input: TopicContextIdentity | TopicContextRef,
  ): Promise<WorktreeRecord | null> {
    this.check();
    const request = topicContextReadinessSchema.parse(input);
    if (request.topic !== slug(request.branch))
      throw Error("Некорректная идентичность топика.");
    if (!("contextId" in request)) {
      const project = (await this.listProjects()).find(
        (p) => p.id === request.projectId,
      );
      if (!project) throw Error("Неизвестный проект");
      const owners = (await this.clones.list(request.projectId)).filter(
        (r) =>
          r.year === request.year &&
          r.topic === request.topic &&
          r.branch === request.branch &&
          !r.deletedAt,
      );
      if (owners.length > 1)
        throw Error(
          "Владелец топика неоднозначен. Выберите точную рабочую копию.",
        );
      if (owners.length === 1)
        return this.checkTopicContextReadiness(worktreeContextRef(owners[0]!));
      await this.assertTaskReady(request, project.path);
      return null;
    }
    return (await this.readyTopicContext(request)).record;
  }
  private async readyTopicContext(ref: TopicContextRef) {
    const record = await this.resolveTopicContext(ref);
    // Check registry/project identity only; primary task data never governs a ready clone.
    const project = (await this.listProjects()).find(
      (p) => p.id === ref.projectId,
    );
    if (!project || project.path !== record.projectPath)
      throw Error(
        "Основная папка проекта изменилась. Выберите контекст заново.",
      );
    const verify = await this.assertTaskReady(ref, project.path, record);
    const after = await this.resolveTopicContext(ref);
    if (after.path !== record.path || after.revision !== record.revision)
      throw Error("Рабочая копия изменилась во время проверки.");
    await verify();
    return { record: after, verify };
  }
  async resolveTopicContext(input: TopicContextRef): Promise<WorktreeRecord> {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    const project = await this.project(ref.projectId);
    const record = await this.clones.resolve(ref);
    if (record.projectPath !== (await realpath(project.path)))
      throw Error(
        "Основная папка проекта изменилась. Выберите контекст заново.",
      );
    return record;
  }
  async listTopicContexts(id: string): Promise<WorktreeRecord[]> {
    this.check();
    const project = await this.project(id);
    const root = await realpath(project.path);
    const records = await this.clones.reconcile(id);
    if (records.some((record) => record.projectPath !== root))
      throw Error(
        "Реестр относится к прежней папке проекта. Требуется проверка.",
      );
    return records.filter((r) => !r.deletedAt);
  }
  private contextActive(contextId: string): boolean {
    return this.runList.some(
      (r) =>
        r.context?.contextId === contextId &&
        (r.status === "starting" ||
          r.status === "running" ||
          this.children.has(r.id)),
    );
  }
  async createTopicContext(input: {
    projectId: string;
    year: string;
    branch: string;
    baseRef: string;
  }) {
    this.check();
    return this.operation(() =>
      this.exclusive(input.projectId, async () =>
        this.clones.create(await this.project(input.projectId), {
          year: input.year,
          branch: input.branch,
          baseRef: input.baseRef,
        }),
      ),
    );
  }
  async migrateTopicContext(input: TopicContextIdentity) {
    const identity = topicContextIdentitySchema.parse(input);
    return this.operation(() =>
      this.exclusive(identity.projectId, async () =>
        this.clones.migrateLegacy(
          await this.project(identity.projectId),
          identity,
        ),
      ),
    );
  }
  async selectTopicContext(input: TopicContextRef | null) {
    this.check();
    const ref = topicContextRefSchema.nullable().parse(input);
    if (ref) await this.resolveTopicContext(ref);
    this.selectedContext = ref;
  }
  async syncTopicContext(input: TopicContextRef) {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    return this.operation(async () =>
      this.sync.request(await this.project(ref.projectId), ref),
    );
  }
  async runRepositoryAction(
    input: RepositoryActionRequest,
  ): Promise<RepositoryActionResult> {
    const request = repositoryActionRequestSchema.parse(input);
    return this.operation(() =>
      this.exclusive(request.projectId, async () => {
        let secrets: string[] = [];
        try {
          this.check();
          return await this.snapshot(
            request.context ?? request.projectId,
            async () => {
              const scoped = await this.project(request.context ?? request.projectId);
              const call = this.invocation(scoped);
              secrets = call.value.env.map((entry) => entry.value).filter(Boolean);
              const actions = new RepositoryActions({
                project: async () => {
                  this.check();
                  const project = (await this.listProjects()).find((p) => p.id === request.projectId);
                  if (!project) throw Error("Неизвестный проект.");
                  return project;
                },
                resolve: (ref) => this.resolveTopicContext(ref),
                sync: (project, ref, onDiagnostic) => this.sync.request(project, ref, "manual", undefined, false, onDiagnostic),
                verify: async () => {
                  this.check();
                  await this.assertSettings(request.projectId);
                  this.assertCatalog(this.context.getStore()!.catalogEpoch);
                },
                git: (args, cwd) => this.runner.command(
                  "git", args, cwd,
                  childEnvironment(process.env, { HOME: this.home, GIT_TERMINAL_PROMPT: "0" }),
                ),
                goga: async (args) => {
                  this.check();
                  await this.assertSettings(request.projectId);
                  await this.validateBinding(scoped);
                  return this.runner.command(call.executable, args, this.root(scoped), call.env);
                },
                gogaOriginal: async (args) => {
                  this.check();
                  await this.assertSettings(request.projectId);
                  await this.validateBinding(scoped);
                  this.assertCatalog(this.context.getStore()!.catalogEpoch);
                  // Project.path is the captured original; root(scoped) would select the clone.
                  return this.runner.command(call.executable, args, scoped.path, call.env);
                },
                secrets,
              });
              return actions.run(request);
            },
            false,
          );
        } catch (error) {
          return repositoryActionFailure(request, error, "", secrets);
        }
      }),
    );
  }
  async topicSyncStatus(input: TopicContextRef) {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    return this.sync.status(await this.project(ref.projectId), ref);
  }
  async retryContextSync(input: TopicContextRef) {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    return this.operation(async () =>
      this.sync.retry(await this.project(ref.projectId), ref, true),
    );
  }
  async prepareContextApply(input: TopicContextRef) {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    return this.operation(async () =>
      this.sync.previewApply(await this.project(ref.projectId), ref),
    );
  }
  async applyContext(input: {
    projectId: string;
    token: string;
    confirmed: true;
  }) {
    this.check();
    if ((await this.sync.applyProjectId(input.token)) !== input.projectId)
      throw Error("Подтверждение другого проекта.");
    return this.operation(async () =>
      this.sync.apply(await this.project(input.projectId), input),
    );
  }
  private deletionGuards(ref: TopicContextRef) {
    return {
      active: this.contextActive(ref.contextId),
      current: this.selectedContext?.contextId === ref.contextId,
    };
  }
  async contextDeletionRecovery(input: TopicContextRef) {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    const project = await this.project(ref.projectId);
    const plans = (await this.clones.deletionRecovery(ref.projectId))
      .filter(
        (p) =>
          p.owner.contextId === ref.contextId &&
          p.owner.projectId === ref.projectId &&
          p.owner.year === ref.year &&
          p.owner.topic === ref.topic &&
          p.owner.branch === ref.branch &&
          p.projectPath === project.path &&
          p.stage !== "completed" &&
          (p.stage !== "prepared" || p.expiresAt > Date.now()),
      )
      .sort((a, b) => b.expiresAt - a.expiresAt);
    const plan = plans[0];
    return plan
      ? {
          token: plan.token,
          contextId: ref.contextId,
          stage: plan.stage,
          details: [
            "Незавершённое удаление восстановлено из журнала.",
            "Повтор использует прежний снимок и архивные refs; основная папка не удаляется.",
          ],
        }
      : null;
  }
  async prepareContextDeletion(input: TopicContextRef) {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    const guards = this.deletionGuards(ref);
    if (guards.active || guards.current)
      throw Error("Выбранный или активный контекст нельзя удалить.");
    const recovered = await this.contextDeletionRecovery(ref);
    if (recovered) return recovered;
    await this.resolveTopicContext(ref);
    const plan = await this.clones.prepareDeletion(
      ref,
      this.deletionGuards(ref),
    );
    return {
      token: plan.token,
      contextId: ref.contextId,
      stage: plan.stage,
      details: [
        "Все коммиты, ветки, теги и reflog будут сохранены в служебных refs основной папки.",
        "Owned clone будет перемещён в системную Корзину. Основная папка и внешние рабочие копии не удаляются.",
        "Незакоммиченные и ценные ignored-файлы блокируют удаление.",
      ],
    };
  }
  async deleteContext(input: { projectId: string; token: string }) {
    this.check();
    if (!this.trashItem) throw Error("Системная Корзина недоступна.");
    return this.operation(async () => {
      const plan = (await this.clones.deletionRecovery(input.projectId)).find(
        (p) => p.token === input.token,
      );
      if (!plan) throw Error("Подтверждение удаления отсутствует.");
      const result = await this.clones.executeDeletion(
        input.token,
        this.deletionGuards(plan.owner),
        {
          trashItem: async (root) => {
            if (
              this.deletionGuards(plan.owner).active ||
              this.deletionGuards(plan.owner).current
            )
              throw Error("Контекст активен или выбран.");
            await this.trashItem!(root);
          },
          removeTopic: async () =>
            this.snapshot(
              input.projectId,
              async () => {
                const d = await this.topicsContext(input.projectId);
                if (d.active()) throw Error("Основная папка занята.");
                const refs = await d.git([
                  "for-each-ref",
                  "--format=%(refname)",
                  "refs/heads",
                  "refs/remotes",
                ]);
                if (
                  refs
                    .split("\n")
                    .includes("refs/remotes/origin/" + plan.owner.branch)
                )
                  throw Error(
                    "Удаление внешней ветки не разрешено этим подтверждением.",
                  );
                if (
                  !refs.split("\n").includes("refs/heads/" + plan.owner.branch)
                )
                  return;
                const board = await this.topicDomain.board(d, plan.owner.year);
                const ticket = await this.topicDomain.prepare(d, {
                  projectId: input.projectId,
                  year: plan.owner.year,
                  action: "delete",
                  expectedRevision: board.revision,
                  topics: [plan.owner.topic],
                });
                const removed = await this.topicDomain.execute(d, ticket.token);
                if (removed.status !== "success") throw Error(removed.message);
              },
              false,
            ),
        },
      );
      this.catalogEpoch++;
      this.previews.clear();
      return {
        projectId: input.projectId,
        status: result.status,
        message: result.message,
        stage: result.stage,
      };
    });
  }
  private async topicsContext(id: ScopeRef): Promise<TopicsContext> {
    const project = await this.project(id);
    const key = await this.key(project);
    return {
      project,
      root: this.root(project),
      owner: this.binding(project)
        ? worktreeContextRef(this.binding(project)!)
        : undefined,
      gitEnv: childEnvironment(process.env, { HOME: this.home }),
      git: (args) => this.cmd(project, args, true),
      goga: async (args, stdin) => {
        await this.assertSettings(scopeProjectId(id));
        await this.validateBinding(project);
        const call = this.invocation(project);
        try {
          return (
            await this.runner.command(
              call.executable,
              args,
              this.root(project),
              call.env,
              stdin,
            )
          ).stdout;
        } catch {
          throw new Error(
            "Операция Goga не выполнена. Проверьте конфигурацию и состояние репозитория.",
          );
        }
      },
      fingerprint: () => this.fingerprint(project),
      baseRef: async () => {
        const config = await this.config(project);
        return typeof config?.topics?.base_ref === "string"
          ? config.topics.base_ref
          : "";
      },
      active: () =>
        this.activeKeys.has(key) ||
        (this.binding(project)
          ? this.contextActive(this.binding(project)!.contextId)
          : this.runList.some(
              (r) =>
                r.projectId === project.id &&
                !r.context &&
                ["starting", "running"].includes(r.status),
            )),
      assertBranchesAvailable: (branches, operation) =>
        assertTopicBranchesAvailable(
          (args) => this.cmd(project, args, true),
          this.root(project),
          branches,
          operation,
        ),
    };
  }
  async readTopicCatalog(
    projectId: string,
    year: string,
  ): Promise<TopicCatalogSnapshot> {
    this.check();
    assertReadActive();
    // This endpoint is primary-only. In particular, never inherit a clone
    // binding from a nested read and silently label its data as primary.
    if (typeof projectId !== "string" || this.context.getStore()?.binding)
      throw Error("Каталог доступен только для основной папки проекта.");
    this.parseScope(projectId);
    topicYearSchema.parse(year);
    const result = await this.snapshot(projectId, async () => {
      const project = await this.project(projectId);
      await this.validateBinding(project);
      assertReadActive();
      const catalog = await this.topicDomain.catalog(
        {
          project,
          goga: async (args) => {
            await this.assertSettings(projectId);
            await this.validateBinding(project);
            assertReadActive();
            const call = this.invocation(project);
            try {
              return (
                await this.runner.command(
                  call.executable,
                  args,
                  project.path,
                  call.env,
                )
              ).stdout;
            } catch {
              assertReadActive();
              throw Error(
                "Не удалось выполнить команду Goga. Проверьте конфигурацию проекта.",
              );
            }
          },
        },
        year,
      );
      await this.validateBinding(project);
      assertReadActive();
      return catalog;
    });
    assertReadActive();
    return result;
  }
  async readTopicBoard(scope: ScopeRef, year: string) {
    return this.snapshot(scope, async () => {
      const board = await this.topicDomain.board(
        await this.topicsContext(scope),
        year,
      );
      if (typeof scope !== "string") return board;
      const before = await this.clones.reconcile(scope);
      for (const owner of before.filter(
        (r) =>
          r.year === year &&
          r.storageKind === "clone" &&
          r.ownership === "managed" &&
          !r.deletedAt,
      )) {
        let row = {
          topic: owner.topic,
          branch: owner.branch,
          statuses: [] as string[],
          current: false,
          remote: false,
          todo: null as string | null,
          divergence: null as string | null,
        };
        let hosts = [owner.branch];
        if (owner.state === "ready") {
          const ref = worktreeContextRef(owner);
          const local = await this.snapshot(ref, async () =>
            this.topicDomain.board(await this.topicsContext(ref), year),
          );
          const own = local.entries.find(
            (r) =>
              !r.remote && r.topic === owner.topic && r.branch === owner.branch,
          );
          if (own) {
            row = { ...own, current: board.currentBranch === owner.branch };
            hosts = own.hosts;
          }
        }
        // Registry inventory exposes unavailable owners honestly, never substitutes primary for their details.
        board.entries = board.entries.filter(
          (r) =>
            r.remote || r.topic !== owner.topic || r.branch !== owner.branch,
        );
        board.records = board.records.filter(
          (r) =>
            r.remote || r.topic !== owner.topic || r.branch !== owner.branch,
        );
        board.entries.push({ ...row, hosts });
        board.records.push(row);
      }
      const after = await this.clones.reconcile(scope);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw Error("Каталог контекстов изменился; обновите список.");
      board.revision = digest(
        JSON.stringify([
          board.revision,
          before.map((r) => [r.contextId, r.revision, r.state]),
        ]),
      );
      return board;
    });
  }
  async readTopicDetails(id: ScopeRef, year: string, target: TopicTarget) {
    if (
      typeof id !== "string" &&
      (id.year !== year ||
        id.topic !== target.topic ||
        id.branch !== target.branch ||
        target.remote)
    )
      throw Error("Топик относится к другому контексту.");
    return this.snapshot(id, async () => {
      const context = await this.topicsContext(id);
      const details = await this.topicDomain.details(context, year, target);
      assertReadActive();
      if (context.owner) await this.resolveTopicContext(context.owner);
      assertReadActive();
      return details;
    });
  }
  async prepareTopicOperation(request: TopicOperationRequest) {
    return this.operation(() =>
      this.exclusive(request?.projectId, () =>
        this.snapshot(request?.context ?? request?.projectId, async () => {
          if (
            request.context &&
            (request.context.projectId !== request.projectId ||
              request.context.year !== request.year ||
              (request.target &&
                (request.target.remote ||
                  request.target.topic !== request.context.topic ||
                  request.target.branch !== request.context.branch)))
          )
            throw Error("Контекст другого топика.");
          if (
            request.context &&
            ["create", "switch", "delete"].includes(request.action)
          )
            throw Error(
              "Для создания/выбора/удаления owned clone используйте отдельное действие.",
            );
          let checked = request;
          if (!request.context) {
            const global = await this.readTopicBoard(
              request.projectId,
              request.year,
            );
            if (global.revision !== request.expectedRevision)
              throw Error("Каталог изменился; обновите данные.");
            const local = await this.topicDomain.board(
              await this.topicsContext(request.projectId),
              request.year,
            );
            checked = { ...request, expectedRevision: local.revision };
          }
          let proof:
            | { base?: BaseSnapshot; publication?: PublicationSnapshot }
            | undefined;
          if (
            request.context &&
            ["update", "publish", "propagate"].includes(request.action)
          ) {
            const before = await this.topicDomain.board(
              await this.topicsContext(request.context),
              request.year,
            );
            if (before.revision !== request.expectedRevision)
              throw Error("Каталог изменился; создайте новый предпросмотр.");
            const baseRef = request.baseRef || before.baseRef;
            if (
              request.action === "publish" ||
              request.action === "propagate" ||
              request.publish
            ) {
              const publication = await this.exchange.preparePublication(
                request.context,
                {
                  action: request.action as "publish" | "update" | "propagate",
                  ...(baseRef ? { baseRef } : {}),
                },
              );
              proof = { publication };
              if (request.action === "propagate")
                checked = { ...checked, baseRef: publication.baseRef };
            }
            if (request.action === "update") {
              const base = await this.exchange.captureBase(
                request.context,
                baseRef,
              );
              proof = { ...proof, base };
              checked = { ...checked, baseRef: base.cloneRef };
            }
            const after = await this.topicDomain.board(
              await this.topicsContext(request.context),
              request.year,
            );
            checked = { ...checked, expectedRevision: after.revision };
          }
          const plan = await this.topicDomain.prepare(
            await this.topicsContext(request.context ?? request.projectId),
            checked,
          );
          const visible = { ...plan, details: [...plan.details] };
          if (proof) {
            this.exchangePlans.set(plan.token, proof);
            const base = proof.base ?? proof.publication?.base;
            if (base)
              visible.details.unshift(
                `Выбранная база ${base.baseRef}: неизменяемый commit ${base.sourceOid}. Основная папка не изменяется.`,
              );
            if (proof.publication)
              visible.details.unshift(...proof.publication.details);
          }
          return visible;
        }),
      ),
    );
  }
  async executeTopicOperation(token: string) {
    const scope = this.topicDomain.scopeForToken(token);
    const id = scopeProjectId(scope);
    return this.operation(() =>
      this.exclusive(id, () =>
        this.snapshot(
          scope,
          async () => {
            const context = await this.topicsContext(scope);
            const proof = this.exchangePlans.get(token);
            const verify = async () => {
              if (proof?.base) await this.exchange.verifyBase(proof.base);
              if (proof?.publication)
                await this.exchange.verifyPublication(proof.publication);
            };
            await verify();
            const invoke = context.goga;
            context.goga = async (args, stdin) => {
              if (
                args.some((arg) =>
                  ["update", "publish", "propagate"].includes(arg),
                )
              )
                await verify();
              return invoke(args, stdin);
            };
            const key = await this.key(context.project);
            const previous = this.locks.get(key) ?? Promise.resolve();
            const next = previous
              .catch(() => {})
              .then(() => this.topicDomain.execute(context, token));
            this.locks.set(key, next);
            try {
              return await next;
            } finally {
              if (this.locks.get(key) === next) this.locks.delete(key);
              this.exchangePlans.delete(token);
            }
          },
          false,
        ),
      ),
    );
  }
  async listBuildFiles(id: ScopeRef, directory = "") {
    this.check();
    return browseBuildFiles(this.root(await this.project(id)), directory);
  }
  async readBuildPlan(id: ScopeRef, relative: string) {
    this.check();
    return readPlan(this.root(await this.project(id)), relative);
  }
  async buildContext(
    id: ScopeRef,
    selection: BuildContextSelection = {},
  ): Promise<BuildContext> {
    if (!buildSelectionSchema.safeParse(selection).success)
      throw new Error("Некорректный выбор сборки");
    validateBuildOptions(selection);
    selection = structuredClone(selection);
    return this.snapshot(id, async () => {
      const p = await this.project(id);
      const before = await this.fingerprint(p);
      const call = this.invocation(p);
      const [help, branch, refs, workflows, profiles] = await Promise.all([
        this.cmd(p, ["build", "--help"]),
        this.cmd(p, ["branch", "--show-current"], true),
        this.cmd(
          p,
          [
            "for-each-ref",
            "--format=%(refname:short)",
            "refs/heads",
            "refs/remotes",
          ],
          true,
        ),
        this.names(path.join(this.root(p), ".goga/workflows")),
        this.profiles(p),
      ]);
      const runtime = {
        ...(await buildHomeEnvironment(this.home)),
        ...Object.fromEntries(
          call.value.env.filter((e) => e.runtime).map((e) => [e.key, e.value]),
        ),
        ...Object.fromEntries(
          (selection.env ?? []).map((e) => [e.key, e.value]),
        ),
      };
      const workflow = selection.workflow || runtime.GOGA_WORKFLOW || "";
      const explicitProfile = selection.profile ?? call.value.profile;
      const profile =
        explicitProfile ||
        (call.value.env.some((e) => e.runtime && e.key === "GOGA_PROFILE") ||
        selection.env?.some((e) => e.key === "GOGA_PROFILE")
          ? runtime.GOGA_PROFILE
          : (call.env.GOGA_PROFILE ?? process.env.GOGA_PROFILE) ||
            runtime.GOGA_PROFILE) ||
        "";
      let defaults: BuildContext["defaults"] = {
        skipReview: false,
        profile: explicitProfile,
      };
      let effectiveReview: string | undefined;
      try {
        // Same executable/cwd/host environment as build's config amendment checkpoint.
        // --env/home.env are container layers, not host hook environment overrides.
        effectiveReview = await this.cmd(p, ["config", "build.review.skip"]);
      } catch {
        defaults.reviewError =
          "Не удалось прочитать настройку ревью из Goga. Проверьте версию, исполняемый файл и конфигурацию или выберите режим явно.";
      }
      if (effectiveReview !== undefined) {
        try {
          defaults.skipReview = buildReviewDefault(effectiveReview);
        } catch {
          defaults.reviewError =
            "Goga вернула некорректное значение настройки ревью. Проверьте версию и конфигурацию или выберите режим явно.";
        }
      }
      let historyPlan: BuildContext["historyPlan"] = { path: "" };
      let candidate: string | undefined;
      try {
        candidate = (
          await this.cmd(p, ["history", "path", "-f", "plan.md"])
        ).trim();
        if (!candidate) throw Error("Empty history path");
      } catch {
        historyPlan.error = buildPlanProblem(
          Error("[build-plan:history]"),
        ).message;
      }
      if (candidate) {
        historyPlan.path = candidate;
        try {
          historyPlan.path = (await readPlan(this.root(p), candidate)).path;
        } catch (error) {
          historyPlan.error = buildPlanProblem(error, true).message;
          // Never return an outside/absolute CLI-controlled path to the renderer.
          if (
            path.isAbsolute(candidate) ||
            candidate.split(/[\\/]/).includes("..") ||
            /[\x00-\x1f]/.test(candidate)
          )
            historyPlan.path = "";
        }
      }
      const capabilities = buildCapabilities(help);
      const branches = refs
        .trim()
        .split("\n")
        .filter((b) => b && !b.endsWith("/HEAD"));
      if (before !== (await this.fingerprint(p)))
        throw new Error("Контекст сборки изменился; обновите данные.");
      return {
        revision: digest(
          JSON.stringify([
            before,
            capabilities,
            defaults,
            workflow,
            explicitProfile,
            profile,
            selection.env ?? [],
            branches,
            historyPlan.path,
          ]),
        ),
        branch: branch.trim(),
        historyPlan,
        capabilities,
        defaults,
        branches,
        workflows,
        profiles,
      };
    });
  }
  async launchBuild(input: BuildRequest): Promise<Run> {
    // Safe errors: zod diagnostics can include user-controlled secrets.
    const parsed = buildRequestSchema.safeParse(input);
    if (!parsed.success) throw new Error("Некорректный запрос сборки");
    const request = structuredClone(parsed.data);
    this.validateRepeatRequest(request);
    validateBuildOptions(request.options);
    if (request.context && request.context.projectId !== request.projectId)
      throw Error("Контекст другого проекта.");
    if (request.context) assertContextEnvironment(request.options.env ?? []);
    return this.operation(() =>
      this.exclusive(request.projectId, () =>
        this.snapshot(
          request.context ?? request.projectId,
          async () => {
            const p = await this.project(request.projectId);
            await guardedProject(this.root(p));
            const key = await this.key(p);
            const previous = this.locks.get(key) ?? Promise.resolve();
            const next = previous
              .catch(() => {})
              .then(() => this.prepareBuild(p, key, request));
            this.locks.set(key, next);
            try {
              return await next;
            } finally {
              if (this.locks.get(key) === next) this.locks.delete(key);
            }
          },
          false,
        ),
      ),
    );
  }
  private async prepareBuild(
    p: Project,
    key: string,
    request: BuildRequest,
  ): Promise<Run> {
    this.check();
    this.assertRunAdmission(p, key, "build");
    if (request.options.clean && !request.confirmClean)
      throw new Error("Подтвердите очистку состояния сборки.");
    const selection = {
      ...(request.options.env !== undefined
        ? { env: request.options.env }
        : {}),
      ...(request.options.workflow !== undefined
        ? { workflow: request.options.workflow }
        : {}),
      ...(request.options.profile !== undefined
        ? { profile: request.options.profile }
        : {}),
    };
    const context = await this.buildContext(p.id, selection);
    if (!context.branch || request.expectedBranch !== context.branch)
      throw new Error("Текущая ветка изменилась. Обновите сборку.");
    if (context.revision !== request.contextRevision)
      throw new Error(
        "Контекст сборки устарел или настройки изменились. Обновите сборку.",
      );
    const plan = await readPlan(this.root(p), request.planPath);
    if (plan.version !== request.planVersion)
      throw new Error("План изменился. Откройте его заново перед сборкой.");
    const invocation = this.invocation(p);
    const options: BuildOptions = {
      ...request.options,
      profile: request.options.profile ?? invocation.value.profile,
    };
    // Project runtime entries preserve order/values; per-run entries override later.
    options.env = [
      ...invocation.value.env
        .filter((e) => e.runtime)
        .map(({ key, value }) => ({ key, value })),
      ...(options.env ?? []),
    ];
    validateBuildOptions(options);
    if (this.binding(p)) assertContextEnvironment(options.env ?? []);
    const args = buildArgs(plan.path, options, context.capabilities);
    if (options.workflow && !context.workflows.includes(options.workflow))
      throw new Error("Рабочий процесс отсутствует");
    if (
      options.profile &&
      !context.profiles.some((p) => p.name === options.profile)
    )
      throw new Error("Выбранный профиль отсутствует");
    const runtime = {
      ...(await buildHomeEnvironment(this.home)),
      ...Object.fromEntries(options.env.map((e) => [e.key, e.value])),
    };
    const workflow = options.workflow || runtime.GOGA_WORKFLOW || "";
    if (options.profile && !workflow)
      throw new Error(
        "Профиль сборки не применяется без рабочего процесса. Выберите рабочий процесс или автоматический профиль.",
      );
    if (options.baseRef && !context.branches.includes(options.baseRef))
      throw new Error(
        "Выберите существующую локальную или удалённую ветку сравнения",
      );
    if (context.defaults.reviewError && options.skipReview === undefined)
      throw new Error(context.defaults.reviewError);
    const configuredSecrets = await buildConfigurationSecrets(
      this.root(p),
      this.home,
    );
    const final = await this.buildContext(p.id, selection);
    if (final.revision !== context.revision || final.branch !== context.branch)
      throw new Error("Контекст сборки изменился перед запуском");
    if (
      (await readPlan(this.root(p), request.planPath)).version !== plan.version
    )
      throw new Error("План изменился перед запуском");
    await this.assertSettings(p.id);
    this.check();
    const run: Run = {
      id: randomUUID(),
      kind: "build",
      ...(this.binding(p)
        ? {
            context: {
              ...worktreeContextRef(this.binding(p)!),
              path: this.root(p),
              repositoryKey: this.binding(p)!.repositoryKey,
            },
            topic: this.binding(p)!.topic,
          }
        : {}),
      projectId: p.id,
      pipeline: "Сборка",
      topic: this.binding(p)?.topic ?? "",
      branch: context.branch,
      status: "running",
      workflow: workflow || null,
      profile: options.profile || null,
      startedAt: new Date().toISOString(),
      update: options.update === true,
      output: { text: "", truncated: false },
      build: {
        planPath: plan.path,
        planVersion: plan.version,
        clean: options.clean === true,
        update: options.update === true,
        ...(options.skipReview !== undefined
          ? { skipReview: options.skipReview }
          : {}),
        skipManifestCheck: options.skipManifestCheck === true,
      },
    };
    run.buildRepeat = createBuildRepeatSnapshot(request.options, {
      sourceRunId: run.id,
      ...(this.binding(p)
        ? { owner: worktreeContextRef(this.binding(p)!) }
        : {}),
    });
    let child: ChildProcessWithoutNullStreams;
    try {
      await this.validateBinding(p);
      this.addActiveRun(key, run.id);
      this.runList.push(run);
      await this.persistRuns();
      child = await this.startRun(
        run,
        p,
        invocation.executable,
        args,
        invocation.env,
      );
    } catch {
      this.removeActiveRun(key, run.id);
      run.status = "failed";
      run.endedAt = new Date().toISOString();
      if (this.runList.includes(run)) await this.persistRuns().catch(() => {});
      throw new Error(
        "Не удалось запустить сборку. Проверьте исполняемый файл и окружение.",
      );
    }
    const secrets = [
      ...configuredSecrets,
      ...invocation.value.env.map((e) => e.value),
      ...options.env.map((e) => e.value),
      options.proxy ?? "",
      ...Object.entries(process.env)
        .filter(([k]) =>
          /(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i.test(
            k,
          ),
        )
        .map(([, v]) => v ?? ""),
    ].filter(Boolean);
    if (options.proxy) {
      try {
        const url = new URL(options.proxy);
        for (const v of [url.username, url.password])
          if (v) secrets.push(v, decodeURIComponent(v));
      } catch {
        /* schema already validates URL */
      }
    }
    this.addActiveRun(key, run.id);
    if (!this.runList.includes(run)) this.runList.push(run);
    this.buildRequests.set(run.id, structuredClone(request));
    const output = captureRunOutput(child, secrets, (snapshot) => {
      run.output = snapshot;
      if (this.runList.includes(run)) this.emitRuns();
    });
    const onClose = (code: number | null) => {
      void this.terminateOwned(
        run.id,
        code === 0 ? "exited" : "failed",
        code === 0
          ? undefined
          : `Сборка завершилась с кодом ${code ?? "signal"}`,
      ).catch(() => {});
    };
    const onError = () => {
      void this.terminateOwned(
        run.id,
        "failed",
        "Не удалось запустить процесс сборки. Проверьте Goga и PATH.",
      ).catch(() => {});
    };
    child.on("close", onClose);
    child.on("error", onError);
    this.children.set(run.id, {
      child,
      output,
      key,
      secrets,
      deadlineAt: Infinity,
      timer: null,
      cancel: () => {
        child.off("close", onClose);
        child.off("error", onError);
      },
    });
    this.emitRuns();
    return this.publicRun(run);
  }
  private validateRepeatRequest(request: BuildRequest) {
    if (!request.repeat) return;
    const source = this.runList.find(
      (r) => r.id === request.repeat!.sourceRunId,
    );
    if (
      !source ||
      source.kind !== "build" ||
      source.projectId !== request.projectId
    )
      throw Error("Исходная сборка не найдена.");
    const narrow = (r: Run["context"] | BuildRequest["context"]) =>
      r
        ? {
            projectId: r.projectId,
            year: r.year,
            topic: r.topic,
            branch: r.branch,
            contextId: r.contextId,
            revision: r.revision,
          }
        : null;
    if (
      JSON.stringify(narrow(source.context)) !==
      JSON.stringify(narrow(request.context))
    )
      throw Error(
        "Повтор относится к другому контексту. Подготовьте исходную рабочую копию заново.",
      );
    const required = source.buildRepeat;
    const effective = new Map(
      (request.options.env ?? []).map((e) => [e.key, e.value]),
    );
    if (required?.requiredEnvKeys.some((k) => !effective.get(k)?.trim()))
      throw Error("Введите недостающие значения окружения исходной сборки.");
    if (required?.requiresProxy && !request.options.proxy)
      throw Error("Введите отсутствующий proxy исходной сборки.");
  }
  async prepareBuildRepeat(id: string): Promise<BuildRepeatPreparation> {
    this.check();
    const source = this.runList.find((r) => r.id === id);
    if (!source || source.kind !== "build" || !source.build)
      throw Error("Исходная сборка отсутствует.");
    if (["starting", "running"].includes(source.status))
      throw Error("Дождитесь завершения исходной сборки.");
    const ref = source.context
      ? {
          projectId: source.context.projectId,
          year: source.context.year,
          topic: source.context.topic,
          branch: source.context.branch,
          contextId: source.context.contextId,
          revision: source.context.revision,
        }
      : undefined;
    await this.project(ref ?? source.projectId);
    return buildRepeatPreparationSchema.parse({
      sourceRunId: id,
      projectId: source.projectId,
      ...(ref ? { context: ref } : {}),
      planPath: source.build.planPath,
      options: source.buildRepeat?.options ?? {
        clean: source.build.clean,
        update: source.build.update,
        skipReview: source.build.skipReview,
        skipManifestCheck: source.build.skipManifestCheck,
      },
      requiredEnvKeys: source.buildRepeat?.requiredEnvKeys ?? [],
      requiresProxy: source.buildRepeat?.requiresProxy ?? false,
      requiresReview: true,
      ...(!source.buildRepeat ? { legacyIncomplete: true } : {}),
    });
  }
  async repeatBuild(id: string, confirmClean: boolean): Promise<Run> {
    if (typeof confirmClean !== "boolean")
      throw new Error("Некорректное подтверждение очистки");
    const original = this.buildRequests.get(id);
    if (!original || !this.runList.some((r) => r.id === id))
      throw new Error("Исходная сборка недоступна для повтора");
    return this.launchBuild({ ...structuredClone(original), confirmClean });
  }
  async checkoutBranch(id: ScopeRef): Promise<string> {
    return (
      await this.cmd(await this.project(id), ["branch", "--show-current"], true)
    ).trim();
  }
  async discover(id: ScopeRef): Promise<Discovery> {
    return this.snapshot(id, () => this.discoverWithSettings(id));
  }
  private async discoverWithSettings(id: ScopeRef): Promise<Discovery> {
    const p = await this.project(id);
    const [
      catalog,
      topics,
      branches,
      current,
      config,
      workflows,
      homeProfiles,
      projectProfiles,
    ] = await Promise.all([
      this.cmd(p, ["pipeline", "--list", "--info"]),
      this.topics(p),
      this.cmd(
        p,
        [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
          "refs/remotes",
        ],
        true,
      ),
      this.cmd(p, ["branch", "--show-current"], true),
      this.config(p),
      this.names(path.join(this.root(p), ".goga/workflows")),
      this.names(path.join(this.home, ".goga/profiles")),
      this.names(path.join(this.root(p), ".goga/profiles")),
    ]);
    const profiles = new Map<string, "home" | "project">(
      homeProfiles.map((n) => [n, "home"]),
    );
    for (const n of projectProfiles) profiles.set(n, "project");
    return {
      projectSettings: {
        version: this.context.getStore()!.document.version,
        profile: this.invocation(p).value.profile,
        executable: this.invocation(p).executable,
      },
      pipelines: parseCatalog(catalog),
      topics,
      branches: branches
        .trim()
        .split("\n")
        .filter((b) => b && !b.endsWith("/HEAD")),
      currentBranch: current.trim(),
      baseRef:
        typeof config?.topics?.base_ref === "string"
          ? config.topics.base_ref
          : undefined,
      workflows,
      profiles: [...profiles]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, source]) => ({ name, source })),
    };
  }
  private normalize(r: PipelineRequest): PipelineRequest {
    if (!r || typeof r.projectId !== "string")
      throw new Error("Некорректный запрос");
    if (
      r.profileMode !== undefined &&
      !["project", "auto"].includes(r.profileMode)
    )
      throw new Error("Некорректный выбор профиля");
    if (r.profileMode === "auto" && r.profile)
      throw new Error("Некорректный выбор профиля");
    pipelineArgs(r, true);
    if (r.context && r.context.projectId !== r.projectId)
      throw Error("Контекст другого проекта.");
    return {
      projectId: r.projectId,
      ...(r.context ? { context: topicContextRefSchema.parse(r.context) } : {}),
      pipeline: r.pipeline,
      workflow: r.workflow,
      profile: r.profile,
      ...(r.profileMode ? { profileMode: r.profileMode } : {}),
      skips: [...new Set(r.skips)],
    };
  }
  private async fingerprint(p: Project) {
    const chunks: string[] = [
      await this.cmd(p, ["rev-parse", "HEAD"], true),
      await this.cmd(p, ["branch", "--show-current"], true),
      process.env.GOGA_PROFILE ?? "",
      (await this.state.read(p.id)).version,
      JSON.stringify(this.invocation(p).value),
    ];
    const walk = async (dir: string, depth = 0) => {
      if (depth > 8) throw new Error("Слишком глубокие определения Goga");
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(dir, e.name);
        if (e.isSymbolicLink())
          throw new Error(
            "Символические ссылки в определениях Goga не поддержаны",
          );
        if (e.isDirectory()) await walk(file, depth + 1);
        else if (e.isFile()) {
          const info = await lstat(file);
          if (info.size > 4 * 1024 * 1024)
            throw new Error("Определения Goga слишком велики");
          chunks.push(file, await readFile(file, "utf8"));
        }
      }
    };
    for (const base of [this.root(p), this.home]) {
      const root = path.join(base, ".goga");
      chunks.push((await optionalText(path.join(root, "config.yml"))) ?? "");
      for (const sub of ["pipelines", "workflows", "profiles", "tools"])
        await walk(path.join(root, sub));
    }
    return digest(chunks.join("\0"));
  }
  private async compose(
    p: Project,
    r: PipelineRequest,
  ): Promise<Omit<Preview, "token">> {
    let workflow: string | null = null;
    if (r.workflow !== "none") {
      const names = await this.names(
        path.join(this.root(p), ".goga/workflows"),
      );
      workflow =
        r.workflow === "auto"
          ? names.includes(r.pipeline)
            ? r.pipeline
            : null
          : workflowName(r.workflow);
      if (workflow && !names.includes(workflow))
        throw new Error("Рабочий процесс отсутствует в проекте");
    }
    const explicit =
      r.profile ||
      (r.profileMode === "auto" ? "" : this.invocation(p).value.profile);
    if (explicit && !workflow)
      throw new Error(
        "Этот конвейер не применяет профиль без рабочего процесса. Выберите рабочий процесс или Автоматически для этого запуска.",
      );
    if (explicit && !(await this.profiles(p)).some((x) => x.name === explicit))
      throw new Error(
        "Выбранный профиль отсутствует. Обновите список профилей.",
      );
    let profile = workflow
      ? explicit || process.env.GOGA_PROFILE?.trim() || null
      : null;
    if (!profile && workflow) {
      const text = await optionalText(
        path.join(this.root(p), ".goga/workflows", workflow + ".yml"),
      );
      profile = peekWorkflowProfile(text ?? "");
    }
    const output = await this.cmd(
      p,
      pipelineArgs({ ...r, profile: explicit }, true),
    );
    return { stages: parseCard(output), workflow, profile };
  }
  async preview(request: PipelineRequest): Promise<Preview> {
    return this.snapshot(request?.context ?? request?.projectId, () =>
      this.previewWithSettings(request),
    );
  }
  private async previewWithSettings(
    request: PipelineRequest,
  ): Promise<Preview> {
    const r = this.normalize(request),
      p = await this.project(r.projectId);
    const epoch = this.context.getStore()!.catalogEpoch;
    this.assertCatalog(epoch);
    const before = await this.fingerprint(p);
    const metadata = r.context
      ? parseCatalog(await this.cmd(p, ["pipeline", "--list", "--info"])).find(
          (row) => row.id === r.pipeline,
        )
      : undefined;
    const composed = await this.compose(p, r);
    if (before !== (await this.fingerprint(p)))
      throw new Error(
        "Определения изменились во время предпросмотра. Обновите его.",
      );
    this.assertCatalog(epoch);
    const result = { ...composed, token: randomUUID() };
    for (const [token, value] of this.previews)
      if (Date.now() - value.created > 15 * 60 * 1000)
        this.previews.delete(token);
    this.previews.set(result.token, {
      request: r,
      ...(metadata ? { metadata } : {}),
      fingerprint: before,
      preview: result,
      created: Date.now(),
    });
    return result;
  }
  private publicRun(run: Run): Run {
    const { process: _private, ...visible } = run;
    return structuredClone(visible);
  }
  runs(): Run[] {
    return this.runList.map((run) => this.publicRun(run));
  }
  private runOwnerHash(run: Run) {
    const c = run.context,
      b = run.build,
      t = run.taskSnapshot;
    return digest(
      JSON.stringify([
        run.id,
        run.projectId,
        c
          ? [
              c.projectId,
              c.year,
              c.topic,
              c.branch,
              c.contextId,
              c.revision,
              c.path,
              c.repositoryKey,
            ]
          : null,
        run.kind ?? null,
        run.pipeline,
        run.topic,
        run.branch,
        run.startedAt,
        b
          ? [
              b.planPath,
              b.planVersion,
              b.clean,
              b.update,
              b.skipReview ?? null,
              b.skipManifestCheck,
            ]
          : null,
        t ? [t.text, t.year, t.topic, t.branch] : null,
      ]),
    );
  }
  private async startRun(
    run: Run,
    p: Project,
    exe: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) {
    if (!this.recovery) return this.runner.start(exe, args, this.root(p), env);
    const launched = await this.recovery.launch({
      runId: run.id,
      ownerHash: this.runOwnerHash(run),
      cwd: this.root(p),
      exe,
      args,
      env: childEnvironment(process.env, { HOME: this.home }, env),
      journal: async (metadata) => {
        run.process = metadata;
        await this.persistRuns();
      },
    });
    return launched.child;
  }
  private async reconcileStoredRun(run: Run) {
    if (!this.recovery) {
      run.recovery = "unverified";
      run.recoveryMessage =
        "Нет проверяемого канала восстановления этого запуска.";
      return;
    }
    try {
      const p = await this.project(
        run.context
          ? {
              projectId: run.context.projectId,
              year: run.context.year,
              topic: run.context.topic,
              branch: run.context.branch,
              contextId: run.context.contextId,
              revision: run.context.revision,
            }
          : run.projectId,
      );
      const result = await this.recovery.reconcile(
        run.process,
        this.runOwnerHash(run),
        this.root(p),
      );
      if (result.state === "terminal") {
        run.status = result.status;
        run.endedAt = result.endedAt;
        delete run.recovery;
        delete run.recoveryMessage;
        delete run.url;
        run.dashboardOpened = false;
        if (run.context) run.syncPending = true;
      } else if (result.state === "alive") {
        run.recovery = "confirmed";
        run.recoveryMessage =
          "Владелец supervisor подтверждён. Процесс продолжает работу; его можно безопасно остановить.";
      } else {
        run.recovery = "unverified";
        run.recoveryMessage = result.message;
      }
    } catch {
      run.recovery = "unverified";
      run.recoveryMessage =
        "Исходный контекст или сохранённые данные процесса недоступны. Никакой процесс не остановлен; восстановите исходную копию и повторите проверку.";
    }
  }
  async reconcileRun(id: string): Promise<Run> {
    this.check();
    const run = this.runList.find((r) => r.id === id);
    if (!run) throw Error("Неизвестный запуск");
    if (!this.children.has(id) && ["starting", "running"].includes(run.status))
      await this.reconcileStoredRun(run);
    await this.persistRuns();
    await this.syncCompletedRun(run);
    this.emitRuns();
    return this.publicRun(run);
  }
  private emitRuns() {
    void this.persistRuns().catch(() => {});
    this.emit("runs", this.runs());
  }
  private async key(p: Project) {
    const dir = (
      await this.cmd(p, ["rev-parse", "--git-common-dir"], true)
    ).trim();
    return realpath(path.resolve(this.root(p), dir));
  }
  async launch(request: LaunchRequest): Promise<Run> {
    if (request?.update !== undefined && typeof request.update !== "boolean")
      throw new Error("Некорректный параметр обновления (update)");
    return this.operation(() =>
      this.exclusive(request?.projectId, () =>
        this.snapshot(
          request?.context ?? request?.projectId,
          () => this.launchWithSettings(request),
          false,
        ),
      ),
    );
  }
  private async launchWithSettings(request: LaunchRequest): Promise<Run> {
    assertEnvironmentTransport(this.context.getStore()!.document.value.env);
    if (typeof request?.clean !== "boolean")
      throw new Error("Некорректный параметр очистки состояния (clean)");
    if (
      typeof request.expectedBranch !== "string" ||
      request.expectedBranch.length > 256 ||
      typeof request.confirmBranchSwitch !== "boolean"
    )
      throw new Error("Некорректное подтверждение текущей ветки");
    if (
      typeof request.confirmEmptyTask !== "boolean" ||
      "confirmTaskOverwrite" in request ||
      (request.topic?.mode === "existing"
        ? typeof request.taskVersion !== "string" ||
          !/^[a-f0-9]{64}$/.test(request.taskVersion)
        : request.taskVersion !== undefined)
    )
      throw new Error(
        "Задача устарела или отсутствует версия. Откройте её заново.",
      );
    const r = this.normalize(request),
      p = await this.project(r.projectId);
    await guardedProject(this.root(p));
    const key = await this.key(p);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.prepare(p, key, r, request));
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  private async prepare(
    p: Project,
    key: string,
    r: PipelineRequest,
    request: LaunchRequest,
  ): Promise<Run> {
    this.check();
    this.assertRunAdmission(p, key, "pipeline");
    const saved = this.previews.get(request.previewToken);
    if (
      !saved ||
      JSON.stringify(saved.request) !== JSON.stringify(r) ||
      Date.now() - saved.created > 15 * 60 * 1000 ||
      saved.fingerprint !== (await this.fingerprint(p))
    )
      throw new Error("Предпросмотр устарел. Обновите стадии перед запуском.");
    if (!saved.preview.stages.length)
      throw new Error("Нельзя запустить пустой набор стадий");
    validateTaskText(request.task);
    if (this.binding(p) && !request.task.trim())
      throw Error(
        "Введите непустое описание задачи для запуска в рабочей копии.",
      );
    const selection = request.topic;
    if (!selection || !["existing", "new"].includes(selection.mode))
      throw new Error("Выберите топик");
    const current = (
      await this.cmd(p, ["branch", "--show-current"], true)
    ).trim();
    if (
      this.binding(p) &&
      (request.topic.mode !== "existing" ||
        request.topic.branch !== this.binding(p)!.branch ||
        request.topic.topic !== this.binding(p)!.topic)
    )
      throw Error("Выберите топик, которому принадлежит клон.");
    const assertBranch = async (expected: string) => {
      if (
        (await this.cmd(p, ["branch", "--show-current"], true)).trim() !==
        expected
      )
        throw new Error(
          "Текущая ветка изменилась вне приложения. Обновите каталог и подтвердите запуск повторно.",
        );
    };
    if (current !== request.expectedBranch)
      throw new Error(
        "Текущая ветка изменилась вне приложения. Обновите каталог и подтвердите запуск повторно.",
      );
    if (
      (selection.mode === "new" || selection.branch !== current) &&
      !request.confirmBranchSwitch
    )
      throw new Error("Подтвердите переключение ветки перед запуском.");
    if (
      (selection.mode === "new" || selection.branch !== current) &&
      this.activeRuns(p, key).length
    )
      throw new Error(
        "Нельзя переключать или создавать ветку, пока в этой папке работает процесс.",
      );
    let branch: string, topic: string, launchTaskPath: string;
    let mutated = false;
    let taskSnapshot: TopicTaskDocument | undefined;
    const assertTask = async (
      expected:
        Pick<TopicTaskDocument, "text" | "exists"> | undefined = taskSnapshot,
    ) => {
      if (!taskSnapshot || !expected) return;
      if (taskPath(topic, this.binding(p)?.year) !== taskSnapshot.path)
        throw new Error("Год задачи изменился. Откройте её заново.");
      const commit = (
        await this.cmd(
          p,
          ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
          true,
        )
      ).trim();
      if (this.binding(p)) {
        const rows = (await this.topics(p, this.binding(p)!.year)).filter(
          (row) => row.topic === topic && row.branch === branch,
        );
        // A confirmed task version includes whether native metadata was absent.
        // Only our own subsequent todo write may turn that absence into a row.
        const expectedMissing =
          expected === taskSnapshot &&
          taskSnapshot.catalogState === "missing-local-metadata";
        if (rows.length > 1 || (rows.length === 0) !== expectedMissing)
          throw Error("Каталог топика изменился. Откройте задачу заново.");
      }
      const actual = await readWorkingTask(this.root(p), taskSnapshot.path);
      if (
        taskDocument(
          this.root(p),
          branch,
          commit,
          taskSnapshot.path,
          taskSnapshot,
        ).version !== taskSnapshot.version ||
        actual.exists !== expected.exists ||
        actual.text !== expected.text
      )
        throw new Error(
          "Задача или ветка изменены извне. Запуск отменён; откройте задачу заново.",
        );
    };
    try {
      if (selection.mode === "new") {
        branch = selection.name;
        if (
          typeof branch !== "string" ||
          branch.startsWith("-") ||
          branch.length > 180 ||
          /[\x00-\x20]/.test(branch)
        )
          throw new Error("Недопустимое имя ветки");
        await this.cmd(p, ["check-ref-format", "--branch", branch], true);
        topic = slug(branch);
        if (!topic)
          throw new Error(
            "Имя топика должно содержать латинские буквы или цифры",
          );
        if (
          typeof selection.baseRef !== "string" ||
          !selection.baseRef ||
          selection.baseRef.startsWith("-") ||
          /[\x00-\x20]/.test(selection.baseRef)
        )
          throw new Error("Недопустимая исходная ветка");
        await this.cmd(
          p,
          ["rev-parse", "--verify", `${selection.baseRef}^{commit}`],
          true,
        );
        if ((await this.cmd(p, ["status", "--porcelain"], true)).trim())
          throw new Error(
            "Есть незакоммиченные изменения. Сохраните или уберите их перед созданием топика.",
          );
        const topicRelative = `.goga/history/${new Date().getFullYear()}/${topic}`;
        launchTaskPath = `${topicRelative}/todo.md`;
        const topicDir = path.join(this.root(p), topicRelative);
        await noSymlinks(topicDir);
        const refs = (
          await this.cmd(
            p,
            [
              "for-each-ref",
              "--format=%(refname)",
              "refs/heads",
              "refs/remotes",
            ],
            true,
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        if (
          refs.some(
            (ref) =>
              ref === `refs/heads/${branch}` ||
              (ref.startsWith("refs/remotes/") &&
                ref
                  .slice("refs/remotes/".length)
                  .split("/")
                  .slice(1)
                  .join("/") === branch),
          )
        )
          throw new Error(
            "Имя ветки уже занято. Выберите существующий топик или другое имя.",
          );
        const directoryExists = async () =>
          lstat(topicDir).then(
            (stat) => stat.isDirectory(),
            (error) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          );
        if (await directoryExists())
          throw new Error("Имя топика уже занято в рабочей копии.");
        for (const ref of refs) {
          if (
            (
              await this.cmd(
                p,
                ["ls-tree", "-d", "--name-only", ref, "--", topicRelative],
                true,
              )
            ).trim()
          )
            throw new Error("Имя топика уже занято в истории веток.");
        }
        const beforeState = JSON.stringify([
          await this.cmd(p, ["rev-parse", "HEAD"], true),
          await this.cmd(p, ["branch", "--show-current"], true),
          await this.cmd(p, ["status", "--porcelain"], true),
        ]);
        this.check();
        await assertBranch(current);
        try {
          await this.cmd(p, [
            "topics",
            "create",
            branch,
            "--base-ref",
            selection.baseRef,
            "--switch",
            ...(request.task ? ["--todo", request.task] : []),
          ]);
          mutated = true;
        } catch (error) {
          try {
            const afterState = JSON.stringify([
              await this.cmd(p, ["rev-parse", "HEAD"], true),
              await this.cmd(p, ["branch", "--show-current"], true),
              await this.cmd(p, ["status", "--porcelain"], true),
            ]);
            mutated = beforeState !== afterState || (await directoryExists());
          } catch {
            throw new Error(
              "Создание топика не завершилось. Не удалось проверить состояние рабочей копии; проверьте ветку и todo.md.",
            );
          }
          throw error;
        }
      } else {
        branch = selection.branch;
        topic = selection.topic;
        taskSnapshot = await this.readTopicTask({
          projectId: p.id,
          branch,
          topic,
        });
        launchTaskPath = taskSnapshot.path;
        if (taskSnapshot.version !== request.taskVersion)
          throw new Error(
            "Задача изменена извне или устарела. Откройте её заново.",
          );
        if (
          taskSnapshot.text.trim() &&
          !request.task.trim() &&
          !request.confirmEmptyTask
        )
          throw new Error("Подтвердите замену задачи пустым текстом.");
        if (branch !== current) {
          if ((await this.cmd(p, ["status", "--porcelain"], true)).trim())
            throw new Error(
              "Есть незакоммиченные изменения. Сохраните или уберите их перед переключением ветки.",
            );
          this.check();
          await assertBranch(current);
          if (
            (await this.readTopicTask({ projectId: p.id, branch, topic }))
              .version !== taskSnapshot.version
          )
            throw new Error(
              "Задача или ветка изменились перед переключением. Откройте задачу заново.",
            );
          await assertBranch(current);
          await this.assertSettings(p.id);
          await this.cmd(
            p,
            ["switch", "--no-overwrite-ignore", "--", branch],
            true,
          );
          mutated = true;
        }
      }
      this.check();
      const actual = (
        await this.cmd(p, ["branch", "--show-current"], true)
      ).trim();
      if (actual !== branch)
        throw new Error("Текущая ветка изменилась вне приложения");
      await assertTask();
      const compositionFingerprint = await this.fingerprint(p);
      const composed = await this.compose(p, r);
      if (compositionFingerprint !== (await this.fingerprint(p)))
        throw new Error(
          "Определения изменились во время финального предпросмотра. Обновите стадии.",
        );
      if (
        JSON.stringify(composed) !==
        JSON.stringify({
          stages: saved.preview.stages,
          workflow: saved.preview.workflow,
          profile: saved.preview.profile,
        })
      )
        throw new Error(
          "После выбора ветки изменились стадии/рабочий процесс/профиль. Обновите предпросмотр.",
        );
      this.check();
      await assertBranch(branch);
      await assertTask();
      await assertBranch(branch);
      if (taskSnapshot && request.task !== taskSnapshot.text) {
        this.check();
        await this.assertSettings(p.id);
        await atomicWrite(
          path.join(this.root(p), taskSnapshot.path),
          request.task,
        );
        mutated = true;
      }
      await assertBranch(branch);
      // Optimistic final check: preserve the original revision even after our save.
      // External writers remain possible between this check and process spawn.
      await assertTask(
        taskSnapshot && request.task !== taskSnapshot.text
          ? { text: request.task, exists: true }
          : taskSnapshot,
      );
      await this.assertSettings(p.id);
      if (taskPath(topic, this.binding(p)?.year) !== launchTaskPath)
        throw new Error("Год задачи изменился. Откройте её заново.");
      // The create CLI (and its hooks) may normalize the submitted text. Record
      // what the pipeline will actually read, never substitute the editor draft.
      const startedTask = await readWorkingTask(this.root(p), launchTaskPath);
      if (taskSnapshot && startedTask.text !== request.task)
        throw new Error(
          "Задача изменена извне перед запуском. Откройте её заново.",
        );
      await assertBranch(branch);
      await this.assertSettings(p.id);
      const invocation = this.invocation(p);
      const effective =
        r.profile || (r.profileMode === "auto" ? "" : invocation.value.profile);
      const run: Run = {
        id: randomUUID(),
        ...(this.binding(p)
          ? {
              context: {
                ...worktreeContextRef(this.binding(p)!),
                path: this.root(p),
                repositoryKey: this.binding(p)!.repositoryKey,
              },
            }
          : {}),
        projectId: p.id,
        pipeline: r.pipeline,
        ...(saved.metadata
          ? {
              pipelineName: saved.metadata.name,
              pipelineDescription: saved.metadata.description,
            }
          : {}),
        topic,
        branch,
        status: "starting",
        workflow: composed.workflow,
        profile: composed.profile,
        startedAt: new Date().toISOString(),
        startupTimeoutMs:
          (invocation.value.startupTimeoutMinutes ??
            DEFAULT_STARTUP_TIMEOUT_MINUTES) * 60000,
        update: request.update === true,
        dashboardOpened: false,
        output: { text: "", truncated: false },
      };
      const deadlineAt = performance.now() + run.startupTimeoutMs!;
      run.taskSnapshot = {
        text: startedTask.text,
        year: launchTaskPath.split("/")[2]!,
        topic,
        branch,
      };
      await this.validateBinding(p);
      this.addActiveRun(key, run.id);
      this.runList.push(run);
      await this.persistRuns();
      let child: ChildProcessWithoutNullStreams;
      try {
        child = await this.startRun(
          run,
          p,
          invocation.executable,
          [
            ...pipelineArgs({ ...r, profile: effective }, false),
            ...(request.clean ? ["--clean"] : []),
            ...(request.update ? ["--update"] : []),
            ...invocation.value.env
              .filter((e) => e.runtime)
              .flatMap((e) => ["-e", `${e.key}=${e.value}`]),
          ],
          invocation.env,
        );
      } catch (error) {
        this.removeActiveRun(key, run.id);
        run.status = "failed";
        run.endedAt = new Date().toISOString();
        await this.persistRuns().catch(() => {});
        throw error;
      }
      this.addActiveRun(key, run.id);
      if (!this.runList.includes(run)) this.runList.push(run);
      this.previews.delete(request.previewToken);
      // Capture only child output, never command arguments/environment metadata.
      const secrets = [
        ...invocation.value.env.map((e) => e.value),
        ...Object.entries(process.env)
          .filter(([key]) =>
            /(?:token|secret|password|passwd|credential|api[_-]?key|private[_-]?key)/i.test(
              key,
            ),
          )
          .map(([, value]) => value ?? ""),
      ].filter(Boolean);
      const output = captureRunOutput(child, secrets, (snapshot) => {
        run.output = snapshot;
        if (this.runList.includes(run)) this.emitRuns();
      });
      const cancelWatch = watchDashboard(child, {
        timeoutMs: null, // One host deadline also covers actual embedded browser load.
        onReady: (url) => {
          if (
            run.status !== "starting" ||
            run.error ||
            this.stopFlights.has(run.id)
          )
            return;
          run.url = url;
          this.emitRuns();
        },
        onFinish: (code) => {
          if (!run.dashboardOpened)
            void this.terminateOwned(
              run.id,
              "failed",
              "Goga завершилась до открытия Dashboard.",
            ).catch(() => {});
          else
            void this.terminateOwned(
              run.id,
              code === 0 ? "exited" : "failed",
              code === 0
                ? undefined
                : `Goga завершилась с кодом ${code ?? "signal"}`,
            ).catch(() => {});
        },
        onFailure: (error) => {
          void this.terminateOwned(run.id, "failed", error.message).catch(
            () => {},
          );
        },
      });
      const entry = {
        child,
        output,
        key,
        deadlineAt,
        secrets,
        timer: null as ReturnType<typeof setTimeout> | null,
        cancel: () => {
          cancelWatch();
          if (entry.timer) clearTimeout(entry.timer);
          entry.timer = null;
        },
      };
      this.children.set(run.id, entry);
      entry.timer = setTimeout(
        () => this.expireStartup(run.id),
        Math.max(0, deadlineAt - performance.now()),
      );
      this.emitRuns();
      return this.publicRun(run);
    } catch (error) {
      if (mutated)
        throw new Error(
          `${(error as Error).message} Рабочая копия уже изменена; автоматического отката нет. Проверьте текущую ветку и todo.md.`,
        );
      throw error;
    }
  }
  closeRun(
    id: string,
    confirm: (run: Run) => Promise<boolean>,
  ): Promise<boolean> {
    const pending = this.closeFlights.get(id);
    if (pending) return pending;
    const operation = Promise.resolve()
      .then(async () => {
        const run = this.runList.find((r) => r.id === id);
        if (!run) throw new Error("Неизвестный запуск");
        if (run.syncPending)
          throw Error(
            "Автоматическая синхронизация ещё не записана. Сохранённый запуск нужен для повтора после перезапуска.",
          );
        if (
          this.children.has(id) ||
          run.status === "starting" ||
          run.status === "running"
        ) {
          if (!(await confirm({ ...run }))) return false;
          await this.stop(id);
        }
        // A completed observer may have updated the status while consent was open.
        if (this.children.has(id))
          throw new Error("Процесс ещё работает; вкладка сохранена.");
        this.runList = this.runList.filter((r) => r.id !== id);
        this.buildRequests.delete(id);
        this.emitRuns();
        return true;
      })
      .finally(() => this.closeFlights.delete(id));
    this.closeFlights.set(id, operation);
    return operation;
  }
  /** Trusted main-process acknowledgement, never exposed through renderer IPC. */
  markDashboardOpened(id: string, url: string): boolean {
    const run = this.runList.find((r) => r.id === id),
      entry = this.children.get(id);
    if (
      !run ||
      !entry ||
      run.status !== "starting" ||
      run.url !== url ||
      run.error ||
      this.stopFlights.has(id)
    )
      return false;
    if (performance.now() >= entry.deadlineAt) {
      this.expireStartup(id);
      return false;
    }
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    run.dashboardOpened = true;
    run.status = "running";
    this.emitRuns();
    return true;
  }
  async dashboardFailed(id: string, error: string): Promise<void> {
    const run = this.runList.find((r) => r.id === id);
    if (run?.status === "starting" && !run.dashboardOpened)
      await this.terminateOwned(id, "failed", error);
  }
  private expireStartup(id: string) {
    const run = this.runList.find((r) => r.id === id);
    if (!run || run.dashboardOpened || run.status !== "starting") return;
    void this.terminateOwned(
      id,
      "failed",
      "Время запуска истекло. Dashboard не открылся в установленный срок.",
    ).catch(() => {});
  }
  stop(id: string): Promise<void> {
    return this.terminateOwned(id, "stopped");
  }
  private terminateOwned(
    id: string,
    status: "failed" | "exited" | "stopped",
    error?: string,
  ): Promise<void> {
    const pending = this.stopFlights.get(id);
    if (pending) return pending;
    // Install single-flight before cancelling observers or any asynchronous kill.
    const operation = Promise.resolve()
      .then(() => this.finishOwned(id, status, error))
      .finally(() => this.stopFlights.delete(id));
    this.stopFlights.set(id, operation);
    return operation;
  }
  private async finishOwned(
    id: string,
    status: "failed" | "exited" | "stopped",
    error?: string,
  ): Promise<void> {
    const entry = this.children.get(id);
    if (!entry) {
      const recovered = this.runList.find((r) => r.id === id);
      if (
        recovered?.process &&
        this.recovery &&
        ["starting", "running"].includes(recovered.status)
      ) {
        const p = await this.project(
          recovered.context
            ? {
                projectId: recovered.context.projectId,
                year: recovered.context.year,
                topic: recovered.context.topic,
                branch: recovered.context.branch,
                contextId: recovered.context.contextId,
                revision: recovered.context.revision,
              }
            : recovered.projectId,
        );
        const result = await this.recovery.stop(
          recovered.process,
          this.runOwnerHash(recovered),
          this.root(p),
        );
        recovered.status = result.status;
        recovered.endedAt = result.endedAt;
        delete recovered.recovery;
        delete recovered.recoveryMessage;
        delete recovered.url;
        if (recovered.context) recovered.syncPending = true;
        await this.persistRuns();
        await this.syncCompletedRun(recovered);
        this.emitRuns();
        return;
      }
      if (this.runList.find((r) => r.id === id)?.recovery === "unverified")
        throw Error(
          "После перезапуска состояние процесса не подтверждено. Остановка по сохранённому PID не выполняется.",
        );
      return;
    }
    const run = this.runList.find((r) => r.id === id)!;
    const safe = (value: string) => {
      let text = stripVTControlCharacters(value);
      for (const secret of [...entry.secrets].sort(
        (a, b) => b.length - a.length,
      ))
        text = text.split(secret).join("[скрыто]");
      return text;
    };
    entry.cancel();
    if (error) run.error = safe(error);
    // Abort a pending native page/permission prompt before awaiting termination.
    if (!run.dashboardOpened) delete run.url;
    this.emitRuns();
    try {
      if (run.process && this.recovery) {
        const result = await this.recovery.stop(
          run.process,
          this.runOwnerHash(run),
          run.process.cwd,
        );
        if (!error && status !== "stopped") status = result.status;
      } else await this.runner.kill(entry.child);
    } catch (killError) {
      run.error = [
        error ? safe(error) : "",
        "Не удалось остановить процесс. Он может ещё работать; повторите остановку.",
        safe(
          killError instanceof Error ? killError.message : String(killError),
        ),
      ]
        .filter(Boolean)
        .join(" ");
      this.emitRuns();
      throw new Error(run.error);
    }
    entry.output.dispose();
    run.output = entry.output.snapshot();
    this.removeActiveRun(entry.key, id);
    this.children.delete(id);
    run.status = status;
    delete run.recovery;
    delete run.recoveryMessage;
    if (status === "stopped") delete run.error;
    else run.error = error ? safe(error) : undefined;
    run.endedAt = new Date().toISOString();
    if (run.context) run.syncPending = true;
    this.emitRuns();
    // The outcome and its pending import intent are one durable snapshot.
    await this.persistRuns();
    await this.syncCompletedRun(run);
  }
  private async syncCompletedRun(run: Run) {
    if (!run.context || !run.syncPending) return;
    const { projectId, contextId, revision, year, topic, branch } = run.context;
    try {
      await this.operation(async () =>
        this.sync.afterRun(
          await this.project(projectId),
          { projectId, contextId, revision, year, topic, branch },
          run.id,
        ),
      );
      run.syncPending = false;
      await this.persistRuns();
      this.emitRuns();
    } catch {
      /* Keep durable intent for restart replay; never rewrite the run outcome. */
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    // Cancel observers before any termination signal: intentional shutdown is not
    // a pipeline failure. Keep failed kills visible and retain their checkout locks.
    for (const entry of this.children.values()) entry.cancel();
    const stopped = await Promise.allSettled(
      [
        ...new Set([
          ...this.children.keys(),
          ...this.runList
            .filter(
              (r) => r.process && ["starting", "running"].includes(r.status),
            )
            .map((r) => r.id),
        ]),
      ].map((id) => this.stop(id)),
    );
    await this.runner.dispose?.();
    const failed = stopped.find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failed) throw failed.reason;
    await Promise.allSettled([...this.locks.values()]);
    await this.runSaveTail;
  }
}
