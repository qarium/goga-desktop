import { HintButton } from "./ActionHint";
import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { ScopeRef } from "../shared/context";
import type {
  ClearRunHistoryRequest,
  ClearRunHistoryResult,
} from "../shared/run-history";
import type { RunKind, RunWithContext } from "./topic-context";
import { TopicModal } from "./TopicsCommon";
import { preparationErrorMessage } from "./preparation-error";
import { useViewActive } from "./RetainedViews";

export function RunHistoryClear({
  scope,
  kind,
  runs,
  label,
  clear,
}: {
  scope: ScopeRef;
  kind: RunKind;
  runs: RunWithContext[];
  label: string;
  clear: (request: ClearRunHistoryRequest) => Promise<ClearRunHistoryResult>;
}) {
  useLocale();
  const [confirmedIds, setConfirmedIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const active = useViewActive(),
    mounted = useRef(false),
    flight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) setConfirmedIds(null);
  }, [active]);
  const eligible = runs.filter(
    (run) =>
      ["exited", "failed", "stopped"].includes(run.status) &&
      !run.syncPending &&
      run.recovery !== "unverified",
  );
  async function submit() {
    if (!confirmedIds?.length || flight.current) return;
    flight.current = true;
    const runIds = confirmedIds;
    setConfirmedIds(null);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await clear({ scope, kind, runIds });
      if (!mounted.current) return;
      setMessage(
        tr("launch.recordsRemovedLength", { length: result.removedRunIds.length }) +
          (result.retained.length
            ? tr("launch.recordsKeptLengthCompletionOrSyncHasNot", { length: result.retained.length })
            : ""),
      );
    } catch (failure) {
      if (mounted.current) setError(preparationErrorMessage(failure));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <HintButton
        type="button"
        disabled={busy || !eligible.length}
        hint={
          !eligible.length &&
          runs.some((run) => run.syncPending || run.recovery === "unverified")
            ? tr("launch.someRecordsAreStillNeededToVerifyProcesses")
            : !eligible.length
              ? tr("launch.noCompletedRecordsToClear")
              : tr("launch.removeCompletedRecordsInTheSelectedSection")
        }
        onClick={() => {
          setError("");
          setMessage("");
          setConfirmedIds(eligible.map((run) => run.id));
        }}
      >
        <Trash2 size={16} aria-hidden="true" />{tr("launch.clearHistory")}</HintButton>
      {(busy || error || message) && (
        <span
          className="run-history-feedback"
          role={error ? "alert" : "status"}
        >
          {busy ? (
            <>
              <span className="loading-spinner" aria-hidden="true" />{tr("launch.clearingHistory")}</>
          ) : (
            error || message
          )}
        </span>
      )}
      {confirmedIds && (
        <TopicModal
          title={tr("launch.clearValue1History", { value1: kind === "pipeline" ? tr("launch.pipeline2") : tr("launch.build2") })}
          className="run-history-clear-dialog"
          onClose={() => setConfirmedIds(null)}
          closeLabel={tr("launch.closeClearHistoryConfirmation")}
        >
          <div className="run-history-clear-body">
            <p className="hint">{label}</p>
            <p>
              <strong>{tr("launch.recordsToRemove")}{confirmedIds.length}</strong>
            </p>
            <p>{tr("launch.onlyCompletedDesktopHistoryEntriesWillBeRemoved")}</p>
            <p className="hint">{tr("launch.activeRunsAndAttachedDashboardsWillRemain")}</p>
          </div>
          <footer className="form-actions">
            <button type="button" onClick={() => setConfirmedIds(null)}>{tr("launch.cancel")}</button>
            <button
              type="button"
              className="danger"
              onClick={() => void submit()}
            >{tr("launch.clearHistory2")}</button>
          </footer>
        </TopicModal>
      )}
    </>
  );
}
