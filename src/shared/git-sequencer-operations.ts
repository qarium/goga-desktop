import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import { gitRevisionSchema } from "./git-workspace";
/** Expected operation is checked against host metadata, never used as authority. */
export const gitSequencerOperationRequestSchema = z
  .object({
    scope: scopeRefSchema,
    revision: gitRevisionSchema,
    operation: z.enum(["cherry-pick", "revert"]),
    action: z.enum(["continue", "abort"]),
  })
  .strict();
export const gitSequencerOperationTokenSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);
export type GitSequencerOperationRequest = z.infer<
  typeof gitSequencerOperationRequestSchema
>;
export interface GitSequencerOperationPreview {
  token: string;
  scope: ScopeRef;
  root: string;
  operation: "cherry-pick" | "revert";
  action: "continue" | "abort";
  branch: string;
  head: string;
  original: string;
  current: string;
  paths: string[];
  discardedResolutionPaths: string[];
  hooks: "disabled";
  effects: string;
  expiresAt: number;
  /** Single revert does not persist whether it was started with --no-commit.
   * Continue must explicitly confirm creation of a commit, including this warning. */
  requiresCommitWarning: boolean;
}

export interface GitSequencerOperationResult {
  scope: ScopeRef;
  operation: "cherry-pick" | "revert";
  action: "continue" | "abort";
  status: "success" | "conflict" | "error" | "uncertain";
  changed: boolean;
  mutationStarted: boolean;
  worktreeRestored: boolean;
  worktreeUpdated: boolean;
  indexPublished: boolean;
  branchPublished: boolean;
  metadataCleared: boolean;
  metadataPublished: boolean;
  objectsPublished: boolean;
  publishedObjectCount: number;
  recoveryStatus: "not-created" | "retained" | "missing" | "unverified";
  recoveryPath?: string;
  lastKnownRecoveryPath?: string;
  lockRetained: boolean;
  retainedLocks: string[];
  uncheckedLocks: string[];
  message: string;
  log: string;
}
