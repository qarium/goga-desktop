export type ContextSyncStatus =
  "new" | "waiting" | "syncing" | "synced" | "error";
export type ContextSyncReason = "manual" | "automatic";
/** Import status never describes the pipeline outcome or integration/deletion safety. */
export interface ContextSyncState {
  projectId: string;
  contextId: string;
  revision: string;
  status: ContextSyncStatus;
  sourceOid?: string;
  importedOid?: string;
  destinationRef?: string;
  operationId?: string;
  error?: string;
  waitingRunIds: string[];
  reasons: ContextSyncReason[];
  updatedAt: string;
}
export interface ContextApplyPreview {
  token: string;
  projectId: string;
  contextId: string;
  revision: string;
  sourceOid: string;
  targetBranch: string;
  targetOid: string;
  canApply: boolean;
  reason?: string;
  files: string[];
}
export interface ContextApplyResult {
  projectId: string;
  contextId: string;
  sourceOid: string;
  targetBranch: string;
  previousTargetOid: string;
  targetOid: string;
}
