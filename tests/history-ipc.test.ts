import { afterEach, expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { readSignal } from "../src/host/read-scope";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
const target = { topic: "topic", branch: "topic", remote: false };
const operations = [
  ["listHistoryYears", "list-history-years", ["p"]],
  ["listHistoryEntries", "list-history-entries", ["p", "2026"]],
  [
    "listHistoryArtifacts",
    "list-history-artifacts",
    ["p", "2026", "topic", target],
  ],
  [
    "readHistoryArtifact",
    "read-history-artifact",
    ["p", "2026", "topic", "report.md", target],
  ],
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
it("validates every history argument before host dispatch", async () => {
  const service = Object.fromEntries(
    operations.map(([method]) => [method, vi.fn()]),
  );
  const handlers = setup(service);
  for (const [channel, args] of [
    ["list-history-years", [{}]],
    ["list-history-entries", ["p", "../2026"]],
    ["list-history-artifacts", ["p", "2026", ".."]],
    [
      "list-history-artifacts",
      ["p", "2026", "topic", { ...target, extra: true }],
    ],
    ["read-history-artifact", ["p", "2026", "topic", "../../secrets"]],
    [
      "read-history-artifact",
      ["p", "2026", "topic", "a.md", { ...target, topic: "../other" }],
    ],
  ] as const)
    expect(() => handlers.get(`goga:${channel}`)!(event, ...args)).toThrow();
  for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
});
it("exposes scoped History methods through preload", async () => {
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
  expect(
    Object.keys(api)
      .filter((name) => name.toLowerCase().includes("history"))
      .sort(),
  ).toEqual(
    [
      ...operations.map(([method]) => method),
      "prepareHistoryPrune",
      "pruneHistory",
      "readGitHistory",
      "readGitHistoryRefs",
    ].sort(),
  );
  await api.prepareHistoryPrune("p", "2026");
  expect(invoke).toHaveBeenLastCalledWith(
    "goga:prepare-history-prune",
    "p",
    "2026",
  );
  await api.pruneHistory("p", "token");
  expect(invoke).toHaveBeenLastCalledWith("goga:prune-history", "p", "token");
  vi.doUnmock("electron");
});
afterEach(() => vi.restoreAllMocks());

it("prune IPC rejects topic scope, malformed year/token and foreign sender", async () => {
  const service = { prepareHistoryPrune: vi.fn(), pruneHistory: vi.fn() };
  const h = setup(service);
  const preview = h.get("goga:prepare-history-prune")!,
    apply = h.get("goga:prune-history")!;
  expect(() => preview(event, { projectId: "p" }, "2026")).toThrow();
  expect(() => preview(event, "p", "../2026")).toThrow();
  expect(() => apply(event, "p", "bad")).toThrow();
  expect(() => preview({ ...event, sender: { id: 2 } }, "p", "2026")).toThrow();
  expect(() =>
    apply(
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
      "p",
      "0461b33f-4e7c-4bd2-b101-111111111111",
    ),
  ).toThrow();
  expect(service.prepareHistoryPrune).not.toHaveBeenCalled();
  expect(service.pruneHistory).not.toHaveBeenCalled();
  await h.get("goga:read-request")!(event, "r", "prepareHistoryPrune", [
    "p",
    "2026",
  ]);
  expect(service.prepareHistoryPrune).toHaveBeenCalledExactlyOnceWith(
    "p",
    "2026",
  );
  await apply(event, "p", "0461b33f-4e7c-4bd2-b101-111111111111");
  expect(service.pruneHistory).toHaveBeenCalledExactlyOnceWith(
    "p",
    "0461b33f-4e7c-4bd2-b101-111111111111",
  );
});
