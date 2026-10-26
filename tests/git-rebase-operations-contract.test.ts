import { describe, expect, it, vi } from "vitest";
import {
  gitRebaseOperationRequestSchema,
  gitRebaseOperationTokenSchema,
} from "../src/shared/git-rebase-operations";
import { registerIPC } from "../src/main/ipc";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
import { readSignal } from "../src/host/read-scope";
const request = { scope: "p", action: "abort", revision: "a".repeat(64) };
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
describe("operation-specific rebase contract", () => {
  it("allows separate abort/continue actions and rejects injected write authority", () => {
    expect(gitRebaseOperationRequestSchema.parse(request)).toEqual(request);
    expect(
      gitRebaseOperationRequestSchema.parse({ ...request, action: "continue" })
        .action,
    ).toBe("continue");
    for (const extra of [
      { action: "skip" },
      { backend: "merge" },
      { root: "/tmp" },
      { force: true },
      { message: "x" },
      { operationBinding: "x" },
    ])
      expect(
        gitRebaseOperationRequestSchema.safeParse({ ...request, ...extra })
          .success,
      ).toBe(false);
    expect(
      gitRebaseOperationTokenSchema.safeParse({ token: "b".repeat(64) })
        .success,
    ).toBe(false);
  });
  it("registers strict scoped preview, token-only execute and rejects writes disguised as reads", async () => {
    const service = {
      prepareGitRebaseOperation: vi.fn(async () => ({ token: "b".repeat(64) })),
      executeGitRebaseOperation: vi.fn(async () => ({ status: "success" })),
    };
    const h = setup(service);
    expect(h.has("goga:prepare-git-rebase-operation")).toBe(true);
    expect(IPC_SCOPES["prepare-git-rebase-operation"]).toBe(
      "topic-or-primary-admin",
    );
    expect(IPC_SCOPES["execute-git-rebase-operation"]).toBe("owner-ticket");
    await h.get("goga:prepare-git-rebase-operation")!(event, request);
    expect(service.prepareGitRebaseOperation).toHaveBeenCalledWith(request);
    for (const extra of [{ root: "/tmp" }, { args: ["--continue"] }])
      expect(() =>
        h.get("goga:prepare-git-rebase-operation")!(event, {
          ...request,
          ...extra,
        }),
      ).toThrow();
    expect(() =>
      h.get("goga:prepare-git-rebase-operation")!(
        { ...event, sender: { id: 2 } },
        request,
      ),
    ).toThrow();
    const token = "b".repeat(64);
    await h.get("goga:execute-git-rebase-operation")!(event, token);
    expect(service.executeGitRebaseOperation).toHaveBeenCalledExactlyOnceWith(
      token,
    );
    expect(() =>
      h.get("goga:execute-git-rebase-operation")!(event, { token, scope: "p" }),
    ).toThrow();
    expect(() =>
      h.get("goga:read-request")!(event, "write", "executeGitRebaseOperation", [
        token,
      ]),
    ).toThrow();
  });
  it("makes preview finite and cancellable without detaching the physical operation", async () => {
    expect((READ_BUDGETS as any).prepareGitRebaseOperation).toBe(30000);
    let signal: AbortSignal | undefined, finish!: () => void;
    const prepareGitRebaseOperation = vi.fn(() => {
      signal = readSignal();
      return new Promise<void>((r) => (finish = r));
    });
    const h = setup({ prepareGitRebaseOperation });
    const pending = h.get("goga:read-request")!(
      event,
      "rebase-op",
      "prepareGitRebaseOperation",
      [request],
    );
    await Promise.resolve();
    h.get("goga:cancel-read")!(event, "rebase-op");
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    finish();
  });
});
