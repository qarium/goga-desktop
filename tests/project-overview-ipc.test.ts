import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
it("classifies and validates overview access for the exact shell and relative files", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    readOverviewFile: vi.fn(async () => ({})),
    saveOverviewFile: vi.fn(async () => ({})),
    listOverviewDirectory: vi.fn(async () => ({})),
  };
  registerIPC(
    { handle: (k: string, f: Function) => handlers.set(k, f) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const read = handlers.get("goga:read-overview-file");
  expect(read).toBeTypeOf("function");
  for (const path of ["../x", "/etc/passwd", ".git/config", "src/../x", ""])
    expect(() => read!(event, "p", path)).toThrow();
  expect(() =>
    read!({ ...event, sender: { id: 2 } }, "p", "main.go"),
  ).toThrow();
  await read!(event, "p", "src/main.go");
  expect(service.readOverviewFile).toHaveBeenCalledWith("p", "src/main.go");
  const save = handlers.get("goga:save-overview-file")!;
  expect(() => save(event, "p", "main.go", "hi", "not-version")).toThrow();
  await save(event, "p", "main.go", "\ufeffpackage main\r\n", "a".repeat(64));
  expect(service.saveOverviewFile).toHaveBeenCalledWith(
    "p",
    "main.go",
    "\ufeffpackage main\r\n",
    "a".repeat(64),
  );
});

it("validates file action ownership, tokens and requests before reaching Host", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    prepareOverviewFileAction: vi.fn(async () => ({})),
    executeOverviewFileAction: vi.fn(async () => ({})),
    revealOverviewEntry: vi.fn(async () => {}),
  };
  registerIPC(
    { handle: (k: string, f: Function) => handlers.set(k, f) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const prepare = handlers.get("goga:prepare-overview-file-action")!;
  const execute = handlers.get("goga:execute-overview-file-action")!;
  const reveal = handlers.get("goga:reveal-overview-entry")!;
  for (const request of [
    { kind: "trash", paths: [] },
    { kind: "trash", paths: Array(129).fill("a") },
    { kind: "trash", paths: ["../a"] },
    { kind: "trash", paths: ["a"], root: "/outside" },
    { kind: "rename", path: "a", destination: ".git/config" },
    { kind: "rename", path: "a", destination: "b", paths: ["a"] },
  ])
    expect(() => prepare(event, "p", request)).toThrow();
  expect(() => execute(event, "not-token")).toThrow();
  expect(() => reveal(event, "p", "../a")).toThrow();
  for (const bad of [
    { ...event, sender: { id: 2 } },
    { ...event, senderFrame: { url: "https://other.test", parent: null } },
    { ...event, senderFrame: { url: "file:///app/index.html", parent: {} } },
  ])
    for (const [handler, args] of [
      [prepare, ["p", { kind: "trash", paths: ["a"] }]],
      [execute, ["12345678-1234-4234-8234-123456789012"]],
      [reveal, ["p", "a"]],
    ] as const)
      expect(() => handler(bad, ...args)).toThrow();
  expect(service.prepareOverviewFileAction).not.toHaveBeenCalled();
  expect(service.executeOverviewFileAction).not.toHaveBeenCalled();
  expect(service.revealOverviewEntry).not.toHaveBeenCalled();
  const request = { kind: "trash", paths: ["a", "folder/b"] };
  await prepare(event, "p", request);
  expect(service.prepareOverviewFileAction).toHaveBeenCalledWith("p", request);
  await execute(event, "12345678-1234-4234-8234-123456789012");
  expect(service.executeOverviewFileAction).toHaveBeenCalledWith(
    "12345678-1234-4234-8234-123456789012",
  );
  await reveal(event, "p", "folder/b");
  expect(service.revealOverviewEntry).toHaveBeenCalledWith("p", "folder/b");
});

it("exposes native file copy/paste only to the shell with relative targets, never through read-request", async () => {
  const handlers = new Map<string, Function>();
  const service = { copyOverviewEntries: vi.fn(async () => {}), pasteOverviewEntries: vi.fn(async () => ({ status: "done" })) };
  registerIPC({ handle: (key: string, fn: Function) => handlers.set(key, fn) } as any, { service, window: { webContents: { id: 1 } }, shellURL: "file:///app/index.html" } as any);
  const event = { sender: { id: 1 }, senderFrame: { url: "file:///app/index.html", parent: null } };
  const copy = handlers.get("goga:copy-overview-entries"), paste = handlers.get("goga:paste-overview-entries");
  expect(copy).toBeTypeOf("function"); expect(paste).toBeTypeOf("function");
  for (const paths of [[], ["../a"], ["/etc/passwd"], [".git/config"], Array(129).fill("a")]) expect(() => copy!(event, "p", paths)).toThrow();
  for (const destination of ["../a", "/etc", ".git"]) expect(() => paste!(event, "p", destination)).toThrow();
  for (const bad of [{ ...event, sender: { id: 2 } }, { ...event, senderFrame: { url: "https://panel.test", parent: null } }, { ...event, senderFrame: { url: "file:///app/index.html", parent: {} } }]) {
    expect(() => copy!(bad, "p", ["a"])).toThrow(); expect(() => paste!(bad, "p", "")).toThrow();
  }
  expect(service.copyOverviewEntries).not.toHaveBeenCalled(); expect(service.pasteOverviewEntries).not.toHaveBeenCalled();
  await copy!(event, "p", ["src/a"]); await paste!(event, "p", "target");
  expect(service.copyOverviewEntries).toHaveBeenCalledExactlyOnceWith("p", ["src/a"]);
  expect(service.pasteOverviewEntries).toHaveBeenCalledExactlyOnceWith("p", "target");
  const read = handlers.get("goga:read-request")!;
  for (const method of ["copyOverviewEntries", "pasteOverviewEntries"]) expect(() => read(event, "12345678-1234-4234-8234-123456789012", method, ["p", ""])).toThrow();
});

