/** Observable facts, not a claim that native Git is a filesystem transaction. */
export type NativeGitOperation =
  | "merge"
  | "rebase"
  | "cherry-pick"
  | "revert"
  | "commit"
  | "discard"
  | "resolve"
  | "branch"
  | "switch"
  | "fetch"
  | "pull";
export type NativeGitJournalState =
  | "prepared"
  | "running"
  | "conflicts"
  | "stopped"
  | "completed"
  | "rejected"
  | "uncertain";
export interface NativeGitOperationResult {
  operationId: string;
  outcome: "completed" | "conflicts" | "stopped" | "rejected" | "uncertain";
  exitCode: number | null;
  signal: string | null;
  beforeHead: string | null;
  afterHead: string | null;
  conflicts: string[];
  verifiedUnrelatedData: boolean;
  processSettled: boolean;
  recovery: "retained" | "removed" | "unknown";
  /** Host-issued storage path; never accepted as a write destination from IPC. */
  recoveryPath?: string;
}
