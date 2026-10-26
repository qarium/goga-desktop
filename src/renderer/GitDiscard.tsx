import { useEffect, useRef, useState } from "react";
import type { ScopeRef } from "../shared/context";
import type { GitDiscardPreview } from "../shared/git-discard";
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
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [preview, setPreview] = useState<GitDiscardPreview | null>(null);
  const [previewRevision, setPreviewRevision] = useState<string | null>(null);
  const [result, setResult] = useState("");
  const [uncertain, setUncertain] = useState(false);
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
  useEffect(() => {
    alive.current = true;
    flight.current = false;
    setPending(null);
    setPreview(null);
    setPreviewRevision(null);
    setResult("");
    setUncertain(false);
    return () => {
      alive.current = false;
      generation.current++;
      read.current?.abort();
    };
  }, [owner]);
  const current = (epoch: number) =>
    alive.current &&
    generation.current === epoch &&
    currentOwner.current === owner;
  const prepare = async (snapshot: GitWorkspaceSnapshot, paths: string[]) => {
    if (
      flight.current ||
      preview ||
      uncertain ||
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
      }
    }
  };
  const execute = async () => {
    if (flight.current || !preview || uncertain) return;
    const epoch = generation.current;
    const submitted = preview;
    if (submitted.expiresAt <= Date.now()) {
      setPreview(null);
      setResult(
        "Подтверждение устарело. Обновите изменения и проверьте выбранные файлы заново.",
      );
      return;
    }
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
      }
    }
  };
  return {
    supported,
    pending,
    preview,
    previewRevision,
    result,
    uncertain,
    locked: !!pending || !!preview || uncertain,
    modalOpen: !!preview || !!result,
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
    // Call only after a successful fresh workspace read, never at refresh start.
    manualRefresh: () => {
      if (!flight.current) setUncertain(false);
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
}: {
  discard: DiscardState;
  snapshot: GitWorkspaceSnapshot | null;
  selectedPaths: string[];
  disabled: boolean;
  visible: boolean;
}) {
  useEffect(() => {
    if ((!visible || disabled) && discard.pending === "prepare")
      discard.cancelPrepare();
  }, [visible, disabled, discard.pending, discard.cancelPrepare]);
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
            !discard.supported || unsafe || unavailable || discard.locked
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
              : discard.uncertain
                ? "Сначала обновите изменения и проверьте состояние Git. Автоматического повтора не будет."
                : "Отмена затронет выбранные файлы целиком, включая подготовленные изменения."}
        </p>
      </div>
      {visible && discard.preview && (
        <TopicModal
          title="Подтвердить отмену изменений"
          closeLabel="Закрыть подтверждение отмены"
          className="git-commit-modal"
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
            {stale && (
              <p role="alert">
                Подтверждение устарело. Закройте его и проверьте выбранные файлы
                заново.
              </p>
            )}
            <button
              type="button"
              className="danger"
              disabled={
                unsafe || stale || !!discard.pending || discard.uncertain
              }
              onClick={() => void discard.execute()}
            >
              Отменить выбранные изменения
            </button>
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
