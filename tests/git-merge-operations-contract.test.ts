import { describe, expect, it, vi } from "vitest";
import {
  gitMergeOperationRequestSchema,
  gitMergeOperationTokenSchema,
} from "../src/shared/git-operations";
import { registerIPC } from "../src/main/ipc";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
import { readSignal } from "../src/host/read-scope";
const request = { scope: "p", action: "continue", revision: "a".repeat(64) };
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
describe("merge-only operation contract", () => {
  it("accepts optional bounded explicit message for continue only and exact scope", () => {
    expect(
      gitMergeOperationRequestSchema.parse({
        ...request,
        message: "My merge\n",
      }),
    ).toMatchObject({ message: "My merge\n" });
    expect(gitMergeOperationRequestSchema.parse(request)).toEqual(request);
    for (const input of [
      { ...request, action: "rebase" },
      { ...request, operation: "rebase" },
      { ...request, root: "/tmp" },
      { ...request, force: true },
      { ...request, message: " " },
      { ...request, message: "\0" },
      { ...request, message: "x".repeat(16385) },
      { ...request, action: "abort", message: "ignored?" },
      { ...request, scope: { projectId: "p" } },
    ])
      expect(gitMergeOperationRequestSchema.safeParse(input).success).toBe(
        false,
      );
    expect(
      gitMergeOperationTokenSchema.safeParse({ token: "b".repeat(64) }).success,
    ).toBe(false);
  });
  it("registers strict scoped preview, token-only execute and rejects writes disguised as reads", async () => {
    const service = {
      prepareGitMergeOperation: vi.fn(async () => ({ token: "b".repeat(64) })),
      executeGitMergeOperation: vi.fn(async () => ({ status: "success" })),
    };
    const h = setup(service);
    expect(h.has("goga:prepare-git-merge-operation")).toBe(true);
    expect(IPC_SCOPES["prepare-git-merge-operation"]).toBe(
      "topic-or-primary-admin",
    );
    expect(IPC_SCOPES["execute-git-merge-operation"]).toBe("owner-ticket");
    await h.get("goga:prepare-git-merge-operation")!(event, request);
    expect(service.prepareGitMergeOperation).toHaveBeenCalledWith(request);
    for (const extra of [{ root: "/tmp" }, { args: ["--continue"] }])
      expect(() =>
        h.get("goga:prepare-git-merge-operation")!(event, {
          ...request,
          ...extra,
        }),
      ).toThrow();
    expect(() =>
      h.get("goga:prepare-git-merge-operation")!(
        { ...event, sender: { id: 2 } },
        request,
      ),
    ).toThrow();
    const token = "b".repeat(64);
    await h.get("goga:execute-git-merge-operation")!(event, token);
    expect(service.executeGitMergeOperation).toHaveBeenCalledExactlyOnceWith(
      token,
    );
    expect(() =>
      h.get("goga:execute-git-merge-operation")!(event, { token, scope: "p" }),
    ).toThrow();
    expect(() =>
      h.get("goga:read-request")!(event, "write", "executeGitMergeOperation", [
        token,
      ]),
    ).toThrow();
  });
  it("makes preview finite and cancellable without detaching the physical operation", async () => {
    expect((READ_BUDGETS as any).prepareGitMergeOperation).toBe(30000);
    let signal: AbortSignal | undefined, finish!: () => void;
    const prepareGitMergeOperation = vi.fn(() => {
      signal = readSignal();
      return new Promise<void>((r) => (finish = r));
    });
    const h = setup({ prepareGitMergeOperation });
    const pending = h.get("goga:read-request")!(
      event,
      "merge-op",
      "prepareGitMergeOperation",
      [request],
    );
    await Promise.resolve();
    h.get("goga:cancel-read")!(event, "merge-op");
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    finish();
  });
});
