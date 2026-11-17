import { describe, expect, it, vi } from "vitest";
import { getOverviewLeaveFiles } from "../src/renderer/overview-leave-drafts";
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

describe("unsaved Overview files on navigation", () => {
  const setup = (owner: string | TopicContextRef) => {
    const sessions = createHomeSessions();
    const disk = new Map<string, { text: string; version: string }>();
    const read = async (_owner: unknown, path: string) => ({
      relativePath: path,
      exists: true,
      ...(disk.get(path) ?? { text: "disk", version: "v1" }),
    });
    const api = {
      readOverviewFile: vi.fn(read),
      saveOverviewFile: vi.fn(
        async (o: unknown, path: string, text: string, version: string) => {
          if ((await read(o, path)).version !== version)
            throw Error("Конфликт сохранения: файл изменился");
          disk.set(path, { text, version: version + "+" });
          return read(o, path);
        },
      ),
    };
    const store = createOverviewStore(api as never, owner);
    const reveal = vi.fn();
    const detach = sessions.attachOverview(store, "retained-editor", reveal);
    const files = (s = owner) => getOverviewLeaveFiles(sessions, s);
    return { api, sessions, store, disk, reveal, detach, files };
  };
  it("collects dirty retained tabs of one owner only and saves latest text through its scoped writer", async () => {
    const o = ctx("v1");
    const { store, files, api, reveal } = setup(o);
    await store.open("one.ts");
    await store.open("two.ts");
    await store.open("clean.md");
    store.edit("one.ts", "one");
    store.edit("two.ts", "two");
    const both = files();
    expect(both.map((f) => f.path)).toEqual(["one.ts", "two.ts"]);
    expect(files(p.id)).toEqual([]);
    expect(files({ ...o, contextId: "unrelated" })).toEqual([]);
    expect(files({ ...o, year: "2025" })).toEqual([]);
    both[1].reveal?.();
    expect(reveal).toHaveBeenCalledWith("two.ts");
    store.edit("one.ts", "latest");
    expect(both[0].readText?.()).toBe("latest");
    await both[0].preflight!();
    await both[0].save();
    expect(api.saveOverviewFile).toHaveBeenCalledWith(
      o,
      "one.ts",
      "latest",
      "v1",
    );
    expect(files().map((f) => f.path)).toEqual(["two.ts"]);
  });
  it("checks disk versions without writing, and never overwrites external changes on a late conflict", async () => {
    const { store, disk, api, files } = setup(p.id);
    await store.open("a.md");
    store.edit("a.md", "draft");
    const [file] = files();
    await file.preflight!();
    disk.set("a.md", { text: "elsewhere", version: "v2" });
    await expect(file.preflight!()).rejects.toThrow(/измен/i);
    expect(api.saveOverviewFile).not.toHaveBeenCalled();
    await expect(file.save()).rejects.toThrow(/конфликт/i);
    expect(disk.get("a.md")?.text).toBe("elsewhere");
    expect(file.readText?.()).toBe("draft");
  });
  it("accepts an identical draft saved by Project from verified disk, retaining undo memory without a second write", async () => {
    const { store, disk, files, api } = setup(p.id);
    await store.open("same.yml");
    store.edit("same.yml", "both");
    const memory = store.getSnapshot().files["same.yml"].memory;
    const [file] = files();
    await file.preflight!();
    disk.set("same.yml", { text: "other", version: "v2" });
    await expect(file.acceptSavedText!()).rejects.toThrow();
    expect(file.readText?.()).toBe("both");
    disk.set("same.yml", { text: "both", version: "v3" });
    await file.acceptSavedText!();
    expect(store.getSnapshot().files["same.yml"]).toMatchObject({
      document: { text: "both", version: "v3" },
      memory,
    });
    expect(files()).toEqual([]);
    expect(api.saveOverviewFile).not.toHaveBeenCalled();
  });
  it("rejects obsolete requests and detached/reopened tabs without operating on their successors", async () => {
    const o = ctx("v1");
    const { store, api, files, detach, reveal } = setup(o);
    await store.open("a");
    store.edit("a", "draft");
    const [prior] = files();
    store.setScope({ ...o, revision: "v2" });
    await expect(prior.save()).rejects.toThrow();
    const [current] = files({ ...o, revision: "v2" });
    expect(current.readText?.()).toBe("draft");
    api.readOverviewFile.mockClear();
    await expect(current.preflight!()).rejects.toThrow(/рабоч|контекст/i);
    await expect(current.acceptSavedText!()).rejects.toThrow();
    await expect(current.save()).rejects.toThrow();
    expect(api.readOverviewFile).not.toHaveBeenCalled();
    expect(api.saveOverviewFile).not.toHaveBeenCalled();
    current.reveal?.();
    expect(reveal).toHaveBeenCalledWith("a");
    // An explicit manual decision remains possible in the live editor.
    expect(await store.save("a")).toBe(true);
    api.saveOverviewFile.mockClear();
    store.close(["a"], true);
    await store.open("a");
    store.edit("a", "replacement");
    await expect(current.save()).rejects.toThrow();
    expect(current.readText?.()).toBeNull();
    const [beforeDetach] = files({ ...o, revision: "v2" });
    detach();
    await expect(beforeDetach.save()).rejects.toThrow();
    expect(api.saveOverviewFile).not.toHaveBeenCalled();
  });
  it("does not write a newer unconfirmed draft while waiting in the open file queue", async () => {
    const { store, api, files } = setup(p.id);
    await store.open("a");
    store.edit("a", "confirmed");
    let finish!: () => void;
    api.readOverviewFile.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        finish = done;
      });
      return { relativePath: "a", exists: true, version: "v1", text: "disk" };
    });
    const reading = files()[0].preflight!();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const writing = files()[0].save();
    store.edit("a", "not yet confirmed");
    finish();
    await expect(reading).rejects.toThrow();
    await expect(writing).rejects.toThrow();
    expect(api.saveOverviewFile).not.toHaveBeenCalled();
    expect(files()[0].readText?.()).toBe("not yet confirmed");
  });
  it("does not report a completed save if new edits arrive during the write", async () => {
    const { store, api, files } = setup(p.id);
    await store.open("a");
    store.edit("a", "first");
    let finish!: () => void;
    api.saveOverviewFile.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        finish = done;
      });
      return { relativePath: "a", exists: true, version: "v2", text: "first" };
    });
    const pending = files()[0].save();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    store.edit("a", "second");
    finish();
    await expect(pending).rejects.toThrow(/правк|измен/i);
    expect(files()[0].readText?.()).toBe("second");
  });
});

