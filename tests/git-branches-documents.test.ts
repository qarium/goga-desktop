// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
const source = (id: string, name: string) => ({
  scope: "project" as const,
  projectId: id,
  target: { kind: "workflow" as const, name },
});
let api: any;
beforeEach(() => {
  api = {
    readProjectDocument: vi.fn(async () => ({
      text: "old",
      version: "1",
      exists: true,
    })),
  };
  Object.defineProperty(window, "goga", { value: api, configurable: true });
});
it("refreshes opened clean files after branch operation without losing dirty drafts or other owners", async () => {
  const store = createSettingsDocuments();
  const clean = source("p", "clean"),
    dirty = source("p", "dirty"),
    other = source("q", "other");
  await store.open(clean);
  await store.open(dirty);
  await store.open(other);
  store.edit(dirty, "unsaved");
  api.readProjectDocument.mockResolvedValue({
    text: "new branch",
    version: "2",
    exists: true,
  });
  await (store as any).refreshProject("p");
  expect(store.get(clean).text).toBe("new branch");
  expect(store.get(dirty).text).toBe("unsaved");
  expect(store.get(dirty).document?.version).toBe("1");
  expect(store.get(other).text).toBe("old");
  expect(store.projectRevision("p")).toBe(1);
  expect(store.projectRevision("q")).toBe(0);
});
it("does not open never revealed files and discards late old reads after a branch change", async () => {
  const store = createSettingsDocuments();
  let resolve!: (v: any) => void;
  api.readProjectDocument.mockImplementationOnce(
    () => new Promise((r) => (resolve = r)),
  );
  const clean = source("p", "clean");
  const initial = store.open(clean);
  const changed = (store as any).refreshProject("p");
  resolve({ text: "old late", version: "1", exists: true });
  await initial;
  await changed;
  expect(store.get(clean).text).toBe("old"); // second fresh response, not old late
  expect(api.readProjectDocument).toHaveBeenCalledTimes(2);
});

