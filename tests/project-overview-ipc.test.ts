import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
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
