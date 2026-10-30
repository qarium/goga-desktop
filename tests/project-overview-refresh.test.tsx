// @vitest-environment jsdom
import React, { useSyncExternalStore } from "react";
import { EditorState } from "@codemirror/state";
import { history, undoDepth } from "@codemirror/commands";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOverviewStore,
  type OverviewAPI,
} from "../src/renderer/overview/store";
import type {
  OverviewDirectory,
  OverviewFile,
} from "../src/shared/project-overview";
import { ProjectOverview } from "../src/renderer/overview/ProjectOverview";
import { RetainedViews } from "../src/renderer/RetainedViews";
import "./helpers/overview-browser-fixture";
import type { DesktopAPI } from "../src/shared/bridge";
import type {
  CellContract,
  SchemaCell,
} from "../src/shared/project-architecture";

const document = (
  path: string,
  text: string,
  version = text,
): OverviewFile => ({
  relativePath: path,
  text,
  version,
  exists: true,
});
const directory = (path: string, names: string[] = []): OverviewDirectory => ({
  path,
  entries: names.map((name) => ({
    path: path ? `${path}/${name}` : name,
    name,
    kind: "file",
  })),
  truncated: false,
});
const schema = (cell = "src"): SchemaCell[] => [
  {
    cell,
    description: "Description",
    types: [],
    usages: [],
    dependencies: {},
    children: [],
  },
];
const contract = (name: string): CellContract => ({
  [name]: { signature: { codemanifest: name, implementation: null } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const disk = new Map<string, OverviewFile>([
    ["a.ts", document("a.ts", "a", "a1")],
    ["src/b.ts", document("src/b.ts", "b", "b1")],
  ]);
  const api = {
    listOverviewDirectory: vi.fn(async (_scope, path) =>
      directory(path, ["entry.ts"]),
    ),
    searchOverviewFiles: vi.fn(async (_scope, path) => directory(path)),
    readOverviewFile: vi.fn(async (_scope, path) => {
      const value = disk.get(path);
      if (!value) throw new Error("Файл удалён");
      return { ...value };
    }),
    saveOverviewFile: vi.fn(async (_scope, path, text, version) => {
      if (disk.get(path)?.version !== version)
        throw new Error("Файл изменён на диске");
      const value = document(path, text, `${version}+`);
      disk.set(path, value);
      return { ...value };
    }),
    createOverviewEntry: vi.fn(async (_scope, path, kind, text = "") => {
      if (disk.has(path)) throw new Error("Путь уже существует");
      if (kind === "directory") return null;
      const value = document(path, text, "created");
      disk.set(path, value);
      return value;
    }),
    readOverviewSchema: vi.fn(async () => schema()),
    readOverviewContract: vi.fn(async (_scope, cell) => contract(cell)),
  } satisfies OverviewAPI;
  const onMutation = vi.fn();
  const store = createOverviewStore(api, "project", onMutation);
  return { disk, api, store, onMutation };
}
afterEach(cleanup);

describe("overview file and refresh state", () => {
  it("publishes immutable snapshots usable by useSyncExternalStore and retains tab memory", async () => {
    const { store } = fixture();
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    function Observer() {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
      return (
        <p>
          {state.active}:
          {state.active ? state.files[state.active].text : "empty"}
        </p>
      );
    }
    render(<Observer />);
    await act(async () => {
      await store.open("a.ts");
    });
    const memory = store.getSnapshot().files["a.ts"].memory;
    act(() => {
      store.edit("a.ts", "draft");
    });
    expect(screen.getByText("a.ts:draft")).toBeTruthy();
    expect(store.getSnapshot()).not.toBe(initial);
    expect(store.getSnapshot().files["a.ts"].memory).toBe(memory);
    expect(store.getSnapshot().order).toEqual(["a.ts"]);
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    unsubscribe();
    store.activate("a.ts");
    expect(notify).not.toHaveBeenCalled();
  });

  it("refreshes one file without schema, contract, directory or other-file reads", async () => {
    const { api, disk, store } = fixture();
    await store.open("a.ts");
    await store.open("src/b.ts");
    disk.set("a.ts", document("a.ts", "outside", "a2"));
    await store.refreshFile("a.ts");
    expect(store.getSnapshot().files["a.ts"].text).toBe("outside");
    expect(store.getSnapshot().active).toBe("src/b.ts");
    expect(api.readOverviewFile.mock.calls.map((call) => call[1])).toEqual([
      "a.ts",
      "src/b.ts",
      "a.ts",
    ]);
    expect(api.readOverviewSchema).not.toHaveBeenCalled();
    expect(api.readOverviewContract).not.toHaveBeenCalled();
    expect(api.listOverviewDirectory).not.toHaveBeenCalled();
  });

  it("refreshes schema, loaded directories, every open file and the active contract", async () => {
    const { api, disk, store } = fixture();
    await store.loadDirectory("");
    await store.loadDirectory("src");
    await store.open("a.ts");
    await store.open("src/b.ts");
    await store.showContract("src");
    disk.set("a.ts", document("a.ts", "new a", "a2"));
    disk.set("src/b.ts", document("src/b.ts", "new b", "b2"));
    api.readOverviewSchema.mockResolvedValue(schema("changed"));
    api.readOverviewContract.mockResolvedValue(contract("new"));
    await store.refreshAll();
    expect(store.getSnapshot().schema).toEqual(schema("changed"));
    expect(store.getSnapshot().files["a.ts"].text).toBe("new a");
    expect(store.getSnapshot().files["src/b.ts"].text).toBe("new b");
    expect(store.getSnapshot().contract).toEqual(contract("new"));
    expect(api.listOverviewDirectory.mock.calls.map((call) => call[1])).toEqual(
      ["", "src", "", "src"],
    );
    expect(api.readOverviewContract).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().refreshing).toBe(false);
    expect(store.getSnapshot().stale).toBe(false);
  });

  it("preserves dirty text, baseline version and undo while indicating external disk changes", async () => {
    const { disk, store } = fixture();
    await store.open("a.ts");
    store.edit("a.ts", "draft");
    const memory = store.getSnapshot().files["a.ts"].memory;
    memory.scrollTop = 23;
    memory.state = EditorState.create({
      doc: "a",
      extensions: [history()],
    }).update({ changes: { from: 0, to: 1, insert: "draft" } }).state;
    expect(undoDepth(memory.state)).toBe(1);
    await store.refreshAll();
    expect(store.getSnapshot().files["a.ts"].changedExternally).toBeFalsy();
    disk.set("a.ts", document("a.ts", "outside", "a2"));
    await store.refreshAll();
    expect(store.getSnapshot().files["a.ts"]).toMatchObject({
      text: "draft",
      document: { text: "a", version: "a1" },
      changedExternally: true,
    });
    expect(store.getSnapshot().files["a.ts"].memory).toBe(memory);
    expect(memory.scrollTop).toBe(23);
    expect(undoDepth(memory.state!)).toBe(1);
    expect(memory.state!.doc.toString()).toBe("draft");
  });

  it("requires confirmation to discard a draft and resets memory only after confirmed replacement", async () => {
    const { api, disk, store } = fixture();
    await store.open("a.ts");
    store.edit("a.ts", "draft");
    const memory = store.getSnapshot().files["a.ts"].memory;
    disk.set("a.ts", document("a.ts", "outside", "a2"));
    expect(await store.refreshFile("a.ts")).toBe("needs-confirmation");
    expect(api.readOverviewFile).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().files["a.ts"].text).toBe("draft");
    expect(await store.refreshFile("a.ts", true)).toBe("refreshed");
    expect(store.getSnapshot().files["a.ts"].text).toBe("outside");
    expect(store.getSnapshot().files["a.ts"].memory).not.toBe(memory);
  });

  it.each([false, true])(
    "does not replace a draft typed during an awaited refresh (confirmed=%s)",
    async (confirmed) => {
      const { api, store } = fixture();
      await store.open("a.ts");
      if (confirmed) store.edit("a.ts", "earlier draft");
      const pending = deferred<OverviewFile>();
      api.readOverviewFile.mockReturnValueOnce(pending.promise);
      const memory = store.getSnapshot().files["a.ts"].memory;
      const read = confirmed
        ? store.refreshFile("a.ts", true)
        : store.refreshAll();
      await Promise.resolve();
      store.edit("a.ts", "typed during read");
      pending.resolve(document("a.ts", "outside", "a2"));
      await read;
      expect(store.getSnapshot().files["a.ts"]).toMatchObject({
        text: "typed during read",
        document: { version: "a1" },
        changedExternally: true,
      });
      expect(store.getSnapshot().files["a.ts"].memory).toBe(memory);
    },
  );

  it("retains deleted files, rejects automatic recreation and refreshes the other regions independently", async () => {
    const { api, disk, store } = fixture();
    await store.open("a.ts");
    await store.open("src/b.ts");
    disk.delete("a.ts");
    disk.set("src/b.ts", document("src/b.ts", "new b", "b2"));
    api.readOverviewSchema.mockRejectedValue(new Error("Нет Goga"));
    await store.refreshAll();
    expect(store.getSnapshot().files["a.ts"].text).toBe("a");
    expect(store.getSnapshot().files["a.ts"].error).toContain("удалён");
    expect(store.getSnapshot().order).toEqual(["a.ts", "src/b.ts"]);
    expect(store.getSnapshot().files["src/b.ts"].text).toBe("new b");
    expect(store.getSnapshot().schemaError).toBe("Нет Goga");
    expect(store.getSnapshot().stale).toBe(true);
    expect(await store.save("a.ts")).toBe(false);
    expect(api.createOverviewEntry).not.toHaveBeenCalled();
  });

  it("treats exists=false as deletion rather than replacing the tab with an empty document", async () => {
    const { api, store } = fixture();
    await store.open("a.ts");
    api.readOverviewFile.mockResolvedValueOnce({
      ...document("a.ts", "", "missing"),
      exists: false,
    });
    expect(await store.refreshFile("a.ts")).toBe("failed");
    expect(store.getSnapshot().files["a.ts"].text).toBe("a");
    expect(store.getSnapshot().files["a.ts"].error).toBeTruthy();
    expect(await store.save("a.ts")).toBe(false);
    expect(api.saveOverviewFile).not.toHaveBeenCalled();
  });

  it("retains file and schema data on errors and clears errors after a successful retry", async () => {
    const { api, store } = fixture();
    await store.loadDirectory("");
    await store.open("a.ts");
    await store.refreshAll();
    api.listOverviewDirectory.mockRejectedValueOnce(new Error("Нет доступа"));
    api.readOverviewSchema.mockRejectedValueOnce(new Error("CLI failed"));
    api.readOverviewFile.mockRejectedValueOnce(new Error("Read failed"));
    await store.refreshAll();
    expect(store.getSnapshot().directories[""]).toEqual(
      directory("", ["entry.ts"]),
    );
    expect(store.getSnapshot().directoryErrors[""]).toBe("Нет доступа");
    expect(store.getSnapshot().schema).toEqual(schema());
    expect(store.getSnapshot().schemaError).toBe("CLI failed");
    expect(store.getSnapshot().files["a.ts"].text).toBe("a");
    await store.refreshAll();
    expect(store.getSnapshot().directoryErrors[""]).toBeFalsy();
    expect(store.getSnapshot().schemaError).toBe("");
    expect(store.getSnapshot().files["a.ts"].error).toBeFalsy();
  });

  it("saves with the original expected version and offers a new copy without losing the source draft", async () => {
    const { api, disk, store, onMutation } = fixture();
    await store.loadDirectory("");
    await store.open("a.ts");
    store.edit("a.ts", "draft");
    disk.set("a.ts", document("a.ts", "outside", "a2"));
    await store.refreshAll();
    expect(await store.save("a.ts")).toBe(false);
    expect(api.saveOverviewFile).toHaveBeenCalledWith(
      "project",
      "a.ts",
      "draft",
      "a1",
    );
    expect(store.getSnapshot().files["a.ts"].text).toBe("draft");
    expect(await store.saveCopy("a.ts", "copy.ts")).toBe(true);
    expect(api.createOverviewEntry).toHaveBeenCalledWith(
      "project",
      "copy.ts",
      "file",
      "draft",
    );
    expect(store.getSnapshot().files["copy.ts"].text).toBe("draft");
    expect(store.getSnapshot().files["a.ts"].text).toBe("draft");
    expect(store.getSnapshot().files["a.ts"].document.version).toBe("a1");
    expect(store.getSnapshot().active).toBe("copy.ts");
    expect(store.getSnapshot().stale).toBe(true);
    expect(onMutation).toHaveBeenCalledTimes(1);
    expect(api.readOverviewSchema).toHaveBeenCalledTimes(1);
    expect(api.listOverviewDirectory).toHaveBeenCalledTimes(3);
  });

  it("preserves edits and undo typed during save while adopting only the saved baseline", async () => {
    const { api, store, onMutation } = fixture();
    await store.open("a.ts");
    store.edit("a.ts", "saving");
    const memory = store.getSnapshot().files["a.ts"].memory;
    const pending = deferred<OverviewFile>();
    api.saveOverviewFile.mockReturnValueOnce(pending.promise);
    const saved = store.save("a.ts");
    await Promise.resolve();
    store.edit("a.ts", "newer draft");
    pending.resolve(document("a.ts", "saving", "a2"));
    expect(await saved).toBe(true);
    expect(store.getSnapshot().files["a.ts"]).toMatchObject({
      text: "newer draft",
      document: { text: "saving", version: "a2" },
      busy: false,
    });
    expect(store.getSnapshot().files["a.ts"].memory).toBe(memory);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("serializes reads behind saves of the same file while leaving another file available", async () => {
    const { api, store } = fixture();
    await store.open("a.ts");
    await store.open("src/b.ts");
    store.edit("a.ts", "saving");
    const pending = deferred<OverviewFile>();
    api.saveOverviewFile.mockReturnValueOnce(pending.promise);
    const saved = store.save("a.ts");
    await Promise.resolve();
    const refreshed = store.refreshAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      api.readOverviewFile.mock.calls.filter((call) => call[1] === "a.ts"),
    ).toHaveLength(1);
    expect(store.getSnapshot().files["a.ts"].busy).toBe(true);
    expect(store.getSnapshot().files["src/b.ts"].text).toBe("b");
    pending.resolve(document("a.ts", "saving", "a2"));
    await saved;
    await refreshed;
    expect(
      api.readOverviewFile.mock.calls.filter((call) => call[1] === "a.ts"),
    ).toHaveLength(2);
    expect(store.getSnapshot().stale).toBe(true);
  });

  it("ignores late contract responses and errors after navigation or closing", async () => {
    const { api, store } = fixture();
    const a = deferred<CellContract>();
    const b = deferred<CellContract>();
    api.readOverviewContract
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);
    const old = store.showContract("a");
    const current = store.showContract("b");
    b.resolve(contract("B"));
    await current;
    a.reject(new Error("Old failure"));
    await old;
    expect(store.getSnapshot().contractCell).toBe("b");
    expect(store.getSnapshot().contract).toEqual(contract("B"));
    expect(store.getSnapshot().contractError).toBe("");
    const closed = deferred<CellContract>();
    api.readOverviewContract.mockReturnValueOnce(closed.promise);
    const read = store.showContract("c");
    store.closeContract();
    closed.resolve(contract("C"));
    await read;
    expect(store.getSnapshot().contractCell).toBeNull();
    expect(store.getSnapshot().contract).toBeNull();
  });

  it("coalesces repeated refreshes instead of queuing Goga processes", async () => {
    const { api, store } = fixture();
    const pending = deferred<SchemaCell[]>();
    api.readOverviewSchema.mockReturnValueOnce(pending.promise);
    const first = store.refreshAll();
    const second = store.refreshAll();
    expect(second).toBe(first);
    expect(store.getSnapshot().refreshing).toBe(true);
    expect(api.readOverviewSchema).toHaveBeenCalledTimes(1);
    pending.resolve(schema());
    await first;
    expect(store.getSnapshot().refreshing).toBe(false);
  });

  it("closes atomically only after draft confirmation and does not reuse old tab responses", async () => {
    const { api, store } = fixture();
    await store.open("a.ts");
    await store.open("src/b.ts");
    store.edit("a.ts", "draft");
    expect(store.close(["a.ts", "src/b.ts"])).toBe(false);
    expect(store.getSnapshot().order).toEqual(["a.ts", "src/b.ts"]);
    const old = deferred<OverviewFile>();
    api.readOverviewFile.mockReturnValueOnce(old.promise);
    const read = store.refreshFile("src/b.ts");
    await Promise.resolve();
    expect(store.close(["src/b.ts"])).toBe(true);
    await store.open("src/b.ts");
    old.resolve(document("src/b.ts", "obsolete", "old"));
    await read;
    expect(store.getSnapshot().files["src/b.ts"].text).toBe("b");
    expect(store.close(store.getSnapshot().order, true)).toBe(true);
    expect(store.getSnapshot().active).toBeNull();
    expect(store.getSnapshot().files).toEqual({});
  });

  it("creates entries without running Goga, reloads the loaded parent and exposes creation errors", async () => {
    const { api, store, onMutation } = fixture();
    await store.loadDirectory("src");
    expect(await store.create("src/new", "directory")).toBe(true);
    expect(api.createOverviewEntry).toHaveBeenCalledWith(
      "project",
      "src/new",
      "directory",
      undefined,
    );
    expect(api.listOverviewDirectory).toHaveBeenCalledTimes(2);
    expect(api.readOverviewSchema).not.toHaveBeenCalled();
    expect(onMutation).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().stale).toBe(true);
    expect(await store.create("a.ts", "file", "do not replace")).toBe(false);
    expect(store.getSnapshot().creationError).toBe("Путь уже существует");
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("retains a failed-open tab and can retry it without creating a file", async () => {
    const { disk, store } = fixture();
    await store.open("missing.ts");
    expect(store.getSnapshot().order).toEqual(["missing.ts"]);
    expect(store.getSnapshot().files["missing.ts"].error).toBeTruthy();
    disk.set("missing.ts", document("missing.ts", "available", "now"));
    expect(await store.refreshFile("missing.ts")).toBe("refreshed");
    expect(store.getSnapshot().files["missing.ts"].text).toBe("available");
  });

  it("preserves memory for byte-identical clean reads and invalidates it for changed text", async () => {
    const { store, disk } = fixture();
    await store.open("a.ts");
    const memory = store.getSnapshot().files["a.ts"].memory;
    await store.refreshFile("a.ts");
    expect(store.getSnapshot().files["a.ts"].memory).toBe(memory);
    disk.set("a.ts", document("a.ts", "different", "a2"));
    await store.refreshFile("a.ts");
    expect(store.getSnapshot().files["a.ts"].memory).not.toBe(memory);
  });

  it("isolates owners and ignores every late update after disposal", async () => {
    const { api } = fixture();
    const scope = {
      projectId: "p",
      topic: "t",
      year: "2026",
      branch: "b",
      contextId: "context",
      revision: "2",
    };
    const store = createOverviewStore(api, scope);
    const pending = deferred<OverviewFile>();
    api.readOverviewFile.mockReturnValueOnce(pending.promise);
    const read = store.open("a.ts");
    await Promise.resolve();
    scope.contextId = "changed";
    expect(api.readOverviewFile.mock.calls[0][0]).toMatchObject({
      contextId: "context",
    });
    const notify = vi.fn();
    store.subscribe(notify);
    store.dispose();
    const snapshot = store.getSnapshot();
    pending.resolve(document("a.ts", "late"));
    await read;
    await store.refreshAll();
    await store.showContract("new");
    await store.loadDirectory("");
    await store.create("new", "file");
    expect(store.getSnapshot()).toBe(snapshot);
    expect(notify).not.toHaveBeenCalled();
    expect(api.readOverviewSchema).not.toHaveBeenCalled();
    expect(api.readOverviewContract).not.toHaveBeenCalled();
    expect(api.listOverviewDirectory).not.toHaveBeenCalled();
    expect(api.createOverviewEntry).not.toHaveBeenCalled();
  });
});

describe("overview scope revisions", () => {
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "t",
    branch: "b",
    contextId: "ctx-a",
    revision: "revision-1",
  };

  it("keeps drafts and memory while allowing a new revision refresh before old reads finish", async () => {
    const { api } = fixture();
    const store = createOverviewStore(api, scope);
    await store.open("a.ts");
    store.edit("a.ts", "draft");
    const memory = store.getSnapshot().files["a.ts"].memory;
    const old = deferred<OverviewFile>();
    api.readOverviewFile.mockReturnValueOnce(old.promise);
    const previous = store.refreshAll();
    await Promise.resolve();
    store.setScope({ ...scope, revision: "revision-2" });
    const next = store.refreshAll();
    expect(next).not.toBe(previous);
    await next;
    expect(api.readOverviewFile.mock.calls.at(-1)?.[0]).toMatchObject({
      revision: "revision-2",
    });
    expect(store.getSnapshot().refreshing).toBe(false);
    const snapshot = store.getSnapshot();
    old.resolve(document("a.ts", "obsolete", "old"));
    await previous;
    expect(store.getSnapshot()).toBe(snapshot);
    expect(store.getSnapshot().files["a.ts"].text).toBe("draft");
    expect(store.getSnapshot().files["a.ts"].memory).toBe(memory);
    expect(await store.save("a.ts")).toBe(true);
    expect(api.saveOverviewFile.mock.calls.at(-1)?.[0]).toMatchObject({
      revision: "revision-2",
    });
  });

  it("ignores old schema, directory and contract errors without ending a new refresh", async () => {
    const { api } = fixture();
    const store = createOverviewStore(api, scope);
    await store.loadDirectory("");
    await store.showContract("src");
    const oldSchema = deferred<SchemaCell[]>();
    const oldDirectory = deferred<OverviewDirectory>();
    const oldContract = deferred<CellContract>();
    api.readOverviewSchema.mockReturnValueOnce(oldSchema.promise);
    api.listOverviewDirectory.mockReturnValueOnce(oldDirectory.promise);
    api.readOverviewContract.mockReturnValueOnce(oldContract.promise);
    const previous = store.refreshAll();
    store.setScope({ ...scope, revision: "revision-2" });
    const nextSchema = deferred<SchemaCell[]>();
    api.readOverviewSchema.mockReturnValueOnce(nextSchema.promise);
    const next = store.refreshAll();
    oldSchema.reject(new Error("old schema"));
    oldDirectory.reject(new Error("old directory"));
    oldContract.reject(new Error("old contract"));
    await previous;
    expect(store.getSnapshot().refreshing).toBe(true);
    expect(store.getSnapshot().schemaError).toBe("");
    expect(store.getSnapshot().directoryErrors[""]).toBeFalsy();
    expect(store.getSnapshot().contractError).toBe("");
    nextSchema.resolve(schema("new"));
    await next;
    expect(store.getSnapshot().schema).toEqual(schema("new"));
    expect(api.listOverviewDirectory.mock.calls.at(-1)?.[0]).toMatchObject({
      revision: "revision-2",
    });
    expect(api.readOverviewContract.mock.calls.at(-1)?.[0]).toMatchObject({
      revision: "revision-2",
    });
  });

  it("does not carry a queued write into a new revision or let an old create open a tab", async () => {
    const { api, onMutation } = fixture();
    const store = createOverviewStore(api, scope, onMutation);
    await store.open("a.ts");
    const oldRead = deferred<OverviewFile>();
    const oldCreate = deferred<OverviewFile>();
    api.readOverviewFile.mockReturnValueOnce(oldRead.promise);
    api.createOverviewEntry.mockReturnValueOnce(oldCreate.promise);
    const read = store.refreshFile("a.ts");
    await Promise.resolve();
    const saved = store.save("a.ts");
    const created = store.create("late.ts", "file");
    store.setScope({ ...scope, revision: "revision-2" });
    oldRead.resolve(document("a.ts", "old"));
    oldCreate.resolve(document("late.ts", "old"));
    await Promise.all([read, saved, created]);
    expect(api.saveOverviewFile).not.toHaveBeenCalled();
    expect(store.getSnapshot().order).toEqual(["a.ts"]);
    expect(onMutation).not.toHaveBeenCalled();
    expect(store.getSnapshot().files["a.ts"].busy).toBe(false);
  });

  it("is a no-op for identical revisions and refuses another logical owner", async () => {
    const { api } = fixture();
    const store = createOverviewStore(api, scope);
    await store.open("a.ts");
    const snapshot = store.getSnapshot();
    store.setScope({ ...scope });
    expect(store.getSnapshot()).toBe(snapshot);
    expect(() => store.setScope({ ...scope, contextId: "other" })).toThrow();
    expect(store.getSnapshot()).toBe(snapshot);
  });
});

