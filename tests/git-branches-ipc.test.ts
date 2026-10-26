import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
import { readSignal } from "../src/host/read-scope";
const event = {
  sender: { id: 1 },
  senderFrame: { url: "file:///app/index.html", parent: null },
};

it.each([
  { action: "merge", ref: "refs/heads/feature" },
  { action: "abort-merge" },
])(
  "validates $action as primary-only preview, with no arbitrary paths or force",
  async (action) => {
    const service = {
      prepareGitBranch: vi.fn(async () => ({ token: "a".repeat(64) })),
    };
    const handlers = setup(service);
    const request = { projectId: "p", revision: "b".repeat(64), ...action };
    await handlers.get("goga:prepare-git-branch")!(event, request);
    expect(service.prepareGitBranch).toHaveBeenCalledExactlyOnceWith(request);
    for (const patch of [
      { projectId: { projectId: "p", contextId: "clone" } },
      { root: "/arbitrary" },
      { force: true },
      { strategy: "ours" },
    ]) {
      expect(() =>
        handlers.get("goga:prepare-git-branch")!(event, {
          ...request,
          ...patch,
        }),
      ).toThrow();
    }
  },
);
function setup(service: object) {
  const handlers = new Map<string, Function>();
  registerIPC(
    { handle: (name: string, fn: Function) => handlers.set(name, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  return handlers;
}
it.each([
  ["readGitBranches", "read-git-branches", "p"],
  [
    "prepareGitBranch",
    "prepare-git-branch",
    { projectId: "p", revision: "a".repeat(64), action: "fetch" },
  ],
] as const)(
  "%s is finite, cancellable and primary-only",
  async (method, channel, arg) => {
    let signal: AbortSignal | undefined, finish!: () => void;
    const methodFn = vi.fn(() => {
      signal = readSignal();
      return new Promise<void>((r) => (finish = r));
    });
    const h = setup({ [method]: methodFn });
    expect(IPC_SCOPES[channel]).toBe("primary-admin");
    expect((READ_BUDGETS as any)[method]).toBe(30000);
    const result = h.get("goga:read-request")!(event, "branches", method, [
      arg,
    ]);
    await Promise.resolve();
    expect(methodFn).toHaveBeenCalledWith(arg);
    h.get("goga:cancel-read")!(event, "branches");
    await expect(result).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    finish();
    expect(() =>
      h.get(`goga:${channel}`)!({ ...event, sender: { id: 2 } }, arg),
    ).toThrow();
  },
);
it("rejects clone scopes, extra paths and write requests masquerading as reads", async () => {
  const service = {
    readGitBranches: vi.fn(),
    prepareGitBranch: vi.fn(),
    executeGitBranch: vi.fn(async () => ({ status: "success" })),
  };
  const h = setup(service);
  expect(h.has("goga:read-git-branches")).toBe(true);
  for (const input of [
    null,
    {},
    { projectId: "p", contextId: "clone", path: "/tmp" },
  ])
    expect(() => h.get("goga:read-git-branches")!(event, input)).toThrow();
  const request = { projectId: "p", revision: "a".repeat(64), action: "fetch" };
  for (const patch of [
    { projectId: { projectId: "p" } },
    { root: "/tmp" },
    { force: true },
  ])
    expect(() =>
      h.get("goga:prepare-git-branch")!(event, { ...request, ...patch }),
    ).toThrow();
  const token = "b".repeat(64);
  expect(IPC_SCOPES["execute-git-branch"]).toBe("owner-ticket");
  expect(() =>
    h.get("goga:execute-git-branch")!(event, { token, projectId: "p" }),
  ).toThrow();
  expect(() =>
    h.get("goga:read-request")!(event, "write", "executeGitBranch", [token]),
  ).toThrow();
  await h.get("goga:execute-git-branch")!(event, token);
  expect(service.executeGitBranch).toHaveBeenCalledExactlyOnceWith(token);
  expect(service.readGitBranches).not.toHaveBeenCalled();
});
