import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import { gitRevisionSchema } from "./git-workspace";
export const gitUpdateStrategySchema = z.enum([
  "merge",
  "rebase",
  "ff-else-merge",
  "ff-else-rebase",
]);
export type GitUpdateStrategy = z.infer<typeof gitUpdateStrategySchema>;
export const gitUpdateHandoffRequestSchema = z
  .object({
    scope: scopeRefSchema,
    revision: gitRevisionSchema,
    candidateId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type GitUpdateHandoffRequest = z.infer<
  typeof gitUpdateHandoffRequestSchema
>;
/** Display/read eligibility only. This candidate never authorizes a Git write. */
export interface GitUpdateHandoffCandidate {
  candidateId: string;
  scope: ScopeRef;
  root: string;
  targetBranch: string;
  targetHead: string;
  sourceRef: string;
  sourceOid: string;
  baseRef: string;
  strategy: GitUpdateStrategy;
  algorithm: "merge" | "rebase";
  conflicts: string[];
  expiresAt: number;
}

export const gitUpdateHandoffTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export interface GitUpdateHandoffPreview {
  token: string;
  candidate: GitUpdateHandoffCandidate;
  hooks: "disabled";
  publishes: false;
  effects: string;
  expiresAt: number;
}
export interface GitUpdateHandoffResult {
  scope: ScopeRef;
  root: string;
  algorithm: "merge" | "rebase";
  status: "conflict" | "error" | "uncertain";
  changed: boolean;
  conflicts: string[];
  message: string;
  log: string;
}
