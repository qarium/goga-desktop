import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
it("guards topic-first removal channels and rejects paths/owner bypasses before Host", async () => {
  const handlers = new Map<string, Function>(),
    service = {
      prepareTopicRemoval: vi.fn(),
      executeTopicRemoval: vi.fn(),
      prepareTopicCloneCleanup: vi.fn(),
    };
  registerIPC(
    { handle: (k: string, v: Function) => handlers.set(k, v) } as any,
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
  for (const name of [
    "prepare-topic-removal",
    "execute-topic-removal",
    "prepare-topic-clone-cleanup",
  ]) {
    const fn = handlers.get("goga:" + name);
    expect(fn).toBeTypeOf("function");
    expect(() => fn!({ ...event, sender: { id: 2 } }, {})).toThrow(/IPC/);
  }
  const request = {
    projectId: "p",
    year: "2026",
    expectedRevision: "a".repeat(64),
    action: "delete",
    topics: ["alpha"],
  };
  await handlers.get("goga:prepare-topic-removal")!(event, request);
  expect(service.prepareTopicRemoval).toHaveBeenCalledExactlyOnceWith(request);
  expect(() =>
    handlers.get("goga:prepare-topic-removal")!(event, {
      ...request,
      skipOwnerChecks: true,
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:prepare-topic-removal")!(event, {
      ...request,
      topics: ["../bad"],
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:execute-topic-removal")!(event, {
      projectId: "p",
      token: "bad",
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:prepare-topic-clone-cleanup")!(event, {
      owner: { projectId: "p" },
      path: "/anywhere",
    }),
  ).toThrow();
});
