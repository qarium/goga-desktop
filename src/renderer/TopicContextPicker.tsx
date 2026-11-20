import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import { TopicRepositoryNotice, type TopicRepositoryState } from "./topic-repository";
import type { DisplayCatalog } from "./topic-display-cache";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { Project } from "../shared/types";
import type { TopicTarget } from "../shared/topics";
import {
  topicContextRefSchema,
  type TopicContextIdentity,
  type WorktreeRecord,
} from "../shared/worktrees";
import { TOPIC_CONTEXT_PREPARE_TIMEOUT_MS } from "../shared/worktree-capabilities";
import {
  contextRef,
  contextRunActivity,
  type RunWithContext,
} from "./topic-context";
import "./TopicContextPicker.css";
import { useOptionFocus } from "./useOptionFocus";
import { ContextOperationProgress } from "./ContextOperationProgress";
import { readRequest } from "./read-request";
import { TopicQuickSync } from "./TopicQuickSync";
import { TopicPickerPopup, useNativeTopicPopup } from "./TopicPickerPopup";

export type TopicCreationProgress = {
  identity: TopicContextIdentity;
  state: "busy" | "error";
  message?: string;
  retry: () => void;
};

/** Presentation only: App places this after repository actions, while a
 * standalone picker may retain its local feedback. Never owns a create flight. */
export function TopicCreationFeedback({
  progress,
  disabled = false,
  onShow,
}: {
  progress: Omit<TopicCreationProgress, "retry">;
  disabled?: boolean;
  onShow: () => void;
}) {
  useLocale();
  if (progress.state === "busy") {
    const label = tr("topics.creatingBranch", { branch: progress.identity.branch });
    return <ContextOperationProgress label={label} message={tr("topics.creating")} />;
  }
  return (
    <div className="topic-context-creation-feedback is-error" role="alert">
      <button
        type="button"
        className="topic-context-creation-error"
        aria-label={tr("topics.showTopicCreationErrorForBranch", { branch: progress.identity.branch })}
        title={progress.message}
        disabled={disabled}
        onClick={onShow}
      >
        <span className="topic-context-creation-warning" aria-hidden="true">
          !
        </span>
        <span className="topic-context-creation-message">{tr("topics.creationFailed")}</span>
        <span aria-hidden="true">↗</span>
      </button>
    </div>
  );
}

export interface TopicContextPickerProps {
  project: Project;
  board: DisplayCatalog | null;
  repository?: TopicRepositoryState;
  catalogError?: string;
  onRetryCatalog?: () => void;
  selected: WorktreeRecord | null;
  knownContexts?: WorktreeRecord[];
  runs?: RunWithContext[];
  disabled?: boolean;
  onSelect: (record: WorktreeRecord, approved?: () => boolean) => void;
  requestedSelection?: { identity: TopicContextIdentity; nonce: number } | null;
  onSelectionRequestHandled?: () => void;
  onTransitionIntent?: () => void;
  onCreated?: (record: WorktreeRecord) => void;
  /** Creating a topic or ensuring a missing clone mutates disk before selection. */
  beforePrepare?: (
    start: (approved: () => boolean) => void,
    creating: boolean,
  ) => void;
  onCreationStarted?: (identity: TopicContextIdentity) => void;
  onCreationProgress?: (progress: TopicCreationProgress | null) => void;
  onShowCreation?: (identity: TopicContextIdentity) => void;
  showCreationFeedback?: boolean;
  onClear: () => void;
  onOpenCard: (target: TopicTarget, year: string) => void;
}
interface PickerTopic {
  identity: TopicContextIdentity;
  record?: WorktreeRecord;
  key: string;
  isCurrent: boolean;
  showYear: boolean;
  ownerLabel?: string;
}
type Preparation =
  | {
      state: "busy";
      identity: TopicContextIdentity;
      create?: boolean;
      owner?: WorktreeRecord;
    }
  | {
      state: "error";
      identity: TopicContextIdentity;
      message: string;
      create?: boolean;
      owner?: WorktreeRecord;
    }
  | null;
