import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RunOutput } from "../shared/types";

const OUTPUT_LIMIT = 128 * 1024;
const BLOCK_SIZE = 4096;
const MASK = "[REDACTED]";

/** A bounded, non-terminal text filter. Escape payloads are never accumulated. */
class PlainText {
  private state:
    "text" | "escape" | "csi" | "string" | "stringEscape" | "intermediate" =
    "text";
  private discarded = 0;
  private cr = false;
  constructor(
    private limit: number,
    private overflow: () => void,
  ) {}
  push(input: string): string {
    let result = "";
    for (const char of input) {
      const code = char.codePointAt(0)!;
      if (this.state !== "text") {
        this.discarded = Math.min(this.limit + 1, this.discarded + char.length);
        if (this.discarded > this.limit) this.overflow();
        if (this.state === "string" || this.state === "stringEscape") {
          if (
            code === 7 ||
            code === 0x9c ||
            (this.state === "stringEscape" && char === "\\")
          )
            this.state = "text";
          else this.state = code === 27 ? "stringEscape" : "string";
        } else if (code === 27) this.state = "escape";
        else if (this.state === "escape") {
          if (char === "[") this.state = "csi";
          else if ("]PX^_".includes(char)) this.state = "string";
          else if (code >= 0x20 && code <= 0x2f) this.state = "intermediate";
          else this.state = "text";
        } else if (this.state === "csi") {
          if (code >= 0x40 && code <= 0x7e) this.state = "text";
        } else if (code >= 0x30 && code <= 0x7e) this.state = "text";
        continue;
      }
      this.discarded = 0;
      if (code === 27) {
        this.state = "escape";
        continue;
      }
      if (code === 0x9b) {
        this.state = "csi";
        continue;
      }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
        this.state = "string";
        continue;
      }
      if (char === "\r") {
        result += "\n";
        this.cr = true;
        continue;
      }
      if (char === "\n" && this.cr) {
        this.cr = false;
        continue;
      }
      if (
        (code < 32 && char !== "\n" && char !== "\t") ||
        (code >= 0x7f && code <= 0x9f)
      )
        continue;
      this.cr = false;
      result += char;
    }
    return result;
  }
}

/** Retains only a possible secret prefix, including masks for overlapping matches. */
class Redactor {
  private pending = "";
  private masks = new Uint8Array(0);
  private masked = false;
  private patterns: { value: string; prefix: Int32Array }[];
  constructor(
    secrets: readonly string[],
    private mask: string,
  ) {
    this.patterns = secrets.map((value) => {
      const prefix = new Int32Array(value.length);
      for (let i = 1, size = 0; i < value.length; i++) {
        while (size && value[i] !== value[size]) size = prefix[size - 1];
        if (value[i] === value[size]) size++;
        prefix[i] = size;
      }
      return { value, prefix };
    });
  }
  push(input: string, final = false): string {
    if (!this.patterns.length) return input;
    const text = this.pending + input;
    const masks = new Uint8Array(text.length);
    masks.set(this.masks);
    const ranges = new Int32Array(text.length + 1);
    let hold = 0;
    // KMP keeps long/repetitive secrets linear per pattern; range deltas avoid
    // repeatedly touching every character of thousands of overlapping matches.
    for (const { value, prefix } of this.patterns) {
      let size = 0;
      for (let i = 0; i < text.length; i++) {
        while (size && text[i] !== value[size]) size = prefix[size - 1];
        if (text[i] === value[size]) size++;
        if (size === value.length) {
          ranges[i - size + 1]++;
          ranges[i + 1]--;
          size = prefix[size - 1];
        }
      }
      hold = Math.max(hold, size);
    }
    for (let i = 0, active = 0; i < text.length; i++) {
      active += ranges[i];
      if (active) masks[i] = 1;
    }
    if (final) {
      masks.fill(1, text.length - hold);
      hold = 0;
    }
    const count = text.length - hold;
    let result = "";
    for (let i = 0; i < count; i++) {
      if (masks[i]) {
        if (!this.masked) result += this.mask;
        this.masked = true;
      } else {
        result += text[i];
        this.masked = false;
      }
    }
    this.pending = text.slice(count);
    this.masks = masks.slice(count);
    return result;
  }
}

/**
 * Captures only child output, never argv/environment. The retained tail is at most
 * 128 KiB UTF-8 (or a smaller maxBytes). Streams decode/filter/redact independently;
 * a final redactor also guards accidental matches across their merged output.
 * Each pending secret prefix is bounded by 4095 UTF-16 units; secret definitions
 * total at most 128 KiB. Oversized secret sets fail closed: output is suppressed
 * and marked truncated, rather than retaining unbounded sensitive input.
 * Ordinary callbacks are at most 10 Hz; explicit/end/dispose flushes are immediate.
 */
