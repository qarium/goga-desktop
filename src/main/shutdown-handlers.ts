import type {
  ShutdownCoordinator,
  ShutdownResult,
} from "./shutdown-coordinator";
interface ExitEvent {
  preventDefault(): void;
}
interface ExitEmitter {
  on(name: string, listener: (event: ExitEvent) => void): unknown;
  removeListener(name: string, listener: (event: ExitEvent) => void): unknown;
}
/** Install before loadShell. Both menu quit and window close use the same flight. */
export function installShutdownHandlers(options: {
  app: ExitEmitter;
  window: ExitEmitter;
  shutdown: Pick<ShutdownCoordinator, "close">;
  isExiting(): boolean;
  report(result: ShutdownResult): Promise<void>;
}): () => void {
  let pending = false;
  const close = (event: ExitEvent) => {
    if (options.isExiting()) return;
    event.preventDefault();
    if (pending) return;
    pending = true;
    void Promise.resolve()
      .then(async () => {
        const result = await options.shutdown.close();
        if (result.status === "failed" || result.status === "partial")
          await options.report(result);
      })
      .catch(() => {
        // Failure to display a native dialog never grants permission to quit.
      })
      .finally(() => {
        pending = false;
      });
  };
  options.window.on("close", close);
  options.app.on("before-quit", close);
  return () => {
    options.window.removeListener("close", close);
    options.app.removeListener("before-quit", close);
  };
}