it.each([true, false])(
  "saves a shared path through real Project and Overview stores (identical buffers: %s)",
  async (identical) => {
    const { getProjectLeaveFiles } =
      await import("../src/renderer/project-leave-drafts");
    const { saveLeaveFiles } = await import("../src/renderer/workspace-leave");
    const owner = ctx("rev-one"),
      project = createSettingsDocuments(),
      sessions = createHomeSessions();
    const path = (target: { name: string }) =>
      ".goga/workflows/" + target.name + ".yml";
    const source = (name: string) => ({
      scope: "project" as const,
      projectId: owner.projectId,
      context: owner,
      target: { kind: "workflow" as const, name },
    });
    const shared = source("shared"),
      other = source("independent");
    const sharedPath = path(shared.target),
      otherPath = path(other.target);
    const disk = new Map([sharedPath, otherPath].map((p) => [p, "original"]));
    const read = (p: string) => {
      const text = disk.get(p);
      if (text == null) throw Error("fixture path mismatch");
      return { relativePath: p, version: text, text, exists: true };
    };
    const write = vi.fn((p: string, text: string, version: string) => {
      if (read(p).version !== version) throw Error("fixture version mismatch");
      disk.set(p, text);
      return read(p);
    });
    const api = {
      readProjectDocument: vi.fn(
        async (o: TopicContextRef, target: typeof shared.target) => {
          expect(o).toEqual(owner);
          return read(path(target));
        },
      ),
      saveProjectDocument: vi.fn(
        async (
          o: TopicContextRef,
          target: typeof shared.target,
          text: string,
          version: string,
        ) => {
          expect(o).toEqual(owner);
          return write(path(target), text, version);
        },
      ),
      readOverviewFile: vi.fn(async (o: TopicContextRef, p: string) => {
        expect(o).toEqual(owner);
        return read(p);
      }),
      saveOverviewFile: vi.fn(
        async (
          o: TopicContextRef,
          p: string,
          text: string,
          version: string,
        ) => {
          expect(o).toEqual(owner);
          return write(p, text, version);
        },
      ),
    };
    vi.stubGlobal("window", { goga: api });
    try {
      const overview = createOverviewStore(api as never, owner);
      const detach = sessions.attachOverview(overview, "retained", vi.fn());
      if (!identical) {
        await project.open(other);
        project.edit(other, "independent draft");
      }
      await project.open(shared);
      await overview.open(sharedPath);
      project.edit(shared, "project draft");
      overview.edit(sharedPath, identical ? "project draft" : "overview draft");
      const overviewMemory = overview.getSnapshot().files[sharedPath].memory;
      const collect = () => [
        ...getProjectLeaveFiles(project, owner, vi.fn()),
        ...getOverviewLeaveFiles(sessions, owner),
      ];
      expect(collect().map((f) => f.path)).toEqual(
        identical
          ? [sharedPath, sharedPath]
          : [otherPath, sharedPath, sharedPath],
      );
      if (identical) {
        await saveLeaveFiles(collect());
        expect(write).toHaveBeenCalledExactlyOnceWith(
          sharedPath,
          "project draft",
          "original",
        );
        expect(api.saveProjectDocument).toHaveBeenCalledTimes(1);
        expect(api.saveOverviewFile).not.toHaveBeenCalled();
        expect(project.get(shared).document).toEqual(read(sharedPath));
        expect(overview.getSnapshot().files[sharedPath].document).toEqual(
          read(sharedPath),
        );
        expect(overview.getSnapshot().files[sharedPath].memory).toBe(
          overviewMemory,
        );
        expect(collect()).toEqual([]);
      } else {
        await expect(saveLeaveFiles(collect())).rejects.toThrow(
          /двух редакторах/,
        );
        expect(write).not.toHaveBeenCalled();
        expect(read(otherPath).text).toBe("original");
        expect(read(sharedPath).text).toBe("original");
        expect(collect().map((f) => f.readText?.())).toEqual([
          "independent draft",
          "project draft",
          "overview draft",
        ]);
      }
      detach();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);
