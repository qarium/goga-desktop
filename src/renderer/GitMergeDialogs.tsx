import { useState } from "react";
import type {
  GitBranchInventory,
  GitBranchPreview,
} from "../shared/git-branches";

import { TopicModal } from "./TopicsCommon";

const short = (ref: string | null) =>
  ref?.replace(/^refs\/(heads|remotes)\//, "") ?? "—";

/** Sources are read-only refs, not checkout targets. Dirty files do not disable selection. */
export function GitMergeSource({
  inventory,
  onClose,
  onSelect,
}: {
  inventory: GitBranchInventory;
  onClose(): void;
  onSelect(ref: string): void;
}) {
  const [group, setGroup] = useState<"local" | "remote">("local");
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const rows = inventory[group].filter(
    (row) => row.ref !== `refs/heads/${inventory.branch}`,
  );
  const source = rows.find((row) => row.ref === selected);
  const filtered = rows.filter((row) =>
    row.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <TopicModal
      className="git-merge-source-dialog"
      title="Влить ветку в текущую"
      onClose={onClose}
    >
      <div className="git-branch-form git-merge-source">
        <div
          className="git-branch-groups"
          role="tablist"
          aria-label="Источник слияния"
        >
          {(
            [
              ["local", "Локальные"],
              ["remote", "Remote"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === group}
              onClick={() => {
                setGroup(key);
                setSelected("");
                setQuery("");
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          autoFocus
          aria-label="Найти ветку-источник"
          placeholder="Название ветки"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="hint">
          Веток: {filtered.length} из {rows.length}
        </p>
        <div
          className="git-merge-branch-list"
          role="listbox"
          aria-label="Ветки для слияния"
        >
          {filtered.map((row, index) => (
            <button
              type="button"
              role="option"
              key={row.ref}
              aria-selected={selected === row.ref}
              title={row.name}
              onClick={() => setSelected(row.ref)}
              onKeyDown={(event) => {
                const offset =
                  event.key === "ArrowDown"
                    ? 1
                    : event.key === "ArrowUp"
                      ? -1
                      : 0;
                if (!offset && event.key !== "Home" && event.key !== "End")
                  return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? filtered.length - 1
                      : Math.max(
                          0,
                          Math.min(filtered.length - 1, index + offset),
                        );
                (
                  event.currentTarget.parentElement?.children[next] as
                    HTMLElement | undefined
                )?.focus();
              }}
            >
              {row.name}
            </button>
          ))}
          {!filtered.length && <p className="hint">Нет доступных веток</p>}
        </div>
        <p className="git-merge-selection">
          Из ветки <strong>{source?.name ?? "Не выбрана"}</strong>
        </p>
        <p className="git-merge-target">
          В текущую ветку <strong>{inventory.branch}</strong>
        </p>
        <details className="git-merge-conditions">
          <summary>Условия слияния</summary>
          <p>
            Без переключения. Fast-forward, если возможен, иначе merge-коммит.
            Без публикации.
          </p>
          {inventory.dirty && (
            <p className="hint">
              Незакоммиченные изменения сами по себе не блокируют слияние и не
              должны попасть в merge-коммит. Если Git не может их сохранить,
              операция остановится.
            </p>
          )}
          {group === "remote" && (
            <p className="hint">
              Используется уже полученная remote-ветка. Запрос к серверу не
              выполняется.
            </p>
          )}
        </details>
        <div className="git-branch-dialog-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="primary"
            disabled={!source}
            onClick={() => source && onSelect(source.ref)}
          >
            Продолжить
          </button>
        </div>
      </div>
    </TopicModal>
  );
}

export function GitMergeConfirmation({
  preview,
  onClose,
  onConfirm,
}: {
  preview: GitBranchPreview;
  onClose(): void;
  onConfirm(): void;
}) {
  const abort = preview.action === "abort-merge";
  return (
    <TopicModal
      title={abort ? "Отменить слияние?" : "Подтвердить слияние"}
      onClose={onClose}
    >
      <div className="git-branch-form">
        <p className="context-path">{preview.root}</p>
        <dl className="git-branch-summary">
          <dt>{abort ? "Входящий коммит" : "Источник"}</dt>
          <dd>
            {preview.sourceRef && `${short(preview.sourceRef)} · `}
            {preview.sourceOid?.slice(0, 8) ?? "—"}
          </dd>
          <dt>{abort ? "Текущая ветка" : "В текущую ветку"}</dt>
          <dd>
            {short(preview.toRef)} · {preview.toOid?.slice(0, 8) ?? "—"}
          </dd>
        </dl>
        {abort ? (
          <>
            <p>
              Ручные решения конфликтов будут потеряны. Git попробует штатно
              отменить незавершённое слияние; текущая ветка не переключится.
            </p>
            <p>
              Если отмена невозможна, появится лог, а состояние останется
              доступным для восстановления. Принудительного сброса не будет.
            </p>
          </>
        ) : (
          <>
            <p>
              Fast-forward, если возможен, иначе Git автоматически создаст
              merge-коммит. Без переключения ветки и публикации в remote.
            </p>
            <p>
              Авторство и подпись — из настроек репозитория. Незакоммиченные
              изменения не включаются в merge-коммит; при риске перезаписи Git
              остановится.
            </p>
          </>
        )}
        <p className="hint">
          Без force, автоматического stash и сброса файлов. Git-хуки отключены.
        </p>
        <div className="git-branch-dialog-actions">
          <button type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className={abort ? "danger" : "primary"}
            onClick={onConfirm}
          >
            {abort ? "Отменить слияние" : `Влить в ${short(preview.toRef)}`}
          </button>
        </div>
      </div>
    </TopicModal>
  );
}
