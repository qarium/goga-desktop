import { expect, it, vi } from "vitest";
import {
  createHomeSessions,
  distinctSessionFiles,
} from "../src/renderer/home/session-summary";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
import { createOverviewStore } from "../src/renderer/overview/store";
import type { TopicContextRef } from "../src/shared/worktrees";

const p = { id: "project", name: "Project", path: "/fixture/project" };
const ctx = (revision: string): TopicContextRef => ({
  projectId: p.id,
  contextId: "ctx-" + "5".repeat(64),
  year: "2026",
  branch: "topic",
  topic: "topic",
  revision,
});
it("keeps editor payloads out of metadata, does not expose private settings or count unchanged templates", () => {
  const sessions = createHomeSessions(),
    docs = createSettingsDocuments();
  sessions.attachSettings(docs, [p]);
  docs.createProfile("private");
  docs.edit({ scope: "home", kind: "profile", name: "private" }, "secret!");
  docs.createWorkflow(p.id, "test", []);
  expect(sessions.getSnapshot()).toEqual([]);
  const src = {
    scope: "project",
    projectId: p.id,
    target: { kind: "workflow", name: "test" },
  } as const;
  docs.edit(src, "my draft");
  const [entry] = sessions.getSnapshot();
  expect(entry.target).toMatchObject({
    kind: "document",
    relativePath: ".goga/workflows/test.yml",
    owner: { kind: "primary", projectId: p.id },
  });
  expect(JSON.stringify(sessions.getSnapshot())).not.toMatch(
    /my draft|secret!|private/,
  );
  const target = entry.target;
  if (target.kind !== "document") throw Error("document expected");
  expect(sessions.readBuffer(target)).toBe("my draft");
  const oldSnapshot = sessions.getSnapshot();
  docs.edit(src, "second edit");
  expect(sessions.getSnapshot()).toBe(oldSnapshot);
  expect(sessions.readBuffer(target)).toBe("second edit");
  docs.reset(src);
  expect(sessions.getSnapshot()).toEqual([]);
  expect(sessions.readBuffer(target)).toBeNull();
});
it("reopens the exact tool and file without a disk read; obsolete buffers do not redirect to the same filename", () => {
  const s = createHomeSessions(),
    docs = createSettingsDocuments();
  s.attachSettings(docs, [p]);
  const scope = ctx("v1");
  const catalog = [
    { name: "one", entries: [] },
    { name: "two", entries: [] },
  ];
  docs.createToolFile(scope, "one", "config.yml", catalog);
  const src = {
    scope: "project",
    projectId: p.id,
    context: scope,
    target: { kind: "tool", tool: "one", path: "config.yml" },
  } as const;
  docs.edit(src, "draft");
  const [{ target }] = s.getSnapshot();
  if (target.kind !== "document") throw Error();
  docs.selectTool(scope, "two");
  docs.updateTool(scope, "one", { selected: "" });
  expect(s.reveal(target)).toEqual({ page: "project-settings", tab: "tools" });
  expect(docs.selectedTool(scope)).toBe("one");
  expect(docs.toolState(scope, "one").selected).toBe("config.yml");
  docs.discard(src);
  void docs.open(src);
  docs.edit(src, "replacement");
  expect(s.has(target)).toBe(false);
  expect(s.readBuffer(target)).toBeNull();
});
it("deduplicates the file count without merging distinct buffers or scope revisions", async () => {
  const s = createHomeSessions(),
    docs = createSettingsDocuments();
  s.attachSettings(docs, [p]);
  const api = {
    readOverviewFile: vi.fn(async () => ({
      relativePath: ".goga/workflows/test.yml",
      version: "1",
      exists: true,
      text: "disk",
    })),
  };
  const first = ctx("v1"),
    second = ctx("v2");
  const overview = createOverviewStore(api as never, first);
  const revealOverview = vi.fn();
  const off = s.attachOverview(overview, "retained-a", revealOverview);
  await overview.open(".goga/workflows/test.yml");
  overview.edit(".goga/workflows/test.yml", "overview");
  docs.createWorkflow(first, "test", []);
  docs.edit(
    {
      scope: "project",
      context: first,
      projectId: p.id,
      target: { kind: "workflow", name: "test" },
    },
    "settings one",
  );
  docs.createWorkflow(second, "test", []);
  docs.edit(
    {
      scope: "project",
      context: second,
      projectId: p.id,
      target: { kind: "workflow", name: "test" },
    },
    "settings two",
  );
  const entries = s.getSnapshot();
  expect(entries).toHaveLength(3);
  expect(distinctSessionFiles(entries)).toHaveLength(1);
  expect(distinctSessionFiles(entries)[0].entries).toHaveLength(3);
  const target = entries.find(
    (e) => e.target.kind === "document" && e.target.source === "overview",
  )!.target;
  if (target.kind !== "document") throw Error();
  expect(s.reveal(target)).toEqual({ page: "overview" });
  expect(revealOverview).toHaveBeenCalledWith(target.relativePath);
  overview.setScope(second);
  expect(s.has(target)).toBe(true);
  expect(s.reveal(target)).toBeNull();
  expect(s.readBuffer(target)).toBe("overview");
  expect(api.readOverviewFile).toHaveBeenCalledTimes(1);
  off();
  expect(s.has(target)).toBe(false);
});
it("late cleanup of replaced retained view does not unregister its successor", async () => {
  const s = createHomeSessions();
  const api = {
    readOverviewFile: vi.fn(async () => ({
      relativePath: "a",
      version: "1",
      text: "disk",
      exists: true,
    })),
  };
  const a = createOverviewStore(api as never, p.id),
    b = createOverviewStore(api as never, p.id);
  const first = s.attachOverview(a, "same-slot", () => {});
  await a.open("a");
  a.edit("a", "old");
  const old = s.getSnapshot()[0].target;
  if (old.kind !== "document") throw Error();
  const second = s.attachOverview(b, "same-slot", () => {});
  await b.open("a");
  b.edit("a", "fresh");
  first();
  const [fresh] = s.getSnapshot();
  expect(s.has(old)).toBe(false);
  if (fresh.target.kind !== "document") throw Error();
  expect(s.readBuffer(fresh.target)).toBe("fresh");
  second();
  expect(s.getSnapshot()).toEqual([]);
});

it("does not rebuild Overview targets on text-only updates, but buffer viewers read the latest draft", async () => {
  const sessions = createHomeSessions();
  const store = createOverviewStore({
    readOverviewFile: async () => ({ text: "disk", exists: true, version: "1", relativePath: "a" }),
  } as never, "p");
  sessions.attachOverview(store, "owner", () => {});
  await store.open("a");
  store.edit("a", "first");
  const current = sessions.getSnapshot();
  const target = current[0].target;
  if (target.kind !== "document") throw Error("document expected");
  const collectPaths = vi.spyOn(store.getSnapshot().order, Symbol.iterator);
  const updated = vi.fn();
  const off = sessions.subscribeBuffer(updated);
  store.edit("a", "newest");
  expect(collectPaths).not.toHaveBeenCalled();
  collectPaths.mockRestore();
  expect(updated).toHaveBeenCalled();
  expect(sessions.getSnapshot()).toBe(current);
  expect(sessions.readBuffer(target)).toBe("newest");
  store.edit("a", "disk");
  expect(sessions.getSnapshot()).toEqual([]);
  expect(sessions.readBuffer(target)).toBeNull();
  off();
});