it.each(["resolve", "reject"])(
  "releases dirty drafts when branch refresh invalidates a pending deletion preview (%s)",
  async (outcome) => {
    const store = createSettingsDocuments();
    const dirty = source("p", "dirty");
    await store.open(dirty);
    store.edit(dirty, "unsaved important draft");
    let resolve!: (value: unknown) => void;
    let reject!: (reason: Error) => void;
    api.prepareDocumentDeletion = vi.fn(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const preview = store.prepareDeletion(dirty);
    expect(store.get(dirty).preparing).toBe(true);

    await store.refreshProject("p");
    expect(store.get(dirty)).toMatchObject({
      text: "unsaved important draft",
      busy: false,
      preparing: false,
      document: { version: "1" },
    });
    expect(store.get(dirty).deletion).toBeUndefined();
    store.edit(dirty, "edited after branch refresh");
    if (outcome === "resolve") resolve({ token: "stale-ticket" });
    else reject(new Error("stale preview error"));
    await preview;
    expect(store.get(dirty).text).toBe("edited after branch refresh");
    expect(store.get(dirty).busy).toBe(false);
    expect(store.get(dirty).deletion).toBeUndefined();
    expect(store.get(dirty).error).toBe("");
    expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  },
);

it.each(["save", "delete"])(
  "does not invalidate an executing document %s during branch refresh",
  async (operation) => {
    const store = createSettingsDocuments();
    const dirty = source("p", "dirty");
    await store.open(dirty);
    store.edit(dirty, "unsaved");
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    api.saveProjectDocument = vi.fn(() => pending);
    api.prepareDocumentDeletion = vi.fn(async () => ({ token: "ticket" }));
    api.deleteDocument = vi.fn(() => pending);
    let mutation: Promise<boolean>;
    if (operation === "save") mutation = store.save(dirty);
    else {
      await store.prepareDeletion(dirty);
      mutation = store.delete(dirty, store.get(dirty).deletion!);
    }
    const before = store.get(dirty);
    await store.refreshProject("p");
    expect(store.get(dirty)).toBe(before);
    expect(store.get(dirty).busy).toBe(true);
    finish(
      operation === "save"
        ? { text: "unsaved", version: "2", exists: true }
        : { status: "trashed" },
    );
    expect(await mutation).toBe(true);
    expect(store.get(dirty).busy).toBe(false);
  },
);

it("rereads one open project file, adopts its disk version and requires exact consent to replace edits", async () => {
  const store = createSettingsDocuments(),
    file = source("p", "edited");
  await store.open(file);
  api.readProjectDocument.mockResolvedValue({
    text: "external",
    version: "2",
    exists: true,
  });
  store.edit(file, "first draft");
  const obsoleteConsent = store.get(file);
  store.edit(file, "later draft");
  await store.reload(file);
  await store.reload(file, obsoleteConsent);
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  expect(store.get(file).text).toBe("later draft");
  await store.reload(file, store.get(file));
  expect(store.get(file)).toMatchObject({
    text: "external",
    document: { version: "2" },
    error: "",
  });
  store.edit(file, "next edit");
  api.saveProjectDocument = vi.fn(async () => ({
    text: "next edit",
    version: "3",
  }));
  expect(await store.save(file)).toBe(true);
  expect(api.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    file.target,
    "next edit",
    "2",
  );
});

it("never replaces an editor or its baseline if reload fails, the file disappears, or the user keeps typing", async () => {
  const store = createSettingsDocuments(),
    file = source("p", "edited");
  await store.open(file);
  store.edit(file, "unsaved");
  api.readProjectDocument.mockRejectedValueOnce(Error("Отказано в доступе"));
  await store.reload(file, store.get(file));
  expect(store.get(file)).toMatchObject({
    text: "unsaved",
    document: { version: "1" },
    busy: false,
  });
  expect(store.get(file).reloadError).toContain("Отказано в доступе");
  api.readProjectDocument.mockResolvedValueOnce({
    text: "",
    version: "missing",
    exists: false,
  });
  await store.reload(file, store.get(file));
  expect(store.get(file)).toMatchObject({
    text: "unsaved",
    document: { version: "1" },
    busy: false,
  });
  let finish!: (value: unknown) => void;
  api.readProjectDocument.mockImplementationOnce(
    () => new Promise((r) => (finish = r)),
  );
  const pending = store.reload(file, store.get(file));
  store.edit(file, "typed while reading");
  finish({ text: "external", version: "2", exists: true });
  await pending;
  expect(store.get(file)).toMatchObject({
    text: "typed while reading",
    document: { version: "1" },
    busy: false,
    error: "",
  });
});

it("a checkout supersedes a slow manual reload and only the new branch snapshot becomes visible", async () => {
  const store = createSettingsDocuments(),
    file = source("p", "clean");
  await store.open(file);
  let finish!: (value: unknown) => void;
  api.readProjectDocument.mockImplementationOnce(
    () => new Promise((r) => (finish = r)),
  );
  api.readProjectDocument.mockResolvedValueOnce({
    text: "new branch",
    version: "3",
    exists: true,
  });
  const previous = store.reload(file);
  const checkout = store.refreshProject("p");
  finish({ text: "old branch", version: "2", exists: true });
  await Promise.all([previous, checkout]);
  expect(store.get(file)).toMatchObject({
    text: "new branch",
    document: { version: "3" },
    busy: false,
  });
});

it("a rename cannot replace a local unsaved destination or target a fixed filename", async () => {
  const store = createSettingsDocuments();
  const from = source("p", "first");
  await store.open(from);
  store.edit(from, "unsaved first");
  store.createWorkflow("p", "Next", []);
  store.edit(source("p", "Next"), "unsaved next");
  api.renameProjectDocument = vi.fn();
  await expect(store.rename(from, "next")).rejects.toThrow(/уже используется/);
  await expect(
    store.rename({ ...from, target: { kind: "config" } }, "unused"),
  ).rejects.toThrow();
  expect(store.get(source("p", "Next")).text).toBe("unsaved next");
  expect(store.get(from).text).toBe("unsaved first");
  expect(api.renameProjectDocument).not.toHaveBeenCalled();
});
it("reserves the destination until rename settles without stealing a changed selection or another owner's draft", async () => {
  const store = createSettingsDocuments(),
    old = source("p", "first"),
    next = source("p", "next"),
    other = source("q", "next");
  await store.open(old);
  store.edit(old, "pending p");
  await store.open(other);
  store.edit(other, "pending q");
  store.updateWorkflow("p", { selected: "first" });
  let done!: (value: unknown) => void;
  api.renameProjectDocument = vi.fn(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const rename = store.rename(old, "next");
  expect(store.busy()).toBe(true);
  expect(() => store.createWorkflow("p", "NEXT", [])).toThrow();
  await store.open(next);
  await store.refreshProject("p");
  store.updateWorkflow("p", { selected: "another" });
  done({
    version: "2",
    exists: true,
    text: "old",
    relativePath: ".goga/workflows/next.yml",
  });
  await rename;
  expect(store.workflowState("p").selected).toBe("another");
  expect(store.get(next)).toMatchObject({
    text: "pending p",
    document: { version: "2", text: "old" },
  });
  expect(store.get(other).text).toBe("pending q");
  expect(store.busy()).toBe(false);
  expect(api.readProjectDocument).toHaveBeenCalledTimes(2);
});

it("offers only edited files from the exact Project workspace, including unmounted editors, to the leave reminder", async () => {
  const { getProjectLeaveFiles } =
    await import("../src/renderer/project-leave-drafts");
  const store = createSettingsDocuments(),
    onReveal = vi.fn();
  const ref = {
    projectId: "p",
    year: "2026",
    topic: "t",
    branch: "t",
    contextId: "ctx-a",
    revision: "rev-1",
  };
  const scoped = { ...source("p", "scoped"), context: ref };
  const targets = [
    { kind: "workflow", name: "w" },
    { kind: "pipeline", name: "p" },
    { kind: "config" },
    { kind: "profile", name: "local" },
    { kind: "dockerfile", path: "build/Dockerfile" },
    { kind: "tool", tool: "mkdocs", path: "doc/data.yml" },
  ] as const;
  api.readSettings = api.readProjectDocument;
  api.saveProjectDocument = vi.fn(async (_scope, _target, text) => ({
    text,
    version: "2",
    exists: true,
  }));
  for (const target of targets) {
    const src = { scope: "project" as const, projectId: "p", target };
    await store.open(src);
    store.edit(src, "my text");
  }
  for (const src of [
    scoped,
    { ...scoped, context: { ...ref, revision: "rev-2" } },
    source("q", "foreign"),
    { scope: "home" as const, kind: "config" as const },
  ]) {
    await store.open(src);
    store.edit(src, "not in primary");
  }
  await store.open(source("p", "clean"));
  const files = getProjectLeaveFiles(store, "p", onReveal);
  expect(files.map((f) => f.path).sort()).toEqual(
    [
      ".goga/workflows/w.yml",
      ".goga/pipelines/p.yml",
      ".goga/config.yml",
      ".goga/profiles/local.yml",
      "build/Dockerfile",
      ".goga/tools/mkdocs/doc/data.yml",
    ].sort(),
  );
  const contextFiles = getProjectLeaveFiles(store, ref, onReveal);
  expect(contextFiles).toHaveLength(1);
  expect(contextFiles[0].readText?.()).toBe("not in primary");
  contextFiles[0].reveal?.();
  expect(onReveal).toHaveBeenCalledWith("workflows");
  await contextFiles[0].preflight?.();
  await contextFiles[0].save();
  expect(api.saveProjectDocument).toHaveBeenCalledTimes(1);
  expect(api.saveProjectDocument).toHaveBeenCalledWith(
    ref,
    scoped.target,
    "not in primary",
    "1",
  );
  expect(getProjectLeaveFiles(store, ref, onReveal)).toEqual([]);
  expect(getProjectLeaveFiles(store, "p", onReveal)).toHaveLength(6);
});

it("preflights external versions without exposing or replacing a draft and checks the live buffer again at write time", async () => {
  const { getProjectLeaveFiles } =
    await import("../src/renderer/project-leave-drafts");
  const store = createSettingsDocuments(),
    file = source("p", "conflict");
  await store.open(file);
  store.edit(file, "draft");
  const [handle] = getProjectLeaveFiles(store, "p", vi.fn());
  api.saveProjectDocument = vi.fn();
  api.readProjectDocument.mockResolvedValueOnce({
    text: "external",
    version: "2",
    exists: true,
  });
  await expect(handle.preflight?.()).rejects.toThrow(/изменился/);
  expect(store.get(file).text).toBe("draft");
  await handle.preflight?.();
  store.edit(file, "later text");
  await expect(handle.save()).rejects.toThrow();
  expect(store.get(file).text).toBe("later text");
  expect(api.saveProjectDocument).not.toHaveBeenCalled();

  const [latest] = getProjectLeaveFiles(store, "p", vi.fn());
  api.saveProjectDocument.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:save-project-document': Error: Конфликт сохранения: файл изменился.",
    ),
  );
  await expect(latest.save()).rejects.toThrow(/^Конфликт сохранения:/);
  expect(store.get(file)).toMatchObject({
    text: "later text",
    document: { text: "old", version: "1" },
  });
});

