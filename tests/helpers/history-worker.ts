import { Lexer } from "marked";
import { vi } from "vitest";
/** jsdom has no Worker. Parse benign UI fixtures with the actual lexer;
 * worker lifetime/error/timeout behavior has independent contract tests. */
export function installHistoryWorker() {
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: unknown) => void) | null = null;
      onerror: unknown;
      onmessageerror: unknown;
      closed = false;
      postMessage({ text }: { text: string }) {
        queueMicrotask(() => {
          if (!this.closed)
            this.onmessage?.({
              data: { ok: true, tokens: Lexer.lex(text, { gfm: true }) },
            });
        });
      }
      terminate() {
        this.closed = true;
      }
    },
  );
}
