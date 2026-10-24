import { Lexer } from "marked";
import { MARKDOWN_MAX_CHARACTERS } from "./history-markdown-limits";
// This module has no filesystem, shell or network operations. Only inert tokens
// leave the worker; HTML generation and custom Markdown extensions are disabled.
self.onmessage = (event: MessageEvent<{ text: unknown }>) => {
  try {
    const text = event.data.text;
    if (typeof text !== "string" || text.length > MARKDOWN_MAX_CHARACTERS)
      throw Error();
    const tokens = Lexer.lex(text, { gfm: true });
    const queue: { value: unknown; depth: number }[] = [
      { value: tokens, depth: 0 },
    ];
    let count = 0;
    while (queue.length) {
      const { value, depth } = queue.pop()!;
      if (++count > 30000 || depth > 80) throw Error();
      if (Array.isArray(value))
        for (const child of value)
          queue.push({ value: child, depth: depth + 1 });
      else if (value && typeof value === "object")
        for (const child of Object.values(value))
          if (child && typeof child === "object")
            queue.push({ value: child, depth: depth + 1 });
    }
    self.postMessage({ ok: true, tokens });
  } catch {
    self.postMessage({ ok: false });
  }
};
