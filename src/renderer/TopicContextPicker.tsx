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
import { readRequest } from "./read-request";
import { TopicQuickSync } from "./TopicQuickSync";
import { TopicPickerPopup, hasNativeTopicPopup } from "./TopicPickerPopup";

export interface TopicContextPickerProps {
  project: Project;
  board: DisplayCatalog | null;
  selected: WorktreeRecord | null;
  knownContexts?: WorktreeRecord[];
  runs?: RunWithContext[];
  disabled?: boolean;
  onSelect: (record: WorktreeRecord) => void;
  requestedSelection?: { identity: TopicContextIdentity; nonce: number } | null;
  onSelectionRequestHandled?: () => void;
  onTransitionIntent?: () => void;
  onCreated?: (record: WorktreeRecord) => void;
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
function copyStatus(record?: WorktreeRecord): string {
  if (!record) return "Копия подготовится при переходе";
  if (
    record.compatibility === "legacy-linked" ||
    record.storageKind === "linked"
  )
    return "Копия прежнего формата";
  if (record.preparation) return "Подготовка не завершена";
  if (record.state === "missing") return "Копия недоступна";
  if (record.state === "conflict") return "Конфликт копии";
  if (record.state === "deleting") return "Копия удаляется";
  return record.ownership === "primary" ? "Основная копия" : "Рабочая копия";
}
const readinessLabel: Record<string, string> = {
  "Копия подготовится при переходе": "Нет копии",
  "Копия прежнего формата": "Старый формат",
  "Подготовка не завершена": "Подготовка",
  "Копия недоступна": "Недоступна",
  "Конфликт копии": "Конфликт",
  "Копия удаляется": "Удаление",
  "Основная копия": "Исходная",
  "Рабочая копия": "Есть копия",
};
const timeoutMessage =
  "Подготовка заняла больше 300 с. Результат подготовки ещё может завершиться; повтор сначала проверит копию. Предыдущий контекст сохранён.";

/** Selecting waits for a host-validated copy; viewing a card never changes cwd. */
export function TopicContextPicker({
  project,
  board,
  selected,
  knownContexts = [],
  runs = [],
  disabled = false,
  onSelect,
  onTransitionIntent,
  onCreated,
  onClear,
  onOpenCard,
  requestedSelection,
  onSelectionRequestHandled,
}: TopicContextPickerProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
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
  const [focused, setFocused] = useState(0);
  const [preparation, setPreparation] = useState<Preparation>(null);
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
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  useEffect(() => {
    if (
      !requestedSelection ||
      requestedSelection.identity.projectId !== project.id
    )
      return;
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
  }, [requestedSelection]);

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
        topic.ownerLabel = `Копия ${sameIdentity.indexOf(topic) + 1}`;
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
  }, [snapshot, knownContexts, current, project.id, query, selectedKey]);
  const primaryIndex = 0;
  const activeIndex = Math.min(focused, topics.length);
  const activeOption = activeIndex >= 0 ? optionId(activeIndex) : undefined;
  useEffect(() => {
    if (!expanded || activeIndex < 0) return;
    const container = list.current;
    const option = container?.ownerDocument.getElementById(
      optionId(activeIndex),
    );
    if (!option || !container) return;
    if (option.offsetTop < container.scrollTop)
      container.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      container.scrollTop + container.clientHeight
    )
      container.scrollTop =
        option.offsetTop + option.offsetHeight - container.clientHeight;
  }, [expanded, activeIndex, query]);

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
    notifyIntent = true,
  ) {
    if (disabled || trigger.current?.matches(":disabled")) return;
    if (notifyIntent) onTransitionIntent?.();
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
                  throw Error("Создание отменено до изменения проекта");
                if (
                  fresh.projectId !== project.id ||
                  fresh.year !== identity.year
                )
                  throw Error(
                    "Настройки базы относятся к другому проекту или году",
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
                      "Точная проверка рабочей копии недоступна в этой версии хоста.",
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
          "Получена некорректная ссылка рабочей копии. Повторное создание не выполняется.",
        );
      if (typeof window.goga.resolveTopicContext !== "function")
        throw Error(
          "Точная проверка рабочей копии недоступна в этой версии хоста.",
        );
      const resolved = await window.goga.resolveTopicContext(ref.data);
      if (
        !resolved ||
        identityKey(resolved) !== identityKey(record) ||
        resolved.contextId !== record.contextId ||
        resolved.revision !== record.revision
      )
        throw Error(
          "Ответ проверки не соответствует подготовленной рабочей копии. Предыдущий контекст сохранён.",
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
          ? "Проверка рабочей копии заняла больше 300 с. Предыдущий контекст сохранён."
          : timeoutMessage,
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
              "Ответ подготовки не соответствует выбранному топику. Предыдущий контекст сохранён.",
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
              "Рабочая копия пока недоступна. Проверьте конфликт ветки, папку проекта и регистрацию Git; предыдущий контекст сохранён.",
          });
        } else {
          if (flights.current.get(key) === flight) flights.current.delete(key);
          setPreparation(null);
          close(true);
          if (create) onCreated?.(record);
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
            : "Не удалось подготовить рабочую копию.";
        setPreparation({
          state: "error",
          identity,
          create,
          owner,
          message: `${message} Предыдущий контекст сохранён.`,
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
    onTransitionIntent?.();
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
      invalidate();
      setPreparation(null);
      close(true);
      onSelect(topic.record);
    } else prepare(topic.identity, false, topic.record, false);
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
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
        aria-label="Без топика — исходная папка проекта, текущая ветка"
        aria-selected={!current}
        className={`topic-context-option${primaryIndex === activeIndex ? " is-focused" : ""}`}
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => setFocused(primaryIndex)}
        onClick={() => choose(primaryIndex)}
      >
        <div className="topic-context-lines" role="gridcell">
          <strong>Без топика</strong>
          <small>Исходная папка · текущая ветка</small>
          {!current && <span className="topic-context-current">Текущий</span>}
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
  const validNewName =
    /^[\p{L}\p{N}][\p{L}\p{N}_/-]*$/u.test(newName) &&
    newName.length <= 80 &&
    !newName.endsWith("/") &&
    !newName.includes("//");
  return (
    <div
      className="topic-context-picker"
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
          Array.from(
            event.currentTarget.querySelectorAll("[aria-describedby]"),
          ).some((control) =>
            control
              .getAttribute("aria-describedby")
              ?.split(/\s+/)
              .includes(tooltip.id),
          );
        if (
          !hasNativeTopicPopup() &&
          !event.currentTarget.contains(destination as Node) &&
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
              ? `Открыть карточку топика ${headerTarget.topic}`
              : "Без топика"
          }
          onClick={() => {
            if (headerTarget && headerYear)
              onOpenCard(headerTarget, headerYear);
            else if (!headerTarget) show();
          }}
        >
          {headerTarget?.topic ?? "Без топика"}
        </button>
        <button
          type="button"
          className="topic-context-trigger"
          ref={trigger}
          aria-label="Выбрать другой топик"
          aria-haspopup="grid"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
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
      {expanded && (
        <TopicPickerPopup anchor={root} onClose={() => close()}>
          <div
            className="topic-context-popup"
            role="region"
            aria-label="Выбор топика"
            onKeyDown={keyDown}
          >
            <label htmlFor={`${id}-search`}>Найти топик</label>
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
              placeholder="Название топика или ветки"
              onChange={(event) => {
                setQuery(event.target.value);
                setFocused(0);
              }}
            />
            <div
              className="topic-context-options"
              id={listId}
              role="grid"
              aria-label="Топики проекта"
              ref={list}
            >
              {primaryRow()}
              {topics.map((topic, topicIndex) => {
                const index = topicIndex + 1;
                const isCurrent = topic.isCurrent;
                const status = copyStatus(topic.record);
                const activity = contextRunActivity(runs, topic.record ?? null);
                const active = activity.activeBuild ?? activity.activePipeline;
                const activityLabel = active
                  ? `● ${active.kind === "build" ? "Сборка" : "Конвейер"}${active.kind !== "build" && active.pipelineName ? ` «${active.pipelineName}»` : ""}${activity.activeCount > 1 ? ` · ещё ${activity.activeCount - 1}` : ""}`
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
                    aria-label={`${topic.identity.topic} ${topic.identity.branch} ${topic.identity.year}${topic.ownerLabel ? ` ${topic.record?.contextId}` : ""} ${status}${isCurrent ? " Текущий" : ""}${activity.activeCount ? ` Активных: ${activity.activeCount}` : ""}`}
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
                    onPointerMove={() => setFocused(index)}
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
                          {readinessLabel[status]}
                        </span>
                        {isCurrent && (
                          <span className="topic-context-current">Текущий</span>
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
                    ? "Список топиков пока недоступен."
                    : "Совпадений нет."}
                </p>
              )}
            </div>
            {preparation?.state === "busy" && (
              <p className="topic-context-feedback" role="status">
                {preparation.owner
                  ? "Проверяем рабочую копию…"
                  : "Подготавливаем рабочую копию…"}
              </p>
            )}
            {preparation?.state === "error" && (
              <div className="topic-context-feedback">
                <p role="alert">{preparation.message}</p>
                <button
                  type="button"
                  onClick={() =>
                    prepare(
                      preparation.identity,
                      preparation.create,
                      preparation.owner,
                    )
                  }
                >
                  Повторить
                </button>
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
                >
                  Создать «{newName}» и подготовить конвейер
                </button>
                <small id={`${id}-creation-reason`}>
                  {!creationAvailable
                    ? "Создание топика недоступно в этой версии хоста."
                    : validNewName
                      ? "Задачу можно описать на следующем шаге. Конвейер сам не запустится."
                      : "Используйте буквы, цифры, дефис, подчёркивание или /. До 80 символов."}
                </small>
              </div>
            )}
          </div>
        </TopicPickerPopup>
      )}
    </div>
  );
}
