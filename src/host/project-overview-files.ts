import path from "node:path";
import { lstat, mkdir, opendir } from "node:fs/promises";
import {
  isOverviewPath,
  type OverviewDirectory,
  type OverviewEntry,
} from "../shared/project-overview";
import {
  readSourceFile,
  saveSourceFile,
  sourceDirectories,
  verifySourceDirectories,
} from "./project-documents";
import { assertReadActive } from "./read-scope";
const MAX_ENTRIES = 2048,
  MAX_SEARCH = 10000,
  MAX_DEPTH = 32;
const validate = (p: string, root = false) => {
  if (!isOverviewPath(p, root)) throw Error("Недопустимый путь файла");
};
export async function listOverviewDirectory(
  root: string,
  relative: string,
): Promise<OverviewDirectory> {
  validate(relative, true);
  assertReadActive();
  const dirs = await sourceDirectories(root, relative);
  const entries: OverviewEntry[] = [];
  let truncated = false;
  const directory = await opendir(path.join(root, relative));
  for await (const e of directory) {
    assertReadActive();
    if (e.name.toLowerCase() === ".git") continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const p = relative ? relative + "/" + e.name : e.name;
    if (!isOverviewPath(p)) continue;
    entries.push({
      path: p,
      name: e.name,
      kind: e.isSymbolicLink()
        ? "unsupported"
        : e.isDirectory()
          ? "directory"
          : e.isFile()
            ? "file"
            : "unsupported",
      ...(e.isSymbolicLink()
        ? { reason: "Символическая ссылка не открывается" }
        : {}),
    });
  }
  await verifySourceDirectories(dirs.identities);
  entries.sort(
    (a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") ||
      a.name.localeCompare(b.name),
  );
  return { path: relative, entries, truncated };
}
export async function searchOverviewFiles(
  root: string,
  relative: string,
  query: string,
): Promise<OverviewDirectory> {
  validate(relative, true);
  if (!query.trim() || query.length > 256)
    throw Error("Введите имя файла до 256 символов");
  const result: OverviewDirectory = {
    path: relative,
    entries: [],
    truncated: false,
  };
  let visited = 0;
  const visit = async (p: string, depth: number): Promise<void> => {
    assertReadActive();
    if (depth > MAX_DEPTH || visited >= MAX_SEARCH) {
      result.truncated = true;
      return;
    }
    const listing = await listOverviewDirectory(root, p);
    result.truncated ||= listing.truncated;
    for (const e of listing.entries) {
      if (++visited > MAX_SEARCH) {
        result.truncated = true;
        return;
      }
      if (
        e.kind !== "unsupported" &&
        e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())
      ) {
        result.entries.push(e);
        if (result.entries.length >= MAX_ENTRIES) {
          result.truncated = true;
          return;
        }
      }
      if (e.kind === "directory") await visit(e.path, depth + 1);
      if (visited >= MAX_SEARCH || result.entries.length >= MAX_ENTRIES) {
        result.truncated = true;
        return;
      }
    }
  };
  await visit(relative, 0);
  return result;
}
export const readOverviewFile = readSourceFile;
export const saveOverviewFile = saveSourceFile;
export async function createOverviewEntry(
  root: string,
  relative: string,
  kind: "file" | "directory",
  text = "",
  guard?: () => Promise<void>,
) {
  validate(relative);
  if (kind === "file")
    return saveSourceFile(root, relative, text, "missing", guard);
  if (kind !== "directory") throw Error("Недопустимый вид файла");
  const parent = await sourceDirectories(
    root,
    path.dirname(relative) === "." ? "" : path.dirname(relative),
  );
  await guard?.();
  await verifySourceDirectories(parent.identities);
  await mkdir(path.join(root, relative), { recursive: false });
  await verifySourceDirectories(parent.identities);
  const created = await lstat(path.join(root, relative));
  if (!created.isDirectory() || created.isSymbolicLink())
    throw Error("Папка изменилась при создании");
  return null;
}
