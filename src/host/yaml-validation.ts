import { t as tr } from "../shared/i18n";
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
    throw new Error(tr("host.unterminatedQuoteOrEscapeInADockerArgument"));
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
      tr("host.profilesMayContainOnlyJsonCompatibleDataQuoteDates"),
    );
  seen.add(value);
  for (const item of Object.values(value)) jsonValue(item, seen);
  seen.delete(value);
}
const mapping = (v: unknown) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function validateYaml(text: string, kind: SettingsKind) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)
    throw new Error(tr("host.theDocumentIsTooLarge"));
  const doc = parseDocument(text, { uniqueKeys: true, version: "1.1" });
  if (doc.errors.length || !isMap(doc.contents))
    throw new Error(tr("host.aValidYamlMappingIsRequired"));
  const obj = doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  if (kind === "config") {
    if (obj.env !== undefined && !mapping(obj.env))
      throw new Error(tr("host.envMustBeAMapping"));
    if (obj.docker !== undefined && !mapping(obj.docker))
      throw new Error(tr("host.dockerMustBeAMapping"));
    for (const key of ["run", "build"]) {
      const v = (obj.docker as Record<string, unknown> | undefined)?.[key];
      if (
        v !== undefined &&
        (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      )
        throw new Error(tr("host.dockerKeyMustBeAListOfStrings", { key: key }));
      if (Array.isArray(v)) for (const item of v) validFragment(item);
    }
  } else jsonValue(obj);
  return obj;
}
