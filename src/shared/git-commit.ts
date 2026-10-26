import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import { gitFilePathSchema, gitRevisionSchema } from "./git-workspace";
export const gitCommitRequestSchema = z
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
        (paths) => paths.reduce((size, p) => size + p.length, 0) <= 256 * 1024,
        "Слишком много путей.",
      ),
    message: z
      .string()
      .min(1)
      .max(16384)
      .refine(
        (value) => !!value.trim() && !value.includes("\0"),
        "Введите сообщение коммита.",
      ),
  })
  .strict();
export const gitCommitTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type GitCommitRequest = z.infer<typeof gitCommitRequestSchema>;
export interface GitCommitPreview {
  token: string;
  scope: ScopeRef;
  root: string;
  branch: string | null;
  paths: string[];
  deletedCount: number;
  message: string;
  wholeFiles: true;
  author: string;
  committer: string;
  signing: boolean;
  hooks: "disabled";
  expiresAt: number;
}
export interface GitCommitResult {
  scope: ScopeRef;
  status: "committed" | "not-committed" | "uncertain";
  commit?: string;
  message: string;
  log: string;
  indexPublished: boolean;
  recoveryPath?: string;
}
