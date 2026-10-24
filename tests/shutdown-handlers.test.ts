import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { installShutdownHandlers } from "../src/main/shutdown-handlers";
it("intercepts window/app exit and coalesces duplicate requests and failure dialogs", async () => {
  const app = new EventEmitter(),
    window = new EventEmitter();
  let finish!: (result: any) => void;
  const close = vi.fn(
    () =>
      new Promise<any>((resolve) => {
        finish = resolve;
      }),
  );
  const report = vi.fn(async () => {});
  const detach = installShutdownHandlers({
    app,
    window,
    shutdown: { close },
    isExiting: () => false,
    report,
  });
  const event = { preventDefault: vi.fn() };
  window.emit("close", event);
  app.emit("before-quit", event);
  expect(event.preventDefault).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  finish({ status: "partial", completed: ["a"], remaining: ["b"] });
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
  detach();
  expect(app.listenerCount("before-quit")).toBe(0);
  expect(window.listenerCount("close")).toBe(0);
});
it.each(["success", "cancelled"])(
  "does not show an error for %s; finalized exit passes through",
  async (status) => {
    const app = new EventEmitter(),
      window = new EventEmitter();
    let exiting = false;
    const close = vi.fn(
      async () => ({ status, completed: [], remaining: [] }) as any,
    );
    const report = vi.fn(async () => {});
    installShutdownHandlers({
      app,
      window,
      shutdown: { close },
      isExiting: () => exiting,
      report,
    });
    const event = { preventDefault: vi.fn() };
    window.emit("close", event);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(report).not.toHaveBeenCalled();
    exiting = true;
    app.emit("before-quit", event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  },
);
