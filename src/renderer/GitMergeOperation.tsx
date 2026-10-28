import { useEffect, useRef, useState } from "react";
import type { ScopeRef } from "../shared/context";
import {
  gitMergeOperationRequestSchema,
  gitMergeOperationTokenSchema,
  type GitMergeOperationPreview,
} from "../shared/git-operations";
import type { GitWorkspaceSnapshot } from "../shared/git-workspace";
import {
  nativeSequenceDiagnostics,
  verifiedNativeSequenceResult,
} from "./git-native-sequence-result";
import {
  formatGitDiagnostics,
  hasGitDiagnostics,
} from "./git-operation-diagnostics";
import { LoadingState } from "./LoadingBoundary";
import { readWithSignal } from "./read-request";
import { documentScopeId } from "./settings-documents";
import { TopicModal, topicError } from "./TopicsCommon";
type Action = "continue" | "abort";
const validMessage = (message: string) =>
  !!message.trim() && message.length <= 16384 && !message.includes("\0");
interface Options {
  scope: ScopeRef;
  snapshot: GitWorkspaceSnapshot | null;
  visible: boolean;
  ready: boolean;
  blocked: boolean;
  unresolved: boolean;
  freshness: string;
  /** Issued sequence of the last successfully accepted workspace read. */
  readVersion: number;
  /** Synchronous owner-local sequence of ALL started workspace reads. */
  getIssuedReadVersion(): number;
  onSucceeded(scope: ScopeRef): void;
}
/** The retained stable owner owns drafts and writes; only reads follow visibility. */
export function useGitMergeOperation(options: Options) {
  const [draft, setDraft] = useState<string | undefined>();
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<GitMergeOperationPreview | null>(null);
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [result, setResult] = useState("");
  const [rereadAfter, setRereadAfter] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true),
    flight = useRef<"prepare" | "execute" | null>(null);
  const read = useRef<AbortController | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const boundFreshness = useRef<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const supported =
    typeof window.goga.prepareGitMergeOperation === "function" &&
    typeof window.goga.executeGitMergeOperation === "function";
  const needsRefresh =
    rereadAfter !== null && options.readVersion <= rereadAfter;
  const available = () => {
    const current = latest.current;
    return (
      supported &&
      current.visible &&
      current.ready &&
      !current.blocked &&
      current.snapshot?.operation === "merge" &&
      documentScopeId(current.snapshot.scope) === documentScopeId(current.scope)
    );
  };
  const close = () => {
    read.current?.abort();
    setAction(null);
    setPreview(null);
    setExpired(false);
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, []);
  useEffect(() => {
    close();
  }, [options.freshness, options.visible, options.ready, options.blocked]);
  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(
      () => {
        setPreview(null);
        setExpired(true);
      },
      Math.max(0, preview.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [preview]);
  async function prepare(nextAction: Action) {
    if (
      flight.current ||
      !available() ||
      needsRefresh ||
      (nextAction === "continue" && latest.current.unresolved)
    )
      return;
    const issued = latest.current,
      snapshot = issued.snapshot!;
    const message = draftRef.current;
    const request =
      nextAction === "abort"
        ? {
            scope: issued.scope,
            revision: snapshot.revision,
            action: nextAction,
          }
        : {
            scope: issued.scope,
            revision: snapshot.revision,
            action: nextAction,
            ...(message !== undefined ? { message } : {}),
          };
    if (!gitMergeOperationRequestSchema.safeParse(request).success) {
      // A retained empty/oversize message must remain reachable for editing.
      // Opening this form grants no token and performs no read or write.
      if (
        nextAction === "continue" &&
        message !== undefined &&
        !validMessage(message)
      ) {
        setAction(nextAction);
        setPreview(null);
        setExpired(false);
      }
      return;
    }
    flight.current = "prepare";
    setPending("prepare");
    setAction(nextAction);
    setPreview(null);
    setResult("");
    setExpired(false);
    const controller = new AbortController();
    read.current = controller;
    try {
      const value = await readWithSignal(
        controller.signal,
        "prepareGitMergeOperation",
        request,
      );
      if (
        !alive.current ||
        controller.signal.aborted ||
        issued.freshness !== latest.current.freshness ||
        !available()
      )
        return;
      if (
        documentScopeId(value.scope) !== documentScopeId(issued.scope) ||
        value.action !== nextAction ||
        value.operation !== "merge" ||
        value.root !== snapshot.root ||
        value.branch !== snapshot.branch ||
        value.head !== snapshot.head ||
        !/^[a-f0-9]{40,64}$/.test(value.sourceOid) ||
        value.hooks !== "disabled" ||
        !gitMergeOperationTokenSchema.safeParse(value.token).success ||
        !Number.isFinite(value.expiresAt) ||
        value.expiresAt <= Date.now() ||
        (nextAction === "continue" &&
          (!validMessage(value.message) ||
            (message !== undefined && value.message !== message)))
      )
        throw Error(
          "Подтверждение устарело или относится к другому контексту, состоянию либо действию. Обновите изменения и повторите проверку.",
        );
      boundFreshness.current = issued.freshness;
      if (nextAction === "continue") {
        setDraft(value.message);
        draftRef.current = value.message;
      }
      setPreview(value);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) {
        setAction(null);
        setPreview(null);
        setResult(topicError(error));
      }
    } finally {
      if (read.current === controller) {
        read.current = null;
        flight.current = null;
        if (alive.current) setPending(null);
      }
    }
  }
  async function execute() {
    if (
      flight.current ||
      !preview ||
      !available() ||
      needsRefresh ||
      boundFreshness.current !== latest.current.freshness ||
      preview.expiresAt <= Date.now() ||
      (preview.action === "continue" &&
        (latest.current.unresolved ||
          !validMessage(draftRef.current ?? "") ||
          draftRef.current !== preview.message))
    )
      return;
    const submitted = preview,
      issuedScope = preview.scope;
    flight.current = "execute";
    setPending("execute");
    setPreview(null);
    setAction(null);
    try {
      // No renderer timeout, cancellation, or automatic retry is allowed for writes.
      const value = await window.goga.executeGitMergeOperation(submitted.token);
      if (!alive.current) return;
      // Fence every read already started, including replies queued in this
      // React batch. Only a successful read started AFTER this result qualifies.
      setRereadAfter(latest.current.getIssuedReadVersion());
      if (
        documentScopeId(value.scope) !== documentScopeId(issuedScope) ||
        value.operation !== "merge" ||
        value.action !== submitted.action
      )
        throw Error("Результат относится к другому контексту или действию.");
      const verified = verifiedNativeSequenceResult(value, {
        scope: issuedScope,
        operation: "merge",
        action: submitted.action,
        head: submitted.head,
        original: submitted.head,
      });
      if (
        verified &&
        value.status === "success" &&
        !value.lockRetained &&
        !value.retainedLocks?.length &&
        !value.uncheckedLocks?.length &&
        !value.recoveryUnverified
      ) {
        setDraft(undefined);
        draftRef.current = undefined;
        latest.current.onSucceeded(issuedScope);
      }
      if (!verified)
        setResult(
          [nativeSequenceDiagnostics(value, false), formatGitDiagnostics(value)]
            .filter(Boolean)
            .join("\n\n"),
        );
      else if (hasGitDiagnostics(value)) setResult(formatGitDiagnostics(value));
    } catch (error) {
      if (alive.current) {
        setRereadAfter(latest.current.getIssuedReadVersion());
        setResult(
          `${topicError(error)}\n\nПроверьте состояние Git. Ответ не подтверждает отсутствие изменений; операция могла выполниться. Автоматического повтора не будет.`,
        );
      }
    } finally {
      flight.current = null;
      if (alive.current) setPending(null);
    }
  }
  return {
    supported,
    pending,
    preview,
    draft,
    action,
    result,
    needsRefresh,
    expired,
    locked: !!pending || !!action,
    modalOpen: !!action || !!result,
    canStart: available() && !pending && !action && !result && !needsRefresh,
    canExecute:
      !!preview &&
      !pending &&
      available() &&
      !needsRefresh &&
      boundFreshness.current === options.freshness &&
      preview.expiresAt > Date.now() &&
      (preview.action === "abort" ||
        (!options.unresolved &&
          validMessage(draft ?? "") &&
          draft === preview.message)),
    messageValid: validMessage(draft ?? ""),
    prepare,
    execute,
    close,
    closeResult: () => setResult(""),
    edit: (message: string) => {
      if (flight.current) return;
      setDraft(message);
      draftRef.current = message;
      setPreview(null);
      setExpired(false);
    },
  };
}
type MergeState = ReturnType<typeof useGitMergeOperation>;
export function GitMergeOperationFooter({
  merge,
  unresolved,
}: {
  merge: MergeState;
  unresolved: boolean;
}) {
  if (!merge.supported)
    return (
      <p>Продолжение и отмена слияния недоступны в этой версии подключения.</p>
    );
  return (
    <div className="git-merge-operation-footer">
      <p role={merge.pending === "execute" ? "status" : undefined}>
        {merge.pending === "execute"
          ? "Выполняется операция слияния… Просмотр можно закрыть; запись не отменяется."
          : merge.needsRefresh
            ? "Сначала обновите изменения и проверьте состояние Git. Для повторной попытки нужна новая проверка."
            : unresolved
              ? "Сначала разрешите и отдельно сохраните все файлы: остались конфликты или несохранённые черновики."
              : "Сохранение файла и завершение слияния — отдельные действия. Завершение использует проверенное дерево индекса, не несохранённые правки."}
      </p>
      <div>
        <button
          type="button"
          className="danger"
          disabled={!merge.canStart}
          onClick={() => void merge.prepare("abort")}
        >
          Отменить слияние…
        </button>
        <button
          type="button"
          className="primary"
          disabled={!merge.canStart || unresolved}
          onClick={() => void merge.prepare("continue")}
        >
          Завершить слияние…
        </button>
      </div>
    </div>
  );
}
export function GitMergeOperationDialogs({ merge }: { merge: MergeState }) {
  const closeOnEscape = (event: React.KeyboardEvent, close: () => void) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  return (
    <>
      {merge.action && (
        <div onKeyDown={(event) => closeOnEscape(event, merge.close)}>
          <TopicModal
            title={
              merge.action === "continue"
                ? "Завершить слияние"
                : "Отменить слияние?"
            }
            closeLabel="Закрыть подтверждение слияния"
            className="git-merge-operation-modal"
            onClose={merge.close}
          >
            <div className="git-merge-operation-form">
              {merge.pending === "prepare" ? (
                <LoadingState label="Проверяем операцию слияния…" />
              ) : (
                <>
                  <div className="git-merge-operation-details">
                    {merge.action === "abort" && (
                      <p className="git-conflict-warning">
                        Ручные решения конфликтов будут потеряны. Посторонние
                        изменения должны быть сохранены: если безопасная отмена
                        не доказана, операция будет отклонена.
                      </p>
                    )}
                    {merge.preview && (
                      <>
                        <dl>
                          <dt>Контекст</dt>
                          <dd
                            title={
                              typeof merge.preview.scope === "string"
                                ? merge.preview.scope
                                : merge.preview.scope.contextId
                            }
                          >
                            {typeof merge.preview.scope === "string"
                              ? `Основная папка · ${merge.preview.scope}`
                              : `${merge.preview.scope.projectId} / ${merge.preview.scope.year} / ${merge.preview.scope.topic} · ${merge.preview.scope.contextId.slice(0, 12)}…`}
                          </dd>
                          <dt>Рабочая папка</dt>
                          <dd>{merge.preview.root}</dd>
                          <dt>Ветка</dt>
                          <dd>{merge.preview.branch}</dd>
                          <dt>HEAD</dt>
                          <dd>{merge.preview.head}</dd>
                          <dt>Входящий коммит</dt>
                          <dd>{merge.preview.sourceOid}</dd>
                          {merge.action === "continue" && (
                            <>
                              <dt>Автор</dt>
                              <dd>{merge.preview.author ?? "Не определён"}</dd>
                              <dt>Коммиттер</dt>
                              <dd>
                                {merge.preview.committer ?? "Не определён"}
                              </dd>
                              <dt>Подпись</dt>
                              <dd>
                                {merge.preview.signing
                                  ? "По настройкам Git"
                                  : "Не настроена"}
                              </dd>
                            </>
                          )}
                        </dl>
                        <p>{merge.preview.effects}</p>
                        <strong>
                          Затронутые пути: {merge.preview.paths.length}
                        </strong>
                        <ul>
                          {merge.preview.paths.map((path) => (
                            <li key={path}>
                              <code>{path}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <p>
                      Непроверяемые стратегии или состояние слияния могут быть
                      отклонены без записи.
                    </p>
                  </div>
                  <div className="git-merge-operation-confirm">
                    <p className="hint">
                      Git-хуки отключены. Результат не публикуется на сервер.
                    </p>
                    {merge.action === "continue" && (
                      <label>
                        Сообщение merge-коммита
                        <textarea
                          aria-label="Сообщение merge-коммита"
                          rows={4}
                          value={merge.draft ?? ""}
                          onChange={(event) => merge.edit(event.target.value)}
                        />
                      </label>
                    )}
                    {!merge.preview && (
                      <p>
                        {merge.expired
                          ? "Срок подтверждения истёк. Проверьте операцию заново."
                          : "Сообщение изменено. Перед записью требуется новая проверка."}
                      </p>
                    )}
                    <div className="git-branch-dialog-actions">
                      <button type="button" onClick={merge.close}>
                        Отмена
                      </button>
                      {!merge.preview && (
                        <button
                          type="button"
                          disabled={
                            merge.action === "continue" && !merge.messageValid
                          }
                          onClick={() => void merge.prepare(merge.action!)}
                        >
                          {merge.action === "continue"
                            ? "Проверить сообщение"
                            : "Проверить отмену"}
                        </button>
                      )}
                      <button
                        type="button"
                        className={
                          merge.action === "continue" ? "primary" : "danger"
                        }
                        disabled={!merge.canExecute}
                        onClick={() => void merge.execute()}
                      >
                        {merge.action === "continue"
                          ? "Создать merge-коммит"
                          : "Отменить слияние"}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </TopicModal>
        </div>
      )}
      {!!merge.result && (
        <div onKeyDown={(event) => closeOnEscape(event, merge.closeResult)}>
          <TopicModal
            title="Результат операции слияния"
            closeLabel="Закрыть результат слияния"
            className="git-workspace-error"
            onClose={merge.closeResult}
          >
            <pre>{merge.result}</pre>
          </TopicModal>
        </div>
      )}
    </>
  );
}
