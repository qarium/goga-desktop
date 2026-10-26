import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import { gitRevisionSchema } from "./git-workspace";
/** This API is deliberately merge-only, never a generic sequencer continuation. */
const common = { scope: scopeRefSchema, revision: gitRevisionSchema };
export const gitMergeOperationRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("continue"),
      message: z
        .string()
        .min(1)
        .max(16384)
        .refine(
          (value) => !!value.trim() && !value.includes("\0"),
          "Введите сообщение коммита.",
        )
        .optional(),
    })
    .strict(),
  z.object({ ...common, action: z.literal("abort") }).strict(),
]);
export const gitMergeOperationTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type GitMergeOperationRequest = z.infer<
  typeof gitMergeOperationRequestSchema
>;
export interface GitMergeOperationPreview {
  token: string;
  scope: ScopeRef;
  root: string;
  operation: "merge";
  action: "continue" | "abort";
  branch: string;
  head: string;
  sourceOid: string;
  /** Current staged merge candidates; execution must prove their provenance. */
  paths: string[];
  effects: string;
  message: string;
  author: string | null;
  committer: string | null;
  signing: boolean;
  hooks: "disabled";
  expiresAt: number;
}
export interface GitMergeOperationResult {
  scope: ScopeRef;
  operation: "merge";
  action: "continue" | "abort";
  status: "success" | "error" | "uncertain";
  changed: boolean;
  commit?: string;
  recoveryPath?: string;
  lockRetained: boolean;
  nativeWarning?: boolean;
  retainedLocks?: string[];
  /** Lock presence/ownership could not be checked; not known absent or retained. */
  uncheckedLocks?: string[];
  /** recoveryPath is last known; its current presence could not be checked. */
  recoveryUnverified?: boolean;
  message: string;
  log: string;
}
