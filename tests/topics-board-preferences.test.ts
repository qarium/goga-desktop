import { expect, it } from "vitest";
import { defaultBoardPreferences } from "../src/renderer/topics-board-model";
import {
  boardPreferencesKey,
  readBoardPreferences,
  writeBoardPreferences,
} from "../src/renderer/topics-board-preferences";
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
};
it("uses project-scoped versioned keys and fresh defaults", () => {
  const s = storage();
  expect(boardPreferencesKey("p")).toBe("goga.desktop.topicsBoard.v1.p");
  expect(readBoardPreferences(s, "p")).toEqual({
    value: defaultBoardPreferences(),
  });
  const p = defaultBoardPreferences();
  p.view = "table";
  expect(writeBoardPreferences(s, "p", p)).toEqual({});
  expect(readBoardPreferences(s, "p").value.view).toBe("table");
  expect(readBoardPreferences(s, "q").value.view).toBe("board");
});
it("retains explicit null assignments across reloads", () => {
  const s = storage(),
    p = defaultBoardPreferences();
  p.statusCategory.todo = null;
  writeBoardPreferences(s, "p", p);
  expect(readBoardPreferences(s, "p").value.statusCategory.todo).toBeNull();
});
it.each([
  "bad json",
  JSON.stringify({ ...defaultBoardPreferences(), schemaVersion: 2 }),
  JSON.stringify({ ...defaultBoardPreferences(), extra: true }),
  JSON.stringify({
    ...defaultBoardPreferences(),
    columns: [
      { id: "a", name: "x" },
      { id: "a", name: "y" },
    ],
  }),
  JSON.stringify({
    ...defaultBoardPreferences(),
    columns: [
      { id: "a", name: "x" },
      { id: "b", name: "X" },
    ],
  }),
  JSON.stringify({
    ...defaultBoardPreferences(),
    statusCategory: { todo: "missing" },
  }),
  JSON.stringify({
    ...defaultBoardPreferences(),
    columns: [{ id: "a", name: "" }],
  }),
])("rejects corrupt preferences without overwriting them: %s", (raw) => {
  const s = storage();
  s.setItem(boardPreferencesKey("p"), raw);
  const r = readBoardPreferences(s, "p");
  expect(r.error).toMatch(/настройки доски/i);
  expect(r.value).toEqual(defaultBoardPreferences());
  expect(s.getItem(boardPreferencesKey("p"))).toBe(raw);
});
it("reports storage failures and does not throw", () => {
  const s = {
    getItem() {
      throw Error("private");
    },
    setItem() {
      throw Error("quota");
    },
  };
  expect(readBoardPreferences(s, "p").error).toMatch(/настройки доски/i);
  expect(
    writeBoardPreferences(s, "p", defaultBoardPreferences()).error,
  ).toMatch(/не сохранены/i);
});
it("preserves literal special status names instead of treating them as object prototypes", () => {
  const s = storage(),
    p = defaultBoardPreferences();
  p.statusCategory = JSON.parse(
    '{"__proto__":"working","constructor":"completed"}',
  );
  writeBoardPreferences(s, "p", p);
  const loaded = readBoardPreferences(s, "p").value;
  expect(Object.hasOwn(loaded.statusCategory, "__proto__")).toBe(true);
  expect(loaded.statusCategory["__proto__"]).toBe("working");
  expect(loaded.statusCategory.constructor).toBe("completed");
});
