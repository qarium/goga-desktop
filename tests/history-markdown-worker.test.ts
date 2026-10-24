import { afterEach, expect, it, vi } from "vitest";
import { lexHistoryMarkdown } from "../src/renderer/history-markdown-worker-client";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("terminates a stuck Markdown parser and settles its promise", async () => {
  vi.useFakeTimers();
  let worker: any;
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: any;
      onerror: any;
      onmessageerror: any;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        worker = this;
      }
    },
  );
  const result = lexHistoryMarkdown(
    "*a".repeat(49000) + "*".repeat(49000),
    new AbortController().signal,
  );
  const rejected = expect(result).rejects.toThrow(/время/);
  await vi.advanceTimersByTimeAsync(1500);
  await rejected;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("terminates on navigation cancellation and ignores late output", async () => {
  let worker: any;
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: any;
      onerror: any;
      onmessageerror: any;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        worker = this;
      }
    },
  );
  const controller = new AbortController();
  const pending = lexHistoryMarkdown("# Test", controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow(/отмен/);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  worker.onmessage?.({ data: { ok: true, tokens: [] } });
});
it("releases parser after success and reports startup/runtime errors", async () => {
  let worker: any;
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: any;
      onerror: any;
      onmessageerror: any;
      terminate = vi.fn();
      postMessage = vi.fn();
      constructor() {
        worker = this;
      }
    },
  );
  const result = lexHistoryMarkdown("# Test", new AbortController().signal);
  worker.onmessage({ data: { ok: true, tokens: [] } });
  expect(await result).toEqual([]);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  const failing = lexHistoryMarkdown("# Test", new AbortController().signal);
  worker.onerror({ preventDefault: vi.fn() });
  await expect(failing).rejects.toThrow();
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw Error("unavailable");
      }
    },
  );
  await expect(
    lexHistoryMarkdown("text", new AbortController().signal),
  ).rejects.toThrow();
});
