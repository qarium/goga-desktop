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
  plural,
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
  const supported =
    typeof window.goga?.readGitSummary === "function" ||
    typeof window.goga?.readRequest === "function";
  return supported ? (
    <SubscribedChanges {...props} />
  ) : (
    <div className="d-git-change unknown">
      <Files size={12} />
      Изменения недоступны
    </div>
  );
}
function SubscribedChanges({
  owner,
  onNavigate,
}: {
  owner: WorkspaceAddress;
  onNavigate: (t: HomeTarget) => void;
}) {
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
    ? "Без Git"
    : v
      ? v.changedFiles
        ? `${v.changedFiles} ${plural(v.changedFiles, ["файл", "файла", "файлов"])} с изменениями`
        : "Нет изменений"
      : unavailable
        ? "Изменения недоступны"
        : "Проверяем изменения…";
  const who =
    owner.kind === "primary"
      ? "Исходный проект · без топика"
      : `Копия топика ${owner.ref.topic} · ${owner.ref.year}`;
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
          label + " · " + who + (missing ? "" : ". Открыть изменения")
        }
        title={
          who +
          (v && state.checkedAt
            ? " · Последняя проверка " +
              new Date(state.checkedAt).toLocaleTimeString()
            : "")
        }
        onClick={() => onNavigate({ kind: "changes", owner })}
      >
        <Files size={12} />
        <span>{label}</span>
        {!missing && <ArrowUpRight size={11} />}
      </button>
      <button
        className="d-changes-refresh"
        title="Обновить изменения"
        aria-label={
          state.loading
            ? "Обновляются изменения"
            : state.error
              ? "Повторить обновление изменений"
              : "Обновить изменения"
        }
        disabled={state.loading}
        onClick={() => void cache.ensure(scope, "manual")}
      >
        {state.loading ? (
          <LoaderCircle size={12} className="d-git-spinner" />
        ) : (
          <RefreshCw size={12} />
        )}
      </button>
      {state.error && (
        <small role="status">
          {v ? "Данные не обновлены" : "Не удалось проверить"}
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
                ? " · " + (t.source === "overview" ? "Обзор" : "Проект")
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
  const [open, setOpen] = useState(false),
    anchor = useRef<HTMLButtonElement>(null);
  if (!entries.length) return null;
  const single = entries.length === 1,
    first = entries[0].target;
  const count =
    kind === "document" ? distinctSessionFiles(entries).length : entries.length;
  const text =
    kind === "document"
      ? `${count} ${plural(count, ["несохранённый файл", "несохранённых файла", "несохранённых файлов"])}`
      : single
        ? targetLabel(first)
        : "Черновики · " + count;
  const scopes = new Set(
    entries.map((e) => contextSuffix(owner, e.target.owner)),
  );
  const suffix =
    scopes.size === 1 ? contextSuffix(owner, first.owner) : "разные контексты";
  const label = text + (suffix ? " · " + suffix : "");
  return (
    <>
      <button
        ref={anchor}
        aria-label={label}
        title={label}
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
      </button>
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
  const owner = visit.target.owner;
  const docs = entries.filter((e) => e.target.kind === "document" && e.dirty),
    drafts = entries.filter((e) => e.target.kind === "draft");
  return (
    <article className="d-recent-tile">
      <button
        className="d-recent-card"
        data-recent-project={project.id}
        aria-label={`Продолжить ${project.name} · ${ownerLabel(owner)} · ${targetLabel(visit.target)}`}
        title={
          visit.previousSessionOnly
            ? "Прежняя вкладка была открыта только в прошлой сессии. Откроется Обзор этой рабочей области."
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
            ? "Прежняя вкладка закрыта · Открыть Обзор"
            : "Продолжить: " + targetLabel(visit.target)}
          <ArrowRight size={12} />
        </small>
      </button>
      <div
        className="d-project-signals"
        aria-label={"Состояние проекта " + project.name}
      >
        <span>
          <Activity size={12} />
          {active === undefined
            ? "Запуски — нет данных"
            : active
              ? `${active} ${plural(active, ["запуск", "запуска", "запусков"])}`
              : "Нет активных запусков"}
        </span>
        {!!unread && (
          <span title="Непрочитанные уведомления проекта">
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
