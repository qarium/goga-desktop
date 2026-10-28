import type { ScopeRef } from "./context";
import type { NativeGitOperationResult } from "./git-native-operation";
/** Native facts replace the legacy manual object/index/ref publication flags. */
export interface NativeSequenceAPIResult {
  scope: ScopeRef;
  operation: "rebase" | "cherry-pick" | "revert";
  action: "continue" | "abort";
  status: "success" | "conflict" | "error" | "uncertain";
  changed: boolean;
  lockRetained: boolean;
  retainedLocks: string[];
  uncheckedLocks: string[];
  native: NativeGitOperationResult;
  recoveryPath?: string;
  message: string;
  log: string;
}
