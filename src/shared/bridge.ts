import type {
  GitHistoryRefs,
  GitHistoryRequest,
  GitHistoryPage,
  GitCommitReadRequest,
  GitCommitDetails,
  GitCommitDiffRequest,
  GitCommitDiff,
} from "./git-history";
import type {
  GitDiscardRequest,
  GitDiscardPreview,
  GitDiscardResult,
} from "./git-discard";
import type {
  GitUpdateHandoffRequest,
  GitUpdateHandoffPreview,
  GitUpdateHandoffResult,
} from "./git-update-handoff";
import type {
  GitSequencerOperationRequest,
  GitSequencerOperationPreview,
  GitSequencerOperationResult,
} from "./git-sequencer-operations";
import type {
  GitRebaseOperationRequest,
  GitRebaseOperationPreview,
  GitRebaseOperationResult,
} from "./git-rebase-operations";
import type {
  GitMergeOperationRequest,
  GitMergeOperationPreview,
  GitMergeOperationResult,
} from "./git-operations";
import type {
  GitConflictSaveRequest,
  GitConflictSavePreview,
  GitConflictSaveResult,
} from "./git-conflict-save";
import type {
  GitConflictDocument,
  GitConflictReadRequest,
} from "./git-conflicts";
import type {
  GitBranchRequest,
  GitBranchInventory,
  GitBranchPreview,
  GitBranchResult,
} from "./git-branches";
import type {
  GitCommitRequest,
  GitCommitPreview,
  GitCommitResult,
} from "./git-commit";
import type {
  GitDiffRequest,
  GitWorkspaceDiff,
  GitWorkspaceSnapshot,
  GitWorkspaceSummary,
} from "./git-workspace";
import type {
  ContextDeletionPreview,
  ContextDeletionResult,
} from "./context-deletion";
import type {
  HistoryArtifact,
  HistoryDocument,
  HistoryPrunePreview,
  HistoryPruneResult,
} from "./history";
import type { TerminalAPI } from "./terminal-control";
import type { TopicPopupBounds } from "./topic-popup";
import type {
  RepositoryActionRequest,
  RepositoryActionResult,
} from "./repository-actions";
import type { BuildRepeatPreparation } from "./build-repeat";
import type { ScopeRef } from "./context";
import type {
  ContextSyncState,
  ContextApplyPreview,
  ContextApplyResult,
} from "./context-sync";
import type {
  TopicContextIdentity,
  TopicContextRef,
  WorktreeRecord,
} from "./worktrees";
import type { ReadMethod } from "./read-deadlines";
import type {
  BuildContext,
  BuildFileList,
  BuildPlanDocument,
  BuildRequest,
  BuildOptions,
  BuildContextSelection,
} from "./build";
import type {
  TopicBoardSnapshot,
  ProjectBranches,
  TopicCatalogSnapshot,
  TopicDetails,
  TopicTarget,
  TopicOperationRequest,
  TopicOperationPlan,
  TopicOperationResult,
} from "./topics";
import type {
  DeletableDocument,
  DeletionTicket,
  DeletionResult,
} from "./document-deletion";
import type {
  ProjectDocumentTarget,
  ProjectDocument,
  ProjectTool,
  ProjectWorkflow,
  ProjectDockerfile,
  ProjectPipeline,
  ProjectProfile,
} from "./project-documents";
import type {
  Project,
  Pipeline,
  ProjectSettings,
  ProjectSettingsView,
  Discovery,
  Preview,
  Run,
  PipelineRequest,
  LaunchRequest,
  TopicTaskRequest,
  TopicTaskDocument,
} from "./types";
export type SettingsKind = "config" | "profile";
export interface SettingsFile {
  text: string;
  version: string;
}
export interface DesktopAPI {
  prepareGitRebaseOperation(
    request: GitRebaseOperationRequest,
  ): Promise<GitRebaseOperationPreview>;
  executeGitRebaseOperation(token: string): Promise<GitRebaseOperationResult>;
  prepareGitUpdateHandoff(
    request: GitUpdateHandoffRequest,
  ): Promise<GitUpdateHandoffPreview>;
  executeGitUpdateHandoff(token: string): Promise<GitUpdateHandoffResult>;
  prepareGitSequencerOperation(
    request: GitSequencerOperationRequest,
  ): Promise<GitSequencerOperationPreview>;
  executeGitSequencerOperation(
    token: string,
  ): Promise<GitSequencerOperationResult>;
  prepareGitConflictSave(
    request: GitConflictSaveRequest,
  ): Promise<GitConflictSavePreview>;
  executeGitConflictSave(token: string): Promise<GitConflictSaveResult>;
  readGitBranches(projectId: string): Promise<GitBranchInventory>;
  prepareGitBranch(request: GitBranchRequest): Promise<GitBranchPreview>;
  executeGitBranch(token: string): Promise<GitBranchResult>;
  prepareGitMergeOperation(
    request: GitMergeOperationRequest,
  ): Promise<GitMergeOperationPreview>;
  executeGitMergeOperation(token: string): Promise<GitMergeOperationResult>;
  prepareGitDiscard(request: GitDiscardRequest): Promise<GitDiscardPreview>;
  executeGitDiscard(token: string): Promise<GitDiscardResult>;
  prepareGitCommit(request: GitCommitRequest): Promise<GitCommitPreview>;
  executeGitCommit(token: string): Promise<GitCommitResult>;
  readGitConflict(
    request: GitConflictReadRequest,
  ): Promise<GitConflictDocument>;
  readGitHistoryRefs(scope: ScopeRef): Promise<GitHistoryRefs>;
  readGitHistory(request: GitHistoryRequest): Promise<GitHistoryPage>;
  readGitCommit(request: GitCommitReadRequest): Promise<GitCommitDetails>;
  readGitCommitDiff(request: GitCommitDiffRequest): Promise<GitCommitDiff>;
  readGitSummary(scope: ScopeRef): Promise<GitWorkspaceSummary>;
  readGitWorkspace(scope: ScopeRef): Promise<GitWorkspaceSnapshot>;
  readGitDiff(request: GitDiffRequest): Promise<GitWorkspaceDiff>;
  /** Optional for compatibility with older hosts and isolated fixtures. */
  terminal?: TerminalAPI;
  runRepositoryAction(
    request: RepositoryActionRequest,
  ): Promise<RepositoryActionResult>;
  setTopicPopupBounds?(id: string, bounds: TopicPopupBounds): Promise<void>;
  closeTopicPopup?(id: string): Promise<void>;
  onTopicPopupClosed?(callback: (id: string) => void): () => void;
  prepareBuildRepeat?(runId: string): Promise<BuildRepeatPreparation>;
  reconcileRun?(runId: string): Promise<Run>;
  createTopicContext(input: {
    projectId: string;
    year: string;
    branch: string;
    baseRef: string;
  }): Promise<WorktreeRecord>;
  migrateTopicContext(input: TopicContextIdentity): Promise<WorktreeRecord>;
  selectTopicContext(ref: TopicContextRef | null): Promise<void>;
  syncTopicContext(ref: TopicContextRef): Promise<ContextSyncState>;
  topicSyncStatus(ref: TopicContextRef): Promise<ContextSyncState>;
  retryContextSync(ref: TopicContextRef): Promise<ContextSyncState>;
  prepareContextApply(ref: TopicContextRef): Promise<ContextApplyPreview>;
  applyContext(input: {
    projectId: string;
    token: string;
    confirmed: true;
  }): Promise<ContextApplyResult>;
  contextDeletionRecovery(
    ref: TopicContextRef,
  ): Promise<ContextDeletionPreview | null>;
  prepareContextDeletion(
    ref: TopicContextRef,
    branch?: string,
  ): Promise<ContextDeletionPreview>;
  deleteContext(input: {
    projectId: string;
    token: string;
    allowAhead?: true;
  }): Promise<ContextDeletionResult>;
  finishContextDeletion(input: {
    projectId: string;
    token: string;
  }): Promise<ContextDeletionResult>;

