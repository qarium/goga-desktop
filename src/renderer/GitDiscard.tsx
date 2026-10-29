import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ScopeRef } from "../shared/context";
import type {
  GitDiscardPreview,
  GitDiscardRecovery,
  GitDiscardRecoveryPreview,
} from "../shared/git-discard";
import type { GitWorkspaceSnapshot } from "../shared/git-workspace";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { TopicModal, topicError } from "./TopicsCommon";
import "./GitDiscard.css";

/** Retain this in the scoped owner, outside the visibility-bound portal. */
export function useGitDiscard(
  scope: ScopeRef,
  onChanged: (approvedPaths: string[]) => void,
) {
  const [pending, setPending] = useState<
    "prepare" | "execute" | "recovery-prepare" | "recovery-execute" | null
  >(null);
  const [preview, setPreview] = useState<GitDiscardPreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [recovery, setRecovery] = useState<GitDiscardRecovery | null>(null);
  const [recoveryPreview, setRecoveryPreview] =
    useState<GitDiscardRecoveryPreview | null>(null);
  const [inspectionError, setInspectionError] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspectionVersion, setInspectionVersion] = useState(0);
  const inspectionRead = useRef<AbortController | null>(null);
  const inspectionOrder = useRef(0);
  const inspectedRevision = useRef<string | null>(null);
  const recoverySupported =
    typeof window.goga.inspectGitDiscardRecovery === "function";
  const recoveryActionsSupported =
    typeof window.goga.prepareGitDiscardRecovery === "function" &&
    typeof window.goga.executeGitDiscardRecovery === "function";
  const owner = documentScopeId(scope);
  const currentOwner = useRef(owner);
  currentOwner.current = owner;
  const generation = useRef(0);
  const flight = useRef(false);
  const alive = useRef(true);
  const read = useRef<AbortController | null>(null);
  const supported =
    typeof window.goga.prepareGitDiscard === "function" &&
    typeof window.goga.executeGitDiscard === "function";
  useLayoutEffect(() => {
    alive.current = true;
    flight.current = false;
    setPending(null);
    setPreview(null);
    setPreviewRevision(null);
    setResult("");
    setUncertain(false);
    setRecovery(null);
    setRecoveryPreview(null);
    setInspectionError("");
    setInspecting(false);
    inspectedRevision.current = null;
    return () => {
      alive.current = false;
      generation.current++;
      read.current?.abort();
      inspectionRead.current?.abort();
      inspectionOrder.current++;
    };
  }, [owner]);
  const current = (epoch: number) =>
    alive.current &&
    generation.current === epoch &&
    currentOwner.current === owner;
  // Stable callback: render-time object identity must not schedule another read.
  const inspect = useCallback(
    (snapshot: GitWorkspaceSnapshot) => {
      if (!recoverySupported || documentScopeId(snapshot.scope) !== owner)
        return;
      inspectedRevision.current = snapshot.revision;
      if (flight.current) return;
      const controller = new AbortController();
      const order = ++inspectionOrder.current;
      const epoch = generation.current;
      inspectionRead.current?.abort();
      inspectionRead.current = controller;
      setInspecting(true);
      setRecovery(null);
      setRecoveryPreview(null);
      setInspectionError("");
      const valid = () =>
        alive.current &&
        currentOwner.current === owner &&
        generation.current === epoch &&
        inspectionOrder.current === order &&
        !controller.signal.aborted;
      void readWithSignal(
        controller.signal,
        "inspectGitDiscardRecovery",
        snapshot.scope,
      )
        .then((value) => {
          if (!valid()) return;
          if (
            documentScopeId(value.scope) !== owner ||
            value.revision !== snapshot.revision
          ) {
            setInspectionError(
              "Состояние отмены изменилось во время проверки. Повторите проверку отмены.",
            );
            return;
          }
          setRecovery(value);
          setUncertain(value.state === "partial" || value.state === "blocked");
        })
        .catch((error) => {
          if (valid()) setInspectionError(topicError(error));
        })
        .finally(() => {
          if (valid()) {
            setInspecting(false);
            inspectionRead.current = null;
          }
        });
      return () => {
        controller.abort();
        if (inspectionOrder.current === order) {
          inspectionOrder.current++;
          inspectionRead.current = null;
          setInspecting(false);
        }
      };
    },
    [owner, recoverySupported],
  );
  const recoveryLocked =
    recoverySupported &&
    (inspecting ||
      !!inspectionError ||
      !recovery ||
      recovery.state === "partial" ||
      recovery.state === "blocked");
  const prepare = async (snapshot: GitWorkspaceSnapshot, paths: string[]) => {
    if (
      flight.current ||
      preview ||
      uncertain ||
      recoveryLocked ||
      !!recoveryPreview ||
      !supported ||
      !paths.length ||
      documentScopeId(snapshot.scope) !== owner ||
      snapshot.operation !== "none" ||
      snapshot.files.some((f) => f.kind === "conflict") ||
      paths.some((p) => !snapshot.files.some((f) => f.path === p))
    )
      return;
    const epoch = generation.current;
    flight.current = true;
    setPending("prepare");
    setResult("");
    const controller = new AbortController();
    read.current = controller;
    try {
      const value = await readWithSignal(
        controller.signal,
        "prepareGitDiscard",
        {
          scope,
          revision: snapshot.revision,
          paths: [...paths],
        },
      );
      if (!current(epoch)) return;
      if (documentScopeId(value.scope) !== owner)
        throw Error("Подтверждение относится к другому контексту.");
      setPreview(value);
      setPreviewRevision(snapshot.revision);
    } catch (error) {
      if (current(epoch)) setResult(topicError(error));
    } finally {
      if (current(epoch)) {
        flight.current = false;
        read.current = null;
        setPending(null);
        if (
          recoverySupported &&
          inspectedRevision.current !== snapshot.revision
        )
          setInspectionVersion((n) => n + 1);
      }
    }
  };
  const execute = async () => {
    if (flight.current || !preview || uncertain || recoveryLocked) return;
    const epoch = generation.current;
    const submitted = preview;
    if (submitted.expiresAt <= Date.now()) {
      setPreview(null);
      setResult(
        "Подтверждение устарело. Обновите изменения и проверьте выбранные файлы заново.",
      );
      return;
    }
    inspectionOrder.current++;
    inspectionRead.current?.abort();
    flight.current = true;
    setPending("execute");
    setPreview(null);
    let approved: string[] = [];
    try {
      // Navigation cancels reads only. A write must return its real host outcome.
      const value = await window.goga.executeGitDiscard(submitted.token);
      if (!current(epoch)) return;
      if (documentScopeId(value.scope) !== owner)
        throw Error(
          "Результат относится к другому контексту. Проверьте состояние Git.",
        );
      const succeeded =
        value.status === "discarded" &&
        value.indexPublished &&
        value.worktreePublished;
      if (succeeded) approved = submitted.paths;
      setUncertain(
        !succeeded &&
          (value.status !== "not-discarded" ||
            value.indexPublished ||
            value.worktreePublished ||
            !!value.changedPaths.length ||
            !!value.trashedPaths.length ||
            !!value.recoveryPath),
      );
      setResult(
        [
          value.message,
          value.log,
          value.recoveryPath &&
            `Материалы восстановления: ${value.recoveryPath}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    } catch (error) {
      if (current(epoch)) {
        setUncertain(true);
        setResult(
          `${topicError(error)}\n\nПроверьте состояние Git перед новой попыткой: ответ не подтверждает, что файлы не были изменены. Автоматического повтора не будет.`,
        );
      }
    } finally {
      if (current(epoch)) {
        flight.current = false;
        setPending(null);
        // Even a failed write may have changed disk state. Only full success clears selection.
        onChanged(approved);
        setInspectionVersion((n) => n + 1);
      }
    }
  };
  const prepareRecovery = async (snapshot: GitWorkspaceSnapshot) => {
    if (
      flight.current ||
      inspecting ||
      !recoveryActionsSupported ||
      recovery?.state !== "partial" ||
      recovery.revision !== snapshot.revision ||
      documentScopeId(snapshot.scope) !== owner
    )
      return;
    const epoch = generation.current;
    const controller = new AbortController();
    read.current = controller;
    flight.current = true;
    setPending("recovery-prepare");
    setResult("");
    try {
      const value = await readWithSignal(
        controller.signal,
        "prepareGitDiscardRecovery",
        { scope, revision: snapshot.revision },
      );
      if (!current(epoch)) return;
      if (
        documentScopeId(value.scope) !== owner ||
        value.revision !== snapshot.revision ||
        inspectedRevision.current !== snapshot.revision
      )
        throw Error(
          "Подтверждение сохранения относится к другому или устаревшему контексту.",
        );
      setRecoveryPreview(value);
    } catch (error) {
      if (current(epoch)) setResult(topicError(error));
    } finally {
      if (current(epoch)) {
        flight.current = false;
        read.current = null;
        setPending(null);
        if (
          recoverySupported &&
          inspectedRevision.current !== snapshot.revision
        )
          setInspectionVersion((n) => n + 1);
      }
    }
  };
  const executeRecovery = async () => {
    if (flight.current || !recoveryPreview) return;
    const submitted = recoveryPreview;
    if (
      submitted.expiresAt <= Date.now() ||
      inspectedRevision.current !== submitted.revision
    ) {
      setRecoveryPreview(null);
      setResult("Подтверждение устарело. Проверьте состояние отмены заново.");
      return;
    }
    const epoch = generation.current;
    flight.current = true;
    setPending("recovery-execute");
    setRecoveryPreview(null);
    try {
      const value = await window.goga.executeGitDiscardRecovery(
        submitted.token,
      );
      if (!current(epoch)) return;
      if (
        documentScopeId(value.scope) !== owner ||
        value.status !== "recovered"
      )
        throw Error(
          "Сохранение текущего состояния не подтверждено для этого контекста.",
        );
      setResult(value.message);
    } catch (error) {
      if (current(epoch)) setResult(topicError(error));
    } finally {
      if (current(epoch)) {
        flight.current = false;
        setPending(null);
        onChanged([]);
        setInspectionVersion((n) => n + 1);
      }
    }
  };
  return {
    supported,
    recovery,
    recoveryPreview,
    recoveryActionsSupported,
    inspecting,
    inspectionError,
    inspectionVersion,
    inspect,
    prepareRecovery,
    executeRecovery,
    retryInspection: () => setInspectionVersion((n) => n + 1),
    closeRecoveryPreview: () => {
      if (!flight.current) setRecoveryPreview(null);
    },
    pending,
    preview,
    previewRevision,
    result,
    uncertain,
    canDiscard: !recoveryLocked,
    locked:
      !!pending ||
      !!preview ||
      !!recoveryPreview ||
      uncertain ||
      inspecting ||
      !!inspectionError,
    modalOpen: !!preview || !!recoveryPreview || !!result,
    prepare,
    execute,
    cancelPrepare: () => {
      if (!read.current) return;
      generation.current++;
      read.current.abort();
      read.current = null;
      flight.current = false;
      setPending(null);
    },
    closePreview: () => {
      if (!flight.current) setPreview(null);
    },
    closeResult: () => setResult(""),
    // Compatibility only: supported hosts require recovery inspection, not a workspace read.
    manualRefresh: () => {
      if (!flight.current && !recoverySupported) setUncertain(false);
    },
  };
}
type DiscardState = ReturnType<typeof useGitDiscard>;
export function GitDiscardFooter({
  discard,
  snapshot,
  selectedPaths,
  disabled,
  visible,
  ready = true,
}: {
  discard: DiscardState;
  snapshot: GitWorkspaceSnapshot | null;
  selectedPaths: string[];
  disabled: boolean;
  visible: boolean;
  ready?: boolean;
}) {
  useEffect(() => {
    if (
      (!visible || disabled) &&
      (discard.pending === "prepare" || discard.pending === "recovery-prepare")
    )
      discard.cancelPrepare();
  }, [visible, disabled, discard.pending, discard.cancelPrepare]);
  const snapshotOwner = snapshot ? documentScopeId(snapshot.scope) : null;
  useEffect(() => {
    if (visible && ready && snapshot) return discard.inspect(snapshot);
  }, [
    visible,
    ready,
    snapshotOwner,
    snapshot?.revision,
    discard.inspectionVersion,
    discard.inspect,
  ]);
  const unsafe =
    disabled ||
    !snapshot ||
    snapshot.operation !== "none" ||
    snapshot.files.some((f) => f.kind === "conflict");
  const unavailable =
    !snapshot ||
    !selectedPaths.length ||
    selectedPaths.some((p) => !snapshot.files.some((f) => f.path === p));
  const stale =
    !!discard.preview &&
    (!snapshot ||
      snapshot.revision !== discard.previewRevision ||
      documentScopeId(snapshot.scope) !==
        documentScopeId(discard.preview.scope));
  return (
    <>
      <div className="git-discard-footer">
        <button
          type="button"
          className="danger"
          disabled={
            !discard.supported ||
            !discard.canDiscard ||
            unsafe ||
            unavailable ||
            discard.locked
          }
          onClick={() => {
            if (snapshot) void discard.prepare(snapshot, selectedPaths);
          }}
        >
          Отменить изменения…
        </button>
        <p role={discard.pending ? "status" : undefined}>
          {discard.pending === "prepare"
            ? "Проверяем выбранные файлы для отмены…"
            : discard.pending === "execute"
              ? "Отменяем выбранные изменения…"
              : discard.pending === "recovery-prepare"
                ? "Проверяем сохранение текущего состояния…"
                : discard.pending === "recovery-execute"
                  ? "Завершаем проверку прежней отмены…"
                  : discard.inspecting
                    ? "Проверяем состояние прежней отмены…"
                    : discard.inspectionError ||
                      discard.recovery?.message ||
                      (discard.uncertain
                        ? "Результат прежней отмены не подтверждён. Автоматического повтора не будет."
                        : "Отмена затронет выбранные файлы целиком, включая подготовленные изменения.")}
        </p>
        {discard.inspectionError && (
          <button
            type="button"
            disabled={!!discard.pending || !ready}
            onClick={discard.retryInspection}
          >
            Повторить проверку отмены
          </button>
        )}
        {discard.recovery?.state === "partial" && (
          <button
            type="button"
            disabled={
              unsafe ||
              !!discard.pending ||
              discard.inspecting ||
              !discard.recoveryActionsSupported
            }
            onClick={() => {
              if (snapshot) void discard.prepareRecovery(snapshot);
            }}
          >
            Оставить текущее состояние…
          </button>
        )}
        {(discard.recovery?.state === "partial" ||
          discard.recovery?.state === "blocked") && (
          <div className="git-discard-recovery-details">
            <p>
              Новая отмена недоступна до проверки прежней попытки.
              Автоматического повтора не будет.
            </p>
            <RecoveryPaths paths={discard.recovery.paths} />
            {discard.recovery.state === "blocked" && (
              <button
                type="button"
                disabled={!!discard.pending || discard.inspecting || !ready}
                onClick={discard.retryInspection}
              >
                Повторить проверку отмены
              </button>
            )}
          </div>
        )}
      </div>
      {visible && discard.recoveryPreview && (
        <TopicModal
          title="Оставить текущее состояние"
          closeLabel="Закрыть подтверждение текущего состояния"
          className="git-commit-modal git-discard-confirmation"
          onClose={discard.closeRecoveryPreview}
        >
          <div className="git-commit-preview">
            <p>{discard.recoveryPreview.message}</p>
            <p>
              Будет удалён служебный снимок прежней отмены и снята её
              блокировка. Файлы, индекс и HEAD не изменятся. Прежняя отмена не
              будет повторена.
            </p>
            <p>
              Текущее состояние файлов останется как есть. Это не восстановление
              отменённых изменений.
            </p>
            <dl>
              <dt>Рабочая папка</dt>
              <dd>{discard.recoveryPreview.root}</dd>
            </dl>
            <RecoveryPaths paths={discard.recoveryPreview.paths} />
            <div className="git-discard-confirm-actions">
              <button
                type="button"
                disabled={
                  unsafe ||
                  !!discard.pending ||
                  !snapshot ||
                  snapshot.revision !== discard.recoveryPreview.revision ||
                  snapshotOwner !==
                    documentScopeId(discard.recoveryPreview.scope)
                }
                onClick={() => void discard.executeRecovery()}
              >
                Оставить текущее состояние и продолжить
              </button>
            </div>
          </div>
        </TopicModal>
      )}
      {visible && discard.preview && (
        <TopicModal
          title="Подтвердить отмену изменений"
          closeLabel="Закрыть подтверждение отмены"
          className="git-commit-modal git-discard-confirmation"
          onClose={discard.closePreview}
        >
          <div className="git-commit-preview">
            <p>
              Выбранные файлы будут восстановлены целиком из HEAD.
              Подготовленные изменения выбранных файлов тоже будут отменены.
              Остальные файлы и их подготовленные изменения сохранятся.
            </p>
            <p>
              Новые файлы, которых нет в HEAD, будут перемещены в системную
              Корзину. Для переименований ниже перечислены оба затрагиваемых
              пути.
            </p>
            <dl>
              <dt>Рабочая папка</dt>
              <dd>{discard.preview.root}</dd>
              <dt>Ветка</dt>
              <dd>{discard.preview.branch ?? "Отсоединённый HEAD"}</dd>
              <dt>HEAD</dt>
              <dd>{discard.preview.head ?? "Нет коммитов"}</dd>
            </dl>
            {discard.preview.recoveryMessage && (
              <p>{discard.preview.recoveryMessage}</p>
            )}
            <strong>Восстановить из HEAD</strong>
            <ul>
              {discard.preview.items
                .filter((item) => item.action === "restore")
                .map((item) => (
                  <li key={item.path}>
                    <code>{item.path}</code>
                  </li>
                ))}
            </ul>
            <strong>Переместить в Корзину</strong>
            <ul>
              {discard.preview.items
                .filter((item) => item.action === "trash")
                .map((item) => (
                  <li key={item.path}>
                    <code>{item.path}</code>
                  </li>
                ))}
            </ul>
            <p>
              Коммит не создаётся, публикация и синхронизация не выполняются.
              При изменении состояния Git потребуется новое подтверждение.
            </p>
            <p>
              После успешной проверки резервная копия удаляется. Отменённые
              изменения отслеживаемых файлов из неё восстановить будет нельзя.
              При ошибке материалы восстановления сохраняются.
            </p>
            {stale && (
              <p role="alert">
                Подтверждение устарело. Закройте его и проверьте выбранные файлы
                заново.
              </p>
            )}
            <div className="git-discard-confirm-actions">
              <button
                type="button"
                className="danger"
                disabled={
                  unsafe ||
                  stale ||
                  !!discard.pending ||
                  discard.uncertain ||
                  discard.inspecting ||
                  !!discard.inspectionError
                }
                onClick={() => void discard.execute()}
              >
                Отменить выбранные изменения
              </button>
            </div>
          </div>
        </TopicModal>
      )}
      {visible && discard.result && (
        <TopicModal
          title="Результат отмены изменений"
          closeLabel="Закрыть результат отмены"
          className="git-workspace-error"
          onClose={discard.closeResult}
        >
          <pre>{discard.result}</pre>
        </TopicModal>
      )}
    </>
  );
}

function RecoveryPaths({ paths }: { paths: GitDiscardRecovery["paths"] }) {
  const labels = {
    unchanged: "совпадает со снимком до прежней попытки",
    restored: "соответствует версии HEAD прежней попытки",
    changed: "отличается от прежнего снимка",
  };
  return (
    <ul>
      {paths.map((item) => (
        <li key={item.path}>
          <code>{item.path}</code> — {labels[item.state]}
        </li>
      ))}
    </ul>
  );
}