const identityKey = (identity: TopicContextIdentity) =>
  JSON.stringify([
    identity.projectId,
    identity.year,
    identity.topic,
    identity.branch,
  ]);
const ownerKey = (record: WorktreeRecord) =>
  JSON.stringify([identityKey(record), record.contextId]);
const readiness = {
  notPrepared: ["topics.theCopyWillBePreparedWhenYouSwitch", "topics.noCopy"],
  legacy: ["topics.legacyCopy", "topics.legacy"],
  preparing: ["topics.preparationIncomplete", "topics.preparing"],
  missing: ["topics.copyUnavailable", "topics.unavailable"],
  conflict: ["topics.copyConflict", "topics.conflict"],
  deleting: ["topics.copyBeingRemoved", "topics.removing"],
  primary: ["topics.originalCopy", "topics.original"],
  ready: ["topics.workingCopy", "topics.copyAvailable"],
} as const;
function copyStatus(record?: WorktreeRecord): keyof typeof readiness {
  if (!record) return "notPrepared";
  if (record.compatibility === "legacy-linked" || record.storageKind === "linked") return "legacy";
  if (record.preparation) return "preparing";
  if (record.state === "missing" || record.state === "conflict" || record.state === "deleting") return record.state;
  return record.ownership === "primary" ? "primary" : "ready";
}
const timeoutMessage = () =>
  tr("topics.preparationTookMoreThan300SecondsAndMay");

