import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";

/** Literal repository-relative UTF-8 paths, not Git pathspec expressions. */
export const gitFilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !value.startsWith("/") &&
      !value.startsWith("\\\\") &&
      !/^[A-Za-z]:/.test(value) &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/.test(
        value,
      ) &&
      value
        .split("/")
        .every(
          (part) =>
            part !== "" &&
            part !== "." &&
            part !== ".." &&
            part.toLowerCase() !== ".git",
        ),
    "Недопустимый путь файла Git.",
  );
/** Read freshness only; this is never authority for a mutation. */
export const gitRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const gitDiffRequestSchema = z
  .object({
    scope: scopeRefSchema,
    path: gitFilePathSchema,
    revision: gitRevisionSchema,
  })
  .strict();
export type GitDiffRequest = z.infer<typeof gitDiffRequestSchema>;
export interface GitWorkspaceFile {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: "tracked" | "untracked" | "conflict";
  submodule: boolean;
}
/** Display only: never a revision or authority for a write. */
export interface GitWorkspaceSummary {
  scope: ScopeRef;
  branch: string | null;
  changedFiles: number;
  conflicts: number;
}
export interface GitWorkspaceSnapshot {
  scope: ScopeRef;
  root: string;
  revision: string;
  head: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  operation: "none" | "merge" | "rebase" | "cherry-pick" | "revert" | "unknown";
  files: GitWorkspaceFile[];
}
export interface GitDiffPart {
  kind: "patch" | "text" | "binary" | "unavailable" | "empty";
  text: string;
}
export interface GitWorkspaceDiff {
  scope: ScopeRef;
  path: string;
  revision: string;
  staged: GitDiffPart;
  unstaged: GitDiffPart;
}
