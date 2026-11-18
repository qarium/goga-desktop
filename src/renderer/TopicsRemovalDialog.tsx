import { useEffect, useRef, useState } from "react";
import type { Project } from "../shared/types";
import type { TopicBoardSnapshot } from "../shared/topics";
import type { TopicRemovalPreview } from "../shared/topic-removal";
import { TopicModal, topicError } from "./TopicsCommon";
import { SearchablePicker } from "./SearchablePicker";
import { useReadScope } from "./read-request";
import {
  useTopicRemovalExecutor,
  useTopicRemovalController,
  TopicRemovalPopup,
} from "./TopicRemovalController";
import { useContextDeletionExecutor } from "./ContextDeletionController";
export function TopicsRemovalDialog({
  project,
  year,
  action,
  topics,
  onClose,
  onChanged,
  onBusy,
}: {
  project: Project;
  year: string;
  action: "delete" | "clear";
  topics: string[];
  onClose: () => void;
  onChanged: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const context = useContextDeletionExecutor(),
    local = useTopicRemovalController(context, onChanged),
    global = useTopicRemovalExecutor();
  const [board, setBoard] = useState<TopicBoardSnapshot | null>(null),
    [base, setBase] = useState("");
  const [plan, setPlan] = useState<TopicRemovalPreview | null>(null),
    [checking, setChecking] = useState(false),
    [executing, setExecuting] = useState(false),
    [submitted, setSubmitted] = useState(false),
    [error, setError] = useState(""),
    [ack, setAck] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const selected = [...new Set(topics)].filter((t) => !excluded.includes(t));
  const scope = JSON.stringify([
    project.id,
    year,
    action,
    [...selected].sort(),
  ]);
  const read = useReadScope(scope),
    executingRef = useRef(false),
    epoch = useRef(0),
    checkingEpoch = useRef<number | null>(null);
  const busy = checking || executing;
  // Previews are cancellable reads. Only an explicitly confirmed write owns
  // the workspace's operation lock.
  useEffect(() => {
    onBusy?.(executing);
    return () => onBusy?.(false);
  }, [executing, onBusy]);
  const check = async (chooseBase = false) => {
    const turn = epoch.current;
    if (checkingEpoch.current === turn || executingRef.current) return;
    checkingEpoch.current = turn;
    setChecking(true);
    setError("");
    try {
      if (action === "clear" && (chooseBase || !board)) {
        const fresh = await read("readTopicBoard", project.id, year);
        if (fresh.projectId !== project.id || fresh.year !== year)
          throw Error("Ответ другого проекта или года.");
        if (turn === epoch.current) {
          setBoard(fresh);
          setBase(fresh.baseRef);
        }
        return;
      }
      const next = await read(
        "prepareTopicRemoval",
        action === "delete"
          ? { projectId: project.id, year, action, topics: selected }
          : {
              projectId: project.id,
              year,
              action,
              baseRef: base,
              expectedRevision: board!.revision,
            },
      );
      if (
        next.projectId !== project.id ||
        next.year !== year ||
        next.action !== action
      )
        throw Error("Подтверждение другого действия.");
      if (turn === epoch.current) {
        setPlan(next);
        setAck(false);
      }
    } catch (e) {
      if (turn === epoch.current) {
        if (action === "clear") setBoard(null); // retry must refresh the revision and base choices
        setError(topicError(e));
      }
    } finally {
      if (turn === epoch.current) {
        checkingEpoch.current = null;
        setChecking(false);
      }
    }
  };
  useEffect(() => {
    epoch.current++;
    setPlan(null);
    setAck(false);
    setBoard(null);
    setBase("");
    void check(true);
    return () => {
      epoch.current++;
    };
  }, [scope, read]);
  const confirmationMissing = action === "clear" && !ack;
  const execute = async () => {
    if (
      !plan ||
      confirmationMissing ||
      plan.blocked?.length ||
      busy ||
      executingRef.current
    )
      return;
    executingRef.current = true;
    setExecuting(true);
    setSubmitted(true);
    try {
      await (global ?? local.execute)(plan, project.name);
      onChanged();
      if (global) onClose();
    } catch (e) {
      setSubmitted(false);
      setError(topicError(e));
    } finally {
      executingRef.current = false;
      setExecuting(false);
    }
  };
  return (
    <>
      {!submitted && (
        <TopicModal
          title={
            action === "clear" ? "Очистить топики" : "Удалить выбранные топики"
          }
          className="topic-removal-dialog"
          busy={executing}
          onClose={onClose}
        >
          <div className="topic-removal-body">
            <p className="hint">
              {project.name} · {year}
              {action === "clear" && base ? ` · база ${base}` : ""}
            </p>
            {action === "delete" && (
              <div className="topic-removal-selected">
                <h3>Выбрано топиков: {selected.length}</h3>
                <ul>
                  {selected.map((t) => (
                    <li key={t}>
                      <code>{t}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {action === "clear" && (
              <>
                <p className="topic-warning">
                  Goga определяет подходящие топики выбранного года по базовой
                  ветке. Поиск, фильтры, категории и отмеченные карточки не
                  ограничивают очистку.
                </p>
                {!plan && board && (
                  <SearchablePicker
                    label="Базовая ветка"
                    placeholder="Выберите базовую ветку"
                    emptyLabel="Нет базовой ветки"
                    searchLabel="Найти базовую ветку"
                    searchPlaceholder="Название ветки"
                    listLabel="Базовые ветки"
                    entries={[
                      ...new Set([
                        ...board.branches,
                        ...(board.baseRef ? [board.baseRef] : []),
                      ]),
                    ]}
                    value={base}
                    onChange={setBase}
                    disabled={busy}
                  />
                )}
                {!plan && board && (
                  <button
                    type="button"
                    disabled={busy || !base || !board}
                    onClick={() => void check()}
                  >
                    Проверить и продолжить
                  </button>
                )}
              </>
            )}
            <p className="topic-warning">
              Удаление затрагивает историю топиков и может затронуть ветки на
              origin.{" "}
              {action === "delete"
                ? "После удаления топиков их рабочие копии будут целиком перемещены в Корзину. Вы потеряете все данные в этих копиях: незакоммиченные изменения, неотслеживаемые и игнорируемые файлы, непереданные коммиты."
                : "Рабочие копии проверяются отдельно и перемещаются в Корзину только после удаления топиков."}
            </p>
            {checking && (
              <p className="topic-removal-progress" role="status">
                <span className="loading-spinner" aria-hidden="true" />
                Проверяем топики…
              </p>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            {plan && (
              <>
                <div className="topic-removal-details">
                  <ul>
                    {plan.details.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </div>
                {!!plan.blocked?.length && (
                  <div
                    className="topic-removal-blockers topic-warning"
                    role="alert"
                  >
                    {plan.blocked.map((item) => (
                      <p key={item.topic}>
                        <strong>{item.topic}</strong>: {item.reason}
                      </p>
                    ))}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        const next = [
                          ...excluded,
                          ...plan.blocked!.map((item) => item.topic),
                        ];
                        if (topics.every((t) => next.includes(t))) onClose();
                        else setExcluded(next);
                      }}
                    >
                      Исключить недоступные (
                      {new Set(plan.blocked.map((item) => item.topic)).size})
                    </button>
                  </div>
                )}
                {action === "clear" && !plan.blocked?.length && (
                  <label className="topic-confirm-check">
                    <input
                      type="checkbox"
                      className="desktop-compact-checkbox"
                      checked={ack}
                      disabled={busy}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    Подтверждаю удаление топиков выбранного года по правилам
                    Goga и последующую очистку соответствующих копий.
                  </label>
                )}
              </>
            )}
          </div>
          <footer className="topic-removal-actions">
            <button type="button" disabled={executing} onClick={onClose}>
              Отмена
            </button>
            {plan ? (
              <button
                type="button"
                className="danger"
                disabled={confirmationMissing || busy || !!plan.blocked?.length}
                onClick={() => void execute()}
              >
                {action === "clear" ? "Очистить топики" : "Удалить топики"}
              </button>
            ) : (
              error && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void check()}
                >
                  {action === "clear" && !board
                    ? "Повторить загрузку веток"
                    : "Повторить проверку"}
                </button>
              )
            )}
          </footer>
        </TopicModal>
      )}
      {!global && <TopicRemovalPopup controller={local} onClosed={onClose} />}
    </>
  );
}
