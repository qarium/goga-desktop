import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useEffect, useRef, useState } from "react";
import type { WorktreeRecord } from "../shared/worktrees";
import { TopicModal } from "./TopicsCommon";
/** Migration is an explicit new owned clone, never conversion or removal. */
export function ContextMigration({
  record,
  onMigrated,
}: {
  record: WorktreeRecord;
  onMigrated: (record: WorktreeRecord) => void;
}) {
  useLocale();
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const flight = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function migrate() {
    if (flight.current || !confirm) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await window.goga.migrateTopicContext({
        projectId: record.projectId,
        year: record.year,
        topic: record.topic,
        branch: record.branch,
      });
      if (!mounted.current) return;
      if (next.storageKind !== "clone" || next.state !== "ready")
        throw Error(
          msg("workspace.theStandaloneCloneIsNotReadyThePreviousWorkingCopy"),
        );
      setConfirm(false);
      onMigrated(next);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="context-compatibility"
      aria-label={msg("workspace.workingCopyCompatibility")}
    >
      <p className="topic-warning">{msg("workspace.thisIsALegacyLinkedWorktreeHistoryIsAvailableBut")}</p>
      <button
        type="button"
        disabled={busy || typeof window.goga.migrateTopicContext !== "function"}
        onClick={() => setConfirm(true)}
      >{msg("workspace.createStandaloneClone")}</button>
      {confirm && (
        <TopicModal
          title={msg("workspace.createASeparateStandaloneClone")}
          busy={busy}
          onClose={() => setConfirm(false)}
        >
          <p>{msg("workspace.aSeparateStandaloneCloneWillBeCreatedForTopic")}{record.topic}{msg("workspace.theOldLinkedWorktreeWillNotBeConvertedOrDeleted")}</p>
          <p className="hint">{msg("workspace.thePreviousContextAndDraftsWillBeKeptIfAn")}</p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(false)}
            >{msg("workspace.cancel")}</button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void migrate()}
            >{msg("workspace.confirmCloneCreation")}</button>
          </div>
        </TopicModal>
      )}
    </section>
  );
}
