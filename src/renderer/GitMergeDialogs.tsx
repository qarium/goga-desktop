import { t as msg } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { useState } from "react";
import type {
  GitBranchInventory,
  GitBranchPreview,
} from "../shared/git-branches";

import { TopicModal } from "./TopicsCommon";

const short = (ref: string | null) =>
  ref?.replace(/^refs\/(heads|remotes)\//, "") ?? "—";

/** Sources are read-only refs, not checkout targets. Dirty files do not disable selection. */
export function GitMergeSource({
  inventory,
  onClose,
  onSelect,
}: {
  inventory: GitBranchInventory;
  onClose(): void;
  onSelect(ref: string): void;
}) {
  useLocale();
  const [group, setGroup] = useState<"local" | "remote">("local");
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const rows = inventory[group].filter(
    (row) => row.ref !== `refs/heads/${inventory.branch}`,
  );
  const source = rows.find((row) => row.ref === selected);
  const filtered = rows.filter((row) =>
    row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <TopicModal
      className="git-merge-source-dialog"
      title={msg("git.mergeBranchIntoCurrent2")}
      onClose={onClose}
    >
      <div className="git-branch-form git-merge-source">
        <div
          className="git-branch-groups"
          role="tablist"
          aria-label={msg("git.mergeSource")}
        >
          {(
            [
              ["local", msg("git.local")],
              ["remote", "Remote"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === group}
              onClick={() => {
                setGroup(key);
                setSelected("");
                setQuery("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          autoFocus
          aria-label={msg("git.findSourceBranch")}
          placeholder={msg("git.branchName")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="hint">{msg("git.branches")}{filtered.length}{msg("git.of2")}{rows.length}
        </p>
        <div
          className="git-merge-branch-list"
          role="listbox"
          aria-label={msg("git.branchesToMerge")}
        >
          {filtered.map((row, index) => (
            <button
              type="button"
              role="option"
              key={row.ref}
              aria-selected={selected === row.ref}
              title={row.name}
              onClick={() => setSelected(row.ref)}
              onKeyDown={(event) => {
                const offset =
                  event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -1
                      : 0;
                if (!offset && event.key !== "Home" && event.key !== "End")
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? filtered.length - 1
                      : Math.max(
                          0,
                          Math.min(filtered.length - 1, index + offset),
                        );
                (
                  event.currentTarget.parentElement?.children[next] as
                    HTMLElement | undefined
                )?.focus();
              }}
            >
              {row.name}
            </button>
          ))}
          {!filtered.length && <p className="hint">{msg("git.noBranchesAvailable")}</p>}
        </div>
        <p className="git-merge-selection">{msg("git.fromBranch")}<strong>{source?.name ?? msg("git.notSelected")}</strong>
        </p>
        <p className="git-merge-target">{msg("git.intoCurrentBranch")}<strong>{inventory.branch}</strong>
        </p>
        <details className="git-merge-conditions">
          <summary>{msg("git.mergeConditions")}</summary>
          <p>{msg("git.noBranchSwitchFastForwardIfPossibleOtherwiseCreateA")}</p>
          {inventory.dirty && (
            <p className="hint">{msg("git.uncommittedChangesDoNotAutomaticallyBlockAMergeAndMust")}</p>
          )}
          {group === "remote" && (
            <p className="hint">{msg("git.usesTheAlreadyFetchedRemoteBranchNoRequestIsSent")}</p>
          )}
        </details>
        <div className="git-branch-dialog-actions">
          <button type="button" onClick={onClose}>{msg("git.cancel")}</button>
          <button
            type="button"
            className="primary"
            disabled={!source}
            onClick={() => source && onSelect(source.ref)}
          >{msg("git.continue")}</button>
        </div>
      </div>
    </TopicModal>
  );
}

export function GitMergeConfirmation({
  preview,
  onClose,
  onConfirm,
}: {
  preview: GitBranchPreview;
  onClose(): void;
  onConfirm(): void;
}) {
  useLocale();
  const abort = preview.action === "abort-merge";
  return (
    <TopicModal
      title={abort ? msg("git.abortMerge") : msg("git.confirmMerge")}
      onClose={onClose}
    >
      <div className="git-branch-form">
        <p className="context-path">{preview.root}</p>
        <dl className="git-branch-summary">
          <dt>{abort ? msg("git.incomingCommit") : msg("git.source")}</dt>
          <dd>
            {preview.sourceRef && `${short(preview.sourceRef)} · `}
            {preview.sourceOid?.slice(0, 8) ?? "—"}
          </dd>
          <dt>{abort ? msg("git.currentBranch") : msg("git.intoCurrentBranch2")}</dt>
          <dd>
            {short(preview.toRef)} · {preview.toOid?.slice(0, 8) ?? "—"}
          </dd>
        </dl>
        {abort ? (
          <>
            <p>{msg("git.manualConflictResolutionsWillBeLostGitWillTryTo")}</p>
            <p>{msg("git.ifTheMergeCannotBeAbortedALogWillAppear")}</p>
          </>
        ) : (
          <>
            <p>{msg("git.fastForwardIfPossibleOtherwiseGitCreatesAMergeCommit")}</p>
            <p>{msg("git.authorshipAndSigningComeFromTheRepositoryConfigurationUncommittedChanges")}</p>
          </>
        )}
        <p className="hint">{msg("git.noForceAutomaticStashOrFileResetGitHooksAre")}</p>
        <div className="git-branch-dialog-actions">
          <button type="button" onClick={onClose}>{msg("git.cancel")}</button>
          <button
            type="button"
            className={abort ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {abort ? msg("git.abortMerge3") : msg("git.mergeInto", { value1: String(short(preview.toRef)) })}
          </button>
        </div>
      </div>
    </TopicModal>
  );
}
