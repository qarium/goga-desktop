import { useState, type CSSProperties, type ReactNode } from "react";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GripVertical,
  Plus,
  Undo2,
  X,
} from "lucide-react";
import type { TopicBoardRecord } from "../shared/topics";
import {
  addBoardColumn,
  assignStatus,
  columnChecked,
  projectTopicsBoard,
  removeBoardColumn,
  renameBoardColumn,
  reorderBoardColumn,
  topicSelectionKey,
  toggleColumn,
  type TopicsBoardColumn,
  type TopicsBoardPreferences,
} from "./topics-board-model";
import "./TopicsBoard.css";
interface Props {
  projectId: string;
  year: string;
  rows: TopicBoardRecord[];
  allRows: TopicBoardRecord[];
  preferences: TopicsBoardPreferences;
  onPreferences: (next: TopicsBoardPreferences) => void;
  selected: ReadonlySet<string>;
  onSelection: (next: Set<string>) => void;
  onOpen: (row: TopicBoardRecord) => void;
  renderActions?: (row: TopicBoardRecord) => ReactNode;
  renderMeta?: (row: TopicBoardRecord) => ReactNode;
}
export function TopicsBoard(props: Props) {
  const { preferences: prefs, onPreferences } = props;
  const board = projectTopicsBoard(props.rows, props.allRows, prefs);
  const [expanded, setExpanded] = useState(false),
    [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [undo, setUndo] = useState<TopicsBoardPreferences | null>(null),
    [dragEpoch, setDragEpoch] = useState(0);
  function apply(next: () => TopicsBoardPreferences, text: string) {
    try {
      const value = next();
      setUndo(prefs);
      onPreferences(value);
      setError("");
      setMessage(text);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить доску.");
    }
  }
  const moveStatus = (status: string, from: string, direction: number) => {
    const ids = ["unassigned", ...prefs.columns.map((c) => c.id)];
    const next = ids[ids.indexOf(from) + direction];
    if (next)
      apply(
        () => assignStatus(prefs, status, next === "unassigned" ? null : next),
        `Статус ${status} перемещён.`,
      );
  };
  const editor = (id: string) => (
    <form
      className="topic-board-inline"
      onSubmit={(e) => {
        e.preventDefault();
        apply(
          () =>
            id === "new"
              ? addBoardColumn(prefs, name, crypto.randomUUID())
              : renameBoardColumn(prefs, id, name),
          "Колонка сохранена.",
        );
      }}
    >
      <input
        autoFocus
        aria-label={
          id === "new" ? "Название новой колонки" : "Название колонки"
        }
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="submit"
        aria-label={id === "new" ? "Создать колонку" : "Сохранить название"}
      >
        <Check />
      </button>
      <button
        type="button"
        aria-label="Отменить редактирование колонки"
        onClick={() => {
          setEditing(null);
          setError("");
        }}
      >
        <X />
      </button>
    </form>
  );
  const content = (column: TopicsBoardColumn, unassigned = false) => (
    <StatusSlot id={column.id}>
      <div className="topic-board-chips">
        {column.statuses.map((status) => (
          <StatusChip
            key={status.name}
            status={status.name}
            count={status.count}
            unassigned={unassigned}
            onMove={(direction) =>
              moveStatus(status.name, column.id, direction)
            }
          />
        ))}
        {!column.statuses.length && (
          <span className="topic-board-drop-hint">Перетащите сюда статусы</span>
        )}
      </div>
      {(!unassigned || expanded) && (
        <div
          className={
            unassigned ? "topic-board-unassigned-cards" : "topic-board-cards"
          }
        >
          {column.rows.map((row) => {
            const key = topicSelectionKey(
                props.projectId,
                props.year,
                row.topic,
              ),
              checked = props.selected.has(key);
            return (
              <article
                className={`topic-board-card${checked ? " selected" : ""}`}
                key={row.topic}
              >
                <div className="topic-board-title-row">
                  <input
                    type="checkbox"
                    aria-label={`Выбрать топик ${row.topic}`}
                    checked={checked}
                    onChange={() => {
                      const next = new Set(props.selected);
                      checked ? next.delete(key) : next.add(key);
                      props.onSelection(next);
                    }}
                  />
                  <button
                    type="button"
                    className="topic-board-title"
                    aria-label={`Открыть топик ${row.topic}`}
                    onClick={() => props.onOpen(row)}
                  >
                    {row.topic}
                  </button>
                </div>
                <div className="topic-board-branch">
                  <GitBranch />
                  <span>{row.branch}</span>
                </div>
                <div className="topic-board-badges">
                  {[...new Set(row.statuses)].map((status) => (
                    <span key={status}>{status}</span>
                  ))}
                </div>
                {row.statusError && (
                  <p className="hint" title={row.statusError}>
                    Статусы требуют проверки
                  </p>
                )}
                <div className="topic-board-footer">
                  {props.renderMeta && (
                    <div className="topic-board-meta">
                      {props.renderMeta(row)}
                    </div>
                  )}
                  {props.renderActions && (
                    <div className="topic-board-card-actions">
                      {props.renderActions(row)}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          {!column.rows.length && (
            <p className="topic-board-empty">Нет топиков</p>
          )}
        </div>
      )}
    </StatusSlot>
  );
  const selectColumn = (column: TopicsBoardColumn) => {
    const keys = column.rows.map((r) =>
      topicSelectionKey(props.projectId, props.year, r.topic),
    );
    return (
      <input
        type="checkbox"
        aria-label={`Выбрать топики колонки ${column.name}`}
        disabled={!keys.length}
        checked={columnChecked(keys, props.selected)}
        onChange={() => props.onSelection(toggleColumn(keys, props.selected))}
      />
    );
  };
  return (
    <div className="topics-board-workspace">
      <div className="topic-board-help">
        <span>Перетаскивайте статусы между колонками, колонки — за ручку.</span>
        <button
          type="button"
          onClick={() => {
            setEditing("new");
            setName("");
            setError("");
          }}
          disabled={prefs.columns.length >= 50}
        >
          <Plus />
          Добавить колонку
        </button>
      </div>
      {message && (
        <div className="topic-board-message">
          <span>{message}</span>
          {undo && (
            <button
              type="button"
              aria-label="Отменить изменение доски"
              onClick={() => {
                onPreferences(undo);
                setUndo(null);
                setMessage("Последнее изменение отменено.");
              }}
            >
              <Undo2 />
              Отменить
            </button>
          )}
        </div>
      )}
      {editing === "new" && editor("new")}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <DragDropProvider
        key={dragEpoch}
        onDragEnd={(event) => {
          const { source, target } = event.operation;
          if (!event.canceled && source && target) {
            if (
              source.data.kind === "status" &&
              target.data.kind === "status-slot"
            ) {
              const column = String(target.data.column);
              apply(
                () =>
                  assignStatus(
                    prefs,
                    String(source.data.status),
                    column === "unassigned" ? null : column,
                  ),
                `Статус ${source.data.status} перемещён.`,
              );
            } else if (source.data.kind === "column" && isSortable(source)) {
              apply(
                () =>
                  reorderBoardColumn(
                    prefs,
                    String(source.data.column),
                    source.index,
                  ),
                "Порядок колонок изменён.",
              );
            }
          }
          // Cancelled/outside drops must undo the library's optimistic DOM ordering.
          setDragEpoch((n) => n + 1);
        }}
      >
        <section
          className="topic-board-unassigned"
          role="region"
          aria-label="Без категории"
        >
          <div className="topic-board-column-heading">
            {selectColumn(board.unassigned)}
            <strong>Без категории</strong>
            <span className="hint">
              Статусов: {board.unassigned.statuses.length}
            </span>
            <button
              type="button"
              className="topic-board-disclosure"
              aria-label={expanded ? "Скрыть топики" : "Показать топики"}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown /> : <ChevronRight />}
              {expanded ? "Скрыть топики" : "Показать топики"} (
              {board.unassigned.rows.length})
            </button>
          </div>
          {content(board.unassigned, true)}
        </section>
        <div
          className="topics-board"
          style={
            {
              "--topic-column-count": Math.max(1, prefs.columns.length),
            } as CSSProperties
          }
        >
          {board.columns.map((column, index) => (
            <SortableColumn
              key={column.id}
              column={column}
              index={index}
              onMove={(direction) => {
                const next = index + direction;
                if (next >= 0 && next < prefs.columns.length)
                  apply(
                    () => reorderBoardColumn(prefs, column.id, next),
                    "Порядок колонок изменён.",
                  );
              }}
            >
              {editing === column.id ? (
                editor(column.id)
              ) : (
                <div className="topic-board-column-heading">
                  {selectColumn(column)}
                  <button
                    className="topic-board-column-name"
                    type="button"
                    aria-label={`Переименовать колонку ${column.name}`}
                    onClick={() => {
                      setEditing(column.id);
                      setName(column.name);
                      setError("");
                    }}
                  >
                    {column.name}
                  </button>
                  <span className="topic-board-count">
                    {column.rows.length}
                  </span>
                  <button
                    className="topic-board-remove"
                    type="button"
                    aria-label={`Удалить колонку ${column.name}`}
                    onClick={() =>
                      apply(
                        () => removeBoardColumn(prefs, column.id),
                        `Колонка «${column.name}» удалена. Топики сохранены.`,
                      )
                    }
                  >
                    <X />
                  </button>
                </div>
              )}
              {content(column)}
            </SortableColumn>
          ))}
        </div>
      </DragDropProvider>
      <span className="sr-only" aria-live="polite">
        {message}
      </span>
      <p className="topic-board-footnote">
        Категории меняют только представление доски, не статусы топиков. Для
        клавиатуры: Alt + ← / → на статусе или ручке колонки.
      </p>
    </div>
  );
}
function StatusChip({
  status,
  count,
  unassigned,
  onMove,
}: {
  status: string;
  count: number;
  unassigned: boolean;
  onMove: (direction: number) => void;
}) {
  const { ref, isDragging } = useDraggable({
    id: `status:${status}`,
    type: "status",
    data: { kind: "status", status },
  });
  return (
    <button
      type="button"
      ref={ref}
      className={`topic-board-status${unassigned ? " unmapped" : ""}`}
      aria-label={`Перетащить статус ${status}, топиков: ${count}`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      onKeyDown={(e) => {
        if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          onMove(e.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <GripVertical />
      <span>{status}</span>
    </button>
  );
}
function StatusSlot({ id, children }: { id: string; children: ReactNode }) {
  const { ref, isDropTarget } = useDroppable({
    id: `status-slot:${id}`,
    accept: "status",
    data: { kind: "status-slot", column: id },
  });
  return (
    <div
      ref={ref}
      className={`topic-board-status-area${isDropTarget ? " drop-active" : ""}`}
    >
      {children}
    </div>
  );
}
function SortableColumn({
  column,
  index,
  onMove,
  children,
}: {
  column: TopicsBoardColumn;
  index: number;
  onMove: (direction: number) => void;
  children: ReactNode;
}) {
  const { ref, handleRef, isDragging } = useSortable({
    id: `column:${column.id}`,
    index,
    group: "columns",
    type: "column",
    accept: "column",
    data: { kind: "column", column: column.id },
  });
  return (
    <section
      ref={ref}
      role="region"
      aria-label={column.name}
      className={`topic-board-column${isDragging ? " dragging" : ""}`}
    >
      <button
        className="topic-board-column-handle"
        ref={handleRef}
        type="button"
        aria-label={`Переместить колонку ${column.name}`}
        onKeyDown={(e) => {
          if (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) {
            e.preventDefault();
            e.stopPropagation();
            onMove(e.key === "ArrowLeft" ? -1 : 1);
          }
        }}
      >
        <GripVertical />
      </button>
      {children}
    </section>
  );
}
