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
import { TopicCard } from "../src/renderer/TopicCard";
import { createTopicsStore } from "../src/renderer/topics-model";
import { topicTargetSchema } from "../src/shared/topics-schema";
const project = {
    id: "catalog-project",
    name: "Catalog",
    path: "/fixture/primary",
  },
  target = { topic: "remote-only", branch: "origin/remote-only", remote: true },
  row = {
    ...target,
    statuses: ["published"],
    current: false,
    todo: "summary",
    divergence: null,
  };
const board = {
  projectId: project.id,
  year: "2026",
  revision: "board",
  currentBranch: "main",
  currentTopic: null,
  baseRef: "main",
  branches: ["main"],
  dirty: false,
  active: false,
  entries: [],
  records: [],
  remoteEntries: [{ ...row, hosts: [row.branch] }],
  remoteRecords: [row],
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
    readTopicDetails: vi.fn(async (scope: any, year: string, t: any) => ({
      projectId: project.id,
      year,
      target: topicTargetSchema.parse(t),
      text: "Committed remote task",
      version: "v",
      exists: true,
      editable: true,
    })),
    ensureTopicContext: vi.fn(),
    selectTopicContext: vi.fn(),
    prepareTopicOperation: vi.fn(),
    executeTopicOperation: vi.fn(),
    launch: vi.fn(),
    launchBuild: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
it.each(["topic", "current"] as const)(
  "reads an unowned remote %s only as explicit project catalog and forbids every mutation",
  async (kind) => {
    render(
      <TopicCard
        project={project}
        year="2026"
        target={target}
        board={board}
        store={createTopicsStore()}
        context={{ kind }}
        contextRequired
        minimal
        onClose={() => {}}
        onChanged={() => {}}
        onPrepare={() => {
          throw Error("No preparation from remote catalog");
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).queryByText("Загружаем топик…")).toBeNull(),
    );
    expect(within(dialog).getByText("Committed remote task")).toBeTruthy();
    expect(api.readTopicDetails).toHaveBeenCalledWith(
      project.id,
      "2026",
      target,
    );
    expect(
      within(dialog).queryByRole("textbox", { name: "Задача топика" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: /Сохранить задачу/ }),
    ).toBeNull();
    for (const name of [
      "Обновить из базы…",
      "Опубликовать…",
      "Перенести в базу…",
      "Удалить топик…",
    ]) {
      const button = within(dialog).getByRole("button", {
        name,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.selectTopicContext).not.toHaveBeenCalled();
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.launchBuild).not.toHaveBeenCalled();
  },
);
it("keeps unowned local topic fail-closed instead of treating primary as an execution owner", async () => {
  render(
    <TopicCard
      project={project}
      year="2026"
      target={{ ...target, branch: "remote-only", remote: false }}
      board={board}
      store={createTopicsStore()}
      context={{ kind: "topic" }}
      contextRequired
      minimal
      onClose={() => {}}
      onChanged={() => {}}
      onPrepare={() => {}}
    />,
  );
  expect(
    await screen.findByText(/Автономный клон этого топика не подтверждён/),
  ).toBeTruthy();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
});
