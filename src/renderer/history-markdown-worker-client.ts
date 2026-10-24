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
      reject(Error("Разбор отменён"));
      return;
    }
    if (text.length > MARKDOWN_MAX_CHARACTERS) {
      reject(Error("Большой Markdown"));
      return;
    }
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./history-markdown-worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      reject(Error("Разбор Markdown недоступен"));
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
    const abort = () => finish(Error("Разбор отменён"));
    const timer = setTimeout(
      () => finish(Error("Превышено время разбора Markdown")),
      MARKDOWN_PARSE_TIMEOUT,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) => {
      if (event.data?.ok && Array.isArray(event.data.tokens))
        finish(undefined, event.data.tokens);
      else finish(Error("Слишком сложный Markdown"));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(Error("Не удалось разобрать Markdown"));
    };
    worker.onmessageerror = () => finish(Error("Не удалось получить Markdown"));
    try {
      worker.postMessage({ text });
    } catch {
      finish(Error("Не удалось отправить Markdown на разбор"));
    }
  });
}
