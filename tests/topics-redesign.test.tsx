// @vitest-environment jsdom
import React from "react";
import { installHistoryWorker } from "./helpers/history-worker";
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
const project = { id: "p", name: "Project", path: "/fixture" };
const row = (topic: string) => ({
  topic,
  branch: topic,
  remote: false,
  current: false,
  statuses: ["planned"],
  todo: "not in table",
  divergence: null,
  hosts: [topic],
});
const a = row("alpha"),
  b = row("beta");
const board = {
  projectId: "p",
  year: "2026",
  revision: "display-only",
  currentBranch: "alpha",
  currentTopic: a,
  baseRef: "main",
  branches: ["main", "alpha", "beta"],
  dirty: false,
  active: false,
  entries: [a, b],
  records: [a, b],
  remoteEntries: [],
  remoteRecords: [],
};
let api: any;
beforeEach(() => {
  installHistoryWorker();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readTopicTable: vi.fn(async () => board),
    readTopicOverview: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      target: b,
      text: "# My task\n\nFull text",
      exists: true,
      version: "v",
      editable: false,
    })),
    readTopicBoard: vi.fn(async () => ({ ...board, revision: "fresh" })),
    prepareTopicOperation: vi.fn(async (r) => ({
      token: "t",
      projectId: "p",
      year: "2026",
      action: r.action,
      title: "Подтвердите действие",
      details: [],
      expiresAt: Date.now() + 10000,
    })),
    executeTopicOperation: vi.fn(async () => ({
      status: "success",
      message: "Готово",
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
it("pins selected context, not primary Git branch; compact table has direct actions", async () => {
  const open = vi.fn(),
    select = vi.fn();
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onChanged={vi.fn()}
      onOpenTopic={open}
      onSelectTopic={select}
      selectedContext={{
        projectId: "p",
        year: "2026",
        topic: "beta",
        branch: "beta",
      }}
    />,
  );
  await screen.findByRole("button", { name: "Открыть топик beta" });
  const rows = screen.getAllByRole("row");
  expect(within(rows[1]!).getByText("Текущий")).toBeTruthy();
  expect(
    within(rows[1]!).getByRole("button", { name: "Открыть топик beta" }),
  ).toBeTruthy();
  expect(screen.queryByText("not in table")).toBeNull();
  expect(screen.queryByText("Собственная ветка")).toBeNull();
  expect(api.readTopicBoard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Открыть топик alpha" }));
  expect(open).toHaveBeenCalled();
  expect(select).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Переключиться на топик alpha" }),
  );
  expect(select).toHaveBeenCalledWith({
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "alpha",
  });
  fireEvent.click(screen.getByRole("button", { name: "Удалить топик alpha" }));
  await waitFor(() =>
    expect(api.prepareTopicOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "delete",
        expectedRevision: "fresh",
        target: { topic: "alpha", branch: "alpha", remote: false },
      }),
    ),
  );
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});
it("no topic means no selected row even if primary repository is on a topic branch", async () => {
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onChanged={vi.fn()}
      onOpenTopic={vi.fn()}
      selectedContext={null}
    />,
  );
  await screen.findByRole("button", { name: "Открыть топик alpha" });
  expect(screen.queryByText("Текущий")).toBeNull();
});
const card = () =>
  render(
    <TopicOverview
      project={project}
      year="2026"
      target={b}
      board={board}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      ownerReadState="confirmed"
    />,
  );
