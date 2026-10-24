import { z } from "zod";

export interface HistoryArtifact {
  /** Relative to the selected history entry, with '/' separators. */
  path: string;
  kind: "directory" | "file";
  /** Metadata permits opening; UTF-8 and content checks are deferred until read. */
  readable: boolean;
  reason?: string;
  size?: number;
}
export interface HistoryDocument {
  /** Project-relative .goga/history/<year>/<entry>/<artifact>. */
  relativePath: string;
  text: string;
  format: "markdown" | "text";
}
export const HISTORY_MAX_BYTES = 1024 * 1024;
export const HISTORY_MAX_ENTRIES = 2048;
export const HISTORY_MAX_DEPTH = 16;
const component = (value: string) =>
  value.length > 0 &&
  value.length <= 255 &&
  value !== "." &&
  value !== ".." &&
  !/[\\/:\x00-\x1f\x7f-\x9f]/.test(value) &&
  // Never round-trip malformed UTF-16 into a different filesystem name.
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
export const historyYearSchema = z.string().regex(/^\d{4}$/);
export const historyEntrySchema = z
  .string()
  .refine(component, "Недопустимое имя записи истории");
export const historyPathSchema = z
  .string()
  .max(4096)
  .refine((value) => {
    const parts = value.split("/");
    return parts.length <= HISTORY_MAX_DEPTH && parts.every(component);
  }, "Недопустимый относительный путь истории (глубина до 16)");

export interface HistoryPrunePreview {
  status: "ready" | "error";
  projectId: string;
  year: string;
  entries: string[];
  token?: string;
  log: string;
  error?: string;
}
export interface HistoryPruneResult {
  status: "ok" | "error";
  /** A mutation was attempted; refresh even on failure because CLI may partially delete. */
  changed: boolean;
  log: string;
  error?: string;
}
