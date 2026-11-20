import { t } from "../shared/i18n";
import { execFile } from "node:child_process";
import path from "node:path";
import {
  LegacyDesktopStateLockError,
  recoverLegacyDesktopStateLock,
  type LegacyLockInspection,
  type LegacyLockSnapshot,
} from "../host/desktop-state-lock";

/** No shell or inherited environment. A diagnostic error is NOT proof of no owner. */
export function inspectLegacyDesktopLock(
  file: string,
): Promise<LegacyLockInspection> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file)
    return Promise.resolve("unknown");
  return new Promise((resolve) => {
    execFile(
      "/usr/sbin/lsof",
      ["-n", "-P", "-t", "+w", "--", file],
      {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 128 * 1024,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      },
      (error, stdout, stderr) => {
        // -t implies -w; +w AFTER -t restores incomplete-scan warnings.
        if (stderr || error?.killed || error?.signal) return resolve("unknown");
        const pids = stdout.trim();
        if (
          !error &&
          pids &&
          pids.split(/\s+/).every((pid) => /^[1-9][0-9]*$/.test(pid))
        )
          return resolve("busy");
        if (error?.code === 1 && stdout === "") return resolve("free");
        resolve("unknown");
      },
    );
  });
}
export async function handleDesktopStartupFailure(
  error: unknown,
  d: {
    confirmRecovery: () => Promise<boolean>;
    recover?: (snapshot: LegacyLockSnapshot) => Promise<string>;
    showError: (message: string) => void;
    relaunch: () => void;
    exit: (code: number) => void;
  },
): Promise<void> {
  if (!(error instanceof LegacyDesktopStateLockError)) {
    try {
      d.showError(
        t("native.startupFailed", { reason: error instanceof Error ? error.message : t("native.unknownError") }),
      );
    } finally {
      d.exit(1);
    }
    return;
  }
  try {
    if (!(await d.confirmRecovery())) {
      d.exit(1);
      return;
    }
    await (
      d.recover ??
      ((snapshot) =>
        recoverLegacyDesktopStateLock(snapshot, inspectLegacyDesktopLock))
    )(error.snapshot);
    // initialize() may already have prepared run recovery before storage failed.
    // Relaunch normally; never retry that partly initialized HostService object.
    d.relaunch();
    d.exit(0);
  } catch {
    try {
      d.showError(
        t("native.recoveryFailed"),
      );
    } finally {
      d.exit(1);
    }
  }
}
