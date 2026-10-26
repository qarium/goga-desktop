import type { ScopeRef } from "./context";
import { gitDiffRequestSchema, type GitDiffRequest } from "./git-workspace";
/** A path/revision read, never a renderer-supplied object or revision expression. */
export const gitConflictReadRequestSchema = gitDiffRequestSchema;
export type GitConflictReadRequest = GitDiffRequest;
export type GitConflictContentKind =
  "text" | "absent" | "binary" | "symlink" | "submodule" | "unavailable";
export interface GitConflictSource {
  readonly oid: string | null;
  readonly mode: string | null;
  readonly kind: GitConflictContentKind;
  /** Exact UTF-8 payload, including BOM, CRLF and missing final newline. */
  readonly text?: string;
  readonly reason?: string;
}
/** UTF-16 half-open offsets, compatible with JavaScript slice and CodeMirror. */
export interface GitConflictRange {
  readonly from: number;
  readonly to: number;
}
export interface GitConflictBlockSource {
  readonly text: string;
  /** Null means ambiguous source position, not the first matching occurrence. */
  readonly range: GitConflictRange | null;
}
export interface GitConflictBlock {
  readonly id: string;
  readonly resultRange: GitConflictRange;
  readonly base: GitConflictBlockSource;
  readonly current: GitConflictBlockSource;
  readonly incoming: GitConflictBlockSource;
}
export type GitConflictGenerated =
  | {
      readonly kind: "text";
      readonly text: string;
      readonly blocks: readonly GitConflictBlock[];
      /** No assertion that the existing working file is this generated document. */
      readonly requiresExplicitReconstruction: true;
    }
  | { readonly kind: "unavailable"; readonly reason: string };
export interface GitConflictDocument {
  readonly scope: ScopeRef;
  readonly path: string;
  readonly revision: string;
  /** Editable documents bind exact owner, HEAD/operation, index/work/stages and
   * effective attributes/config. Revision is a bound display-read nonce, not a
   * whole-worktree write CAS. Unsupported working kinds remain read-only.
   * A fingerprint is never authority without a fresh host prepare/token. */
  readonly fingerprint: string;
  readonly base: GitConflictSource;
  readonly current: GitConflictSource;
  readonly incoming: GitConflictSource;
  readonly working: {
    readonly kind: GitConflictContentKind;
    readonly text?: string;
    readonly reason?: string;
  };
  readonly generated: GitConflictGenerated;
}
