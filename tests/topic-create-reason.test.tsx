// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TopicsWorkspace } from "../src/renderer/TopicsWorkspace";
import { createTopicsStore } from "../src/renderer/topics-model";
import type { TopicBoardSnapshot } from "../src/shared/topics";
const project = { id: "p", name: "Project", path: "/fixture" };
const row = (topic: string, branch: string, statuses: string[]) => ({
  topic,
  branch,
  statuses,
  current: branch === "feature/a",
  remote: false,
  todo: branch,
  divergence: null,
});
const a = row("feature-a", "feature/a", ["planned"]),
  h = row("feature-a", "main", ["done"]),
  b = row("feature-b", "feature/b", ["tool.ready"]);
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "rev",
  currentBranch: "feature/a",
  currentTopic: a,
  baseRef: "main",
  branches: ["main", "feature/a"],
  dirty: false,
  active: false,
  entries: [
    { ...a, hosts: ["feature/a", "main"] },
    { ...b, hosts: ["feature/b"] },
  ],
  records: [a, h, b],
  remoteEntries: [],
  remoteRecords: [],
};
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readTopicBoard: vi.fn(async () => board),
    readTopicDetails: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      target: a,
      text: "Original task",
      exists: true,
      version: "task-v",
      editable: true,
    })),
    prepareTopicOperation: vi.fn(async (req) => ({
      token: "token",
      projectId: "p",
      year: "2026",
      action: req.action,
      title: "Подтвердите действие",
      details: ["origin/feature/new"],
      expiresAt: Date.now() + 60000,
    })),
    executeTopicOperation: vi.fn(async () => ({
      projectId: "p",
      status: "success",
      message: "Готово",
    })),
  };
  api.readTopicTable = api.readTopicBoard;
  api.readTopicOverview = api.readTopicDetails;
  window.goga = api;
});
afterEach(cleanup);
const mount = () =>
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onOpenTopic={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
const button = () =>
  screen.getByRole("button", { name: "Создать топик" }) as HTMLButtonElement;
const reason = () => {
  const id = button().getAttribute("aria-describedby");
  return id ? document.getElementById(id) : null;
};
const settled = () =>
  waitFor(() =>
    expect(
      document.querySelector(".topics-workspace")?.getAttribute("aria-busy"),
    ).toBe("false"),
  );
const deferred = () => {
  let resolve!: (v: any) => void, reject!: (e: Error) => void;
  const promise = new Promise<any>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { resolve, reject, promise };
};
const assertReason = (parts: string[], stale = false) => {
  expect(button().disabled).toBe(true);
  const el = reason();
  expect(el).not.toBeNull();
  const visible = parts.map((part) => part[0].toUpperCase() + part.slice(1));
  expect(el!.textContent).toBe(
    visible.join("; ") +
      (stale
        ? ". По последней успешной загрузке; обновить список топиков не удалось."
        : ""),
  );
  const compact = document.querySelector(".topic-create-reason");
  expect(compact).not.toBeNull();
  expect(compact!.classList.contains("action-reason")).toBe(true);
  expect(compact!.querySelector(":scope > .action-reason-text")).not.toBeNull();
  expect(compact!.classList.contains("topic-action-reason")).toBe(false);
  expect(
    compact!.querySelector('svg[aria-hidden="true"][focusable="false"]'),
  ).not.toBeNull();
  expect(compact!.getAttribute("role")).not.toBe("alert");
  for (const text of visible) {
    const content = screen.getByText(text, { exact: true });
    expect(compact!.contains(content)).toBe(true);
    expect(content.closest("details, [hidden], .sr-only")).toBeNull();
    expect(content.hasAttribute("title")).toBe(false);
  }
  expect(compact).toBe(el);
  expect(compact!.querySelector("details")).toBeNull();
  expect(screen.queryByText("Подробнее", { exact: true })).toBeNull();
  expect(
    compact!.textContent?.match(/незакоммиченные изменения/giu)?.length ?? 0,
  ).toBe(0);
  expect(compact!.parentElement).toBe(button().parentElement?.parentElement);
  expect(compact!.nextElementSibling).toBe(button().parentElement);
  expect(
    compact!.compareDocumentPosition(button()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(el!.textContent).not.toMatch(/переключ/iu);
};
const noReason = () => {
  expect(button().hasAttribute("aria-describedby")).toBe(false);
  expect(document.querySelector(".topic-create-reason")).toBeNull();
};
const ui = (store = createTopicsStore(), p = project, revision = "1") => (
  <TopicsWorkspace
    project={p}
    store={store}
    revision={revision}
    onOpenTopic={vi.fn()}
    onChanged={vi.fn()}
  />
);
it("places the complete reason before the refresh/create group in DOM order", async () => {
  api.readTopicBoard.mockResolvedValue({ ...board, active: true });
  mount();
  await settled();
  const badge = document.querySelector(".topic-create-reason")!;
  expect(badge.nextElementSibling).toBe(
    document.querySelector(".topic-create-action"),
  );
});
it("removes the redundant Подробнее disclosure from the create reason only", async () => {
  api.readTopicBoard.mockResolvedValue({ ...board, active: true });
  mount();
  await settled();
  expect(screen.queryByText("Подробнее", { exact: true })).toBeNull();
  expect(document.querySelector(".topic-create-reason details")).toBeNull();
});
it.each([false, true])(
  "explains active projects even when dirty=%s",
  async (dirty) => {
    api.readTopicBoard.mockResolvedValue({ ...board, dirty, active: true });
    mount();
    await settled();
    assertReason(["в проекте работает запуск"]);
    fireEvent.click(button());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "available board (empty=%s) has no reason or extra prohibition",
  async (empty) => {
    api.readTopicBoard.mockResolvedValue(
      empty
        ? { ...board, entries: [], records: [], currentTopic: null }
        : board,
    );
    mount();
    await settled();
    noReason();
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(screen.getByRole("dialog", { name: "Создать топик" })).toBeTruthy();
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  },
);
it("initial reading shows one loader without any active or missing-board warning", async () => {
  const d = deferred();
  api.readTopicBoard.mockReturnValueOnce(d.promise);
  mount();
  noReason();
  expect(button().disabled).toBe(true);
  expect(document.querySelectorAll(".loading-state")).toHaveLength(1);
  await act(async () => d.resolve({ ...board, active: true }));
  await settled();
  assertReason(["в проекте работает запуск"]);
});
it.each([true, false])(
  "refresh hides stale reason (old active=%s) until the current result",
  async (active) => {
    api.readTopicBoard.mockResolvedValueOnce({ ...board, active });
    mount();
    await settled();
    const oldId = button().getAttribute("aria-describedby");
    const d = deferred();
    api.readTopicBoard.mockReturnValueOnce(d.promise);
    fireEvent.click(screen.getByRole("button", { name: "Обновить список" }));
    noReason();
    if (oldId) expect(document.getElementById(oldId)).toBeNull();
    expect(button().disabled).toBe(true);
    expect(
      screen.getByRole("status").querySelector(".loading-spinner"),
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("table", { hidden: true })).toBeTruthy();
    await act(async () => d.resolve({ ...board, active: !active }));
    await settled();
    if (active) {
      noReason();
      expect(button().disabled).toBe(false);
    } else assertReason(["в проекте работает запуск"]);
  },
);
it("project change immediately clears old reason and only describes the new board", async () => {
  const store = createTopicsStore();
  api.readTopicBoard.mockResolvedValueOnce({ ...board, active: true });
  const view = render(ui(store));
  await settled();
  assertReason(["в проекте работает запуск"]);
  const d = deferred();
  api.readTopicBoard.mockReturnValueOnce(d.promise);
  view.rerender(ui(store, { ...project, id: "b", name: "Beta" }));
  noReason();
  expect(button().disabled).toBe(true);
  expect(document.querySelectorAll(".loading-state")).toHaveLength(1);
  await act(async () =>
    d.resolve({ ...board, projectId: "b", active: true, dirty: false }),
  );
  await settled();
  assertReason(["в проекте работает запуск"]);
});
it("late prior-project snapshot cannot add a stale dirty reason", async () => {
  const old = deferred(),
    fresh = deferred(),
    store = createTopicsStore();
  api.readTopicBoard
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const view = render(ui(store));
  view.rerender(ui(store, { ...project, id: "b", name: "Beta" }));
  await act(async () => fresh.resolve({ ...board, projectId: "b" }));
  await settled();
  noReason();
  await act(async () => old.resolve({ ...board, dirty: true }));
  noReason();
  expect(button().disabled).toBe(false);
});
it("missing board explains failed reading, not dirty, and clears on retry", async () => {
  api.readTopicBoard.mockRejectedValueOnce(Error("board unavailable"));
  mount();
  await settled();
  assertReason(["не удалось загрузить список топиков"]);
  const d = deferred();
  api.readTopicBoard.mockReturnValueOnce(d.promise);
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  noReason();
  expect(document.querySelectorAll(".loading-state")).toHaveLength(1);
  await act(async () => d.resolve(board));
  await settled();
  noReason();
  expect(button().disabled).toBe(false);
});
it("invalid year explains that existing condition without inventing dirty", async () => {
  mount();
  await settled();
  fireEvent.change(screen.getByLabelText("Год"), { target: { value: "20" } });
  await settled();
  assertReason(["укажите год из четырёх цифр"]);
  const d = deferred();
  api.readTopicBoard.mockReturnValueOnce(d.promise);
  fireEvent.change(screen.getByLabelText("Год"), { target: { value: "2025" } });
  noReason();
  await act(async () => d.resolve({ ...board, year: "2025" }));
  await settled();
  noReason();
  expect(button().disabled).toBe(false);
});
it("failed refresh blocks creation until a successful fresh catalog", async () => {
  mount();
  await settled();
  api.readTopicBoard.mockRejectedValueOnce(Error("refresh unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Обновить список" }));
  await settled();
  expect(screen.getByRole("alert").textContent).toContain(
    "refresh unavailable",
  );
  assertReason(["не удалось загрузить список топиков"]);
});
it.each([false, true])(
  "busy operation is explained with existing dirty=%s and removed on settlement",
  async (dirty) => {
    api.readTopicBoard.mockResolvedValue({ ...board, dirty });
    mount();
    await settled();
    const d = deferred();
    api.prepareTopicOperation.mockReturnValueOnce(d.promise);
    fireEvent.click(
      screen.getByRole("button", { name: "Удалить топик feature-b" }),
    );
    await waitFor(() => expect(api.prepareTopicOperation).toHaveBeenCalled());
    assertReason(["выполняется операция с топиками"]);
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
    await act(async () => d.reject(Error("controlled failure")));
    noReason();
    expect(button().disabled).toBe(false);
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
  },
);

it("keeps the active reason visible without adding a dirty-create prohibition", async () => {
  api.readTopicBoard.mockResolvedValue({ ...board, dirty: true, active: true });
  mount();
  await settled();
  assertReason(["в проекте работает запуск"]);
  expect(button().getAttribute("aria-describedby")).toBe(reason()!.id);
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
});
it("explains a retained active snapshot honestly after a failed refresh", async () => {
  api.readTopicBoard.mockResolvedValueOnce({ ...board, active: true });
  mount();
  await settled();
  api.readTopicBoard.mockRejectedValueOnce(Error("refresh unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Обновить список" }));
  await settled();
  assertReason(["не удалось загрузить список топиков"]);
  expect(screen.getByRole("alert").textContent).toContain(
    "refresh unavailable",
  );
});

it("keeps active and in-flight reasons without a dirty prohibition after the next board settles", async () => {
  const store = createTopicsStore();
  api.readTopicBoard.mockResolvedValueOnce({ ...board, dirty: true });
  const view = render(ui(store));
  await settled();
  const operation = deferred();
  api.prepareTopicOperation.mockReturnValueOnce(operation.promise);
  fireEvent.click(
    screen.getByRole("button", { name: "Удалить топик feature-b" }),
  );
  await waitFor(() => expect(api.prepareTopicOperation).toHaveBeenCalled());
  api.readTopicBoard.mockResolvedValueOnce({
    ...board,
    active: true,
    dirty: true,
  });
  view.rerender(ui(store, project, "2"));
  noReason();
  await settled();
  assertReason([
    "в проекте работает запуск",
    "выполняется операция с топиками",
  ]);
  await act(async () => operation.reject(Error("controlled failure")));
  assertReason(["в проекте работает запуск"]);
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});

it("allows creation from a dirty board without a dirty prohibition", async () => {
  api.readTopicBoard.mockResolvedValue({ ...board, dirty: true });
  mount();
  await settled();
  expect(button().disabled).toBe(false);
  noReason();
  fireEvent.click(button());
  expect(screen.getByRole("dialog", { name: "Создать топик" })).toBeTruthy();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
});
