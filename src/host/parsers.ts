import { stripVTControlCharacters } from "node:util";
import type { Pipeline, Stage, PipelineRequest } from "../shared/types";
export function safeName(
  value: unknown,
  label = "имя",
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 180 ||
    value.startsWith("-") ||
    /[\/\\\x00-\x20]/.test(value) ||
    value.includes("..")
  )
    throw new Error(`Недопустимое ${label}`);
}
export function profileName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value.length > 180
  )
    throw new Error("Недопустимое имя профиля");
}
export function parseCatalog(text: string): Pipeline[] {
  const result: Pipeline[] = [];
  let current: Pipeline | undefined;
  for (const line of stripVTControlCharacters(text).split(/\r?\n/)) {
    const m = line.match(/^\* (.+?)( \(project\))?\s*$/);
    if (m) {
      safeName(m[1]);
      current = { id: m[1]!, name: m[1]!, description: "", project: !!m[2] };
      result.push(current);
    } else {
      const field = line.match(/^\s+(name|description):\s*(.*)$/);
      if (field && current)
        current[field[1] as "name" | "description"] = field[2]!;
    }
  }
  return result;
}
export function parseCard(text: string): Stage[] {
  const stages: Stage[] = [];
  let current: Stage | undefined;
  for (const line of stripVTControlCharacters(text).split(/\r?\n/)) {
    const m = line.match(/^\* ([^\s]+):\s*$/);
    if (m) {
      safeName(m[1], "stage ID");
      if (stages.some((s) => s.id === m[1])) throw new Error("Повтор stage ID");
      current = { id: m[1]!, title: "" };
      stages.push(current);
    } else {
      const t = line.match(/^\s+title:\s*(.*)$/);
      if (t && current) current.title = t[1]!;
    }
  }
  return stages;
}
export function pipelineArgs(r: PipelineRequest, info: boolean): string[] {
  safeName(r.pipeline, "имя конвейера");
  if (
    typeof r.workflow !== "string" ||
    typeof r.profile !== "string" ||
    !Array.isArray(r.skips) ||
    r.skips.length > 1000
  )
    throw new Error("Некорректные параметры");
  const args = ["pipeline", r.pipeline];
  if (r.workflow === "none") args.push("--no-workflow");
  else if (r.workflow !== "auto") {
    const name = workflowName(r.workflow);
    safeName(name, "имя рабочего процесса");
    args.push("--workflow", name);
  }
  if (r.profile) {
    profileName(r.profile);
    args.push("--profile", r.profile);
  }
  for (const id of r.skips) {
    safeName(id, "stage ID");
    args.push("--skip", id);
  }
  if (info) args.push("--info");
  return args;
}
export function dashboardUrl(line: string): string | undefined {
  const m = stripVTControlCharacters(line).match(
    /^\s*dashboard: (http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5})\s*$/,
  );
  if (!m) return;
  try {
    const u = new URL(m[1]!);
    if (Number(u.port) > 0 && Number(u.port) <= 65535) return u.origin;
  } catch {}
  return;
}
export class DashboardParser {
  private buffers = { stdout: "", stderr: "" };
  push(stream: "stdout" | "stderr", chunk: string): string[] {
    this.buffers[stream] += chunk;
    const lines = this.buffers[stream].split("\n");
    this.buffers[stream] = lines.pop()!.slice(-65536);
    return lines.flatMap((l) => {
      const url = dashboardUrl(l);
      return url ? [url] : [];
    });
  }
  flush(stream: "stdout" | "stderr"): string[] {
    return this.push(stream, "\n");
  }
}
/** Mirrors Goga load_workflow._peek_literal_profile for metadata only.
 * Stage composition always comes from Goga, never from this parser. */
export function peekWorkflowProfile(text: string): string | null {
  let raw: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^profile:[ \t]*(.*)$/);
    if (match) raw = match[1];
  }
  if (raw === undefined) return null;
  let quote = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]!))) {
      raw = raw.slice(0, i);
      break;
    }
  }
  let value = raw.trim();
  if (!value || value.includes("{{") || value.includes("{%")) return null;
  if (
    value.length >= 2 &&
    value[0] === value.at(-1) &&
    ['"', "'"].includes(value[0]!)
  )
    value = value.slice(1, -1).trim();
  return value || null;
}

export function workflowName(choice: string) {
  return choice.startsWith("file:") ? choice.slice(5) : choice;
}
