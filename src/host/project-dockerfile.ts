import path from "node:path";
import { createHash } from "node:crypto";
import { isProjectDockerfilePath } from "../shared/project-documents";
/** Goga prints a header followed by a plain scalar, not a YAML serialization. */
export function parseDockerfile(root: string, output: string) {
  const match = /^# dockerfile\r?\n([^\r\n]+)\r?\n?$/.exec(output);
  if (!match) throw new Error("Не удалось прочитать путь Dockerfile из Goga");
  const value = match[1],
    configured = value !== "null";
  const selected = configured ? value : ".goga/Dockerfile";
  if (
    selected.split("/").some((part) => part === "..") ||
    selected.includes("\\")
  )
    throw new Error("Недопустимый путь Dockerfile");
  const normalized = path.posix.normalize(selected);
  const relativePath = path.isAbsolute(normalized)
    ? path.relative(root, normalized)
    : normalized;
  if (!isProjectDockerfilePath(relativePath))
    throw new Error(
      "Dockerfile должен быть обычным файлом внутри выбранного проекта, вне Git и конфигурации",
    );
  return {
    relativePath,
    configured,
    fingerprint: createHash("sha256").update(output).digest("hex"),
  };
}
