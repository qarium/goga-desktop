export type ProjectDocumentTarget =
  | { kind: "config" }
  | { kind: "tool"; tool: string; path: string }
  | { kind: "workflow"; name: string }
  | { kind: "pipeline"; name: string }
  | { kind: "profile"; name: string };
export interface ProjectDocument {
  text: string;
  version: string;
  relativePath: string;
  exists: boolean;
}
export interface ProjectToolEntry {
  path: string;
  kind: "directory" | "file";
  editable: boolean;
  reason?: string;
}
export interface ProjectTool {
  name: string;
  entries: ProjectToolEntry[];
}

// Kept platform-independent so IPC and filesystem/catalog validation cannot drift.
export const PROJECT_TOOL_NAME_MAX_LENGTH = 255;
export const PROJECT_TOOL_PATH_MAX_LENGTH = 4096;

export function isProjectToolName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= PROJECT_TOOL_NAME_MAX_LENGTH &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  );
}

export function isProjectToolPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= PROJECT_TOOL_PATH_MAX_LENGTH &&
    !/[\\\x00-\x1f\x7f-\x9f]/.test(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export interface ProjectWorkflow {
  name: string;
  path: string;
  editable: boolean;
  reason?: string;
}

/** Desktop launch safeName contract, plus portable filename and text safety. */
export function isProjectWorkflowName(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 180 ||
    value.startsWith("-") ||
    value.includes("..") ||
    /[\/\\\s\x00-\x20\x7f-\x9f]/.test(value)
  )
    return false;
  // Reject unpaired surrogates rather than silently replacing filename characters.
  try {
    encodeURIComponent(value);
  } catch {
    return false;
  }
  return new TextEncoder().encode(value + ".yml").length <= 255;
}

/** Comparison only: retain the original name for paths and launch arguments. */
export function projectWorkflowAliasKey(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** Flat raw project pipeline source, never an installed/home definition. */
export interface ProjectPipeline extends ProjectWorkflow {}

/** Pipeline namespaces (tool:name) use the same safe basename grammar. */
export const isProjectPipelineName = isProjectWorkflowName;
export const projectPipelineAliasKey = projectWorkflowAliasKey;

/** Same filename grammar as Goga resolve_profile and personal profile settings. */
export function isProjectProfileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 180 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
  );
}
export interface ProjectProfile extends ProjectWorkflow {}
