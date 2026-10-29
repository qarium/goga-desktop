import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import { gitFilePathSchema, gitRevisionSchema } from "./git-workspace";
export const gitDiscardRequestSchema = z
  .object({
    scope: scopeRefSchema,
    revision: gitRevisionSchema,
    paths: z
      .array(gitFilePathSchema)
      .min(1)
      .max(1000)
      .refine(
        (paths) => new Set(paths).size === paths.length,
        "Пути не должны повторяться.",
      )
      .refine(
        (paths) => paths.reduce((sum, p) => sum + p.length, 0) <= 256 * 1024,
        "Слишком много путей.",
      ),
  })
  .strict();
export const gitDiscardTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type GitDiscardRequest = z.infer<typeof gitDiscardRequestSchema>;
export interface GitDiscardPreview {
  token: string;
  scope: ScopeRef;
  root: string;
  branch: string | null;
  head: string | null;
  /** Includes both endpoints of an approved rename. */
  paths: string[];
  items: { path: string; action: "restore" | "trash" }[];
  expiresAt: number;
  recoveryMessage?: string;
}
export interface GitDiscardResult {
  scope: ScopeRef;
  status: "discarded" | "not-discarded" | "uncertain";
  changedPaths: string[];
  trashedPaths: string[];
  indexPublished: boolean;
  /** Worktree phase completed on success (also true for an already-absent path),
   * or at least one worktree mutation occurred before a partial failure. */
  worktreePublished: boolean;
  message: string;
  log: string;
  recoveryPath?: string;
}

/** Read-only, owner-scoped assessment. It grants no write authority. */
export interface GitDiscardRecovery {
  scope: ScopeRef;
  revision: string;
  state: "clear" | "unchanged" | "partial" | "blocked";
  message: string;
  paths: { path: string; state: "unchanged" | "restored" | "changed" }[];
}
export const gitDiscardRecoveryRequestSchema = z
  .object({ scope: scopeRefSchema, revision: gitRevisionSchema })
  .strict();
export type GitDiscardRecoveryRequest = z.infer<
  typeof gitDiscardRecoveryRequestSchema
>;
export interface GitDiscardRecoveryPreview {
  token: string;
  scope: ScopeRef;
  root: string;
  revision: string;
  paths: GitDiscardRecovery["paths"];
  message: string;
  expiresAt: number;
}
export interface GitDiscardRecoveryResult {
  scope: ScopeRef;
  status: "recovered";
  message: string;
}
