import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { parseDocument } from "yaml";
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
import {
  buildRepeatPreparationSchema,
  type BuildRepeatPreparation,
} from "../shared/build-repeat";
import {
  scopeProjectId,
  scopeRefSchema,
  type ScopeRef,
} from "../shared/context";
import type {
  ContextDeletionPreview,
  ContextDeletionResult,
} from "../shared/context-deletion";
import {
  isDeletableDocument,
  isDeletionToken,
  isDeletionVersion,
  type DeletableDocument,
  type DeletionResult,
  type DeletionTicket,
  type TrashItem,
} from "../shared/document-deletion";
import { assertEnvironmentTransport } from "../shared/environment-transport";
import {
  gitBranchProjectSchema,
  gitBranchRequestSchema,
  gitBranchTokenSchema,
  type GitBranchRequest,
} from "../shared/git-branches";
import {
  gitCommitRequestSchema,
  gitCommitTokenSchema,
  type GitCommitRequest,
} from "../shared/git-commit";
import {
  gitConflictSaveRequestSchema,
  gitConflictSaveTokenSchema,
  type GitConflictSaveRequest,
} from "../shared/git-conflict-save";
import {
  gitConflictReadRequestSchema,
  type GitConflictDocument,
  type GitConflictReadRequest,
} from "../shared/git-conflicts";
import {
  gitDiscardRequestSchema,
  gitDiscardTokenSchema,
  type GitDiscardRequest,
} from "../shared/git-discard";
import {
  gitCommitDiffRequestSchema,
  gitCommitReadRequestSchema,
  gitHistoryRequestSchema,
  type GitCommitDiffRequest,
  type GitCommitReadRequest,
  type GitHistoryRequest,
} from "../shared/git-history";
import {
  gitMergeOperationRequestSchema,
  gitMergeOperationTokenSchema,
  type GitMergeOperationRequest,
} from "../shared/git-operations";
import {
  gitRebaseOperationRequestSchema,
  gitRebaseOperationTokenSchema,
  type GitRebaseOperationRequest,
} from "../shared/git-rebase-operations";
import {
  gitSequencerOperationRequestSchema,
  gitSequencerOperationTokenSchema,
  type GitSequencerOperationRequest,
} from "../shared/git-sequencer-operations";
import {
  gitUpdateHandoffRequestSchema,
  gitUpdateHandoffTokenSchema,
  type GitUpdateHandoffCandidate,
  type GitUpdateHandoffRequest,
} from "../shared/git-update-handoff";
import {
  gitDiffRequestSchema,
  type GitDiffRequest,
  type GitWorkspaceDiff,
  type GitWorkspaceSnapshot,
  type GitWorkspaceSummary,
} from "../shared/git-workspace";
import type {
  HistoryPrunePreview,
  HistoryPruneResult,
} from "../shared/history";
import {
  historyEntrySchema,
  historyPathSchema,
  historyYearSchema,
} from "../shared/history";
import type { ProjectDocumentTarget } from "../shared/project-documents";
import {
  repositoryActionRequestSchema,
  type RepositoryActionRequest,
  type RepositoryActionResult,
} from "../shared/repository-actions";
import { DEFAULT_STARTUP_TIMEOUT_MINUTES } from "../shared/startup-timeout";
import type { TerminalContext } from "../shared/terminal";
import type {
  TopicBoardSnapshot,
  TopicCatalogSnapshot,
  TopicDetails,
  TopicOperationRequest,
  TopicTarget,
} from "../shared/topics";
import { topicTargetSchema, topicYearSchema } from "../shared/topics-schema";
import type {
  Discovery,
  LaunchRequest,
  Pipeline,
  PipelineRequest,
  Preview,
  Project,
  ProjectSettings,
  ProjectSettingsView,
  Run,
  Topic,
  TopicTaskDocument,
  TopicTaskRequest,
} from "../shared/types";
import { availableWorkflowPipelines } from "../shared/workflow-suggestions";
import {
  topicContextIdentitySchema,
  topicContextReadinessSchema,
  topicContextRefSchema,
  worktreeContextRef,
  type TopicContextIdentity,
  type TopicContextRef,
  type WorktreeRecord,
} from "../shared/worktrees";
import {
  listBuildFiles as browseBuildFiles,
  buildArgs,
  buildCapabilities,
  buildConfigurationSecrets,
  buildHomeEnvironment,
  buildReviewDefault,
  readBuildPlan as readPlan,
} from "./build";
import { createBuildRepeatSnapshot } from "./build-repeat";
import { CloneManager, type ContextDeletionPlan } from "./clones";
import {
  ContextExchangeManager,
  type BaseSnapshot,
  type PublicationSnapshot,
} from "./context-exchange";
import { ContextRunsStore } from "./context-runs-store";
import { ContextSyncManager } from "./context-sync";
import {
  deletionSwitchBranches,
  prepareDeletionSwitch,
  verifyDeletionSwitch,
  type DeletionSwitch,
} from "./deletion-branch-switch";
import {
  DesktopStateStore,
  validateProjectSettings,
  type ProjectSettingsDocument,
} from "./desktop-state";
import { DocumentDeletionTickets } from "./document-deletion";
import { GitBranchActions, type GitBranchContext } from "./git-branches";
import {
  assertStoppedRebaseOwnership,
  directory as conflictDirectory,
  regular as conflictRegular,
  stat as conflictStat,
  type StoppedRebaseConflictBinding,
} from "./git-conflict-state";
import { GitConflictReader, type GitConflictContext } from "./git-conflicts";
import { GitHistoryReader } from "./git-history-reader";
import { withTrustedGitIndex } from "./git-index-scope";
import type { GitMergeContext } from "./git-merge-safety";
import { preserveGitMergeCleanupError } from "./git-merge-safety";
import { NativeGitWorkspaceActions } from "./git-native-commit";
import { NativeGitConflictActions } from "./git-native-conflict-save";
import { createNativeGitCapability, nativeIntent } from "./git-native-context";
import { NativeGitDiscardActions } from "./git-native-discard";
import { NativeGitJournal } from "./git-native-journal";
import { NativeGitMergeOperations } from "./git-native-merge";
import { NativeGitSequenceAPI } from "./git-native-sequence-api";
import { fingerprintNativeGitControls } from "./git-native-state";
import type { GitUpdateAttemptInput } from "./git-native-update-handoff";
import {
  NativeGitUpdateHandoff,
  type NativeGitUpdateContext,
} from "./git-native-update-handoff";
import { type GitCommitContext } from "./git-workspace-actions";
import { GitWorkspaceReader } from "./git-workspace-reader";
import * as history from "./history";
import { HistoryPruner, type PruneAccess } from "./history-prune";
import {
  parseCard,
  parseCatalog,
  peekWorkflowProfile,
  pipelineArgs,
  workflowName,
} from "./parsers";
import { NodeRunner, watchDashboard, type Runner } from "./process";
import {
  assertContextEnvironment,
  childEnvironment,
} from "./process-environment";
import { parseDockerfile } from "./project-dockerfile";
import {
  listProjectPipelines,
  listProjectProfiles,
  listProjectTools,
  listProjectWorkflows,
  prepareSourceDeletion,
  readProjectDocument,
  saveProjectDocument,
} from "./project-documents";
import { assertReadActive, withOfflineGitReadScope } from "./read-scope";
import {
  RepositoryActions,
  repositoryActionFailure,
  sanitizeRepositoryLog,
} from "./repository-actions";
import { captureRunOutput } from "./run-output";
import { RunRecoveryManager } from "./run-recovery";
import {
  SettingsStore,
  atomicWrite,
  digest,
  noSymlinks,
  optionalText,
} from "./settings";
import type { PreparedShutdown } from "./shutdown";
import {
  prepareTerminalEnvironment,
  type TerminalLaunch,
  type TerminalSystem,
} from "./terminal-environment";
import type { TerminalSessions } from "./terminal-sessions";
import { readTopicTableDisplay, readTopicTaskOverview } from "./topic-display";
import { assertTopicTaskReady } from "./topic-readiness";
import {
  guardedProject,
  readCommittedTask,
  readWorkingTask,
  taskDocument,
  taskPath,
  validateTaskText,
} from "./topic-task";
import { TopicsDomain, readBranchChoices, type TopicsContext } from "./topics";
import { assertTopicBranchesAvailable } from "./worktree-topic-guards";
import { WorktreeManager } from "./worktrees";
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
  private selectionEpoch = 0;
  private buildRequests = new Map<string, BuildRequest>();
  private topicDomain = new TopicsDomain();
  private deletionTickets = new DocumentDeletionTickets();
  private historyPruner = new HistoryPruner();
  private gitUpdateHandoff = new NativeGitUpdateHandoff({
    context: (scope, action) => this.gitUpdateContext(scope, action),
  });
  private gitNativeSequence = new NativeGitSequenceAPI({
    context: (scope, action) => this.gitNativeSequenceContext(scope, action),
  });
  private gitMergeOperations = new NativeGitMergeOperations({
    context: (scope, action) => this.gitNativeSequenceContext(scope, action),
  });
  private gitBranches = new GitBranchActions({
    context: (id, action) => this.gitBranchContext(id, action),
  });
  private gitConflictActions = new NativeGitConflictActions({
    context: (scope, action) =>
      this.gitConflictSaveContext(scope, (context) =>
        action({
          ...context,
          // Host-only capability: canonicalize with pinned attributes in a private Git
          // context, never execute live repository filters or inherited configuration.
          isolatedGit: (args, stdin) =>
            this.runner.command(
              "git",
              args,
              context.root,
              {
                HOME: this.home,
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_ATTR_NOSYSTEM: "1",
                GIT_TERMINAL_PROMPT: "0",
                GIT_NO_LAZY_FETCH: "1",
                GIT_ALLOW_PROTOCOL: "",
              },
              stdin,
            ),
        }),
      ),
  });
  private gitActions = new NativeGitWorkspaceActions({
    context: (scope, action) => this.gitCommitContext(scope, action),
  });
  private personalSettings: SettingsStore;
  private gitDiscardActions: NativeGitDiscardActions;
  private trashItem?: TrashItem;
  private terminalLeases = new Map<string, number>();
  private operationTail: Promise<unknown> = Promise.resolve();
  private catalogEpoch = 0;
  private deleting = false;
  private nativeGitJournal: NativeGitJournal;
  private home: string;
  private dataDir: string;
  private goga: string;
  private runner: Runner;
  private state: DesktopStateStore;
  private context = new AsyncLocalStorage<{
    projectId: string;
    scopedProject: Project;
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
  private shutdownAdmission = false;
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
    this.nativeGitJournal = new NativeGitJournal({
      directory: path.join(this.home, ".goga", "desktop", "git-operations"),
    });
    this.personalSettings = options.settings ?? new SettingsStore(this.home);
    this.trashItem = options.trashItem;
    this.gitDiscardActions = new NativeGitDiscardActions({
      context: (scope, action) => this.gitCommitContext(scope, action),
      trashItem: this.trashItem,
    });
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
        scopedProject,
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
          throw preserveGitMergeCleanupError(error, message);
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
  /** Catalog identity only: no shell resolution, launch environment or automatic clone creation. */
  async resolveTerminalOwner(scope: ScopeRef): Promise<TerminalContext> {
    this.check();
    const parsed = this.parseScope(scope);
    return this.context.exit(() =>
      this.snapshot(parsed, async () => {
        // snapshot() already resolved the exact clone and checked ownership,
        // revision and effective Git paths. Repeating project()/validateBinding()
        // here performed that same discovery three times per read/show.
        const binding = this.context.getStore()?.binding;
        if (!binding)
          return {
            kind: "primary" as const,
            projectId: scopeProjectId(parsed),
          };
        const { revision: _, ...identity } = worktreeContextRef(binding);
        return { kind: "topic" as const, ...identity };
      }),
    );
  }
  async acquireTerminalContext(
    scope: ScopeRef,
    system: TerminalSystem = {},
  ): Promise<{ launch: TerminalLaunch; release: () => void }> {
    const parsed = this.parseScope(scope);
    return this.operation(async () => {
      this.check();
      const key =
        typeof parsed === "string" ? `primary:${parsed}` : parsed.contextId;
      this.terminalLeases.set(key, (this.terminalLeases.get(key) ?? 0) + 1);
      let released = false;
      let launch: TerminalLaunch | undefined;
      const release = () => {
        if (released) return;
        released = true;
        launch?.dispose?.();
        const count = (this.terminalLeases.get(key) ?? 1) - 1;
        if (count) this.terminalLeases.set(key, count);
        else this.terminalLeases.delete(key);
      };
      try {
        launch = await this.prepareTerminalLaunch(parsed, system);
        this.check();
        return { launch, release };
      } catch (error) {
        release();
        throw error;
      }
    });
  }
  /** Host-only launch preparation; env and root verification never cross renderer IPC. */
  async prepareTerminalLaunch(
    scope: ScopeRef,
    system: TerminalSystem = {},
  ): Promise<TerminalLaunch> {
    this.check();
    const parsed = this.parseScope(scope);
    const toContext = (ref: ScopeRef): TerminalContext => {
      if (typeof ref === "string") return { kind: "primary", projectId: ref };
      const { revision: _revision, ...identity } = ref;
      return { kind: "topic", ...identity };
    };
    let admitted = false;
    // Each resolution starts outside inherited pipeline snapshots; primary never inherits a topic.
    return prepareTerminalEnvironment(
      toContext(parsed),
      () =>
        this.context.exit(async () => {
          this.check();
          let current = parsed;
          if (admitted && typeof parsed !== "string") {
            const records = (await this.clones.list(parsed.projectId)).filter(
              (record) =>
                record.contextId === parsed.contextId &&
                record.projectId === parsed.projectId &&
                record.year === parsed.year &&
                record.topic === parsed.topic &&
                record.branch === parsed.branch &&
                !record.deletedAt,
            );
            if (records.length !== 1)
              throw Error("Владелец терминала недоступен.");
            current = worktreeContextRef(records[0]!);
          }
          const result = await this.snapshot(current, async () => {
            const project = await this.project(current);
            await this.validateBinding(project);
            const binding = this.binding(project);
            return {
              context: binding
                ? toContext(worktreeContextRef(binding))
                : toContext(project.id),
              root: this.root(project),
              env: this.context
                .getStore()!
                .document.value.env.map((row) => ({ ...row })),
            };
          });
          admitted = true;
          return result;
        }),
      { inherited: { ...process.env, HOME: this.home }, ...system },
    );
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
    verifyLaunchReadiness = false,
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
    // snapshot() already resolved this exact owner and its effective Git root.
    // Reuse that Project only for this read; every command and the final owner
    // resolution still check live paths. The launch path deliberately revalidates.
    const snapshot = this.context.getStore();
    const p =
      !verifyLaunchReadiness && snapshot?.projectId === request.projectId
        ? snapshot.scopedProject
        : await this.project(request.projectId);
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
    // Opening the editor needs a scoped task snapshot, not repeated full
    // readiness scans. The private launch path opts into those before writing.
    const readiness =
      taskOwner && verifyLaunchReadiness
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
    if (taskOwner && current !== taskOwner.branch)
      throw Error("Ветка рабочей копии изменилась. Выберите контекст заново.");
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
    const pending = records.some((r) => r.deletedAt)
      ? await this.clones.contextDeletionRecovery(id)
      : [];
    return records.filter(
      (r) =>
        !r.deletedAt ||
        pending.some((plan) => plan.owner.contextId === r.contextId),
    );
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
    const epoch = ++this.selectionEpoch;
    if (ref) await this.resolveTopicContext(ref);
    if (epoch === this.selectionEpoch) this.selectedContext = ref;
  }
  async syncTopicContext(input: TopicContextRef) {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    return this.operation(async () =>
      this.sync.request(await this.project(ref.projectId), ref),
    );
  }
  /** All resolution/object reads are offline; display never creates a clone. */
  private async gitWorkspaceRead<T>(
    scope: ScopeRef,
    read: (
      reader: GitWorkspaceReader,
      context: GitConflictContext,
    ) => Promise<T>,
  ): Promise<T> {
    const owner = this.parseScope(scope);
    // Do not install an admitted rebase owner into the general-purpose settings
    // ALS snapshot: nested launch/save/settings calls must use the strict resolver.
    return this.context.exit(() =>
      withOfflineGitReadScope(async () => {
        this.check();
        assertReadActive();
        const epoch = this.catalogEpoch;
        this.assertCatalog(epoch);
        const project = await this.project(scopeProjectId(owner));
        const document = await this.state.read(project.id);
        try {
          const admission =
            typeof owner === "string"
              ? undefined
              : await this.clones.resolveGitRead(owner);
          const binding = admission?.record;
          const root = binding?.path ?? project.path;
          const stoppedRebase = this.stoppedRebaseConflictBinding(admission);
          const verify = async () => {
            this.check();
            assertReadActive();
            this.assertCatalog(epoch);
            if (
              document.version !== (await this.state.read(project.id)).version
            )
              throw Error(
                "Настройки проекта изменились. Откройте изменения заново.",
              );
            const current = (await this.listProjects()).find(
              (p) => p.id === project.id,
            );
            if (
              !current ||
              current.path !== project.path ||
              root !== (await realpath(root))
            )
              throw Error(
                "Рабочая папка изменилась. Откройте изменения заново.",
              );
            if (binding && typeof owner !== "string") {
              if (binding.projectPath !== (await realpath(project.path)))
                throw Error(
                  "Основная папка проекта изменилась; подмена клона запрещена.",
                );
              // Match the ordinary resolver's effective-path check under the final
              // read environment, without its repairing CloneStore or write admission.
              const paths = (
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
                  root,
                  { HOME: this.home },
                )
              ).stdout
                .trim()
                .split("\n");
              const expected = [
                root,
                binding.gitCommonDir,
                binding.gitCommonDir,
                path.join(binding.gitCommonDir, "index"),
                path.join(binding.gitCommonDir, "objects"),
              ];
              if (
                paths.length !== expected.length ||
                paths.some((p, i) => path.resolve(root, p) !== expected[i])
              )
                throw Error("Эффективные пути Git не соответствуют контексту.");
              const fresh = await this.clones.resolveGitRead(owner);
              if (JSON.stringify(fresh) !== JSON.stringify(admission))
                throw Error(
                  "Владелец или операция Git изменились. Откройте изменения заново.",
                );
            }
            // Owner/object checks await Git processes; settings can change while
            // they run, so the final settings check belongs after them as well.
            if (
              document.version !== (await this.state.read(project.id)).version
            )
              throw Error(
                "Настройки проекта изменились. Откройте изменения заново.",
              );
            this.assertCatalog(epoch);
            assertStoppedRebaseOwnership(stoppedRebase);
            assertReadActive();
          };
          const git: GitConflictContext["git"] = async (args) => {
            assertReadActive();
            return this.runner.command("git", args, root, {
              HOME: this.home,
              GIT_TERMINAL_PROMPT: "0",
              GIT_NO_LAZY_FETCH: "1",
              GIT_ALLOW_PROTOCOL: "",
            });
          };
          const reader = new GitWorkspaceReader({
            scope: owner,
            root,
            verify,
            git: async (args) => (await git(args)).stdout,
          });
          await verify();
          const result = await read(reader, {
            ...(stoppedRebase ? { stoppedRebase } : {}),
            scope: owner,
            root,
            verify,
            git,
            ownerKey: JSON.stringify([
              owner,
              root,
              document.version,
              binding?.gitCommonDir,
            ]),
            snapshot: () => reader.snapshot(),
          });
          await verify();
          assertReadActive();
          return result;
        } catch (error) {
          let message =
            error instanceof Error ? error.message : "Чтение Git не выполнено";
          for (const entry of document.value.env)
            if (entry.value)
              message = message.split(entry.value).join("[скрыто]");
          throw Error(message);
        }
      }),
    );
  }
  private gitHistoryRead<T>(
    scope: ScopeRef,
    read: (reader: GitHistoryReader) => Promise<T>,
  ): Promise<T> {
    return this.gitWorkspaceRead(scope, (_workspace, context) =>
      read(
        new GitHistoryReader({
          scope: context.scope,
          root: context.root,
          verify: context.verify,
          git: async (args) => (await context.git(args)).stdout,
        }),
      ),
    );
  }
  async readGitHistoryRefs(scope: ScopeRef) {
    return this.gitHistoryRead(scope, (reader) => reader.refs());
  }
  async readGitHistory(input: GitHistoryRequest) {
    const request = gitHistoryRequestSchema.parse(input);
    return this.gitHistoryRead(request.scope, (reader) => reader.page(request));
  }
  async readGitCommit(input: GitCommitReadRequest) {
    const request = gitCommitReadRequestSchema.parse(input);
    return this.gitHistoryRead(request.scope, (reader) =>
      reader.commit(request),
    );
  }
  async readGitCommitDiff(input: GitCommitDiffRequest) {
    const request = gitCommitDiffRequestSchema.parse(input);
    return this.gitHistoryRead(request.scope, (reader) => reader.diff(request));
  }
  async readGitSummary(scope: ScopeRef): Promise<GitWorkspaceSummary> {
    return this.gitWorkspaceRead(scope, (reader) => reader.summary());
  }
  async readGitWorkspace(scope: ScopeRef): Promise<GitWorkspaceSnapshot> {
    return this.gitWorkspaceRead(scope, (reader) => reader.snapshot());
  }
  async readGitDiff(input: GitDiffRequest): Promise<GitWorkspaceDiff> {
    const request = gitDiffRequestSchema.parse(input);
    return this.gitWorkspaceRead(request.scope, (reader) =>
      reader.diff(request),
    );
  }
  async readGitConflict(
    input: GitConflictReadRequest,
  ): Promise<GitConflictDocument> {
    const request = gitConflictReadRequestSchema.parse(input);
    return new GitConflictReader({
      context: (scope, read) =>
        this.gitWorkspaceRead(scope, (_reader, context) => read(context)),
    }).read(request);
  }
  private stoppedRebaseConflictBinding(
    admission: Awaited<ReturnType<CloneManager["resolveGitRead"]>> | undefined,
  ): StoppedRebaseConflictBinding | undefined {
    if (!admission?.operationBinding) return undefined;
    const head = conflictRegular(
      path.join(admission.record.gitCommonDir, "HEAD"),
    )?.bytes.toString("utf8");
    if (!head || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n$/.test(head))
      throw Error("HEAD остановленного rebase изменился.");
    const ownership = [
      path.join(
        this.clones.store.root,
        `.owner-${admission.record.contextId}.json`,
      ),
      path.join(admission.record.gitCommonDir, "desktop-owner.json"),
    ].map((file) => {
      const parent = conflictDirectory(path.dirname(file));
      const value = conflictRegular(file, 4096);
      if (!value || conflictDirectory(path.dirname(file)) !== parent)
        throw Error("Владение остановленным rebase изменилось.");
      return Object.freeze([file, value.identity] as const);
    });
    return Object.freeze({
      kind: "stopped-linear-rebase",
      proof: admission.operationBinding,
      head: head.trim(),
      ownership: Object.freeze(ownership),
    });
  }
  /** Conflict-file writes use the same physical owner admission as native
   * continuation. The stopped-operation seal is checked separately on every
   * verification; no cached cross-request authority or repeated clone resolver. */
  private async gitConflictSaveContext<T>(
    scope: ScopeRef,
    action: (
      context: GitCommitContext & {
        stoppedRebase?: StoppedRebaseConflictBinding;
      },
    ) => Promise<T>,
  ): Promise<T> {
    return this.gitNativeSequenceContext(scope, async (context) => {
      const owner = context.scope;
      const admission =
        typeof owner === "string"
          ? undefined
          : await this.clones.resolveGitRead(owner);
      if (admission && admission.record.path !== context.root)
        throw Error("Рабочая папка конфликта не соответствует владельцу.");
      const settings = await this.state.read(scopeProjectId(owner));
      const stoppedRebase = this.stoppedRebaseConflictBinding(admission);
      const controls = await fingerprintNativeGitControls(context.root);
      const verify = async () => {
        await context.verify();
        assertStoppedRebaseOwnership(stoppedRebase);
        if (controls !== (await fingerprintNativeGitControls(context.root)))
          throw Error("Операция Git изменилась. Откройте конфликт заново.");
      };
      await verify();
      const result = await action({
        ...context,
        stoppedRebase,
        verify,
        ownerKey: JSON.stringify([
          owner,
          context.root,
          settings.version,
          admission?.record.gitCommonDir,
        ]),
        git: (args, options) =>
          options?.indexFile
            ? withTrustedGitIndex(options.indexFile, () =>
                context.git(args, options.stdin),
              )
            : context.git(args, options?.stdin),
      });
      if (
        result &&
        typeof result === "object" &&
        "log" in result &&
        "message" in result
      )
        return {
          ...result,
          log: context.sanitizeDiagnostics!(String(result.log)),
          message: context.sanitizeDiagnostics!(String(result.message)),
        };
      return result;
    });
  }
  /** Fresh scoped settings/owner admission spans the entire action, never a stale closure. */
  private nativeCloneOwnerProof(binding?: WorktreeRecord) {
    if (!binding) return [];
    if (!binding.sourceCommonDir) throw Error("Источник клона не подтверждён.");
    return [
      ...[
        path.join(this.clones.store.root, `.owner-${binding.contextId}.json`),
        path.join(binding.gitCommonDir, "desktop-owner.json"),
      ].map((file) => {
        const value = conflictRegular(file, 4096);
        if (!value) throw Error("Владение клоном не подтверждено.");
        return ["file", file, value.identity];
      }),
      // Bind source redirection as opaque filesystem identity, not parsed Git
      // formats. Repeated owner checks must detect topology changes before a
      // publication, not only during the final Git-based clone validation.
      ...[
        path.join(binding.projectPath, ".git"),
        ...["commondir", "gitdir", "objects/info/alternates", "objects/info/http-alternates"]
          .map((name) => path.join(binding.sourceCommonDir!, name)),
      ].map((file) => [
        "source-topology", file,
        conflictStat(file)?.isDirectory()
          ? conflictDirectory(file)
          : conflictRegular(file, 65536)?.identity ?? "missing",
      ]),
      ...[binding.projectPath, binding.sourceCommonDir].map((dir) => [
        "directory",
        dir,
        conflictDirectory(dir),
      ]),
    ];
  }
  /** Narrow native-operation context. Physical clone admission is deliberately
   * separate from branch/launch admission; only the engine's durable receipt
   * can authorize a detached continuation. Never install it into settings ALS. */
  private async gitNativeSequenceContext<T>(
    scope: ScopeRef,
    action: (context: GitMergeContext) => Promise<T>,
    readOnlyProbe = false,
  ): Promise<T> {
    const owner = this.parseScope(scope);
    return this.context.exit(() =>
      withOfflineGitReadScope(async () => {
        // Goga capture/refusal probes run under the caller's mutation mutex.
        // They share physical native admission, but never acquire another lock.
        const admit = async () => {
          const binding =
            typeof owner === "string"
              ? undefined
              : await this.clones.resolveNativeOperationOwner(owner);
          let completed: T | undefined;
          let actionFailure: unknown;
          let sanitize = (v: string) => sanitizeRepositoryLog(v);
          const run = async () => {
            if (
              binding &&
              typeof owner !== "string" &&
              JSON.stringify(
                await this.clones.resolveNativeOperationOwner(owner),
              ) !== JSON.stringify(binding)
            )
              throw Error("Владелец клона изменился.");
            const epoch = this.catalogEpoch;
            const project = await this.project(scopeProjectId(owner));
            const settings = await this.state.read(project.id);
            const root = binding?.path ?? (await realpath(project.path));
            const ownership = () => this.nativeCloneOwnerProof(binding);
            const physicalOwner = ownership();
            const verify = async () => {
              this.check();
              assertReadActive();
              this.assertCatalog(epoch);
              const current = (await this.listProjects()).find(
                (p) => p.id === project.id,
              );
              if (
                !current ||
                current.path !== project.path ||
                root !== (await realpath(root)) ||
                settings.version !== (await this.state.read(project.id)).version
              )
                throw Error(
                  "Владелец или настройки операции изменились. Повторите предпросмотр.",
                );
              if (binding && typeof owner !== "string") {
                if (
                  binding.projectPath !== (await realpath(project.path)) ||
                  JSON.stringify(await ownership()) !==
                    JSON.stringify(physicalOwner)
                )
                  throw Error(
                    "Владелец клона изменился; переход в основной проект запрещён.",
                  );
                await this.clones.assertNativeOperationOwnerRecord(binding);
              }
              this.assertCatalog(epoch);
              if (
                settings.version !== (await this.state.read(project.id)).version
              )
                throw Error("Настройки операции изменились.");
            };
            const native = createNativeGitCapability({
              root,
              runner: this.runner,
              journal: this.nativeGitJournal,
              env: { HOME: this.home },
              owner: async () => {
                await verify();
                return {
                  scope: owner,
                  projectPath: await realpath(project.path),
                  registryRevision: nativeIntent([
                    settings.version,
                    binding ? worktreeContextRef(binding) : null,
                    ...(binding ? [physicalOwner] : []),
                  ]),
                };
              },
            });
            const git: GitMergeContext["git"] = (args, stdin) =>
              this.runner.command(
                "git",
                args,
                root,
                {
                  HOME: this.home,
                  GIT_TERMINAL_PROMPT: "0",
                  GIT_NO_LAZY_FETCH: "1",
                  GIT_ALLOW_PROTOCOL: "",
                },
                stdin,
              );
            const reader = new GitWorkspaceReader({
              scope: owner,
              root,
              verify,
              git: async (args) => (await git(args)).stdout,
            });
            sanitize = (value: string) =>
              sanitizeRepositoryLog(
                value,
                settings.value.env.map((r) => r.value).filter(Boolean),
              );
            await verify();
            try {
              const value = await action({
                scope: owner,
                root,
                ownerKey: nativeIntent([
                  owner,
                  root,
                  settings.version,
                  physicalOwner,
                ]),
                verify,
                git,
                native,
                snapshot: () => reader.snapshot(),
                sanitizeDiagnostics: sanitize,
              });
              completed = value;
              await verify();
              if (
                binding &&
                typeof owner !== "string" &&
                JSON.stringify(
                  await this.clones.resolveNativeOperationOwner(owner),
                ) !== JSON.stringify(binding)
              )
                throw Error("Владелец клона изменился после операции.");
              return value;
            } catch (error) {
              actionFailure = error;
              throw preserveGitMergeCleanupError(
                error,
                sanitize(
                  error instanceof Error ? error.message : String(error),
                ),
              );
            }
          };
          try {
            return await (binding && !readOnlyProbe
              ? this.clones.store.withRepositoryLock(
                  binding.repositoryKey,
                  run,
                  { existingOnly: true },
                )
              : run());
          } catch (error) {
            if (
              completed &&
              typeof completed === "object" &&
              "log" in completed &&
              ("outcome" in completed || "status" in completed)
            ) {
              return {
                ...completed,
                ...("outcome" in completed
                  ? { outcome: "uncertain" }
                  : { status: "uncertain" }),
                log: sanitize(
                  String(completed.log) +
                    "\nИтоговая проверка владельца/служебной блокировки не пройдена: " +
                    (error instanceof Error ? error.message : String(error)),
                ),
              } as T;
            }
            // A finally/release failure must not erase the original action
            // failure. Both diagnostics pass through the same secret filter.
            const describe = (value: unknown) =>
              value instanceof Error ? value.message : String(value);
            throw preserveGitMergeCleanupError(
              error,
              sanitize(
                actionFailure && describe(actionFailure) !== describe(error)
                  ? `${describe(actionFailure)}\n${describe(error)}`
                  : describe(error),
              ),
            );
          }
        };
        return readOnlyProbe
          ? admit()
          : this.exclusive(scopeProjectId(owner), admit);
      }),
    );
  }
  private async gitCommitContext<T>(
    scope: ScopeRef,
    action: (context: GitCommitContext) => Promise<T>,
  ): Promise<T> {
    const owner = this.parseScope(scope);
    return this.context.exit(() =>
      withOfflineGitReadScope(() =>
        this.exclusive(scopeProjectId(owner), () =>
          this.snapshot(
            owner,
            async () => {
              this.check();
              assertReadActive();
              const project = this.context.getStore()!.scopedProject;
              const settings = this.context.getStore()!;
              const binding = this.binding(project);
              const root = await realpath(this.root(project));
              const secrets = settings.document.value.env
                .map((row) => row.value)
                .filter(Boolean);
              const physicalOwner = this.nativeCloneOwnerProof(binding);
              const verify = async () => {
                this.check();
                assertReadActive();
                await this.assertSettings(project.id);
                this.assertCatalog(settings.catalogEpoch);
                const current = (await this.listProjects()).find(
                  (p) => p.id === project.id,
                );
                if (
                  !current ||
                  current.path !== project.path ||
                  root !== (await realpath(this.root(project)))
                )
                  throw Error(
                    "Рабочая папка изменилась. Повторите предпросмотр коммита.",
                  );
                if (binding) {
                  // The repository lifecycle lock below is not reentrant: validate the
                  // captured record directly instead of calling resolve() under it.
                  const row = (await this.clones.store.read()).records.find(
                    (r) => r.contextId === binding.contextId,
                  );
                  if (
                    !row ||
                    row.state !== "ready" ||
                    row.storageKind !== "clone" ||
                    row.ownership !== "managed" ||
                    row.path !== binding.path ||
                    row.projectPath !== binding.projectPath ||
                    row.gitCommonDir !== binding.gitCommonDir ||
                    JSON.stringify(worktreeContextRef(row)) !==
                      JSON.stringify(worktreeContextRef(binding))
                  )
                    throw Error(
                      "Владелец клона изменился. Коммит в основной папке запрещён.",
                    );
                  await this.clones.store.assertOwned(row);
                  if (
                    JSON.stringify(this.nativeCloneOwnerProof(binding)) !==
                    JSON.stringify(physicalOwner)
                  )
                    throw Error("Физический владелец клона изменился.");
                }
              };
              const git: GitCommitContext["git"] = (args, options) => {
                const run = () =>
                  this.runner.command(
                    "git",
                    args,
                    root,
                    {
                      HOME: this.home,
                      GIT_TERMINAL_PROMPT: "0",
                      GIT_NO_LAZY_FETCH: "1",
                      GIT_ALLOW_PROTOCOL: "",
                    },
                    options?.stdin,
                  );
                return options?.indexFile
                  ? withTrustedGitIndex(options.indexFile, run)
                  : run();
              };
              const run = async () => {
                await verify();
                await this.nativeGitJournal.assertAdmission(root, {
                  scope: owner,
                  registryRevision: nativeIntent([
                    settings.document.version,
                    binding ? worktreeContextRef(binding) : null,
                    ...(binding ? [physicalOwner] : []),
                  ]),
                  projectPath: await realpath(project.path),
                });
                const reader = new GitWorkspaceReader({
                  scope: owner,
                  root,
                  verify,
                  git: async (args) => (await git(args)).stdout,
                });
                try {
                  const result = await action({
                    scope: owner,
                    root,
                    ownerKey: JSON.stringify([
                      owner,
                      root,
                      settings.document.version,
                      binding?.gitCommonDir,
                    ]),
                    verify,
                    git,
                    native: createNativeGitCapability({
                      root,
                      runner: this.runner,
                      journal: this.nativeGitJournal,
                      env: { HOME: this.home },
                      owner: async () => {
                        await verify();
                        return {
                          scope: owner,
                          registryRevision: nativeIntent([
                            settings.document.version,
                            binding ? worktreeContextRef(binding) : null,
                            ...(binding ? [physicalOwner] : []),
                          ]),
                          projectPath: await realpath(project.path),
                        };
                      },
                    }),
                    snapshot: async () => {
                      const value = await reader.snapshot();
                      if (binding && value.branch !== binding.branch)
                        throw Error(
                          "Ветка клона изменилась. Повторите предпросмотр коммита.",
                        );
                      return value;
                    },
                  });
                  // Only operation diagnostics, not user-authored content or identity,
                  // are sanitized here. The generic context can also return previews.
                  if (
                    result &&
                    typeof result === "object" &&
                    "log" in result &&
                    "message" in result
                  )
                    return {
                      ...result,
                      log: sanitizeRepositoryLog(String(result.log), secrets),
                      message: sanitizeRepositoryLog(
                        String(result.message),
                        secrets,
                      ),
                    };
                  return result;
                } catch (error) {
                  throw preserveGitMergeCleanupError(
                    error,
                    sanitizeRepositoryLog(
                      error instanceof Error
                        ? error.message
                        : "Не удалось выполнить операцию Git.",
                      secrets,
                    ),
                  );
                }
              };
              return binding
                ? this.clones.store.withRepositoryLock(
                    binding.repositoryKey,
                    run,
                    { existingOnly: true },
                  )
                : run();
            },
            false,
          ),
        ),
      ),
    );
  }
  /** Branch authority is always the original project. Local probes remain offline;
   * only the explicit, validated fetch step receives an online transport. */
  private async gitBranchContext<T>(
    input: string,
    action: (context: GitBranchContext) => Promise<T>,
  ): Promise<T> {
    const id = gitBranchProjectSchema.parse(input);
    return this.context.exit(() =>
      this.exclusive(id, () =>
        this.snapshot(
          id,
          async () => {
            const settings = this.context.getStore()!;
            const project = settings.scopedProject;
            if (this.binding(project))
              throw Error("Управление ветками доступно только без топика.");
            const root = await realpath(this.root(project));
            const secrets = settings.document.value.env
              .map((row) => row.value)
              .filter(Boolean);
            const verify = async () => {
              this.check();
              assertReadActive();
              await this.assertSettings(id);
              this.assertCatalog(settings.catalogEpoch);
              const current = (await this.listProjects()).find(
                (p) => p.id === id,
              );
              if (
                !current ||
                current.path !== project.path ||
                (await realpath(this.root(current))) !== root
              )
                throw Error(
                  "Рабочая папка изменилась. Повторите предпросмотр операции.",
                );
            };
            const git: GitBranchContext["git"] = (args, stdin) =>
              withOfflineGitReadScope(() =>
                this.runner.command(
                  "git",
                  args,
                  root,
                  {
                    HOME: this.home,
                    GIT_TERMINAL_PROMPT: "0",
                    GIT_NO_LAZY_FETCH: "1",
                    GIT_ALLOW_PROTOCOL: "",
                  },
                  stdin,
                ),
              );
            const reader = new GitWorkspaceReader({
              scope: id,
              root,
              verify,
              git: async (args) => (await git(args)).stdout,
            });
            try {
              await verify();
              const result = await action({
                scope: id,
                root,
                ownerKey: JSON.stringify([id, root, settings.document.version]),
                verify,
                git,
                native: createNativeGitCapability({
                  root,
                  runner: this.runner,
                  journal: this.nativeGitJournal,
                  env: { HOME: this.home },
                  owner: async () => {
                    await verify();
                    return {
                      scope: id,
                      registryRevision: nativeIntent([
                        settings.document.version,
                        null,
                      ]),
                      projectPath: await realpath(project.path),
                    };
                  },
                }),
                sanitizeDiagnostics: (value) =>
                  sanitizeRepositoryLog(value, secrets),
                privateGit: (args, indexFile) =>
                  withTrustedGitIndex(indexFile, () => git(args)),
                remoteGit: (args) =>
                  this.runner.command("git", args, root, {
                    HOME: this.home,
                    GIT_TERMINAL_PROMPT: "0",
                    GIT_NO_LAZY_FETCH: "1",
                  }),
                snapshot: () => reader.snapshot(),
              });
              if (
                result &&
                typeof result === "object" &&
                "log" in result &&
                "message" in result
              )
                return {
                  ...result,
                  log: sanitizeRepositoryLog(String(result.log), secrets),
                  message: sanitizeRepositoryLog(
                    String(result.message),
                    secrets,
                  ),
                };
              return result;
            } catch (error) {
              throw preserveGitMergeCleanupError(
                error,
                sanitizeRepositoryLog(
                  error instanceof Error
                    ? error.message
                    : "Не удалось выполнить операцию Git.",
                  secrets,
                ),
              );
            }
          },
          false,
        ),
      ),
    );
  }
  async readGitBranches(projectId: string) {
    return this.gitBranches.inventory(gitBranchProjectSchema.parse(projectId));
  }
  async prepareGitBranch(request: GitBranchRequest) {
    return this.gitBranches.prepare(gitBranchRequestSchema.parse(request));
  }
  async executeGitBranch(input: string) {
    this.assertLaunchAllowed();
    const token = gitBranchTokenSchema.parse(input);
    return this.operation(() => this.gitBranches.execute(token));
  }
  async prepareGitConflictSave(input: GitConflictSaveRequest) {
    return this.gitConflictActions.prepare(
      gitConflictSaveRequestSchema.parse(input),
    );
  }
  async executeGitConflictSave(input: string) {
    this.assertLaunchAllowed();
    const token = gitConflictSaveTokenSchema.parse(input);
    return this.operation(() => this.gitConflictActions.execute(token));
  }
  async prepareGitRebaseOperation(input: GitRebaseOperationRequest) {
    return this.gitNativeSequence.prepareRebase(
      gitRebaseOperationRequestSchema.parse(input),
    );
  }
  async executeGitRebaseOperation(input: string) {
    this.assertLaunchAllowed();
    const token = gitRebaseOperationTokenSchema.parse(input);
    return this.operation(() => this.gitNativeSequence.executeRebase(token));
  }
  private async updateHandoffContext(
    context: GitCommitContext,
  ): Promise<NativeGitUpdateContext> {
    const project = await this.project(scopeProjectId(context.scope));
    const document = await this.state.read(project.id),
      value = document.value;
    if (typeof context.scope !== "string") assertContextEnvironment(value.env);
    const binding =
      typeof context.scope === "string"
        ? undefined
        : await this.clones.resolveNativeOperationOwner(context.scope);
    const physicalOwner = this.nativeCloneOwnerProof(binding);
    const native =
      context.native ??
      createNativeGitCapability({
        root: context.root,
        runner: this.runner,
        journal: this.nativeGitJournal,
        env: { HOME: this.home },
        owner: async () => {
          await context.verify();
          if (
            JSON.stringify(this.nativeCloneOwnerProof(binding)) !==
            JSON.stringify(physicalOwner)
          )
            throw Error("Владелец клона изменился.");
          return {
            scope: context.scope,
            projectPath: await realpath(project.path),
            registryRevision: nativeIntent([
              document.version,
              binding ? worktreeContextRef(binding) : null,
              ...(binding ? [physicalOwner] : []),
            ]),
          };
        },
      });
    const env = Object.fromEntries(
      value.env.map((entry) => [entry.key, entry.value]),
    );
    const executable =
      value.executable === "goga" ? this.goga : value.executable;
    return {
      ...context,
      native,
      topicsConfig: async () => {
        await context.verify();
        const output = await this.runner.command(
          executable,
          ["config", "topics"],
          context.root,
          env,
        );
        await context.verify();
        return output.stdout;
      },
    };
  }
  private gitUpdateContext<T>(
    scope: ScopeRef,
    action: (context: NativeGitUpdateContext) => Promise<T>,
    readOnlyProbe = false,
  ): Promise<T> {
    return this.gitNativeSequenceContext(
      scope,
      async (c) =>
        action(
          await this.updateHandoffContext({
            ...c,
            git: (args, options) => c.git(args, options?.stdin),
          }),
        ),
      readOnlyProbe,
    );
  }
  /** Capture and refusal probes are read-only and never re-enter the mutation
   * mutex held by the caller. Goga itself runs outside that offline read scope. */
  private async invokeUpdateWithHandoff<T>(
    scope: ScopeRef,
    input: GitUpdateAttemptInput,
    invoke: () => Promise<T>,
    offer: (candidate: GitUpdateHandoffCandidate) => void,
  ): Promise<T> {
    let attempt: object | undefined;
    try {
      attempt = await this.gitUpdateContext(
        scope,
        async (context) => {
          if (
            (
              await context.git(["symbolic-ref", "--quiet", "--short", "HEAD"])
            ).stdout.trim() !== input.targetBranch
          )
            throw Error("Топик не является текущей веткой этого контекста.");
          const sourceRef = (
            await context.git([
              "rev-parse",
              "--symbolic-full-name",
              "--verify",
              input.sourceRef,
            ])
          ).stdout.trim();
          if (
            !/^refs\/(heads|remotes|desktop)\//.test(sourceRef) ||
            sourceRef.includes("\n")
          )
            throw Error("Источник не является прямой веткой.");
          return this.gitUpdateHandoff.captureAttempt(context, {
            ...input,
            sourceRef,
          });
        },
        true,
      );
    } catch {
      // Ineligible/unsupported handoff does not disable the ordinary Goga path.
    }
    try {
      return await invoke();
    } catch (error) {
      if (attempt) {
        try {
          const candidate = await this.gitUpdateContext(
            scope,
            (context) =>
              this.gitUpdateHandoff.afterFailure(context, attempt!, error),
            true,
          );
          if (candidate) offer(candidate);
        } catch {
          /* Keep the original failure; never infer authority from its text. */
        }
      }
      throw error;
    }
  }
  async prepareGitUpdateHandoff(input: GitUpdateHandoffRequest) {
    return this.gitUpdateHandoff.prepare(
      gitUpdateHandoffRequestSchema.parse(input),
    );
  }
  async executeGitUpdateHandoff(input: string) {
    this.assertLaunchAllowed();
    const token = gitUpdateHandoffTokenSchema.parse(input);
    return this.operation(() => this.gitUpdateHandoff.execute(token));
  }
  async prepareGitSequencerOperation(input: GitSequencerOperationRequest) {
    return this.gitNativeSequence.prepareSequencer(
      gitSequencerOperationRequestSchema.parse(input),
    );
  }
  async executeGitSequencerOperation(input: string) {
    this.assertLaunchAllowed();
    const token = gitSequencerOperationTokenSchema.parse(input);
    return this.operation(() => this.gitNativeSequence.executeSequencer(token));
  }
  async prepareGitMergeOperation(input: GitMergeOperationRequest) {
    return this.gitMergeOperations.prepare(
      gitMergeOperationRequestSchema.parse(input),
    );
  }
  async executeGitMergeOperation(input: string) {
    this.assertLaunchAllowed();
    const token = gitMergeOperationTokenSchema.parse(input);
    return this.operation(() => this.gitMergeOperations.execute(token));
  }
  async prepareGitDiscard(input: GitDiscardRequest) {
    return this.gitDiscardActions.prepare(gitDiscardRequestSchema.parse(input));
  }
  async executeGitDiscard(input: string) {
    this.assertLaunchAllowed();
    const token = gitDiscardTokenSchema.parse(input);
    return this.operation(() => this.gitDiscardActions.execute(token));
  }
  async prepareGitCommit(input: GitCommitRequest) {
    return this.gitActions.prepare(gitCommitRequestSchema.parse(input));
  }
  async executeGitCommit(input: string) {
    this.assertLaunchAllowed();
    const token = gitCommitTokenSchema.parse(input);
    return this.operation(() => this.gitActions.execute(token));
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
              const scoped = await this.project(
                request.context ?? request.projectId,
              );
              const call = this.invocation(scoped);
              secrets = call.value.env
                .map((entry) => entry.value)
                .filter(Boolean);
              let handoff: GitUpdateHandoffCandidate | undefined;
              const invokeGoga = async (args: string[]) => {
                this.check();
                await this.assertSettings(request.projectId);
                await this.validateBinding(scoped);
                return this.runner.command(
                  call.executable,
                  args,
                  this.root(scoped),
                  call.env,
                );
              };
              const actions = new RepositoryActions({
                project: async () => {
                  this.check();
                  const project = (await this.listProjects()).find(
                    (p) => p.id === request.projectId,
                  );
                  if (!project) throw Error("Неизвестный проект.");
                  return project;
                },
                resolve: (ref) => this.resolveTopicContext(ref),
                inventory: () => this.clones.list(request.projectId),
                sync: (project, ref, onDiagnostic) =>
                  this.sync.request(
                    project,
                    ref,
                    "manual",
                    undefined,
                    false,
                    onDiagnostic,
                  ),
                verify: async () => {
                  this.check();
                  await this.assertSettings(request.projectId);
                  this.assertCatalog(this.context.getStore()!.catalogEpoch);
                },
                git: (args, cwd) =>
                  this.runner.command(
                    "git",
                    args,
                    cwd,
                    childEnvironment(process.env, {
                      HOME: this.home,
                      GIT_TERMINAL_PROMPT: "0",
                    }),
                  ),
                goga: invokeGoga,
                gogaUpdate: (args, input) =>
                  this.invokeUpdateWithHandoff(
                    request.context ?? request.projectId,
                    input,
                    () => invokeGoga(args),
                    (candidate) => {
                      handoff = candidate;
                    },
                  ),
                gogaOriginal: async (args) => {
                  this.check();
                  await this.assertSettings(request.projectId);
                  await this.validateBinding(scoped);
                  this.assertCatalog(this.context.getStore()!.catalogEpoch);
                  // Project.path is the captured original; root(scoped) would select the clone.
                  return this.runner.command(
                    call.executable,
                    args,
                    scoped.path,
                    call.env,
                  );
                },
                secrets,
              });
              const result = await actions.run(request);
              return {
                ...result,
                ...(handoff && result.status === "error" ? { handoff } : {}),
              };
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
  private terminalDeletion?: Pick<
    TerminalSessions,
    "inspectIdleContext" | "prepareContextDeletion"
  >;
  /** Main-process wiring only; never exposed through IPC. */
  setTerminalDeletionController(
    controller: NonNullable<HostService["terminalDeletion"]>,
  ) {
    if (this.terminalDeletion && this.terminalDeletion !== controller)
      throw Error("Терминальный контроллер уже установлен.");
    this.terminalDeletion = controller;
  }
  private terminalDeletionBlocked(scope: ScopeRef): boolean {
    const key =
      typeof scope === "string" ? `primary:${scope}` : scope.contextId;
    const leases = this.terminalLeases.get(key) ?? 0;
    if (!leases) return false;
    // Unknown/starting leases must not be mistaken for safely idle sessions.
    return (
      !this.terminalDeletion ||
      this.terminalDeletion.inspectIdleContext(scope) !== leases
    );
  }
  private deletionGuards(ref: TopicContextRef) {
    return {
      active:
        this.contextActive(ref.contextId) || this.terminalDeletionBlocked(ref),
      current: this.selectedContext?.contextId === ref.contextId,
    };
  }
  private contextDeletionPreview(
    plan: ContextDeletionPlan,
  ): ContextDeletionPreview {
    return {
      token: plan.token,
      contextId: plan.owner.contextId,
      stage: plan.stage,
      switchBranch: plan.primarySwitch?.to,
      clonePath: plan.path,
      aheadCount: plan.aheadCount,
      requiresAheadConfirmation:
        plan.stage === "prepared" && plan.aheadCount > 0,
      details: [
        ...(plan.primarySwitch
          ? [
              `После перехода в «Без топика» основная папка будет переключена с «${plan.primarySwitch.from}» на «${plan.primarySwitch.to}» без force, затем Goga удалит топик.`,
            ]
          : []),
        "Простаивающие сессии этого топика будут закрыты. Выполняющиеся команды блокируют удаление; сессии других контекстов сохраняются.",
        "Рабочая копия целиком, включая .git, будет перемещена в системную Корзину.",
        "После переключения в основную папку Goga удалит топик. Основная папка и внешние рабочие копии не удаляются.",
        "Незакоммиченные, неотслеживаемые и ignored-файлы блокируют удаление. Архивные refs, синхронизация и публикация не создаются.",
      ],
    };
  }
  async contextDeletionRecovery(
    input: TopicContextRef,
  ): Promise<ContextDeletionPreview | null> {
    this.check();
    const ref = topicContextRefSchema.parse(input);
    const project = await this.project(ref.projectId);
    const owned = (p: { owner: TopicContextRef; projectPath: string }) =>
      p.owner.contextId === ref.contextId &&
      p.owner.projectId === ref.projectId &&
      p.owner.year === ref.year &&
      p.owner.topic === ref.topic &&
      p.owner.branch === ref.branch &&
      p.projectPath === project.path;
    const legacyPlans = await this.clones.deletionRecovery(ref.projectId);
    if (
      legacyPlans.some(
        (p) => owned(p) && (p.stage !== "prepared" || p.expiresAt > Date.now()),
      )
    )
      throw Error(
        "Найден старый журнал archive-first. Требуется ручная проверка; новый порядок удаления к нему не применяется.",
      );
    const plans = (await this.clones.contextDeletionRecovery(ref.projectId))
      .filter(
        (p) => owned(p) && (p.stage !== "prepared" || p.expiresAt > Date.now()),
      )
      .sort((a, b) => b.expiresAt - a.expiresAt);
    return plans[0] ? this.contextDeletionPreview(plans[0]) : null;
  }
  /** Preview the actual native operation before any clone loss. The exemption is
   * host-created and scoped to one exact registry owner/revision, never IPC input. */
  private async contextTopicDeletion(
    plan: Pick<
      ContextDeletionPlan,
      "owner" | "projectPath" | "recordRevision"
    > &
      Partial<
        Pick<
          ContextDeletionPlan,
          "primaryHead" | "primaryTopicAbsent" | "primarySwitch"
        >
      >,
    execute = false,
    beforeExecute?: () => Promise<void>,
    beforeMutation?: () => void,
  ) {
    return this.snapshot(
      plan.owner.projectId,
      async () => {
        const project = await this.project(plan.owner.projectId);
        if (project.path !== plan.projectPath)
          throw Error("Основная папка проекта изменилась.");
        const d = await this.topicsContext(
          plan.owner.projectId,
          {
            owner: plan.owner,
            revision: plan.recordRevision,
          },
          execute ? beforeMutation : undefined,
        );
        if (
          d.active() ||
          (plan.primarySwitch &&
            this.terminalDeletionBlocked(plan.owner.projectId))
        )
          throw Error("Основная папка занята.");
        if (!execute && plan.primarySwitch) {
          await verifyDeletionSwitch(
            d.git,
            plan.projectPath,
            plan.primarySwitch,
          );
          d.deletionSwitchFrom = plan.primarySwitch.from;
          // Permit only this primary checkout during the read-only preview;
          // any foreign worktree still blocks deletion.
          d.assertBranchesAvailable = (branches) =>
            assertTopicBranchesAvailable(
              d.git,
              plan.projectPath,
              branches,
              "update",
            );
        }
        const refs = (
          await d.git([
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
          ])
        )
          .split("\n")
          .filter(Boolean);
        const normalize = (name: string) =>
          name
            .toLowerCase()
            .replace(/[^\x00-\x7f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
        if (
          refs.some(
            (ref) =>
              ref.startsWith("refs/remotes/origin/") &&
              normalize(ref.slice("refs/remotes/origin/".length)) ===
                plan.owner.topic,
          )
        )
          throw Error(
            "Удаление внешней ветки не разрешено этим подтверждением.",
          );
        const matching = refs.filter(
          (ref) =>
            ref.startsWith("refs/heads/") &&
            normalize(ref.slice("refs/heads/".length)) === plan.owner.topic,
        );
        if (matching.some((ref) => ref !== `refs/heads/${plan.owner.branch}`))
          throw Error(
            "Одноимённый топик основной папки принадлежит другой ветке. Удаление не разрешено.",
          );
        if (
          execute &&
          matching.length &&
          (
            await d.git(["rev-parse", "--verify", `${matching[0]}^{commit}`])
          ).trim() !== plan.primaryHead
        )
          throw Error(
            "Ветка основной папки изменилась после подтверждения удаления.",
          );
        const request = {
          projectId: plan.owner.projectId,
          year: plan.owner.year,
          action: "delete" as const,
          topics: [plan.owner.topic],
        };
        await d.assertPrimaryOwnerAvailable?.({
          ...request,
          expectedRevision: "",
        });
        const relative = `.goga/history/${plan.owner.year}/${plan.owner.topic}`;
        await noSymlinks(path.join(project.path, relative));
        let exists = true;
        try {
          await lstat(path.join(project.path, relative));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          exists = false;
        }
        const ownBranch = refs.some(
          (ref) =>
            normalize(
              ref.startsWith("refs/heads/")
                ? ref.slice("refs/heads/".length)
                : ref
                    .slice("refs/remotes/".length)
                    .split("/")
                    .slice(1)
                    .join("/"),
            ) === plan.owner.topic,
        );
        let carried = false;
        if (!ownBranch) {
          for (const ref of refs) {
            if (
              (
                await d.git([
                  "ls-tree",
                  "-d",
                  "--name-only",
                  ref,
                  "--",
                  relative,
                ])
              ).trim() === relative
            ) {
              carried = true;
              break;
            }
          }
        }
        const absent = !ownBranch && !exists && !carried;
        if (plan.primaryTopicAbsent && !absent)
          throw Error(
            "Топик появился в основной папке после подтверждения. Его удаление не разрешено.",
          );
        // A clone-only topic has nothing to remove in primary. This absence is
        // bound into the journal so later primary data is never silently deleted.
        if (absent) return true;
        // After an uncertain native result, a survivor-hosted directory is
        // deliberately retained by Goga; no own branch means nothing remains to delete.
        if (execute && !ownBranch && carried) return false;
        const board = await this.topicDomain.board(d, plan.owner.year);
        const ticket = await this.topicDomain.prepare(d, {
          ...request,
          expectedRevision: board.revision,
        });
        if (execute) {
          // Bind the fresh native ticket to the original deletion consent, not
          // to files or refs introduced while board/prepare was reading.
          await beforeExecute?.();
          if (this.deletionGuards(plan.owner).current)
            throw Error("Сначала переключитесь в основную папку.");
          const removed = await this.topicDomain.execute(d, ticket.token);
          if (removed.status !== "success") throw Error(removed.message);
        }
        return false;
      },
      false,
    );
  }
  async prepareContextDeletion(
    input: TopicContextRef,
    branch?: string,
  ): Promise<ContextDeletionPreview> {
    return this.operation(async () => {
      this.check();
      const ref = topicContextRefSchema.parse(input);
      if (this.deletionGuards(ref).active)
        throw Error("Активный контекст нельзя удалить.");
      const recovered = await this.contextDeletionRecovery(ref);
      if (recovered) return recovered;
      const row = await this.resolveTopicContext(ref);
      const git = (args: string[]) =>
        this.runner.command("git", args, row.projectPath).then((r) => r.stdout);
      const currentBranch = (await git(["branch", "--show-current"])).trim();
      let primarySwitch: DeletionSwitch | undefined;
      if (currentBranch === ref.branch) {
        if (!branch)
          return {
            token: "",
            contextId: ref.contextId,
            stage: "choose-branch",
            switchBranches: await deletionSwitchBranches(git, ref.topic),
            details: [
              `В основной папке открыта ветка «${currentBranch}». Выберите другую локальную ветку для перехода перед удалением топика.`,
            ],
          };
        primarySwitch = await prepareDeletionSwitch(
          git,
          row.projectPath,
          currentBranch,
          branch,
        );
      } else if (branch)
        throw Error(
          "Ветка основной папки изменилась. Откройте подтверждение заново.",
        );
      const primaryTopicAbsent = await this.contextTopicDeletion({
        owner: ref,
        projectPath: row.projectPath,
        recordRevision: row.revision,
        primarySwitch,
      });
      const plan = await this.clones.prepareContextDeletion(
        ref,
        this.deletionGuards(ref),
        primaryTopicAbsent,
        primarySwitch,
      );
      return this.contextDeletionPreview(plan);
    });
  }
  private async ownedContextDeletion(input: {
    projectId: string;
    token: string;
  }) {
    const plan = await this.clones.readContextDeletion(input.token);
    if (
      plan.owner.projectId !== input.projectId ||
      plan.projectPath !== (await this.project(input.projectId)).path
    )
      throw Error("Подтверждение удаления другого проекта или основной папки.");
    return plan;
  }
  async deleteContext(input: {
    projectId: string;
    token: string;
    allowAhead?: true;
  }): Promise<ContextDeletionResult> {
    this.check();
    if (!this.trashItem) throw Error("Системная Корзина недоступна.");
    return this.operation(async () => {
      const plan = await this.ownedContextDeletion(input);
      if (this.deletionGuards(plan.owner).active)
        throw Error("Активный контекст нельзя удалить.");
      const terminals = this.terminalDeletion?.prepareContextDeletion(
        plan.owner,
      );
      try {
        const result = await this.clones.trashContext(
          input.token,
          this.deletionGuards(plan.owner),
          {
            beforeTrash: async (latest) => {
              if (this.deletionGuards(plan.owner).active)
                throw Error("Активный контекст нельзя удалить.");
              await this.contextTopicDeletion(latest);
            },
            stopIdleTerminals: async () => {
              await terminals?.stopIdle();
              if (this.terminalLeases.has(plan.owner.contextId))
                throw Error(
                  "Не удалось подтвердить закрытие терминалов топика. Копия сохранена.",
                );
            },
            trashItem: async (root) => {
              if (this.deletionGuards(plan.owner).active)
                throw Error("Активный контекст нельзя удалить.");
              await this.trashItem!(root);
            },
          },
          input.allowAhead,
        );
        this.catalogEpoch++;
        this.previews.clear();
        return {
          projectId: input.projectId,
          status: result.status,
          message: result.message,
          stage: result.stage,
          cloneRemoved: result.cloneRemoved,
        };
      } finally {
        terminals?.release();
      }
    });
  }
  async finishContextDeletion(input: {
    projectId: string;
    token: string;
  }): Promise<ContextDeletionResult> {
    this.check();
    return this.operation(async () => {
      const plan = await this.ownedContextDeletion(input);
      if (this.deletionGuards(plan.owner).current)
        throw Error(
          "Сначала переключитесь в основную папку; удаляемый контекст ещё выбран.",
        );
      if (this.deletionGuards(plan.owner).active)
        throw Error("Активный контекст нельзя удалить.");
      const terminals = plan.primarySwitch
        ? this.terminalDeletion?.prepareContextDeletion(plan.owner.projectId)
        : undefined;
      try {
        if (plan.primarySwitch) {
          await this.snapshot(plan.owner.projectId, async () => {
            const primary = await this.topicsContext(plan.owner.projectId);
            if (
              primary.active() ||
              this.terminalDeletionBlocked(plan.owner.projectId)
            )
              throw Error("Основная папка занята.");
          });
        }
        const result = await this.clones.finishContextDeletion(
          input.token,
          async (latest, validatePrimarySnapshot) => {
            await this.contextTopicDeletion(
              latest,
              true,
              async () => {
                await validatePrimarySnapshot();
                terminals?.validate();
              },
              () => {
                terminals?.validate();
              },
            );
          },
          () => {
            terminals?.validate();
          },
        );
        this.catalogEpoch++;
        this.previews.clear();
        return {
          projectId: input.projectId,
          status: result.status,
          message: result.message,
          stage: result.stage,
          cloneRemoved: result.cloneRemoved,
        };
      } finally {
        terminals?.release();
      }
    });
  }
  private async topicsContext(
    id: ScopeRef,
    confirmedDeletion?: { owner: TopicContextRef; revision: string },
    beforeCommand?: () => void,
    intercept?: (
      args: string[],
      invoke: () => Promise<string>,
    ) => Promise<string>,
  ): Promise<TopicsContext> {
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
        beforeCommand?.();
        try {
          const invoke = async () =>
            (
              await this.runner.command(
                call.executable,
                args,
                this.root(project),
                call.env,
                stdin,
              )
            ).stdout;
          return intercept ? await intercept(args, invoke) : await invoke();
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
      assertPrimaryOwnerAvailable: async (request) => {
        if (request.context || !["delete", "update"].includes(request.action))
          return;
        const topics = new Set(
          request.topics ?? (request.target ? [request.target.topic] : []),
        );
        const allOwners = await this.clones.list(project.id);
        const owners = allOwners.filter(
          (row) =>
            row.projectId === project.id &&
            row.year === request.year &&
            row.storageKind === "clone" &&
            row.ownership === "managed" &&
            !row.deletedAt,
        );
        // This exemption is issued only by the dedicated host deletion flow.
        // Never expose it as an IPC/request field or exempt
        // another owner merely because it is also in the deleting state.
        const confirmed = (row: WorktreeRecord) =>
          !!confirmedDeletion &&
          request.action === "delete" &&
          request.projectId === confirmedDeletion.owner.projectId &&
          request.year === confirmedDeletion.owner.year &&
          topics.size === 1 &&
          topics.has(confirmedDeletion.owner.topic) &&
          row.contextId === confirmedDeletion.owner.contextId &&
          row.projectId === confirmedDeletion.owner.projectId &&
          row.year === confirmedDeletion.owner.year &&
          row.topic === confirmedDeletion.owner.topic &&
          row.branch === confirmedDeletion.owner.branch &&
          row.projectPath === project.path &&
          (row.state === "ready" ||
            row.state === "deleting" ||
            (row.state === "missing" && !!row.deletedAt)) &&
          row.revision === confirmedDeletion.revision;
        if (confirmedDeletion && !allOwners.some(confirmed))
          throw Error(
            "Подтверждённый владелец удаления изменился. Обновите подтверждение.",
          );
        // Goga delete is slug-wide even when the request carries target.branch.
        // Every matching owner must use the dedicated context deletion flow.
        if (
          owners.some(
            (row) =>
              row.projectPath !== project.path ||
              (request.action === "delete"
                ? topics.has(row.topic) && !confirmed(row)
                : !!request.target &&
                  !request.target.remote &&
                  row.topic === request.target.topic &&
                  row.branch === request.target.branch),
          )
        )
          throw Error(
            "У топика есть рабочая копия. Операция из основной папки запрещена; выберите её точный контекст.",
          );
      },
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
  /** Read-only inventory: no clone discovery, refresh, Goga, or mutation authority. */
  private async topicDisplayInventory(project: Project, year: string) {
    const rows = (await this.clones.list(project.id)).filter(
      (row) =>
        row.year === year &&
        row.storageKind === "clone" &&
        row.ownership === "managed" &&
        !row.deletedAt,
    );
    if (
      rows.some(
        (row) =>
          row.projectId !== project.id || row.projectPath !== project.path,
      )
    )
      throw Error(
        "Реестр относится к прежней папке проекта. Требуется проверка.",
      );
    assertReadActive();
    return rows;
  }
  async readTopicTable(
    projectId: string,
    year: string,
  ): Promise<TopicBoardSnapshot> {
    this.check();
    assertReadActive();
    if (typeof projectId !== "string" || this.context.getStore()?.binding)
      throw Error("Таблица доступна только для основной папки проекта.");
    this.parseScope(projectId);
    topicYearSchema.parse(year);
    const result = await this.snapshot(projectId, async () => {
      const context = await this.topicsContext(projectId);
      const before = await this.topicDisplayInventory(context.project, year);
      const table = await readTopicTableDisplay(context, year);
      const entries = new Map(
        table.entries.map((row) => [
          JSON.stringify([row.topic, row.branch]),
          row,
        ]),
      );
      const groups = new Map<string, WorktreeRecord[]>();
      for (const owner of before) {
        const key = JSON.stringify([owner.topic, owner.branch]);
        groups.set(key, [...(groups.get(key) ?? []), owner]);
      }
      const ownerGroups = [...groups.values()];
      const failed = new Set<string>();
      const summaries: TopicBoardSnapshot["entries"] = [];
      let next = 0;
      const worker = async () => {
        for (;;) {
          const index = next++;
          const group = ownerGroups[index];
          const owner = group?.[0];
          if (!owner || !group) return;
          assertReadActive();
          const primary = entries.get(
            JSON.stringify([owner.topic, owner.branch]),
          );
          let row: TopicBoardSnapshot["entries"][number] = {
            topic: owner.topic,
            branch: owner.branch,
            remote: false,
            current: primary?.current ?? false,
            statuses: [],
            todo: null,
            divergence: null,
            hosts: primary?.hosts ?? [owner.branch],
          };
          if (group.length > 1) {
            for (const candidate of group) failed.add(candidate.contextId);
            row.statusError =
              "Неоднозначный владелец статуса топика. Обновите список контекстов.";
            summaries[index] = row;
            continue;
          }
          try {
            if (owner.state !== "ready") throw Error("Owner unavailable");
            const ref = worktreeContextRef(owner);
            const local = await this.snapshot(ref, async () => {
              const owned = await this.topicsContext(ref);
              const localTable = await readTopicTableDisplay(owned, year);
              await this.validateBinding(owned.project);
              assertReadActive();
              return localTable;
            });
            const own = local.entries.find(
              (entry) =>
                entry.topic === owner.topic &&
                entry.branch === owner.branch &&
                !entry.remote,
            );
            if (own)
              row = {
                ...own,
                current: row.current,
                // Placement describes the original repository; clone reads only
                // refresh the exact owner's status/divergence.
                hosts: primary?.hosts ?? own.hosts,
              };
          } catch {
            // Cancellation is not an owner status error and must invalidate the read.
            assertReadActive();
            failed.add(owner.contextId);
            row.statusError =
              "Не удалось прочитать актуальный статус топика. Обновите таблицу.";
          }
          summaries[index] = row;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, ownerGroups.length) }, worker),
      );
      for (const row of summaries)
        entries.set(JSON.stringify([row.topic, row.branch]), row);
      table.entries = [...entries.values()];
      table.records = table.entries.map(({ hosts: _hosts, ...row }) => row);
      const after = await this.topicDisplayInventory(context.project, year);
      // Exact owner validation may mark a vanished clone unavailable. Such a row
      // remains explicitly unknown; identity/membership changes still invalidate
      // the whole read, as do revision changes of successfully loaded owners.
      const comparable = (rows: WorktreeRecord[]) =>
        rows.map((row) => {
          if (!failed.has(row.contextId)) return row;
          const {
            revision: _revision,
            state: _state,
            reason: _reason,
            ...identity
          } = row;
          return identity;
        });
      if (
        JSON.stringify(comparable(before)) !== JSON.stringify(comparable(after))
      )
        throw Error("Каталог контекстов изменился; обновите список.");
      assertReadActive();
      return table;
    });
    assertReadActive();
    return result;
  }
  private assertHistoryPrimary(scope: ScopeRef): string {
    const parsed = this.parseScope(scope);
    if (
      typeof parsed !== "string" ||
      this.context.getStore()?.binding ||
      this.selectedContext?.projectId === parsed
    )
      throw Error("Очистка истории доступна только в режиме «Без топика».");
    this.check();
    return parsed;
  }
  private async historyPruneAccess(projectId: string): Promise<PruneAccess> {
    this.assertHistoryPrimary(projectId);
    const project = await this.project(projectId);
    const call = this.invocation(project);
    const snapshot = this.context.getStore()!;
    return {
      root: project.path,
      version: JSON.stringify([
        snapshot.document.version,
        snapshot.catalogEpoch,
      ]),
      secrets: call.value.env.map((e) => e.value).filter(Boolean),
      verify: async () => {
        this.assertHistoryPrimary(projectId);
        await this.assertSettings(projectId);
        this.assertCatalog(snapshot.catalogEpoch);
        if ((await this.project(projectId)).path !== project.path)
          throw Error("Папка проекта изменилась. Повторите предпросмотр.");
      },
      command: (args) =>
        this.runner.command(call.executable, args, project.path, call.env),
    };
  }
  async prepareHistoryPrune(
    scope: ScopeRef,
    year: string,
  ): Promise<HistoryPrunePreview> {
    try {
      const id = this.assertHistoryPrimary(scope);
      historyYearSchema.parse(year);
      return await this.exclusive(id, () =>
        this.snapshot(
          id,
          async () =>
            this.historyPruner.run(
              id,
              year,
              await this.historyPruneAccess(id),
            ) as Promise<HistoryPrunePreview>,
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Не удалось подготовить очистку.";
      return {
        status: "error",
        projectId: typeof scope === "string" ? scope : "",
        year,
        entries: [],
        error: message,
        log: message,
      };
    }
  }
  async pruneHistory(
    scope: ScopeRef,
    token: string,
  ): Promise<HistoryPruneResult> {
    // Consume before any await, including the serialization queue.
    const pending =
      typeof token === "string" ? this.historyPruner.take(token) : undefined;
    let changed = false;
    try {
      const id = this.assertHistoryPrimary(scope);
      if (!pending || pending.projectId !== id)
        throw Error(
          "Подтверждение очистки истекло или уже использовано. Откройте предпросмотр заново.",
        );
      return await this.operation(() =>
        this.exclusive(id, () =>
          this.snapshot(
            id,
            async () => {
              const result = (await this.historyPruner.run(
                id,
                pending.year,
                await this.historyPruneAccess(id),
                pending,
              )) as HistoryPruneResult;
              changed = result.changed;
              return result;
            },
            false,
          ),
        ),
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Не удалось выполнить очистку.";
      return { status: "error", changed, error: message, log: message };
    }
  }
  private async historyRead<T>(
    scope: ScopeRef,
    action: (project: Project) => Promise<T>,
  ) {
    this.check();
    const parsed = this.parseScope(scope);
    if (typeof parsed === "string" && this.context.getStore()?.binding)
      throw Error("Для рабочей копии требуется точный контекст топика.");
    return history.withHistoryRead(async () => {
      const result = await this.snapshot(parsed, async () => {
        const project = await this.project(parsed);
        const result = await action(project);
        await this.validateBinding(project);
        assertReadActive();
        return result;
      });
      assertReadActive();
      return result;
    });
  }
  async listHistoryYears(scope: ScopeRef) {
    return this.historyRead(scope, (project) =>
      history.listHistoryYears(this.root(project)),
    );
  }
  async listHistoryEntries(scope: ScopeRef, year: string) {
    historyYearSchema.parse(year);
    return this.historyRead(scope, (project) =>
      history.listHistoryEntries(this.root(project), year),
    );
  }
  private async historyEntryRead<T>(
    scope: ScopeRef,
    year: string,
    entry: string,
    target: TopicTarget | undefined,
    action: (root: string, source?: history.HistoryTopicSource) => Promise<T>,
  ) {
    historyYearSchema.parse(year);
    historyEntrySchema.parse(entry);
    if (target !== undefined) topicTargetSchema.parse(target);
    const parsed = this.parseScope(scope);
    if (
      target &&
      (target.topic !== entry ||
        (typeof parsed !== "string" &&
          (parsed.year !== year ||
            parsed.topic !== entry ||
            parsed.branch !== target.branch ||
            target.remote)))
    )
      throw Error("История относится к другому контексту топика.");
    return this.historyRead(parsed, async (project) => {
      const owner = this.binding(project);
      const assertNoOwner = async () => {
        if (
          target &&
          !owner &&
          !target.remote &&
          (await this.topicDisplayInventory(project, year)).some(
            (row) => row.topic === target.topic && row.branch === target.branch,
          )
        )
          throw Error(
            "У топика есть рабочая копия. Выберите её точный контекст; подмена основной папкой запрещена.",
          );
      };
      await assertNoOwner();
      const result = await action(
        this.root(project),
        target
          ? {
              projectId: project.id,
              target,
              ...(owner ? { owner: worktreeContextRef(owner) } : {}),
              gitEnv: childEnvironment(process.env, { HOME: this.home }),
            }
          : undefined,
      );
      await assertNoOwner();
      return result;
    });
  }
  async listHistoryArtifacts(
    scope: ScopeRef,
    year: string,
    entry: string,
    target?: TopicTarget,
  ) {
    return this.historyEntryRead(scope, year, entry, target, (root, source) =>
      history.listHistoryArtifacts(root, year, entry, source),
    );
  }
  async readHistoryArtifact(
    scope: ScopeRef,
    year: string,
    entry: string,
    path: string,
    target?: TopicTarget,
  ) {
    historyPathSchema.parse(path);
    return this.historyEntryRead(scope, year, entry, target, (root, source) =>
      history.readHistoryArtifact(root, year, entry, path, source),
    );
  }
  async readTopicOverview(
    scope: ScopeRef,
    year: string,
    target: TopicTarget,
  ): Promise<TopicDetails> {
    this.check();
    assertReadActive();
    const parsed = this.parseScope(scope);
    topicYearSchema.parse(year);
    topicTargetSchema.parse(target);
    if (
      typeof parsed !== "string" &&
      (parsed.year !== year ||
        parsed.topic !== target.topic ||
        parsed.branch !== target.branch ||
        target.remote)
    )
      throw Error("Топик относится к другому контексту.");
    if (typeof parsed === "string" && this.context.getStore()?.binding)
      throw Error("Для рабочей копии требуется точный контекст топика.");
    const result = await this.snapshot(parsed, async () => {
      const context = await this.topicsContext(parsed);
      const assertNoOwner = async () => {
        if (
          !context.owner &&
          !target.remote &&
          (await this.topicDisplayInventory(context.project, year)).some(
            (row) => row.topic === target.topic && row.branch === target.branch,
          )
        )
          throw Error(
            "У топика есть рабочая копия. Выберите её точный контекст; подмена основной папкой запрещена.",
          );
      };
      await assertNoOwner();
      const details = await readTopicTaskOverview(context, year, target);
      await assertNoOwner();
      await this.validateBinding(context.project);
      assertReadActive();
      return details;
    });
    assertReadActive();
    return result;
  }
  /** Primary-only display read; no clone reconciliation or mutation proofs. */
  async readProjectBranches(projectId: string) {
    this.check();
    assertReadActive();
    if (typeof projectId !== "string" || this.context.getStore()?.binding)
      throw Error("Ветки доступны только для основной папки проекта.");
    this.parseScope(projectId);
    const result = await this.snapshot(projectId, async () => {
      const project = await this.project(projectId);
      const choices = await readBranchChoices((args) =>
        this.cmd(project, args, true),
      );
      assertReadActive();
      return { projectId, ...choices };
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
            const proof = this.exchangePlans.get(token);
            let handoff: GitUpdateHandoffCandidate | undefined;
            const context = await this.topicsContext(
              scope,
              undefined,
              undefined,
              (args, invoke) => {
                // Only our validated single-topic update command can offer a handoff.
                if (
                  args[0] !== "topics" ||
                  args[1] !== "--year" ||
                  args[3] !== "update" ||
                  args[5] !== "--base-ref" ||
                  !args[6]
                )
                  return invoke();
                return this.invokeUpdateWithHandoff(
                  scope,
                  {
                    targetBranch: args[4],
                    sourceRef: args[6],
                    baseRef: proof?.base?.baseRef ?? args[6],
                  },
                  invoke,
                  (candidate) => {
                    handoff = candidate;
                  },
                );
              },
            );
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
              const result = await next;
              return {
                ...result,
                ...(handoff && result.status !== "success" ? { handoff } : {}),
              };
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
    this.assertLaunchAllowed();
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
    this.assertLaunchAllowed();
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
    // Goga only resolves profiles when a workflow is active.
    if (
      workflow &&
      explicit &&
      !(await this.profiles(p)).some((x) => x.name === explicit)
    )
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
    this.assertLaunchAllowed();
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
    this.assertLaunchAllowed();
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
    this.assertLaunchAllowed();
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
        taskSnapshot = await this.readTopicTaskWithSettings(
          { projectId: p.id, branch, topic },
          true,
        );
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
  private assertLaunchAllowed(): void {
    this.check();
    if (this.shutdownAdmission)
      throw Error("Приложение готовится к выходу. Новый запуск недоступен.");
  }
  /** Freeze only new runs; stopping/recovery and project reads must remain usable.
   * Drain the pre-existing operation chain before taking the confirmation snapshot:
   * a recovery launch may already be between journal persistence and actual spawn.
   */
  async prepareShutdown(): Promise<PreparedShutdown> {
    this.check();
    if (this.shutdownAdmission)
      throw Error("Подготовка к выходу уже выполняется.");
    this.shutdownAdmission = true;
    let released = false;
    const active = () =>
      this.runList.filter(
        (run) =>
          ["starting", "running"].includes(run.status) ||
          this.children.has(run.id),
      );
    try {
      await this.operationTail;
      const planned = new Map(
        active().map((run) => [run.id, this.runOwnerHash(run)]),
      );
      const validate = () => {
        if (released) throw Error("Подготовка к выходу уже завершена.");
        for (const run of active()) {
          if (
            planned.get(run.id) !== this.runOwnerHash(run) ||
            run.recovery === "unverified"
          )
            throw Error("Состояние запуска не подтверждено. Выход отменён.");
        }
        if (
          [...this.children.keys()].some(
            (id) => !this.runList.some((run) => run.id === id),
          )
        )
          throw Error("Состояние запуска не подтверждено. Выход отменён.");
      };
      validate();
      return {
        items: active().map((run) => ({
          id: `run:${run.id}`,
          label: `${run.pipeline} — ${run.topic || "Без топика"}`,
        })),
        requiresConfirmation: planned.size > 0,
        validate,
        stop: async () => {
          validate();
          for (const run of active()) await this.stop(run.id);
        },
        remaining: () =>
          [
            ...new Set([
              ...active().map((run) => run.id),
              ...this.children.keys(),
            ]),
          ].map((id) => `run:${id}`),
        release: () => {
          if (released) return;
          released = true;
          this.shutdownAdmission = false;
        },
      };
    } catch (error) {
      this.shutdownAdmission = false;
      throw error;
    }
  }
  /** Unified exit has already stopped all runs. Persist before irreversible cleanup.
   * Runner.dispose failures retain ownership and reopen its admissions for a retry.
   */
  async finalizeShutdown(): Promise<void> {
    if (
      !this.shutdownAdmission ||
      this.children.size ||
      this.runList.some((run) => ["starting", "running"].includes(run.status))
    )
      throw Error("Сначала требуется завершить запуски приложения.");
    await this.operationTail;
    await this.runSaveTail;
    this.disposed = true;
    try {
      await this.runner.dispose?.();
    } catch (error) {
      this.disposed = false;
      throw error;
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
