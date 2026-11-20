import { t as msg } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import { useState } from "react";
import type {
  OverviewPasteConflict,
  OverviewPasteDecision,
} from "../../shared/project-overview";
import { TopicModal } from "../TopicsCommon";
export function PasteConflictDialog({
  conflicts,
  blocked,
  onConfirm,
  onCancel,
}: {
  conflicts: OverviewPasteConflict[];
  blocked: (path: string) => boolean;
  onConfirm: (decisions: OverviewPasteDecision[]) => void;
  onCancel: () => void;
}) {
  useLocale();
  const [decisions, setDecisions] = useState<OverviewPasteDecision[]>([]);
  const [all, setAll] = useState(false);
  const remaining = conflicts.filter(
    (c) => !decisions.some((d) => d.path === c.path),
  );
  const current = remaining[0];
  const dirty = blocked(current.path);
  const choose = (action: OverviewPasteDecision["action"]) => {
    const targets = all
      ? remaining.filter(
          (c) => action === "skip" || (c.replaceable && !blocked(c.path)),
        )
      : [current];
    const next = [
      ...decisions,
      ...targets.map((c) => ({ path: c.path, action })),
    ];
    if (next.length === conflicts.length) onConfirm(next);
    else setDecisions(next);
  };
  return (
    <TopicModal
      title={msg("overview.fileAlreadyExists")}
      closeLabel={msg("overview.closePasteConfirmation")}
      className="ov-paste-dialog"
      onClose={onCancel}
    >
      <div className="ov-paste-text">
        <div className="ov-paste-intro">
          <p>{msg("overview.anItemWithThisNameAlreadyExistsInTheDestination")}</p>
          <p className="ov-paste-conflict-path">
            <strong>{current.path}</strong>
          </p>
        </div>
        <p className="ov-hint">{msg("overview.pasteConflictsRemaining", { count: remaining.length })}</p>
        {dirty ? (
          <p role="status">{msg("overview.thisFileHasUnsavedChangesOrIsBeingSavedYou")}</p>
        ) : !current.replaceable ? (
          <p role="status">{msg("overview.thisItemCannotBeSafelyReplacedWithAFileOf")}</p>
        ) : (
          <p>{msg("overview.replaceTheExistingFileWithTheCopiedFile")}</p>
        )}
      </div>
      <label className="ov-paste-apply-all">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />{msg("overview.applyToAll")}</label>
      <footer>
        <button onClick={onCancel}>{msg("overview.cancelPaste")}</button>
        <button onClick={() => choose("skip")}>{msg("overview.skip")}</button>
        <button
          className="primary"
          disabled={!current.replaceable || dirty}
          onClick={() => choose("replace")}
        >{msg("overview.replace")}</button>
      </footer>
    </TopicModal>
  );
}
