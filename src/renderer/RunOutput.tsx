import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { memo, useLayoutEffect, useRef, useState } from "react";
import type { Run } from "../shared/types";
import { runFailureMessage } from "../shared/run-failure";
import "./RunOutput.css";
import { useRunJournal } from "./useRunJournal";

export function TerminalIcon() {
  useLocale();
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="m5 7 4 5-4 5m8 0h6" />
    </svg>
  );
}

export {dashboardReady} from "./run-dashboard-state";
import {dashboardReady,canRestoreRunDashboard} from "./run-dashboard-state";

// Output is already bounded, sanitized and throttled by the host. Keep it as
// one text node: never interpret HTML, terminal commands, links or ANSI markup.
const OutputText = memo(function OutputText({
  text,
  live,
}: {
  text: string;
  live: boolean;
}) {
  useLocale();
  const viewport = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useLayoutEffect(() => {
    if (following.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [text]);
  return (
    <div
      className="run-output-viewport"
      ref={viewport}
      onScroll={(event) => {
        const element = event.currentTarget;
        following.current =
          element.scrollHeight - element.clientHeight - element.scrollTop <= 32;
      }}
    >
      <pre
        className="run-output-text"
        aria-label={tr("launch.runOutputLines")}
        tabIndex={0}
      >
        {text}
      </pre>
      {!text && (
        <p className="run-output-empty">
          {live
            ? tr("launch.noNewMessagesYetOutputAppearsHereAs")
            : tr("launch.noSavedMessages")}
        </p>
      )}
    </div>
  );
});

export function RunOutput({
  run,
  viewError,
  onRestore,
}: {
  run: Run;
  viewError?: string;
  onRestore?: () => Promise<void>;
}) {
  useLocale();
  const [restoring, setRestoring] = useState(false);
  const restoreFlight = useRef(false);
  const [restoreError, setRestoreError] = useState("");
  async function restore() {
    if (restoreFlight.current || !onRestore) return;
    restoreFlight.current = true;
    setRestoring(true);
    setRestoreError("");
    try {
      await onRestore();
    } catch {
      setRestoreError(
        tr("launch.theDashboardCouldNotBeRestoredTheProcess"),
      );
    } finally {
      restoreFlight.current = false;
      setRestoring(false);
    }
  }
  const journal = useRunJournal(run);
  const isBuild = run.kind === "build";
  const unverified = run.recovery === "unverified";
  const confirmed = run.recovery === "confirmed";
  const active =
    !unverified && (run.status === "starting" || run.status === "running");
  const ready = dashboardReady(run);
  const failure = viewError || (run.failureReason ? runFailureMessage(run.failureReason) : run.error);
  const title = unverified
    ? tr("launch.processStateHasNotBeenVerifiedSinceRestart")
    : viewError
      ? tr("launch.pipelineDashboardUnavailable")
      : run.status === "failed" || (active && !!failure)
        ? tr("launch.couldNotLaunch")
        : run.status === "exited"
          ? tr("launch.processFinished")
          : run.status === "stopped"
            ? tr("launch.runStopped")
            : confirmed
              ? tr("launch.processVerifiedAfterRestart")
              : isBuild
                ? tr("launch.buildRunning")
                : tr("launch.preparingRun2");
  return (
    <section className="run-output-page" aria-label={tr("launch.outputLog")}>
      {run.syncPending && (
        <p className="run-output-note" role="status">{tr("launch.commitSyncIsPendingThisIsSeparateFrom")}</p>
      )}
      {run.persistenceError && (
        <p className="error" role="alert">{tr("launch.runHistoryWasNotFullySaved")}{run.persistenceError}{tr("launch.keepTheAppOpenUntilTheHistoryIs")}</p>
      )}
      {(!ready || failure) && (
        <div className="run-output-hero">
          <div
            className={`run-output-symbol ${failure ? "has-error" : ""}`}
            aria-hidden="true"
          >
            {active && !confirmed && !failure ? (
              <svg
                className="run-output-spinner"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M21 12a9 9 0 1 1-9-9" />
              </svg>
            ) : (
              <TerminalIcon />
            )}
          </div>
          <div>
            <h2>{title}</h2>
            <p className={failure ? "error" : ""}>
              {unverified
                ? tr("launch.theLastOutputWasSavedDesktopCannotConfirm")
                : failure ||
                  run.dashboardMessage ||
                  (confirmed
                    ? tr("launch.theOriginalOutputAndDashboardCouldNotBe")
                    : active
                      ? tr("launch.value1OutputAppearsBelowAsItArrives", { value1: run.update ? tr("launch.launchingWithAnImageUpdate") : tr("launch.standardLaunch") })
                      : tr("launch.outputFromThisRunIsSavedBelow"))}
            </p>
            {onRestore && canRestoreRunDashboard(run,viewError) && (
                <div className="run-output-reconnect">
                  <button
                    type="button"
                    disabled={restoring}
                    aria-busy={restoring}
                    onClick={() => void restore()}
                  >
                    {restoring ? tr("launch.connectingDashboard") : tr("launch.restoreDashboard")}
                  </button>
                  {restoreError && (
                    <p className="error" role="alert">
                      {restoreError}
                    </p>
                  )}
                </div>
              )}
            {active && !confirmed && !failure && !ready && !isBuild && (
              <p className="run-output-budget">{tr("launch.maximumTimeToOpenTheDashboard")}{" "}
                {(run.startupTimeoutMs ?? 600_000) / 60_000}{tr("launch.min")}</p>
            )}
          </div>
        </div>
      )}
      <section
        id="run-output-journal"
        className="run-output-journal"
        aria-label={tr("launch.runOutput")}
      >
        <header className="run-output-header">
          <TerminalIcon />
          <h3>{tr("launch.output")}</h3>
        </header>
        {journal.error && <p role="alert" className="run-output-note">{tr("launch.couldNotLoadOutput")}<button onClick={journal.retry}>{tr("launch.retryLoadingLog")}</button>
        </p>}
        {journal.loading ? <p className="run-output-note" role="status">{tr("launch.loadingLog")}</p> :
          (!journal.error || journal.output) && <OutputText text={journal.output?.text ?? ""} live={active && !confirmed} />}
        <footer className="run-output-footer">
          <span>
            {active && !confirmed ? tr("launch.liveOutput") : tr("launch.savedOutput")}
          </span>
          <span>{tr("launch.logForThisTab")}</span>
        </footer>
      </section>
      {journal.output?.truncated && (
        <p className="run-output-note">{tr("launch.someOutputWasRemovedOrHiddenDueTo")}</p>
      )}
      <p className="run-output-note">{tr("launch.knownSecretsAreHiddenOtherSecretsMayStill")}</p>
      <p className="run-output-hint">
        {confirmed
          ? tr("launch.theSavedLogIsNotALiveOutput")
          : isBuild
            ? tr("launch.buildOutputIsAvailableDuringAndAfterExecution")
            : ready && !failure
              ? tr("launch.clickRunningAgainToReturnToTheDashboard")
              : active && !failure
                ? tr("launch.theDashboardWillOpenAutomaticallyWhenReadyNo")
                : tr("launch.theRunWillNotRestartAutomatically")}
      </p>
    </section>
  );
}
