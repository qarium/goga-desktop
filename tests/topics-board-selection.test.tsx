// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { TopicsWorkspace } from "../src/renderer/TopicsWorkspace";
import { createTopicsStore } from "../src/renderer/topics-model";
import { topicsBoardV4 } from "./fixtures/topics-board-v4";
const project = { id: "p", name: "Project", path: "/fixture" };
beforeEach(() => {
  window.goga = {
    readTopicTable: vi.fn(async (_p, year) => topicsBoardV4(year)),
  } as any;
});
afterEach(cleanup);
const setup = () =>
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onOpenTopic={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
it("starts on board; column selection and table selection are shared", async () => {
  setup();
  const col = await screen.findByRole("region", { name: "В работе" });
  fireEvent.click(
    within(col).getByRole("checkbox", {
      name: "Выбрать топики колонки В работе",
    }),
  );
  expect(screen.getByText(/Выбрано: 5/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Таблица" }));
  const box = screen.getByRole("checkbox", {
    name: "Выбрать топик contract-editor",
  });
  expect((box as HTMLInputElement).checked).toBe(true);
  fireEvent.click(box);
  fireEvent.click(screen.getByRole("button", { name: "Доска" }));
  expect(
    (
      within(await screen.findByRole("region", { name: "В работе" })).getByRole(
        "checkbox",
        { name: "Выбрать топики колонки В работе" },
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
});
it("reports hidden selection and keeps it across reset, but resets on year change", async () => {
  setup();
  const col = await screen.findByRole("region", { name: "Запланировано" });
  fireEvent.click(
    within(col).getByRole("checkbox", {
      name: "Выбрать топики колонки Запланировано",
    }),
  );
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "not-found" },
  });
  expect(screen.getByText(/Скрыто фильтрами: 4/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
  expect(screen.getByText(/Выбрано: 4/)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Год" }), {
    target: { value: "2025" },
  });
  await waitFor(() =>
    expect(window.goga.readTopicTable).toHaveBeenCalledWith("p", "2025"),
  );
  expect(screen.queryByText(/Выбрано:/)).toBeNull();
});
it("retains unassigned choices and view after remount and handles storage events", async () => {
  const view = setup();
  await screen.findByRole("region", { name: "Запланировано" });
  fireEvent.click(screen.getByRole("button", { name: "Таблица" }));
  view.unmount();
  setup();
  expect(await screen.findByRole("table")).toBeTruthy();
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: "goga.desktop.topicsBoard.v1.p",
      storageArea: window.localStorage,
      newValue: null,
    }),
  );
  expect(
    await screen.findByRole("region", { name: "Запланировано" }),
  ).toBeTruthy();
});
it("offers selected deletion and clear in the real filter bar without using filters as clear scope", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  (window.goga as any).readTopicBoard = vi.fn(async () => topicsBoardV4());
  (window.goga as any).prepareTopicRemoval = vi.fn(async (r: any) => ({
    token: "t",
    projectId: "p",
    year: "2026",
    action: r.action,
    details: ["Check"],
    expiresAt: Date.now() + 120000,
  }));
  setup();
  fireEvent.click(
    within(
      await screen.findByRole("region", { name: "Запланировано" }),
    ).getByRole("checkbox", { name: "Выбрать топики колонки Запланировано" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Удалить выбранные топики" }),
  );
  await screen.findByText("Check");
  expect(window.goga.prepareTopicRemoval).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "delete",
      topics: [
        "history-search",
        "report-export",
        "dependency-audit",
        "log-structure",
      ],
    }),
  );
});