describe("overview completed mutations", () => {
  it("rereads a loaded parent after a mutation even when its previous read is still pending", async () => {
    const { api, store } = fixture();
    await store.loadDirectory("");
    const old = deferred<OverviewDirectory>();
    api.listOverviewDirectory
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(directory("", ["copy.ts"]));
    const read = store.loadDirectory("");
    const created = store.create("copy.ts", "file", "copy");
    await Promise.resolve();
    old.resolve(directory("", ["old.ts"]));
    await Promise.all([read, created]);
    expect(api.listOverviewDirectory).toHaveBeenCalledTimes(3);
    expect(
      store.getSnapshot().directories[""].entries.map((entry) => entry.name),
    ).toEqual(["copy.ts"]);
  });

  it("invalidates architecture and notifies for a completed save even when its tab was closed", async () => {
    const { api, store, onMutation } = fixture();
    await store.open("a.ts");
    store.edit("a.ts", "saved");
    const pending = deferred<OverviewFile>();
    api.saveOverviewFile.mockReturnValueOnce(pending.promise);
    const saved = store.save("a.ts");
    await Promise.resolve();
    store.close(["a.ts"], true);
    pending.resolve(document("a.ts", "saved", "a2"));
    expect(await saved).toBe(true);
    expect(store.getSnapshot().files["a.ts"]).toBeUndefined();
    expect(store.getSnapshot().stale).toBe(true);
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("fills an unchanged failed-open destination after its explicit creation", async () => {
    const { store } = fixture();
    await store.open("new.ts");
    expect(await store.create("new.ts", "file", "new source")).toBe(true);
    expect(store.getSnapshot().files["new.ts"]).toMatchObject({
      text: "new source",
      document: { text: "new source", exists: true },
    });
  });
});

it("does not extend confirmed discard permission to edits made while waiting behind a save", async () => {
  const { api, store } = fixture();
  await store.open("a.ts");
  store.edit("a.ts", "saving");
  const savedDocument = deferred<OverviewFile>();
  api.saveOverviewFile.mockReturnValueOnce(savedDocument.promise);
  const saved = store.save("a.ts");
  await Promise.resolve();
  const refreshed = store.refreshFile("a.ts", true);
  store.edit("a.ts", "newer draft");
  savedDocument.resolve(document("a.ts", "saving", "a2"));
  await Promise.all([saved, refreshed]);
  expect(store.getSnapshot().files["a.ts"].text).toBe("newer draft");
});

it("refreshes more than 64 loaded folders without exhausting the bounded read transport", async () => {
  const { ReadCoordinator } = await import("../src/shared/read-deadlines");
  const { store, api } = fixture();
  const reads = new ReadCoordinator();
  api.listOverviewDirectory.mockImplementation((_scope, p) =>
    reads.run(
      "dir:" + p,
      1000,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return directory(p, ["updated.ts"]);
      },
      () => {},
    ),
  );
  for (let i = 0; i < 80; i++) await store.loadDirectory("folder-" + i);
  await store.refreshAll();
  expect(store.getSnapshot().directoryErrors).toEqual({});
  expect(store.getSnapshot().stale).toBe(false);
  expect(api.listOverviewDirectory).toHaveBeenCalledTimes(160);
});

it("removes only the known Electron read wrapper for schema/contract errors, retaining data and retry", async () => {
  const { api, store } = fixture();
  await store.open("a.ts");
  store.edit("a.ts", "draft");
  await store.refreshAll();
  api.readOverviewSchema.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:read-request': Error: Команда «goga schema» завершилась с кодом 1.",
    ),
  );
  await store.refreshAll();
  expect(store.getSnapshot().schemaError).toBe(
    "Команда «goga schema» завершилась с кодом 1.",
  );
  expect(store.getSnapshot().schema).toEqual(schema());
  expect(store.getSnapshot().files["a.ts"].text).toBe("draft");
  api.readOverviewContract.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:read-request': Error: Команда «goga contract -- src» завершилась с кодом 2.",
    ),
  );
  await store.showContract("src");
  expect(store.getSnapshot().contractError).toBe(
    "Команда «goga contract -- src» завершилась с кодом 2.",
  );
  await store.showContract("src");
  await store.refreshAll();
  expect(store.getSnapshot().schemaError).toBe("");
  expect(store.getSnapshot().contractError).toBe("");
  store.dispose();
});

