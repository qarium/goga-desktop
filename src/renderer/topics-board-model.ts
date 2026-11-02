import type { TopicBoardRecord } from "../shared/topics";

export interface TopicsBoardPreferences {
  schemaVersion: 1;
  view: "table" | "board";
  columns: Array<{ id: string; name: string }>;
  statusCategory: Record<string, string | null>;
}
export const initialStatusCategory: Record<string, string> = {
  empty: "planned",
  todo: "planned",
  backlog: "planned",
  defined: "working",
  discovered: "working",
  prototyped: "working",
  designed: "working",
  planned: "working",
  done: "completed",
};
export function defaultBoardPreferences(): TopicsBoardPreferences {
  return {
    schemaVersion: 1,
    view: "board",
    columns: [
      { id: "planned", name: "Запланировано" },
      { id: "working", name: "В работе" },
      { id: "completed", name: "Завершено" },
    ],
    statusCategory: Object.assign(Object.create(null), initialStatusCategory),
  };
}
export const topicSelectionKey = (
  projectId: string,
  year: string,
  topic: string,
) => JSON.stringify([projectId, year, topic]);
export function columnChecked(keys: string[], selected: ReadonlySet<string>) {
  return keys.length > 0 && keys.every((key) => selected.has(key));
}
export function toggleColumn(keys: string[], selected: ReadonlySet<string>) {
  const next = new Set(selected),
    remove = columnChecked(keys, selected);
  for (const key of keys) remove ? next.delete(key) : next.add(key);
  return next;
}
export function statusCategory(
  prefs: TopicsBoardPreferences,
  status: string,
): string | null {
  const assigned = Object.hasOwn(prefs.statusCategory, status)
    ? prefs.statusCategory[status]
    : null;
  return assigned && prefs.columns.some((c) => c.id === assigned)
    ? assigned
    : null;
}
export interface TopicsBoardColumn {
  id: string;
  name: string;
  rows: TopicBoardRecord[];
  statuses: Array<{ name: string; count: number }>;
}
export function projectTopicsBoard(
  visible: TopicBoardRecord[],
  all: TopicBoardRecord[],
  prefs: TopicsBoardPreferences,
): { columns: TopicsBoardColumn[]; unassigned: TopicsBoardColumn } {
  const unique = (rows: TopicBoardRecord[]) => [
    ...new Map(rows.map((r) => [r.topic, r])).values(),
  ];
  const statuses = [
    ...new Set([
      ...Object.keys(initialStatusCategory),
      ...Object.keys(prefs.statusCategory),
      ...all.flatMap((r) => r.statuses),
    ]),
  ];
  const build = (id: string | null, name: string): TopicsBoardColumn => ({
    id: id ?? "unassigned",
    name,
    rows: unique(
      visible.filter(
        (r) =>
          (!r.statuses.length && id === null) ||
          r.statuses.some((s) => statusCategory(prefs, s) === id),
      ),
    ),
    statuses: statuses
      .filter((s) => statusCategory(prefs, s) === id)
      .map((s) => ({
        name: s,
        count: unique(all.filter((r) => r.statuses.includes(s))).length,
      })),
  });
  return {
    columns: prefs.columns.map((c) => build(c.id, c.name)),
    unassigned: build(null, "Без категории"),
  };
}
export function assignStatus(
  prefs: TopicsBoardPreferences,
  status: string,
  column: string | null,
) {
  if (
    !status ||
    status.length > 256 ||
    (column !== null && !prefs.columns.some((c) => c.id === column))
  )
    throw Error("Недопустимый статус или колонка.");
  if (
    !Object.hasOwn(prefs.statusCategory, status) &&
    Object.keys(prefs.statusCategory).length >= 1000
  )
    throw Error("Слишком много настроенных статусов.");
  return {
    ...prefs,
    statusCategory: { ...prefs.statusCategory, [status]: column },
  };
}
function columnName(
  prefs: TopicsBoardPreferences,
  name: string,
  exclude?: string,
) {
  const clean = name.trim();
  if (!clean || clean.length > 64)
    throw Error("Название колонки: от 1 до 64 символов.");
  if (
    prefs.columns.some(
      (c) =>
        c.id !== exclude &&
        c.name.toLocaleLowerCase() === clean.toLocaleLowerCase(),
    )
  )
    throw Error("Колонка с таким названием уже есть.");
  return clean;
}
export function addBoardColumn(
  prefs: TopicsBoardPreferences,
  name: string,
  id: string,
) {
  if (
    prefs.columns.length >= 50 ||
    !id ||
    id.length > 128 ||
    id === "unassigned" ||
    prefs.columns.some((c) => c.id === id)
  )
    throw Error("Нельзя добавить колонку.");
  return {
    ...prefs,
    columns: [...prefs.columns, { id, name: columnName(prefs, name) }],
  };
}
export function renameBoardColumn(
  prefs: TopicsBoardPreferences,
  id: string,
  name: string,
) {
  if (!prefs.columns.some((c) => c.id === id))
    throw Error("Колонка отсутствует.");
  const clean = columnName(prefs, name, id);
  return {
    ...prefs,
    columns: prefs.columns.map((c) =>
      c.id === id ? { ...c, name: clean } : c,
    ),
  };
}
export function removeBoardColumn(prefs: TopicsBoardPreferences, id: string) {
  if (!prefs.columns.some((c) => c.id === id))
    throw Error("Колонка отсутствует.");
  return {
    ...prefs,
    columns: prefs.columns.filter((c) => c.id !== id),
    statusCategory: Object.fromEntries(
      Object.entries(prefs.statusCategory).map(([s, c]) => [
        s,
        c === id ? null : c,
      ]),
    ),
  };
}
export function reorderBoardColumn(
  prefs: TopicsBoardPreferences,
  id: string,
  index: number,
) {
  const from = prefs.columns.findIndex((c) => c.id === id);
  if (
    from < 0 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= prefs.columns.length
  )
    throw Error("Недопустимый порядок колонок.");
  const columns = [...prefs.columns],
    [column] = columns.splice(from, 1);
  columns.splice(index, 0, column!);
  return { ...prefs, columns };
}
