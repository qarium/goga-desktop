import { topicContextRefSchema, type TopicContextRef } from "./worktrees";
import {
  isProjectToolName,
  isProjectProfileName,
  isProjectToolPath,
  isProjectWorkflowName,
  type ProjectDocumentTarget,
} from "./project-documents";
export type DeletableDocument =
  | {
      scope: "project";
      context?: TopicContextRef;
      projectId: string;
      target: Exclude<ProjectDocumentTarget, { kind: "config" | "dockerfile" }>;
    }
  | { scope: "home"; kind: "profile"; name: string };
export interface DeletionTicket {
  token: string;
  name: string;
  relativePath: string;
  profileFallback?: boolean;
}
export type DeletionResult =
  | { status: "trashed" }
  | { status: "not-trashed" | "uncertain"; message: string };
export type TrashItem = (absolutePath: string) => Promise<void>;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  Object.keys(v).length === expected.length &&
  expected.every((k) => Object.hasOwn(v, k));
export const isPersonalProfileName = isProjectProfileName;
/** Used at both IPC and direct host boundaries: never accept caller filesystem paths. */
export function isDeletableDocument(v: unknown): v is DeletableDocument {
  if (!record(v)) return false;
  if (v.scope === "home")
    return (
      keys(v, ["scope", "kind", "name"]) &&
      v.kind === "profile" &&
      isPersonalProfileName(v.name)
    );
  if (
    v.scope !== "project" ||
    !(
      keys(v, ["scope", "projectId", "target"]) ||
      (keys(v, ["scope", "projectId", "target", "context"]) &&
        topicContextRefSchema.safeParse(v.context).success)
    ) ||
    typeof v.projectId !== "string" ||
    !v.projectId ||
    v.projectId.length > 256 ||
    !record(v.target)
  )
    return false;
  const t = v.target;
  if (t.kind === "profile")
    return keys(t, ["kind", "name"]) && isProjectProfileName(t.name);
  if (t.kind === "workflow" || t.kind === "pipeline")
    return keys(t, ["kind", "name"]) && isProjectWorkflowName(t.name);
  return (
    t.kind === "tool" &&
    keys(t, ["kind", "tool", "path"]) &&
    isProjectToolName(t.tool) &&
    isProjectToolPath(t.path) &&
    /\.ya?ml$/.test(t.path)
  );
}
export const isDeletionVersion = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const isDeletionToken = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    v,
  );