describe("overview read lifecycle", () => {
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "feature/alpha",
    contextId: `ctx-${"a".repeat(64)}`,
    revision: "00000000-0000-4000-8000-000000000001",
  };

  it("automatically reloads a failed schema for a new active revision without Repeat", async () => {
    const { api } = fixture();
    const failure = "Команда «goga schema» завершилась с кодом 1.";
    api.readOverviewSchema.mockRejectedValueOnce(
      Error(
        `Error invoking remote method 'goga:read-request': Error: ${failure}`,
      ),
    );
    const view = render(
      <ProjectOverview scope={scope} api={api as unknown as DesktopAPI} />,
    );
    await screen.findByText(failure);
    expect(api.readOverviewSchema).toHaveBeenCalledTimes(1);
    const nextScope = {
      ...scope,
      revision: "00000000-0000-4000-8000-000000000002",
    };
    view.rerender(
      <ProjectOverview scope={nextScope} api={api as unknown as DesktopAPI} />,
    );
    await waitFor(() =>
      expect(api.readOverviewSchema).toHaveBeenLastCalledWith(nextScope),
    );
    await waitFor(() => expect(screen.queryByText(failure)).toBeNull());
    expect(api.readOverviewSchema).toHaveBeenCalledTimes(2);
    expect(api.listOverviewDirectory).toHaveBeenLastCalledWith(nextScope, "");
  });

  it("starts a fresh refresh on A to B to A before a cancelled refresh settles", async () => {
    const { api } = fixture();
    const pending = deferred<SchemaCell[]>();
    api.readOverviewSchema.mockReturnValueOnce(pending.promise);
    const overview = (
      <ProjectOverview scope={scope} api={api as unknown as DesktopAPI} />
    );
    const view = render(
      <RetainedViews activeKey="a">{overview}</RetainedViews>,
    );
    expect(api.readOverviewSchema).toHaveBeenCalledTimes(1);
    // Consecutive synchronous commits leave the abort catch/finally pending.
    view.rerender(
      <RetainedViews activeKey="b">
        <div>Topic B</div>
      </RetainedViews>,
    );
    view.rerender(<RetainedViews activeKey="a">{overview}</RetainedViews>);
    await waitFor(() =>
      expect(api.readOverviewSchema).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Чтение отменено/)).toBeNull(),
    );
    pending.reject(Error("obsolete schema failure"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("obsolete schema failure")).toBeNull();
    expect(screen.queryByText(/Чтение отменено/)).toBeNull();
  });
});

