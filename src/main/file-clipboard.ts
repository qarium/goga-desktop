import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { FileClipboard } from "../shared/project-overview";
const MIME = "text/uri-list",
  MAX_BYTES = 1024 * 1024,
  MAX_FILES = 128;
interface FileClipboardItem {
  readonly types: string[];
  getType(type: string): Promise<unknown>;
}
interface FileClipboardTransport<T extends FileClipboardItem> {
  read(): Promise<T[]>;
  write(items: T[]): Promise<void>;
}
const invalid = () =>
  Error("В буфере нет подходящих локальных файлов или список слишком большой.");
function localFile(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "file:" ||
      (url.hostname && url.hostname !== "localhost") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw invalid();
    const result = fileURLToPath(url);
    if (
      !path.isAbsolute(result) ||
      path.resolve(result) !== result ||
      /[\x00-\x1f\x7f-\x9f]/.test(result)
    )
      throw invalid();
    return result;
  } catch {
    throw invalid();
  }
}
/** Electron 44 maps text/uri-list to native filenames (Finder includes all files in one item).
 * Plain text is deliberately not interpreted as filesystem authority. */
export function createFileClipboard<T extends FileClipboardItem>(
  transport: FileClipboardTransport<T>,
  createItem: (data: Record<string, Blob>) => T,
): FileClipboard {
  return {
    async writeText(text) {
      if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES)
        throw invalid();
      await transport.write([
        createItem({ "text/plain": new Blob([text], { type: "text/plain" }) }),
      ]);
    },
    async readFiles() {
      const items = await transport.read();
      if (items.length > MAX_FILES) throw invalid();
      const files: string[] = [];
      let bytes = 0;
      for (const item of items) {
        if (!item.types.includes(MIME)) continue;
        const blob = await item.getType(MIME);
        if (!(blob instanceof Blob)) throw invalid();
        bytes += blob.size;
        if (bytes > MAX_BYTES) throw invalid();
        for (const line of (await blob.text()).split(/\r?\n/)) {
          if (!line || line.startsWith("#")) continue;
          files.push(localFile(line));
          if (files.length > MAX_FILES) throw invalid();
        }
      }
      return [...new Set(files)];
    },
    async writeFiles(paths) {
      if (!paths.length || paths.length > MAX_FILES) throw invalid();
      const text = paths
        .map((p) => {
          if (
            !path.isAbsolute(p) ||
            path.resolve(p) !== p ||
            /[\x00-\x1f\x7f-\x9f]/.test(p)
          )
            throw invalid();
          return pathToFileURL(p).href;
        })
        .join("\r\n");
      if (Buffer.byteLength(text) > MAX_BYTES) throw invalid();
      await transport.write([
        createItem({ [MIME]: new Blob([text], { type: MIME }) }),
      ]);
    },
  };
}
