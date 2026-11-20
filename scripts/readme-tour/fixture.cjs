// Renderer-only tour data. The sole Electron dependency is the isolated bridge;
// no IPC, files, network, commands, user settings or real processes are used.
"use strict";
const { contextBridge } = require("electron");
const project = (id, name) => ({ id, name, path: "/sample/" + id });
const atlas = project("atlas", "Atlas");
const orbit = project("orbit", "Orbit");
const notes = project("field-notes", "Field Notes");
const catalog = [atlas, orbit];
const noop = async () => {};
const unused = async () => { throw new Error("Action outside the readme tour"); };
const noEvents = () => () => {};
const runListeners = new Set();
const stages = [
  ["define", "Product definition & create PRD"],
  ["discover", "Technical discovery & create ADR"],
  ["specify", "Create task, specs & decomposition"],
  ["review", "Review of the created task"],
].map(([id, title]) => ({ id, title }));
const pipeline = { id: "refinement", name: "Refinement", description: "Task refinement process", project: false };
const development = { id: "development", name: "Development", description: "Implement and review a change", project: false };
const runLog = [
  "Refinement | Field Notes | sample run",
  "",
  ...stages.map(({ id, title }) => "[done]  " + id.padEnd(10) + title),
  "",
  "Refinement complete.",
].join("\n");
const started = new Date(Date.now() - 3 * 60000).toISOString();
const runs = [{
  id: "orbit-sample-build", projectId: orbit.id, pipeline: "build", pipelineName: "Build", kind: "build",
  topic: "", branch: "main", workflow: null, profile: null, status: "running", startedAt: started,
  build: { planPath: "plans/search-index.md", clean: false }, output: { text: "Building a sample search index.", truncated: false },
}];
const boardEntries = [
  ["map-export", "todo"], ["field-checklist", "backlog"], ["offline-index", "designed"],
  ["note-search", "planned"], ["route-preview", "done"], ["catalog-import", "done"],
].map(([topic, status]) => ({
  topic, branch: topic, current: false, remote: false, todo: "", statuses: [status],
  divergence: null, hosts: status === "done" ? [topic, "main"] : [topic],
}));
const branchNames = ["main", ...boardEntries.map(t => t.branch)];
const board = async (projectId, year) => ({
  projectId, year, revision: "a".repeat(64), currentBranch: "main", currentTopic: null, baseRef: "main",
  branches: branchNames, dirty: false, active: false, entries: boardEntries, records: boardEntries, remoteEntries: [], remoteRecords: [],
});
const entries = {
  "README.md": "# Field Notes\n\nCollect observations and find them by place or subject.\n",
  "src/catalog/CODEMANIFEST": "Catalog:\n  location: catalog.ts\n",
  "src/catalog/catalog.ts": "export interface Catalog {\n  find(query: string): Note[];\n}\n",
  "src/search/CODEMANIFEST": "SearchIndex:\n  location: search.ts\n",
  "src/search/search.ts": "export interface SearchIndex {\n  query(text: string): string[];\n}\n",
  "src/notes/CODEMANIFEST": "Note:\n  location: note.ts\n",
  "src/notes/note.ts": "export interface Note {\n  title: string;\n  tags: string[];\n}\n",
};
function listDirectory(_scope, path) {
  const prefix = path ? path + "/" : "";
  const found = new Map();
  for (const file of Object.keys(entries)) {
    if (!file.startsWith(prefix)) continue;
    const [name, ...rest] = file.slice(prefix.length).split("/");
    found.set(name, { name, path: prefix + name, kind: rest.length ? "directory" : "file" });
  }
  return { path, truncated: false, entries: [...found.values()].sort((a,b) =>
    Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name)) };
}
const cell = (path, description, types, dependencies = {}, children = []) => ({ cell: path, description, types, usages: [], dependencies, children });
const dep = (name) => ({ types: [name], usages: [] });
const schema = [cell("src", "Field notes library", [], {}, [
  cell("src/catalog", "Browse and organize notes", ["Catalog"], { "src/search": dep("SearchIndex"), "src/notes": dep("Note") }),
  cell("src/search", "Search by subject or location", ["SearchIndex"], { "src/notes": dep("Note") }),
  cell("src/notes", "Observation and location records", ["Note"]),
])];
const api = {
  initialInterfaceLanguage: process.argv.find(arg=>arg.startsWith("--goga-tour-language="))?.split("=")[1] ?? "en",
  listProjects: async () => [...catalog],
  chooseProject: async () => { if (!catalog.some(p => p.id === notes.id)) catalog.push(notes); return notes; },
  runs: async () => [...runs],
  onRuns: callback => { runListeners.add(callback); return () => runListeners.delete(callback); },
  onFocusRun: noEvents, onViewError: noEvents, selectRun: noop,
  readTopicTable: board, readTopicBoard: board,
  readTopicCatalog: async (projectId, year) => ({ projectId, year, currentTopic: null, entries: boardEntries }),
  readProjectBranches: async projectId => ({ projectId, branches: branchNames, localBranches: branchNames }),
  listTopicContexts: async () => [], selectTopicContext: noop,
  listSettings: async () => ({ profiles: [] }),
  readProjectSettings: async () => ({ value: { executable: "goga", profile: "", env: [] }, version: "tour", profiles: [] }),
  readGitSummary: async scope => ({ scope, branch: "main", changedFiles: 0, conflicts: 0 }),
  readGitWorkspace: async scope => ({ scope, root: notes.path, revision: "a".repeat(64), head: "b".repeat(40),
    branch: "main", upstream: null, ahead: 0, behind: 0, operation: "none", files: [] }),
  listOverviewDirectory: async (...args) => listDirectory(...args),
  readOverviewSchema: async () => schema,
  readOverviewFile: async (_scope, path) => {
    if (!Object.hasOwn(entries,path)) throw new Error("Not a sample file");
    return { relativePath: path, text: entries[path], exists: true, version: "tour" };
  },
  readOverviewContract: async () => ({}),
  reportOverviewCloseState: noop,
  demoState: async () => ({ engine: "embedded", port: 45123, shows: [], access: { owner: null, phase: "off", connectionId: null } }),
  demoExecute: unused,
  discover: async () => ({ repository: "ready", pipelines: [development, pipeline], topics: boardEntries,
    currentBranch: "main", baseRef: "main", branches: branchNames, workflows: [], profiles: [],
    projectSettings: { version: "tour", executable: "goga", profile: "" } }),
  checkoutBranch: async () => "main",
  readTopicTask: async () => ({ exists: true, text: "Prepare the next milestone.", version: "tour", path: "todo.md" }),
  preview: async (request) => ({ token: "tour-preview",
    stages: request.pipeline === development.id ? [{ id: "implement", title: "Implement the change" }, { id: "review", title: "Review the change" }] : stages,
    workflow: null, profile: null }),
  launch: async (request) => {
    if (request.pipeline !== pipeline.id || request.projectId !== notes.id || request.topic?.mode !== "none" ||
        request.context || runs.some(r => r.id === "tour-refinement")) throw new Error("Unexpected sample run request");
    const run = { id: "tour-refinement", pipeline: pipeline.id, pipelineName: pipeline.name, kind: "pipeline",
      pipelineDescription: pipeline.description, projectId: notes.id, topic: "", branch: "main",
      workflow: null, profile: null, status: "exited", startedAt: started, endedAt: new Date().toISOString(),
      output: { text: runLog, truncated: false } };
    runs.push(run);
    for (const notify of runListeners) notify([...runs]);
    return run;
  },
};
// The capture launcher uses a fresh, temporary browser session. Seed only its
// display preferences; all subsequent project moves use Desktop's own controls.
localStorage.setItem("goga.desktop.projectOrganization.v1", JSON.stringify({
  schemaVersion: 1, groups: [{ id: "studio", name: "Studio", collapsed: false, projectIds: ["atlas","orbit"] }], ungroupedProjectIds: [],
}));
localStorage.setItem("goga.desktop.homeVisits.v1", JSON.stringify({
  schemaVersion: 1, visits: [atlas, orbit].map((p, i) => ({
    projectId: p.id, visitedAt: Date.now() - (i+1)*60000,
    target: { kind: "section", section: "overview", owner: { kind: "primary", projectId: p.id } },
  })),
}));
contextBridge.exposeInMainWorld("goga", api);
