// @vitest-environment jsdom
import React, { useState } from "react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { TopicsBoard } from "../src/renderer/TopicsBoard";
import {
  defaultBoardPreferences,
  type TopicsBoardPreferences,
} from "../src/renderer/topics-board-model";
import { topicsBoardV4 } from "./fixtures/topics-board-v4";
afterEach(cleanup);
function Fixture() {
  const [preferences, setPreferences] = useState<TopicsBoardPreferences>(
    defaultBoardPreferences(),
  );
  const [selected, setSelected] = useState(new Set<string>());
  return (
    <TopicsBoard
      projectId="p"
      year="2026"
      rows={topicsBoardV4().entries}
      allRows={topicsBoardV4().entries}
      preferences={preferences}
      onPreferences={setPreferences}
      selected={selected}
      onSelection={setSelected}
      onOpen={vi.fn()}
    />
  );
}
it("shows real slugs/branches, leaves unassigned topics collapsed and chips visible", () => {
  render(<Fixture />);
  const u = screen.getByRole("region", { name: "Без категории" });
  expect(
    within(u).getByRole("button", {
      name: /Перетащить статус security-review/,
    }),
  ).toBeTruthy();
  expect(
    within(u).queryByRole("button", { name: "Открыть топик cli-update" }),
  ).toBeNull();
  fireEvent.click(within(u).getByRole("button", { name: /Показать топики/ }));
  expect(
    within(u).getByRole("button", { name: "Открыть топик cli-update" }),
  ).toBeTruthy();
  expect(screen.queryByText(/Также в категориях/)).toBeNull();
});
it("adds, renames and deletes columns inline and supports one-step undo", () => {
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Добавить колонку" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Название новой колонки" }),
    { target: { value: "Проверка" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Создать колонку" }));
  expect(screen.getByRole("region", { name: "Проверка" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Переименовать колонку Проверка" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Название колонки" }), {
    target: { value: "Аудит" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить название" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Удалить колонку Аудит" }),
  );
  expect(screen.queryByRole("region", { name: "Аудит" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Отменить изменение доски" }),
  );
  expect(screen.getByRole("region", { name: "Аудит" })).toBeTruthy();
});
it("status click does not reassign; keyboard moving and column order work", () => {
  render(<Fixture />);
  const chip = screen.getByRole("button", { name: /Перетащить статус todo/ });
  fireEvent.click(chip);
  expect(
    within(screen.getByRole("region", { name: "Запланировано" })).getByRole(
      "button",
      { name: /Перетащить статус todo/ },
    ),
  ).toBeTruthy();
  fireEvent.keyDown(chip, { key: "ArrowRight", altKey: true });
  expect(
    within(screen.getByRole("region", { name: "В работе" })).getByRole(
      "button",
      { name: /Перетащить статус todo/ },
    ),
  ).toBeTruthy();
  fireEvent.keyDown(
    screen.getByRole("button", { name: "Переместить колонку Запланировано" }),
    { key: "ArrowRight", altKey: true },
  );
  expect(
    screen.getAllByRole("region").map((r) => r.getAttribute("aria-label")),
  ).toEqual(["Без категории", "В работе", "Запланировано", "Завершено"]);
});

it("hides the unassigned region when all statuses have a category and restores it for unknown statuses even under filters", () => {
  const known = topicsBoardV4().entries.filter((row) =>
    row.statuses.every(
      (status) => status in defaultBoardPreferences().statusCategory,
    ),
  );
  const props = {
    projectId: "p",
    year: "2026",
    rows: known,
    allRows: known,
    preferences: defaultBoardPreferences(),
    onPreferences: vi.fn(),
    selected: new Set<string>(),
    onSelection: vi.fn(),
    onOpen: vi.fn(),
  };
  const view = render(<TopicsBoard {...props} />);
  expect(screen.queryByRole("region", { name: "Без категории" })).toBeNull();
  view.rerender(
    <TopicsBoard {...props} rows={[]} allRows={topicsBoardV4().entries} />,
  );
  expect(screen.getByRole("region", { name: "Без категории" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Перетащить статус security-review/ }),
  ).toBeTruthy();
  view.rerender(<TopicsBoard {...props} />);
  expect(screen.queryByRole("region", { name: "Без категории" })).toBeNull();
});

it("reveals an empty unassigned area after keyboard unassign and hides it after the last status is assigned", () => {
  const rows = topicsBoardV4().entries.filter((row) =>
    row.statuses.every(
      (status) => status in defaultBoardPreferences().statusCategory,
    ),
  );
  function Known() {
    const [preferences, onPreferences] = useState(defaultBoardPreferences());
    return (
      <TopicsBoard
        projectId="p"
        year="2026"
        rows={rows}
        allRows={rows}
        preferences={preferences}
        onPreferences={onPreferences}
        selected={new Set()}
        onSelection={vi.fn()}
        onOpen={vi.fn()}
      />
    );
  }
  render(<Known />);
  expect(screen.queryByRole("region", { name: "Без категории" })).toBeNull();
  fireEvent.keyDown(
    screen.getByRole("button", { name: /Перетащить статус empty/ }),
    { key: "ArrowLeft", altKey: true },
  );
  const unassigned = screen.getByRole("region", { name: "Без категории" });
  fireEvent.keyDown(
    within(unassigned).getByRole("button", { name: /Перетащить статус empty/ }),
    { key: "ArrowRight", altKey: true },
  );
  expect(screen.queryByRole("region", { name: "Без категории" })).toBeNull();
});

it("uses the same app-styled native checkboxes for cards, columns and disabled empty columns", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/renderer/TopicsBoard.css", "utf8");
  document.head.append(style);
  try {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Добавить колонку" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Название новой колонки" }),
      {
        target: { value: "Пустая" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Создать колонку" }));
    const card = document.querySelector<HTMLInputElement>(
      ".topic-board-card input[type=checkbox]",
    )!;
    const column = screen.getByRole("checkbox", {
      name: "Выбрать топики колонки В работе",
    });
    const empty = screen.getByRole("checkbox", {
      name: "Выбрать топики колонки Пустая",
    }) as HTMLInputElement;
    expect(empty.disabled).toBe(true);
    for (const input of [card, column, empty]) {
      expect(input.tagName).toBe("INPUT");
      expect(input.getAttribute("type")).toBe("checkbox");
      const css = getComputedStyle(input);
      expect(css.appearance).toBe("none");
      expect(css.width).toBe("15px");
      expect(css.height).toBe("15px");
      expect(css.borderRadius).toBe("3px");
    }
    fireEvent.click(column);
    expect((column as HTMLInputElement).checked).toBe(true);
  } finally {
    style.remove();
  }
});
