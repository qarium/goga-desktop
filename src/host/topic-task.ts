import { childEnvironment } from "./process-environment";
import path from "node:path";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { digest, noSymlinks } from "./settings";
import type { TopicTaskDocument } from "../shared/types";
const execute = promisify(execFile);
const MAX_BYTES = 400000;
export function validateTaskText(text: unknown): asserts text is string {
  if (
    typeof text !== "string" ||
    text.length > 100000 ||
    text.includes("\0") ||
    text === "__declared__" ||
    Buffer.from(text).toString("utf8") !== text
  )
    throw new Error(
      "Некорректное описание задачи (UTF-8, не более 100000 символов)",
    );
}
function decode(bytes: Uint8Array) {
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  validateTaskText(text);
  return text;
}
export function taskPath(
  topic: string,
  year: number | string = new Date().getFullYear(),
) {
  if (
    !/^\d{4}$/.test(String(year)) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(topic)
  )
    throw new Error("Некорректный топик");
  return `.goga/history/${year}/${topic}/todo.md`;
}
export async function guardedProject(root: string) {
  await noSymlinks(root);
  if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
    throw new Error("Путь проекта изменился. Добавьте проект заново.");
}
export async function readWorkingTask(
  root: string,
  relative: string,
  observe?: (stamp: string) => void,
): Promise<{ text: string; exists: boolean }> {
  await guardedProject(root);
  const file = path.join(root, relative);
  await noSymlinks(file);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      observe?.("missing");
      return { text: "", exists: false };
    }
    throw error;
  }
  if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES)
    throw new Error(
      "todo.md должен быть обычным UTF-8 файлом допустимого размера",
    );
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await handle.stat();
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      actual.size > MAX_BYTES ||
      actual.ino !== info.ino ||
      actual.dev !== info.dev
    )
      throw new Error("Недопустимый файл todo.md");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const next = await handle.read(
        bytes,
        bytesRead,
        bytes.length - bytesRead,
        bytesRead,
      );
      if (!next.bytesRead) break;
      bytesRead += next.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(file);
    if (
      after.nlink !== 1 ||
      current.nlink !== 1 ||
      current.size !== actual.size ||
      current.mtimeMs !== actual.mtimeMs ||
      current.ctimeMs !== actual.ctimeMs ||
      after.size !== actual.size ||
      after.mtimeMs !== actual.mtimeMs ||
      after.ctimeMs !== actual.ctimeMs ||
      current.ino !== actual.ino ||
      current.dev !== actual.dev
    )
      throw new Error("Задача изменилась во время чтения. Откройте её заново.");
    if (bytesRead > MAX_BYTES) throw new Error("todo.md слишком велик");
    await noSymlinks(file);
    observe?.(
      JSON.stringify([
        actual.dev,
        actual.ino,
        actual.nlink,
        actual.size,
        actual.mtimeMs,
        actual.ctimeMs,
      ]),
    );
    return { text: decode(bytes.subarray(0, bytesRead)), exists: true };
  } finally {
    await handle.close();
  }
}
export async function readCommittedTask(
  root: string,
  commit: string,
  relative: string,
  git: (args: string[]) => Promise<string>,
  env?: NodeJS.ProcessEnv,
) {
  // Inspect every tree component: ls-tree must never follow a link/submodule.
  const parts = relative.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const name = parts.slice(0, i).join("/");
    const entry = await git(["ls-tree", "-z", commit, "--", name]);
    if (!entry) return { text: "", exists: false };
    const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t([^\0]+)\0$/.exec(
      entry,
    );
    if (
      !match ||
      match[4] !== name ||
      (i < parts.length
        ? match[1] !== "040000" || match[2] !== "tree"
        : !["100644", "100755"].includes(match[1]!) || match[2] !== "blob")
    )
      throw new Error(
        "Ссылки и нестандартные объекты в пути todo.md не поддержаны",
      );
    if (i === parts.length) {
      const size = Number((await git(["cat-file", "-s", match[3]!])).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BYTES)
        throw new Error("todo.md слишком велик");
      const { stdout } = await execute("git", ["cat-file", "blob", match[3]!], {
        cwd: root,
        env: childEnvironment(process.env, {}, env),
        encoding: "buffer",
        maxBuffer: MAX_BYTES + 1,
        timeout: 120000,
      });
      return { text: decode(stdout), exists: true };
    }
  }
  throw new Error("Не удалось прочитать todo.md");
}
export function taskDocument(
  root: string,
  branch: string,
  commit: string,
  relative: string,
  value: Pick<TopicTaskDocument, "text" | "exists" | "catalogState">,
): TopicTaskDocument {
  return {
    ...value,
    path: relative,
    version: digest(
      JSON.stringify([
        root,
        branch,
        commit,
        relative,
        value.exists,
        value.text,
        ...(value.catalogState ? [value.catalogState] : []),
      ]),
    ),
  };
}