  ensureTopicContext(identity: TopicContextIdentity): Promise<WorktreeRecord>;
  resolveTopicContext(ref: TopicContextRef): Promise<WorktreeRecord>;
  checkTopicContextReadiness(
    request: TopicContextIdentity | TopicContextRef,
  ): Promise<WorktreeRecord | null>;
  listTopicContexts(projectId: string): Promise<WorktreeRecord[]>;
  readRequest?(
    id: string,
    method: ReadMethod,
    args: unknown[],
  ): Promise<unknown>;
  cancelRead?(id: string): Promise<void>;
  buildContext(
    projectId: ScopeRef,
    selection?: BuildContextSelection,
  ): Promise<BuildContext>;
  listBuildFiles(
    projectId: ScopeRef,
    directory: string,
  ): Promise<BuildFileList>;
  readBuildPlan(projectId: ScopeRef, path: string): Promise<BuildPlanDocument>;
  launchBuild(request: BuildRequest): Promise<Run>;
  repeatBuild(runId: string, confirmClean: boolean): Promise<Run>;
  prepareHistoryPrune(
    projectId: string,
    year: string,
  ): Promise<HistoryPrunePreview>;
  pruneHistory(projectId: string, token: string): Promise<HistoryPruneResult>;
  listHistoryYears(scope: ScopeRef): Promise<string[]>;
  listHistoryEntries(scope: ScopeRef, year: string): Promise<string[]>;
  listHistoryArtifacts(
    scope: ScopeRef,
    year: string,
    entry: string,
    target?: TopicTarget,
  ): Promise<HistoryArtifact[]>;
  readHistoryArtifact(
    scope: ScopeRef,
    year: string,
    entry: string,
    path: string,
    target?: TopicTarget,
  ): Promise<HistoryDocument>;
  readTopicCatalog(
    projectId: string,
    year: string,
  ): Promise<TopicCatalogSnapshot>;
  /** Display-only snapshot; its revision cannot authorize operations. */
  readTopicTable(projectId: string, year: string): Promise<TopicBoardSnapshot>;
  /** Checked task-only read. No mutation authority or full board is loaded. */
  readTopicOverview(
    scope: ScopeRef,
    year: string,
    target: TopicTarget,
  ): Promise<TopicDetails>;
  readProjectBranches(projectId: string): Promise<ProjectBranches>;
  readTopicBoard(
    projectId: ScopeRef,
    year: string,
  ): Promise<TopicBoardSnapshot>;
  readTopicDetails(
    projectId: ScopeRef,
    year: string,
    target: TopicTarget,
  ): Promise<TopicDetails>;
  prepareTopicOperation(
    request: TopicOperationRequest,
  ): Promise<TopicOperationPlan>;
  executeTopicOperation(token: string): Promise<TopicOperationResult>;
  prepareDocumentDeletion(
    source: DeletableDocument,
    expectedVersion?: string,
  ): Promise<DeletionTicket>;
  deleteDocument(token: string): Promise<DeletionResult>;
  listProjects(): Promise<Project[]>;
  listProjectProfiles(projectId: ScopeRef): Promise<ProjectProfile[]>;
  listProjectTools(projectId: ScopeRef): Promise<ProjectTool[]>;
  listProjectWorkflows(projectId: ScopeRef): Promise<ProjectWorkflow[]>;
  listWorkflowSuggestions(projectId: ScopeRef): Promise<Pipeline[]>;
  resolveProjectDockerfile(projectId: ScopeRef): Promise<ProjectDockerfile>;
  listProjectPipelines(projectId: ScopeRef): Promise<ProjectPipeline[]>;
  readProjectDocument(
    projectId: ScopeRef,
    target: ProjectDocumentTarget,
  ): Promise<ProjectDocument>;
  saveProjectDocument(
    projectId: ScopeRef,
    target: ProjectDocumentTarget,
    text: string,
    version: string,
  ): Promise<ProjectDocument>;
  chooseProject(): Promise<Project | null>;
  readProjectSettings(projectId: ScopeRef): Promise<ProjectSettingsView>;
  saveProjectSettings(
    projectId: ScopeRef,
    value: ProjectSettings,
    version: string,
  ): Promise<ProjectSettingsView>;
  discover(projectId: ScopeRef): Promise<Discovery>;
  checkoutBranch(projectId: ScopeRef): Promise<string>;
  readTopicTask(request: TopicTaskRequest): Promise<TopicTaskDocument>;
  preview(request: PipelineRequest): Promise<Preview>;
  launch(request: LaunchRequest): Promise<Run>;
  runs(): Promise<Run[]>;
  closeRun(id: string): Promise<boolean>;
  stopRun(id: string): Promise<void>;
  selectRun(id: string | null): Promise<void>;
  listSettings(): Promise<{ profiles: string[] }>;
  readSettings(kind: SettingsKind, name?: string): Promise<SettingsFile>;
  saveSettings(
    kind: SettingsKind,
    name: string | undefined,
    text: string,
    version: string,
  ): Promise<SettingsFile>;
  onRuns(callback: (runs: Run[]) => void): () => void;
  onFocusRun(callback: (id: string) => void): () => void;
  onViewError(
    callback: (data: { id: string; error: string }) => void,
  ): () => void;
}
declare global {
  interface Window {
    goga: DesktopAPI;
  }
}
