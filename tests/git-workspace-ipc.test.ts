import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
import { readSignal } from "../src/host/read-scope";
const event = {
  sender: { id: 1 },
  senderFrame: { url: "file:///app/index.html", parent: null },
};
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
  ["readGitWorkspace", "read-git-workspace", ["p"]],
  ["readGitSummary", "read-git-summary", ["p"]],
  [
    "prepareGitUpdateHandoff",
    "prepare-git-update-handoff",
    [{ scope: "p", revision: "a".repeat(64), candidateId: "b".repeat(64) }],
  ],
  [
    "prepareGitConflictSave",
    "prepare-git-conflict-save",
    [
      {
        scope: "p",
        path: "file.txt",
        revision: "a".repeat(64),
        fingerprint: "b".repeat(64),
        resolution: { kind: "text", text: "resolved" },
      },
    ],
  ],
  [
    "readGitConflict",
    "read-git-conflict",
    [{ scope: "p", path: "conflict.txt", revision: "a".repeat(64) }],
  ],
  [
    "readGitDiff",
    "read-git-diff",
    [{ scope: "p", path: "a file.txt", revision: "a".repeat(64) }],
  ],
] as const)(
  "%s is a scoped, cancellable finite read",
  async (method, channel, args) => {
    let signal: AbortSignal | undefined, finish!: () => void;
    const service = {
      [method]: vi.fn(() => {
        signal = readSignal();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    };
    const handlers = setup(service);
    expect(IPC_SCOPES[channel]).toBe("topic-or-primary-admin");
    expect((READ_BUDGETS as Record<string, number>)[method]).toBe(30000);
    const result = handlers.get("goga:read-request")!(
      event,
      "git-read",
      method,
      args,
    );
    await Promise.resolve();
    expect(service[method]).toHaveBeenCalledWith(...args);
    expect(signal?.aborted).toBe(false);
    handlers.get("goga:cancel-read")!(event, "git-read");
    await expect(result).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    finish();
    expect(() =>
      handlers.get(`goga:${channel}`)!(
        { ...event, sender: { id: 2 } },
        ...args,
      ),
    ).toThrow();
    expect(() =>
      handlers.get(`goga:${channel}`)!(
        {
          ...event,
          senderFrame: { url: "file:///app/index.html", parent: {} },
        },
        ...args,
      ),
    ).toThrow();
  },
);
it("rejects forged scope, paths, revisions and extra diff authority before host calls", () => {
  const service = { readGitWorkspace: vi.fn(), readGitDiff: vi.fn() };
  const h = setup(service);
  expect(h.has("goga:read-git-workspace")).toBe(true);
  for (const scope of [null, {}, { projectId: "p", path: "/tmp/fake" }])
    expect(() => h.get("goga:read-git-workspace")!(event, scope)).toThrow();
  const request = { scope: "p", path: "ok.txt", revision: "a".repeat(64) };
  for (const patch of [
    { path: "../secret" },
    { path: "/tmp/secret" },
    { path: ".git/config" },
    { revision: "" },
    { root: "/tmp" },
  ])
    expect(() =>
      h.get("goga:read-git-diff")!(event, { ...request, ...patch }),
    ).toThrow();
  expect(service.readGitWorkspace).not.toHaveBeenCalled();
  expect(service.readGitDiff).not.toHaveBeenCalled();
});
it("validates commit preview and only accepts an opaque execute ticket from the shell", async () => {
  const service = {
    prepareGitCommit: vi.fn(async () => ({ token: "test" })),
    executeGitCommit: vi.fn(async () => ({ status: "committed" })),
  };
  const h = setup(service);
  expect(h.has("goga:prepare-git-commit")).toBe(true);
  expect(h.has("goga:execute-git-commit")).toBe(true);
  expect(IPC_SCOPES["execute-git-commit"]).toBe("owner-ticket");
  const request = {
    scope: "p",
    revision: "a".repeat(64),
    paths: ["file.txt"],
    message: "selected",
  };
  await h.get("goga:prepare-git-commit")!(event, request);
  for (const patch of [
    { root: "/other" },
    { paths: [".git/config"] },
    { paths: [] },
    { message: "" },
    { paths: ["a", "a"] },
  ])
    expect(() =>
      h.get("goga:prepare-git-commit")!(event, { ...request, ...patch }),
    ).toThrow();
  const token = "1".repeat(64);
  expect(() =>
    h.get("goga:execute-git-commit")!(event, { token, root: "/other" }),
  ).toThrow();
  expect(() =>
    h.get("goga:execute-git-commit")!({ ...event, sender: { id: 2 } }, token),
  ).toThrow();
  await h.get("goga:execute-git-commit")!(event, token);
  expect(service.executeGitCommit).toHaveBeenCalledExactlyOnceWith(token);
  expect(() =>
    h.get("goga:read-request")!(event, "bad-write", "executeGitCommit", [
      token,
    ]),
  ).toThrow();
});

it("refuses conflict requests with renderer-supplied roots, objects, commands or bad owners", () => {
  const service = { readGitConflict: vi.fn() },
    h = setup(service);
  const request = { scope: "p", path: "file", revision: "a".repeat(64) };
  expect(h.has("goga:read-git-conflict")).toBe(true);
  for (const patch of [
    { path: "../outside" },
    { path: ".git/index" },
    { scope: {} },
    { revision: "HEAD" },
    { oid: "a".repeat(40) },
    { root: "/tmp" },
    { args: ["show", "HEAD"] },
  ])
    expect(() =>
      h.get("goga:read-git-conflict")!(event, { ...request, ...patch }),
    ).toThrow();
  expect(service.readGitConflict).not.toHaveBeenCalled();
});

it("validates single conflict preview and token-only save with no read-route write authority", async () => {
  const service = {
    prepareGitConflictSave: vi.fn(async () => ({ token: "test" })),
    executeGitConflictSave: vi.fn(async () => ({ status: "saved" })),
  };
  const h = setup(service);
  expect(h.has("goga:prepare-git-conflict-save")).toBe(true);
  expect(h.has("goga:execute-git-conflict-save")).toBe(true);
  expect(IPC_SCOPES["execute-git-conflict-save"]).toBe("owner-ticket");
  const request = {
    scope: "p",
    path: "file.txt",
    revision: "a".repeat(64),
    fingerprint: "b".repeat(64),
    resolution: { kind: "text", text: "resolved\r\n" },
  };
  for (const patch of [
    { root: "/other" },
    { path: ".git/index" },
    { fingerprint: "HEAD" },
    { resolution: { kind: "current", oid: "a".repeat(40) } },
    { env: { GIT_DIR: "/other" } },
  ])
    expect(() =>
      h.get("goga:prepare-git-conflict-save")!(event, { ...request, ...patch }),
    ).toThrow();
  expect(service.prepareGitConflictSave).not.toHaveBeenCalled();
  await h.get("goga:prepare-git-conflict-save")!(event, request);
  expect(service.prepareGitConflictSave).toHaveBeenCalledExactlyOnceWith(
    request,
  );
  const token = "1".repeat(64);
  expect(() =>
    h.get("goga:execute-git-conflict-save")!(event, { token, path: "other" }),
  ).toThrow();
  expect(() =>
    h.get("goga:execute-git-conflict-save")!(
      { ...event, sender: { id: 2 } },
      token,
    ),
  ).toThrow();
  expect(() =>
    h.get("goga:execute-git-conflict-save")!(
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
      token,
    ),
  ).toThrow();
  expect(() =>
    h.get("goga:read-request")!(event, "write", "executeGitConflictSave", [
      token,
    ]),
  ).toThrow();
  expect(service.executeGitConflictSave).not.toHaveBeenCalled();
  await h.get("goga:execute-git-conflict-save")!(event, token);
  expect(service.executeGitConflictSave).toHaveBeenCalledExactlyOnceWith(token);
});

it("update handoff execution is a strict owner ticket, not a read or a command", async () => {
  const service = { executeGitUpdateHandoff: vi.fn(async () => "result") };
  const handlers = setup(service);
  expect(IPC_SCOPES["execute-git-update-handoff"]).toBe("owner-ticket");
  const execute = handlers.get("goga:execute-git-update-handoff")!;
  expect(() =>
    execute(event, { token: "a".repeat(64), root: "/tmp" }),
  ).toThrow();
  expect(service.executeGitUpdateHandoff).not.toHaveBeenCalled();
  expect(await execute(event, "a".repeat(64))).toBe("result");
});
