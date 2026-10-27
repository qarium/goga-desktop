import { useEffect, useRef, useState } from "react";
import type { ScopeRef } from "../shared/context";
import type { GitWorkspaceSnapshot } from "../shared/git-workspace";
import type { GitCommitPreview } from "../shared/git-commit";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { TopicModal, topicError } from "./TopicsCommon";

/** Lives in the retained owner, not in the visibility-bound portal. */
export function useGitCommit(scope: ScopeRef, onCommitted: () => void) {
  const [paths, setPaths] = useState<string[]>([]);
  const selectionSnapshot = useRef<{
    branch: string;
    paths: Set<string>;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [preview, setPreview] = useState<GitCommitPreview | null>(null);
  const [result, setResult] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true);
  const flight = useRef(false);
  const read = useRef<AbortController | null>(null);
  const done = useRef(onCommitted);
  done.current = onCommitted;
  const owner = documentScopeId(scope);
  const supported =
    typeof window.goga.prepareGitCommit === "function" &&
    typeof window.goga.executeGitCommit === "function";
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, []);
  const toggle = (path: string) => {
    if (flight.current || preview) return;
    setPaths((current) =>
      current.includes(path)
        ? current.filter((p) => p !== path)
        : [...current, path],
    );
  };
  const prepare = async (snapshot: GitWorkspaceSnapshot) => {
    if (flight.current || uncertain) return;
    flight.current = true;
    setPending("prepare");
    setResult("");
    const controller = new AbortController();
    read.current = controller;
    try {
      const value = await readWithSignal(
        controller.signal,
        "prepareGitCommit",
        {
          scope,
          revision: snapshot.revision,
          paths: [...paths],
          message,
        },
      );
      if (!alive.current) return;
      if (documentScopeId(value.scope) !== owner)
        throw Error("Подтверждение относится к другому контексту.");
      setPreview(value);
    } catch (error) {
      if (alive.current) setResult(topicError(error));
    } finally {
      flight.current = false;
      if (alive.current) setPending(null);
    }
  };
  const execute = async () => {
    if (flight.current || !preview) return;
    const submitted = preview;
    flight.current = true;
    setPreview(null);
    setPending("execute");
    try {
      // A write is never cancelled by navigation or a renderer-only timeout.
      // The host reports the actual outcome after its bounded Git process ends.
      const value = await window.goga.executeGitCommit(submitted.token);
      if (!alive.current) return;
      if (documentScopeId(value.scope) !== owner)
        throw Error(
          "Результат относится к другому контексту. Проверьте состояние Git.",
        );
      if (value.status === "committed" && value.indexPublished) {
        setPaths((current) =>
          current.filter((p) => !submitted.paths.includes(p)),
        );
        setMessage((current) => (current === submitted.message ? "" : current));
        done.current();
      }
      if (
        value.status !== "committed" ||
        !value.indexPublished ||
        value.recoveryPath
      ) {
        setUncertain(value.status !== "not-committed" || !!value.recoveryPath);
        setResult(
          [
            value.message,
            value.commit && `Коммит: ${value.commit}`,
            value.log,
            value.recoveryPath &&
              `Материалы восстановления: ${value.recoveryPath}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }
    } catch (error) {
      if (alive.current) {
        setUncertain(true);
        setResult(
          `${topicError(error)}\n\nПроверьте состояние Git перед новой попыткой: ответ не подтверждает, что коммит не был создан.`,
        );
      }
    } finally {
      flight.current = false;
      if (alive.current) setPending(null);
    }
  };
  return {
    paths,
    message,
    setMessage,
    pending,
    preview,
    result,
    uncertain,
    supported,
    toggle,
    initializeSelection: (snapshot: GitWorkspaceSnapshot) => {
      if (
        flight.current ||
        preview ||
        documentScopeId(snapshot.scope) !== owner ||
        snapshot.operation !== "none" ||
        snapshot.files.some((file) => file.kind === "conflict")
      )
        return;
      const branch = snapshot.branch ?? `HEAD:${snapshot.head ?? "unborn"}`;
      const eligible = snapshot.files
        .filter((file) => !file.submodule)
        .map((file) => file.path);
      const previous = selectionSnapshot.current;
      const sameBranch = previous?.branch === branch;
      selectionSnapshot.current = { branch, paths: new Set(eligible) };
      // Defaults apply to newly observed changes, not just the first visit.
      // Keep deliberate deselection until a path disappears or the branch changes.
      setPaths((current) => {
        const selected = new Set(current);
        return eligible.filter(
          (path) =>
            !sameBranch || !previous.paths.has(path) || selected.has(path),
        );
      });
    },
    prepare,
    execute,
    closePreview: () => setPreview(null),
    closeResult: () => setResult(""),
    removePaths: (removed: string[]) => {
      if (!flight.current && !preview)
        setPaths((current) =>
          current.filter((path) => !removed.includes(path)),
        );
    },
    clearPaths: () => {
      if (!flight.current && !preview) setPaths([]);
    },
    manualRefresh: () => {
      if (!flight.current) setUncertain(false);
    },
  };
}
type CommitState = ReturnType<typeof useGitCommit>;
export function GitCommitFooter({
  commit,
  snapshot,
  disabled,
  visible,
}: {
  commit: CommitState;
  snapshot: GitWorkspaceSnapshot | null;
  disabled: boolean;
  visible: boolean;
}) {
  const blocked =
    disabled ||
    !!commit.pending ||
    !!commit.preview ||
    commit.uncertain ||
    !snapshot ||
    snapshot.operation !== "none" ||
    snapshot.files.some((f) => f.kind === "conflict");
  const available =
    !!snapshot &&
    commit.paths.every((p) => snapshot.files.some((f) => f.path === p));
  return (
    <>
      <div className="git-commit-form">
        <label
          htmlFor={`git-message-${documentScopeId(snapshot?.scope ?? "pending")}`}
        >
          Сообщение коммита
        </label>
        <div className="git-commit-input-row">
          <textarea
            id={`git-message-${documentScopeId(snapshot?.scope ?? "pending")}`}
            aria-label="Сообщение коммита"
            rows={2}
            maxLength={10000}
            value={commit.message}
            disabled={disabled || !!commit.pending || !!commit.preview}
            onChange={(e) => commit.setMessage(e.target.value)}
            placeholder="Кратко опишите изменения"
          />
          <button
            type="button"
            className="primary"
            disabled={
              blocked ||
              !available ||
              !commit.paths.length ||
              !commit.message.trim()
            }
            onClick={() => {
              if (snapshot) void commit.prepare(snapshot);
            }}
          >
            Создать коммит…
          </button>
        </div>
        <p role={commit.pending ? "status" : undefined}>
          {commit.pending === "prepare"
            ? "Проверяем выбранные файлы…"
            : commit.pending === "execute"
              ? "Создаём локальный коммит…"
              : commit.uncertain
                ? "Сначала обновите изменения и проверьте состояние Git. Автоматического повтора не будет."
                : `Выбрано файлов: ${commit.paths.length}. Коммит содержит файлы целиком и не публикуется на сервер.`}
        </p>
        {!!commit.paths.length && (
          <button
            type="button"
            className="git-commit-clear"
            disabled={disabled || !!commit.pending || !!commit.preview}
            onClick={commit.clearPaths}
          >
            Снять выбор файлов
          </button>
        )}
      </div>
      {visible && commit.preview && (
        <TopicModal
          title="Подтвердить коммит"
          closeLabel="Закрыть подтверждение коммита"
          className="git-commit-modal"
          onClose={commit.closePreview}
        >
          <div className="git-commit-preview">
            <p>
              В коммит войдёт полное текущее содержимое выбранных файлов, а не
              только подготовленные строки. Подготовленные изменения остальных
              файлов сохранятся.
            </p>
            <dl>
              <dt>Рабочая папка</dt>
              <dd>{commit.preview.root}</dd>
              <dt>Ветка</dt>
              <dd>{commit.preview.branch ?? "Отсоединённый HEAD"}</dd>
              <dt>Автор</dt>
              <dd>{commit.preview.author}</dd>
              <dt>Коммиттер</dt>
              <dd>{commit.preview.committer}</dd>
              <dt>Подпись</dt>
              <dd>
                {commit.preview.signing ? "По настройкам Git" : "Не настроена"}
              </dd>
            </dl>
            <p>
              Git-хуки не запускаются. Публикация и синхронизация не
              выполняются.
            </p>
            <strong>
              Файлов: {commit.preview.paths.length} · удалений:{" "}
              {commit.preview.deletedCount}
            </strong>
            <ul>
              {commit.preview.paths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
            <pre>{commit.preview.message}</pre>
            <button
              type="button"
              className="primary"
              onClick={() => void commit.execute()}
            >
              Создать локальный коммит
            </button>
          </div>
        </TopicModal>
      )}
      {visible && commit.result && (
        <TopicModal
          title="Результат коммита"
          closeLabel="Закрыть результат коммита"
          className="git-workspace-error"
          onClose={commit.closeResult}
        >
          <pre>{commit.result}</pre>
        </TopicModal>
      )}
    </>
  );
}
