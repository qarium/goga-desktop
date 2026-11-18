// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TopicsRemovalDialog } from "../src/renderer/TopicsRemovalDialog";
import { topicsBoardV4 } from "./fixtures/topics-board-v4";
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.goga = {
    readTopicBoard: vi.fn(async () => topicsBoardV4()),
    prepareTopicRemoval: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      action: "clear",
      token: "t",
      details: ["Проверенная команда clear"],
      expiresAt: Date.now() + 120000,
    })),
    executeTopicRemoval: vi.fn(),
  } as any;
});
afterEach(cleanup);
it("shows year/base and explains filter scope without claiming a candidate preview", async () => {
  render(
    <TopicsRemovalDialog
      project={{ id: "p", name: "Project", path: "/fixture" }}
      year="2026"
      action="clear"
      topics={[]}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  expect(
    await screen.findByRole("combobox", { name: "Базовая ветка" }),
  ).toBeTruthy();
  expect(screen.getByText(/Поиск, фильтры.*не ограничивают/)).toBeTruthy();
  expect(screen.queryByText(/Найти топики для очистки/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Проверить и продолжить" }),
  );
  await screen.findByText("Проверенная команда clear");
  expect(window.goga.prepareTopicRemoval).toHaveBeenCalledWith({
    projectId: "p",
    year: "2026",
    action: "clear",
    baseRef: "main",
    expectedRevision: "a".repeat(64),
  });
  const submit = screen.getByRole("button", {
    name: "Очистить топики",
  }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Подтверждаю удаление/ }),
  );
  expect(submit.disabled).toBe(false);
  expect(window.goga.readTopicBoard).toHaveBeenCalledTimes(1);
  expect(window.goga.executeTopicRemoval).not.toHaveBeenCalled();
});

it("retries a failed branch list load instead of preparing clear with an empty base", async () => {
  vi.mocked(window.goga.readTopicBoard).mockRejectedValueOnce(
    Error("Список не прочитан"),
  );
  render(
    <TopicsRemovalDialog
      project={{ id: "p", name: "Project", path: "/fixture" }}
      year="2026"
      action="clear"
      topics={[]}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: /Повторить/ }));
  expect(
    await screen.findByRole("combobox", { name: "Базовая ветка" }),
  ).toBeTruthy();
  expect(window.goga.prepareTopicRemoval).not.toHaveBeenCalled();
});
