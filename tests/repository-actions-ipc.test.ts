import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
it("routes validated repository actions only from the shell without paths or commands", async () => {
  const handlers = new Map<string, Function>();
  const runRepositoryAction = vi.fn(async (v) => v);
  registerIPC(
    { handle: (n: string, f: Function) => handlers.set(n, f) } as any,
    {
      service: { runRepositoryAction },
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const handler = handlers.get("goga:run-repository-action");
  expect(handler).toBeTypeOf("function");
  expect(IPC_SCOPES["run-repository-action"]).toBe("topic-or-primary-admin");
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const request = { projectId: "p", action: "publish" };
  expect(await handler!(event, request)).toEqual(request);
  for (const extra of [
    { path: "/untrusted" },
    { args: ["reset"] },
    { action: "reset" },
    { context: { projectId: "other" } },
  ])
    expect(() => handler!(event, { ...request, ...extra })).toThrow();
  expect(() => handler!({ ...event, sender: { id: 2 } }, request)).toThrow();
  expect(runRepositoryAction).toHaveBeenCalledTimes(1);
});

it.each(["propagate", "update-remote"])(
  "admits only shell-owned topic action %s and rejects arbitrary execution inputs",
  async (action) => {
    const handlers = new Map<string, Function>();
    const runRepositoryAction = vi.fn(async (v) => v);
    registerIPC(
      { handle: (n: string, f: Function) => handlers.set(n, f) } as any,
      {
        service: { runRepositoryAction },
        window: { webContents: { id: 1 } },
        shellURL: "file:///app/index.html",
      } as any,
    );
    const handler = handlers.get("goga:run-repository-action")!;
    const event = {
      sender: { id: 1 },
      senderFrame: { url: "file:///app/index.html", parent: null },
    };
    const context = {
      projectId: "p",
      year: "2026",
      topic: "display-name",
      branch: "alpha",
      contextId: `ctx-${"a".repeat(64)}`,
      revision: "00000000-0000-4000-8000-000000000001",
    };
    const request = { projectId: "p", action, context };
    expect(IPC_SCOPES["run-repository-action"]).toBe("topic-or-primary-admin");
    expect(await handler(event, request)).toEqual(request);
    for (const extra of [
      { cwd: "/untrusted" },
      { path: "/untrusted" },
      { args: ["--publish"] },
      { command: "push" },
      { baseRef: "main" },
      { context: undefined },
      { context: { ...context, projectId: "other" } },
      { context: { ...context, branch: "--help" } },
      { context: { ...context, path: "/untrusted" } },
    ])
      expect(() => handler(event, { ...request, ...extra })).toThrow();
    expect(() => handler({ ...event, sender: { id: 2 } }, request)).toThrow();
    expect(() =>
      handler(
        {
          ...event,
          senderFrame: { url: "https://example.invalid", parent: null },
        },
        request,
      ),
    ).toThrow();
    expect(runRepositoryAction).toHaveBeenCalledTimes(1);
  },
);

it("accepts exact explicit card propagation through the existing shell scope only", async () => {
  const handlers = new Map<string, Function>();
  const runRepositoryAction = vi.fn(async (v) => v);
  registerIPC(
    { handle: (n: string, f: Function) => handlers.set(n, f) } as any,
    {
      service: { runRepositoryAction },
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const handler = handlers.get("goga:run-repository-action")!;
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const propagation = {
    year: "2026",
    topic: "alpha",
    branch: "alpha",
    baseRef: "main",
  };
  const request = { projectId: "p", action: "propagate", propagation };
  expect(await handler(event, request)).toEqual(request);
  for (const extra of [
    { action: "publish" },
    { action: "update-remote" },
    { propagation: { ...propagation, path: "/unsafe" } },
    { propagation: { ...propagation, baseRef: "--force" } },
    { propagation: { ...propagation, branch: "--help" } },
    { propagation: { ...propagation, year: "bad" } },
    { propagation: { ...propagation, args: ["reset"] } },
  ])
    expect(() => handler(event, { ...request, ...extra })).toThrow();
  expect(() => handler({ ...event, sender: { id: 2 } }, request)).toThrow();
  expect(runRepositoryAction).toHaveBeenCalledTimes(1);
});
