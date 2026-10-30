import { it, expect, vi } from "vitest";
import { createOverviewStore } from "../src/renderer/overview/store";
function setup() {
  const document = (p: string, text: string) => ({
    relativePath: p,
    text,
    version: "v-" + p,
    exists: true,
  });
  const api = {
    listOverviewDirectory: vi.fn(async (_s: any, p: string) => ({
      path: p,
      entries: [],
      truncated: false,
    })),
    readOverviewFile: vi.fn(async (_s: any, p: string) => document(p, "disk")),
    readOverviewSchema: vi.fn(async () => []),
    readOverviewContract: vi.fn(async () => ({})),
    saveOverviewFile: vi.fn(),
    createOverviewEntry: vi.fn(
      async (_s: any, p: string, _k: any, text: string) => document(p, text),
    ),
  };
  return { store: createOverviewStore(api as any, "p"), api };
}
it("remaps renamed folder tabs with fresh baselines while preserving drafts and editor memory", async () => {
  const { store, api } = setup();
  await store.open("src/a.ts");
  await store.open("src/b.ts");
  store.edit("src/a.ts", "draft");
  const memory = store.getSnapshot().files["src/a.ts"].memory;
  memory.scrollTop = 42;
  await store.applyFileAction("rename", ["src"], "next");
  const s = store.getSnapshot();
  expect(s.order).toEqual(["next/a.ts", "next/b.ts"]);
  expect(s.active).toBe("next/b.ts");
  expect(s.files["next/a.ts"].text).toBe("draft");
  expect(s.files["next/a.ts"].document.relativePath).toBe("next/a.ts");
  expect(s.files["next/a.ts"].memory).toBe(memory);
  expect(s.files["src/a.ts"]).toBeUndefined();
  expect(api.readOverviewFile).toHaveBeenCalledWith("p", "next/a.ts");
});
it("closes clean trashed tabs, retains dirty text as unavailable, and permits save copy", async () => {
  const { store, api } = setup();
  await store.open("src/a.ts");
  await store.open("src/b.ts");
  store.edit("src/a.ts", "draft");
  await store.applyFileAction("trash", ["src"]);
  const s = store.getSnapshot();
  expect(s.order).toEqual(["src/a.ts"]);
  expect(s.files["src/a.ts"].text).toBe("draft");
  expect(s.files["src/a.ts"].document.exists).toBe(false);
  expect(await store.save("src/a.ts")).toBe(false);
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
  expect(await store.saveCopy("src/a.ts", "copy.ts")).toBe(true);
  expect(api.createOverviewEntry).toHaveBeenCalledWith(
    "p",
    "copy.ts",
    "file",
    "draft",
  );
});
it("retains an unreadable renamed destination draft without enabling stale saves", async () => {
  const { store, api } = setup();
  await store.open("src/a.ts");
  store.edit("src/a.ts", "draft");
  api.readOverviewFile.mockRejectedValueOnce(Error("unavailable"));
  await store.applyFileAction("rename", ["src/a.ts"], "src/new.ts");
  expect(store.getSnapshot().files["src/new.ts"].text).toBe("draft");
  expect(await store.save("src/new.ts")).toBe(false);
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
});
it("never replaces an existing destination draft after trash and a rename into the same disk path", async () => {
  const { store } = setup();
  await store.open("a.ts");
  store.edit("a.ts", "original draft");
  await store.applyFileAction("trash", ["a.ts"]);
  await store.open("b.ts");
  store.edit("b.ts", "second draft");
  await expect(
    store.applyFileAction("rename", ["b.ts"], "a.ts"),
  ).rejects.toThrow(/черновик/i);
  const s = store.getSnapshot();
  expect(s.files["a.ts"].text).toBe("original draft");
  expect(s.files["b.ts"].text).toBe("second draft");
  expect(new Set(s.order).size).toBe(s.order.length);
  expect(await store.save("b.ts")).toBe(false);
});
it("preserves an existing destination child draft during a late folder rename collision", async () => {
  const { store } = setup();
  await store.open("next/a.ts");
  store.edit("next/a.ts", "destination draft");
  await store.applyFileAction("trash", ["next"]);
  await store.open("old/a.ts");
  store.edit("old/a.ts", "source draft");
  await expect(
    store.applyFileAction("rename", ["old"], "next"),
  ).rejects.toThrow(/черновик/i);
  expect(store.getSnapshot().files["next/a.ts"].text).toBe("destination draft");
  expect(store.getSnapshot().files["old/a.ts"].text).toBe("source draft");
  expect(new Set(store.getSnapshot().order).size).toBe(
    store.getSnapshot().order.length,
  );
});
