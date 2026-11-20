import { HintButton } from "../ActionHint";
import { getLocale, t as msg } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bell,
  FilePenLine,
  Files,
  Folder,
  LoaderCircle,
  PencilLine,
  RefreshCw,
} from "lucide-react";
import type { Project } from "../../shared/types";
import { documentScopeId } from "../settings-documents";
import { gitSummaryCacheFor } from "../git-summary-cache";
import { TopicPickerPopup } from "../TopicPickerPopup";
import {
  contextSuffix,
  ownerLabel,
  ownerProject,
  targetLabel,
} from "./model";
import { distinctSessionFiles } from "./session-summary";
import type {
  HomeTarget,
  ProjectVisit,
  SessionEntry,
  WorkspaceAddress,
} from "./types";

function useVisible(ref: RefObject<HTMLElement | null>) {
  const [onScreen, setOnScreen] = useState(false),
    [foreground, setForeground] = useState(
      () => document.visibilityState !== "hidden",
    );
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) =>
      setOnScreen(entries[entries.length - 1]?.isIntersecting === true),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => {
    const changed = () => setForeground(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return onScreen && foreground;
}
export function RecentChanges(props: {
  owner: WorkspaceAddress;
  onNavigate: (t: HomeTarget) => void;
}) {
  useLocale();
  const supported =
    typeof window.goga?.readGitSummary === "function" ||
    typeof window.goga?.readRequest === "function";
  return supported ? (
    <SubscribedChanges {...props} />
  ) : (
    <div className="d-git-change unknown">
      <Files size={12} />{msg("shell.changesUnavailable")}</div>
  );
}
function SubscribedChanges({
  owner,
  onNavigate,
}: {
  owner: WorkspaceAddress;
  onNavigate: (t: HomeTarget) => void;
}) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null),
    visible = useVisible(ref),
    scope = owner.kind === "primary" ? owner.projectId : owner.ref,
    key = documentScopeId(scope);
  const cache = gitSummaryCacheFor(window.goga);
  const subscribe = useCallback(
    (fn: () => void) => (visible ? cache.subscribe(scope, fn) : () => {}),
    [visible, key, cache],
  );
  const state = useSyncExternalStore(subscribe, () => cache.getSnapshot(scope));
  useEffect(() => {
    if (!visible) return;
    void cache.ensure(scope, "visible");
    const resumed = () => void cache.ensure(scope, "focus");
    window.addEventListener("focus", resumed);
    return () => window.removeEventListener("focus", resumed);
  }, [visible, key, cache]);
  const v = state.lastGood,
    missing = v?.repository === "missing",
    unavailable = !v && !!state.error;
  const label = missing
    ? msg("shell.noGit")
    : v
      ? v.changedFiles
        ? msg("shell.modifiedFileCount", { count: v.changedFiles })
        : msg("shell.noChanges")
      : unavailable
        ? msg("shell.changesUnavailable")
        : msg("shell.checkingChanges");
  const who =
    owner.kind === "primary"
      ? msg("shell.originalProjectNoTopic")
      : msg("shell.topicWorkingCopy2", { topic: String(owner.ref.topic), year: String(owner.ref.year) });
  return (
    <div
      ref={ref}
      className={`d-git-change${state.error ? " has-error" : ""}`}
      data-changes-state={
        state.error
          ? "error"
          : state.loading
            ? "pending"
            : v
              ? "ready"
              : "unknown"
      }
      data-changes-project={ownerProject(owner)}
    >
      <button
        className="d-changes-link"
        data-changes-link={ownerProject(owner)}
        disabled={missing}
        aria-label={
          label + " · " + who + (missing ? "" : msg("shell.openChanges"))
        }
        title={
          who +
          (v && state.checkedAt
            ? msg("shell.lastChecked") +
              new Date(state.checkedAt).toLocaleTimeString(getLocale())
            : "")
        }
        onClick={() => onNavigate({ kind: "changes", owner })}
      >
        <Files size={12} />
        <span>{label}</span>
        {!missing && <ArrowUpRight size={11} />}
      </button>
      <HintButton
        className="d-changes-refresh"
        hint={msg("shell.refreshChanges")}
        aria-label={
          state.loading
            ? msg("shell.refreshingChanges")
            : state.error
              ? msg("shell.retryRefreshingChanges")
              : msg("shell.refreshChanges")
        }
        disabled={state.loading}
        onClick={() => void cache.ensure(scope, "manual")}
      >
        {state.loading ? (
          <LoaderCircle size={12} className="d-git-spinner" />
        ) : (
          <RefreshCw size={12} />
        )}
      </HintButton>
      {state.error && (
        <small role="status">
          {v ? msg("shell.dataNotRefreshed") : msg("shell.couldNotCheck")}
        </small>
      )}
    </div>
  );
}

