import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
it("guards all Topics channels and validates input before forwarding", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    readTopicBoard: vi.fn(),
    readTopicDetails: vi.fn(),
    prepareTopicOperation: vi.fn(),
    executeTopicOperation: vi.fn(),
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
    "read-topic-board",
    "read-topic-details",
    "prepare-topic-operation",
    "execute-topic-operation",
  ]) {
    expect(handlers.has("goga:" + name)).toBe(true);
    expect(() =>
      handlers.get("goga:" + name)!({ ...event, sender: { id: 2 } }),
    ).toThrow(/IPC/);
  }
  const target = { topic: "feature", branch: "feature", remote: false };
  await handlers.get("goga:read-topic-board")!(event, "p", "2025");
  expect(service.readTopicBoard).toHaveBeenCalledWith("p", "2025");
  await handlers.get("goga:read-topic-details")!(event, "p", "2025", target);
  expect(service.readTopicDetails).toHaveBeenCalledWith("p", "2025", target);
  for (const year of ["25", "../2025", "20255", 2025])
    expect(() =>
      handlers.get("goga:read-topic-board")!(event, "p", year),
    ).toThrow();
  expect(() =>
    handlers.get("goga:read-topic-details")!(event, "p", "2025", {
      ...target,
      branch: "--bad",
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:prepare-topic-operation")!(event, {
      projectId: "p",
      year: "2025",
      action: "publish",
      expectedRevision: "a".repeat(64),
      target,
      unknown: 1,
    }),
  ).toThrow();
  expect(() =>
    handlers.get("goga:execute-topic-operation")!(event, "../../file"),
  ).toThrow();
});
