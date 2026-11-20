import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
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
  useLocale();
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
      setError(e instanceof Error ? e.message : tr("topics.couldNotUpdateTheBoard"));
    }
  }
  const moveStatus = (status: string, from: string, direction: number) => {
    const ids = ["unassigned", ...prefs.columns.map((c) => c.id)];
    const next = ids[ids.indexOf(from) + direction];
    if (next)
      apply(
        () => assignStatus(prefs, status, next === "unassigned" ? null : next),
        tr("topics.statusStatusMoved", { status: status }),
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
          tr("topics.columnSaved"),
        );
      }}
    >
      <input
        autoFocus
        aria-label={
          id === "new" ? tr("topics.newColumnName") : tr("topics.columnName")
        }
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        type="submit"
        aria-label={id === "new" ? tr("topics.createColumn") : tr("topics.saveName")}
      >
        <Check />
      </button>
      <button
        type="button"
        aria-label={tr("topics.cancelEditingColumn")}
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
          <span className="topic-board-drop-hint">{tr("topics.dragStatusesHere")}</span>
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
                    aria-label={tr("topics.selectTopicTopic", { topic: row.topic })}
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
                    aria-label={tr("topics.openTopicTopic", { topic: row.topic })}
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
                  <p className="hint" title={row.statusError}>{tr("topics.statusesNeedReview")}</p>
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
            <p className="topic-board-empty">{tr("topics.noTopics")}</p>
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
        aria-label={tr("topics.selectTopicsInName", { name: column.name })}
        disabled={!keys.length}
        checked={columnChecked(keys, props.selected)}
        onChange={() => props.onSelection(toggleColumn(keys, props.selected))}
      />
    );
  };
  return (
    <div className="topics-board-workspace">
      <div className="topic-board-help">
        <span>{tr("topics.dragStatusesBetweenColumnsDragAColumnBy")}</span>
        <button
          type="button"
          onClick={() => {
            setEditing("new");
            setName("");
            setError("");
          }}
          disabled={prefs.columns.length >= 50}
        >
          <Plus />{tr("topics.addColumn")}</button>
      </div>
      {message && (
        <div className="topic-board-message">
          <span>{message}</span>
          {undo && (
            <button
              type="button"
              aria-label={tr("topics.undoBoardChange")}
              onClick={() => {
                onPreferences(undo);
                setUndo(null);
                setMessage(tr("topics.lastChangeUndone"));
              }}
            >
              <Undo2 />{tr("topics.undo")}</button>
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
                tr("topics.statusStatusMoved", { status: source.data.status }),
              );
            } else if (source.data.kind === "column" && isSortable(source)) {
              apply(
                () =>
                  reorderBoardColumn(
                    prefs,
                    String(source.data.column),
                    source.index,
                  ),
                tr("topics.columnOrderUpdated"),
              );
            }
          }
          // Cancelled/outside drops must undo the library's optimistic DOM ordering.
          setDragEpoch((n) => n + 1);
        }}
      >
        {board.unassigned.statuses.length > 0 && (
          <section
            className="topic-board-unassigned"
            role="region"
            aria-label={tr("topics.unassigned")}
          >
            <div className="topic-board-column-heading">
              {selectColumn(board.unassigned)}
              <strong>{tr("topics.unassigned")}</strong>
              <span className="hint">{tr("topics.statuses2")}{board.unassigned.statuses.length}
              </span>
              <button
                type="button"
                className="topic-board-disclosure"
                aria-label={expanded ? tr("topics.hideTopics") : tr("topics.showTopics")}
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <ChevronDown /> : <ChevronRight />}
                {expanded ? tr("topics.hideTopics") : tr("topics.showTopics")} (
                {board.unassigned.rows.length})
              </button>
            </div>
            {content(board.unassigned, true)}
          </section>
        )}
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
              editing={editing === column.id}
              onMove={(direction) => {
                const next = index + direction;
                if (next >= 0 && next < prefs.columns.length)
                  apply(
                    () => reorderBoardColumn(prefs, column.id, next),
                    tr("topics.columnOrderUpdated"),
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
                    aria-label={tr("topics.renameColumnName", { name: column.name })}
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
                    aria-label={tr("topics.deleteColumnName", { name: column.name })}
                    onClick={() =>
                      apply(
                        () => removeBoardColumn(prefs, column.id),
                        tr("topics.columnNameDeletedTopicsWereKept", { name: column.name }),
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
      <p className="topic-board-footnote">{tr("topics.categoriesChangeOnlyTheBoardLayoutNotTopic")}</p>
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
  useLocale();
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
      aria-label={tr("topics.dragStatusStatusTopicsCount", { status: status, count: count })}
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
  useLocale();
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
  editing,
  onMove,
  children,
}: {
  column: TopicsBoardColumn;
  index: number;
  editing: boolean;
  onMove: (direction: number) => void;
  children: ReactNode;
}) {
  useLocale();
  const { ref, handleRef, isDragging } = useSortable({
    id: `column:${column.id}`,
    index,
    disabled: editing,
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
      {!editing && (
        <button
          className="topic-board-column-handle"
          ref={handleRef}
          type="button"
          aria-label={tr("topics.moveColumnName", { name: column.name })}
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
      )}
      {children}
    </section>
  );
}
