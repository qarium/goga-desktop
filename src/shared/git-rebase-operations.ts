import type { NativeGitOperationResult } from "./git-native-operation";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import { gitRevisionSchema } from "./git-workspace";
/** Operation-specific abort and bounded resolved linear merge/apply continuation. */
export const gitRebaseOperationRequestSchema = z
  .object({
    scope: scopeRefSchema,
    revision: gitRevisionSchema,
    action: z.enum(["abort", "continue"]),
  })
  .strict();
export const gitRebaseOperationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type GitRebaseOperationRequest = z.infer<
  typeof gitRebaseOperationRequestSchema
>;
export interface GitRebaseOperationPreview {
  token: string;
  scope: ScopeRef;
  root: string;
  operation: "rebase";
  backend: "merge" | "apply";
  action: "abort" | "continue";
  branch: string;
  head: string;
  original: string;
  paths: string[];
  /** Exact conflict paths with staged or manual resolutions discarded by abort. */
  discardedResolutionPaths?: string[];
  hooks: "disabled";
  effects: string;
  expiresAt: number;
}
export interface GitRebaseOperationResult {
  scope: ScopeRef;
  operation: "rebase";
  action: "abort" | "continue";
  status: "success" | "conflict" | "error" | "uncertain";
  /** True also when native worktree writes may have occurred but cannot be verified. */
  changed: boolean;
  native?: NativeGitOperationResult;
  mutationStarted?: boolean;
  worktreeRestored?: boolean;
  indexPublished?: boolean;
  headPublished?: boolean;
  metadataCleared?: boolean;
  /** Continuation facts; count includes partial object promotion before failure. */
  /** Complete object-promotion step, not a claim of zero writes when false. */
  objectsPublished?: boolean;
  /** Source object files created, including a file whose write/fsync failed. */
  publishedObjectCount?: number;
  branchPublished?: boolean;
  metadataPublished?: boolean;
  worktreeUpdated?: boolean;
  recoveryStatus?: "not-created" | "retained" | "missing" | "unverified";
  /** Issued only when the owned directory and captured backup bytes are present. */
  recoveryPath?: string;
  /** Diagnostic location only: never authority to find, restore or remove files. */
  lastKnownRecoveryPath?: string;
  lockRetained?: boolean;
  retainedLocks?: string[];
  uncheckedLocks?: string[];
  message: string;
  log: string;
}
