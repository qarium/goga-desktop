import { afterEach, expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { readSignal } from "../src/host/read-scope";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
const operations = [
  ["listProjectSpecifications", "list-project-specifications", ["p"]],
  ["readProjectSpecification", "read-project-specification", ["p", "a.md"]],
] as const;
const event = {
  sender: { id: 1 },
  senderFrame: { url: "file:///app/index.html", parent: null },
};
function setup(service: object) {
  const handlers = new Map<string, Function>();
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  return handlers;
}
it.each(operations)(
  "routes %s through secure cancellable 30s read transport",
  async (method, channel, args) => {
    let signal: AbortSignal | undefined, finish!: (value: unknown) => void;
    const service = {
      [method]: vi.fn(() => {
        signal = readSignal();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }),
    };
    const handlers = setup(service);
    expect(IPC_SCOPES[channel]).toBe("topic-or-primary-admin");
    expect(READ_BUDGETS[method]).toBe(30000);
    const pending = handlers.get("goga:read-request")!(
      event,
      "read",
      method,
      args,
    );
    await Promise.resolve();
    expect(service[method]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(signal?.aborted).toBe(false);
    handlers.get("goga:cancel-read")!(event, "read");
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    finish({});
    await Promise.resolve();
    expect(() =>
      handlers.get(`goga:${channel}`)!(
        { ...event, sender: { id: 9 } },
        ...args,
      ),
    ).toThrow();
    expect(() =>
      handlers.get(`goga:${channel}`)!(
        { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
        ...args,
      ),
    ).toThrow();
  },
);
it("validates every specification argument before host dispatch", async () => {
  const service = Object.fromEntries(
    operations.map(([method]) => [method, vi.fn()]),
  );
  const handlers = setup(service);
  for (const [channel, args] of [
    ["list-project-specifications", [{}]],
    ["read-project-specification", ["p", "../secret.md"]],
    ["read-project-specification", ["p", "/tmp/x.md"]],
    ["read-project-specification", ["p", "x.yml"]],
    [
      "read-project-specification",
      [{ projectId: "p", contextId: "fake" }, "a.md"],
    ],
  ] as const)
    expect(() => handlers.get(`goga:${channel}`)!(event, ...args)).toThrow();
  for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
});
it("exposes scoped specification methods through preload", async () => {
  vi.resetModules();
  const invoke = vi.fn(async () => []),
    expose = vi.fn();
  vi.doMock("electron", () => ({
    contextBridge: { exposeInMainWorld: expose },
    ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() },
  }));
  await import("../src/main/preload");
  const api = expose.mock.calls[0]![1];
  for (const [method, channel, args] of operations) {
    await api[method](...args);
    expect(invoke).toHaveBeenLastCalledWith(`goga:${channel}`, ...args);
  }
  vi.doUnmock("electron");
});
afterEach(() => vi.restoreAllMocks());

it("forwards a complete host-issued owner unchanged", async () => {
  const owner = {
    projectId: "p",
    year: "2026",
    topic: "feature",
    branch: "feature/test",
    contextId: "ctx-" + "a".repeat(64),
    revision: "12345678-1234-4234-8234-123456789012",
  };
  const service = { readProjectSpecification: vi.fn(async () => ({})) };
  await setup(service).get("goga:read-project-specification")!(
    event,
    owner,
    "a.md",
  );
  expect(service.readProjectSpecification).toHaveBeenCalledExactlyOnceWith(
    owner,
    "a.md",
  );
});