it("does not let a previous reminder write or reveal a replacement buffer with the same name and text", async () => {
  const { getProjectLeaveFiles } =
    await import("../src/renderer/project-leave-drafts");
  const store = createSettingsDocuments(),
    file = source("p", "again"),
    onReveal = vi.fn();
  await store.open(file);
  store.edit(file, "same");
  const [old] = getProjectLeaveFiles(store, "p", onReveal);
  store.discard(file);
  await store.open(file);
  store.edit(file, "same");
  await expect(old.save()).rejects.toThrow();
  old.reveal?.();
  expect(onReveal).not.toHaveBeenCalled();
  expect(old.readText?.()).toBeNull();
});

it("saves a new tool draft only with its original missing version", async () => {
  const { getProjectLeaveFiles } =
    await import("../src/renderer/project-leave-drafts");
  const store = createSettingsDocuments(),
    file = {
      scope: "project" as const,
      projectId: "p",
      target: { kind: "tool" as const, tool: "demo", path: "new.yml" },
    };
  store.createToolFile("p", "demo", "new.yml", [{ name: "demo", entries: [] }]);
  store.edit(file, "enabled: true");
  const fs = await import("node:fs/promises"),
    path = await import("node:path"),
    { tmpdir } = await import("node:os");
  const host = await import("../src/host/project-documents");
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "goga-leave-new-tool-")),
  );
  try {
    const directory = path.join(root, ".goga/tools/demo");
    const destination = path.join(directory, "new.yml");
    await fs.mkdir(directory, { recursive: true });
    api.readProjectDocument.mockImplementation(
      async (_scope: unknown, target: typeof file.target) => {
        try {
          return await host.readProjectDocument(root, target);
        } catch (e) {
          throw Error(
            "Error invoking remote method 'goga:read-request': " + String(e),
          );
        }
      },
    );
    api.saveProjectDocument = vi.fn((_scope, target, text, version) =>
      host.saveProjectDocument(root, target, text, version),
    );
    const [handle] = getProjectLeaveFiles(store, "p", vi.fn());
    await expect(
      host.readProjectDocument(root, file.target),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await handle.preflight?.();
    expect(await fs.readdir(directory)).toEqual([]);
    await fs.writeFile(destination, "fresh: elsewhere");
    await expect(handle.preflight?.()).rejects.toThrow(/изменился/);
    await expect(handle.save()).rejects.toThrow(/Конфликт/);
    expect(await fs.readFile(destination, "utf8")).toBe("fresh: elsewhere");
    expect(store.get(file).text).toBe("enabled: true");
    await fs.unlink(destination);
    await handle.preflight?.();
    await handle.save();
    expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
      "p",
      file.target,
      "enabled: true",
      "missing",
    );
    expect(await fs.readFile(destination, "utf8")).toBe("enabled: true");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