it("invalidates suspended reads without letting old errors finish a new refresh or replace drafts", async () => {
  const { api } = fixture();
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "feature/alpha",
    contextId: `ctx-${"a".repeat(64)}`,
    revision: "00000000-0000-4000-8000-000000000001",
  };
  const store = createOverviewStore(api, scope);
  await store.loadDirectory("");
  await store.open("a.ts");
  await store.showContract("src");
  store.edit("a.ts", "draft");
  const memory = store.getSnapshot().files["a.ts"].memory;
  const oldSchema = deferred<SchemaCell[]>();
  const oldDirectory = deferred<OverviewDirectory>();
  const oldFile = deferred<OverviewFile>();
  const oldContract = deferred<CellContract>();
  api.readOverviewSchema.mockReturnValueOnce(oldSchema.promise);
  api.listOverviewDirectory.mockReturnValueOnce(oldDirectory.promise);
  api.readOverviewFile.mockReturnValueOnce(oldFile.promise);
  api.readOverviewContract.mockReturnValueOnce(oldContract.promise);
  const previous = store.refreshAll();
  await Promise.resolve();
  store.suspendReads();
  const nextSchema = deferred<SchemaCell[]>();
  api.readOverviewSchema.mockReturnValueOnce(nextSchema.promise);
  const next = store.refreshAll();
  expect(next).not.toBe(previous);
  oldSchema.reject(Error("old schema"));
  oldDirectory.reject(Error("old directory"));
  oldFile.reject(Error("old file"));
  oldContract.reject(Error("old contract"));
  await previous;
  expect(store.getSnapshot().refreshing).toBe(true);
  expect(store.getSnapshot().schemaError).toBe("");
  expect(store.getSnapshot().directoryErrors).toEqual({});
  expect(store.getSnapshot().contractError).toBe("");
  expect(store.getSnapshot().files["a.ts"].error).toBeFalsy();
  nextSchema.resolve(schema("current"));
  await next;
  expect(store.getSnapshot().schema).toEqual(schema("current"));
  expect(store.getSnapshot().refreshing).toBe(false);
  expect(store.getSnapshot().stale).toBe(false);
  expect(store.getSnapshot().files["a.ts"].text).toBe("draft");
  expect(store.getSnapshot().files["a.ts"].memory).toBe(memory);
});

