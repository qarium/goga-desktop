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