it("validates text copy and one-shot paste decisions only for shell, never read-request", async () => {
  expect(IPC_SCOPES["execute-overview-paste"]).toBe("owner-ticket");
  const handlers = new Map<string, Function>();
  const service = {
    copyOverviewPaths: vi.fn(async () => {}),
    prepareOverviewPaste: vi.fn(async () => ({})),
    executeOverviewPaste: vi.fn(async () => ({})),
  };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const copy = handlers.get("goga:copy-overview-paths"),
    prepare = handlers.get("goga:prepare-overview-paste"),
    execute = handlers.get("goga:execute-overview-paste");
  expect(copy).toBeTypeOf("function");
  expect(prepare).toBeTypeOf("function");
  expect(execute).toBeTypeOf("function");
  const token = "12345678-1234-4234-8234-123456789012";
  for (const args of [
    ["p", ["../a"], true],
    ["p", ["a"], "true"],
    ["p", ["/etc/passwd"], false],
  ])
    expect(() => copy!(event, ...args)).toThrow();
  for (const destination of ["../a", "/etc", ".git"])
    expect(() => prepare!(event, "p", destination)).toThrow();
  for (const [t, decisions] of [
    ["bad", []],
    [token, [{ path: "../a", action: "replace" }]],
    [token, [{ path: "a", action: "force" }]],
    [token, [{ path: "a", action: "replace", source: "/etc/passwd" }]],
    [token, Array(10001).fill({ path: "a", action: "skip" })],
  ])
    expect(() => execute!(event, t, decisions)).toThrow();
  for (const bad of [
    { ...event, sender: { id: 2 } },
    { ...event, senderFrame: { url: "https://panel.test", parent: null } },
    { ...event, senderFrame: { url: "file:///app/index.html", parent: {} } },
  ]) {
    expect(() => copy!(bad, "p", ["a"], true)).toThrow();
    expect(() => prepare!(bad, "p", "")).toThrow();
    expect(() => execute!(bad, token, [])).toThrow();
  }
  expect(service.copyOverviewPaths).not.toHaveBeenCalled();
  expect(service.prepareOverviewPaste).not.toHaveBeenCalled();
  expect(service.executeOverviewPaste).not.toHaveBeenCalled();
  await copy!(event, "p", ["a"], false);
  await prepare!(event, "p", "target");
  await execute!(event, token, [{ path: "target/a", action: "skip" }]);
  expect(service.copyOverviewPaths).toHaveBeenCalledExactlyOnceWith(
    "p",
    ["a"],
    false,
  );
  expect(service.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith(
    "p",
    "target",
  );
  expect(service.executeOverviewPaste).toHaveBeenCalledExactlyOnceWith(token, [
    { path: "target/a", action: "skip" },
  ]);
  const read = handlers.get("goga:read-request")!;
  for (const method of [
    "copyOverviewPaths",
    "prepareOverviewPaste",
    "executeOverviewPaste",
  ])
    expect(() => read(event, token, method, ["p", ""])).toThrow();
});

const preloadElectron = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({})),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: preloadElectron,
  contextBridge: { exposeInMainWorld: preloadElectron.expose },
}));
it("bridges file text paths and prepared paste through actual preload with exact arguments", async () => {
  await import("../src/main/preload");
  expect(preloadElectron.invoke).not.toHaveBeenCalled();
  const api = preloadElectron.expose.mock.calls[0][1];
  await api.copyOverviewPaths("p", ["src/a", "src/b"], true);
  expect(preloadElectron.invoke).toHaveBeenLastCalledWith(
    "goga:copy-overview-paths",
    "p",
    ["src/a", "src/b"],
    true,
  );
  await api.prepareOverviewPaste("p", "target");
  expect(preloadElectron.invoke).toHaveBeenLastCalledWith(
    "goga:prepare-overview-paste",
    "p",
    "target",
  );
  const decisions = [{ path: "target/a", action: "skip" }];
  await api.executeOverviewPaste("token", decisions);
  expect(preloadElectron.invoke).toHaveBeenLastCalledWith(
    "goga:execute-overview-paste",
    "token",
    decisions,
  );
});
