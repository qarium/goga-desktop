import type { Run } from "../shared/types";
import { dashboardRecoveryAllowed } from "../shared/dashboard-connection";
export function dashboardReady(run: Run) {
  return (
    dashboardRecoveryAllowed(run) &&
    run.kind !== "build" &&
    run.status === "running" &&
    !!run.url &&
    (run.dashboardOpened === true || run.dashboardOpened === undefined)
  );
}

/** Matches the recovery afforded by the run output view; this never starts a process. */
export function canRestoreRunDashboard(run: Run, viewError?: string) {
  return (
    run.status === "running" &&
    run.recovery !== "unverified" &&
    run.dashboardRecoveryVersion === 1 &&
    run.kind !== "build" &&
    (!dashboardReady(run) || !!viewError)
  );
}
