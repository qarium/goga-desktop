import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import { gitFilePathSchema, gitRevisionSchema } from "./git-workspace";

const text = z
  .string()
  .max(1024 * 1024)
  .refine(
    (value) =>
      !value.includes("\0") &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
        value,
      ) &&
      new TextEncoder().encode(value).length <= 1024 * 1024,
    "Поддерживается точный текст UTF-8 размером не более 1 МиБ.",
  );
export const gitConflictResolutionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text }).strict(),
  z.object({ kind: z.literal("current") }).strict(),
  z.object({ kind: z.literal("incoming") }).strict(),
  z.object({ kind: z.literal("delete") }).strict(),
]);
export const gitConflictSaveRequestSchema = z
  .object({
    scope: scopeRefSchema,
    path: gitFilePathSchema,
    revision: gitRevisionSchema,
    fingerprint: gitRevisionSchema,
    resolution: gitConflictResolutionSchema,
  })
  .strict();
export const gitConflictSaveTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type GitConflictResolution = z.infer<typeof gitConflictResolutionSchema>;
export type GitConflictSaveRequest = z.infer<
  typeof gitConflictSaveRequestSchema
>;
export interface GitConflictSavePreview {
  token: string;
  scope: ScopeRef;
  path: string;
  branch: string | null;
  resolution: GitConflictResolution["kind"];
  bytes: number;
  expiresAt: number;
  hooks: "disabled";
  canonicalization: "git-text-attributes";
}
export interface GitConflictSaveResult {
  scope: ScopeRef;
  path: string;
  status: "saved" | "not-saved" | "partial" | "uncertain";
  worktreePublished: boolean;
  indexPublished: boolean;
  recoveryPath?: string;
  lockRetained: boolean;
  message: string;
  log: string;
}
