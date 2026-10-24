import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
import { readSignal } from "../src/host/read-scope";
import { READ_BUDGETS } from "../src/shared/read-deadlines";
import { IPC_SCOPES } from "../src/shared/operation-scopes";
it.each([
  ["readTopicTable", "read-topic-table", "catalog", ["p", "2026"]],
  [
    "readTopicOverview",
    "read-topic-overview",
    "topic-or-primary-admin",
    ["p", "2026", { topic: "topic", branch: "topic", remote: false }],
  ],
] as const)(
  "routes %s through cancellable bounded read transport",
  async (method, channel, scope, args) => {
    const handlers = new Map<string, Function>();
    let signal: AbortSignal | undefined, finish!: (value: unknown) => void;
    const service = {
      [method]: vi.fn(() => {
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
    expect(IPC_SCOPES[channel]).toBe(scope);
    expect(READ_BUDGETS[method]).toBeGreaterThan(0);
    const event = {
      sender: { id: 1 },
      senderFrame: { url: "file:///app/index.html", parent: null },
    };
    const pending = handlers.get("goga:read-request")!(
      event,
      "read",
      method,
      args,
    );
    await Promise.resolve();
    expect(service[method]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(signal?.aborted).toBe(false);
    handlers.get("goga:cancel-read")!(event, "read");
    await expect(pending).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    finish({});
    await Promise.resolve();
    expect(() =>
      handlers.get(`goga:${channel}`)!(
        { ...event, sender: { id: 9 } },
        ...args,
      ),
    ).toThrow();
  },
);
