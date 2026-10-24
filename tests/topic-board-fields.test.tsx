// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TopicsWorkspace } from "../src/renderer/TopicsWorkspace";
import { TopicOverview } from "../src/renderer/TopicOverview";
import { createTopicsStore } from "../src/renderer/topics-model";
import type { TopicBoardEntry, TopicBoardSnapshot } from "../src/shared/topics";

const project = { id: "p", name: "Project", path: "/fixture" };
const row = (
  topic: string,
  divergence: string | null,
  hosts: string[],
  statuses = ["planned"],
): TopicBoardEntry => ({
  topic,
  branch: `feature/${topic}`,
  remote: false,
  current: false,
  statuses,
  todo: null,
  divergence,
  hosts,
});
const alpha = row("alpha", "need-update", ["main", "release"]);
const beta = row("beta", "propagated", ["release"]);
const gamma = row("gamma", "base", ["develop"], ["done"]);
const makeBoard = (entries = [alpha, beta, gamma]): TopicBoardSnapshot => ({
  projectId: "p",
  year: "2026",
  revision: "display:test",
  currentBranch: "",
  currentTopic: null,
  baseRef: "",
  branches: [],
  dirty: false,
  active: false,
  entries,
  records: entries,
  remoteEntries: [],
  remoteRecords: [],
});
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readTopicTable: vi.fn(async () => makeBoard()),
    readTopicBoard: vi.fn(async () => makeBoard()),
    readTopicOverview: vi.fn(async (_scope, year, target) => ({
      projectId: "p",
      year,
      target,
      text: "Task text",
      exists: true,
      version: "v",
      editable: false,
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
const workspace = (store = createTopicsStore()) => (
  <TopicsWorkspace
    project={project}
    store={store}
    onOpenTopic={vi.fn()}
    onChanged={vi.fn()}
    selectedContext={{
      projectId: "p",
      year: "2026",
      topic: beta.topic,
      branch: beta.branch,
    }}
  />
);
const card = (board: TopicBoardSnapshot | null, target = alpha) => (
  <TopicOverview
    project={project}
    year="2026"
    target={target}
    board={board}
    onClose={vi.fn()}
    onChanged={vi.fn()}
  />
);
const visibleTopics = () =>
  screen
    .getAllByRole("button", { name: /^Открыть топик / })
    .map((button) => button.textContent);

it("shows branch and base columns before statuses and preserves current-first ordering", async () => {
  render(workspace());
  await screen.findByRole("button", { name: "Открыть топик alpha" });
  expect(
    screen.getAllByRole("columnheader").map((cell) => cell.textContent),
  ).toEqual([
    "Топик",
    "Ветка",
    "Относительно base",
    "Статусы",
    "Активные запуски",
    "Действия",
  ]);
  expect(visibleTopics()).toEqual(["beta", "alpha", "gamma"]);
  const cells = within(screen.getAllByRole("row")[1]!).getAllByRole("cell");
  expect(cells[1]!.textContent).toBe("feature/beta");
  expect(cells[2]!.textContent).toBe("Перенесён в базу");
  expect(api.readTopicTable).toHaveBeenCalledTimes(1);
  expect(api.readTopicBoard).not.toHaveBeenCalled();
});
it.each([
  ["base", "Совпадает с базой"],
  ["up-to-date", "База актуальна"],
  ["propagated", "Перенесён в базу"],
  ["need-update", "Требует обновления"],
  ["future-value", "future-value"],
])(
  "renders %s with the same Russian label and native title in table and card",
  async (code, label) => {
    const entry = row("alpha", code, ["main"]),
      board = makeBoard([entry]);
    api.readTopicTable.mockResolvedValue(board);
    const table = render(workspace());
    expect((await screen.findByText(label)).getAttribute("title")).toBe(code);
    table.unmount();
    render(card(board, entry));
    expect(screen.getByText(label).getAttribute("title")).toBe(code);
    expect(
      screen
        .getByText(label)
        .closest(".topic-statuses")
        ?.contains(screen.getByText("planned")),
    ).toBe(true);
    await screen.findByText("Task text");
    expect(api.readTopicTable).toHaveBeenCalledTimes(1);
    expect(api.readTopicBoard).not.toHaveBeenCalled();
  },
);
it("renders unknown divergence as a dash in table and card", async () => {
  const entry = row("alpha", null, []),
    board = makeBoard([entry]);
  api.readTopicTable.mockResolvedValue(board);
  const view = render(workspace());
  await screen.findByRole("button", { name: "Открыть топик alpha" });
  expect(
    within(screen.getAllByRole("row")[1]!).getAllByRole("cell")[2]!.textContent,
  ).toBe("—");
  view.unmount();
  render(card(board, entry));
  expect(screen.getByText("—").closest(".topic-statuses")).toBeTruthy();
  await screen.findByText("Task text");
});
async function selectFilter(button: RegExp, values: string[], search?: string) {
  fireEvent.click(screen.getByRole("button", { name: button }));
  const dialog = screen.getByRole("dialog");
  if (search)
    fireEvent.change(within(dialog).getByRole("searchbox"), {
      target: { value: search },
    });
  for (const value of values)
    fireEvent.click(within(dialog).getByRole("checkbox", { name: value }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Применить" }));
}
it("filters by placement (not own branch), OR within hosts, AND groups, retaining choices and resetting without extra reads", async () => {
  const store = createTopicsStore();
  let view = render(workspace(store));
  await screen.findByRole("button", { name: "Открыть топик alpha" });
  await selectFilter(/^Размещение/, ["main", "develop"]);
  expect(visibleTopics()).toEqual(["alpha", "gamma"]);
  expect(api.readTopicTable).toHaveBeenCalledTimes(1);
  await selectFilter(/^Статусы ·/, ["planned"]);
  expect(visibleTopics()).toEqual(["alpha"]);
  await selectFilter(/^Топики ·/, ["beta"]);
  expect(screen.queryByRole("button", { name: /^Открыть топик / })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
  expect(visibleTopics()).toEqual(["beta", "alpha", "gamma"]);
  expect(store.filters.get("p")?.hosts).toEqual([]);
  await selectFilter(/^Размещение/, ["release"], "relea");
  expect(visibleTopics()).toEqual(["beta", "alpha"]);
  view.unmount();
  view = render(workspace(store));
  await screen.findByRole("button", { name: "Открыть топик beta" });
  expect(visibleTopics()).toEqual(["beta", "alpha"]);
  expect(screen.getByRole("button", { name: /^Размещение · 1/ })).toBeTruthy();
  expect(api.readTopicTable).toHaveBeenCalledTimes(2);
  expect(api.readTopicBoard).not.toHaveBeenCalled();
});
it("loads only display metadata for a card opened from the selector without an initial board", async () => {
  render(card(null));
  await screen.findByText("Task text");
  expect(await screen.findByText("Требует обновления")).toBeTruthy();
  expect(screen.getByText("planned")).toBeTruthy();
  expect(api.readTopicTable).toHaveBeenCalledExactlyOnceWith("p", "2026");
  expect(api.readTopicBoard).not.toHaveBeenCalled();
});
it.each(["project", "year", "branch", "remote"])(
  "does not show divergence from a mismatched %s",
  async (mismatch) => {
    const wrong = makeBoard([
      {
        ...alpha,
        divergence: "propagated",
        ...(mismatch === "branch" ? { branch: "other" } : {}),
        ...(mismatch === "remote" ? { remote: true } : {}),
      },
    ]);
    if (mismatch === "project") wrong.projectId = "another";
    if (mismatch === "year") wrong.year = "2025";
    api.readTopicTable.mockResolvedValue(makeBoard([alpha]));
    render(card(wrong));
    await screen.findByText("Task text");
    expect(screen.queryByText("Перенесён в базу")).toBeNull();
    expect(await screen.findByText("Требует обновления")).toBeTruthy();
    expect(api.readTopicBoard).not.toHaveBeenCalled();
  },
);
it("ignores a late metadata response after target changes", async () => {
  let finish!: (value: TopicBoardSnapshot) => void;
  api.readTopicTable.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(card(null));
  await waitFor(() => expect(api.readTopicTable).toHaveBeenCalledTimes(1));
  view.rerender(card(makeBoard(), beta));
  await screen.findByText("Перенесён в базу");
  finish(makeBoard());
  await waitFor(() =>
    expect(screen.queryByText("Требует обновления")).toBeNull(),
  );
});
