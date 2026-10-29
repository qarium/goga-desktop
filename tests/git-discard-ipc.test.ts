import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
const trusted = {
  sender: { id: 1 },
  senderFrame: { url: "file:///app/index.html", parent: null },
};
it("authorizes exact scoped previews and token-only writes, never write via read route", async () => {
  const service = {
    prepareGitDiscard: vi.fn(async (x) => x),
    executeGitDiscard: vi.fn(async (x) => x),
  };
  const handlers = new Map<string, Function>();
  registerIPC(
    { handle: (name: string, fn: Function) => handlers.set(name, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: trusted.senderFrame.url,
    } as any,
  );
  const request = { scope: "p", revision: "a".repeat(64), paths: ["f"] },
    token = "b".repeat(64);
  expect(IPC_SCOPES["prepare-git-discard"]).toBe("topic-or-primary-admin");
  expect(IPC_SCOPES["execute-git-discard"]).toBe("owner-ticket");
  expect(READ_BUDGETS.prepareGitDiscard).toBe(30000);
  expect(
    await handlers.get("goga:read-request")!(
      trusted,
      "discard-preview",
      "prepareGitDiscard",
      [request],
    ),
  ).toEqual(request);
  expect(await handlers.get("goga:execute-git-discard")!(trusted, token)).toBe(
    token,
  );
  for (const event of [
    { ...trusted, sender: { id: 2 } },
    { ...trusted, senderFrame: { ...trusted.senderFrame, parent: {} } },
  ]) {
    expect(() =>
      handlers.get("goga:prepare-git-discard")!(event, request),
    ).toThrow();
    expect(() =>
      handlers.get("goga:execute-git-discard")!(event, token),
    ).toThrow();
  }
  expect(() =>
    handlers.get("goga:prepare-git-discard")!(trusted, {
      ...request,
      root: "/other",
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:execute-git-discard")!(trusted, {
      token,
      paths: ["other"],
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:read-request")!(trusted, "bad", "executeGitDiscard", [
      token,
    ]),
  ).toThrow();
  expect(service.executeGitDiscard).toHaveBeenCalledTimes(1);
});

it("routes recovery inspection and preview as scoped reads and acknowledgement as a token-only write", async () => {
  const service = {
    inspectGitDiscardRecovery: vi.fn(async (scope) => ({ scope })),
    prepareGitDiscardRecovery: vi.fn(async (request) => request),
    executeGitDiscardRecovery: vi.fn(async (token) => token),
  };
  const handlers = new Map<string, Function>();
  registerIPC(
    { handle: (name: string, fn: Function) => handlers.set(name, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: trusted.senderFrame.url,
    } as any,
  );
  expect(handlers.get("goga:inspect-git-discard-recovery")).toBeTypeOf(
    "function",
  );
  const request = { scope: "p", revision: "a".repeat(64) };
  expect(
    await handlers.get("goga:read-request")!(
      trusted,
      "inspect-recovery",
      "inspectGitDiscardRecovery",
      ["p"],
    ),
  ).toEqual({ scope: "p" });
  expect(
    await handlers.get("goga:read-request")!(
      trusted,
      "preview-recovery",
      "prepareGitDiscardRecovery",
      [request],
    ),
  ).toEqual(request);
  const token = "c".repeat(64);
  expect(
    await handlers.get("goga:execute-git-discard-recovery")!(trusted, token),
  ).toBe(token);
  expect(() =>
    handlers.get("goga:read-request")!(
      trusted,
      "bad-recovery",
      "executeGitDiscardRecovery",
      [token],
    ),
  ).toThrow();
  expect(() =>
    handlers.get("goga:prepare-git-discard-recovery")!(trusted, {
      ...request,
      force: true,
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:execute-git-discard-recovery")!(
      { ...trusted, sender: { id: 2 } },
      token,
    ),
  ).toThrow();
  expect((IPC_SCOPES as any)["execute-git-discard-recovery"]).toBe(
    "owner-ticket",
  );
});