function EntryChooser({
  entries,
  anchor,
  onNavigate,
  onClose,
  label,
}: {
  entries: readonly SessionEntry[];
  anchor: RefObject<HTMLElement | null>;
  onNavigate: (t: HomeTarget) => void;
  onClose: () => void;
  label: string;
}) {
  useLocale();
  const list = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    el.querySelector("button")?.focus();
    const outside = (event: Event) => {
      if (
        !el.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      )
        close.current();
    };
    el.ownerDocument.addEventListener("pointerdown", outside);
    return () => el.ownerDocument.removeEventListener("pointerdown", outside);
  }, [anchor]);
  return (
    <div
      className="home-session-menu"
      ref={list}
      role="menu"
      aria-label={label}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
          anchor.current?.focus();
        }
        if (e.key === "Tab") onClose();
        if (["Home", "End", "ArrowDown", "ArrowUp"].includes(e.key)) {
          e.preventDefault();
          const buttons = Array.from(
            e.currentTarget.querySelectorAll("button"),
          );
          const i = buttons.indexOf(e.target as HTMLButtonElement);
          buttons[
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? buttons.length - 1
                : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                  buttons.length
          ]?.focus();
        }
      }}
    >
      {entries.map((entry) => {
        const t = entry.target,
          o = t.owner;
        const label = t.kind === "document" ? t.relativePath : targetLabel(t);
        const sameSlug = entries.some(
          (e) =>
            e.id !== entry.id &&
            o.kind === "topic" &&
            e.target.owner.kind === "topic" &&
            e.target.owner.ref.topic === o.ref.topic &&
            e.target.owner.ref.contextId !== o.ref.contextId,
        );
        return (
          <button
            key={entry.id}
            role="menuitem"
            onClick={() => {
              onClose();
              onNavigate(t);
            }}
          >
            <strong>{label}</strong>
            <small>
              {ownerLabel(o)}
              {o.kind === "topic" && " · " + o.ref.year}
              {sameSlug &&
                o.kind === "topic" &&
                " · " + o.ref.branch + " · " + o.ref.contextId.slice(-8)}
              {t.kind === "document"
                ? " · " + (t.source === "overview" ? msg("shell.overview") : msg("shell.project2"))
                : ""}
            </small>
          </button>
        );
      })}
    </div>
  );
}
function SessionAction({
  entries,
  owner,
  kind,
  onNavigate,
}: {
  entries: readonly SessionEntry[];
  owner: WorkspaceAddress;
  kind: "draft" | "document";
  onNavigate: (t: HomeTarget) => void;
}) {
  useLocale();
  const [open, setOpen] = useState(false),
    anchor = useRef<HTMLButtonElement>(null);
  if (!entries.length) return null;
  const single = entries.length === 1,
    first = entries[0].target;
  const count =
    kind === "document" ? distinctSessionFiles(entries).length : entries.length;
  const text =
    kind === "document"
      ? msg("shell.unsavedFileCount", { count })
      : single
        ? targetLabel(first)
        : msg("shell.drafts") + count;
  const scopes = new Set(
    entries.map((e) => contextSuffix(owner, e.target.owner)),
  );
  const suffix =
    scopes.size === 1 ? contextSuffix(owner, first.owner) : msg("shell.multipleContexts");
  const label = text + (suffix ? " · " + suffix : "");
  return (
    <>
      <HintButton
        ref={anchor}
        aria-label={label}
        hint={label}
        aria-haspopup={!single ? "menu" : undefined}
        aria-expanded={!single ? open : undefined}
        data-draft={kind === "draft" ? ownerProject(owner) : undefined}
        data-unsaved={kind === "document" ? ownerProject(owner) : undefined}
        onClick={() => (single ? onNavigate(first) : setOpen((v) => !v))}
      >
        {kind === "draft" ? (
          <PencilLine size={12} />
        ) : (
          <FilePenLine size={12} />
        )}
        <span className="d-session-label">
          {text}
          {suffix && (
            <span
              className="d-session-context"
              data-session-context={kind === "draft" ? "draft" : "unsaved"}
            >
              {" "}
              · {suffix}
            </span>
          )}
        </span>
        <ArrowUpRight size={11} />
      </HintButton>
      {open && !single && (
        <TopicPickerPopup
          domPortal
          anchor={anchor}
          label={text}
          width={320}
          onClose={() => setOpen(false)}
        >
          <EntryChooser
            entries={entries}
            anchor={anchor}
            label={text}
            onNavigate={onNavigate}
            onClose={() => setOpen(false)}
          />
        </TopicPickerPopup>
      )}
    </>
  );
}
export const RecentProjectCard = memo(function RecentProjectCard({
  project,
  visit,
  entries,
  active,
  unread,
  operation,
  onNavigate,
}: {
  project: Project;
  visit: ProjectVisit;
  entries: readonly SessionEntry[];
  active?: number;
  unread?: number;
  operation?: string;
  onNavigate: (t: HomeTarget) => void;
}) {
  useLocale();
  const owner = visit.target.owner;
  const docs = entries.filter((e) => e.target.kind === "document" && e.dirty),
    drafts = entries.filter((e) => e.target.kind === "draft");
  return (
    <article className="d-recent-tile">
      <button
        className="d-recent-card"
        data-recent-project={project.id}
        aria-label={msg("shell.resume", { name: String(project.name), value2: String(ownerLabel(owner)), value3: String(targetLabel(visit.target)) })}
        title={
          visit.previousSessionOnly
            ? msg("shell.thePreviousTabWasOnlyOpenInThePreviousSession")
            : undefined
        }
        onClick={() => onNavigate(visit.target)}
      >
        <span className="d-recent-top">
          <Folder size={16} />
          <strong>{project.name}</strong>
          <ArrowUpRight size={14} />
        </span>
        <span className="d-recent-context">{ownerLabel(owner)}</span>
        <small>
          {visit.previousSessionOnly
            ? msg("shell.previousTabClosedOpenOverview")
            : msg("shell.resume2") + targetLabel(visit.target)}
          <ArrowRight size={12} />
        </small>
      </button>
      <div
        className="d-project-signals"
        aria-label={msg("shell.projectStatus") + project.name}
      >
        <span>
          <Activity size={12} />
          {active === undefined
            ? msg("shell.runsNoData")
            : active
              ? msg("shell.runCount", { count: active })
              : msg("shell.noActiveRuns")}
        </span>
        {!!unread && (
          <span title={msg("shell.unreadProjectNotifications")}>
            <Bell size={12} />
            {unread}
          </span>
        )}
      </div>
      <RecentChanges owner={owner} onNavigate={onNavigate} />
      {(docs.length > 0 || drafts.length > 0 || operation) && (
        <div className="d-session-actions">
          <SessionAction
            entries={drafts}
            owner={owner}
            kind="draft"
            onNavigate={onNavigate}
          />
          <SessionAction
            entries={docs}
            owner={owner}
            kind="document"
            onNavigate={onNavigate}
          />
          {operation && <span role="status">{operation}</span>}
        </div>
      )}
    </article>
  );
});
