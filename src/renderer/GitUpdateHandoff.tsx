import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import { gitFilePathSchema, gitRevisionSchema } from "../shared/git-workspace";
import {
  gitUpdateHandoffRequestSchema,
  gitUpdateHandoffTokenSchema,
  gitUpdateStrategySchema,
  type GitUpdateHandoffCandidate,
  type GitUpdateHandoffPreview,
} from "../shared/git-update-handoff";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { TopicModal, topicError } from "./TopicsCommon";
const text = z
  .string()
  .min(1)
  .refine((v) => !v.includes("\0"));
const rootSchema = text.refine((v) => v.startsWith("/"));
const oid = z.string().regex(/^[a-f0-9]{40}$/);
const algorithmSchema = z.enum(["merge", "rebase"]);
const candidateSchema = z.object({
  candidateId: gitUpdateHandoffTokenSchema,
  scope: scopeRefSchema,
  root: rootSchema,
  targetBranch: text,
  targetHead: oid,
  sourceRef: text,
  sourceOid: oid,
  baseRef: text,
  strategy: gitUpdateStrategySchema,
  algorithm: algorithmSchema,
  conflicts: z.array(gitFilePathSchema).min(1),
  expiresAt: z.number().finite(),
});
const previewSchema = z.object({
  token: gitUpdateHandoffTokenSchema,
  candidate: candidateSchema,
  hooks: z.literal("disabled"),
  publishes: z.literal(false),
  effects: text,
  expiresAt: z.number().finite(),
});
const identitySchema = z.object({
  scope: scopeRefSchema,
  root: rootSchema,
  algorithm: algorithmSchema,
});
const resultSchema = identitySchema.extend({
  status: z.enum(["conflict", "error", "uncertain"]),
  changed: z.boolean(),
  conflicts: z.array(gitFilePathSchema),
  message: z.string(),
  log: z.string(),
});
function candidateKey(c: GitUpdateHandoffCandidate) {
  return JSON.stringify([
    documentScopeId(c.scope),
    c.candidateId,
    c.root,
    c.targetBranch,
    c.targetHead,
    c.sourceRef,
    c.sourceOid,
    c.baseRef,
    c.strategy,
    c.algorithm,
    c.conflicts,
    c.expiresAt,
  ]);
}
interface Props {
  autoPrepare?: boolean;
  candidate: GitUpdateHandoffCandidate;
  onClose(): void;
  onChanged(scope: ScopeRef): void;
}
/** Each exact candidate owns its reads, confirmation and non-cancellable write. */
export function GitUpdateHandoff(props: Props) {
  return <HandoffConfirmation key={candidateKey(props.candidate)} {...props} />;
}
function HandoffConfirmation({
  candidate,
  onClose,
  onChanged,
  autoPrepare = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false);
  const [pending, setPending] = useState<"prepare" | "execute" | null>(null);
  const [preview, setPreview] = useState<GitUpdateHandoffPreview | null>(null);
  const [error, setError] = useState("");
  const [report, setReport] = useState("");
  const alive = useRef(true),
    dismissed = useRef(false),
    flight = useRef(false);
  const read = useRef<AbortController | null>(null);
  const callbacks = useRef({ onClose, onChanged });
  callbacks.current = { onClose, onChanged };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      read.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!preview) return;
    const timeout = setTimeout(
      () => {
        setPreview(null);
        setError(
          "Срок подтверждения истёк. Закройте окно и проверьте состояние заново.",
        );
      },
      Math.max(
        0,
        Math.min(preview.expiresAt, candidate.expiresAt) - Date.now(),
      ),
    );
    return () => clearTimeout(timeout);
  }, [preview, candidate.expiresAt]);
  const current = () => alive.current && !dismissed.current;
  function close() {
    dismissed.current = true;
    read.current?.abort();
    setClosed(true);
    callbacks.current.onClose();
  }
  async function prepare() {
    if (flight.current || !current()) return;
    flight.current = true;
    setOpen(true);
    setPending("prepare");
    const controller = new AbortController();
    read.current = controller;
    try {
      if (
        !candidateSchema.safeParse(candidate).success ||
        candidate.expiresAt <= Date.now()
      )
        throw Error("Предложение устарело или содержит непроверенные поля.");
      const raw = await readWithSignal(
        controller.signal,
        "readGitWorkspace",
        candidate.scope,
      );
      if (!current() || controller.signal.aborted) return;
      const snapshot = z
        .object({
          scope: scopeRefSchema,
          root: rootSchema,
          revision: gitRevisionSchema,
          head: oid,
          branch: text,
          operation: z.literal("none"),
        })
        .safeParse(raw);
      if (
        !snapshot.success ||
        documentScopeId(snapshot.data.scope) !==
          documentScopeId(candidate.scope) ||
        snapshot.data.root !== candidate.root ||
        snapshot.data.head !== candidate.targetHead ||
        snapshot.data.branch !== candidate.targetBranch
      )
        throw Error(
          "Состояние Git устарело или относится к другому контексту. Обновите изменения.",
        );
      const request = gitUpdateHandoffRequestSchema.parse({
        scope: candidate.scope,
        revision: snapshot.data.revision,
        candidateId: candidate.candidateId,
      });
      const response = await readWithSignal(
        controller.signal,
        "prepareGitUpdateHandoff",
        request,
      );
      if (!current() || controller.signal.aborted) return;
      const checked = previewSchema.safeParse(response);
      if (
        !checked.success ||
        candidateKey(checked.data.candidate) !== candidateKey(candidate) ||
        checked.data.expiresAt <= Date.now() ||
        candidate.expiresAt <= Date.now()
      )
        throw Error(
          "Подтверждение устарело или относится к другому контексту, состоянию либо алгоритму. Его данные не показаны.",
        );
      setPreview(checked.data);
    } catch (e) {
      if (current() && !controller.signal.aborted) setError(topicError(e));
    } finally {
      if (read.current === controller) read.current = null;
      flight.current = false;
      if (current()) setPending(null);
    }
  }
  async function execute() {
    if (
      !preview ||
      flight.current ||
      !current() ||
      preview.expiresAt <= Date.now() ||
      candidate.expiresAt <= Date.now()
    )
      return;
    const submitted = preview;
    // Consume the single authorization before awaiting. Never cancel or retry writes.
    flight.current = true;
    setPreview(null);
    setPending("execute");
    try {
      const value = await window.goga.executeGitUpdateHandoff(submitted.token);
      if (!current()) return;
      const identity = identitySchema.safeParse(value);
      if (
        !identity.success ||
        documentScopeId(identity.data.scope) !==
          documentScopeId(candidate.scope) ||
        identity.data.root !== candidate.root ||
        identity.data.algorithm !== candidate.algorithm
      )
        throw Error(
          "Результат относится к другому контексту, рабочей папке или алгоритму; его данные не показаны.",
        );
      const checked = resultSchema.safeParse(value);
      const verified =
        checked.success &&
        checked.data.status === "conflict" &&
        checked.data.changed &&
        checked.data.conflicts.length > 0;
      const diagnostics = value as unknown as Record<string, unknown>;
      setReport(
        [
          verified
            ? "Конфликт подтверждён. Разрешите файлы в редакторе конфликтов; операция ещё не завершена."
            : "Результат не подтверждён. Проверьте состояние Git: изменения могли произойти. Автоматического повтора не будет.",
          typeof diagnostics.message === "string"
            ? diagnostics.message
            : "Сообщение не получено.",
          typeof diagnostics.log === "string"
            ? diagnostics.log
            : "Журнал не получен.",
        ].join("\n\n"),
      );
      if (verified) callbacks.current.onChanged(candidate.scope);
    } catch (e) {
      if (current())
        setError(
          `${topicError(e)}\n\nРезультат не подтверждён. Проверьте состояние Git: операция могла выполниться. Автоматического повтора не будет.`,
        );
    } finally {
      flight.current = false;
      if (current()) setPending(null);
    }
  }
  useEffect(() => {
    let active = true;
    if (autoPrepare)
      void Promise.resolve().then(() => {
        if (active) void prepare();
      });
    return () => {
      active = false;
    };
  }, [autoPrepare]);
  if (closed) return null;
  const p = preview?.candidate;
  return (
    <>
      {!autoPrepare && (
        <button type="button" disabled={open} onClick={() => void prepare()}>
          Разрешить конфликт вручную…
        </button>
      )}
      {open && (
        <div
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <TopicModal
            title="Переход к ручному разрешению конфликта"
            closeLabel="Закрыть подтверждение перехода"
            className="git-merge-operation-modal"
            onClose={close}
          >
            <div className="git-merge-operation-form">
              {pending === "prepare" && (
                <p role="status">Проверяем состояние Git…</p>
              )}
              {pending === "execute" && (
                <p role="status">
                  Создаём конфликт… Просмотр можно закрыть; запись не
                  отменяется.
                </p>
              )}
              {error && <pre role="alert">{error}</pre>}
              {report && <pre role="status">{report}</pre>}
              {p && (
                <>
                  <div className="git-merge-operation-details">
                    <dl>
                      <dt>Контекст</dt>
                      <dd>
                        {typeof p.scope === "string"
                          ? p.scope
                          : `${p.scope.projectId} / ${p.scope.year} / ${p.scope.topic} · ${p.scope.contextId}`}
                      </dd>
                      <dt>Рабочая папка</dt>
                      <dd>{p.root}</dd>
                      <dt>Целевая ветка</dt>
                      <dd>{p.targetBranch}</dd>
                      <dt>Текущий HEAD</dt>
                      <dd>{p.targetHead}</dd>
                      <dt>Источник</dt>
                      <dd>{p.sourceRef}</dd>
                      <dt>Коммит источника</dt>
                      <dd>{p.sourceOid}</dd>
                      <dt>Базовая ветка</dt>
                      <dd>{p.baseRef}</dd>
                      <dt>Стратегия обновления</dt>
                      <dd>{p.strategy}</dd>
                      <dt>Алгоритм</dt>
                      <dd>{p.algorithm}</dd>
                    </dl>
                    <p className="git-conflict-warning">{preview.effects}</p>
                    <p>
                      В текущей рабочей папке начнётся {p.algorithm}. Файлы и
                      индекс будут изменены; операция остановится на конфликте.
                      Продолжение или отмена потребует отдельного подтверждения.
                    </p>
                    <ul>
                      {p.conflicts.map((path) => (
                        <li key={path}>
                          <code>{path}</code>
                        </li>
                      ))}
                    </ul>
                    <p className="hint">
                      Git-хуки отключены. Результат не публикуется на сервер.
                    </p>
                  </div>
                  <div className="git-merge-operation-confirm">
                    <div className="git-branch-dialog-actions">
                      <button type="button" onClick={close}>
                        Отмена
                      </button>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void execute()}
                      >
                        Подтвердить переход к конфликту
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </TopicModal>
        </div>
      )}
    </>
  );
}
