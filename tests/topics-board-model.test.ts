import { expect, it } from "vitest";
import {
  defaultBoardPreferences,
  projectTopicsBoard,
  assignStatus,
  addBoardColumn,
  renameBoardColumn,
  removeBoardColumn,
  reorderBoardColumn,
  columnChecked,
  toggleColumn,
  topicSelectionKey,
} from "../src/renderer/topics-board-model";
const row = (topic: string, statuses: string[]) => ({
  topic,
  branch: topic,
  statuses,
  current: false,
  remote: false,
  todo: null,
  divergence: null,
});
it("starts with three categories and all built-in statuses", () => {
  const prefs = defaultBoardPreferences();
  expect(prefs.view).toBe("board");
  expect(prefs.columns.map((c) => c.name)).toEqual([
    "Запланировано",
    "В работе",
    "Завершено",
  ]);
  const projected = projectTopicsBoard([], [], prefs);
  expect(projected.columns.map((c) => c.statuses.map((s) => s.name))).toEqual([
    ["empty", "todo", "backlog"],
    ["defined", "discovered", "prototyped", "designed", "planned"],
    ["done"],
  ]);
});
it("deduplicates a topic within each column but shares it across matching columns", () => {
  const rows = [
    row("a", ["todo", "planned", "todo"]),
    row("a", ["todo"]),
    row("b", ["done"]),
  ];
  const b = projectTopicsBoard(rows, rows, defaultBoardPreferences());
  expect(b.columns.map((c) => c.rows.map((r) => r.topic))).toEqual([
    ["a"],
    ["a"],
    ["b"],
  ]);
  expect(b.columns[0].statuses.find((s) => s.name === "todo")?.count).toBe(1);
});
it("keeps unknown chips visible under filters and no-status topics unassigned", () => {
  const all = [row("a", ["review"]), row("b", [])];
  const b = projectTopicsBoard([], all, defaultBoardPreferences());
  expect(b.unassigned.statuses).toEqual([{ name: "review", count: 1 }]);
  expect(b.unassigned.rows).toEqual([]);
  expect(
    projectTopicsBoard(all, all, defaultBoardPreferences()).unassigned.rows.map(
      (r) => r.topic,
    ),
  ).toEqual(["a", "b"]);
});
it("moves statuses without changing source rows, including prototype-like object keys", () => {
  const p = defaultBoardPreferences(),
    rows = [row("a", ["__proto__"])];
  const moved = assignStatus(p, "__proto__", "working");
  expect(projectTopicsBoard(rows, rows, moved).columns[1].rows).toHaveLength(1);
  expect(p.statusCategory).not.toHaveProperty("__proto__");
  expect(rows[0].statuses).toEqual(["__proto__"]);
  expect(() => assignStatus(p, "todo", "missing")).toThrow();
});
it("deleting a column explicitly unassigns defaults instead of restoring them", () => {
  const p = removeBoardColumn(defaultBoardPreferences(), "planned");
  expect(p.statusCategory.todo).toBeNull();
  expect(
    projectTopicsBoard([], [], p).unassigned.statuses.map((s) => s.name),
  ).toContain("todo");
  expect(p.columns).toHaveLength(2);
});
it("adds, renames and reorders columns immutably and rejects invalid names", () => {
  const p = defaultBoardPreferences();
  const a = addBoardColumn(p, "  Проверка  ", "review");
  expect(a.columns[3]).toEqual({ id: "review", name: "Проверка" });
  const b = renameBoardColumn(a, "review", "Аудит");
  const c = reorderBoardColumn(b, "review", 0);
  expect(c.columns.map((x) => x.id)).toEqual([
    "review",
    "planned",
    "working",
    "completed",
  ]);
  expect(p.columns).toHaveLength(3);
  expect(() => addBoardColumn(p, "В РАБОТЕ", "x")).toThrow();
  expect(() => addBoardColumn(p, " ", "x")).toThrow();
  expect(() => renameBoardColumn(p, "missing", "x")).toThrow();
  expect(() => reorderBoardColumn(p, "planned", -1)).toThrow();
});
it("selects just a column's filtered topics and never clears hidden selections", () => {
  const a = topicSelectionKey("p", "2026", "a"),
    b = topicSelectionKey("p", "2026", "b");
  expect(a).not.toBe(topicSelectionKey("p", "2025", "a"));
  expect(columnChecked([], new Set())).toBe(false);
  expect(columnChecked([a, b], new Set([a]))).toBe(false);
  const s = toggleColumn([a, b], new Set([a, "hidden"]));
  expect(columnChecked([a, b], s)).toBe(true);
  expect([...toggleColumn([a, b], s)]).toEqual(["hidden"]);
  expect([...s]).toContain("hidden");
});
