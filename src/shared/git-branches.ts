import type { NativeGitOperationResult } from "./git-native-operation";
import { z } from "zod";
import { gitRevisionSchema, type GitWorkspaceSnapshot } from "./git-workspace";
export const gitBranchProjectSchema = z.string().min(1).max(256);
const name = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) => !v.startsWith("-") && !/[\x00-\x20\x7f]/.test(v),
    "Недопустимое имя ветки.",
  );
const base = { projectId: gitBranchProjectSchema, revision: gitRevisionSchema };
export const gitBranchRequestSchema = z.discriminatedUnion("action", [
  z
    .object({ ...base, action: z.literal("create"), name, switch: z.boolean() })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("switch-local"),
      ref: name.refine((v) => v.startsWith("refs/heads/") && v.length > 11),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("switch-remote"),
      ref: name.refine((v) => v.startsWith("refs/remotes/") && v.length > 13),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("merge"),
      ref: name.refine((v) =>
        /^(?:refs\/heads\/.+|refs\/remotes\/.+)$/.test(v),
      ),
    })
    .strict(),
  z.object({ ...base, action: z.literal("abort-merge") }).strict(),
  z.object({ ...base, action: z.literal("fetch") }).strict(),
  z.object({ ...base, action: z.literal("pull") }).strict(),
]);
export const gitBranchTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type GitBranchRequest = z.infer<typeof gitBranchRequestSchema>;
export interface GitBranchRef {
  ref: string;
  name: string;
  oid: string;
  upstream: string | null;
  checkedOut: boolean;
}
export interface GitBranchInventory {
  projectId: string;
  root: string;
  revision: string;
  head: string | null;
  branch: string | null;
  upstream: string | null;
  dirty: boolean;
  operation: GitWorkspaceSnapshot["operation"];
  local: GitBranchRef[];
  remote: GitBranchRef[];
}
export interface GitBranchPreview {
  token: string;
  projectId: string;
  root: string;
  action: GitBranchRequest["action"];
  fromRef: string | null;
  fromOid: string | null;
  /** Exact selected source; for pull this is the verified remote-tracking upstream. */
  sourceRef: string | null;
  /** Exact incoming commit; external pending merges need not have a named ref. */
  sourceOid?: string | null;
  mergeMode?: "ff-or-commit" | "abort";
  /** Merge automatically creates a commit when a fast-forward is impossible. */
  autoCommit?: boolean;
  toRef: string | null;
  toOid: string | null;
  remote: string | null;
  createsBranch: boolean;
  switchesBranch: boolean;
  hooks: "disabled";
  expiresAt: number;
}
export interface GitBranchResult {
  native?: NativeGitOperationResult;
  projectId: string;
  action: GitBranchRequest["action"];
  status: "success" | "error" | "uncertain" | "conflict";
  conflictCount?: number;
  nativeWarning?: boolean;
  retainedLocks?: string[];
  /** Lock presence/ownership could not be checked; not known absent or retained. */
  uncheckedLocks?: string[];
  /** recoveryPath is last known; its current presence could not be checked. */
  recoveryUnverified?: boolean;
  lockRetained?: boolean;
  recoveryPath?: string;
  changed: boolean;
  message: string;
  log: string;
}
