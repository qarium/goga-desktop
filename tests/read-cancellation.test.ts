import { it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { NodeRunner } from "../src/host/process";
import { withReadScope, readSignal } from "../src/host/read-scope";
import { registerIPC } from "../src/main/ipc";
it("cancels only the command owned by a read, not an independent running process", async () => {
  const runner = new NodeRunner();
  const owned = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const independent = { pid: 999 };
  vi.spyOn(runner, "start").mockReturnValue(owned as any);
  const kill = vi.spyOn(runner, "kill").mockResolvedValue();
  const controller = new AbortController();
  const result = withReadScope(controller.signal, () =>
    runner.command("fixture", [], "/private/tmp"),
  );
  controller.abort();
  await expect(result).rejects.toThrow(/Чтение отменено/);
  expect(kill).toHaveBeenCalledExactlyOnceWith(owned);
  expect(kill).not.toHaveBeenCalledWith(independent);
  await expect(async () =>
    withReadScope(controller.signal, () =>
      runner.command("fixture", [], "/private/tmp"),
    ),
  ).rejects.toThrow(/отменено/);
  expect(runner.start).toHaveBeenCalledTimes(1);
});
it("read IPC validates methods/sender, isolates cancelled results, and passes cancellation to commands", async () => {
  const handlers = new Map<string, Function>();
  let finish!: (v: unknown) => void,
    signal: AbortSignal | undefined,
    destroy!: () => void;
  const service = {
    discover: vi.fn(() => {
      signal = readSignal();
      return new Promise((r) => (finish = r));
    }),
  };
  registerIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      service,
      settings: {},
      window: {
        webContents: {
          id: 1,
          once: (_event: string, fn: () => void) => (destroy = fn),
        },
      },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const read = handlers.get("goga:read-request")!,
    cancel = handlers.get("goga:cancel-read")!;
  expect(() => read(event, "id", "launch", [])).toThrow();
  expect(() =>
    read({ ...event, sender: { id: 2 } }, "id", "discover", ["p"]),
  ).toThrow(/IPC/);
  const old = read(event, "old", "discover", ["p"]);
  await Promise.resolve();
  expect(signal?.aborted).toBe(false);
  cancel(event, "old");
  await expect(old).rejects.toThrow(/ожидания/);
  expect(signal?.aborted).toBe(true);
  service.discover.mockResolvedValueOnce({ fresh: true } as never);
  expect(await read(event, "new", "discover", ["p"])).toEqual({ fresh: true });
  finish({ stale: true });
  await Promise.resolve();
  const pending = read(event, "destroy", "discover", ["p"]);
  await Promise.resolve();
  destroy();
  await expect(pending).rejects.toThrow();
  expect(signal?.aborted).toBe(true);
});
it("host deadline aborts a silent read even when renderer cancellation never arrives", async () => {
  vi.useFakeTimers();
  try {
    const handlers = new Map<string, Function>();
    let signal: AbortSignal | undefined;
    const service = {
      readProjectSettings: vi.fn(() => {
        signal = readSignal();
        return new Promise(() => {});
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
    const event = {
      sender: { id: 1 },
      senderFrame: { url: "file:///app/index.html", parent: null },
    };
    let error = "";
    void handlers.get("goga:read-request")!(
      event,
      "old",
      "readProjectSettings",
      ["p"],
    ).catch((e: Error) => (error = e.message));
    await vi.advanceTimersByTimeAsync(30001);
    expect(error).toContain("Превышено время ожидания");
    expect(signal?.aborted).toBe(true);
    service.readProjectSettings.mockResolvedValueOnce({ fresh: true } as never);
    expect(
      await handlers.get("goga:read-request")!(
        event,
        "fresh",
        "readProjectSettings",
        ["p"],
      ),
    ).toEqual({ fresh: true });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