it("opens task without clone and loads placements only on demand, keeps actions in footer", async () => {
  card();
  await screen.findByRole("heading", { name: "My task" });
  expect(api.readTopicOverview).toHaveBeenCalledWith("p", "2026", {
    topic: "beta",
    branch: "beta",
    remote: false,
  });
  expect(api.readTopicBoard).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Синхронизировать/ })).toBeNull();
  expect(screen.queryByText(/Есть копия|Нет копии/)).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Размещение по веткам" }));
  await waitFor(() => expect(api.readTopicBoard).toHaveBeenCalledTimes(1));
  expect(
    screen.getByRole("button", { name: "Удалить топик…" }).closest("footer"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Задача" }));
  expect(await screen.findByRole("heading", { name: "My task" })).toBeTruthy();
  expect(api.readTopicOverview).toHaveBeenCalledTimes(1);
});
it("settles overview failures and keeps header/footer accessible", async () => {
  api.readTopicOverview.mockRejectedValueOnce(Error("Test error"));
  card();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Test error",
  );
  expect(
    screen.queryByRole("status", { name: "Загружаем задачу…" }),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Закрыть карточку" })).toBeTruthy();
});
it("selecting a base only picks it; update obtains a fresh proof and requires confirmation", async () => {
  card();
  await screen.findByRole("heading", { name: "My task" });
  const base = screen.getByRole("combobox", {
    name: "Из ветки",
  });
  fireEvent.focus(base);
  await within(screen.getByRole("combobox", { name: "Из ветки" })).findByRole(
    "option",
    { name: "main" },
  );
  fireEvent.change(base, { target: { value: "main" } });
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
  await waitFor(() =>
    expect(api.prepareTopicOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "update",
        baseRef: "main",
        publish: false,
        expectedRevision: "fresh",
        target: { topic: "beta", branch: "beta", remote: false },
      }),
    ),
  );
  expect(api.readTopicBoard).toHaveBeenCalledTimes(2);
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});
it("does not substitute primary catalog while owner inventory is uncertain", async () => {
  const view = render(
    <TopicOverview
      project={project}
      year="2026"
      target={b}
      board={board}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      ownerReadState="loading"
    />,
  );
  expect(api.readTopicOverview).not.toHaveBeenCalled();
  view.rerender(
    <TopicOverview
      project={project}
      year="2026"
      target={b}
      board={board}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      ownerReadState="error"
      ownerReadError="Inventory unavailable"
    />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Inventory unavailable",
  );
  expect(api.readTopicOverview).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: "Удалить топик…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it("reloads placements after a confirmed update without switching tabs", async () => {
  card();
  await screen.findByRole("heading", { name: "My task" });
  fireEvent.click(screen.getByRole("tab", { name: "Размещение по веткам" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("status", { name: "Загружаем размещение…" }),
    ).toBeNull(),
  );
  fireEvent.focus(screen.getByRole("combobox", { name: "Из ветки" }));
  await within(screen.getByRole("combobox", { name: "Из ветки" })).findByRole(
    "option",
    { name: "main" },
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Из ветки" }), {
    target: { value: "main" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить" }));
  await waitFor(() => expect(api.readTopicBoard).toHaveBeenCalledTimes(4));
  await waitFor(() =>
    expect(screen.getByRole("table").textContent).toContain("beta"),
  );
  expect(screen.queryByText("Размещения не найдены")).toBeNull();
});
it("keeps remote placements readable while mutations are unavailable", async () => {
  const remote = { topic: "beta", branch: "origin/beta", remote: true };
  api.readTopicOverview.mockResolvedValue({
    projectId: "p",
    year: "2026",
    target: remote,
    text: "Remote task",
    exists: true,
    version: "v",
    editable: false,
  });
  api.readTopicBoard.mockResolvedValue({
    ...board,
    remoteRecords: [{ ...b, ...remote }],
  });
  render(
    <TopicOverview
      project={project}
      year="2026"
      target={remote}
      board={board}
      onClose={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  await screen.findByText("Remote task");
  fireEvent.click(screen.getByRole("tab", { name: "Размещение по веткам" }));
  await screen.findByText("origin/beta");
  expect(
    (screen.getByRole("button", { name: "Обновить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it("renders repository text safely without executing raw HTML or loading images", async () => {
  api.readTopicOverview.mockResolvedValue({
    projectId: "p",
    year: "2026",
    target: b,
    text: '<img src="https://example.invalid/pixel">\n\n```sh\nprintf x\n```\n\n- **item**',
    exists: true,
    version: "v",
    editable: false,
  });
  const view = card();
  await screen.findByText('<img src="https://example.invalid/pixel">');
  expect(view.container.querySelector("img")).toBeNull();
  expect(screen.getByText("printf x").tagName).toBe("CODE");
  expect(screen.getByText("item").tagName).toBe("STRONG");
});
it("does not choose an arbitrary owner for deletion when the same topic has multiple contexts", async () => {
  const owner = {
    projectId: "p",
    year: "2026",
    topic: "beta",
    branch: "beta",
    contextId: "one",
    revision: "r",
    state: "ready",
    storageKind: "clone",
    ownership: "managed",
    path: "/one",
    projectPath: "/fixture",
    gitCommonDir: "/one/.git",
    repositoryKey: "repo",
  } as any;
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      knownContexts={[owner, { ...owner, contextId: "two", path: "/two" }]}
      onOpenTopic={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  const button = await screen.findByRole("button", {
    name: "Удалить топик beta",
  });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
});
it("retains the exact deletion owner chosen at click, not the latest inventory order", async () => {
  const owner = {
    projectId: "p",
    year: "2026",
    topic: "beta",
    branch: "beta",
    contextId: "one",
    revision: "r",
    state: "ready",
    storageKind: "clone",
    ownership: "managed",
    path: "/one",
    projectPath: "/fixture",
    gitCommonDir: "/one/.git",
    repositoryKey: "repo",
  } as any;
  api.prepareContextDeletion = vi.fn(async () => ({
    token: "owned-token",
    contextId: "one",
    stage: "prepared",
    details: ["Owned"],
  }));
  const props = {
    project,
    store: createTopicsStore(),
    onOpenTopic: vi.fn(),
    onChanged: vi.fn(),
  };
  const view = render(<TopicsWorkspace {...props} knownContexts={[owner]} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Удалить топик beta" }),
  );
  await waitFor(() =>
    expect(api.prepareContextDeletion).toHaveBeenCalledTimes(1),
  );
  view.rerender(
    <TopicsWorkspace
      {...props}
      knownContexts={[{ ...owner, contextId: "two", path: "/two" }, owner]}
    />,
  );
  expect(api.prepareContextDeletion.mock.calls[0][0].contextId).toBe("one");
  expect(api.prepareContextDeletion).toHaveBeenCalledTimes(1);
});
