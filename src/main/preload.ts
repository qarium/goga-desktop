import { createTerminalControlAPI } from "./terminal-control-preload";
import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAPI } from "../shared/bridge";
const invoke = (name: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`goga:${name}`, ...args);
function listen<T>(name: string, callback: (value: T) => void) {
  const fn = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(`goga:${name}`, fn);
  return () => ipcRenderer.removeListener(`goga:${name}`, fn);
}
const api: DesktopAPI = {
  prepareGitRebaseOperation: (request) =>
    invoke("prepare-git-rebase-operation", request),
  executeGitRebaseOperation: (token) =>
    invoke("execute-git-rebase-operation", token),
  prepareGitUpdateHandoff: (request) =>
    invoke("prepare-git-update-handoff", request),
  executeGitUpdateHandoff: (token) =>
    invoke("execute-git-update-handoff", token),
  prepareGitSequencerOperation: (request) =>
    invoke("prepare-git-sequencer-operation", request),
  executeGitSequencerOperation: (token) =>
    invoke("execute-git-sequencer-operation", token),
  prepareGitMergeOperation: (request) =>
    invoke("prepare-git-merge-operation", request),
  executeGitMergeOperation: (token) =>
    invoke("execute-git-merge-operation", token),
  prepareGitConflictSave: (request) =>
    invoke("prepare-git-conflict-save", request),
  executeGitConflictSave: (token) => invoke("execute-git-conflict-save", token),
  readGitBranches: (projectId) => invoke("read-git-branches", projectId),
  prepareGitBranch: (request) => invoke("prepare-git-branch", request),
  executeGitBranch: (token) => invoke("execute-git-branch", token),
  readGitHistoryRefs: (scope) => invoke("read-git-history-refs", scope),
  readGitHistory: (request) => invoke("read-git-history", request),
  readGitCommit: (request) => invoke("read-git-commit", request),
  readGitCommitDiff: (request) => invoke("read-git-commit-diff", request),
  readGitSummary: (scope) => invoke("read-git-summary", scope),
  readGitWorkspace: (scope) => invoke("read-git-workspace", scope),
  readGitConflict: (request) => invoke("read-git-conflict", request),
  readGitDiff: (request) => invoke("read-git-diff", request),
  inspectGitDiscardRecovery: (scope) =>
    invoke("inspect-git-discard-recovery", scope),
  prepareGitDiscardRecovery: (request) =>
    invoke("prepare-git-discard-recovery", request),
  executeGitDiscardRecovery: (token) =>
    invoke("execute-git-discard-recovery", token),
  prepareGitDiscard: (request) => invoke("prepare-git-discard", request),
  executeGitDiscard: (token) => invoke("execute-git-discard", token),
  prepareGitCommit: (request) => invoke("prepare-git-commit", request),
  executeGitCommit: (token) => invoke("execute-git-commit", token),
  terminal: createTerminalControlAPI(
    (channel, value) =>
      ipcRenderer.invoke(channel, ...(value === undefined ? [] : [value])),
    (channel, callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) =>
        callback(value);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
  ),
  runRepositoryAction: (request) => invoke("run-repository-action", request),
  setTopicPopupBounds: (id, bounds) =>
    invoke("set-topic-popup-bounds", id, bounds),
  closeTopicPopup: (id) => invoke("close-topic-popup", id),
  onTopicPopupClosed: (callback) => listen("topic-popup-closed", callback),
  prepareBuildRepeat: (id) => invoke("prepare-build-repeat", id),
  reconcileRun: (id) => invoke("reconcile-run", id),
  createTopicContext: (v) => invoke("create-topic-context", v),
  migrateTopicContext: (v) => invoke("migrate-topic-context", v),
  selectTopicContext: (v) => invoke("select-topic-context", v),
  syncTopicContext: (v) => invoke("sync-topic-context", v),
  topicSyncStatus: (v) => invoke("topic-sync-status", v),
  retryContextSync: (v) => invoke("retry-context-sync", v),
  prepareContextApply: (v) => invoke("prepare-context-apply", v),
  applyContext: (v) => invoke("apply-context", v),
  contextDeletionRecovery: (v) => invoke("context-deletion-recovery", v),
  prepareContextDeletion: (v, branch) =>
    branch === undefined
      ? invoke("prepare-context-deletion", v)
      : invoke("prepare-context-deletion", v, branch),
  deleteContext: (v) => invoke("delete-context", v),
  finishContextDeletion: (v) => invoke("finish-context-deletion", v),
  ensureTopicContext: (identity) => invoke("ensure-topic-context", identity),
  resolveTopicContext: (ref) => invoke("resolve-topic-context", ref),
  checkTopicContextReadiness: (ref) =>
    invoke("check-topic-context-readiness", ref),
  listTopicContexts: (projectId) => invoke("list-topic-contexts", projectId),
  readRequest: (id, method, args) => invoke("read-request", id, method, args),
  cancelRead: (id) => invoke("cancel-read", id),
  buildContext: (id, selection) => invoke("build-context", id, selection),
  listBuildFiles: (id, directory) => invoke("list-build-files", id, directory),
  readBuildPlan: (id, path) => invoke("read-build-plan", id, path),
  launchBuild: (request) => invoke("launch-build", request),
  repeatBuild: (id, confirmClean) => invoke("repeat-build", id, confirmClean),
  prepareHistoryPrune: (projectId, year) =>
    invoke("prepare-history-prune", projectId, year),
  pruneHistory: (projectId, token) => invoke("prune-history", projectId, token),
  listHistoryYears: (scope) => invoke("list-history-years", scope),
  listHistoryEntries: (scope, year) =>
    invoke("list-history-entries", scope, year),
  listHistoryArtifacts: (scope, year, entry, target) =>
    invoke("list-history-artifacts", scope, year, entry, target),
  readHistoryArtifact: (scope, year, entry, path, target) =>
    invoke("read-history-artifact", scope, year, entry, path, target),
  readTopicCatalog: (id, year) => invoke("read-topic-catalog", id, year),
  readTopicTable: (id, year) => invoke("read-topic-table", id, year),
  readTopicOverview: (id, year, target) =>
    invoke("read-topic-overview", id, year, target),
  readProjectBranches: (id) => invoke("read-project-branches", id),
  readTopicBoard: (id, year) => invoke("read-topic-board", id, year),
  readTopicDetails: (id, year, target) =>
    invoke("read-topic-details", id, year, target),
  prepareTopicOperation: (request) =>
    invoke("prepare-topic-operation", request),
  executeTopicOperation: (token) => invoke("execute-topic-operation", token),
  prepareDocumentDeletion: (source, version) =>
    invoke("prepare-document-deletion", source, version),
  deleteDocument: (token) => invoke("delete-document", token),
  listProjects: () => invoke("list-projects"),
  listProjectProfiles: (id) => invoke("list-project-profiles", id),
  listProjectTools: (id) => invoke("list-project-tools", id),
  resolveProjectDockerfile: (id) => invoke("resolve-project-dockerfile", id),
  listProjectPipelines: (id) => invoke("list-project-pipelines", id),
  listProjectWorkflows: (id) => invoke("list-project-workflows", id),
  listWorkflowSuggestions: (id) => invoke("list-workflow-suggestions", id),
  readProjectDocument: (id, target) =>
    invoke("read-project-document", id, target),
  saveProjectDocument: (id, target, text, version) =>
    invoke("save-project-document", id, target, text, version),
  chooseProject: () => invoke("choose-project"),
  readProjectSettings: (id) => invoke("read-project-settings", id),
  saveProjectSettings: (id, value, version) =>
    invoke("save-project-settings", id, value, version),
  discover: (id) => invoke("discover", id),
  checkoutBranch: (id) => invoke("checkout-branch", id),
  readTopicTask: (r) => invoke("read-topic-task", r),
  preview: (r) => invoke("preview", r),
  launch: (r) => invoke("launch", r),
  runs: () => invoke("runs"),
  closeRun: (id) => invoke("close-run", id),
  stopRun: (id) => invoke("stop-run", id),
  selectRun: (id) => invoke("select-run", id),
  listSettings: () => invoke("list-settings"),
  readSettings: (kind, name) => invoke("read-settings", kind, name),
  saveSettings: (kind, name, text, version) =>
    invoke("save-settings", kind, name, text, version),
  onRuns: (callback) => listen("runs", callback),
  onFocusRun: (callback) => listen("focus-run", callback),
  onViewError: (callback) => listen("view-error", callback),
};
contextBridge.exposeInMainWorld("goga", api);
