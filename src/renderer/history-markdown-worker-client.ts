import { t as msg } from "../shared/i18n";
import type { Token } from "marked";
import {
  MARKDOWN_MAX_CHARACTERS,
  MARKDOWN_PARSE_TIMEOUT,
} from "./history-markdown-limits";
/** Untrusted Markdown is parsed off-thread; a pathological input cannot freeze navigation. */
export function lexHistoryMarkdown(
  text: string,
  signal: AbortSignal,
): Promise<Token[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Error(msg("workspace.parsingCanceled")));
      return;
    }
    if (text.length > MARKDOWN_MAX_CHARACTERS) {
      reject(Error(msg("workspace.largeMarkdownDocument")));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./history-markdown-worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      reject(Error(msg("workspace.markdownParsingUnavailable")));
      return;
    }
    let done = false;
    const finish = (error?: Error, tokens?: Token[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error);
      else resolve(tokens!);
    };
    const abort = () => finish(Error(msg("workspace.parsingCanceled")));
    const timer = setTimeout(
      () => finish(Error(msg("workspace.markdownParsingTimedOut"))),
      MARKDOWN_PARSE_TIMEOUT,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) => {
      if (event.data?.ok && Array.isArray(event.data.tokens))
        finish(undefined, event.data.tokens);
      else finish(Error(msg("workspace.markdownIsTooComplex")));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(Error(msg("workspace.couldNotParseMarkdown")));
    };
    worker.onmessageerror = () => finish(Error(msg("workspace.couldNotGetMarkdown")));
    try {
      worker.postMessage({ text });
    } catch {
      finish(Error(msg("workspace.couldNotSubmitMarkdownForParsing")));
    }
  });
}
