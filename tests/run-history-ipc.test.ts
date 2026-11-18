import { afterEach, expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { IPC_SCOPES } from "../src/shared/operation-scopes";

const shellURL = "file:///app/index.html";
const event = {
  sender: { id: 1 },
  senderFrame: { url: shellURL, parent: null },
};
const owner = {
  projectId: "project",
  year: "2026",
  topic: "alpha",
  branch: "feature/alpha",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "123e4567-e89b-42d3-a456-426614174000",
};
const request = {
  scope: "project",
  kind: "pipeline",
  runIds: ["finished-1", "finished-2"],
};
function fixture() {
  const handlers = new Map<string, Function>();
  const result = {
    removedRunIds: ["finished-1"],
    retained: [{ id: "finished-2", reason: "active" }],
  };
  const clearRunHistory = vi.fn(async () => result);
  registerIPC(
    {
      handle: (channel: string, handler: Function) =>
        handlers.set(channel, handler),
    } as any,
    {
      service: { clearRunHistory },
      window: { webContents: { id: 1 } },
      shellURL,
    } as any,
  );
  return {
    handler: handlers.get("goga:clear-run-history")!,
    clearRunHistory,
    result,
  };
}

afterEach(() => {
  vi.doUnmock("electron");
  vi.resetModules();
});

it("registers a context-scoped history mutation and forwards only the confirmed IDs", async () => {
  const f = fixture();
  expect(IPC_SCOPES["clear-run-history"]).toBe("topic-or-primary-admin");
  expect(typeof f.handler).toBe("function");
  await expect(f.handler(event, request)).resolves.toEqual(f.result);
  expect(f.clearRunHistory).toHaveBeenLastCalledWith(request);
  const topicBuild = { ...request, scope: owner, kind: "build" };
  await expect(f.handler(event, topicBuild)).resolves.toEqual(f.result);
  expect(f.clearRunHistory).toHaveBeenLastCalledWith(topicBuild);
  expect(f.clearRunHistory).toHaveBeenCalledTimes(2);
});

it("refuses foreign windows, foreign documents and embedded frames before invoking the host", () => {
  const f = fixture();
  for (const hostile of [
    { ...event, sender: { id: 2 } },
    { ...event, senderFrame: { url: "http://127.0.0.1:5432", parent: null } },
    { ...event, senderFrame: { url: shellURL, parent: {} } },
    { ...event, senderFrame: null },
  ])
    expect(() => f.handler(hostile, request)).toThrow(/IPC/);
  expect(f.clearRunHistory).not.toHaveBeenCalled();
});

it("rejects malformed scopes, extra capabilities and unbounded or duplicated run IDs", () => {
  const f = fixture();
  for (const bad of [
    null,
    {},
    { ...request, scope: null },
    { ...request, scope: "" },
    { ...request, scope: { ...owner, contextId: "other" } },
    { ...request, scope: { ...owner, projectId: undefined } },
    { ...request, scope: { ...owner, path: "/another-project" } },
    { ...request, kind: "all" },
    { ...request, force: true },
    { ...request, paths: ["/another-project"] },
    { ...request, runIds: [] },
    { ...request, runIds: ["same", "same"] },
    { ...request, runIds: [""] },
    { ...request, runIds: ["bad\nidentifier"] },
    { ...request, runIds: ["x".repeat(257)] },
    { ...request, runIds: [42] },
    { ...request, runIds: ["finished-1"], status: "running" },
  ])
    expect(() => f.handler(event, bad)).toThrow();
  expect(f.clearRunHistory).not.toHaveBeenCalled();
});

it("preload exposes only the dedicated request-forwarding API", async () => {
  const result = { removedRunIds: ["finished-1"], retained: [] };
  const invoke = vi.fn(async () => result);
  let bridge: any;
  vi.doMock("electron", () => ({
    contextBridge: {
      exposeInMainWorld: (_name: string, value: unknown) => {
        bridge = value;
      },
    },
    ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  }));
  await import("../src/main/preload");
  expect(typeof bridge.clearRunHistory).toBe("function");
  await expect(bridge.clearRunHistory(request)).resolves.toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(
    "goga:clear-run-history",
    request,
  );
});
