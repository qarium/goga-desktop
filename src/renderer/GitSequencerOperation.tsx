import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import type { GitWorkspaceSnapshot } from "../shared/git-workspace";
import {
  gitSequencerOperationRequestSchema,
  gitSequencerOperationTokenSchema,
  type GitSequencerOperationPreview,
} from "../shared/git-sequencer-operations";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { TopicModal, topicError } from "./TopicsCommon";
import { LoadingState } from "./LoadingBoundary";
type Action = "continue" | "abort";
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const text = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\0"));
const recoveryPath = text.refine((v) => v.startsWith("/"));
const previewSchema = z.object({
  scope: scopeRefSchema,
  token: gitSequencerOperationTokenSchema,
  root: text,
  operation: z.enum(["cherry-pick", "revert"]),
  current: oid,
  requiresCommitWarning: z.boolean(),
  action: z.enum(["continue", "abort"]),
  branch: text.refine((v) => !/[\x00-\x20\x7f]/.test(v)),
  head: oid,
  original: oid,
  paths: z.array(text),
  discardedResolutionPaths: z.array(text),
  hooks: z.literal("disabled"),
  effects: text,
  expiresAt: z.number().finite(),
});
const resultSchema = z.object({
  scope: scopeRefSchema,
  operation: z.enum(["cherry-pick", "revert"]),
  action: z.enum(["continue", "abort"]),
  status: z.enum(["success", "conflict", "error", "uncertain"]),
  changed: z.boolean(),
  mutationStarted: z.boolean(),
  worktreeRestored: z.boolean(),
  indexPublished: z.boolean(),

  metadataCleared: z.boolean(),
  objectsPublished: z.boolean(),
  publishedObjectCount: z.number().int().nonnegative(),
  branchPublished: z.boolean(),
  metadataPublished: z.boolean(),
  worktreeUpdated: z.boolean(),
  recoveryStatus: z.enum(["not-created", "retained", "missing", "unverified"]),
  recoveryPath: recoveryPath.optional(),
  lastKnownRecoveryPath: recoveryPath.optional(),
  lockRetained: z.boolean(),
  retainedLocks: z.array(text),
  uncheckedLocks: z.array(text),
  message: z.string(),
  log: z.string(),
});
/** A host status alone does not authorize discarding drafts or claiming completion. */
function verifiedResult(
  value: unknown,
  submitted: GitSequencerOperationPreview,
): boolean {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return false;
  const v = parsed.data;
  if (
    documentScopeId(v.scope) !== documentScopeId(submitted.scope) ||
    v.action !== submitted.action ||
    v.operation !== submitted.operation ||
    !v.changed ||
    !v.mutationStarted ||
    !v.indexPublished ||
    v.lockRetained ||
    v.retainedLocks.length ||
    v.uncheckedLocks.length ||
    v.recoveryStatus !== "retained" ||
    !v.recoveryPath ||
    (v.lastKnownRecoveryPath !== undefined &&
      v.lastKnownRecoveryPath !== v.recoveryPath)
  )
    return false;
  if (!v.branchPublished || !v.metadataPublished) return false;
  if (v.action === "abort")
    return (
      v.status === "success" &&
      v.worktreeRestored &&
      v.metadataCleared &&
      !v.worktreeUpdated &&
      !v.objectsPublished &&
      v.publishedObjectCount === 0
    );
  return (
    !v.worktreeRestored &&
    v.worktreeUpdated === true &&
    v.objectsPublished === true &&
    v.publishedObjectCount !== undefined &&
    ((v.status === "success" && v.metadataCleared) ||
      (v.status === "conflict" && !v.metadataCleared))
  );
}
/** Even malformed replies retain each observable fact, without treating omissions as false. */
function diagnostics(value: unknown, verified: boolean): string {
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const bool = (field: string) =>
    v[field] === true ? "да" : v[field] === false ? "нет" : "не подтверждено";
  const str = (field: string) =>
    typeof v[field] === "string" ? (v[field] as string) : "не подтверждено";
  const locks = (field: string) => {
    const entries = v[field];
    if (!Array.isArray(entries)) return "не проверены";
    const observed = entries.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (observed.length !== entries.length)
      return `наблюдаемые имена: ${observed.length ? observed.join(", ") : "не получены"}; список неполон или не проверен, наличие и владение не подтверждены`;
    return observed.length ? observed.join(", ") : "нет";
  };
  const recoveryVerified =
    v.recoveryStatus === "retained" &&
    recoveryPath.safeParse(v.recoveryPath).success &&
    (v.lastKnownRecoveryPath === undefined ||
      v.lastKnownRecoveryPath === v.recoveryPath);
  const recovery = recoveryVerified
    ? `Проверенные материалы восстановления: ${str("recoveryPath")}`
    : v.recoveryStatus === "missing"
      ? "Материалы восстановления отсутствуют; сохранность не подтверждена."
      : v.recoveryStatus === "unverified"
        ? "Наличие, владение или целостность материалов восстановления не проверены."
        : v.recoveryStatus === "not-created"
          ? "Материалы восстановления не создавались."
          : "Состояние материалов восстановления не подтверждено.";
  return [
    verified
      ? v.status === "conflict"
        ? "Следующий конфликт: операция не завершена. Обновлённое состояние доступно в редакторе конфликтов."
        : v.action === "abort"
          ? "Отмена операции подтверждена."
          : "Завершение операции подтверждено."
      : "Результат не подтверждён. Проверьте состояние Git; ответ не подтверждает отсутствие изменений. Автоматического повтора не будет.",
    `Заявление хоста: ${str("status")} · ${str("message")}`,
    typeof v.log === "string" && v.log,
    `Изменения: ${bool("changed")}\nЗапись начата: ${bool("mutationStarted")}\nРабочая папка восстановлена: ${bool("worktreeRestored")}\nРабочая папка обновлена: ${bool("worktreeUpdated")}\nШаг публикации объектов: ${bool("objectsPublished")}\nОпубликованных файлов объектов: ${typeof v.publishedObjectCount === "number" && Number.isSafeInteger(v.publishedObjectCount) && v.publishedObjectCount >= 0 ? v.publishedObjectCount : "не подтверждено"}\nИндекс опубликован: ${bool("indexPublished")}\nВетка опубликована: ${bool("branchPublished")}\nМетаданные опубликованы: ${bool("metadataPublished")}\nМетаданные удалены: ${bool("metadataCleared")}`,
    "Незавершённый шаг публикации объектов не означает, что объекты не записывались. Количество включает созданные файлы с ошибкой записи или fsync и не подтверждает их сохранность.",
    recovery,
    typeof v.lastKnownRecoveryPath === "string" &&
      `Последний известный путь (не подтверждает сохранность): ${v.lastKnownRecoveryPath}`,
    !recoveryVerified &&
      typeof v.recoveryPath === "string" &&
      `Наблюдаемый путь восстановления (сохранность не подтверждена): ${v.recoveryPath}`,
    `Блокировка сохранена: ${bool("lockRetained")}\nСохранённые блокировки: ${locks("retainedLocks")}\nНепроверенные блокировки: ${locks("uncheckedLocks")}. Их наличие и владелец не подтверждены.`,
    "Исходные reflog не дополняются; журнал восстановления не заменяет native reflog. Автоматического восстановления или удаления блокировок нет.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
interface Options {
  scope: ScopeRef;
  snapshot: GitWorkspaceSnapshot | null;
  visible: boolean;
  ready: boolean;
  blocked: boolean;
  unresolved: boolean;
  freshness: string;
  readVersion: number;
  getIssuedReadVersion(): number;
  onSucceeded(scope: ScopeRef): void;
}
/** The retained owner, not its visibility, owns the non-cancellable write. */
export function useGitSequencerOperation(options: Options) {
  const [displayOperation, setDisplayOperation] = useState<
    "cherry-pick" | "revert"
  >("cherry-pick");
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<GitSequencerOperationPreview | null>(
    null,
  );
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [result, setResult] = useState("");
  const [rereadAfter, setRereadAfter] = useState<number | null>(null);
  const [expired, setExpired] = useState(false);
  const alive = useRef(true),
    flight = useRef<"prepare" | "execute" | null>(null),
    read = useRef<AbortController | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const bound = useRef<{ freshness: string; read: number } | null>(null);
  const supported =
    typeof window.goga.prepareGitSequencerOperation === "function" &&
    typeof window.goga.executeGitSequencerOperation === "function";
  const needsRefresh =
    rereadAfter !== null && options.readVersion <= rereadAfter;
  const available = () => {
    const o = latest.current;
    return (
      supported &&
      o.visible &&
      o.ready &&
      !o.blocked &&
      (o.snapshot?.operation === "cherry-pick" ||
        o.snapshot?.operation === "revert") &&
      oid.safeParse(o.snapshot.head).success &&
      documentScopeId(o.snapshot.scope) === documentScopeId(o.scope)
    );
  };
  const close = () => {
    read.current?.abort();
    read.current = null;
    if (flight.current === "prepare") {
      flight.current = null;
      setPending(null);
    }
    bound.current = null;
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
  async function prepare(next: Action) {
    if (
      flight.current ||
      !available() ||
      needsRefresh ||
      (next === "continue" && latest.current.unresolved)
    )
      return;
    const issued = latest.current,
      snapshot = issued.snapshot!,
      issuedRead = issued.getIssuedReadVersion();
    const request = {
      scope: issued.scope,
      revision: snapshot.revision,
      action: next,
      operation: snapshot.operation,
    };
    const parsedRequest = gitSequencerOperationRequestSchema.safeParse(request);
    if (!parsedRequest.success) return;
    flight.current = "prepare";
    setPending("prepare");
    setAction(next);
    setDisplayOperation(snapshot.operation as "cherry-pick" | "revert");
    setPreview(null);
    setResult("");
    setExpired(false);
    const controller = new AbortController();
    read.current = controller;
    try {
      const raw = await readWithSignal(
        controller.signal,
        "prepareGitSequencerOperation",
        parsedRequest.data,
      );
      if (
        !alive.current ||
        controller.signal.aborted ||
        issued.freshness !== latest.current.freshness ||
        issuedRead !== latest.current.getIssuedReadVersion() ||
        !available()
      )
        return;
      const checked = previewSchema.safeParse(raw);
      if (!checked.success)
        throw Error(
          "Подтверждение Git содержит непроверенные поля. Обновите изменения и повторите проверку.",
        );
      const value = checked.data;
      if (
        documentScopeId(value.scope) !== documentScopeId(issued.scope) ||
        value.root !== snapshot.root ||
        value.head !== snapshot.head ||
        value.action !== next ||
        value.operation !== snapshot.operation ||
        value.expiresAt <= Date.now() ||
        (typeof issued.scope !== "string"
          ? value.branch !== issued.scope.branch
          : snapshot.branch !== null && value.branch !== snapshot.branch)
      )
        throw Error(
          "Подтверждение устарело или относится к другому контексту, состоянию либо действию. Обновите изменения и повторите проверку.",
        );
      bound.current = { freshness: issued.freshness, read: issuedRead };
      setPreview(value);
    } catch (error) {
      if (
        alive.current &&
        !controller.signal.aborted &&
        issued.freshness === latest.current.freshness &&
        available()
      ) {
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
  const validConfirmation = () =>
    !!preview &&
    available() &&
    !needsRefresh &&
    bound.current?.freshness === latest.current.freshness &&
    bound.current.read === latest.current.getIssuedReadVersion() &&
    preview.expiresAt > Date.now() &&
    preview.operation === latest.current.snapshot?.operation &&
    (preview.action === "abort" || !latest.current.unresolved);
  async function execute() {
    if (flight.current || !validConfirmation() || !preview) return;
    const submitted = preview;
    // Consume authorization before awaiting, including stale event closures.
    bound.current = null;
    flight.current = "execute";
    setPending("execute");
    setPreview(null);
    setAction(null);
    try {
      // Writes deliberately have no renderer cancellation, timeout, or retry.
      const value = await window.goga.executeGitSequencerOperation(
        submitted.token,
      );
      if (
        !alive.current ||
        documentScopeId(latest.current.scope) !==
          documentScopeId(submitted.scope)
      )
        return;
      // Fence ALL already-issued reads, including a reply queued in this React batch.
      setRereadAfter(latest.current.getIssuedReadVersion());
      // Identity must be proven before displaying even diagnostic data. A reply
      // for another owner/action must not leak its paths, messages, or journal.
      const identity = z
        .object({
          scope: scopeRefSchema,
          operation: z.enum(["cherry-pick", "revert"]),
          action: z.enum(["continue", "abort"]),
        })
        .safeParse(value);
      if (
        !identity.success ||
        documentScopeId(identity.data.scope) !==
          documentScopeId(submitted.scope) ||
        identity.data.action !== submitted.action ||
        identity.data.operation !== submitted.operation
      )
        throw Error(
          "Результат относится к другому контексту или действию; его данные не показаны.",
        );
      const verified = verifiedResult(value, submitted);
      setResult(diagnostics(value, verified));
      if (verified) latest.current.onSucceeded(submitted.scope);
    } catch (error) {
      if (
        alive.current &&
        documentScopeId(latest.current.scope) ===
          documentScopeId(submitted.scope)
      ) {
        setRereadAfter(latest.current.getIssuedReadVersion());
        setResult(
          `${topicError(error)}\n\nРезультат не подтверждён. Проверьте состояние Git: операция могла выполниться; отсутствие записи, сохранность материалов восстановления и снятие блокировок не подтверждены. Автоматического повтора не будет.`,
        );
      }
    } finally {
      flight.current = null;
      if (alive.current) setPending(null);
    }
  }
  return {
    supported,
    displayOperation,
    operation:
      options.snapshot?.operation === "revert" ? "revert" : "cherry-pick",
    pending,
    preview,
    action,
    result,
    expired,
    needsRefresh,
    locked: !!pending || !!action,
    modalOpen: !!action || !!result,
    canStart: available() && !pending && !action && !result && !needsRefresh,
    canExecute: !pending && validConfirmation(),
    prepare,
    execute,
    close,
    closeResult: () => setResult(""),
  };
}
type SequencerState = ReturnType<typeof useGitSequencerOperation>;
export function GitSequencerOperationFooter({
  sequencer,
  unresolved,
}: {
  sequencer: SequencerState;
  unresolved: boolean;
}) {
  if (!sequencer.supported)
    return (
      <p>
        Продолжение и отмена этой операции недоступны в этой версии подключения.
      </p>
    );
  return (
    <div className="git-merge-operation-footer">
      <p role={sequencer.pending === "execute" ? "status" : undefined}>
        {sequencer.pending === "execute"
          ? "Выполняется операция Git… Просмотр можно закрыть; запись не отменяется."
          : sequencer.needsRefresh
            ? "Сначала обновите изменения и проверьте состояние Git. Для повторной попытки нужна новая проверка."
            : unresolved
              ? "Сначала разрешите и отдельно сохраните все файлы: остались конфликты или несохранённые черновики."
              : "Сохранение файла и продолжение операции — отдельные действия."}
      </p>
      <div>
        <button
          type="button"
          className="danger"
          disabled={!sequencer.canStart}
          onClick={() => void sequencer.prepare("abort")}
        >
          Отменить {sequencer.operation}…
        </button>
        <button
          type="button"
          className="primary"
          disabled={!sequencer.canStart || unresolved}
          onClick={() => void sequencer.prepare("continue")}
        >
          Продолжить {sequencer.operation}…
        </button>
      </div>
    </div>
  );
}
export function GitSequencerOperationDialogs({
  sequencer: s,
}: {
  sequencer: SequencerState;
}) {
  const escape = (e: React.KeyboardEvent, close: () => void) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  const p = s.preview,
    operation = s.displayOperation,
    label =
      s.action === "continue"
        ? `Продолжить ${operation}`
        : `Отменить ${operation}`;
  return (
    <>
      {s.action && (
        <div onKeyDown={(e) => escape(e, s.close)}>
          <TopicModal
            title={label + (s.action === "abort" ? "?" : "")}
            closeLabel={`Закрыть подтверждение ${operation}`}
            className="git-merge-operation-modal"
            onClose={s.close}
          >
            <div className="git-merge-operation-form">
              {s.pending === "prepare" ? (
                <LoadingState label="Проверяем операцию Git…" />
              ) : (
                <>
                  <div className="git-merge-operation-details">
                    {s.action === "abort" && (
                      <p className="git-conflict-warning">
                        Будут восстановлены указанный исходный коммит и дерево.
                        Сохранённые и ручные решения конфликтов будут удалены;
                        посторонние правки блокируют отмену. Несохранённые
                        черновики удаляются только после подтверждённого успеха.
                      </p>
                    )}
                    {p && (
                      <>
                        <dl>
                          <dt>Контекст</dt>
                          <dd>
                            {typeof p.scope === "string"
                              ? `Основная папка · ${p.scope}`
                              : `${p.scope.projectId} / ${p.scope.year} / ${p.scope.topic} · ${p.scope.contextId}`}
                          </dd>
                          <dt>Рабочая папка</dt>
                          <dd>{p.root}</dd>
                          <dt>Ветка</dt>
                          <dd>{p.branch}</dd>
                          <dt>HEAD</dt>
                          <dd>{p.head}</dd>
                          <dt>Исходный коммит для отмены</dt>
                          <dd>{p.original}</dd>
                          <dt>Текущий коммит операции</dt>
                          <dd>{p.current}</dd>
                        </dl>
                        {p.requiresCommitWarning && (
                          <p className="git-conflict-warning">
                            Будет создан коммит; исходный --no-commit определить
                            невозможно.
                          </p>
                        )}
                        <p>{p.effects}</p>
                        {p.action === "abort" &&
                          !!p.discardedResolutionPaths?.length && (
                            <section
                              aria-label="Решения, которые будут удалены"
                              className="git-conflict-warning"
                            >
                              <strong>Будут удалены решения в файлах:</strong>
                              <ul>
                                {p.discardedResolutionPaths.map((n) => (
                                  <li key={n}>
                                    <code>{n}</code>
                                  </li>
                                ))}
                              </ul>
                            </section>
                          )}
                        <strong>Затронутые пути: {p.paths.length}</strong>
                        <ul>
                          {p.paths.map((n) => (
                            <li key={n}>
                              <code>{n}</code>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <p>
                      Поддерживаются проверенные линейные последовательности и
                      существующие текстовые файлы в установленных пределах.
                      Продолжение создаёт коммиты до следующего конфликта либо
                      завершения. Пропуск пустых коммитов, mainline и
                      нестандартные параметры не выполняются автоматически.
                    </p>
                    <p>
                      Исходные reflog не дополняются. Материалы восстановления
                      сохраняются; они не заменяют native reflog.
                    </p>
                  </div>
                  <div className="git-merge-operation-confirm">
                    <p className="hint">
                      Git-хуки отключены. Результат не публикуется на сервер.
                    </p>
                    {!p && (
                      <p>
                        {s.expired
                          ? "Срок подтверждения истёк. Проверьте операцию заново."
                          : "Подтверждение недоступно. Закройте окно и обновите изменения."}
                      </p>
                    )}
                    <div className="git-branch-dialog-actions">
                      <button type="button" onClick={s.close}>
                        Отмена
                      </button>
                      {s.expired && (
                        <button
                          type="button"
                          onClick={() => void s.prepare(s.action!)}
                        >
                          Проверить заново
                        </button>
                      )}
                      <button
                        type="button"
                        className={
                          s.action === "continue" ? "primary" : "danger"
                        }
                        disabled={!s.canExecute}
                        onClick={() => void s.execute()}
                      >
                        {label}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </TopicModal>
        </div>
      )}
      {!!s.result && (
        <div onKeyDown={(e) => escape(e, s.closeResult)}>
          <TopicModal
            title={`Результат операции ${operation}`}
            closeLabel={`Закрыть результат ${operation}`}
            className="git-workspace-error"
            onClose={s.closeResult}
          >
            <pre>{s.result}</pre>
          </TopicModal>
        </div>
      )}
    </>
  );
}
