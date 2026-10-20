import { parseDocument, isMap } from "yaml";
import type { SettingsKind } from "../shared/types";
function validFragment(value: string) {
  let quote = "",
    escaped = false;
  for (const char of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "'" || char === '"') quote = char;
  }
  if (quote || escaped)
    throw new Error("Незавершённая кавычка или escape в docker аргументе");
}
function jsonValue(value: unknown, seen = new Set<object>()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (
    typeof value !== "object" ||
    value instanceof Date ||
    value instanceof Map ||
    value instanceof Set ||
    seen.has(value)
  )
    throw new Error(
      "Профиль должен содержать только JSON-совместимые данные; даты заключайте в кавычки",
    );
  seen.add(value);
  for (const item of Object.values(value)) jsonValue(item, seen);
  seen.delete(value);
}
const mapping = (v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function validateYaml(text: string, kind: SettingsKind) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("Документ слишком большой");
  const doc = parseDocument(text, { uniqueKeys: true, version: "1.1" });
  if (doc.errors.length || !isMap(doc.contents))
    throw new Error("Нужен корректный YAML mapping");
  const obj = doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  if (kind === "config") {
    if (obj.env !== undefined && !mapping(obj.env))
      throw new Error("env должен быть mapping");
    if (obj.docker !== undefined && !mapping(obj.docker))
      throw new Error("docker должен быть mapping");
    for (const key of ["run", "build"]) {
      const v = (obj.docker as Record<string, unknown> | undefined)?.[key];
      if (
        v !== undefined &&
        (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      )
        throw new Error(`docker.${key} должен быть списком строк`);
      if (Array.isArray(v)) for (const item of v) validFragment(item);
    }
  } else jsonValue(obj);
  return obj;
}
