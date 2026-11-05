import { useState } from "react";
import type {
  OverviewPasteConflict,
  OverviewPasteDecision,
} from "../../shared/project-overview";
import { TopicModal } from "../TopicsCommon";
export function PasteConflictDialog({
  conflicts,
  blocked,
  onConfirm,
  onCancel,
}: {
  conflicts: OverviewPasteConflict[];
  blocked: (path: string) => boolean;
  onConfirm: (decisions: OverviewPasteDecision[]) => void;
  onCancel: () => void;
}) {
  const [decisions, setDecisions] = useState<OverviewPasteDecision[]>([]);
  const [all, setAll] = useState(false);
  const remaining = conflicts.filter(
    (c) => !decisions.some((d) => d.path === c.path),
  );
  const current = remaining[0];
  const dirty = blocked(current.path);
  const choose = (action: OverviewPasteDecision["action"]) => {
    const targets = all
      ? remaining.filter(
          (c) => action === "skip" || (c.replaceable && !blocked(c.path)),
        )
      : [current];
    const next = [
      ...decisions,
      ...targets.map((c) => ({ path: c.path, action })),
    ];
    if (next.length === conflicts.length) onConfirm(next);
    else setDecisions(next);
  };
  return (
    <TopicModal
      title="Файл уже существует"
      closeLabel="Закрыть подтверждение вставки"
      className="ov-paste-dialog"
      onClose={onCancel}
    >
      <div className="ov-paste-text">
        <div className="ov-paste-intro">
          <p>Объект с таким именем уже есть в папке назначения:</p>
          <p className="ov-paste-conflict-path">
            <strong>{current.path}</strong>
          </p>
        </div>
        <p className="ov-hint">
          Осталось совпадений: {remaining.length}. Папки объединяются, остальные
          файлы сохраняются.
        </p>
        {dirty ? (
          <p role="status">
            В этом файле есть несохранённые изменения или выполняется
            сохранение. Можно пропустить его; черновик останется в редакторе.
          </p>
        ) : !current.replaceable ? (
          <p role="status">
            Этот объект нельзя безопасно заменить файлом другого типа. Можно
            пропустить его.
          </p>
        ) : (
          <p>Заменить существующий файл скопированным?</p>
        )}
      </div>
      <label className="ov-paste-apply-all">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        Применить ко всем
      </label>
      <footer>
        <button onClick={onCancel}>Отменить вставку</button>
        <button onClick={() => choose("skip")}>Пропустить</button>
        <button
          className="primary"
          disabled={!current.replaceable || dirty}
          onClick={() => choose("replace")}
        >
          Заменить
        </button>
      </footer>
    </TopicModal>
  );
}
