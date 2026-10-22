import { z } from "zod";
import type { Project } from "../shared/types";
import type { TopicCatalogSnapshot } from "../shared/topics";
import {
  topicContextRefSchema,
  type WorktreeRecord,
} from "../shared/worktrees";
import { contextRef } from "./topic-context";

export type DisplayCatalog = TopicCatalogSnapshot;
const target = z.object({
  topic: z.string().min(1).max(1024),
  branch: z.string().min(1).max(256),
  remote: z.boolean(),
});
const catalogSchema = z.object({
  projectId: z.string().min(1).max(256),
  year: z.string().regex(/^\d{4}$/),
  entries: z.array(target).max(10000),
  currentTopic: target.nullable(),
});
const key = (kind: string, project: Project, year = "") =>
  `goga.desktop.${kind}.v1:${JSON.stringify([project.id, project.path, year])}`;
function get(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length <= 2_000_000 ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}
function put(key: string, value: unknown) {
  try {
    const raw = JSON.stringify(value);
    if (raw.length <= 2_000_000) localStorage.setItem(key, raw);
  } catch {
    /* Display preferences must not prevent navigation when storage is unavailable. */
  }
}
export function readCatalogCache(
  project: Project,
  year: string,
): DisplayCatalog | null {
  const parsed = catalogSchema.safeParse(get(key("catalog", project, year)));
  return parsed.success &&
    parsed.data.projectId === project.id &&
    parsed.data.year === year
    ? parsed.data
    : null;
}
export function writeCatalogCache(project: Project, input: DisplayCatalog) {
  const parsed = catalogSchema.safeParse(input);
  if (parsed.success && parsed.data.projectId === project.id)
    put(key("catalog", project, parsed.data.year), parsed.data);
}
// Store a choice, not a host capability. History can retain a narrow reference
// after the working copy and its inventory record have disappeared.
const selectionSchema = topicContextRefSchema.extend({
  path: z.string().max(4096).optional(),
});
/** Presentation only: a restored choice is unavailable until host resolve succeeds. */
export function readWorkspaceSelection(
  project: Project,
): WorktreeRecord | null | undefined {
  const value = get(key("selection", project));
  if (value === null) return null;
  const parsed = selectionSchema.safeParse(value);
  if (!parsed.success || parsed.data.projectId !== project.id) return undefined;
  return {
    ...parsed.data,
    projectPath: project.path,
    path: parsed.data.path ?? "",
    gitCommonDir: "",
    repositoryKey: "",
    ownership: "managed",
    storageKind: "clone",
    state: "conflict",
    preparation: "pending",
  };
}
export function writeWorkspaceSelection(
  project: Project,
  record: WorktreeRecord | null,
) {
  if (record === null) {
    put(key("selection", project), null);
    return;
  }
  if (
    record.projectId !== project.id ||
    (record.projectPath !== project.path &&
      !(record.state === "missing" && record.projectPath === "")) ||
    record.storageKind !== "clone" ||
    record.ownership !== "managed" ||
    record.compatibility ||
    record.preparation ||
    record.deletedAt
  )
    return;
  const parsed = selectionSchema.safeParse({
    ...contextRef(record),
    path: record.path,
  });
  if (parsed.success) put(key("selection", project), parsed.data);
}
