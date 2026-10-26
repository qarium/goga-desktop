import {
  formatGitDiagnostics,
  hasGitDiagnostics,
} from "./git-operation-diagnostics";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GitMergeConfirmation, GitMergeSource } from "./GitMergeDialogs";
import type {
  GitBranchInventory,
  GitBranchPreview,
  GitBranchRequest,
} from "../shared/git-branches";
import { TopicPickerPopup, dismissActiveTopicPopup } from "./TopicPickerPopup";
import { TopicModal, topicError } from "./TopicsCommon";
import { LoadingState } from "./LoadingBoundary";
import { readWithSignal } from "./read-request";
import { useViewActive } from "./RetainedViews";
import "./GitBranchPicker.css";
const labels: Record<GitBranchRequest["action"], string> = {
  create: "Создать ветку",
  "switch-local": "Переключить ветку",
  "switch-remote": "Создать отслеживающую ветку",
  fetch: "Обновить список из remote",
  pull: "Подтянуть текущую ветку",
  merge: "Подтвердить слияние",
  "abort-merge": "Отменить слияние?",
};
const short = (ref: string | null) =>
  ref?.replace(/^refs\/(heads|remotes)\//, "") ?? "—";
interface Props {
  projectId: string;
  branch: string;
  revision: number;
  disabled?: boolean;
  mutationBlockedReason?: string;
  onChanged(projectId: string): void;
  onOverlayChange?(projectId: string, visible: boolean): void;
  onBusyChange?(busy: boolean): void;
  onShowChanges?(): void;
  operation?: GitBranchInventory["operation"];
  abortContainer?: HTMLElement | null;
}
/** Instance belongs to one retained primary project, never the current selector. */
export function GitBranchPicker(props: Props) {
  return <BranchOwner key={props.projectId} {...props} />;
}
function BranchOwner({
  projectId,
  branch,
  revision,
  disabled = false,
  mutationBlockedReason,
  onChanged,
  onOverlayChange,
  onBusyChange,
  onShowChanges,
  operation,
  abortContainer,
}: Props) {
  const active = useViewActive();
  const [open, setOpen] = useState(false),
    [group, setGroup] = useState<"local" | "remote">("local"),
    [query, setQuery] = useState("");
  const [inventory, setInventory] = useState<GitBranchInventory | null>(null),
    [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false),
    [merging, setMerging] = useState(false),
    [name, setName] = useState(""),
    [switchTo, setSwitchTo] = useState(true);
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null),
    [preview, setPreview] = useState<GitBranchPreview | null>(null);
  const [result, setResult] = useState(""),
    [resultConflict, setResultConflict] = useState(false),
    [attempt, setAttempt] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const alive = useRef(true),
    flight = useRef(false),
    preparing = useRef<AbortController | null>(null);
  const done = useRef(onChanged);
  done.current = onChanged;
  const available = useRef(active && !disabled && !mutationBlockedReason);
  available.current = active && !disabled && !mutationBlockedReason;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      preparing.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active || disabled) {
      setOpen(false);
      setCreating(false);
      setMerging(false);
      setPreview(null);
      preparing.current?.abort();
    }
  }, [active, disabled]);
  useEffect(() => {
    if (mutationBlockedReason) {
      setCreating(false);
      setMerging(false);
      setPreview(null);
      preparing.current?.abort();
    }
  }, [mutationBlockedReason]);
  useEffect(() => {
    if (!active || !open || disabled) return;
    const controller = new AbortController();
    setLoading(true);
    setInventory(null);
    void readWithSignal(controller.signal, "readGitBranches", projectId)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.projectId !== projectId)
          throw Error("Список веток относится к другому проекту.");
        setInventory(value);
      })
      .catch(async (error) => {
        if (controller.signal.aborted) return;
        setOpen(false);
        await dismissActiveTopicPopup().catch(() => {});
        if (alive.current) setResult(topicError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, open, disabled, projectId, revision, attempt]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !anchor.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const presentation = useRef({ onOverlayChange, onBusyChange });
  presentation.current = { onOverlayChange, onBusyChange };
  const modalVisible =
    active &&
    (creating || merging || pending === "prepare" || !!preview || !!result);
  useLayoutEffect(() => {
    presentation.current.onOverlayChange?.(projectId, modalVisible);
    return () => presentation.current.onOverlayChange?.(projectId, false);
  }, [projectId, modalVisible]);
  useEffect(() => {
    presentation.current.onBusyChange?.(!!pending);
    return () => presentation.current.onBusyChange?.(false);
  }, [pending]);
  const ready =
    !!inventory && !loading && !pending && !disabled && !mutationBlockedReason;
  const mutable = ready && inventory.operation === "none";
  function closeResult() {
    setResult("");
    setResultConflict(false);
  }
  async function hideMenu() {
    setOpen(false);
    await dismissActiveTopicPopup();
  }
  async function prepare(input: GitBranchRequest | "abort-merge") {
    if (flight.current || !available.current) return;
    flight.current = true;
    setPending("prepare");
    setCreating(false);
    setMerging(false);
    setResult("");
    setResultConflict(false);
    const controller = new AbortController();
    preparing.current = controller;
    try {
      await hideMenu();
      if (controller.signal.aborted) return;
      // The workspace abort action can be opened with the branch menu closed.
      // Read a fresh owner-bound revision instead of reusing an old menu snapshot.
      let request: GitBranchRequest;
      if (input === "abort-merge") {
        const current = await readWithSignal(
          controller.signal,
          "readGitBranches",
          projectId,
        );
        if (controller.signal.aborted || !alive.current) return;
        if (current.projectId !== projectId)
          throw Error("Список веток относится к другому проекту.");
        request = {
          projectId,
          revision: current.revision,
          action: "abort-merge",
        };
      } else request = input;
      const value = await readWithSignal(
        controller.signal,
        "prepareGitBranch",
        request,
      );
      if (!alive.current || controller.signal.aborted) return;
      if (value.projectId !== projectId || value.action !== request.action)
        throw Error("Подтверждение относится к другой операции.");
      setPreview(value);
    } catch (error) {
      if (alive.current && !controller.signal.aborted)
        setResult(topicError(error));
    } finally {
      flight.current = false;
      if (preparing.current === controller) preparing.current = null;
      if (alive.current) setPending(null);
    }
  }
  async function execute() {
    if (flight.current || !preview || !available.current) return;
    const submitted = preview;
    flight.current = true;
    setPreview(null);
    setPending("execute");
    try {
      const value = await window.goga.executeGitBranch(submitted.token);
      if (!alive.current) return;
      if (value.projectId !== projectId || value.action !== submitted.action)
        throw Error(
          "Результат относится к другой операции. Проверьте состояние Git.",
        );
      if (hasGitDiagnostics(value)) {
        setResultConflict(value.status === "conflict");
        setResult(formatGitDiagnostics(value));
      }
    } catch (error) {
      if (alive.current)
        setResult(
          `${topicError(error)}\n\nПроверьте состояние Git: ответ не подтверждает отсутствие изменений. Автоматического повтора не будет.`,
        );
    } finally {
      flight.current = false;
      // Also refresh after refusal: fetch or a native operation may be partially applied.
      done.current(projectId);
      if (alive.current) {
        setPending(null);
        setInventory(null);
        setAttempt((n) => n + 1);
      }
    }
  }
  const basicRequest = inventory
    ? { projectId, revision: inventory.revision }
    : null;
  const rows = (inventory?.[group] ?? []).filter((row) =>
    row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="git-branch-picker">
      <button
        ref={anchor}
        type="button"
        className="git-workspace-trigger git-branch-trigger"
        aria-label={`Ветка: ${branch}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled || !!pending}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          style={{ flexShrink: 0 }}
        >
          <path d="M6 3v12" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span>{branch}</span>
      </button>
      {pending === "execute" && (
        <span className="git-branch-running" role="status">
          Операция Git…
        </span>
      )}
      {active &&
        operation === "merge" &&
        abortContainer &&
        createPortal(
          <button
            type="button"
            className="danger"
            disabled={disabled || !!pending || !!mutationBlockedReason}
            onClick={() => void prepare("abort-merge")}
          >
            Отменить слияние…
          </button>,
          abortContainer,
        )}
      {active && open && (
        <TopicPickerPopup
          anchor={anchor}
          onClose={() => setOpen(false)}
          label="Выбор ветки"
          width={376}
        >
          <div
            ref={menu}
            className="git-branch-menu"
            role="dialog"
            aria-label="Выбор ветки"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                anchor.current?.focus();
              }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    ".git-branch-list button:not(:disabled)",
                  ),
                ];
                if (!buttons.length) return;
                const index = buttons.indexOf(
                  event.target as HTMLButtonElement,
                );
                const next =
                  event.key === "ArrowDown"
                    ? (index + 1) % buttons.length
                    : index <= 0
                      ? buttons.length - 1
                      : index - 1;
                event.preventDefault();
                buttons[next]?.focus();
              }
            }}
          >
            <div
              className="git-branch-groups"
              role="tablist"
              aria-label="Источник веток"
            >
              {(
                [
                  ["local", "Локальные"],
                  ["remote", "Remote"],
                ] as const
              ).map(([key, label]) => (
                <button
                  type="button"
                  key={key}
                  role="tab"
                  aria-selected={group === key}
                  onClick={() => {
                    setGroup(key);
                    setQuery("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="search"
              aria-label="Найти ветку"
              placeholder="Найти ветку"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            {loading ? (
              <LoadingState label="Загружаем ветки…" />
            ) : (
              <div
                className="git-branch-list"
                role="tabpanel"
                aria-label={
                  group === "local" ? "Локальные ветки" : "Удалённые ветки"
                }
              >
                {rows.map((row) => (
                  <button
                    key={row.ref}
                    type="button"
                    aria-label={row.name}
                    disabled={
                      !mutable ||
                      inventory?.dirty ||
                      row.checkedOut ||
                      (group === "local" && row.name === inventory?.branch)
                    }
                    onClick={() =>
                      basicRequest &&
                      void prepare({
                        ...basicRequest,
                        action:
                          group === "local" ? "switch-local" : "switch-remote",
                        ref: row.ref,
                      })
                    }
                  >
                    <span>{row.name}</span>
                    <small>
                      {group === "local" && row.name === inventory?.branch
                        ? "Текущая"
                        : row.checkedOut
                          ? "Открыта в другой копии"
                          : group === "remote"
                            ? "Создать локальную и переключиться"
                            : "Переключиться"}
                    </small>
                  </button>
                ))}
                {!rows.length && <p className="hint">Ветки не найдены</p>}
              </div>
            )}
            {mutationBlockedReason && (
              <p className="hint" role="status">
                {mutationBlockedReason}
              </p>
            )}
            {inventory?.operation !== "none" && inventory && (
              <p className="hint">
                Завершите текущую операцию Git перед изменением веток.
              </p>
            )}
            {inventory?.dirty && (
              <p className="hint">
                Для переключения сохраните изменения коммитом. Создание ветки
                без переключения доступно.
              </p>
            )}
            <div className="git-branch-menu-actions">
              {ready && inventory?.operation === "merge" && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void prepare("abort-merge")}
                >
                  Отменить слияние…
                </button>
              )}
              {group === "local" ? (
                <>
                  <button
                    type="button"
                    disabled={!mutable || !inventory?.head}
                    onClick={async () => {
                      try {
                        await hideMenu();
                        if (!alive.current || !available.current) return;
                        setSwitchTo(!inventory?.dirty);
                        setCreating(true);
                      } catch (e) {
                        setResult(topicError(e));
                      }
                    }}
                  >
                    Создать ветку…
                  </button>
                  <button
                    type="button"
                    disabled={!mutable || !inventory?.branch || !inventory.head}
                    onClick={async () => {
                      try {
                        await hideMenu();
                        if (alive.current && available.current)
                          setMerging(true);
                      } catch (e) {
                        if (alive.current) setResult(topicError(e));
                      }
                    }}
                  >
                    Влить ветку в текущую…
                  </button>
                  <button
                    type="button"
                    disabled={
                      !mutable || !inventory?.branch || !inventory?.upstream
                    }
                    onClick={() =>
                      basicRequest &&
                      void prepare({ ...basicRequest, action: "pull" })
                    }
                  >
                    Подтянуть текущую ветку
                  </button>
                  <small>
                    Только fast-forward из настроенной upstream-ветки.
                  </small>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!mutable}
                    onClick={() =>
                      basicRequest &&
                      void prepare({ ...basicRequest, action: "fetch" })
                    }
                  >
                    Обновить список из remote
                  </button>
                  <small>
                    Из origin. Рабочие файлы и текущая ветка не меняются.
                  </small>
                </>
              )}
            </div>
          </div>
        </TopicPickerPopup>
      )}
      {active && merging && inventory && (
        <GitMergeSource
          inventory={inventory}
          onClose={() => setMerging(false)}
          onSelect={(ref) =>
            basicRequest &&
            void prepare({ ...basicRequest, action: "merge", ref })
          }
        />
      )}
      {active && creating && (
        <TopicModal title="Создать ветку" onClose={() => setCreating(false)}>
          <form
            className="git-branch-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (basicRequest)
                void prepare({
                  ...basicRequest,
                  action: "create",
                  name,
                  switch: switchTo && !inventory?.dirty,
                });
            }}
          >
            <label>
              Название ветки
              <input
                autoFocus
                aria-label="Название ветки"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={1024}
              />
            </label>
            <label className="git-branch-check">
              <input
                type="checkbox"
                checked={switchTo && !inventory?.dirty}
                disabled={inventory?.dirty}
                onChange={(event) => setSwitchTo(event.target.checked)}
              />
              Переключиться на новую ветку
            </label>
            <p className="hint">
              От текущего HEAD · {inventory?.head?.slice(0, 8)}. Создание
              Git-ветки не создаёт топик.
            </p>
            {inventory?.dirty && (
              <p className="hint">
                Есть незакоммиченные изменения. Ветка будет создана без
                переключения.
              </p>
            )}
            <div className="git-branch-dialog-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Отмена
              </button>
              <button type="submit" className="primary" disabled={!name.trim()}>
                Продолжить
              </button>
            </div>
          </form>
        </TopicModal>
      )}
      {active && pending === "prepare" && (
        <TopicModal
          title="Проверяем операцию Git"
          onClose={() => {
            preparing.current?.abort();
            setPending(null);
          }}
        >
          <LoadingState label="Проверяем операцию Git…" />
        </TopicModal>
      )}
      {active &&
        preview &&
        (preview.action === "merge" || preview.action === "abort-merge") && (
          <GitMergeConfirmation
            preview={preview}
            onClose={() => setPreview(null)}
            onConfirm={() => void execute()}
          />
        )}
      {active &&
        preview &&
        preview.action !== "merge" &&
        preview.action !== "abort-merge" && (
          <TopicModal
            title={labels[preview.action]}
            onClose={() => setPreview(null)}
          >
            <div className="git-branch-form">
              <p className="context-path">{preview.root}</p>
              <dl className="git-branch-summary">
                <dt>Текущая ветка</dt>
                <dd>
                  {short(preview.fromRef)} ·{" "}
                  {preview.fromOid?.slice(0, 8) ?? "—"}
                </dd>
                {preview.action === "pull" ? (
                  <>
                    <dt>Источник</dt>
                    <dd>{short(preview.sourceRef)}</dd>
                    <dt>Последний известный коммит</dt>
                    <dd>{preview.toOid?.slice(0, 8) ?? "Ещё не загружен"}</dd>
                  </>
                ) : (
                  preview.toRef && (
                    <>
                      <dt>Целевая ветка</dt>
                      <dd>
                        {short(preview.toRef)}{" "}
                        {preview.toOid && `· ${preview.toOid.slice(0, 8)}`}
                      </dd>
                    </>
                  )
                )}
                {preview.remote && (
                  <>
                    <dt>Remote</dt>
                    <dd>{preview.remote}</dd>
                  </>
                )}
              </dl>
              <p>
                {preview.action === "fetch"
                  ? "Обновится список веток origin. Рабочие файлы останутся без изменений."
                  : preview.action === "pull"
                    ? "Получим свежие изменения upstream и применим только fast-forward. При расхождении операция остановится."
                    : preview.switchesBranch
                      ? "Переключение изменит файлы основной папки. Незакоммиченные изменения блокируют переключение."
                      : "Ветка будет создана без изменения рабочих файлов."}
              </p>
              <p className="hint">
                Без force, stash и сброса изменений. Git-хуки отключены.
              </p>
              <div className="git-branch-dialog-actions">
                <button type="button" onClick={() => setPreview(null)}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void execute()}
                >
                  Подтвердить
                </button>
              </div>
            </div>
          </TopicModal>
        )}
      {active && result && (
        <TopicModal
          title={
            resultConflict
              ? "Слияние остановлено: конфликты"
              : "Результат операции Git"
          }
          onClose={closeResult}
        >
          <pre className="git-branch-log">{result}</pre>
          <div className="git-branch-dialog-actions">
            {resultConflict && onShowChanges && (
              <button
                type="button"
                onClick={() => {
                  closeResult();
                  onShowChanges();
                }}
              >
                Просмотреть конфликты
              </button>
            )}
            <button type="button" onClick={closeResult}>
              Закрыть
            </button>
          </div>
        </TopicModal>
      )}
    </div>
  );
}
