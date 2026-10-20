import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
it("worktree IPC accepts only identities from trusted shell and keeps writes out of read cancellation", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    ensureTopicContext: vi.fn(async (v) => v),
    resolveTopicContext: vi.fn(async (v) => v),
    listTopicContexts: vi.fn(async () => []),
  };
  registerIPC(
    { handle: (name: string, fn: Function) => handlers.set(name, fn) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const identity = {
    projectId: "p",
    year: "2026",
    topic: "feature",
    branch: "feature",
  };
  const ref = {
    ...identity,
    contextId: "ctx-" + "a".repeat(64),
    revision: "00000000-0000-4000-8000-000000000001",
  };
  for (const channel of [
    "ensure-topic-context",
    "resolve-topic-context",
    "list-topic-contexts",
  ]) {
    expect(handlers.has("goga:" + channel)).toBe(true);
    expect(() =>
      handlers.get("goga:" + channel)!(
        { ...event, sender: { id: 2 } },
        identity,
      ),
    ).toThrow(/IPC/);
  }
  await handlers.get("goga:ensure-topic-context")!(event, identity);
  expect(service.ensureTopicContext).toHaveBeenCalledWith(identity);
  for (const value of [
    { ...identity, path: "/elsewhere" },
    { ...identity, ownership: "managed" },
    { ...identity, year: "../2026" },
    { ...identity, branch: "--evil" },
  ])
    expect(() =>
      handlers.get("goga:ensure-topic-context")!(event, value),
    ).toThrow();
  await handlers.get("goga:resolve-topic-context")!(event, ref);
  expect(service.resolveTopicContext).toHaveBeenCalledWith(ref);
  expect(() =>
    handlers.get("goga:resolve-topic-context")!(event, {
      ...ref,
      path: "/elsewhere",
    }),
  ).toThrow();
  await handlers.get("goga:list-topic-contexts")!(event, "p");
  expect(service.listTopicContexts).toHaveBeenCalledWith("p");
  expect("ensureTopicContext" in READ_BUDGETS).toBe(false);
  expect("listTopicContexts" in READ_BUDGETS).toBe(true);
  expect("resolveTopicContext" in READ_BUDGETS).toBe(true);
});
