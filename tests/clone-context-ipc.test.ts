import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
const ref = {
  projectId: "p",
  year: "2026",
  topic: "feature",
  branch: "feature",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
it("passes only narrow context refs to owner-scoped readers and lifecycle writes", async () => {
  const handlers = new Map<string, Function>();
  const service = new Proxy(
    {},
    { get: (_, name) => vi.fn(async (...args) => ({ name, args })) },
  );
  registerIPC(
    { handle: (n: string, f: Function) => handlers.set(n, f) } as any,
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
  for (const channel of [
    "check-topic-context-readiness",
    "discover",
    "list-project-workflows",
    "read-project-settings",
    "topic-sync-status",
    "sync-topic-context",
    "retry-context-sync",
    "prepare-context-apply",
    "prepare-context-deletion",
  ]) {
    const fn = handlers.get("goga:" + channel);
    expect(fn, channel).toBeTypeOf("function");
    expect((await fn!(event, ref)).args).toEqual([ref]);
    expect(() => fn!(event, { ...ref, path: "/untrusted" })).toThrow();
  }
  expect("syncTopicContext" in READ_BUDGETS).toBe(false);
  expect("topicSyncStatus" in READ_BUDGETS).toBe(true);
  expect(READ_BUDGETS.checkTopicContextReadiness).toBe(300000);
  const { contextId: _contextId, revision: _revision, ...identity } = ref;
  expect(
    (await handlers.get("goga:check-topic-context-readiness")!(event, identity))
      .args,
  ).toEqual([identity]);
  expect(() =>
    handlers.get("goga:check-topic-context-readiness")!(event, {
      ...identity,
      contextId: ref.contextId,
    }),
  ).toThrow();
  const request = {
    projectId: "p",
    pipeline: "p",
    workflow: "w",
    profile: "",
    skips: [],
    context: ref,
  };
  expect((await handlers.get("goga:preview")!(event, request)).args).toEqual([
    request,
  ]);
  expect(() =>
    handlers.get("goga:create-topic-context")!(event, {
      projectId: "p",
      year: "2026",
      branch: "--evil",
      baseRef: "main",
    }),
  ).toThrow();
});
