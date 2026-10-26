import { useRef } from "react";
import type { EditorView } from "@codemirror/view";
import {
  GitConflictCodePane,
  type ConflictPaneAnchor,
} from "./GitConflictCodePane";
import { supportedConflict, type GitConflictsState } from "./useGitConflicts";
import { LoadingState } from "./LoadingBoundary";
import { TopicModal } from "./TopicsCommon";
import "./GitConflictEditor.css";

export function GitConflictEditor({
  conflicts,
}: {
  conflicts: GitConflictsState;
}) {
  const views = useRef<
    Partial<Record<"current" | "result" | "incoming", EditorView>>
  >({});
  const linkedPositions = useRef(new WeakMap<EditorView, number>());
  const entry = conflicts.entry;
  const sync = (origin: EditorView) => {
    const positions = linkedPositions.current;
    const top = origin.scrollDOM.scrollTop;
    const expected = positions.get(origin);
    positions.delete(origin);
    // Browser scroll events are asynchronous, including clamped programmatic
    // writes. Do not feed those events back into the pane the user is moving.
    if (expected !== undefined && Math.abs(expected - top) < 1) return;
    const maximum =
      origin.scrollDOM.scrollHeight - origin.scrollDOM.clientHeight;
    for (const view of Object.values(views.current)) {
      if (view === origin) continue;
      const targetMaximum =
        view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight;
      const target =
        maximum > 0 ? (top / maximum) * Math.max(0, targetMaximum) : top;
      if (Math.abs(view.scrollDOM.scrollTop - target) < 1) continue;
      view.scrollDOM.scrollTop = target;
      positions.set(view, view.scrollDOM.scrollTop);
    }
  };
  if (conflicts.loading)
    return (
      <div className="git-conflict-loading">
        <LoadingState label="Загрузка конфликта" />
      </div>
    );
  if (!entry)
    return (
      <div className="git-workspace-empty">
        Не удалось прочитать конфликт.
        <button onClick={conflicts.requestReload}>Перечитать файл…</button>
      </div>
    );
  const { document: doc, draft } = entry;
  const blocked = conflicts.locked || entry.saved;
  const supported = supportedConflict(doc);
  const anchors = (
    side: "current" | "result" | "incoming",
  ): ConflictPaneAnchor[] =>
    (draft?.blocks ?? []).flatMap((block, i) => {
      const range =
        side === "result"
          ? block.mapped
            ? { from: block.from, to: block.to }
            : null
          : block.source[side].range;
      if (!range) return [];
      return [
        {
          range,
          resolved: !!block.choice,
          actions:
            side === "result"
              ? [
                  ...(["current", "incoming"] as const)
                    .filter((sourceSide) => !block.source[sourceSide].range)
                    .map((sourceSide) => ({
                      label: `Блок ${i + 1}: принять ${sourceSide === "current" ? "текущую" : "входящую"}`,
                      symbol: sourceSide === "current" ? "→" : "←",
                      disabled: blocked || !block.mapped,
                      selected: block.choice === sourceSide,
                      run: () => conflicts.apply(block.id, sourceSide),
                    })),
                  {
                    label: `Блок ${i + 1}: принять обе`,
                    symbol: "⇉",
                    disabled: blocked || !block.mapped,
                    selected: block.choice === "both",
                    run: () => conflicts.apply(block.id, "both"),
                  },
                  {
                    label: `Блок ${i + 1}: решён вручную`,
                    symbol: "✓",
                    disabled: blocked || !block.mapped,
                    selected: block.choice === "manual",
                    run: () => conflicts.manual(block.id),
                  },
                ]
              : [
                  {
                    label: `Блок ${i + 1}: принять ${side === "current" ? "текущую" : "входящую"}`,
                    symbol: side === "current" ? "→" : "←",
                    disabled: blocked || !block.mapped,
                    selected: block.choice === side,
                    run: () => conflicts.apply(block.id, side),
                  },
                ],
        },
      ];
    });
  return (
    <section
      className="git-conflict-editor"
      aria-label={`Разрешение конфликта: ${doc.path}`}
    >
      <div className="git-conflict-toolbar">
        <strong title={doc.path}>{doc.path}</strong>
        <button
          disabled={blocked || doc.generated.kind !== "text" || !supported}
          onClick={conflicts.requestReconstruct}
        >
          Восстановить блоки…
        </button>
        <button disabled={conflicts.locked} onClick={conflicts.requestReload}>
          Перечитать файл…
        </button>
      </div>
      {supported &&
        draft &&
        !draft.blocks.length &&
        doc.generated.kind === "text" &&
        doc.generated.blocks.length > 0 && (
          <p className="git-conflict-warning" role="note">
            Рабочий файл отличается от модели конфликта. Ручные правки
            сохранены; для применения блоков нажмите «Восстановить блоки…» и
            подтвердите замену черновика, либо завершите разрешение вручную.
          </p>
        )}
      {!!draft?.blocks.length && (
        <details className="git-conflict-help">
          <summary>Как применять блоки</summary>
          <p>
            → принять текущую · ← принять входящую · ⇉ принять обе · ✓ решено
            вручную. Применение меняет только черновик; запись — по кнопке
            «Сохранить файл…».
          </p>
        </details>
      )}
      {conflicts.stale && (
        <p className="git-conflict-warning" role="note">
          Черновик относится к предыдущему состоянию Git. Текст сохранён в
          памяти, полномочия не обновлены. Для новой версии явно перечитайте
          файл.
        </p>
      )}
      {!supported && (
        <p className="git-conflict-warning">
          Этот вид конфликта не поддерживается для записи:{" "}
          {doc.working.reason ||
            [doc.base, doc.current, doc.incoming, doc.working]
              .filter((s) => !["text", "absent"].includes(s.kind))
              .map((s) => s.reason || s.kind)
              .join("; ")}
          . Файл не помечен решённым.
        </p>
      )}
      {draft?.blocks.some((b) => !b.mapped) && (
        <p className="git-conflict-warning">
          Правка пересекла границу блока. Автоматическое применение недоступно;
          сохраните текст и проверьте результат вручную.
        </p>
      )}
      {draft?.blocks.some(
        (b) => !b.source.current.range || !b.source.incoming.range,
      ) && (
        <p className="git-conflict-warning">
          Позиция части исходных блоков неоднозначна. Для них кнопки принятия
          текущей и входящей версии доступны рядом с блоком результата.
        </p>
      )}
      <div className="git-conflict-panes">
        {(["current", "result", "incoming"] as const).map((side) => {
          const content = side === "result" ? doc.working : doc[side];
          const value = side === "result" ? draft?.text : content.text;
          const label =
            side === "current"
              ? "Текущая версия"
              : side === "incoming"
                ? "Входящая версия"
                : "Результат разрешения";
          return (
            <section
              key={side}
              className={`git-conflict-pane git-conflict-${side}`}
              aria-label={label}
            >
              <header>
                <strong>{side === "result" ? "Результат" : label}</strong>
                <small>
                  {side === "result"
                    ? entry.reconstructed
                      ? "Реконструкция · редактируется"
                      : "Фактический рабочий файл"
                    : "Только чтение"}
                </small>
              </header>
              <div className="git-conflict-code">
                {value !== undefined ? (
                  <GitConflictCodePane
                    label={label}
                    side={side}
                    value={value}
                    readOnly={side !== "result" || blocked || !supported}
                    memory={entry.memory[side]}
                    externalChange={
                      side === "result" ? entry.editorChange : undefined
                    }
                    onExternalChangeRejected={conflicts.rejectEditorChange}
                    anchors={anchors(side)}
                    onEdit={side === "result" ? conflicts.edit : undefined}
                    onView={(view) => {
                      if (view) views.current[side] = view;
                      else delete views.current[side];
                    }}
                    onScroll={sync}
                  />
                ) : (
                  <div className="git-workspace-empty">
                    {content.kind === "absent"
                      ? "Файл отсутствует"
                      : content.reason || `Текст недоступен: ${content.kind}`}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export function GitConflictFooter({
  conflicts,
  disabled,
}: {
  conflicts: GitConflictsState;
  disabled: boolean;
}) {
  const entry = conflicts.entry;
  const blocked =
    disabled ||
    conflicts.locked ||
    !entry ||
    !supportedConflict(entry.document) ||
    entry.uncertain ||
    entry.saved;
  const ready =
    !!entry &&
    (entry.ready ||
      ((entry.reconstructed || !!entry.draft?.blocks.length) &&
        !!entry.draft &&
        entry.draft.blocks.every((b) => b.choice !== null)));
  return (
    <div className="git-conflict-footer">
      <div className="git-conflict-save-row">
        {entry?.draft && (
          <label>
            <input
              type="checkbox"
              checked={entry.ready}
              disabled={blocked}
              onChange={(e) => conflicts.setReady(e.target.checked)}
            />
            Результат проверен вручную
          </label>
        )}
        <span role="status">
          {conflicts.pending?.kind === "execute"
            ? `Записываем ${conflicts.pending.path}… Просмотр можно закрыть.`
            : conflicts.pending?.kind === "prepare"
              ? "Проверяем разрешение…"
              : entry?.saved
                ? "Файл и индекс сохранены."
                : entry?.uncertain
                  ? "Исход записи требует проверки. Повтор заблокирован до явного перечитывания."
                  : entry?.reconstructed || !!entry?.draft?.blocks.length
                    ? `Нерешённых блоков: ${entry.draft?.blocks.filter((b) => !b.choice).length ?? 0}`
                    : "Ручной режим: маркеры в тексте не считаются решениями автоматически."}
        </span>
        {conflicts.pending?.kind === "prepare" && (
          <button onClick={conflicts.cancelPrepare}>Отменить проверку</button>
        )}
        {entry?.log && (
          <button onClick={conflicts.showLog}>Журнал записи</button>
        )}
        <button
          className="primary"
          disabled={blocked || !entry?.draft || !ready}
          onClick={() => {
            if (entry?.draft)
              void conflicts.prepare({ kind: "text", text: entry.draft.text });
          }}
        >
          Сохранить файл…
        </button>
      </div>
      {entry && supportedConflict(entry.document) && (
        <details className="git-conflict-whole-file">
          <summary>Решение для файла целиком</summary>
          <div>
            <button
              disabled={blocked}
              onClick={() => void conflicts.prepare({ kind: "current" })}
            >
              Принять текущий файл…
            </button>
            <button
              disabled={blocked}
              onClick={() => void conflicts.prepare({ kind: "incoming" })}
            >
              Принять входящий файл…
            </button>
            <button
              disabled={blocked}
              onClick={() => void conflicts.prepare({ kind: "delete" })}
            >
              Удалить файл…
            </button>
            <small>
              Заменяет весь файл, включая ручные правки; требуется
              подтверждение.
            </small>
          </div>
        </details>
      )}
    </div>
  );
}
export function GitConflictDialogs({
  conflicts,
}: {
  conflicts: GitConflictsState;
}) {
  return (
    <>
      {conflicts.confirmation && (
        <TopicModal
          title={
            conflicts.confirmation === "reload"
              ? "Перечитать конфликт?"
              : "Восстановить проверенные блоки?"
          }
          closeLabel="Закрыть подтверждение конфликта"
          onClose={conflicts.closeConfirmation}
        >
          <div className="git-conflict-modal-body">
            <p>
              {conflicts.confirmation === "reload"
                ? "Текущий черновик и история редактирования будут отброшены. Рабочий файл на диске не изменится."
                : "Реконструкция заменит текущий черновик и может удалить ручные правки. Она строится из сохранённых версий Git, а не из маркеров в рабочем файле. Файл на диске не изменится."}
            </p>
            <button className="primary" onClick={conflicts.confirm}>
              {conflicts.confirmation === "reload"
                ? "Отбросить черновик и перечитать"
                : "Заменить черновик реконструкцией"}
            </button>
          </div>
        </TopicModal>
      )}
      {conflicts.preview && (
        <TopicModal
          title="Подтвердить разрешение файла"
          closeLabel="Закрыть подтверждение разрешения"
          onClose={conflicts.closePreview}
        >
          <div className="git-conflict-modal-body">
            <dl>
              <dt>Файл</dt>
              <dd>{conflicts.preview.path}</dd>
              <dt>Ветка</dt>
              <dd>{conflicts.preview.branch ?? "Отсоединённый HEAD"}</dd>
              <dt>Решение</dt>
              <dd>
                {
                  {
                    text: "Точный текст результата",
                    current:
                      "Текущий файл целиком (или удаление, если отсутствует)",
                    incoming:
                      "Входящий файл целиком (или удаление, если отсутствует)",
                    delete: "Удалить файл",
                  }[conflicts.preview.resolution]
                }
              </dd>
              <dt>Размер</dt>
              <dd>{conflicts.preview.bytes} байт</dd>
            </dl>
            <p>
              Будут изменены рабочий файл и индекс. Git-хуки отключены.
              Канонизация индекса — по текстовым атрибутам Git. Продолжение
              операции и публикация не выполняются.
            </p>
            <button
              className="primary"
              onClick={() => void conflicts.execute()}
            >
              Записать файл и индекс
            </button>
          </div>
        </TopicModal>
      )}
      {conflicts.message && (
        <TopicModal
          title={conflicts.message.title}
          closeLabel="Закрыть результат разрешения"
          className="git-workspace-error"
          onClose={conflicts.closeMessage}
        >
          <pre>{conflicts.message.text}</pre>
        </TopicModal>
      )}
    </>
  );
}
