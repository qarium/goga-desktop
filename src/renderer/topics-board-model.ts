import legacyRussianLabels from "../../locales/legacy-topic-board-v1.json";
import { t as tr } from "../shared/i18n";
import type { TopicBoardRecord } from "../shared/topics";

export interface TopicsBoardPreferences {
  schemaVersion: 1;
  view: "table" | "board";
  columns: Array<{ id: string; name: string; builtInName?: boolean }>;
  statusCategory: Record<string, string | null>;
}
const defaultLabelKeys = { planned: "planned", working: "inProgress", completed: "completed" } as const;
export function columnDisplayName(column: TopicsBoardPreferences["columns"][number]) {
  return column.builtInName && Object.hasOwn(defaultLabelKeys, column.id)
    ? tr(`topics.${defaultLabelKeys[column.id as keyof typeof defaultLabelKeys]}` as const) : column.name;
}
// Original v1 profiles stored the Russian default literally. Only recognize a
// known ID and its exact legacy label; never match a custom column by its name.
export function migrateColumn(column: TopicsBoardPreferences["columns"][number]) {
  const key = Object.hasOwn(defaultLabelKeys, column.id) && defaultLabelKeys[column.id as keyof typeof defaultLabelKeys];
  return key && column.builtInName === undefined && column.name === legacyRussianLabels[key]
    ? { ...column, builtInName: true } : column;
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
    columns: Object.entries(defaultLabelKeys).map(([id, key]) => ({
      id, name: tr(`topics.${key}` as const), builtInName: true,
    })),
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
  // A missing status is the built-in empty state, not an unknown status.
  const rowStatuses = (row: TopicBoardRecord) =>
    row.statuses.length ? row.statuses : ["empty"];
  const statuses = [
    ...new Set([
      ...Object.keys(initialStatusCategory),
      ...Object.keys(prefs.statusCategory),
      ...all.flatMap(rowStatuses),
    ]),
  ];
  const build = (id: string | null, name: string): TopicsBoardColumn => ({
    id: id ?? "unassigned",
    name,
    rows: unique(
      visible.filter((r) =>
        rowStatuses(r).some((s) => statusCategory(prefs, s) === id),
      ),
    ),
    statuses: statuses
      .filter((s) => statusCategory(prefs, s) === id)
      .map((s) => ({
        name: s,
        count: unique(all.filter((r) => rowStatuses(r).includes(s))).length,
      })),
  });
  return {
    columns: prefs.columns.map((c) => build(c.id, columnDisplayName(c))),
    unassigned: build(null, tr("topics.unassigned")),
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
    throw Error(tr("topics.invalidStatusOrColumn"));
  if (
    !Object.hasOwn(prefs.statusCategory, status) &&
    Object.keys(prefs.statusCategory).length >= 1000
  )
    throw Error(tr("topics.tooManyConfiguredStatuses"));
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
    throw Error(tr("topics.columnNamesMustBeBetween1And64"));
  if (
    prefs.columns.some(
      (c) =>
        c.id !== exclude &&
        columnDisplayName(c).toLocaleLowerCase() === clean.toLocaleLowerCase(),
    )
  )
    throw Error(tr("topics.aColumnWithThisNameAlreadyExists"));
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
    throw Error(tr("topics.couldNotAddColumn"));
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
    throw Error(tr("topics.columnNotFound"));
  const clean = columnName(prefs, name, id);
  return {
    ...prefs,
    columns: prefs.columns.map((c) =>
      c.id === id ? { ...c, name: clean, ...(Object.hasOwn(defaultLabelKeys, id) && { builtInName: false }) } : c,
    ),
  };
}
export function removeBoardColumn(prefs: TopicsBoardPreferences, id: string) {
  if (!prefs.columns.some((c) => c.id === id))
    throw Error(tr("topics.columnNotFound"));
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
    throw Error(tr("topics.invalidColumnOrder"));
  const columns = [...prefs.columns],
    [column] = columns.splice(from, 1);
  columns.splice(index, 0, column!);
  return { ...prefs, columns };
}
