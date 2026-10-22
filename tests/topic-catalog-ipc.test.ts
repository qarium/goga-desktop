import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { readSignal } from "../src/host/read-scope";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
it("routes catalog through bounded cancellable read transport and rejects late results", async () => {
  const handlers = new Map<string, Function>();
  let signal: AbortSignal | undefined, finish!: (value: unknown) => void;
  const service = {
    readTopicCatalog: vi.fn(() => {
      signal = readSignal();
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  expect(IPC_SCOPES["read-topic-catalog"]).toBe("catalog");
  expect(READ_BUDGETS.readTopicCatalog).toBeGreaterThan(0);
  expect(READ_BUDGETS.readTopicCatalog).toBeLessThanOrEqual(
    READ_BUDGETS.readTopicBoard,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const pending = handlers.get("goga:read-request")!(
    event,
    "catalog",
    "readTopicCatalog",
    ["p", "2026"],
  );
  await Promise.resolve();
  expect(service.readTopicCatalog).toHaveBeenCalledExactlyOnceWith("p", "2026");
  expect(signal?.aborted).toBe(false);
  handlers.get("goga:cancel-read")!(event, "catalog");
  await expect(pending).rejects.toThrow();
  expect(signal?.aborted).toBe(true);
  finish({ projectId: "p", year: "2026", entries: [], currentTopic: null });
  await Promise.resolve();
});
