import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useRef } from "react";
import type { EditorView } from "@codemirror/view";
import {
  GitConflictCodePane,
  type ConflictPaneAnchor,
} from "./GitConflictCodePane";
import { supportedConflict, type GitConflictsState } from "./useGitConflicts";
import { LoadingState } from "./LoadingBoundary";
import { TopicModal } from "./TopicsCommon";
import "./GitConflictEditor.css";

export function GitConflictEditor({
  conflicts,
}: {
  conflicts: GitConflictsState;
}) {
  useLocale();
  const views = useRef<
    Partial<Record<"current" | "result" | "incoming", EditorView>>
  >({});
  const linkedPositions = useRef(new WeakMap<EditorView, number>());
  const entry = conflicts.entry;
  const sync = (origin: EditorView) => {
    const positions = linkedPositions.current;
    const top = origin.scrollDOM.scrollTop;
    const expected = positions.get(origin);
    positions.delete(origin);
    // Browser scroll events are asynchronous, including clamped programmatic
    // writes. Do not feed those events back into the pane the user is moving.
    if (expected !== undefined && Math.abs(expected - top) < 1) return;
    const maximum =
      origin.scrollDOM.scrollHeight - origin.scrollDOM.clientHeight;
    for (const view of Object.values(views.current)) {
      if (view === origin) continue;
      const targetMaximum =
        view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
      const target =
        maximum > 0 ? (top / maximum) * Math.max(0, targetMaximum) : top;
      if (Math.abs(view.scrollDOM.scrollTop - target) < 1) continue;
      view.scrollDOM.scrollTop = target;
      positions.set(view, view.scrollDOM.scrollTop);
    }
  };
  if (conflicts.loading)
    return (
      <div className="git-conflict-loading">
        <LoadingState label={msg("git.loadingConflict")} />
      </div>
    );
  if (!entry)
    return (
      <div className="git-workspace-empty">{msg("git.couldNotReadConflict")}<button onClick={conflicts.requestReload}>{msg("git.reloadFile")}</button>
      </div>
    );
  const { document: doc, draft } = entry;
  const blocked = conflicts.locked || entry.saved;
  const supported = supportedConflict(doc);
  const anchors = (
    side: "current" | "result" | "incoming",
  ): ConflictPaneAnchor[] =>
    (draft?.blocks ?? []).flatMap((block, i) => {
      const range =
        side === "result"
          ? block.mapped
            ? { from: block.from, to: block.to }
            : null
          : block.source[side].range;
      if (!range) return [];
      return [
        {
          range,
          resolved: !!block.choice,
          actions:
            side === "result"
              ? [
                  ...(["current", "incoming"] as const)
                    .filter((sourceSide) => !block.source[sourceSide].range)
                    .map((sourceSide) => ({
                      label: msg("git.blockAccept", { value1: String(i + 1), value2: String(sourceSide === "current" ? msg("git.current2") : msg("git.incoming")) }),
                      symbol: sourceSide === "current" ? "→" : "←",
                      disabled: blocked || !block.mapped,
                      selected: block.choice === sourceSide,
                      run: () => conflicts.apply(block.id, sourceSide),
                    })),
                  {
                    label: msg("git.blockAcceptBoth", { value1: String(i + 1) }),
                    symbol: "⇉",
                    disabled: blocked || !block.mapped,
                    selected: block.choice === "both",
                    run: () => conflicts.apply(block.id, "both"),
                  },
                  {
                    label: msg("git.blockResolvedManually", { value1: String(i + 1) }),
                    symbol: "✓",
                    disabled: blocked || !block.mapped,
                    selected: block.choice === "manual",
                    run: () => conflicts.manual(block.id),
                  },
                ]
              : [
                  {
                    label: msg("git.blockAccept", { value1: String(i + 1), value2: String(side === "current" ? msg("git.current2") : msg("git.incoming")) }),
                    symbol: side === "current" ? "→" : "←",
                    disabled: blocked || !block.mapped,
                    selected: block.choice === side,
                    run: () => conflicts.apply(block.id, side),
                  },
                ],
        },
      ];
    });
  return (
    <section
      className="git-conflict-editor"
      aria-label={msg("git.resolveConflict", { path: String(doc.path) })}
    >
      <div className="git-conflict-toolbar">
        <strong title={doc.path}>{doc.path}</strong>
        <button
          disabled={blocked || doc.generated.kind !== "text" || !supported}
          onClick={conflicts.requestReconstruct}
        >{msg("git.restoreBlocks")}</button>
        <button disabled={conflicts.locked} onClick={conflicts.requestReload}>{msg("git.reloadFile")}</button>
      </div>
      {supported &&
        draft &&
        !draft.blocks.length &&
        doc.generated.kind === "text" &&
        doc.generated.blocks.length > 0 && (
          <p className="git-conflict-warning" role="note">{msg("git.theWorkingFileDiffersFromTheConflictModelManualEdits")}</p>
        )}
      {!!draft?.blocks.length && (
        <details className="git-conflict-help">
          <summary>{msg("git.howToApplyBlocks")}</summary>
          <p>{msg("git.acceptCurrentAcceptIncomingAcceptBothResolvedManuallyApplyingChanges")}</p>
        </details>
      )}
      {conflicts.stale && (
        <p className="git-conflict-warning" role="note">{msg("git.thisDraftBelongsToAnEarlierGitStateItsText")}</p>
      )}
      {!supported && (
        <p className="git-conflict-warning">{msg("git.writingIsNotSupportedForThisConflictType")}{" "}
          {doc.working.reason ||
            [doc.base, doc.current, doc.incoming, doc.working]
              .filter((s) => !["text", "absent"].includes(s.kind))
              .map((s) => s.reason || s.kind)
              .join("; ")}{msg("git.theFileHasNotBeenMarkedAsResolved")}</p>
      )}
      {draft?.blocks.some((b) => !b.mapped) && (
        <p className="git-conflict-warning">{msg("git.theEditCrossedABlockBoundaryAutomaticResolutionIsUnavailable")}</p>
      )}
      {draft?.blocks.some(
        (b) => !b.source.current.range || !b.source.incoming.range,
      ) && (
        <p className="git-conflict-warning">{msg("git.someOriginalBlockPositionsAreAmbiguousChooseTheCurrentOr")}</p>
      )}
      <div className="git-conflict-panes">
        {(["current", "result", "incoming"] as const).map((side) => {
          const content = side === "result" ? doc.working : doc[side];
          const value = side === "result" ? draft?.text : content.text;
          const label =
            side === "current"
              ? msg("git.currentVersion")
              : side === "incoming"
                ? msg("git.incomingVersion")
                : msg("git.resolutionResult");
          return (
            <section
              key={side}
              className={`git-conflict-pane git-conflict-${side}`}
              aria-label={label}
            >
              <header>
                <strong>{side === "result" ? msg("git.result") : label}</strong>
                <small>
                  {side === "result"
                    ? entry.reconstructed
                      ? msg("git.reconstructedEditable")
                      : msg("git.actualWorkingFile")
                    : msg("git.readOnly")}
                </small>
              </header>
              <div className="git-conflict-code">
                {value !== undefined ? (
                  <GitConflictCodePane
                    label={label}
                    side={side}
                    value={value}
                    readOnly={side !== "result" || blocked || !supported}
                    memory={entry.memory[side]}
                    externalChange={
                      side === "result" ? entry.editorChange : undefined
                    }
                    onExternalChangeRejected={conflicts.rejectEditorChange}
                    anchors={anchors(side)}
                    onEdit={side === "result" ? conflicts.edit : undefined}
                    onView={(view) => {
                      if (view) views.current[side] = view;
                      else delete views.current[side];
                    }}
                    onScroll={sync}
                  />
                ) : (
                  <div className="git-workspace-empty">
                    {content.kind === "absent"
                      ? msg("git.fileMissing")
                      : content.reason || msg("git.textUnavailable", { kind: String(content.kind) })}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export function GitConflictFooter({
  conflicts,
  disabled,
}: {
  conflicts: GitConflictsState;
  disabled: boolean;
}) {
  useLocale();
  const entry = conflicts.entry;
  const blocked =
    disabled ||
    conflicts.locked ||
    !entry ||
    !supportedConflict(entry.document) ||
    entry.uncertain ||
    entry.saved;
  const ready =
    !!entry &&
    (entry.ready ||
      ((entry.reconstructed || !!entry.draft?.blocks.length) &&
        !!entry.draft &&
        entry.draft.blocks.every((b) => b.choice !== null)));
  return (
    <div className="git-conflict-footer">
      <div className="git-conflict-save-row">
        {entry?.draft && (
          <label>
            <input
              type="checkbox"
              checked={entry.ready}
              disabled={blocked}
              onChange={(e) => conflicts.setReady(e.target.checked)}
            />{msg("git.resultCheckedManually")}</label>
        )}
        <span role="status">
          {conflicts.pending?.kind === "execute"
            ? msg("git.writingYouCanCloseThisView", { path: String(conflicts.pending.path) })
            : conflicts.pending?.kind === "prepare"
              ? msg("git.checkingResolution")
              : entry?.saved
                ? msg("git.fileAndIndexSaved")
                : entry?.uncertain
                  ? msg("git.theWriteOutcomeMustBeVerifiedExplicitlyReloadTheFile")
                  : entry?.reconstructed || !!entry?.draft?.blocks.length
                    ? msg("git.unresolvedBlocks", { value1: String(entry.draft?.blocks.filter((b) => !b.choice).length ?? 0) })
                    : msg("git.manualModeConflictMarkersInTheTextDoNotCount")}
        </span>
        {conflicts.pending?.kind === "prepare" && (
          <button onClick={conflicts.cancelPrepare}>{msg("git.cancelCheck")}</button>
        )}
        {entry?.log && (
          <button onClick={conflicts.showLog}>{msg("git.writeLog")}</button>
        )}
        <button
          className="primary"
          disabled={blocked || !entry?.draft || !ready}
          onClick={() => {
            if (entry?.draft)
              void conflicts.prepare({ kind: "text", text: entry.draft.text });
          }}
        >{msg("git.saveFile")}</button>
      </div>
      {entry && supportedConflict(entry.document) && (
        <details className="git-conflict-whole-file">
          <summary>{msg("git.resolveEntireFile")}</summary>
          <div>
            <button
              disabled={blocked}
              onClick={() => void conflicts.prepare({ kind: "current" })}
            >{msg("git.acceptCurrentFile")}</button>
            <button
              disabled={blocked}
              onClick={() => void conflicts.prepare({ kind: "incoming" })}
            >{msg("git.acceptIncomingFile")}</button>
            <button
              disabled={blocked}
              onClick={() => void conflicts.prepare({ kind: "delete" })}
            >{msg("git.deleteFile")}</button>
            <small>{msg("git.replacesTheEntireFileIncludingManualEditsConfirmationIsRequired")}</small>
          </div>
        </details>
      )}
    </div>
  );
}
export function GitConflictDialogs({
  conflicts,
}: {
  conflicts: GitConflictsState;
}) {
  useLocale();
  return (
    <>
      {conflicts.confirmation && (
        <TopicModal
          title={
            conflicts.confirmation === "reload"
              ? msg("git.reloadConflict")
              : msg("git.restoreVerifiedBlocks")
          }
          closeLabel={msg("git.closeConflictConfirmation")}
          onClose={conflicts.closeConfirmation}
        >
          <div className="git-conflict-modal-body">
            <p>
              {conflicts.confirmation === "reload"
                ? msg("git.theCurrentDraftAndItsEditHistoryWillBeDiscarded")
                : msg("git.reconstructionReplacesTheCurrentDraftAndMayRemoveManualEdits")}
            </p>
            <button className="primary" onClick={conflicts.confirm}>
              {conflicts.confirmation === "reload"
                ? msg("git.discardDraftAndReload")
                : msg("git.replaceDraftWithReconstruction")}
            </button>
          </div>
        </TopicModal>
      )}
      {conflicts.preview && (
        <TopicModal
          title={msg("git.confirmFileResolution")}
          closeLabel={msg("git.closeResolutionConfirmation")}
          onClose={conflicts.closePreview}
        >
          <div className="git-conflict-modal-body">
            <dl>
              <dt>{msg("git.file2")}</dt>
              <dd>{conflicts.preview.path}</dd>
              <dt>{msg("git.branch2")}</dt>
              <dd>{conflicts.preview.branch ?? msg("git.detachedHEAD")}</dd>
              <dt>{msg("git.resolution")}</dt>
              <dd>
                {
                  {
                    text: msg("git.exactResultText"),
                    current:
                      msg("git.entireCurrentFileDeleteIfMissing"),
                    incoming:
                      msg("git.entireIncomingFileDeleteIfMissing"),
                    delete: msg("git.deleteFile2"),
                  }[conflicts.preview.resolution]
                }
              </dd>
              <dt>{msg("git.size")}</dt>
              <dd>{conflicts.preview.bytes}{msg("git.bytes")}</dd>
            </dl>
            <p>{msg("git.theWorkingFileAndIndexWillChangeGitHooksAre")}</p>
            <button
              className="primary"
              onClick={() => void conflicts.execute()}
            >{msg("git.writeFileAndIndex")}</button>
          </div>
        </TopicModal>
      )}
      {conflicts.message && (
        <TopicModal
          title={conflicts.message.title}
          closeLabel={msg("git.closeResolutionResult")}
          className="git-workspace-error"
          onClose={conflicts.closeMessage}
        >
          <pre>{conflicts.message.text}</pre>
        </TopicModal>
      )}
    </>
  );
}
