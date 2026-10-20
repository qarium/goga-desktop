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
  prepareContextDeletion: (v) => invoke("prepare-context-deletion", v),
  deleteContext: (v) => invoke("delete-context", v),
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
