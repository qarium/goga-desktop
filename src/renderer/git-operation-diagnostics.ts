import { t as msg } from "../shared/i18n";
/** Preserve facts separately: unchecked locks are not known retained or absent. */
interface GitDiagnostics {
  status: string;
  message: string;
  log: string;
  commit?: string;
  nativeWarning?: boolean;
  lockRetained?: boolean;
  retainedLocks?: string[];
  uncheckedLocks?: string[];
  recoveryPath?: string;
  recoveryUnverified?: boolean;
}
export const hasGitDiagnostics = (value: GitDiagnostics) =>
  value.status !== "success" ||
  !!value.nativeWarning ||
  !!value.lockRetained ||
  !!value.retainedLocks?.length ||
  !!value.uncheckedLocks?.length ||
  !!value.recoveryPath ||
  !!value.recoveryUnverified;
export function formatGitDiagnostics(value: GitDiagnostics): string {
  return [
    value.message,
    value.commit && msg("git.commit", { commit: String(value.commit) }),
    value.log,
    value.nativeWarning &&
      msg("git.gitReportedAWarningCheckTheLogAndWorkingCopy"),
    value.recoveryPath && msg("git.recoveryFiles", { recoveryPath: String(value.recoveryPath) }),
    value.recoveryUnverified &&
      msg("git.recoveryFilesWereNotVerifiedThePathIsBasedOn"),
    value.lockRetained &&
      msg("git.theLockWasRetainedDoNotRemoveItWithoutChecking"),
    value.retainedLocks?.length &&
      msg("git.retainedLocks", { value1: String(value.retainedLocks.join(", ")) }),
    value.uncheckedLocks?.length &&
      msg("git.unverifiedLocksTheirPresenceAndOwnershipAreUnconfirmed", { value1: String(value.uncheckedLocks.join(", ")) }),
    value.status === "uncertain" &&
      msg("git.outcomeUnknownCheckTheGitStateTheResponseDoesNot"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