export function captureRunOutput(
  child: ChildProcessWithoutNullStreams,
  secrets: readonly string[],
  onUpdate: (output: RunOutput) => void,
  options: { maxBytes?: number; throttleMs?: number } = {},
): { snapshot(): RunOutput; flush(): void; dispose(): void } {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.min(OUTPUT_LIMIT, Math.floor(options.maxBytes!)))
    : OUTPUT_LIMIT;
  const throttleMs = Number.isFinite(options.throttleMs)
    ? Math.max(100, options.throttleMs!)
    : 100;
  let text = "",
    bytes = 0,
    truncated = false,
    disposed = false,
    dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const markTruncated = () => {
    if (!truncated) {
      truncated = true;
      dirty = true;
    }
  };
  let secretBytes = 0,
    suppress = false;
  const normalized = new Set<string>();
  for (const secret of secrets) {
    if (!secret) continue;
    if (
      secret.length > BLOCK_SIZE ||
      (secretBytes += Buffer.byteLength(secret)) > OUTPUT_LIMIT
    ) {
      suppress = true;
      markTruncated();
      normalized.clear();
      break;
    }
    const plain = new PlainText(OUTPUT_LIMIT, () => {}).push(secret);
    if (plain) normalized.add(plain);
  }
  const known = [...normalized];
  let mask = MASK;
  if (known.some((secret) => mask.includes(secret))) {
    const used = new Set(known.join(""));
    let code = 0xe000;
    while (used.has(String.fromCodePoint(code))) code++;
    // A character absent from all bounded secret definitions cannot recreate one.
    mask = String.fromCodePoint(code);
  }
  const merged = new Redactor(known, mask);
  const snapshot = (): RunOutput => ({ text, truncated });
  const publish = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    onUpdate(snapshot());
  };
  const schedule = () => {
    if (dirty && !timer) timer = setTimeout(publish, throttleMs);
  };
  const append = (value: string) => {
    if (!value) return;
    text += value;
    bytes += Buffer.byteLength(value);
    if (bytes > maxBytes) {
      const buffer = Buffer.from(text);
      let start = buffer.length - maxBytes;
      while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
      text = buffer.subarray(start).toString("utf8");
      bytes = buffer.length - start;
      markTruncated();
    }
    dirty = true;
  };
  const states = (["stdout", "stderr"] as const).map((name) => {
    const decoder = new StringDecoder("utf8");
    const plain = new PlainText(maxBytes, markTruncated);
    const redactor = new Redactor(known, mask);
    let ended = false;
    const accept = (value: string) =>
      append(merged.push(redactor.push(plain.push(value))));
    const data = (chunk: Buffer | string) => {
      if (disposed || ended || suppress) return;
      // Work in small blocks even if a single child write is very large.
      if (typeof chunk === "string") {
        for (let offset = 0; offset < chunk.length;) {
          let end = Math.min(chunk.length, offset + BLOCK_SIZE);
          if (end < chunk.length && /[\uD800-\uDBFF]/.test(chunk[end - 1]))
            end--;
          accept(chunk.slice(offset, end));
          offset = end;
        }
      } else {
        for (let offset = 0; offset < chunk.length; offset += BLOCK_SIZE)
          accept(decoder.write(chunk.subarray(offset, offset + BLOCK_SIZE)));
      }
      schedule();
    };
    const finish = () => {
      if (ended) return;
      ended = true;
      if (!suppress) {
        accept(decoder.end());
        append(merged.push(redactor.push("", true)));
      }
    };
    const end = () => {
      if (!disposed) {
        finish();
        publish();
      }
    };
    child[name].on("data", data);
    child[name].on("end", end);
    return { name, data, end, finish };
  });
  // A flush is a publication boundary, NOT a stream boundary: a later write may
  // complete a held secret prefix, so raw pending data must not be released here.
  const flush = () => {
    if (!disposed) publish();
  };
  const dispose = () => {
    if (disposed) return;
    for (const state of states) state.finish();
    append(merged.push("", true));
    disposed = true;
    for (const state of states) {
      child[state.name].off("data", state.data);
      child[state.name].off("end", state.end);
    }
    child.off("close", dispose);
    publish();
  };
  child.on("close", dispose);
  schedule();
  return { snapshot, flush, dispose };
}
