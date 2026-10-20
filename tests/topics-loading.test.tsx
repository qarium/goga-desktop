// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { TopicCard, type TopicCardContext } from "../src/renderer/TopicCard";
import { TopicsWorkspace } from "../src/renderer/TopicsWorkspace";
import { createTopicsStore, topicDraftKey } from "../src/renderer/topics-model";
import type { TopicBoardSnapshot, TopicDetails } from "../src/shared/topics";
const project = { id: "p", name: "Fixture", path: "/fixture" };
const target = { topic: "feature-a", branch: "feature/a", remote: false };
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "r1",
  currentBranch: target.branch,
  currentTopic: target,
  baseRef: "main",
  branches: ["main", target.branch],
  dirty: false,
  active: false,
  entries: [],
  records: [],
  remoteEntries: [],
  remoteRecords: [],
};
const details: TopicDetails = {
  projectId: "p",
  year: "2026",
  target,
  text: "Saved task",
  exists: true,
  version: "v1",
  editable: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let boardRead: ReturnType<typeof deferred<TopicBoardSnapshot>>;
let taskRead: ReturnType<typeof deferred<TopicDetails>>;
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  boardRead = deferred();
  taskRead = deferred();
  api = {
    readTopicBoard: vi.fn(() => boardRead.promise),
    readTopicDetails: vi.fn(() => taskRead.promise),
    prepareTopicOperation: vi.fn(),
    executeTopicOperation: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
function mount(
  context: TopicCardContext = { kind: "current" },
  store = createTopicsStore(),
) {
  const onClose = vi.fn();
  return {
    ...render(
      <TopicCard
        project={project}
        year="2026"
        target={target}
        board={board}
        store={store}
        context={context}
        onClose={onClose}
        onChanged={vi.fn()}
        onPrepare={vi.fn()}
      />,
    ),
    onClose,
    store,
  };
}
it.each(["board", "task"])(
  "keeps task loading and inactive transfer until both reads finish (%s first)",
  async (first) => {
    mount();
    expect(
      screen
        .getByText("Загружаем топик…")
        .closest("[role=status]")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(
      screen
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") || b.textContent),
    ).toEqual(["Закрыть карточку", "Синхронизировать", "Применить в базу…"]);
    for (const name of ["Синхронизировать", "Применить в базу…"]) {
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
    }
    expect(screen.queryByRole("heading", { name: "Задача" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Базовая ветка" })).toBeNull();
    await act(async () => {
      if (first === "board") boardRead.resolve(board);
      else taskRead.resolve(details);
    });
    expect(
      screen
        .getByText("Загружаем топик…")
        .closest("[role=status]")
        ?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(screen.queryByRole("textbox", { name: "Задача топика" })).toBeNull();
    await act(async () => {
      if (first === "board") taskRead.resolve(details);
      else boardRead.resolve(board);
    });
    expect(screen.queryByText("Загружаем топик…")).toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Задача топика",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Saved task");
    expect(screen.getByLabelText("Базовая ветка")).toBeTruthy();
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  },
);
it("shows an error instead of partial content; retry keeps the existing unsaved draft", async () => {
  const store = createTopicsStore(),
    key = topicDraftKey(project.id, "2026", target);
  store.tasks.set(key, {
    text: "Keep unsaved work",
    original: "Saved task",
    version: "v1",
  });
  mount({ kind: "topic" }, store);
  await act(async () => {
    taskRead.reject(new Error("Test read failed"));
    boardRead.resolve(board);
  });
  expect(screen.getByRole("alert").textContent).toContain("Test read failed");
  expect(screen.queryByText("Загружаем топик…")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Задача топика" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Опубликовать…" })).toBeNull();
  expect(store.tasks.get(key)?.text).toBe("Keep unsaved work");
  const next = deferred<TopicDetails>();
  api.readTopicDetails.mockImplementationOnce(() => next.promise);
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  expect(
    screen
      .getByText("Загружаем топик…")
      .closest("[role=status]")
      ?.getAttribute("aria-busy"),
  ).toBe("true");
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () =>
    next.resolve({ ...details, text: "Externally changed", version: "v2" }),
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Задача топика",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Keep unsaved work");
  expect(screen.getByText(/Сохранённая задача изменилась/)).toBeTruthy();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
});
it("can close during loading and ignores results after unmount", async () => {
  const card = mount();
  const close = screen.getByRole("button", {
    name: "Закрыть карточку",
  }) as HTMLButtonElement;
  expect(close.disabled).toBe(false);
  fireEvent.click(close);
  expect(card.onClose).toHaveBeenCalledOnce();
  card.unmount();
  await act(async () => {
    boardRead.resolve(board);
    taskRead.resolve(details);
  });
  expect(card.store.tasks.size).toBe(0);
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});
it("does not load historical snapshots or new-topic preparation", () => {
  const first = mount({
    kind: "run",
    run: {
      taskSnapshot: {
        text: "Historical snapshot",
        year: "2026",
        topic: target.topic,
        branch: target.branch,
      },
    } as any,
  });
  expect(screen.getByText("Historical snapshot")).toBeTruthy();
  expect(screen.queryByText("Загружаем топик…")).toBeNull();
  expect(
    screen.queryByRole("region", { name: "Перенос изменений" }),
  ).toBeNull();
  first.unmount();
  mount({ kind: "preparation", newTopic: true, text: "New preparation" });
  expect(screen.getByText("New preparation")).toBeTruthy();
  expect(screen.queryByText("Загружаем топик…")).toBeNull();
  expect(api.readTopicBoard).not.toHaveBeenCalled();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
});
it("refresh has its own framed-button style and preserves its accessible label", async () => {
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onOpenTopic={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await act(async () => boardRead.resolve(board));
  const refresh = screen.getByRole("button", { name: "Обновить список" });
  expect(refresh.classList.contains("topic-refresh-button")).toBe(true);
  expect(refresh.classList.contains("icon-button")).toBe(false);
  expect(refresh.getAttribute("title")).toBe("Обновить список");
  fireEvent.click(refresh);
  expect(api.readTopicBoard).toHaveBeenCalledTimes(2);
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});
