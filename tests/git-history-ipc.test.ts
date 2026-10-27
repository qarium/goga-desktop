import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { readSignal } from "../src/host/read-scope";
const electron = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({})),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: electron,
  contextBridge: { exposeInMainWorld: electron.expose },
}));
const event = {
  sender: { id: 1 },
  senderFrame: { url: "file:///app/index.html", parent: null },
};
function handlers(service: object) {
  const result = new Map<string, Function>();
  registerIPC(
    { handle: (name: string, fn: Function) => result.set(name, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  return result;
}
const page = { scope: "p", ref: "HEAD", offset: 0 };
const commit = {
  scope: "p",
  ref: "HEAD",
  tip: "a".repeat(40),
  commit: "a".repeat(40),
  parentIndex: 0,
};
const cases = [
  ["readGitHistoryRefs", "read-git-history-refs", "p"],
  ["readGitHistory", "read-git-history", page],
  ["readGitCommit", "read-git-commit", { ...commit, fileOffset: 0 }],
  ["readGitCommitDiff", "read-git-commit-diff", { ...commit, path: "a" }],
] as const;
it.each(cases)(
  "%s has a scoped, finite, cancellable read channel",
  async (method, channel, request) => {
    let signal: AbortSignal | undefined, finish!: () => void;
    const service = {
      [method]: vi.fn(() => {
        signal = readSignal();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    };
    const h = handlers(service);
    expect((IPC_SCOPES as Record<string, string>)[channel]).toBe(
      "topic-or-primary-admin",
    );
    expect((READ_BUDGETS as Record<string, number>)[method]).toBe(30000);
    const result = h.get("goga:read-request")!(event, "history-read", method, [
      request,
    ]);
    await Promise.resolve();
    expect(service[method]).toHaveBeenCalledWith(request);
    h.get("goga:cancel-read")!(event, "history-read");
    await expect(result).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    finish();
    expect(() =>
      h.get(`goga:${channel}`)!({ ...event, sender: { id: 2 } }, request),
    ).toThrow();
    expect(() =>
      h.get(`goga:${channel}`)!(
        { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
        request,
      ),
    ).toThrow();
  },
);
it("rejects arbitrary paths, revisions, executables and roots before host calls", () => {
  const service = Object.fromEntries(
    cases.map(([method]) => [method, vi.fn()]),
  );
  const h = handlers(service);
  for (const [, channel] of cases) expect(h.has(`goga:${channel}`)).toBe(true);
  for (const patch of [
    { root: "/tmp" },
    { ref: "--all" },
    { ref: "main~1" },
    { argv: ["checkout", "main"] },
    { scope: { projectId: "p", path: "/tmp" } },
  ])
    expect(() =>
      h.get("goga:read-git-history")!(event, { ...page, ...patch }),
    ).toThrow();
  expect(() =>
    h.get("goga:read-git-commit-diff")!(event, {
      ...commit,
      path: "../secret",
    }),
  ).toThrow();
  expect(() =>
    h.get("goga:read-git-commit")!(event, {
      ...commit,
      commit: "HEAD^",
      fileOffset: 0,
    }),
  ).toThrow();
  for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
});
it("exposes read-only history calls without invoking commands while loading preload", async () => {
  await import("../src/main/preload");
  expect(electron.invoke).not.toHaveBeenCalled();
  const api = electron.expose.mock.calls[0][1];
  for (const [method, channel, request] of cases) {
    await api[method](request);
    expect(electron.invoke).toHaveBeenLastCalledWith(
      `goga:${channel}`,
      request,
    );
  }
});