/** Selecting waits for a host-validated copy; viewing a card never changes cwd. */
export function TopicContextPicker({
  project,
  board,
  repository = "available",
  catalogError,
  onRetryCatalog,
  selected,
  knownContexts = [],
  runs = [],
  disabled = false,
  onSelect,
  onTransitionIntent,
  onCreated,
  beforePrepare,
  onCreationStarted,
  onCreationProgress,
  onShowCreation,
  showCreationFeedback = true,
  onClear,
  onOpenCard,
  requestedSelection,
  onSelectionRequestHandled,
}: TopicContextPickerProps) {
  const locale = useLocale();
  const nativePopup = useNativeTopicPopup();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const epoch = useRef(0);
  const busyKey = useRef<string | null>(null);
  // Writes stay physically alive after UI timeout/navigation. Never cancel Git here.
  const flights = useRef(new Map<string, Promise<WorktreeRecord>>());
  const mounted = useRef(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { focus, setFocused } = useOptionFocus();
  const focused = focus.index;
  const [preparation, setPreparation] = useState<Preparation>(null);
  const progressCallback = useRef(onCreationProgress);
  progressCallback.current = onCreationProgress;
  // Presentation only. The picker retains ownership of the single physical
  // flight, its epoch checks, timeout reconciliation and explicit retry.
  useEffect(() => {
    progressCallback.current?.(
      preparation?.create
        ? {
            identity: preparation.identity,
            state: preparation.state,
            message:
              preparation.state === "error" ? preparation.message : undefined,
            retry: () => prepare(preparation.identity, true, preparation.owner),
          }
        : null,
    );
  }, [preparation]);
  useEffect(() => () => progressCallback.current?.(null), []);
  const current = selected?.projectId === project.id ? selected : null;
  const snapshot = board?.projectId === project.id ? board : null;
  const scopeKey = JSON.stringify([project.id, project.path]);
  const selectedKey = current ? ownerKey(current) : null;
  const headerTarget = current
    ? { topic: current.topic, branch: current.branch, remote: false }
    : null;
  const headerYear = current?.year;
  const expanded = open && !disabled;
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;
  const clearTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const invalidate = () => {
    epoch.current++;
    busyKey.current = null;
    clearTimer();
  };

  useEffect(() => {
    invalidate();
    setOpen(false);
    setQuery("");
    setPreparation(null);
  }, [scopeKey, selectedKey, current?.revision]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!expanded) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !popup.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded, repository]);

  useEffect(() => {
    if (
      !requestedSelection ||
      requestedSelection.identity.projectId !== project.id
    )
      return;
    if (repository !== "available") {
      if (repository === "missing") onSelectionRequestHandled?.();
      return;
    }
    const identity = requestedSelection.identity;
    const owners = knownContexts.filter(
      (record) =>
        !record.deletedAt && identityKey(record) === identityKey(identity),
    );
    if (owners.length > 1) {
      setQuery(identity.topic);
      setOpen(true);
    } else prepare(identity, false, owners[0]);
    onSelectionRequestHandled?.();
  }, [requestedSelection, repository]);

  const topics = useMemo(() => {
    const logical = new Map<string, TopicContextIdentity>();
    if (snapshot) {
      // Per-host records describe placements, not logical topic owners.
      for (const entry of [
        ...snapshot.entries,
        ...(snapshot.currentTopic ? [snapshot.currentTopic] : []),
      ]) {
        if (entry.remote) continue;
        const identity = {
          projectId: project.id,
          year: snapshot.year,
          topic: entry.topic,
          branch: entry.branch,
        };
        logical.set(identityKey(identity), identity);
      }
    }
    const owners = new Map<string, WorktreeRecord>();
    const ownedIdentities = new Set<string>();
    const sourceOwners = [...knownContexts];
    // A selected historical snapshot is only a fallback. Explicitly refreshed
    // host inventory owns row freshness without automatically changing selection.
    if (
      current &&
      !knownContexts.some((record) => ownerKey(record) === ownerKey(current))
    )
      sourceOwners.push(current);
    for (const record of sourceOwners) {
      if (record.projectId !== project.id || record.deletedAt) continue;
      owners.set(ownerKey(record), record);
      ownedIdentities.add(identityKey(record));
    }
    const all: PickerTopic[] = [
      ...[...logical]
        .filter(([key]) => !ownedIdentities.has(key))
        .map(([key, identity]) => ({
          identity,
          key,
          isCurrent: false,
          showYear: false,
        })),
      ...[...owners].map(([key, record]) => ({
        identity: {
          projectId: record.projectId,
          year: record.year,
          topic: record.topic,
          branch: record.branch,
        },
        record,
        key,
        isCurrent: false,
        showYear: false,
      })),
    ];
    const marked = current
      ? all.find((topic) => topic.key === selectedKey)
      : undefined;
    if (marked) marked.isCurrent = true;
    for (const topic of all) {
      topic.showYear = all.some(
        (other) =>
          other.identity.topic === topic.identity.topic &&
          other.identity.year !== topic.identity.year,
      );
      const sameIdentity = all.filter(
        (other) => identityKey(other.identity) === identityKey(topic.identity),
      );
      if (sameIdentity.length > 1)
        topic.ownerLabel = tr("topics.copyValue1", { value1: sameIdentity.indexOf(topic) + 1 });
    }
    const term = query.trim().toLocaleLowerCase();
    return all
      .filter((topic) => !topic.isCurrent)
      .filter(({ identity }) =>
        `${identity.topic} ${identity.branch} ${identity.year}`
          .toLocaleLowerCase()
          .includes(term),
      )
      .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
  }, [snapshot, knownContexts, current, project.id, query, selectedKey, locale]);
  const primaryIndex = 0;
  const activeIndex = Math.min(focused, topics.length);
  const activeOption = activeIndex >= 0 ? optionId(activeIndex) : undefined;
  useEffect(() => {
    if (!expanded || activeIndex < 0 || focus.source === "pointer") return;
    const container = list.current;
    const option = container?.ownerDocument.getElementById(
      optionId(activeIndex),
    );
    if (!option || !container) return;
    // offsetTop belongs to the positioned popup, not necessarily the list.
    // Compare viewport rectangles in the same document (also for native portals)
    // and scroll only this list, never the containing page or the search field.
    const top = container.getBoundingClientRect().top + container.clientTop;
    const bounds = option.getBoundingClientRect();
    if (bounds.top < top) container.scrollTop += bounds.top - top;
    else if (bounds.bottom > top + container.clientHeight)
      container.scrollTop += Math.min(
        bounds.top - top,
        bounds.bottom - top - container.clientHeight,
      );
  }, [expanded, activeIndex, query, focus]);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  }
  function show() {
    if (disabled || trigger.current?.matches(":disabled")) return;
    setFocused(0);
    setQuery("");
    setOpen(true);
  }
  function prepare(
    identity: TopicContextIdentity,
    create = false,
    owner?: WorktreeRecord,
  ) {
    if ((create || !owner) && beforePrepare) {
      const ticket = epoch.current;
      beforePrepare((approved) => {
        if (mounted.current && epoch.current === ticket)
          startPreparation(identity, create, owner, approved);
      }, create);
    } else startPreparation(identity, create, owner);
  }
  function startPreparation(
    identity: TopicContextIdentity,
    create: boolean,
    owner: WorktreeRecord | undefined,
    approved?: () => boolean,
  ) {
    if (disabled || trigger.current?.matches(":disabled")) return;
    if (repository !== "available") return;
    onTransitionIntent?.();
    const key = JSON.stringify([
      scopeKey,
      identityKey(identity),
      create,
      owner?.contextId,
      owner?.revision,
    ]);
    if (busyKey.current === key) return;
    invalidate();
    const token = epoch.current;
    busyKey.current = key;
    setPreparation({ state: "busy", identity, create, owner });
    if (create && onCreationStarted) {
      close();
      onCreationStarted(identity);
    }
    let flight = flights.current.get(key);
    const reused = Boolean(flight);
    if (!flight) {
      try {
        flight = Promise.resolve(
          create
            ? (async () => {
                // The display catalog has no mutation/configuration authority.
                // Load the configured base only for this explicit create intent.
                const fresh = await readRequest(
                  "readTopicBoard",
                  project.id,
                  identity.year,
                );
                if (!mounted.current || token !== epoch.current)
                  throw Error(tr("topics.creationCanceledBeforeTheProjectChanged"));
                if (
                  fresh.projectId !== project.id ||
                  fresh.year !== identity.year
                )
                  throw Error(
                    tr("topics.baseSettingsBelongToAnotherProjectOrYear"),
                  );
                return window.goga.createTopicContext({
                  projectId: project.id,
                  year: identity.year,
                  branch: identity.branch,
                  baseRef: fresh.baseRef || "HEAD",
                });
              })()
            : owner
              ? typeof window.goga.resolveTopicContext === "function"
                ? window.goga.resolveTopicContext(contextRef(owner))
                : Promise.reject(
                    Error(
                      tr("topics.thisHostVersionCannotVerifyTheExactWorking"),
                    ),
                  )
              : window.goga.ensureTopicContext(identity),
        );
      } catch (error) {
        flight = Promise.reject(error);
      }
      flights.current.set(key, flight);
      const forget = () => {
        if (flights.current.get(key) === flight) flights.current.delete(key);
      };
      // A fulfilled write survives timeout/navigation until a current intent
      // validates and consumes it. Never issue a second ensure/create blindly.
      void flight.then(undefined, forget);
    }
    const isLatest = () => mounted.current && token === epoch.current;
    const matchesRequest = (record: WorktreeRecord) =>
      !!record &&
      (create
        ? record.projectId === identity.projectId &&
          record.year === identity.year &&
          record.branch === identity.branch
        : identityKey(record) === identityKey(identity) &&
          (!owner ||
            (record.contextId === owner.contextId &&
              record.revision === owner.revision)));
    const verified = flight.then(async (record) => {
      if (!reused || !isLatest() || !matchesRequest(record)) return record;
      const ref = topicContextRefSchema.safeParse(contextRef(record));
      if (!ref.success)
        throw Error(
          tr("topics.invalidWorkingCopyReferenceNoCopyWillBe"),
        );
      if (typeof window.goga.resolveTopicContext !== "function")
        throw Error(
          tr("topics.thisHostVersionCannotVerifyTheExactWorking"),
        );
      const resolved = await window.goga.resolveTopicContext(ref.data);
      if (
        !resolved ||
        identityKey(resolved) !== identityKey(record) ||
        resolved.contextId !== record.contextId ||
        resolved.revision !== record.revision
      )
        throw Error(
          tr("topics.theVerificationResponseDoesNotMatchThePrepared"),
        );
      return resolved;
    });
    timer.current = setTimeout(() => {
      if (!isLatest()) return;
      invalidate();
      setPreparation({
        state: "error",
        identity,
        create,
        owner,
        message: owner
          ? tr("topics.workingCopyVerificationTookMoreThan300Seconds")
          : timeoutMessage(),
      });
    }, TOPIC_CONTEXT_PREPARE_TIMEOUT_MS);
    void verified.then(
      (record) => {
        if (!isLatest()) return;
        clearTimer();
        busyKey.current = null;
        if (!matchesRequest(record)) {
          setPreparation({
            state: "error",
            identity,
            create,
            owner,
            message:
              tr("topics.thePreparationResponseDoesNotMatchTheSelected"),
          });
        } else if (
          record.state !== "ready" ||
          record.storageKind !== "clone" ||
          record.ownership !== "managed" ||
          record.compatibility === "legacy-linked" ||
          record.preparation ||
          record.deletedAt ||
          !topicContextRefSchema.safeParse(contextRef(record)).success
        ) {
          setPreparation({
            state: "error",
            identity,
            create,
            owner,
            message:
              tr("topics.theWorkingCopyIsUnavailableCheckBranchConflicts"),
          });
        } else {
          if (flights.current.get(key) === flight) flights.current.delete(key);
          setPreparation(null);
          close(true);
          if (create) onCreated?.(record);
          else if (approved) onSelect(record, approved);
          else onSelect(record);
        }
      },
      (error: unknown) => {
        if (!isLatest()) return;
        clearTimer();
        busyKey.current = null;
        const message =
          error instanceof Error
            ? error.message
            : tr("topics.couldNotPrepareTheWorkingCopy");
        setPreparation({
          state: "error",
          identity,
          create,
          owner,
          message: tr("topics.messageThePreviousContextWasKept", { message: message }),
        });
      },
    );
  }
  function choose(index: number) {
    if (disabled || trigger.current?.matches(":disabled")) return;
    if (index === primaryIndex) {
      onTransitionIntent?.();
      invalidate();
      setPreparation(null);
      close(true);
      onClear();
      return;
    }
    const topic = topics[index - 1];
    if (!topic) return;
    if (
      current &&
      topic.key === selectedKey &&
      current.state === "ready" &&
      topic.record?.state === "ready" &&
      topic.record.revision === current.revision &&
      !topic.record.preparation &&
      !current.preparation &&
      !current.deletedAt
    ) {
      onTransitionIntent?.();
      invalidate();
      setPreparation(null);
      close(true);
    } else if (
      topic.record &&
      (topic.record.state === "missing" ||
        topic.record.compatibility === "legacy-linked" ||
        topic.record.storageKind === "linked")
    ) {
      // The host-issued record remains unavailable/legacy: this only opens its
      // history and migration UI. Never ensure/recreate or promote it to ready.
      onTransitionIntent?.();
      invalidate();
      setPreparation(null);
      close(true);
      onSelect(topic.record);
    } else prepare(topic.identity, false, topic.record);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab" && !nativePopup && popup.current) {
      const selector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]';
      const controls = Array.from(popup.current.querySelectorAll<HTMLElement>(selector)).filter((node) => node.tabIndex >= 0);
      const boundary = event.shiftKey ? controls[0] : controls.at(-1);
      if (event.target === boundary) {
        // A body portal must not change the selector's place in keyboard order.
        const shell = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((node) => node.tabIndex >= 0 && !popup.current?.contains(node));
        const anchorControls = shell.filter((node) => root.current?.contains(node));
        const edge = anchorControls.at(-1);
        const destination = event.shiftKey ? edge : edge ? shell[shell.indexOf(edge) + 1] : undefined;
        event.preventDefault();
        close();
        (destination ?? trigger.current)?.focus();
        return;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
      event.target === search.current
    ) {
      event.preventDefault();
      const last = topics.length;
      setFocused(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : Math.max(
                0,
                Math.min(
                  last,
                  activeIndex + (event.key === "ArrowDown" ? 1 : -1),
                ),
              ),
      );
    } else if (event.key === "Enter" && event.target === search.current) {
      event.preventDefault();
      choose(activeIndex);
    }
  }
  function primaryRow() {
    return (
      <div
        id={optionId(primaryIndex)}
        role="row"
        aria-label={tr("topics.noTopicOriginalProjectFolderCurrentBranch")}
        aria-selected={!current}
        className={`topic-context-option${primaryIndex === activeIndex ? " is-focused" : ""}`}
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => setFocused(primaryIndex, "pointer")}
        onClick={() => choose(primaryIndex)}
      >
        <div className="topic-context-lines" role="gridcell">
          <strong>{tr("launch.noTopic")}</strong>
          <small>{tr("topics.originalFolderCurrentBranch")}</small>
          {!current && <span className="topic-context-current">{tr("topics.current")}</span>}
        </div>
      </div>
    );
  }
  const newName = query.trim();
  const hasExact =
    (current &&
      [current.topic, current.branch].some(
        (value) => value.toLocaleLowerCase() === newName.toLocaleLowerCase(),
      )) ||
    topics.some(
      ({ identity }) =>
        identity.topic.toLocaleLowerCase() === newName.toLocaleLowerCase() ||
        identity.branch.toLocaleLowerCase() === newName.toLocaleLowerCase(),
    );
  const creationAvailable =
    !!onCreated && typeof window.goga.createTopicContext === "function";
  const creation =
    showCreationFeedback && preparation?.create ? preparation : null;
  const validNewName =
    /^[\p{L}\p{N}][\p{L}\p{N}_/-]*$/u.test(newName) &&
    newName.length <= 80 &&
    !newName.endsWith("/") &&
    !newName.includes("//");
  return (
    <div
      className={`topic-context-picker${creation ? " has-creation-feedback" : ""}`}
      ref={root}
      onBlur={(event) => {
        const destination = event.relatedTarget;
        const tooltip =
          destination instanceof Element
            ? destination.closest('[role="tooltip"]')
            : null;
        // A repository action's tooltip is portalled into this document's body.
        // Only a tooltip explicitly described by this picker belongs to it.
        const ownedTooltip =
          !!tooltip?.id &&
          [...event.currentTarget.querySelectorAll("[aria-describedby]"), ...(popup.current?.querySelectorAll("[aria-describedby]") ?? [])].some((control) =>
            control
              .getAttribute("aria-describedby")
              ?.split(/\s+/)
              .includes(tooltip.id),
          );
        if (
          !nativePopup &&
          !event.currentTarget.contains(destination as Node) &&
          !popup.current?.contains(destination as Node) &&
          !ownedTooltip
        )
          close();
      }}
    >
      <div className="topic-context-split">
        <button
          type="button"
          className="topic-context-name"
          disabled={disabled}
          aria-label={
            headerTarget
              ? tr("topics.openTopicCardForTopic", { topic: headerTarget.topic })
              : tr("launch.noTopic")
          }
          onClick={() => {
            if (headerTarget && headerYear)
              onOpenCard(headerTarget, headerYear);
            else if (!headerTarget) show();
          }}
        >
          {headerTarget?.topic ?? tr("launch.noTopic")}
        </button>
        <button
          type="button"
          className="topic-context-trigger"
          ref={trigger}
          aria-label={tr("topics.selectAnotherTopic")}
          aria-haspopup={repository === "available" ? "grid" : "dialog"}
          aria-expanded={expanded}
          aria-controls={expanded ? (repository === "available" ? listId : id) : undefined}
          disabled={disabled}
          onClick={() => (expanded ? close() : show())}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              show();
            } else if (event.key === "Escape") close(true);
          }}
        >
          <span className="topic-context-chevron" aria-hidden="true" />
        </button>
      </div>
      {creation && (
        <TopicCreationFeedback
          progress={creation}
          disabled={disabled}
          onShow={() => {
            if (onShowCreation) onShowCreation(creation.identity);
            else {
              setQuery(creation.identity.branch);
              setFocused(0);
              setOpen(true);
            }
          }}
        />
      )}
      {expanded && (
        <TopicPickerPopup anchor={root} onClose={() => close()} domPortal>
          <div
            ref={popup}
            className="topic-context-popup"
            role="region"
            aria-label={tr("topics.topicPicker")}
            onKeyDown={keyDown}
          >
            {repository !== "available" ? (
              <div id={id} role="dialog" aria-label={tr("topics.topicAvailability")}>
                {repository === "checking"
                  ? <p role="status">{tr("topics.checkingGitInProject")}</p>
                  : <TopicRepositoryNotice popup />}
                {current && <button type="button" onClick={() => choose(primaryIndex)}>{tr("topics.goToOriginalFolder")}</button>}
              </div>
            ) : <>
            {catalogError && (
              <div className="context-board-error">
                <p role="alert">{catalogError}</p>
                {onRetryCatalog && (
                  <button type="button" onClick={onRetryCatalog}>{tr("topics.retryLoadingTopics")}</button>
                )}
              </div>
            )}
            <label htmlFor={`${id}-search`}>{tr("topics.findTopic")}</label>
            <input
              id={`${id}-search`}
              ref={search}
              type="search"
              role="combobox"
              aria-haspopup="grid"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-controls={listId}
              aria-activedescendant={activeOption}
              autoComplete="off"
              value={query}
              placeholder={tr("topics.topicOrBranchName")}
              onChange={(event) => {
                setQuery(event.target.value);
                setFocused(0);
              }}
            />
            <div
              className="topic-context-options"
              id={listId}
              role="grid"
              aria-label={tr("topics.projectTopics")}
              ref={list}
            >
              {primaryRow()}
              {topics.map((topic, topicIndex) => {
                const index = topicIndex + 1;
                const isCurrent = topic.isCurrent;
                const [longLabel, shortLabel] = readiness[copyStatus(topic.record)];
                const status = tr(longLabel);
                const activity = contextRunActivity(runs, topic.record ?? null);
                const active = activity.activeBuild ?? activity.activePipeline;
                const activityLabel = active
                  ? `● ${active.kind === "build" ? tr("launch.build") : tr("launch.pipeline")}${active.kind !== "build" && active.pipelineName ? ` «${active.pipelineName}»` : ""}${activity.activeCount > 1 ? tr("topics.value1More", { value1: activity.activeCount - 1 }) : ""}`
                  : null;
                const pending =
                  preparation?.state === "busy" &&
                  identityKey(preparation.identity) ===
                    identityKey(topic.identity) &&
                  preparation.owner?.contextId === topic.record?.contextId;
                return (
                  <div
                    key={topic.key}
                    id={optionId(index)}
                    role="row"
                    aria-label={`${topic.identity.topic} ${topic.identity.branch} ${topic.identity.year}${topic.ownerLabel ? ` ${topic.record?.contextId}` : ""} ${status}${isCurrent ? tr("topics.current2") : ""}${activity.activeCount ? tr("topics.activeActivecount", { activeCount: activity.activeCount }) : ""}`}
                    aria-selected={isCurrent}
                    aria-disabled={pending}
                    className={`topic-context-option${index === activeIndex ? " is-focused" : ""}`}
                    onPointerDown={(event) => {
                      if (!(
                        (event.target as Element).nodeType === 1 &&
                        (event.target as Element).closest("button")
                      ))
                        event.preventDefault();
                    }}
                    onPointerMove={() => setFocused(index, "pointer")}
                    onClick={() => choose(index)}
                  >
                    <div className="topic-context-lines" role="gridcell">
                      <strong>
                        {topic.identity.topic}
                        {topic.showYear && (
                          <span className="topic-context-disambiguation">
                            {" "}
                            · {topic.identity.year}
                          </span>
                        )}
                      </strong>
                      <small>
                        {topic.identity.branch}
                        {topic.ownerLabel && <span> · {topic.ownerLabel}</span>}
                      </small>
                      <small className="topic-context-status">
                        <span
                          className="topic-context-readiness"
                          title={status}
                        >
                          {tr(shortLabel)}
                        </span>
                        {isCurrent && (
                          <span className="topic-context-current">{tr("topics.current")}</span>
                        )}
                      </small>
                      {activity.activeCount > 0 && (
                        <span className="topic-context-activity">
                          {activityLabel}
                        </span>
                      )}
                    </div>
                    <div
                      className="topic-context-option-actions"
                      role="gridcell"
                    >
                      <TopicQuickSync
                        identity={topic.identity}
                        record={topic.record}
                        onStarted={() => close(true)}
                      />
                    </div>
                  </div>
                );
              })}
              {topics.length === 0 && (
                <p className="topic-context-empty">
                  {!snapshot && !knownContexts.length
                    ? tr("topics.theTopicListIsNotAvailableYet")
                    : tr("topics.noMatches")}
                </p>
              )}
            </div>
            {preparation?.state === "busy" && (
              <p
                className="topic-context-feedback"
                role={preparation.create ? undefined : "status"}
              >
                {preparation.owner
                  ? tr("topics.checkingWorkingCopy")
                  : tr("topics.preparingWorkingCopy")}
              </p>
            )}
            {preparation?.state === "error" && (
              <div className="topic-context-feedback">
                <p role={preparation.create ? undefined : "alert"}>
                  {preparation.message}
                </p>
                <button
                  type="button"
                  onClick={() =>
                    prepare(
                      preparation.identity,
                      preparation.create,
                      preparation.owner,
                    )
                  }
                >{tr("launch.retry")}</button>
              </div>
            )}
            {newName && !hasExact && (
              <div className="topic-context-create">
                <button
                  type="button"
                  disabled={
                    !creationAvailable ||
                    !validNewName ||
                    preparation?.state === "busy"
                  }
                  onClick={() =>
                    prepare(
                      {
                        projectId: project.id,
                        year:
                          snapshot?.year ?? String(new Date().getFullYear()),
                        topic: newName,
                        branch: newName,
                      },
                      true,
                    )
                  }
                  aria-describedby={`${id}-creation-reason`}
                >{tr("topics.createAndPreparePipeline", { topic: newName })}</button>
                <small id={`${id}-creation-reason`}>
                  {!creationAvailable
                    ? tr("topics.creatingTopicsIsUnavailableInThisHostVersion")
                    : validNewName
                      ? tr("topics.describeTheTaskInTheNextStepThe")
                      : tr("topics.useLettersDigitsHyphensUnderscoresOrUpTo")}
                </small>
              </div>
            )}
            </>}
          </div>
        </TopicPickerPopup>
      )}
    </div>
  );
}