it("does not cancel or invalidate a save when reads are suspended", async () => {
  const { api, store, onMutation } = fixture();
  await store.open("a.ts");
  store.edit("a.ts", "saved draft");
  const pending = deferred<OverviewFile>();
  api.saveOverviewFile.mockReturnValueOnce(pending.promise);
  const saved = store.save("a.ts");
  await Promise.resolve();
  store.suspendReads();
  expect(store.getSnapshot().files["a.ts"].busy).toBe(true);
  pending.resolve(document("a.ts", "saved draft", "a2"));
  expect(await saved).toBe(true);
  expect(store.getSnapshot().files["a.ts"]).toMatchObject({
    text: "saved draft",
    document: { text: "saved draft", version: "a2" },
    busy: false,
  });
  expect(onMutation).toHaveBeenCalledTimes(1);
});

it("keeps a queued save admitted when its cancelled read fails during suspension", async () => {
  const { api, store, onMutation } = fixture();
  await store.open("a.ts");
  store.edit("a.ts", "draft to save");
  const pending = deferred<OverviewFile>();
  api.readOverviewFile.mockReturnValueOnce(pending.promise);
  const read = store.refreshAll();
  await Promise.resolve();
  const saved = store.save("a.ts");
  store.suspendReads();
  pending.reject(Error("Чтение отменено. Черновик сохранён."));
  await read;
  expect(await saved).toBe(true);
  expect(api.saveOverviewFile).toHaveBeenCalledWith(
    "project",
    "a.ts",
    "draft to save",
    "a1",
  );
  expect(store.getSnapshot().files["a.ts"].error).toBeFalsy();
  expect(store.getSnapshot().files["a.ts"].document.text).toBe("draft to save");
  expect(onMutation).toHaveBeenCalledTimes(1);
  expect(api.readOverviewSchema).toHaveBeenCalledTimes(1);
});
