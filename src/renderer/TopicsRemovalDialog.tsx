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
    [busy, setBusy] = useState(false),
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
    flight = useRef(false),
    epoch = useRef(0);
  useEffect(() => {
    onBusy?.(busy);
    return () => onBusy?.(false);
  }, [busy, onBusy]);
  const prepare = async (selectedBase?: string) => {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    const turn = epoch.current;
    try {
      const fresh = await read("readTopicBoard", project.id, year);
      if (fresh.projectId !== project.id || fresh.year !== year)
        throw Error("Ответ другого проекта или года.");
      const next = await read("prepareTopicRemoval", {
        projectId: project.id,
        year,
        expectedRevision: fresh.revision,
        action,
        ...(action === "delete"
          ? { topics: selected }
          : { baseRef: selectedBase || base }),
      } as any);
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
      if (turn === epoch.current) setError(topicError(e));
    } finally {
      flight.current = false;
      if (turn === epoch.current) setBusy(false);
    }
  };
  useEffect(() => {
    epoch.current++;
    setPlan(null);
    setAck(false);
    setBoard(null);
    setError("");
    const turn = epoch.current;
    if (action === "delete") void prepare();
    else {
      setBusy(true);
      void read("readTopicBoard", project.id, year)
        .then((b) => {
          if (b.projectId !== project.id || b.year !== year)
            throw Error("Ответ другого проекта или года.");
          if (turn === epoch.current) {
            setBoard(b);
            setBase(b.baseRef);
          }
        })
        .catch((e) => {
          if (turn === epoch.current) setError(topicError(e));
        })
        .finally(() => {
          if (turn === epoch.current) setBusy(false);
        });
    }
    return () => {
      epoch.current++;
    };
  }, [scope, read]);
  const execute = async () => {
    if (!plan || !ack || plan.blocked?.length || flight.current) return;
    flight.current = true;
    setBusy(true);
    try {
      await (global ?? local.execute)(plan, project.name);
      onChanged();
      if (global) onClose();
    } catch (e) {
      setError(topicError(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <TopicModal
        title={
          action === "clear" ? "Очистить топики" : "Удалить выбранные топики"
        }
        busy={busy}
        onClose={onClose}
      >
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
            {!plan && (
              <button
                type="button"
                disabled={busy || !base || !board}
                onClick={() => void prepare(base)}
              >
                Проверить и продолжить
              </button>
            )}
          </>
        )}
        <p className="topic-warning">
          Удаление может затронуть ветки на origin и историю топиков. После
          успеха соответствующие проверенные копии целиком перемещаются в
          системную Корзину. Это не скрытие с доски.
        </p>
        {busy && <p role="status">Проверяем топики…</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {plan && (
          <>
            <div className="topic-confirmation">
              <ul>
                {plan.details.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </div>
            {!!plan.blocked?.length && (
              <div className="topic-warning" role="alert">
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
            <label className="topic-confirm-check">
              <input
                type="checkbox"
                checked={ack}
                disabled={busy}
                onChange={(e) => setAck(e.target.checked)}
              />
              Подтверждаю удаление{" "}
              {action === "clear"
                ? "топиков выбранного года по правилам Goga"
                : "перечисленных топиков"}{" "}
              и последующую очистку соответствующих копий.
            </label>
          </>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            Отмена
          </button>
          {plan ? (
            <button
              type="button"
              className="danger"
              disabled={!ack || busy || !!plan.blocked?.length}
              onClick={() => void execute()}
            >
              {action === "clear" ? "Очистить топики" : "Удалить топики"}
            </button>
          ) : (
            error && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void prepare(base)}
              >
                Повторить проверку
              </button>
            )
          )}
        </footer>
      </TopicModal>
      {!global && <TopicRemovalPopup controller={local} />}
    </>
  );
}
