export interface ContextDeletionPreview {
  token: string;
  switchBranches?: string[];
  switchBranch?: string;
  contextId: string;
  stage: string;
  details: string[];
  clonePath?: string;
  aheadCount?: number;
  requiresAheadConfirmation?: boolean;
}
export interface ContextDeletionResult {
  projectId: string;
  status: "success" | "partial" | "failed";
  message: string;
  stage?: string;
  /** True only after recoverable trash was acknowledged and source disappeared. */
  cloneRemoved?: boolean;
}
