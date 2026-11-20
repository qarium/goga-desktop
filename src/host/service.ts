import { t as tr } from "../shared/i18n";
import { runFailureMessage, type RunFailureReason } from "../shared/run-failure";
import {
  projectRemovalRequestSchema,
  type ProjectRemovalRequest,
} from "../shared/project-registration";
import { ProjectCreationCoordinator } from "./project-creation";
import { clearRunHistoryRequestSchema, type ClearRunHistoryRequest, type ClearRunHistoryResult } from "../shared/run-history";
import type { ProjectCreationRequest } from "../shared/project-creation";
import * as specifications from "./project-specifications";
import { pipelineDisplayMetadata } from "../shared/pipeline-display";
import { capturePipelineRepeat, pipelineRepeatSnapshotSchema } from "../shared/pipeline-repeat";
import { topicRemovalRequestSchema, topicRemovalTokenSchema, topicCloneCleanupRequestSchema, type TopicRemovalRequest, type TopicCloneCleanupRequest } from "../shared/topic-removal";
import { TopicRemovalDomain, ownTopicRefs, type TopicRemovalAccess, type RemovalInventory } from "./topic-removal";
import { diskOnlyTopicDirectories, readTopicRefInventory, readTopicMutationSnapshot } from "./topics";
import {
  overviewFileActionRequestSchema,
  overviewFileActionTokenSchema,
  overviewCopyPathsSchema,
  overviewDirectorySchema,
  overviewPasteDecisionsSchema,
  type OverviewPastePreview,
  type OverviewPasteDecision,
  type FileClipboard,
  type OverviewPasteResult,
  type OverviewFileActionRequest,
  type OverviewFileActionResult,
} from "../shared/project-overview";
import {
  OverviewFileActionTickets,
  prepareOverviewAction,
  checkedOverviewEntry,
} from "./overview-file-actions";
import {
  copyOverviewEntries as pasteOverviewFiles,
  prepareOverviewPaste as prepareOverviewFiles,
  type PreparedOverviewPaste,
} from "./overview-paste";
import { withNativeGitCompletion } from "./git-native-completion";
import { NativeGitSequence } from "./git-native-sequence";
import { createGogaPathReader, gogaEnvironment } from "./goga-environment";
import { readLaunchTopicIndex } from "./launch-topic-index";
import { LaunchFormReads, hasLocalTopicMetadata, type FormRead } from "./launch-form-read";
import {
  CommandSpawnError,
  CommandExitError,
  RunnerShutdownError,
} from "./process";
import * as overviewFiles from "./project-overview-files";
import {
  readOverviewSchema,
  readOverviewContract,
  buildArchitectureIndex,
} from "./project-overview-architecture";
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
  LaunchDiscoveryOptions,
  LaunchRequest,
  Pipeline,
  PipelinePreviewRequest,
  PipelineRequest,
  Preview,
  Project,
  ProjectSettings,
  ProjectSettingsView,
  Run,
  RunOutput,
  RunJournalSlice,
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
import {
  CloneManager,
  ensureCloneTopicDirectory,
  type ContextDeletionPlan,
} from "./clones";
import {
  ContextExchangeManager,
  type BaseSnapshot,
  type PublicationSnapshot,
} from "./context-exchange";
import {
  ContextRunsStore,
  RunHistoryClearCommittedError,
} from "./context-runs-store";
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
import { GitCommitCoordinator } from "./git-commit-coordinator";
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
  renameProjectDocument,
  saveProjectDocument,
} from "./project-documents";
import { assertReadActive, withOfflineGitReadScope } from "./read-scope";
import {
  RepositoryActions,
  repositoryActionFailure,
  sanitizeRepositoryLog,
} from "./repository-actions";
import { captureRunOutput } from "./run-output";
import { readDashboardIdentity } from "../shared/dashboard-connection";
import { RunRecoveryManager } from "./run-recovery";
import {
  SettingsStore,
  atomicWrite,
  digest,
  noSymlinks,
  optionalText,
} from "./settings";
import { ShutdownKeepError, type PreparedShutdown } from "./shutdown";
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
import { TopicsDomain, readSelectedTopicDeletionSnapshot, readBranchChoices, type TopicsContext } from "./topics";
import { assertTopicBranchesAvailable } from "./worktree-topic-guards";
import { WorktreeManager } from "./worktrees";
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
interface SettingsSnapshot {
  projectId: string;
  scopedProject: Project;
  document: ProjectSettingsDocument;
  catalogEpoch: number;
  binding?: WorktreeRecord;
  formDisplay?: true;
}
function standardFormBoard(settings: ProjectSettings) {
  return settings.executable === "goga" && !settings.env.some(row => row.key === "PATH");
}
const effectivePathArgs = [
  "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir",
  "--git-path", "index", "--git-path", "objects",
];
function assertGitPaths(binding: WorktreeRecord, paths: string[]) {
  const expected = [binding.path, binding.gitCommonDir, binding.gitCommonDir,
    path.join(binding.gitCommonDir, "index"), path.join(binding.gitCommonDir, "objects")];
  if (paths.length !== expected.length || paths.some((p, i) => path.resolve(binding.path, p) !== expected[i]))
    throw Error(tr("host.effectiveGitPathsDoNotMatchTheContextLaunchingIn"));
}
export class HostService extends EventEmitter {
  private overviewSchemaIssued = new Map<string, number>();
  private overviewSchemas = new Map<
    string,
    ReturnType<typeof buildArchitectureIndex>
  >();
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
  private dashboardFlights = new Map<
    string,
    { controller: AbortController; promise: Promise<string> }
  >();
  private recoveryPoll?: ReturnType<typeof setInterval>;
  private recoveryPolling = false;
  private detachedRuns = new Set<string>();
  private sync: ContextSyncManager;
  private selectedContext: TopicContextRef | null = null;
  private selectionEpoch = 0;
  private buildRequests = new Map<string, BuildRequest>();
  private topicDomain = new TopicsDomain();
  private topicRemovals = new TopicRemovalDomain();
  private deletionTickets = new DocumentDeletionTickets();
  private overviewFileActionTickets = new OverviewFileActionTickets();
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
  private gitActions = new GitCommitCoordinator({
    context: (scope, action) => this.gitCommitContext(scope, action),
  });
  private personalSettings: SettingsStore;
  private gitDiscardActions: NativeGitDiscardActions;
  private trashItem?: TrashItem;
  private fileClipboard?: FileClipboard;
  private overviewPasteTickets = new Map<
    string,
    { scope: ScopeRef; root: string; prepared: PreparedOverviewPaste }
  >();
  private showItemInFolder?: (absolutePath: string) => void;
  private terminalLeases = new Map<string, number>();
  private terminalLeaseProjects = new Map<symbol, string>();
  private operationTail: Promise<unknown> = Promise.resolve();
  private catalogEpoch = 0;
  private deleting = false;
  private nativeGitJournal: NativeGitJournal;
  private home: string;
  private dataDir: string;
  private goga: string;
  private shellPath?: () => Promise<string>;
  private runner: Runner;
  private projectCreation: ProjectCreationCoordinator;
  private state: DesktopStateStore;
  private context = new AsyncLocalStorage<SettingsSnapshot>();
  private readonly formReads = new LaunchFormReads();
  private settingsLocks = new Map<string, Promise<unknown>>();
  private documentSaveRevisions = new Map<string, number>();
  private runList: Run[] = [];
  // A run is journaled before spawn. Until its local observer is installed it
  // belongs to this launch, not to restart reconciliation.
  private readonly localRunAdmissions = new WeakSet<Run>();
  private journalHeads = new WeakMap<Run, { end: number; sequence: number }>();
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
  private pipelineRepeatFlights = new Map<string, Promise<Run>>();
  private activeKeys = new Map<string, Set<string>>();
  private worktrees: WorktreeManager;
  private contextPreparations = new Map<string, Promise<WorktreeRecord>>();
  private disposed = false;
  private shutdownFinalized = false;
  private shutdownAdmission = false;
  private readonly demonstrationActive?: (projectId:string, contextId?:string)=>boolean;
  private readonly demoAdmissions = new Map<symbol,ScopeRef>();
  constructor(options: {
    demonstrationActive?: (projectId:string, contextId?:string)=>boolean;
    home?: string;
    dataDir: string;
    goga?: string;
    shellPath?: () => Promise<string>;
    runner?: Runner;
    projectCreationRunner?: Runner;
    settings?: SettingsStore;
    trashItem?: TrashItem;
    fileClipboard?: FileClipboard;
    showItemInFolder?: (absolutePath: string) => void;
    recovery?: RunRecoveryManager;
  }) {
    super();
    this.home = options.home ?? homedir();
    this.demonstrationActive = options.demonstrationActive;
    this.nativeGitJournal = new NativeGitJournal({
      directory: path.join(this.home, ".goga", "desktop", "git-operations"),
    });
    this.personalSettings = options.settings ?? new SettingsStore(this.home);
    this.trashItem = options.trashItem;
    this.fileClipboard = options.fileClipboard;
    this.showItemInFolder = options.showItemInFolder;
    this.gitDiscardActions = new NativeGitDiscardActions({
      context: (scope, action) => this.gitCommitContext(scope, action, true),
      trashItem: this.trashItem,
    });
    this.dataDir = options.dataDir;
    this.goga = options.goga ?? "goga";
    this.state = new DesktopStateStore(this.home, this.dataDir);
    this.runner = options.runner ?? new NodeRunner(120000, { HOME: this.home });
    this.projectCreation = new ProjectCreationCoordinator({
      home: this.home,
      runner: options.projectCreationRunner ?? new NodeRunner(30 * 60 * 1000, { HOME: this.home }),
      progress: (value) => this.emit("project-creation", value),
      register: (folder) => this.state.addProject({
        id: digest(folder).slice(0, 24), name: path.basename(folder), path: folder,
      }),
    });
    this.shellPath =
      options.shellPath ??
      (!options.runner
        ? createGogaPathReader(this.home, this.runner)
        : undefined);
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
            (await this.invocation(await this.project(ref))).env,
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
    this.recoveryPoll = setInterval(() => {
      if (this.disposed || this.shutdownAdmission || this.recoveryPolling)
        return;
      this.recoveryPolling = true;
      void Promise.all(
        this.runList
          .filter(
            (r) =>
              r.dashboardRecoveryVersion === 1 && this.canReconcileStoredRun(r),
          )
          .map((r) => this.reconcileRun(r.id).catch(() => {})),
      ).finally(() => {
        this.recoveryPolling = false;
      });
    }, 3000);
    this.recoveryPoll.unref();
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
        ({
          output,
          url,
          error,
          failureReason,
          persistenceError,
          recoveryMessage,
          dashboardReconnect,
          dashboardRunId,
          dashboardMessage,
          ...row
        }) => row,
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
          tr("host.couldNotSaveRunHistoryItsStateWillNeedVerification");
      this.emit("runs", this.runCatalog());
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
        tr("host.processStateHasNotBeenVerifiedSinceRestartVerifyThe"),
      );
    if (kind === "build" && active.some((run) => run.kind === "build"))
      throw Error(tr("host.aBuildIsAlreadyRunningInThisRepository"));
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
  /** Keep removes the observer, not live checkout membership. Release it only
   * after recovery has authoritatively confirmed a terminal process result. */
  private releaseRecoveredTerminalRun(id: string) {
    for (const key of this.activeKeys.keys()) this.removeActiveRun(key, id);
    this.detachedRuns.delete(id);
  }
  private check() {
    if (this.disposed) throw new Error(tr("host.theApplicationIsShuttingDown"));
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
    return this.withSettingsSnapshot({
      projectId: id, scopedProject, document, catalogEpoch: epoch, binding,
    }, action, verifyAfter);
  }
  private withSettingsSnapshot<T>(snapshot: SettingsSnapshot, action: () => Promise<T>, verifyAfter = true) {
    const { projectId: id, document, catalogEpoch: epoch } = snapshot;
    return this.context.run(snapshot,
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
              : tr("host.theGogaOperationFailed");
          for (const entry of document.value.env)
            if (entry.value)
              message = message.split(entry.value).join(tr("host.hidden"));
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
        tr("host.projectSettingsChangedThePreviewIsStaleRefreshBeforeLaunching"),
      );
  }
  private async invocation(p: Project) {
    const doc = this.context.getStore();
    if (!doc || doc.projectId !== p.id)
      throw new Error(tr("host.noProjectSettingsSnapshot"));
    const value = doc.document.value;
    if (this.bindings.has(p)) assertContextEnvironment(value.env);
    return {
      executable: value.executable === "goga" ? this.goga : value.executable,
      env: await gogaEnvironment(value.env, this.shellPath),
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
    const call = await this.invocation(project);
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
        error instanceof CommandExitError && /No such option:\s*--profile\b/.test(error.stderr)
      )
        throw new Error(
          tr("host.thisVersionOfGogaDoesNotSupportProfileTheSelected"),
        );
      assertReadActive();
      if (error instanceof RunnerShutdownError) throw error;
      const label = [path.basename(call.executable), ...args]
        .map((word) =>
          /^[\p{L}\p{N}_./+@=-]+$/u.test(word) ? word : JSON.stringify(word),
        )
        .join(" ");
      const reason =
        error instanceof CommandExitError
          ? tr("host.exitedWithCodeValue1CheckTheProjectConfiguration", { value1: error.exitCode ?? "signal" })
          : error instanceof CommandSpawnError
            ? error.code === "ENOENT"
              ? tr("host.couldNotStartTheExecutableOrItsInterpreterWasNot")
              : error.code === "EACCES"
                ? tr("host.couldNotStartPermissionToExecuteTheFileWasDenied")
                : tr("host.couldNotStartCheckTheExecutableAndItsInterpreter")
            : tr("host.failedCheckTheExecutablePathAndProjectConfigurationEnvironmentValues");
      throw new Error(tr("host.commandLabelReason", { label: label, reason: reason }));
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
      const leaseOwner = Symbol();
      this.terminalLeaseProjects.set(leaseOwner, scopeProjectId(parsed));
      let released = false;
      let launch: TerminalLaunch | undefined;
      const release = () => {
        if (released) return;
        released = true;
        launch?.dispose?.();
        const count = (this.terminalLeases.get(key) ?? 1) - 1;
        if (count) this.terminalLeases.set(key, count);
        else this.terminalLeases.delete(key);
        this.terminalLeaseProjects.delete(leaseOwner);
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
              throw Error(tr("host.terminalOwnerUnavailable"));
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
          tr("host.theSelectedProfileNoLongerExistsSelectAnExistingProfile"),
        );
      await this.validateBinding(p);
      const document = await this.state.save(
        scopeProjectId(id),
        value,
        version,
      );
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
        tr("host.projectDocumentsChangedSuggestionsAreStaleRefresh"),
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
  private overviewRead<T>(
    scope: ScopeRef,
    action: (project: Project) => Promise<T>,
  ) {
    this.check();
    return this.snapshot(scope, async () => {
      const project = await this.project(scope);
      return action(project);
    });
  }
  listOverviewDirectory(scope: ScopeRef, p: string) {
    return this.overviewRead(scope, (project) =>
      overviewFiles.listOverviewDirectory(this.root(project), p),
    );
  }
  searchOverviewFiles(scope: ScopeRef, p: string, query: string) {
    return this.overviewRead(scope, (project) =>
      overviewFiles.searchOverviewFiles(this.root(project), p, query),
    );
  }
  readOverviewFile(scope: ScopeRef, p: string) {
    return this.overviewRead(scope, (project) =>
      overviewFiles.readOverviewFile(this.root(project), p),
    );
  }
  // A running payload is not a file lock. Overview writes retain exact-owner,
  // settings and path/version guards without requiring an idle process context.
  private overviewWrite<T>(
    scope: ScopeRef,
    action: (root: string, guard: () => Promise<void>) => Promise<T>,
  ) {
    this.assertLaunchAllowed();
    return this.operation(() =>
      this.exclusive(scopeProjectId(scope), () =>
        this.overviewRead(scope, async (project) => {
          const epoch = this.catalogEpoch;
          const guard = async () => {
            this.assertLaunchAllowed();
            assertReadActive();
            this.assertCatalog(epoch);
            await this.validateBinding(project);
            await this.assertSettings(project.id);
          };
          await guard();
          const result = await action(this.root(project), guard);
          await guard();
          return result;
        }),
      ),
    );
  }
  saveOverviewFile(scope: ScopeRef, p: string, text: string, version: string) {
    return this.overviewWrite(scope, (root, guard) =>
      overviewFiles.saveOverviewFile(root, p, text, version, guard),
    );
  }
  createOverviewEntry(
    scope: ScopeRef,
    p: string,
    kind: "file" | "directory",
    text = "",
  ) {
    return this.overviewWrite(scope, (root, guard) =>
      overviewFiles.createOverviewEntry(root, p, kind, text, guard),
    );
  }
  async copyOverviewPaths(
    scope: ScopeRef,
    paths: string[],
    absolute: boolean,
  ): Promise<void> {
    const selected = structuredClone(this.parseScope(scope));
    const unique = [...new Set(overviewCopyPathsSchema.parse(paths))];
    if (typeof absolute !== "boolean") throw Error(tr("host.invalidPathFormat"));
    if (!this.fileClipboard?.writeText)
      throw Error(tr("host.textClipboardUnavailable"));
    return this.overviewRead(selected, async (project) => {
      const root = this.root(project);
      const entries = await Promise.all(
        unique.map((p) => checkedOverviewEntry(root, p)),
      );
      await this.validateBinding(project);
      await this.assertSettings(project.id);
      for (const entry of entries) await entry.verify();
      await this.validateBinding(project);
      await this.fileClipboard!.writeText!(
        unique.map((p) => (absolute ? path.join(root, p) : p)).join("\n"),
      );
    });
  }
  async prepareOverviewPaste(
    scope: ScopeRef,
    directory: string,
  ): Promise<OverviewPastePreview> {
    const selected = structuredClone(this.parseScope(scope));
    const destination = overviewDirectorySchema.parse(directory);
    if (!this.fileClipboard) throw Error(tr("host.fileClipboardUnavailable"));
    const expectedRoot = await this.overviewRead(selected, async (project) => {
      await this.validateBinding(project);
      await this.assertSettings(project.id);
      return this.root(project);
    });
    const sources = [...(await this.fileClipboard.readFiles())];
    return this.overviewRead(selected, async (project) => {
      await this.validateBinding(project);
      await this.assertSettings(project.id);
      const root = this.root(project);
      if (root !== expectedRoot)
        throw Error(
          tr("host.theProjectWorkingFolderChangedRetryThePasteInThe"),
        );
      const prepared = await prepareOverviewFiles(root, sources, destination);
      await this.validateBinding(project);
      await this.assertSettings(project.id);
      while (this.overviewPasteTickets.size >= 128)
        this.overviewPasteTickets.delete(
          this.overviewPasteTickets.keys().next().value!,
        );
      const token = randomUUID();
      this.overviewPasteTickets.set(token, { scope: selected, root, prepared });
      return {
        token,
        conflicts: prepared.conflicts.map((conflict) => ({ ...conflict })),
      };
    });
  }
  async executeOverviewPaste(
    token: string,
    decisions: OverviewPasteDecision[],
  ): Promise<OverviewPasteResult> {
    // Consume synchronously before admission: duplicate calls never retry writes.
    const pending = overviewFileActionTokenSchema.safeParse(token).success
      ? this.overviewPasteTickets.get(token)
      : undefined;
    this.overviewPasteTickets.delete(token);
    const notDone = (): OverviewPasteResult => ({
      status: "not-done",
      completedPaths: [],
      touchedPaths: [],
      message:
        tr("host.confirmationIsStaleOrAlreadyUsedRefreshTheListAnd"),
    });
    if (!pending) return notDone();
    let observed: OverviewPasteResult | undefined;
    try {
      const parsed = overviewPasteDecisionsSchema.parse(decisions);
      return await this.overviewWrite(pending.scope, async (root, guard) => {
        if (root !== pending.root)
          throw Error(tr("host.theProjectWorkingFolderChanged"));
        observed = await pending.prepared.perform(parsed, guard);
        return observed;
      });
    } catch {
      return observed
        ? {
            ...observed,
            status: "uncertain",
            message:
              observed.status === "uncertain"
                ? observed.message
                : tr("host.theCopyResultCouldNotBeVerifiedCheckTheTree"),
          }
        : notDone();
    }
  }
  async copyOverviewEntries(scope: ScopeRef, paths: string[]): Promise<void> {
    const selected = structuredClone(this.parseScope(scope));
    const parsed = overviewCopyPathsSchema.parse(paths);
    const unique = [...new Set(parsed)].filter(p => !parsed.some(parent => parent !== p && p.startsWith(parent + "/")));
    if (!this.fileClipboard) throw Error(tr("host.fileClipboardUnavailable"));
    return this.overviewRead(selected, async project => {
      const root = this.root(project);
      const entries = await Promise.all(unique.map(p => checkedOverviewEntry(root, p, true)));
      await this.validateBinding(project);
      await this.assertSettings(project.id);
      for (const entry of entries) await entry.verify();
      await this.validateBinding(project);
      await this.fileClipboard!.writeFiles(unique.map(p => path.join(root, p)));
    });
  }
  async pasteOverviewEntries(scope: ScopeRef, destinationDirectory: string): Promise<OverviewPasteResult> {
    const selected = structuredClone(this.parseScope(scope));
    const destination = overviewDirectorySchema.parse(destinationDirectory);
    if (!this.fileClipboard) throw Error(tr("host.fileClipboardUnavailable"));
    // Capture authority before the native clipboard await. A later selection is
    // never used as a fallback destination for this operation.
    const expectedRoot = await this.overviewRead(selected, async project => {
      await this.validateBinding(project);
      await this.assertSettings(project.id);
      return this.root(project);
    });
    const sources = [...await this.fileClipboard.readFiles()];
    let observed: OverviewPasteResult | undefined;
    try {
      return await this.overviewWrite(selected, async (root, guard) => {
        if (root !== expectedRoot) throw Error(tr("host.theProjectWorkingFolderChangedRetryThePasteInThe"));
        observed = await pasteOverviewFiles(root, sources, destination, guard);
        return observed;
      });
    } catch (error) {
      if (!observed) throw error;
      return { ...observed, status: "uncertain", message: tr("host.theCopyResultCouldNotBeVerifiedCheckTheTree") };
    }
  }
  async prepareOverviewFileAction(
    scope: ScopeRef,
    request: OverviewFileActionRequest,
  ) {
    this.assertLaunchAllowed();
    const selected = structuredClone(this.parseScope(scope));
    const parsed = overviewFileActionRequestSchema.parse(request);
    return this.overviewRead(selected, async (project) => {
      await this.validateBinding(project);
      const root = this.root(project);
      const prepared = await prepareOverviewAction(root, parsed);
      await this.assertSettings(project.id);
      return this.overviewFileActionTickets.issue({
        scope: selected,
        root,
        settingsVersion: this.context.getStore()!.document.version,
        prepared,
      });
    });
  }
  async executeOverviewFileAction(
    token: string,
  ): Promise<OverviewFileActionResult> {
    // Consume before entering the host queue; neither duplicate nor stale calls retry.
    const pending = overviewFileActionTokenSchema.safeParse(token).success
      ? this.overviewFileActionTickets.take(token)
      : undefined;
    const notDone = (): OverviewFileActionResult => ({
      status: "not-done",
      completedPaths: [],
      message:
        tr("host.confirmationIsStaleOrAlreadyUsedRefreshTheListAnd2"),
    });
    if (!pending) return notDone();
    let observed: OverviewFileActionResult | undefined;
    try {
      return await this.overviewWrite(pending.scope, async (root, guard) => {
        const verify = async () => {
          await guard();
          if (
            !this.overviewFileActionTickets.isCurrent(pending) ||
            root !== pending.root ||
            this.context.getStore()!.document.version !==
              pending.settingsVersion
          )
            throw Error(tr("host.previewIsStale"));
        };
        await verify();
        observed = await pending.prepared.perform(verify, this.trashItem);
        return observed;
      });
    } catch {
      return observed
        ? {
            ...observed,
            status: "uncertain",
            message:
              tr("host.theResultCouldNotBeVerifiedCheckTheDirectoryAnd"),
          }
        : notDone();
    }
  }
  revealOverviewEntry(scope: ScopeRef, p: string): Promise<void> {
    return this.overviewRead(scope, async (project) => {
      const entry = await checkedOverviewEntry(this.root(project), p);
      await this.validateBinding(project);
      await this.assertSettings(project.id);
      await entry.verify();
      if (!this.showItemInFolder) throw Error(tr("host.showInFinderIsUnavailable"));
      this.showItemInFolder(path.join(this.root(project), p));
    });
  }
  async readOverviewSchema(scope: ScopeRef) {
    let key = "",
      issued = 0;
    const data = await this.overviewRead(scope, async (project) => {
      key = JSON.stringify([
        scope,
        this.root(project),
        this.context.getStore()!.document.version,
      ]);
      issued = (this.overviewSchemaIssued.get(key) ?? 0) + 1;
      this.overviewSchemaIssued.set(key, issued);
      // A new empty project has no code to analyse, with or without Git. Do not
      // invoke Goga merely to display its empty Overview; recheck on every read.
      if ((await readdir(this.root(project))).every((name) => name === ".git")) return [];
      const call = await this.invocation(project);
      return readOverviewSchema(
        this.runner,
        call.executable,
        this.root(project),
        call.env,
      );
    });
    if (this.overviewSchemaIssued.get(key) === issued) {
      this.overviewSchemas.set(key, buildArchitectureIndex(data));
      if (this.overviewSchemas.size > 16) {
        const oldest = this.overviewSchemas.keys().next().value!;
        this.overviewSchemas.delete(oldest);
        this.overviewSchemaIssued.delete(oldest);
      }
    }
    return data;
  }
  readOverviewContract(scope: ScopeRef, cell: string) {
    return this.overviewRead(scope, async (project) => {
      const call = await this.invocation(project),
        root = this.root(project);
      const key = JSON.stringify([
        scope,
        root,
        this.context.getStore()!.document.version,
      ]);
      let index = this.overviewSchemas.get(key);
      if (!index)
        index = buildArchitectureIndex(
          await readOverviewSchema(
            this.runner,
            call.executable,
            root,
            call.env,
          ),
        );
      if (!Object.hasOwn(index.cells, cell))
        throw Error(tr("host.thisFolderIsNotInTheCurrentSchema"));
      return readOverviewContract(
        this.runner,
        call.executable,
        root,
        cell,
        call.env,
      );
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
          tr("host.theDockerfilePathChangedReopenTheCurrentFile"),
        );
      const document = await readProjectDocument(this.root(project), target);
      const latest = await this.dockerfile(project);
      if (latest.fingerprint !== metadata.fingerprint)
        throw new Error(tr("host.dockerfileConfigurationChanged"));
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
                  tr("host.dockerfileConfigurationChangedYourDraftWasKeptReopenTheCurrent"),
                );
              const guard = async () => {
                await this.validateBinding(project);
                await this.assertSettings(project.id);
                const latest = await this.dockerfile(project);
                if (latest.fingerprint !== metadata.fingerprint)
                  throw new Error(tr("host.dockerfileConfigurationChanged"));
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
              () => this.validateBinding(project),
            );
      this.documentSaveRevisions.set(
        scopeProjectId(id),
        (this.documentSaveRevisions.get(scopeProjectId(id)) ?? 0) + 1,
      );
      return document;
    });
  }

  async renameProjectDocument(
    scope: ScopeRef,
    target: ProjectDocumentTarget,
    newName: string,
    expectedVersion: string,
  ) {
    this.check();
    const projectId = scopeProjectId(scope);
    return this.exclusive(projectId, async () => {
      const project = await this.project(scope);
      try {
        return await renameProjectDocument(
          this.root(project),
          target,
          newName,
          expectedVersion,
          () => this.validateBinding(project),
        );
      } finally {
        // Even an uncertain result invalidates prior catalog reads.
        this.documentSaveRevisions.set(
          projectId,
          (this.documentSaveRevisions.get(projectId) ?? 0) + 1,
        );
      }
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
        tr("host.documentsChangedThePreviewOrCatalogIsStaleRefresh"),
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
        tr("host.removalIsUnavailableWhileAPipelineIsStartingOrRunning"),
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
      throw new Error(tr("host.invalidDocumentOrVersionForRemoval"));
    const selected = structuredClone(source);
    if (
      selected.scope === "project" &&
      selected.context &&
      selected.context.projectId !== selected.projectId
    )
      throw Error(tr("host.contextBelongsToAnotherProject"));
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
          tr("host.theDocumentIsMissingHasChangedOrCannotBeRemoved"),
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
          tr("host.removalConfirmationExpiredOrWasAlreadyUsedSelectTheDocument"),
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
          message: tr("host.systemTrashUnavailableNothingWasDeleted"),
        };
      const action = async (): Promise<DeletionResult> => {
        this.assertDeletionIdle();
        // Invalidate at both boundaries: pending requests, including ones begun
        // while the adapter is working, must never publish pre-deletion results.
        this.deleting = true;
        this.catalogEpoch++;
        if (pending.source.scope === "project")
          this.documentSaveRevisions.set(
            pending.source.projectId,
            (this.documentSaveRevisions.get(pending.source.projectId) ?? 0) + 1,
          );
        try {
          if (pending.source.scope === "project" && pending.source.context) {
            if (pending.source.projectId !== pending.source.context.projectId)
              throw Error(tr("host.contextBelongsToAnotherProject"));
            await this.project(pending.source.context);
          }
          return await pending.guard.perform(async (absolutePath) => {
            // A valid confirmation can expire while queued behind a save.
            // Check inside the guarded save queue, immediately at adapter entry.
            if (!this.deletionTickets.isCurrent(pending))
              throw new Error(tr("host.removalConfirmationExpired"));
            this.check();
            this.assertDeletionIdle();
            await this.trashItem!(absolutePath);
          });
        } catch {
          return {
            status: "uncertain",
            message:
              tr("host.couldNotVerifyRemovalCheckTrashAndTheFolderThe"),
          };
        } finally {
          this.catalogEpoch++;
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
    if (!result.success) throw Error(tr("host.invalidProjectOrContext"));
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
    if (this.context.getStore()?.formDisplay) {
      await this.formGitFacts(project);
      return;
    }
    await this.clones.store.assertOwned(binding);
    // Use the same normal HOME/system/global inputs as real children.
    const raw = (await this.runner.command("git", ["rev-parse", ...effectivePathArgs], binding.path, { HOME: this.home })).stdout;
    await this.clones.store.assertOwned(binding);
    assertGitPaths(binding, raw.trim().split("\n"));
  }
  /** Each observation is live. For a clone it verifies physical ownership on
   * both sides of the command and normal (not management-only) Git paths. */
  private async formGitFacts(project: Project, requestedBranch?: string) {
    this.check();
    assertReadActive();
    const binding = this.binding(project);
    if (binding) await this.clones.assertNativeOperationOwnerRecord(binding);
    const raw = (await this.runner.command("git", ["rev-parse",
      ...(binding ? effectivePathArgs : []),
      requestedBranch ? `refs/heads/${requestedBranch}^{commit}` : "HEAD",
      "--symbolic-full-name", "HEAD",
    ], this.root(project), { HOME: this.home })).stdout;
    if (binding) await this.clones.assertNativeOperationOwnerRecord(binding);
    const lines = raw.replace(/\n$/, "").split("\n");
    const ref = lines.pop(), commit = lines.pop();
    if (binding) assertGitPaths(binding, lines);
    if ((!binding && lines.length) || !commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ||
        !ref || (ref !== "HEAD" && !/^refs\/heads\/[^\x00-\x20\x7f]+$/.test(ref)))
      throw Error(tr("host.couldNotDetermineTheTopicBranch"));
    const branch = ref === "HEAD" ? "" : ref.slice("refs/heads/".length);
    if (binding && branch !== binding.branch)
      throw Error(tr("host.theWorkingCopyBranchChangedSelectTheContextAgain"));
    assertReadActive();
    return {commit, branch};
  }
  private async resolveFormOwner(ref: TopicContextRef, project: Project) {
    const {record, operationBinding} = await this.clones.resolveGitRead(ref);
    if (operationBinding || record.projectPath !== project.path ||
        record.storageKind !== "clone" || record.ownership !== "managed" ||
        record.state !== "ready" || record.preparation || record.reason || record.deletedAt)
      throw Error(tr("host.theCloneIsUnavailableOrDoesNotBelongToThe"));
    return record;
  }
  /** Display-only admission. A receipt is an optimization hint, never authority:
   * no registry refresh, fallback to the primary folder, or cross-request settings. */
  private formSnapshot<T>(scope: ScopeRef, hint: FormRead | undefined, phase: "discover" | "task" | "preview",
    action: (p: Project, reusable: FormRead | undefined, year: string) => Promise<T>) {
    return this.context.exit(async () => {
      this.check();
      assertReadActive();
      const ref = this.parseScope(scope), id = scopeProjectId(ref), epoch = this.catalogEpoch;
      this.assertCatalog(epoch);
      const {project: registered, document} = await this.state.readRegisteredProject(id);
      const project = { ...registered };
      await guardedProject(project.path);
      const year = typeof ref === "string" ? String(new Date().getFullYear()) : ref.year;
      const reusable = hint && hint.projectPath === project.path && hint.settingsVersion === document.version &&
        hint.epoch === epoch && hint.year === year ? hint : undefined;
      let binding: WorktreeRecord | undefined;
      if (typeof ref !== "string") {
        // Only an exact local task read can skip full re-admission. Before running
        // a configurable --list/--info/board, re-check remotes, config and owner.
        binding = phase === "task" && reusable?.binding && standardFormBoard(document.value)
          ? reusable.binding : await this.resolveFormOwner(ref, project);
        await this.clones.assertNativeOperationOwnerRecord(binding);
        this.bindings.set(project, binding);
      }
      const result = await this.withSettingsSnapshot({
        projectId: id, scopedProject: project, document, catalogEpoch: epoch, binding, formDisplay: true,
      }, async () => {
        // The task/preview starts with its own combined observation. Discovery also
        // reads files in parallel, so verify the effective root before admitting it.
        if (binding && phase === "discover") await this.formGitFacts(project);
        const result = await action(project, reusable, year);
        // Never share the terminal verification/cancellation signal between two IPC reads.
        if (binding && typeof ref !== "string") {
          if (phase !== "discover") {
            const live = await this.resolveFormOwner(ref, project);
            if (JSON.stringify(live) !== JSON.stringify(binding))
              throw Error(tr("host.theWorkingCopyChangedDuringReading"));
          }
          await this.formGitFacts(project);
        }
        const current = await this.state.readRegisteredProject(id);
        if (current.document.version !== document.version)
          throw Error(tr("host.projectSettingsChangedThePreviewIsStaleRefreshBeforeLaunching"));
        if (current.project.path !== project.path || await realpath(project.path) !== project.path)
          throw Error(tr("host.theOriginalProjectFolderChangedRefresh"));
        this.check();
        assertReadActive();
        return result;
      }, false); // The paired read above verifies both registration and settings.
      assertReadActive();
      return result;
    });
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
        tr("host.theContextHasAnActiveRunOrTheProcessState"),
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
      throw Error(tr("host.theContextChangedLaunchingInTheOriginalFolderIsNot"));
    await this.assertEffectiveRoot(project);
  }
  private async project(scope: ScopeRef): Promise<Project> {
    const parsed = this.parseScope(scope),
      id = scopeProjectId(parsed);
    const p = (await this.listProjects()).find((p) => p.id === id);
    if (!p) throw new Error(tr("host.unknownProject2"));
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
      throw Error(tr("host.theCloneIsUnavailableOrDoesNotBelongToThe"));
    const scoped = { ...p };
    this.bindings.set(scoped, binding);
    await this.assertEffectiveRoot(scoped);
    return scoped;
  }
  /** Admit under the same ordering as unregister/topic deletion, but never hold
   * the project lock during a browser launch or tie ordinary edits/runs to a show. */
  async withDemonstrationOwner(
    scope: ScopeRef,
    open: (label: string) => Promise<void>,
  ): Promise<void> {
    const ref = this.parseScope(scope), projectId = scopeProjectId(ref), ticket = Symbol();
    try {
      const label = await this.operation(() => this.exclusive(projectId, async () => {
        this.check();
        if (this.shutdownAdmission) throw Error(tr("host.theAppIsPreparingToExit"));
        this.demoAdmissions.set(ticket, ref);
        const project = await this.project(ref);
        return typeof ref === "string" ? project.name : project.name + " · " + ref.topic;
      }));
      await open(label);
    } finally {
      this.demoAdmissions.delete(ticket);
    }
  }
  private hasDemonstration(projectId: string, contextId?: string) {
    return this.demonstrationActive?.(projectId, contextId) || [...this.demoAdmissions.values()].some(s =>
      scopeProjectId(s) === projectId && (!contextId || (typeof s !== "string" && s.contextId === contextId)));
  }
  async listProjects(): Promise<Project[]> {
    return this.state.listProjects();
  }
  createProject(request: ProjectCreationRequest) {
    this.check();
    if (this.shutdownAdmission) throw Error(tr("host.theAppIsPreparingToExit"));
    return this.projectCreation.create(request);
  }
  cancelProjectCreation(id: string) { return this.projectCreation.cancelAndWait(id); }
  prepareProjectCreationShutdown() { return this.projectCreation.prepareShutdown(); }
  /** Serialized with launch/terminal admission; unregistering never stops processes. */
  async removeProject(input: ProjectRemovalRequest): Promise<Project[]> {
    const target = projectRemovalRequestSchema.parse(input);
    if (!path.isAbsolute(target.path))
      throw Error(tr("host.invalidProjectFolder"));
    return this.operation(() =>
      this.exclusive(target.id, async () => {
        this.check();
        if (
          this.runList.some(
            (run) =>
              run.projectId === target.id &&
              (["starting", "running"].includes(run.status) ||
                run.recovery === "unverified" ||
                this.children.has(run.id) ||
                this.stopFlights.has(run.id)),
          )
        )
          throw Error(
            tr("host.finishTheProjectSRunOrVerifyItsStateFirst"),
          );
        if ([...this.terminalLeaseProjects.values()].includes(target.id))
          throw Error(
            tr("host.closeThisProjectSTerminalsFirstTheProjectRemainsIn"),
          );
        if(this.hasDemonstration(target.id))
          throw Error(tr("host.closeThisProjectSDemonstrationsFirstTheProjectRemainsIn"));
        const remaining = await this.state.removeProject(target);
        if (this.selectedContext?.projectId === target.id)
          this.selectedContext = null;
        return remaining;
      }),
    );
  }
  async addProject(folder: string): Promise<Project> {
    this.check();
    if (typeof folder !== "string" || !path.isAbsolute(folder))
      throw new Error(tr("host.chooseALocalFolder"));
    const canonical = await realpath(folder);
    if (!(await lstat(canonical)).isDirectory())
      throw Error(tr("host.chooseTheProjectFolderNotAFile"));
    // A project is a local directory. Git-root discovery is only a hint which
    // preserves canonical IDs for existing repositories, never an admission gate.
    let root = canonical;
    try {
      const discovered = (
        await withOfflineGitReadScope(() =>
          this.runner.command(
            "git",
            ["rev-parse", "--show-toplevel"],
            canonical,
          ),
        )
      ).stdout.trim();
      if (path.isAbsolute(discovered)) {
        const candidate = await realpath(discovered);
        const relative = path.relative(candidate, canonical);
        if (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        )
          root = candidate;
      }
    } catch (error) {
      if (error instanceof RunnerShutdownError) throw error;
      // Missing Git, no repository, or a failed Git probe do not grant any Git
      // authority. Its actual operations retain their independent strict guards.
    }
    this.check();
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
    if (doc.errors.length) throw new Error(tr("host.invalidProjectConfiguration"));
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
        throw new Error(tr("host.gogaReturnedAnInvalidTopicCatalog"));
      throw e;
    }
    if (!Array.isArray(rows)) throw new Error(tr("host.invalidTopicCatalog"));
    return rows
      .map((r) => {
        if (
          typeof r.topic !== "string" ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(r.topic) ||
          typeof r.branch !== "string" ||
          r.branch.startsWith("-")
        )
          throw new Error(tr("host.invalidGogaTopic"));
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
    if (request?.formReadId) {
      const scope = this.parseScope(request.context ?? request.projectId);
      const hint = this.formReads.claim(request.formReadId, scope, "task");
      return this.formSnapshot(scope, hint, "task", (_, reusable, year) =>
        this.readTopicTaskWithSettings(request, false, undefined, {reusable, year}));
    }
    return this.snapshot(request?.context ?? request?.projectId, () =>
      this.readTopicTaskWithSettings(request),
    );
  }
  private async readTopicTaskWithSettings(
    request: TopicTaskRequest,
    forLaunch = false,
    launchYear?: string,
    form?: { reusable?: FormRead; year: string },
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
      throw new Error(tr("host.invalidTaskRequest"));
    if (
      request.context &&
      (request.context.projectId !== request.projectId ||
        request.context.topic !== request.topic ||
        request.context.branch !== request.branch)
    )
      throw Error(tr("host.theTaskBelongsToAnotherContext"));
    // snapshot() already resolved this exact owner and its effective Git root.
    // Reuse that Project only for this read; every command and the final owner
    // resolution still check live paths. The launch path deliberately revalidates.
    const snapshot = this.context.getStore();
    const p =
      !forLaunch && snapshot?.projectId === request.projectId
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
      throw Error(tr("host.theTaskBelongsToAnotherContext"));
    // Catalog rows describe presentation, not authority to launch in an already
    // resolved checkout. Launch reads only this task and validates the live owner.
    const facts = form ? await this.formGitFacts(p, request.branch) : undefined;
    const settings = snapshot?.document.value;
    // Explicit executables and custom PATH can supply a different board provider.
    // Only the standard Goga contract equates current-topic membership with its directory.
    const standard = settings && standardFormBoard(settings);
    let count: number | undefined, localMetadata: boolean | undefined;
    if (form?.reusable && standard && taskOwner) {
      localMetadata = await hasLocalTopicMetadata(this.root(p), form.year, request.topic);
      count = localMetadata ? 1 : 0;
    } else if (form?.reusable && standard && facts?.branch === request.branch &&
        form.reusable.currentBranch === request.branch && form.reusable.currentTopicCount > 0 &&
        await hasLocalTopicMetadata(this.root(p), form.year, request.topic)) {
      localMetadata = true;
      count = form.reusable.currentTopicCount;
    } else if (!forLaunch) {
      const members = form?.reusable?.members;
      const member = members?.get(request.branch);
      // In a different checkout the topic directory is immutable at this
      // commit. A matching slug alone is not proof: observe the live ref
      // on both sides of the file read, and never use this on a write/launch.
      if (!taskOwner && standard && facts && facts.branch !== request.branch &&
          member?.topic === request.topic && member.oid === facts.commit) {
        count = 1;
      } else {
        // Only retry the index if this form previously admitted it. Other
        // providers and consumers retain their original catalog semantics.
        const index = members && form && !taskOwner && standard
          ? await this.primaryFormIndex(p, form.year)
          : undefined;
        const rows = index?.topics ?? await this.topics(p, taskOwner?.year ?? form?.year);
        count = rows.filter(t => t.branch === request.branch && t.topic === request.topic).length;
      }
    }
    if (count !== undefined && count > 1)
      throw new Error(tr("host.theTopicIsAmbiguousRefreshTheCatalog"));
    if (count === 0 && !taskOwner)
      throw new Error(
        tr("host.noTaskDataWasFoundForTheSelectedTopicRefresh"),
      );
    const relative = taskPath(
      request.topic,
      request.context?.year ?? this.context.getStore()?.binding?.year ?? launchYear,
    );
    const git = (args: string[]) => this.cmd(p, args, true);
    const current = facts?.branch ?? (await git(["branch", "--show-current"])).trim();
    if (taskOwner && current !== taskOwner.branch)
      throw Error(tr("host.theWorkingCopyBranchChangedSelectTheContextAgain"));
    const commit = facts?.commit ?? (
      await git([
        "rev-parse",
        "--verify",
        `refs/heads/${request.branch}^{commit}`,
      ])
    ).trim();
    if (!/^[a-f0-9]{40,64}$/.test(commit))
      throw new Error(tr("host.couldNotDetermineTheTopicBranch2"));
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
    const after = form ? await this.formGitFacts(p, request.branch) : undefined;
    if (
      (after?.branch ?? (await git(["branch", "--show-current"])).trim()) !== current ||
      // A working task is not pinned to an unrelated HEAD revision. Only
      // display/committed reads need their exact ref to remain coherent.
      ((!forLaunch || current !== request.branch) &&
        (after?.commit ?? (
          await git([
            "rev-parse",
            "--verify",
            `refs/heads/${request.branch}^{commit}`,
          ])
        ).trim()) !== commit) ||
      (localMetadata !== undefined && form &&
        await hasLocalTopicMetadata(this.root(p), form.year, request.topic) !== localMetadata) ||
      taskPath(
        request.topic,
        request.context?.year ?? this.context.getStore()?.binding?.year ?? launchYear,
      ) !== relative
    )
      throw new Error(
        tr("host.theBranchOrTaskChangedWhileBeingReadOpenThe"),
      );
    if (forLaunch) await this.validateBinding(p);
    assertReadActive();
    // Form reads run a read-only physical owner check at the outer return boundary.
    if (taskOwner && !form) await this.resolveTopicContext(taskOwner);
    assertReadActive();
    return taskDocument(this.root(p), request.branch, commit, relative, {
      ...value,
      ...(count === 0
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
      return Promise.reject(Error(tr("host.invalidTopicIdentity")));
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
            tr("host.cannotPrepareAWorkingCopyDuringAnActiveRunRepository"),
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
            tr("host.theTopicIsAbsentFromTheCurrentLocalCatalogRefresh"),
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
                  tr("host.theOriginalProjectFolderChangedSelectTheContextAgain"),
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
      throw Error(tr("host.invalidTopicIdentity2"));
    if (!("contextId" in request)) {
      const project = (await this.listProjects()).find(
        (p) => p.id === request.projectId,
      );
      if (!project) throw Error(tr("host.unknownProject2"));
      const owners = (await this.clones.list(request.projectId)).filter(
        (r) =>
          r.year === request.year &&
          r.topic === request.topic &&
          r.branch === request.branch &&
          !r.deletedAt,
      );
      if (owners.length > 1)
        throw Error(
          tr("host.topicOwnershipIsAmbiguousSelectTheExactWorkingCopy"),
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
        tr("host.theOriginalProjectFolderChangedSelectTheContextAgain"),
      );
    const verify = await this.assertTaskReady(ref, project.path, record);
    const after = await this.resolveTopicContext(ref);
    if (after.path !== record.path || after.revision !== record.revision)
      throw Error(tr("host.theWorkingCopyChangedDuringVerification"));
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
        tr("host.theOriginalProjectFolderChangedSelectTheContextAgain"),
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
        tr("host.theRegistryBelongsToThePreviousProjectFolderVerificationRequired"),
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
        const { project, document } = await this.state.readRegisteredProject(
          scopeProjectId(owner),
        );
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
            const current = await this.state.readRegisteredProject(project.id);
            if (document.version !== current.document.version)
              throw Error(
                tr("host.projectSettingsChangedOpenChangesAgain"),
              );
            if (
              current.project.path !== project.path ||
              root !== (await realpath(root))
            )
              throw Error(
                tr("host.theWorkingFolderChangedOpenChangesAgain"),
              );
            if (binding && typeof owner !== "string") {
              if (binding.projectPath !== (await realpath(project.path)))
                throw Error(
                  tr("host.theOriginalProjectFolderChangedUsingItInPlaceOf"),
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
                throw Error(tr("host.effectiveGitPathsDoNotMatchTheContext"));
              const fresh = await this.clones.resolveGitRead(owner);
              if (JSON.stringify(fresh) !== JSON.stringify(admission))
                throw Error(
                  tr("host.theGitOwnerOrOperationChangedOpenChangesAgain"),
                );
            }
            // Git and clone proofs can outlive either a settings change or an
            // external path rebind of the same project id. Check both again.
            const final = await this.state.readRegisteredProject(project.id);
            if (document.version !== final.document.version)
              throw Error(
                tr("host.projectSettingsChangedOpenChangesAgain"),
              );
            if (final.project.path !== project.path)
              throw Error(
                tr("host.theWorkingFolderChangedOpenChangesAgain"),
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
            error instanceof Error ? error.message : tr("host.gitReadFailed");
          for (const entry of document.value.env)
            if (entry.value)
              message = message.split(entry.value).join(tr("host.hidden"));
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
    return this.gitWorkspaceRead(
      scope,
      async (reader, context): Promise<GitWorkspaceSummary> => {
        // Only a genuinely absent primary .git is a supported local-folder state.
        // Broken metadata, permission failures and missing managed clones still fail.
        if (typeof context.scope === "string") {
          const marker = await lstat(path.join(context.root, ".git")).catch(
            (error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            },
          );
          if (!marker)
            return {
              scope: context.scope,
              repository: "missing",
              branch: null,
              changedFiles: 0,
              conflicts: 0,
            };
        }
        return reader.summary();
      },
    );
  }
  inspectGitDiscardRecovery(scope: ScopeRef) {
    return this.gitDiscardActions.inspectRecovery(this.parseScope(scope));
  }
  prepareGitDiscardRecovery(input: unknown) {
    return this.gitDiscardActions.prepareRecovery(input);
  }
  async executeGitDiscardRecovery(input: string) {
    this.assertLaunchAllowed();
    const token = gitDiscardTokenSchema.parse(input);
    return this.operation(() => this.gitDiscardActions.executeRecovery(token));
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
      throw Error(tr("host.thePausedRebaseHeadChanged"));
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
        throw Error(tr("host.ownershipOfThePausedRebaseChanged"));
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
        throw Error(tr("host.theConflictWorkingFolderDoesNotMatchTheOwner"));
      const settings = await this.state.read(scopeProjectId(owner));
      const stoppedRebase = this.stoppedRebaseConflictBinding(admission);
      const controls = await fingerprintNativeGitControls(context.root);
      const verify = async () => {
        await context.verify();
        assertStoppedRebaseOwnership(stoppedRebase);
        if (controls !== (await fingerprintNativeGitControls(context.root)))
          throw Error(tr("host.theGitOperationChangedOpenTheConflictAgain"));
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
    if (!binding.sourceCommonDir) throw Error(tr("host.theCloneSourceCouldNotBeVerified"));
    return [
      ...[
        path.join(this.clones.store.root, `.owner-${binding.contextId}.json`),
        path.join(binding.gitCommonDir, "desktop-owner.json"),
      ].map((file) => {
        const value = conflictRegular(file, 4096);
        if (!value) throw Error(tr("host.cloneOwnershipCouldNotBeVerified"));
        return ["file", file, value.identity];
      }),
      // Bind source redirection as opaque filesystem identity, not parsed Git
      // formats. Repeated owner checks must detect topology changes before a
      // publication, not only during the final Git-based clone validation.
      ...[
        path.join(binding.projectPath, ".git"),
        ...[
          "commondir",
          "gitdir",
          "objects/info/alternates",
          "objects/info/http-alternates",
        ].map((name) => path.join(binding.sourceCommonDir!, name)),
      ].map((file) => [
        "source-topology",
        file,
        conflictStat(file)?.isDirectory()
          ? conflictDirectory(file)
          : (conflictRegular(file, 65536)?.identity ?? "missing"),
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
    projectAlreadySerialized = false,
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
              throw Error(tr("host.theCloneOwnerChanged"));
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
                  tr("host.theOwnerOrOperationSettingsChangedPreviewAgain"),
                );
              if (binding && typeof owner !== "string") {
                if (
                  binding.projectPath !== (await realpath(project.path)) ||
                  JSON.stringify(await ownership()) !==
                    JSON.stringify(physicalOwner)
                )
                  throw Error(
                    tr("host.theCloneOwnerChangedSwitchingToTheOriginalProjectIs"),
                  );
                await this.clones.assertNativeOperationOwnerRecord(binding);
              }
              this.assertCatalog(epoch);
              if (
                settings.version !== (await this.state.read(project.id)).version
              )
                throw Error(tr("host.operationSettingsChanged"));
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
                throw Error(tr("host.theCloneOwnerChangedAfterTheOperation"));
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
                    tr("host.nfinalVerificationOfTheOwnerOrServiceLockFailed") +
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
        return readOnlyProbe || projectAlreadySerialized
          ? admit()
          : this.exclusive(scopeProjectId(owner), admit);
      }),
    );
  }
  private async gitCommitContext<T>(
    scope: ScopeRef,
    action: (context: GitCommitContext) => Promise<T>,
    discardRecovery = false,
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
                    tr("host.theWorkingFolderChangedPreviewTheCommitAgain"),
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
                      tr("host.theCloneOwnerChangedCommitsInTheOriginalFolderAre"),
                    );
                  await this.clones.store.assertOwned(row);
                  if (
                    JSON.stringify(this.nativeCloneOwnerProof(binding)) !==
                    JSON.stringify(physicalOwner)
                  )
                    throw Error(tr("host.thePhysicalOwnerOfTheCloneChanged"));
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
                if (!discardRecovery)
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
                          tr("host.theCloneBranchChangedPreviewTheCommitAgain"),
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
                        : tr("host.gitOperationFailed"),
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
    projectAlreadySerialized = false,
  ): Promise<T> {
    const id = gitBranchProjectSchema.parse(input);
    const serialize = (action: () => Promise<T>) =>
      projectAlreadySerialized ? action() : this.exclusive(id, action);
    return this.context.exit(() =>
      serialize(() =>
        this.snapshot(
          id,
          async () => {
            const settings = this.context.getStore()!;
            const project = settings.scopedProject;
            if (this.binding(project))
              throw Error(tr("host.branchManagementIsAvailableOnlyWithNoTopicSelected"));
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
                  tr("host.theWorkingFolderChangedPreviewTheOperationAgain"),
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
                    : tr("host.gitOperationFailed"),
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
            throw Error(tr("host.theCloneOwnerChanged"));
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
    // Both update entry points arrive here only when the user commits the
    // operation. Never create directories while displaying a board or preview.
    if (typeof scope !== "string") {
      if (scope.branch !== input.targetBranch)
        throw Error(tr("host.theRequestedBranchBelongsToAnotherTopic"));
      await ensureCloneTopicDirectory(await this.resolveTopicContext(scope));
    }
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
            throw Error(tr("host.theTopicIsNotTheCurrentBranchInThisContext"));
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
            throw Error(tr("host.theSourceIsNotADirectBranch"));
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
  /** Each hop completes its own native journal before the next write starts.
   * The enclosing repository action already serializes this project. */
  private async withOriginalTopicBranch(
    project: Project,
    branch: string,
    expectedOid: string,
    action: () => Promise<void>,
    diagnostic: (message: string) => void,
  ): Promise<void> {
    const root = await realpath(project.path);
    let original: string | undefined;
    const switchTo = async (target: string, returning = false) => {
      const result = await withNativeGitCompletion(() =>
        this.gitBranchContext(
          project.id,
          async (context) => {
            if (context.root !== root)
              throw Error(tr("host.theOriginalWorkingFolderChanged"));
            const engine = new GitBranchActions({
              context: async (_id, fn) => fn(context),
            });
            const inventory = await engine.inventory(project.id);
            if (!inventory.branch)
              throw Error(tr("host.switchingRequiresACurrentLocalBranch"));
            if (!returning) {
              original = inventory.branch;
              if (
                inventory.local.find(
                  (row) => row.ref === `refs/heads/${branch}`,
                )?.oid !== expectedOid
              )
                throw Error(
                  tr("host.theTopicBranchChangedAfterSyncChangesWereNotApplied"),
                );
            }
            if (inventory.branch === target)
              return {
                projectId: project.id,
                action: "switch-local" as const,
                status: "success" as const,
                changed: false,
                message: tr("host.thisBranchIsAlreadySelected"),
                log: "",
              };
            if (
              returning &&
              (inventory.branch !== branch || inventory.head !== expectedOid)
            )
              throw Error(
                tr("host.theCurrentBranchOrItsCommitChangedExternallyTheExternal"),
              );
            this.assertScopeWritable(this.context.getStore()!.scopedProject);
            if (this.terminalDeletionBlocked(project.id))
              throw Error(
                tr("host.aTerminalCommandIsUsingTheOriginalWorkingFolder"),
              );
            const preview = await engine.prepare({
              projectId: project.id,
              action: "switch-local",
              revision: inventory.revision,
              ref: `refs/heads/${target}`,
            });
            return engine.execute(preview.token);
          },
          true,
        ),
      );
      diagnostic(result.log);
      if (result.status !== "success")
        throw Error(
          [
            result.message,
            ...(result.recoveryPath
              ? [tr("host.recoveryFilesRecoverypath", { recoveryPath: result.recoveryPath })]
              : []),
          ].join("\n"),
        );
      return result.changed;
    };
    diagnostic(tr("host.switchingTheOriginalProjectToTopicBranchBranch", { branch: branch }));
    // An uncertain first hop must not authorize CLI execution or another write.
    const switched = await switchTo(branch);
    let failure: unknown;
    let failed = false;
    try {
      await action();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (switched) {
        diagnostic(tr("host.returningTheOriginalProjectToBranchOriginal", { original: original! }));
        try {
          await switchTo(original!, true);
          diagnostic(tr("host.originalBranchOriginalRestored", { original: original! }));
        } catch (error) {
          throw Error(
            [
              tr("host.couldNotReturnToTheOriginalBranchOriginalNoChanges", { original: original! }),
              failed
                ? failure instanceof Error
                  ? failure.message
                  : tr("host.gogaTopicsPropagateFailed")
                : tr("host.gogaTopicsPropagateCompletedTheCommandWasNotRepeated"),
              error instanceof Error ? error.message : String(error),
            ].join("\n"),
          );
        }
      }
    }
    if (failed) throw failure;
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
              const call = await this.invocation(scoped);
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
              const repositorySnapshot = this.context.getStore()!;
              const actions = new RepositoryActions({
                project: async () => {
                  this.check();
                  const project = (await this.listProjects()).find(
                    (p) => p.id === request.projectId,
                  );
                  if (!project) throw Error(tr("host.unknownProject"));
                  return project;
                },
                resolve: (ref) => this.resolveTopicContext(ref),
                inventory: () => this.clones.list(request.projectId),
                mergeTopic: (ref, source, verifySource) =>
                  withNativeGitCompletion(() =>
                    this.gitNativeSequenceContext(
                      ref,
                      async (context) => {
                        if (
                          this.contextActive(ref.contextId) ||
                          this.terminalDeletionBlocked(ref)
                        )
                          throw Error(
                            tr("host.stopTheRunAndActiveTerminalCommandsInTheTopic"),
                          );
                        const engine = new NativeGitSequence({
                          context: async (_scope, action) => action(context),
                        });
                        const preview = await engine.prepareStart(ref, {
                          operation: "merge",
                          source,
                        });
                        await verifySource();
                        return engine.execute(preview.token);
                      },
                      false,
                      true,
                    ),
                  ),
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
                  if (
                    (await this.state.read(request.projectId)).version !==
                    repositorySnapshot.document.version
                  )
                    throw Error(
                      tr("host.projectSettingsChangedRetryTheAction"),
                    );
                  this.assertCatalog(repositorySnapshot.catalogEpoch);
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
                withOriginalTopicBranch: (
                  branch,
                  expectedOid,
                  action,
                  diagnostic,
                ) =>
                  this.withOriginalTopicBranch(
                    scoped,
                    branch,
                    expectedOid,
                    action,
                    diagnostic,
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
      throw Error(tr("host.confirmationBelongsToAnotherProject"));
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
      throw Error(tr("host.theTerminalControllerIsAlreadyInstalled"));
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
        this.contextActive(ref.contextId) || this.terminalDeletionBlocked(ref) || this.hasDemonstration(ref.projectId,ref.contextId),
      current: this.selectedContext?.contextId === ref.contextId,
    };
  }
  private contextDeletionPreview(
    plan: ContextDeletionPlan,
  ): ContextDeletionPreview {
    return {
      token: plan.token,
      ...(plan.flow === "clone-after-topic"
        ? { purpose: "clone-after-topic" as const }
        : {}),
      contextId: plan.owner.contextId,
      stage: plan.stage,
      switchBranch: plan.primarySwitch?.to,
      clonePath: plan.path,
      ...(plan.schemaVersion === 4 ? {} : { aheadCount: plan.aheadCount }),
      requiresAheadConfirmation:
        plan.stage === "prepared" && plan.aheadCount > 0,
      details: [
        ...(plan.primarySwitch
          ? [
              tr("host.afterSwitchingToNoTopicTheOriginalFolderWillSwitch", { from: plan.primarySwitch.from, to: plan.primarySwitch.to }),
            ]
          : []),
        tr("host.idleSessionsForThisTopicWillBeClosedRunningCommands"),
        tr("host.theEntireWorkingCopyIncludingGitWillBeMovedTo"),
        plan.flow === "clone-after-topic"
          ? tr("host.theTopicWasAlreadyRemovedOnlyThisCopyWillBe")
          : tr("host.afterSwitchingToTheOriginalFolderGogaWillRemoveThe"),
        plan.schemaVersion === 4
          ? tr("host.theEntireCopyIncludingLocalFilesAndUnpushedCommitsWill")
          : tr("host.uncommittedUntrackedOrIgnoredFilesPreventRemovalNoArchiveRefs"),
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
        tr("host.aLegacyArchiveFirstJournalWasFoundCheckItManually"),
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
          throw Error(tr("host.theOriginalProjectFolderChanged"));
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
          throw Error(tr("host.theOriginalFolderIsBusy"));
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
            tr("host.deletingAnExternalBranchIsNotAuthorizedByThisConfirmation"),
          );
        const matching = refs.filter(
          (ref) =>
            ref.startsWith("refs/heads/") &&
            normalize(ref.slice("refs/heads/".length)) === plan.owner.topic,
        );
        if (matching.some((ref) => ref !== `refs/heads/${plan.owner.branch}`))
          throw Error(
            tr("host.aTopicWithTheSameNameInTheOriginalFolder"),
          );
        if (
          execute &&
          matching.length &&
          (
            await d.git(["rev-parse", "--verify", `${matching[0]}^{commit}`])
          ).trim() !== plan.primaryHead
        )
          throw Error(
            tr("host.theBranchInTheOriginalFolderChangedAfterRemovalWas"),
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
            tr("host.theTopicAppearedInTheOriginalFolderAfterConfirmationIts"),
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
            throw Error(tr("host.switchToTheOriginalFolderFirst"));
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
        throw Error(tr("host.theActiveContextCannotBeRemoved"));
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
              tr("host.branchCurrentbranchIsCheckedOutInTheOriginalFolderSelect", { currentBranch: currentBranch }),
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
          tr("host.theBranchInTheOriginalFolderChangedOpenTheConfirmation"),
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
      throw Error(tr("host.removalConfirmationBelongsToAnotherProjectOrOriginalFolder"));
    return plan;
  }
  async deleteContext(input: {
    projectId: string;
    token: string;
    allowAhead?: true;
  }): Promise<ContextDeletionResult> {
    this.check();
    if (!this.trashItem) throw Error(tr("host.systemTrashUnavailable"));
    return this.operation(async () => {
      const plan = await this.ownedContextDeletion(input);
      if (this.deletionGuards(plan.owner).active)
        throw Error(tr("host.theActiveContextCannotBeRemoved"));
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
                throw Error(tr("host.theActiveContextCannotBeRemoved"));
              if (latest.flow === "clone-after-topic")
                await this.assertCleanupTopicAbsent(
                  latest.owner,
                  latest.projectPath,
                  latest.schemaVersion === 4
                    ? "explicit-copy"
                    : "verified-absent",
                );
              else await this.contextTopicDeletion(latest);
            },
            stopIdleTerminals: async () => {
              await terminals?.stopIdle();
              if (this.terminalLeases.has(plan.owner.contextId))
                throw Error(
                  tr("host.couldNotVerifyClosureOfTheTopicSTerminalsIts"),
                );
            },
            trashItem: async (root) => {
              if (this.deletionGuards(plan.owner).active)
                throw Error(tr("host.theActiveContextCannotBeRemoved"));
              await this.trashItem!(root);
            },
          },
          input.allowAhead,
        );
        this.catalogEpoch++;
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
          tr("host.switchToTheOriginalFolderFirstTheContextToRemove"),
        );
      if (this.deletionGuards(plan.owner).active)
        throw Error(tr("host.theActiveContextCannotBeRemoved"));
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
              throw Error(tr("host.theOriginalFolderIsBusy"));
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
        const call = await this.invocation(project);
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
            tr("host.gogaOperationFailedCheckTheConfigurationAndRepositoryState"),
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
            tr("host.theConfirmedRemovalOwnerChangedConfirmAgain"),
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
            tr("host.theTopicHasAWorkingCopyTheOriginalFolderCannot"),
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
      throw Error(tr("host.theCatalogIsAvailableOnlyInTheOriginalProjectFolder"));
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
            const call = await this.invocation(project);
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
                tr("host.theGogaCommandFailedCheckTheProjectConfiguration"),
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
        tr("host.theRegistryBelongsToThePreviousProjectFolderVerificationRequired"),
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
      throw Error(tr("host.theTableIsAvailableOnlyInTheOriginalProjectFolder"));
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
              tr("host.topicStatusOwnershipIsAmbiguousRefreshTheContextList");
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
              tr("host.couldNotReadTheCurrentTopicStatusRefreshTheTable");
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
        throw Error(tr("host.theContextCatalogChangedRefreshTheList"));
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
      throw Error(tr("host.historyCleanupIsOnlyAvailableWithNoTopicSelected"));
    this.check();
    return parsed;
  }
  private async historyPruneAccess(projectId: string): Promise<PruneAccess> {
    this.assertHistoryPrimary(projectId);
    const project = await this.project(projectId);
    const call = await this.invocation(project);
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
          throw Error(tr("host.theProjectFolderChangedPreviewAgain"));
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
          : tr("host.couldNotPrepareCleanup");
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
          tr("host.theCleanupConfirmationExpiredOrWasAlreadyUsedOpenThe"),
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
          : tr("host.cleanupFailed");
      return { status: "error", changed, error: message, log: message };
    }
  }
  private async specificationsRead<T>(scope: ScopeRef, action: (project: Project) => Promise<T>) {
    this.check();
    const parsed = this.parseScope(scope);
    if (typeof parsed === "string" && this.context.getStore()?.binding)
      throw Error(tr("host.theWorkingCopyRequiresAnExactTopicContext"));
    return withOfflineGitReadScope(() => this.snapshot(parsed, async () => {
      const project = await this.project(parsed);
      assertReadActive();
      const result = await action(project);
      await this.validateBinding(project);
      assertReadActive();
      return result;
    }));
  }
  listProjectSpecifications(scope: ScopeRef) {
    return this.specificationsRead(scope, project => specifications.listProjectSpecifications(this.root(project)));
  }
  readProjectSpecification(scope: ScopeRef, relative: string) {
    return this.specificationsRead(scope, project => specifications.readProjectSpecification(this.root(project), relative));
  }
  private async historyRead<T>(
    scope: ScopeRef,
    action: (project: Project) => Promise<T>,
  ) {
    this.check();
    const parsed = this.parseScope(scope);
    if (typeof parsed === "string" && this.context.getStore()?.binding)
      throw Error(tr("host.theWorkingCopyRequiresAnExactTopicContext"));
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
      throw Error(tr("host.historyBelongsToADifferentTopicContext"));
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
            tr("host.theTopicHasAWorkingCopySelectItsExactContext"),
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
      throw Error(tr("host.theTopicBelongsToAnotherContext"));
    if (typeof parsed === "string" && this.context.getStore()?.binding)
      throw Error(tr("host.theWorkingCopyRequiresAnExactTopicContext"));
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
            tr("host.theTopicHasAWorkingCopySelectItsExactContext"),
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
      throw Error(tr("host.branchesAreAvailableOnlyInTheOriginalProjectFolder"));
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
        throw Error(tr("host.theContextCatalogChangedRefreshTheList"));
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
      throw Error(tr("host.theTopicBelongsToAnotherContext"));
    return this.snapshot(id, async () => {
      const context = await this.topicsContext(id);
      const details = await this.topicDomain.details(context, year, target);
      assertReadActive();
      if (context.owner) await this.resolveTopicContext(context.owner);
      assertReadActive();
      return details;
    });
  }
  private async assertCleanupTopicAbsent(
    owner: TopicContextRef,
    expectedPath?: string,
    mode: "verified-absent" | "explicit-copy" = "verified-absent",
  ) {
    return this.snapshot(owner.projectId, async () => {
      const project = await this.project(owner.projectId);
      if (expectedPath && project.path !== expectedPath)
        throw Error(tr("host.theOriginalFolderChanged"));
      const d = await this.topicsContext(owner.projectId);
      const refs = await readTopicRefInventory(d.git);
      if (ownTopicRefs(refs, owner.topic).length)
        throw Error(
          tr("host.theTopicSOwnBranchExistsCopyCleanupIsNot"),
        );
      if (
        (
          await diskOnlyTopicDirectories(d, refs, owner.year, [owner.topic])
        ).has(owner.topic)
      )
        throw Error(
          tr("host.theTopicDirectoryRemainsInTheOriginalFolderTheCopy"),
        );
      // For an explicitly selected copy the confirmed native command owns its
      // remote effects. Moving the local directory does not need an additional
      // server round-trip (in particular a clone-only topic can be offline).
      if (mode === "explicit-copy") return;
      const remotes = (await d.git(["remote"])).split("\n");
      if (
        remotes.includes("origin") &&
        (
          await d.git([
            "ls-remote",
            "--heads",
            "--",
            "origin",
            `refs/heads/${owner.branch}`,
          ])
        ).trim()
      )
        throw Error(tr("host.theBranchStillExistsOnOriginTheCopyWasKept"));
    });
  }
  private async topicRemovalAccess(
    request: TopicRemovalRequest,
  ): Promise<TopicRemovalAccess> {
    const { projectId, year } = request;
    const project = await this.project(projectId);
    const owners = async () =>
      (await this.clones.list(projectId)).filter(
        (o) =>
          o.year === year &&
          o.storageKind === "clone" &&
          o.ownership === "managed" &&
          !o.deletedAt,
      );
    const inventory = async (): Promise<RemovalInventory> => {
      // Mutation admission needs public Git state and registry ownership, not
      // repeated Goga status projections from every clone in the display table.
      assertReadActive();
      const before = await this.clones.list(projectId);
      const d = await this.topicsContext(projectId),
        local =
          request.action === "delete" && request.expectedRevision === undefined
            ? await readSelectedTopicDeletionSnapshot(d, year)
            : await readTopicMutationSnapshot(d, year);
      const after = await this.clones.list(projectId);
      if (JSON.stringify(before) !== JSON.stringify(after))
        throw Error(tr("host.theContextCatalogChanged"));
      return {
        projectId,
        projectPath: project.path,
        year,
        revision: digest(
          JSON.stringify([
            local.revision,
            before.map((r) => [r.contextId, r.revision, r.state]),
          ]),
        ),
        primaryState: local,
        refs: local.refs,
        owners: before.filter(
          (o) =>
            o.year === year &&
            o.storageKind === "clone" &&
            o.ownership === "managed" &&
            !o.deletedAt,
        ),
      };
    };
    const nativeContext = async (
      before: RemovalInventory,
      beforeCommand?: () => void,
    ) => {
      if (before.projectPath !== project.path)
        throw Error(tr("host.theOriginalFolderChanged"));
      const d = await this.topicsContext(projectId, undefined, beforeCommand);
      if (d.owner || d.root !== project.path)
        throw Error(tr("host.theWorkingCopyCannotBeSubstitutedForTheOriginalFolder"));
      d.removalFlow = true;
      d.assertPrimaryOwnerAvailable = async () => {
        const fresh = await owners();
        const key = (rows: WorktreeRecord[]) =>
          JSON.stringify(
            [...rows].sort((a, b) => a.contextId.localeCompare(b.contextId)),
          );
        if (
          fresh.some((o) => o.projectPath !== project.path) ||
          key(fresh) !== key(before.owners)
        )
          throw Error(
            tr("host.workingCopyOwnershipChangedConfirmRemovalAgain"),
          );
      };
      return d;
    };
    return {
      inventory,
      diskOnlyRemaining: async (after, topics) =>
        diskOnlyTopicDirectories(
          await this.topicsContext(projectId),
          after.refs,
          year,
          topics,
        ),
      inspect: async (owner, action) => {
        if (this.deletionGuards(owner).active)
          throw Error(tr("host.theCopyHasActiveSessions"));
        const recovery = await this.contextDeletionRecovery(owner);
        if (recovery) throw Error(tr("host.aCopyRemovalIsUnfinished"));
        return action === "delete"
          ? this.clones.captureWholeCopyIdentity(owner)
          : this.clones.captureRemovalBaseline(owner);
      },
      prepareNative: async (request, before) => {
        const d = await nativeContext(before);
        let topics: string[] = [];
        if (request.action === "delete") {
          const managed = new Set(before.owners.map((owner) => owner.topic));
          const noOwn = new Set(
            request.topics.filter(
              (topic) =>
                managed.has(topic) && !ownTopicRefs(before.refs, topic).length,
            ),
          );
          const diskOnly = await diskOnlyTopicDirectories(
            d,
            before.refs,
            year,
            [...noOwn],
          );
          topics = request.topics.filter(
            (topic) => !noOwn.has(topic) || diskOnly.has(topic),
          );
        }
        if (request.action === "delete" && !topics.length) return null;
        return this.topicDomain.prepare(
          d,
          {
            ...request,
            ...(request.action === "delete" ? { topics } : {}),
            expectedRevision: before.primaryState.revision,
          },
          before.primaryState,
        );
      },
      executeNative: async (token, before) => {
        // An admitted run/terminal need not change the clone registry. Check
        // live activity at the command boundary, after async CLI resolution.
        // A selected-delete ticket issues one Goga mutation for the whole batch.
        const selected = new Set(
          request.action === "delete" ? request.topics : [],
        );
        const targets = before.owners.filter((owner) =>
          selected.has(owner.topic),
        );
        let blocked = "";
        const d = await nativeContext(before, () => {
            const busy = targets.find(
              (owner) => this.deletionGuards(worktreeContextRef(owner)).active,
            );
            if (busy) {
              blocked = tr("host.topicTopicNowHasAnActiveSessionInItsCopy", { topic: busy.topic });
              throw Error(blocked);
            }
          }),
          key = await this.key(project);
        const previous = this.locks.get(key) ?? Promise.resolve();
        const next = previous
          .catch(() => {})
          .then(() => this.topicDomain.execute(d, token, before.primaryState));
        this.locks.set(key, next);
        try {
          const result = await next;
          return blocked
            ? { projectId, status: "failed" as const, message: blocked }
            : result;
        } finally {
          if (this.locks.get(key) === next) this.locks.delete(key);
        }
      },
      prepareCleanup: async (owner, baseline) => {
        const wholeCopy =
          !!baseline && "kind" in baseline && baseline.kind === "whole-copy";
        await this.assertCleanupTopicAbsent(
          owner,
          project.path,
          wholeCopy ? "explicit-copy" : "verified-absent",
        );
        const plan = await this.clones.prepareContextCleanup(
          owner,
          this.deletionGuards(owner),
          baseline,
          wholeCopy,
        );
        return this.contextDeletionPreview(plan);
      },
    };
  }
  async prepareTopicRemoval(input: TopicRemovalRequest) {
    if (this.context.getStore()?.binding)
      throw Error(tr("host.removalIsAvailableOnlyInTheOriginalProjectFolder"));
    const request = topicRemovalRequestSchema.parse(input);
    // The preview does not mutate the project. It must neither hold the global
    // operation queue nor leave an obsolete read blocking navigation/other work.
    return this.snapshot(request.projectId, async () => {
      assertReadActive();
      return this.topicRemovals.prepare(
        await this.topicRemovalAccess(request),
        request,
      );
    });
  }
  async executeTopicRemoval(input: { projectId: string; token: string }) {
    if (this.context.getStore()?.binding)
      throw Error(tr("host.removalIsAvailableOnlyInTheOriginalProjectFolder"));
    const parsed = topicRemovalTokenSchema.parse(input),
      prepared = this.topicRemovals.take(parsed.projectId, parsed.token);
    return this.operation(() =>
      this.exclusive(parsed.projectId, () =>
        this.snapshot(
          parsed.projectId,
          async () => {
            const result = await this.topicRemovals.execute(
              await this.topicRemovalAccess(prepared.request),
              prepared,
            );
            return result;
          },
          false,
        ),
      ),
    );
  }
  async prepareTopicCloneCleanup(
    input: TopicCloneCleanupRequest,
  ): Promise<ContextDeletionPreview> {
    const request = topicCloneCleanupRequestSchema.parse(input),
      owner = request.owner;
    return this.operation(() =>
      this.exclusive(owner.projectId, () =>
        this.snapshot(owner.projectId, async () => {
          const recovery = await this.contextDeletionRecovery(owner);
          if (recovery) {
            if (recovery.purpose !== "clone-after-topic")
              throw Error(
                tr("host.finishThePreviousRemovalOfThisContextFirst"),
              );
            // A prepared cleanup has not moved any data: an explicit recheck must
            // bind a new snapshot/consent. Later stages keep their original journal.
            if (recovery.stage !== "prepared") return recovery;
          }
          const row = await this.resolveTopicContext(owner);
          await this.assertCleanupTopicAbsent(owner, row.projectPath);
          const baseline = request.operationToken
            ? this.topicRemovals.baseline(request.operationToken, owner)
            : undefined;
          return this.contextDeletionPreview(
            await this.clones.prepareContextCleanup(
              owner,
              this.deletionGuards(owner),
              baseline && !("kind" in baseline) ? baseline : undefined,
            ),
          );
        }),
      ),
    );
  }
  async prepareTopicOperation(request: TopicOperationRequest) {
    if (request?.action === "clear")
      throw Error(tr("host.useTheSeparateTopicCleanupConfirmation"));
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
            throw Error(tr("host.contextBelongsToAnotherTopic"));
          if (
            request.context &&
            ["create", "switch", "delete"].includes(request.action)
          )
            throw Error(
              tr("host.useTheDedicatedActionToCreateSelectOrDeleteA"),
            );
          let checked = request;
          if (!request.context) {
            const global = await this.readTopicBoard(
              request.projectId,
              request.year,
            );
            if (global.revision !== request.expectedRevision)
              throw Error(tr("host.theCatalogChangedRefresh"));
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
              throw Error(tr("host.theCatalogChangedCreateANewPreview"));
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
                tr("host.selectedBaseBaserefImmutableCommitSourceoidTheOriginalFolderIs", { baseRef: base.baseRef, sourceOid: base.sourceOid }),
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
      throw new Error(tr("host.invalidBuildSelection"));
    validateBuildOptions(selection);
    selection = structuredClone(selection);
    return this.snapshot(id, async () => {
      const p = await this.project(id);
      const before = await this.fingerprint(p);
      const call = await this.invocation(p);
      const reads = [
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
      ] as const;
      const [help, branch, refs, workflows, profiles] = await Promise.all(
        reads,
      ).catch(async (error) => {
        // Peers can still hold settings locks; retain ownership until all settle.
        await Promise.allSettled(reads);
        throw error;
      });
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
          tr("host.couldNotReadTheReviewSettingFromGogaCheckThe");
      }
      if (effectiveReview !== undefined) {
        try {
          defaults.skipReview = buildReviewDefault(effectiveReview);
        } catch {
          defaults.reviewError =
            tr("host.gogaReturnedAnInvalidReviewSettingCheckTheVersionAnd");
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
        historyPlan.errorCode = "history";
        historyPlan.error = buildPlanProblem(
          Error("[build-plan:history]"),
        ).message;
      }
      if (candidate) {
        historyPlan.path = candidate;
        try {
          historyPlan.path = (await readPlan(this.root(p), candidate)).path;
        } catch (error) {
          const problem = buildPlanProblem(error, true);
          historyPlan.errorCode = problem.code;
          historyPlan.error = problem.message;
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
        throw new Error(tr("host.theBuildContextChangedRefresh"));
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
    if (!parsed.success) throw new Error(tr("host.invalidBuildRequest"));
    const request = structuredClone(parsed.data);
    this.validateRepeatRequest(request);
    validateBuildOptions(request.options);
    if (request.context && request.context.projectId !== request.projectId)
      throw Error(tr("host.contextBelongsToAnotherProject"));
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
      throw new Error(tr("host.confirmClearingBuildState"));
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
      throw new Error(tr("host.theCurrentBranchChangedRefreshTheBuild"));
    if (context.revision !== request.contextRevision)
      throw new Error(
        tr("host.theBuildContextIsStaleOrItsSettingsChangedRefresh"),
      );
    const plan = await readPlan(this.root(p), request.planPath);
    if (plan.version !== request.planVersion)
      throw new Error(tr("host.thePlanChangedOpenItAgainBeforeBuilding"));
    const invocation = await this.invocation(p);
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
      throw new Error(tr("host.workflowNotFound"));
    if (
      options.profile &&
      !context.profiles.some((p) => p.name === options.profile)
    )
      throw new Error(tr("host.selectedProfileNotFound"));
    const runtime = {
      ...(await buildHomeEnvironment(this.home)),
      ...Object.fromEntries(options.env.map((e) => [e.key, e.value])),
    };
    const workflow = options.workflow || runtime.GOGA_WORKFLOW || "";
    if (options.profile && !workflow)
      throw new Error(
        tr("host.aBuildProfileCannotBeAppliedWithoutAWorkflowSelect"),
      );
    if (options.baseRef && !context.branches.includes(options.baseRef))
      throw new Error(
        tr("host.selectAnExistingLocalOrRemoteComparisonBranch"),
      );
    if (context.defaults.reviewError && options.skipReview === undefined)
      throw new Error(context.defaults.reviewError);
    const configuredSecrets = await buildConfigurationSecrets(
      this.root(p),
      this.home,
    );
    const final = await this.buildContext(p.id, selection);
    if (final.revision !== context.revision || final.branch !== context.branch)
      throw new Error(tr("host.theBuildContextChangedBeforeLaunch"));
    if (
      (await readPlan(this.root(p), request.planPath)).version !== plan.version
    )
      throw new Error(tr("host.thePlanChangedBeforeLaunch"));
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
      pipeline: "build", // Stable journal identifier. Translate the build kind only for display.
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
      this.localRunAdmissions.add(run);
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
      this.localRunAdmissions.delete(run);
      this.removeActiveRun(key, run.id);
      run.status = "failed";
      run.endedAt = new Date().toISOString();
      if (this.runList.includes(run)) await this.persistRuns().catch(() => {});
      throw new Error(
        tr("host.couldNotStartTheBuildCheckTheExecutableAndEnvironment"),
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
    const output = captureRunOutput(child, secrets, (snapshot,end) =>
      this.publishRunOutput(run,snapshot,end),
    );
    const onClose = (code: number | null) => {
      void this.terminateOwned(
        run.id,
        code === 0 ? "exited" : "failed",
        code === 0
          ? undefined
          : { kind: "build-exit", code },
      ).catch(() => {});
    };
    const onError = () => {
      void this.terminateOwned(
        run.id,
        "failed",
        { kind: "build-spawn" },
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
    this.localRunAdmissions.delete(run);
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
      throw Error(tr("host.originalBuildNotFound"));
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
        tr("host.theRepeatRequestBelongsToAnotherContextPrepareTheOriginal"),
      );
    const required = source.buildRepeat;
    const effective = new Map(
      (request.options.env ?? []).map((e) => [e.key, e.value]),
    );
    if (required?.requiredEnvKeys.some((k) => !effective.get(k)?.trim()))
      throw Error(tr("host.enterMissingEnvironmentValuesFromTheOriginalBuild"));
    if (required?.requiresProxy && !request.options.proxy)
      throw Error(tr("host.enterTheMissingProxyFromTheOriginalBuild"));
  }
  async prepareBuildRepeat(id: string): Promise<BuildRepeatPreparation> {
    this.check();
    const source = this.runList.find((r) => r.id === id);
    if (!source || source.kind !== "build" || !source.build)
      throw Error(tr("host.originalBuildMissing"));
    if (["starting", "running"].includes(source.status))
      throw Error(tr("host.waitForTheOriginalBuildToFinish"));
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
      throw new Error(tr("host.invalidCleanupConfirmation"));
    const original = this.buildRequests.get(id);
    if (!original || !this.runList.some((r) => r.id === id))
      throw new Error(tr("host.theOriginalBuildCannotBeRepeated"));
    return this.launchBuild({ ...structuredClone(original), confirmClean });
  }
  async checkoutBranch(id: ScopeRef): Promise<string> {
    return this.pipelineBranch(await this.project(id));
  }
  /** Absence is supported only for original local folders. Corrupt metadata,
   * permission errors and missing managed repositories must still fail closed. */
  private async hasProjectGit(p: Project): Promise<boolean> {
    if (this.binding(p)) return true;
    try {
      await lstat(path.join(this.root(p), ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  private async pipelineBranch(p: Project): Promise<string> {
    return (await this.hasProjectGit(p))
      ? (await this.cmd(p, ["branch", "--show-current"], true)).trim()
      : "";
  }
  async discover(id: ScopeRef, options?: LaunchDiscoveryOptions): Promise<Discovery> {
    if (options?.forLaunchForm === true) {
      const scope = this.parseScope(id);
      const {result, hint} = await this.formSnapshot(scope, undefined, "discover", async (project, _, year) => {
        const snapshot = this.context.getStore()!;
        const { discovery: result, members } = await this.discoverWithSettings(scope, project, year);
        const hint: FormRead = {
          members,
          projectPath: project.path, binding: snapshot.binding, epoch: snapshot.catalogEpoch,
          settingsVersion: snapshot.document.version, year, currentBranch: result.currentBranch,
          currentTopicCount: result.topics.filter(t => t.branch === result.currentBranch && t.topic === slug(result.currentBranch)).length,
        };
        return {result, hint};
      });
      return {...result, formReadId: this.formReads.issue(scope, hint)};
    }
    return this.snapshot(id, async () => (await this.discoverWithSettings(id)).discovery);
  }

  private async primaryFormIndex(p: Project, year: string) {
    const snapshot = this.context.getStore();
    if (!snapshot?.formDisplay || this.binding(p) || !standardFormBoard(snapshot.document.value))
      return;
    this.check();
    assertReadActive();
    await this.assertSettings(p.id);
    const { executable, env } = await this.invocation(p);
    const index = await readLaunchTopicIndex({
      cwd: this.root(p), year, executable, env, runner: this.runner,
    });
    // An unsupported installation may fall back; an aborted read or failure
    // running Goga's hooks must not launch a second provider.
    this.check();
    assertReadActive();
    return index;
  }

  private async launchChoices(
    p: Project,
    repository: boolean,
    pinned: WorktreeRecord | undefined,
    relatedReads: Promise<unknown>[],
    formYear?: string,
  ): Promise<Pick<Discovery, "topics" | "branches" | "currentBranch"> & { byBranch?: FormRead["members"] }> {
    if (!repository || pinned)
      return { topics: [], branches: [], currentBranch: pinned?.branch ?? "" };
    if (formYear) {
      const index = await this.primaryFormIndex(p, formYear);
      if (index) return index;
    }
    const reads = [
      this.topics(p, formYear),
      this.cmd(p, ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], true),
      this.cmd(p, ["branch", "--show-current"], true),
    ] as const;
    // Let the outer discovery retain these sibling reads, while observing the
    // first failure immediately instead of masking it behind a slower sibling.
    relatedReads.push(...reads);
    const [topics, refs, head] = await Promise.all(reads);
    return {
      topics,
      branches: refs.trim().split("\n").filter(b => b && !b.endsWith("/HEAD")),
      currentBranch: head.trim(),
    };
  }

  private async discoverWithSettings(id: ScopeRef, formProject?: Project, year?: string): Promise<{
    discovery: Discovery; members?: FormRead["members"];
  }> {
    const p = formProject ?? await this.project(id);
    const pinned = formProject && this.binding(formProject);
    const repository = await this.hasProjectGit(p);
    const relatedReads: Promise<unknown>[] = [];
    const reads = [
      this.cmd(p, ["pipeline", "--list", "--info"]),
      this.launchChoices(p, repository, pinned, relatedReads, year),
      this.config(p),
      this.names(path.join(this.root(p), ".goga/workflows")),
      this.names(path.join(this.home, ".goga/profiles")),
      this.names(path.join(this.root(p), ".goga/profiles")),
    ] as const;
    const [
      catalog,
      choices,
      config,
      workflows,
      homeProfiles,
      projectProfiles,
    ] = await Promise.all(reads).catch(async (error) => {
      // Peers can still hold settings locks; retain ownership until all settle.
      await Promise.allSettled(reads);
      // The choices read may have registered these peers after another top-level
      // promise failed; drain only once all the top-level promises settled.
      await Promise.allSettled(relatedReads);
      throw error;
    });
    const profiles = new Map<string, "home" | "project">(
      homeProfiles.map((n) => [n, "home"]),
    );
    for (const n of projectProfiles) profiles.set(n, "project");
    const discovery: Discovery = {
      repository: repository ? "ready" : "missing",
      projectSettings: {
        version: this.context.getStore()!.document.version,
        profile: (await this.invocation(p)).value.profile,
        executable: (await this.invocation(p)).executable,
      },
      pipelines: parseCatalog(catalog),
      topics: choices.topics,
      branches: choices.branches,
      currentBranch: choices.currentBranch,
      baseRef:
        typeof config?.topics?.base_ref === "string"
          ? config.topics.base_ref
          : undefined,
      workflows,
      profiles: [...profiles]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, source]) => ({ name, source })),
    };
    return { discovery, members: choices.byBranch };
  }
  private normalize(r: PipelineRequest): PipelineRequest {
    if (!r || typeof r.projectId !== "string")
      throw new Error(tr("host.invalidRequest"));
    if (
      r.profileMode !== undefined &&
      !["project", "auto"].includes(r.profileMode)
    )
      throw new Error(tr("host.invalidProfileSelection"));
    if (r.profileMode === "auto" && r.profile)
      throw new Error(tr("host.invalidProfileSelection"));
    pipelineArgs(r, true);
    if (r.context && r.context.projectId !== r.projectId)
      throw Error(tr("host.contextBelongsToAnotherProject"));
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
  private async fingerprint(p: Project, formDisplay = false) {
    const repository = await this.hasProjectGit(p);
    const facts = repository && formDisplay ? await this.formGitFacts(p) : undefined;
    const chunks: string[] = [
      facts ? facts.commit + "\n" : repository
        ? await this.cmd(p, ["rev-parse", "HEAD"], true)
        : "local-folder:no-git",
      facts ? (facts.branch ? facts.branch + "\n" : "") :
        repository ? await this.cmd(p, ["branch", "--show-current"], true) : "",
      process.env.GOGA_PROFILE ?? "",
      (await this.state.read(p.id)).version,
      JSON.stringify((await this.invocation(p)).value),
    ];
    const walk = async (dir: string, depth = 0) => {
      if (depth > 8) throw new Error(tr("host.gogaDefinitionsAreNestedTooDeeply"));
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
            tr("host.symbolicLinksInGogaDefinitionsAreNotSupported"),
          );
        if (e.isDirectory()) await walk(file, depth + 1);
        else if (e.isFile()) {
          const info = await lstat(file);
          if (info.size > 4 * 1024 * 1024)
            throw new Error(tr("host.gogaDefinitionsAreTooLarge"));
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
        throw new Error(tr("host.workflowNotFoundInThisProject"));
    }
    const explicit =
      r.profile ||
      (r.profileMode === "auto"
        ? ""
        : (await this.invocation(p)).value.profile);
    // Goga only resolves profiles when a workflow is active.
    if (
      workflow &&
      explicit &&
      !(await this.profiles(p)).some((x) => x.name === explicit)
    )
      throw new Error(
        tr("host.theSelectedProfileIsMissingRefreshTheProfileList"),
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
  async preview(request: PipelinePreviewRequest): Promise<Preview> {
    if (request?.formReadId) {
      const scope = this.parseScope(request.context ?? request.projectId);
      const hint = this.formReads.claim(request.formReadId, scope, "preview");
      return this.formSnapshot(scope, hint, "preview", project => this.previewWithSettings(request, project));
    }
    return this.snapshot(request?.context ?? request?.projectId, () =>
      this.previewWithSettings(request),
    );
  }
  private async previewWithSettings(
    request: PipelineRequest,
    formProject?: Project,
  ): Promise<Preview> {
    const r = this.normalize(request),
      p = formProject ?? await this.project(r.projectId);
    const epoch = this.context.getStore()!.catalogEpoch;
    this.assertCatalog(epoch);
    const before = await this.fingerprint(p, !!formProject);
    const composed = await this.compose(p, r);
    if (before !== (await this.fingerprint(p, !!formProject)))
      throw new Error(
        tr("host.definitionsChangedDuringPreviewRefreshThePreview"),
      );
    this.assertCatalog(epoch);
    const result = { ...composed, token: randomUUID() };
    return result;
  }
  private publicRun(run: Run): Run {
    const { process: _private, ...visible } = run;
    return structuredClone(visible);
  }
  hasRun(id: string): boolean {
    return this.runList.some((run) => run.id === id);
  }
  runs(): Run[] {
    return this.runList.map((run) => this.publicRun(run));
  }
  /** Navigation, dashboards and notifications observe lifecycle, not raw journal content. */
  runCatalog(): Run[] {
    return this.runList.map(({ process: _private, output: _output, ...row }) => structuredClone(row));
  }
  private publishRunOutput(run: Run, output: RunOutput, end: number) {
    run.output = output;
    if (!this.runList.includes(run)) return;
    const sequence = (this.journalHeads.get(run)?.sequence ?? 0) + 1;
    this.journalHeads.set(run, {end,sequence});
    this.emit("run-output", run.id, sequence);
    // Ordinary stdout was already excluded from the durable signature. Retry
    // a failed save as before; finalization and all metadata changes still save.
    if (!this.lastRunSave) void this.persistRuns().catch(() => {});
  }
  readRunJournal(id: string, after?: number): RunJournalSlice {
    this.check();
    const run = this.runList.find(r => r.id === id);
    if (!run) throw Error(tr("host.unknownRun"));
    const output = run.output ?? {text:"",truncated:false};
    const head = this.journalHeads.get(run);
    const end = head?.end ?? output.text.length, start = end - output.text.length;
    const from = after !== undefined && after >= start && after <= end ? after : start;
    return {id, sequence:head?.sequence ?? 0, start, from, end,
      truncated:output.truncated, text:output.text.slice(from-start)};
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
        ...(run.pipelineRepeat ? [run.pipelineRepeat] : []),
        ...(run.dashboardRecoveryVersion ? [run.dashboardRecoveryVersion] : []),
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
  private clearDashboard(run: Run) {
    delete run.url;
    delete run.dashboardReconnect;
    delete run.dashboardRunId;
    delete run.dashboardMessage;
  }
  private canReconcileStoredRun(run: Run): boolean {
    return (
      (run.status === "starting" || run.status === "running") &&
      !this.localRunAdmissions.has(run) &&
      !this.children.has(run.id) &&
      this.runList.includes(run)
    );
  }
  private async reconcileStoredRun(run: Run) {
    const active = () => this.canReconcileStoredRun(run);
    if (!active()) return;
    if (!this.recovery) {
      this.clearDashboard(run);
      run.recovery = "unverified";
      run.recoveryMessage =
        tr("host.noVerifiableRecoveryChannelIsAvailableForThisRun");
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
      if (!active()) return;
      const result = await this.recovery.reconcile(
        run.process,
        this.runOwnerHash(run),
        this.root(p),
      );
      if (!active()) return;
      if (result.state === "terminal") {
        run.status = result.status;
        run.endedAt = result.endedAt;
        delete run.recovery;
        delete run.recoveryMessage;
        this.clearDashboard(run);
        run.dashboardOpened = false;
        this.releaseRecoveredTerminalRun(run.id);
        if (run.context) run.syncPending = true;
      } else if (result.state === "alive") {
        run.recovery = "confirmed";
        delete run.recoveryMessage;
        if (
          run.dashboardRecoveryVersion === 1 &&
          run.kind !== "build" &&
          run.process
        ) {
          try {
            await this.restoreSavedDashboard(run);
          } catch {
            if (!active()) return;
            this.clearDashboard(run);
            run.dashboardMessage =
              tr("host.theDashboardIsNotReadyOrItsSourceChangedReconnect");
          }
        }
      } else {
        this.clearDashboard(run);
        run.recovery = "unverified";
        run.recoveryMessage = result.message;
      }
    } catch {
      if (!active()) return;
      this.clearDashboard(run);
      run.recovery = "unverified";
      run.recoveryMessage =
        tr("host.theOriginalContextOrStoredProcessDataIsUnavailableNo");
    }
  }
  async reconcileRun(id: string): Promise<Run> {
    this.check();
    const run = this.runList.find((r) => r.id === id);
    if (!run) throw Error(tr("host.unknownRun"));
    if (this.canReconcileStoredRun(run)) await this.reconcileStoredRun(run);
    await this.persistRuns();
    await this.syncCompletedRun(run);
    this.emitRuns();
    return this.publicRun(run);
  }
  private emitRuns() {
    void this.persistRuns().catch(() => {});
    this.emit("runs", this.runCatalog());
  }
  private async key(p: Project) {
    const dir = (
      await this.cmd(p, ["rev-parse", "--git-common-dir"], true)
    ).trim();
    return realpath(path.resolve(this.root(p), dir));
  }
  private async pipelineLaunchKey(p: Project) {
    return (await this.hasProjectGit(p))
      ? this.key(p)
      : "local-folder:" + (await realpath(this.root(p)));
  }
  async launch(request: LaunchRequest): Promise<Run> {
    this.assertLaunchAllowed();
    if (request?.update !== undefined && typeof request.update !== "boolean")
      throw new Error(tr("host.invalidUpdateOption"));
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
  /** Repeat choices, not a cached launch request or a second launch implementation. */
  repeatPipeline(id: string): Promise<Run> {
    const pending = this.pipelineRepeatFlights.get(id);
    if (pending) return pending;
    const operation = Promise.resolve().then(() => {
      this.assertLaunchAllowed();
      const source = this.runList.find((run) => run.id === id);
      if (!source || source.kind === "build") throw Error(tr("host.theOriginalPipelineRunIsMissing"));
      if (!source.pipelineRepeat) throw Error(tr("host.fullRepeatSettingsWereNotSavedForThisRunCreate"));
      const context = source.context ? {
        projectId: source.context.projectId,
        year: source.context.year,
        topic: source.context.topic,
        branch: source.context.branch,
        contextId: source.context.contextId,
        revision: source.context.revision,
      } : undefined;
      const scope = context ?? source.projectId;
      return this.operation(() => this.exclusive(source.projectId, () => this.snapshot(scope, async () => {
        this.assertLaunchAllowed();
        if (!this.runList.includes(source)) throw Error(tr("host.theOriginalRunWasAlreadyClosed"));
        if (["starting", "running"].includes(source.status) || source.recovery === "unverified" || this.children.has(id) || this.stopFlights.has(id))
          throw Error(tr("host.waitUntilTheOriginalRunIsConfirmedFinishedForA"));
        const options = pipelineRepeatSnapshotSchema.parse(source.pipelineRepeat);
        const { version: _version, ...choices } = options;
        return this.launchWithSettings({
          ...choices,
          projectId: source.projectId,
          ...(context ? { context } : {}),
          pipeline: source.pipeline,
          ...pipelineDisplayMetadata(source),
          expectedBranch: source.branch,
          confirmBranchSwitch: false,
          topic: source.topic ? { mode: "existing", topic: source.topic, branch: source.branch } : { mode: "none" },
          task: "",
          confirmEmptyTask: false,
        }, source.taskSnapshot?.year);
      }, false)));
    }).finally(() => {
      if (this.pipelineRepeatFlights.get(id) === operation) this.pipelineRepeatFlights.delete(id);
    });
    this.pipelineRepeatFlights.set(id, operation);
    return operation;
  }
  private async launchWithSettings(request: LaunchRequest, taskYear?: string): Promise<Run> {
    this.assertLaunchAllowed();
    assertEnvironmentTransport(this.context.getStore()!.document.value.env);
    if (typeof request?.clean !== "boolean")
      throw new Error(tr("host.invalidCleanStateOption"));
    if (
      typeof request.expectedBranch !== "string" ||
      request.expectedBranch.length > 256 ||
      typeof request.confirmBranchSwitch !== "boolean"
    )
      throw new Error(tr("host.invalidConfirmationOfTheCurrentBranch"));
    if (
      typeof request.confirmEmptyTask !== "boolean" ||
      "confirmTaskOverwrite" in request ||
      (request.taskVersion !== undefined &&
        (request.topic?.mode !== "existing" ||
          typeof request.taskVersion !== "string" ||
          !/^[a-f0-9]{64}$/.test(request.taskVersion)))
    )
      throw new Error(
        tr("host.invalidTaskVersionTheDraftWasNotSaved"),
      );
    if (
      request.topic?.mode === "none" &&
      (Object.keys(request.topic).some((key) => key !== "mode") ||
        request.task !== "" ||
        request.confirmEmptyTask ||
        request.confirmBranchSwitch)
    )
      throw Error(
        tr("host.aRunWithoutATopicDoesNotSaveATask"),
      );
    const r = this.normalize(request),
      p = await this.project(r.projectId);
    await guardedProject(this.root(p));
    const key = await this.pipelineLaunchKey(p);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.prepare(p, key, r, request, taskYear));
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  /** One confirmed creation intent; all execution admission is reused in the clone. */
  private async launchNewTopicInClone(
    primary: Project,
    pipeline: PipelineRequest,
    request: LaunchRequest,
  ): Promise<Run> {
    if (request.topic.mode !== "new" || this.binding(primary))
      throw Error(tr("host.createNewTopicsFromTheOriginalProject"));
    const base = (
      await this.cmd(
        primary,
        [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${request.topic.baseRef}^{commit}`,
        ],
        true,
      )
    ).trim();
    const owner = await this.clones.create(primary, {
      year: String(new Date().getFullYear()),
      branch: request.topic.name,
      baseRef: base,
    });
    try {
      await this.assertSettings(primary.id);
      const context = worktreeContextRef(owner);
      return await this.snapshot(
        context,
        async () => {
          const scoped = { ...pipeline, context };
          const task = await this.readTopicTaskWithSettings(
            {
              projectId: primary.id,
              context,
              topic: owner.topic,
              branch: owner.branch,
            },
            true,
          );
          return this.launchWithSettings({
            ...request,
            ...scoped,
            topic: {
              mode: "existing",
              topic: owner.topic,
              branch: owner.branch,
            },
            expectedBranch: owner.branch,
            confirmBranchSwitch: false,
            taskVersion: task.version,
          });
        },
        false,
      );
    } catch (error) {
      throw Error(
        tr("host.value1TheWorkingCopyForTopicTopicIsReadyPath", { value1: error instanceof Error ? error.message : String(error), topic: owner.topic, path: owner.path }),
      );
    }
  }
  private async prepare(
    p: Project,
    key: string,
    r: PipelineRequest,
    request: LaunchRequest,
    taskYear?: string,
  ): Promise<Run> {
    this.check();
    this.assertRunAdmission(p, key, "pipeline");
    validateTaskText(request.task);
    const selection = request.topic;
    if (!selection || !["none", "existing", "new"].includes(selection.mode))
      throw new Error(tr("host.selectATopic"));
    const repository = await this.hasProjectGit(p);
    if (!repository && selection.mode !== "none")
      throw Error(
        tr("host.topicsRequireAGitRepositorySelectNoTopicToLaunch"),
      );
    const current = await this.pipelineBranch(p);
    if (
      this.binding(p) &&
      (request.topic.mode !== "existing" ||
        request.topic.branch !== this.binding(p)!.branch ||
        request.topic.topic !== this.binding(p)!.topic)
    )
      throw Error(tr("host.selectTheTopicThatOwnsThisClone"));
    const assertBranch = async (expected: string) => {
      if (
        (await this.hasProjectGit(p)) !== repository ||
        (await this.pipelineBranch(p)) !== expected
      )
        throw new Error(
          tr("host.theCurrentBranchChangedOutsideTheAppRefreshTheCatalog"),
        );
    };
    if (current !== request.expectedBranch)
      throw new Error(
        tr("host.theCurrentBranchChangedOutsideTheAppRefreshTheCatalog"),
      );
    if (
      (selection.mode === "new" ||
        (selection.mode === "existing" && selection.branch !== current)) &&
      !request.confirmBranchSwitch
    )
      throw new Error(tr("host.confirmTheBranchSwitchBeforeLaunch"));
    if (
      (selection.mode === "new" ||
        (selection.mode === "existing" && selection.branch !== current)) &&
      this.activeRuns(p, key).length
    )
      throw new Error(
        tr("host.cannotSwitchOrCreateABranchWhileAProcessIs"),
      );
    let branch: string, topic: string, launchTaskPath: string | undefined;
    let mutated = false;
    let taskSnapshot: TopicTaskDocument | undefined;
    const taskConflict = () =>
      Error(
        tr("host.theTaskChangedOutsideTheAppItWasNotOverwritten"),
      );
    const assertTaskWrite = async () => {
      if (!taskSnapshot || request.taskVersion === undefined) return;
      const actual = await readWorkingTask(this.root(p), taskSnapshot.path);
      if (
        actual.text !== taskSnapshot.text ||
        actual.exists !== taskSnapshot.exists
      )
        throw taskConflict();
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
          throw new Error(tr("host.invalidBranchName"));
        await this.cmd(p, ["check-ref-format", "--branch", branch], true);
        topic = slug(branch);
        if (!topic)
          throw new Error(
            tr("host.aTopicNameMustContainLatinLettersOrDigits"),
          );
        if (
          typeof selection.baseRef !== "string" ||
          !selection.baseRef ||
          selection.baseRef.startsWith("-") ||
          /[\x00-\x20]/.test(selection.baseRef)
        )
          throw new Error(tr("host.invalidSourceBranch"));
        await this.cmd(
          p,
          ["rev-parse", "--verify", `${selection.baseRef}^{commit}`],
          true,
        );
        if ((await this.cmd(p, ["status", "--porcelain"], true)).trim())
          throw new Error(
            tr("host.thereAreUncommittedChangesSaveOrSetThemAsideBefore"),
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
            tr("host.theBranchNameIsAlreadyInUseSelectAnExisting"),
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
          throw new Error(tr("host.theTopicNameIsAlreadyInUseInTheWorking"));
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
            throw new Error(tr("host.theTopicNameIsAlreadyInUseInBranchHistory"));
        }
        this.check();
        await assertBranch(current);
        await this.assertSettings(p.id);
        return this.launchNewTopicInClone(p, r, request);
      } else if (selection.mode === "none") {
        // Primary checkout only: no topic lookup, task write, clone or checkout.
        branch = current;
        topic = "";
      } else {
        branch = selection.branch;
        topic = selection.topic;
        taskSnapshot = await this.readTopicTaskWithSettings(
          { projectId: p.id, branch, topic },
          true,
          taskYear,
        );
        launchTaskPath = taskSnapshot.path;
        if (
          request.taskVersion !== undefined &&
          request.task !== taskSnapshot.text &&
          taskSnapshot.version !== request.taskVersion
        )
          throw taskConflict();
        if (
          request.taskVersion !== undefined &&
          taskSnapshot.text.trim() &&
          !request.task.trim() &&
          !request.confirmEmptyTask
        )
          throw new Error(tr("host.confirmReplacingTheTaskWithEmptyText"));
        if (branch !== current) {
          const targetRef = (
            await this.cmd(
              p,
              ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
              true,
            )
          ).trim();
          if ((await this.cmd(p, ["status", "--porcelain"], true)).trim())
            throw new Error(
              tr("host.thereAreUncommittedChangesSaveOrSetThemAsideBefore2"),
            );
          this.check();
          await assertBranch(current);
          if (
            (
              await this.cmd(
                p,
                ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
                true,
              )
            ).trim() !== targetRef
          )
            throw new Error(
              tr("host.theTaskOrBranchChangedBeforeSwitchingOpenTheTask"),
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
      await assertBranch(branch);
      // Preview is presentation only. Compose the chosen command against the
      // current checkout rather than comparing it to a cached admission token.
      const composed = await this.compose(p, r);
      if (!composed.stages.length)
        throw Error(tr("host.cannotLaunchWithNoStagesSelected"));
      this.check();
      await assertBranch(branch);
      if (
        taskSnapshot &&
        request.taskVersion !== undefined &&
        request.task !== taskSnapshot.text
      ) {
        await this.assertSettings(p.id);
        await assertTaskWrite();
        try {
          await atomicWrite(
            path.join(this.root(p), taskSnapshot.path),
            request.task,
            {
              createOnly: !taskSnapshot.exists,
              beforeCommit: async () => {
                this.check();
                await assertBranch(branch);
                await this.assertSettings(p.id);
                await this.validateBinding(p);
                await assertTaskWrite();
              },
            },
          );
        } catch (error) {
          if (
            !taskSnapshot.exists &&
            (error as NodeJS.ErrnoException).code === "EEXIST"
          )
            throw taskConflict();
          throw error;
        }
        mutated = true;
        const written = await readWorkingTask(this.root(p), taskSnapshot.path);
        if (!written.exists || written.text !== request.task)
          throw Error(
            tr("host.theTaskChangedWhileSavingCheckTodoMdTheRun"),
          );
      }
      await assertBranch(branch);
      await this.assertSettings(p.id);
      // No topic means no implicit todo/history read or snapshot. The pipeline
      // itself still executes its configured stages in the admitted checkout.
      if (
        launchTaskPath !== undefined &&
        taskPath(topic, this.binding(p)?.year ?? taskYear) !== launchTaskPath
      )
        throw new Error(tr("host.theTaskYearChangedOpenItAgain"));
      const startedTask =
        launchTaskPath === undefined
          ? undefined
          : await readWorkingTask(this.root(p), launchTaskPath);
      if (
        taskSnapshot &&
        request.taskVersion !== undefined &&
        startedTask?.text !== request.task
      )
        throw new Error(
          tr("host.theTaskChangedExternallyBeforeLaunchOpenItAgain"),
        );
      await assertBranch(branch);
      await this.assertSettings(p.id);
      const invocation = await this.invocation(p);
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
        ...pipelineDisplayMetadata(request),
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
        pipelineRepeat: capturePipelineRepeat({ ...r, clean: request.clean, update: request.update }),
        dashboardRecoveryVersion: 1,
        dashboardOpened: false,
        output: { text: "", truncated: false },
      };
      const deadlineAt = performance.now() + run.startupTimeoutMs!;
      if (startedTask && launchTaskPath)
        run.taskSnapshot = {
          text: startedTask.text,
          year: launchTaskPath.split("/")[2]!,
          topic,
          branch,
        };
      await this.validateBinding(p);
      this.localRunAdmissions.add(run);
      this.addActiveRun(key, run.id);
      this.runList.push(run);
      let child: ChildProcessWithoutNullStreams;
      try {
        await this.persistRuns();
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
        this.localRunAdmissions.delete(run);
        this.removeActiveRun(key, run.id);
        run.status = "failed";
        run.endedAt = new Date().toISOString();
        await this.persistRuns().catch(() => {});
        throw error;
      }
      this.addActiveRun(key, run.id);
      if (!this.runList.includes(run)) this.runList.push(run);
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
      const output = captureRunOutput(child, secrets, (snapshot,end) =>
        this.publishRunOutput(run,snapshot,end),
      );
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
              { kind: "dashboard-not-opened" },
            ).catch(() => {});
          else
            void this.terminateOwned(
              run.id,
              code === 0 ? "exited" : "failed",
              code === 0
                ? undefined
                : { kind: "pipeline-exit", code },
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
      this.localRunAdmissions.delete(run);
      entry.timer = setTimeout(
        () => this.expireStartup(run.id),
        Math.max(0, deadlineAt - performance.now()),
      );
      this.emitRuns();
      return this.publicRun(run);
    } catch (error) {
      if (mutated)
        throw new Error(
          tr("host.value1TheWorkingCopyHasAlreadyChangedNoAutomaticRollback", { value1: (error as Error).message }),
        );
      throw error;
    }
  }
  /** Clear private Desktop history only. Never resolve a working copy or signal a process. */
  async clearRunHistory(
    input: ClearRunHistoryRequest,
  ): Promise<ClearRunHistoryResult> {
    this.check();
    const request = clearRunHistoryRequestSchema.parse(input);
    const belongs = (run: Run) => {
      const scope = request.scope;
      if (typeof scope === "string")
        return run.projectId === scope && !run.context;
      const owner = run.context;
      return (
        run.projectId === scope.projectId &&
        run.topic === scope.topic &&
        run.branch === scope.branch &&
        owner &&
        owner.projectId === scope.projectId &&
        owner.contextId === scope.contextId &&
        owner.year === scope.year &&
        owner.topic === scope.topic &&
        owner.branch === scope.branch
      );
    };
    const reason = (
      run: Run,
    ): ClearRunHistoryResult["retained"][number]["reason"] | undefined => {
      if (
        this.children.has(run.id) ||
        !["exited", "failed", "stopped"].includes(run.status)
      )
        return "active";
      if (run.recovery === "unverified") return "unverified";
      if (run.syncPending) return "pending-sync";
      if (
        this.closeFlights.has(run.id) ||
        this.stopFlights.has(run.id) ||
        this.pipelineRepeatFlights.has(run.id)
      )
        return "busy";
      return undefined;
    };
    const inspect = () => {
      const eligible: string[] = [],
        retained: ClearRunHistoryResult["retained"] = [];
      const current = new Map(this.runList.map((run) => [run.id, run]));
      for (const id of request.runIds) {
        const run = current.get(id);
        if (!run) continue; // a repeated confirmed request is idempotent
        if (!belongs(run) || (run.kind ?? "pipeline") !== request.kind)
          throw Error(
            tr("host.theRunDoesNotBelongToTheSelectedSectionOr"),
          );
        const keep = reason(run);
        if (keep) retained.push({ id, reason: keep });
        else eligible.push(id);
      }
      return { eligible, retained };
    };
    const initial = inspect();
    if (!initial.eligible.length)
      return { removedRunIds: [], retained: initial.retained };
    // Drain any preceding lifecycle writes. Concurrent later snapshots remain
    // safe because the store's terminal ledger prevents deleted IDs reappearing.
    await this.persistRuns();
    this.check();
    const fresh = inspect();
    const confirmed = new Set(initial.eligible),
      initiallyRetained = new Set(initial.retained.map((item) => item.id));
    const candidates = fresh.eligible.filter((id) => confirmed.has(id));
    const retained = [
      ...initial.retained,
      ...fresh.retained.filter((item) => !initiallyRetained.has(item.id)),
    ];
    if (!candidates.length) return { removedRunIds: [], retained };
    const current = () => {
      this.check();
      const safe = new Set(inspect().eligible);
      const existing = new Set(this.runList.map((run) => run.id));
      if (candidates.some((id) => existing.has(id) && !safe.has(id)))
        throw Error(
          tr("host.runStateChangedDuringCleanupHistoryWasKeptRetry"),
        );
    };
    const publishRemoval = (ids: string[]) => {
      const deleted = new Set(ids);
      this.runList = this.runList.filter((run) => !deleted.has(run.id));
      for (const id of ids) {
        this.dashboardFlights.get(id)?.controller.abort();
        this.buildRequests.delete(id);
      }
      this.lastRunSave = "";
      this.emit("runs", this.runCatalog());
    };
    let removedRunIds: string[];
    try {
      removedRunIds = await this.runStore.clearCompleted(candidates, current);
    } catch (error) {
      if (error instanceof RunHistoryClearCommittedError)
        publishRemoval(error.removedRunIds);
      throw error;
    }
    publishRemoval(candidates);
    return { removedRunIds, retained };
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
        if (!run) throw new Error(tr("host.unknownRun"));
        if (run.syncPending)
          throw Error(
            tr("host.automaticSyncHasNotBeenRecordedYetTheSavedRun"),
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
          throw new Error(tr("host.theProcessIsStillRunningTheTabWasKept"));
        this.dashboardFlights.get(id)?.controller.abort();
        this.runList = this.runList.filter((r) => r.id !== id);
        this.buildRequests.delete(id);
        this.emitRuns();
        return true;
      })
      .finally(() => this.closeFlights.delete(id));
    this.closeFlights.set(id, operation);
    return operation;
  }
  private async restoreSavedDashboard(
    run: Run,
    signal?: AbortSignal,
  ): Promise<string> {
    if (
      !this.recovery ||
      !run.process ||
      run.dashboardRecoveryVersion !== 1 ||
      run.kind === "build"
    )
      throw Error(tr("host.noNewDashboardConnectionWasSavedForThisRun"));
    const owner = this.runOwnerHash(run),
      metadata = run.process;
    const claim = await this.recovery.readDashboard(
      metadata,
      owner,
      metadata.cwd,
    );
    if (!claim) throw Error(tr("host.noDashboardConnectionWasSavedForThisRun"));
    const pin = await readDashboardIdentity(claim.origin, signal);
    // The payload may finish while HTTP is in flight. A status response is not
    // authority to open a panel after its supervised process has terminated.
    const processState = await this.recovery.reconcile(
      metadata,
      owner,
      metadata.cwd,
    );
    if (processState.state !== "alive")
      throw Error(
        tr("host.theProcessIsNoLongerVerifiedAsRunningConnectionCanceled"),
      );
    if (
      signal?.aborted ||
      !this.runList.includes(run) ||
      this.runOwnerHash(run) !== owner ||
      run.process !== metadata ||
      !["starting", "running"].includes(run.status) ||
      this.stopFlights.has(run.id)
    )
      throw Error(tr("host.runStateChangedConnectionCanceled"));
    if (pin !== claim.serverRunId)
      throw Error(tr("host.dashboardSourceChangedConnectionCanceled"));
    run.url = claim.origin;
    run.dashboardRunId = pin;
    run.dashboardReconnect = true;
    delete run.dashboardMessage;
    return claim.origin;
  }
  /** Trusted main only. First page success must not depend on AFM exposing a run_id. */
  async dashboardLoaded(id: string, url: string): Promise<boolean> {
    if (!this.markDashboardOpened(id, url)) return false;
    const run = this.runList.find((r) => r.id === id)!;
    if (run.recovery === "confirmed") {
      try {
        const {url: previousURL,dashboardRunId,dashboardReconnect,dashboardMessage}=run;
        await this.restoreSavedDashboard(run);
        if (run.url !== previousURL || run.dashboardRunId !== dashboardRunId ||
            run.dashboardReconnect !== dashboardReconnect || run.dashboardMessage !== dashboardMessage)
          this.emitRuns();
        return true;
      } catch {
        return false;
      }
    }
    if (
      run.dashboardRecoveryVersion !== 1 ||
      !run.process ||
      !this.recovery ||
      run.dashboardReconnect
    )
      return true;
    const owner = this.runOwnerHash(run),
      metadata = run.process;
    try {
      const pin = await readDashboardIdentity(url);
      if (
        !this.runList.includes(run) ||
        this.runOwnerHash(run) !== owner ||
        run.process !== metadata ||
        run.url !== url ||
        run.status !== "running" ||
        this.stopFlights.has(id)
      )
        return false;
      await this.recovery.saveDashboard(metadata, url, pin);
      if (
        !this.runList.includes(run) ||
        run.status !== "running" ||
        this.stopFlights.has(id)
      )
        return false;
      run.dashboardReconnect = true;
      run.dashboardRunId = pin;
      delete run.dashboardMessage;
      await this.persistRuns();
    } catch {
      if (
        !this.runList.includes(run) ||
        run.status !== "running" ||
        this.runOwnerHash(run) !== owner ||
        run.process !== metadata
      )
        return false;
      run.dashboardMessage =
        tr("host.reconnectionAfterExitIsUnavailableBecauseAVerifiableDashboardLink");
    }
    this.emitRuns();
    return this.runList.includes(run) && run.status === "running";
  }
  prepareDashboardReconnect(id: string): Promise<string> {
    this.check();
    if (this.shutdownAdmission)
      return Promise.reject(Error(tr("host.theAppIsPreparingToExit")));
    const previous = this.dashboardFlights.get(id);
    if (previous) return previous.promise;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(async () => {
        const run = this.runList.find((r) => r.id === id);
        if (
          !run ||
          run.dashboardRecoveryVersion !== 1 ||
          !this.recovery ||
          !run.process
        )
          throw Error(tr("host.noNewDashboardConnectionWasSavedForThisRun"));
        const owner = this.runOwnerHash(run);
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
          owner,
          this.root(p),
        );
        if (result.state !== "alive") {
          if (result.state === "terminal") await this.reconcileRun(id);
          throw Error(
            tr("host.theProcessCouldNotBeVerifiedAsRunningTheDashboard"),
          );
        }
        if (controller.signal.aborted || this.runOwnerHash(run) !== owner)
          throw Error(tr("host.connectionCanceled"));
        const url = await this.restoreSavedDashboard(run, controller.signal);
        this.emitRuns();
        return url;
      })
      .finally(() => {
        if (this.dashboardFlights.get(id)?.controller === controller)
          this.dashboardFlights.delete(id);
      });
    this.dashboardFlights.set(id, { controller, promise });
    return promise;
  }
  /** Trusted main-process acknowledgement, never exposed through renderer IPC. */
  markDashboardOpened(id: string, url: string): boolean {
    const run = this.runList.find((r) => r.id === id),
      entry = this.children.get(id);
    if (
      !run ||
      (!entry && !(run.recovery === "confirmed" && run.dashboardReconnect)) ||
      !["starting", "running"].includes(run.status) ||
      run.url !== url ||
      run.error ||
      this.stopFlights.has(id)
    )
      return false;
    if (run.status === "running") return true;
    if (!entry || performance.now() >= entry.deadlineAt) {
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
      { kind: "dashboard-timeout" },
    ).catch(() => {});
  }
  stop(id: string): Promise<void> {
    return this.terminateOwned(id, "stopped");
  }
  private terminateOwned(
    id: string,
    status: "failed" | "exited" | "stopped",
    reason?: string | RunFailureReason,
  ): Promise<void> {
    const pending = this.stopFlights.get(id);
    if (pending) return pending;
    // Install single-flight before cancelling observers or any asynchronous kill.
    const operation = Promise.resolve()
      .then(() => this.finishOwned(id, status, reason))
      .finally(() => this.stopFlights.delete(id));
    this.stopFlights.set(id, operation);
    return operation;
  }
  private async finishOwned(
    id: string,
    status: "failed" | "exited" | "stopped",
    reason?: string | RunFailureReason,
  ): Promise<void> {
    const failureReason = typeof reason === "object" ? reason : undefined;
    const error = typeof reason === "object" ? runFailureMessage(reason) : reason;
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
        this.clearDashboard(recovered);
        this.releaseRecoveredTerminalRun(recovered.id);
        if (recovered.context) recovered.syncPending = true;
        await this.persistRuns();
        await this.syncCompletedRun(recovered);
        this.emitRuns();
        return;
      }
      if (this.runList.find((r) => r.id === id)?.recovery === "unverified")
        throw Error(
          tr("host.processStateWasNotVerifiedAfterRestartTheSavedPid"),
        );
      return;
    }
    const run = this.runList.find((r) => r.id === id)!;
    const safe = (value: string) => {
      let text = stripVTControlCharacters(value);
      for (const secret of [...entry.secrets].sort(
        (a, b) => b.length - a.length,
      ))
        text = text.split(secret).join(tr("host.hidden"));
      return text;
    };
    entry.cancel();
    if (error) {
      run.error = safe(error);
      run.failureReason = failureReason;
    }
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
      // This compound failure includes external diagnostics; do not replace it with a UI label.
      delete run.failureReason;
      run.error = [
        error ? safe(error) : "",
        tr("host.couldNotStopTheProcessItMayStillBeRunning"),
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
    if (status === "stopped" || !error) {
      delete run.error;
      delete run.failureReason;
    } else {
      run.error = safe(error);
      run.failureReason = failureReason;
    }
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
      throw Error(tr("host.theApplicationIsPreparingToExitNewRunsAreUnavailable"));
  }
  /** Freeze only new runs; stopping/recovery and project reads must remain usable.
   * Drain the pre-existing operation chain before taking the confirmation snapshot:
   * a recovery launch may already be between journal persistence and actual spawn.
   */
  async prepareShutdown(): Promise<PreparedShutdown> {
    // A later window finalizer can fail after this host has already closed.
    // Retry may prove its empty inventory, but must never reopen admission.
    if (!this.shutdownFinalized) this.check();
    if (this.shutdownAdmission)
      throw Error(tr("host.exitPreparationIsAlreadyInProgress"));
    this.shutdownAdmission = true;
    let released = false;
    const active = () =>
      this.runList.filter(
        (run) =>
          (!this.shutdownFinalized || !this.detachedRuns.has(run.id)) &&
          (["starting", "running"].includes(run.status) ||
            this.children.has(run.id)),
      );
    try {
      await this.operationTail;
      const planned = new Map(
        active().map((run) => [run.id, this.runOwnerHash(run)]),
      );
      const validate = () => {
        if (released) throw Error(tr("host.exitPreparationHasAlreadyFinished"));
        for (const run of active()) {
          if (
            planned.get(run.id) !== this.runOwnerHash(run) ||
            run.recovery === "unverified"
          )
            throw Error(tr("host.runStateIsUnverifiedExitCanceled"));
        }
        if (
          [...this.children.keys()].some(
            (id) => !this.runList.some((run) => run.id === id),
          )
        )
          throw Error(tr("host.runStateIsUnverifiedExitCanceled"));
      };
      const validateKeep = async () => {
        validate();
        for (const run of active()) {
          if (
            run.kind === "build" ||
            run.dashboardRecoveryVersion !== 1 ||
            !run.process ||
            !this.recovery ||
            run.status !== "running"
          )
            throw new ShutdownKeepError("unsupported");
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
            if (result.state !== "alive")
              throw new ShutdownKeepError("unavailable");
            await this.restoreSavedDashboard(run);
          } catch {
            throw new ShutdownKeepError("unavailable");
          }
        }
        validate();
        try {
          await this.persistRuns();
        } catch {
          throw new ShutdownKeepError("unavailable");
        }
      };
      validate();
      return {
        items: active().map((run) => ({
          id: `run:${run.id}`,
          label: `${run.pipeline} — ${run.topic || tr("host.noTopic")}`,
        })),
        requiresConfirmation: planned.size > 0,
        validate,
        validateKeep,
        keep: async () => {
          await validateKeep();
          validate();
          const remaining = active();
          // No await between inventory proof and observer detachment. Never signal
          // the detached supervisor or its guardian, including error fallback.
          for (const run of remaining) {
            const entry = this.children.get(run.id);
            if (entry) {
              entry.cancel();
              entry.output.dispose();
              entry.child.stdin.destroy();
              entry.child.stdout.destroy();
              entry.child.stderr.destroy();
              entry.child.unref();
              this.children.delete(run.id);
            }
            run.recovery = "confirmed";
            this.detachedRuns.add(run.id);
          }
          await this.persistRuns();
        },
        retained: () =>
          active()
            .filter((run) => this.detachedRuns.has(run.id))
            .map((run) => `run:${run.id}`),
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
  /** Unified exit has stopped or explicitly detached every owned run.
   * Persist before cleanup; a runner failure keeps the app and recovery poll alive.
   */
  async finalizeShutdown(): Promise<void> {
    if (
      !this.shutdownAdmission ||
      this.children.size ||
      this.runList.some(
        (run) =>
          ["starting", "running"].includes(run.status) &&
          !this.detachedRuns.has(run.id),
      )
    )
      throw Error(tr("host.stopTheApplicationSRunsFirst"));
    if (this.shutdownFinalized) return;
    await this.operationTail;
    await this.persistRuns();
    await this.runSaveTail;
    for (const flight of this.dashboardFlights.values())
      flight.controller.abort();
    this.disposed = true;
    try {
      await this.projectCreation.dispose();
      await this.runner.dispose?.();
      clearInterval(this.recoveryPoll);
      this.shutdownFinalized = true;
    } catch (error) {
      this.disposed = false;
      throw error;
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.projectCreation.dispose();
    clearInterval(this.recoveryPoll);
    for (const flight of this.dashboardFlights.values())
      flight.controller.abort();
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
