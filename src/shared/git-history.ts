import { z } from "zod";
import { gitFilePathSchema, type GitDiffPart } from "./git-workspace";
import { scopeRefSchema, type ScopeRef } from "./context";

export const gitOidSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export type GitOid = z.infer<typeof gitOidSchema>;
/** Exact public refs only. The host additionally checks its own ref inventory. */
export const gitHistoryRefSchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value === "HEAD" ||
      (/^refs\/(?:heads|remotes)\/.+/.test(value) &&
        !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
        !value.includes("..") &&
        !value.includes("@{") &&
        !value.endsWith(".") &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFFFD/.test(
          value,
        ) &&
        value
          .split("/")
          .every(
            (part) =>
              part !== "" && !part.startsWith(".") && !part.endsWith(".lock"),
          )),
    "Недопустимая ветка просмотра Git.",
  );
export type GitHistoryRef = z.infer<typeof gitHistoryRefSchema>;
export const gitHistoryRequestSchema = z
  .object({
    scope: scopeRefSchema,
    ref: gitHistoryRefSchema,
    tip: gitOidSchema.optional(),
    offset: z.number().int().min(0).max(1_000_000),
  })
  .strict()
  .refine(
    (request) => request.offset === 0 || request.tip !== undefined,
    "Следующая страница требует закреплённого снимка истории.",
  );
export type GitHistoryRequest = z.infer<typeof gitHistoryRequestSchema>;
export interface GitHistoryRefs {
  scope: ScopeRef;
  currentBranch: string | null;
  local: { ref: string; name: string }[];
  remote: { ref: string; name: string }[];
}
export interface GitHistoryCommit {
  oid: GitOid;
  parents: GitOid[];
  subject: string;
  author: string;
  authoredAt: string;
  committedAt: string;
  refs: string[];
}
export interface GitHistoryPage {
  scope: ScopeRef;
  currentBranch: string | null;
  ref: GitHistoryRef;
  tip: GitOid | null;
  commits: GitHistoryCommit[];
  nextOffset: number | null;
}

export const gitCommitReadRequestSchema = z
  .object({
    scope: scopeRefSchema,
    ref: gitHistoryRefSchema,
    tip: gitOidSchema,
    commit: gitOidSchema,
    parentIndex: z.number().int().min(0).max(1023),
    fileOffset: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export const gitCommitDiffRequestSchema = gitCommitReadRequestSchema
  .omit({ fileOffset: true })
  .extend({
    path: gitFilePathSchema,
    originalPath: gitFilePathSchema.optional(),
  })
  .strict();
export type GitCommitReadRequest = z.infer<typeof gitCommitReadRequestSchema>;
export type GitCommitDiffRequest = z.infer<typeof gitCommitDiffRequestSchema>;
export interface GitHistoryFile {
  path: string;
  originalPath?: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}
export interface GitCommitDetails {
  scope: ScopeRef;
  ref: GitHistoryRef;
  tip: GitOid;
  commit: GitHistoryCommit;
  message: string;
  parentIndex: number;
  parent: GitOid | null;
  files: GitHistoryFile[];
  nextFileOffset: number | null;
}
export interface GitCommitDiff {
  scope: ScopeRef;
  tip: GitOid;
  commit: GitOid;
  parent: GitOid | null;
  path: string;
  part: GitDiffPart;
}
