// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { createDraftStore } from "../src/renderer/task-drafts";

const project = { id: "p", name: "Project", path: "/fixture/p" };
let api: any;
beforeEach(() => {
  api = {
    discover: vi.fn(async () => ({
      pipelines: [
        { id: "build", name: "Build", description: "", project: true },
      ],
      topics: [
        {
          branch: "main",
          topic: "main",
          current: true,
          remote: false,
          todo: "",
          statuses: [],
        },
      ],
      branches: ["main"],
      currentBranch: "main",
      workflows: [],
      profiles: [],
    })),
    preview: vi.fn(async () => ({
      token: "token",
      stages: [{ id: "one", title: "One" }],
      workflow: null,
      profile: null,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "saved task",
      exists: true,
      version: "v1",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    launch: vi.fn(async () => ({ id: "run" })),
  };
  window.goga = api;
});
afterEach(cleanup);
const store = () => createDraftStore();
function form(drafts = store()) {
  return render(
    <LaunchForm
      project={project}
      draftStore={drafts}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
}
async function loaded() {
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Запустить" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
}
function disclosure() {
  const summary = screen.getByText("Что нужно сделать?", {
    selector: "summary",
  });
  return { summary, details: summary.closest("details")! };
}
it.each(["saved task", ""])(
  "starts collapsed with task %j and launches without opening",
  async (text) => {
    api.readTopicTask.mockResolvedValue({
      text,
      exists: true,
      version: "v1",
      path: "todo.md",
    });
    form();
    await loaded();
    expect(disclosure().details.open).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Запустить" }));
    await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
    expect(api.launch.mock.calls[0][0]).toMatchObject({
      task: text,
      taskVersion: "v1",
    });
  },
);
it("toggles the same editor without reading again, preserves edits and sends them while collapsed", async () => {
  form();
  await loaded();
  const calls = api.readTopicTask.mock.calls.length;
  const { summary, details } = disclosure();
  await userEvent.click(summary);
  expect(details.open).toBe(true);
  const editor = screen.getByRole("textbox", { name: "Что нужно сделать?" });
  fireEvent.change(editor, { target: { value: "edited task" } });
  await userEvent.click(summary);
  expect(details.open).toBe(false);
  await userEvent.click(summary);
  expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
    editor,
  );
  expect(editor).toHaveProperty("value", "edited task");
  await userEvent.click(summary);
  expect(api.readTopicTask).toHaveBeenCalledTimes(calls);
  await userEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    task: "edited task",
    taskVersion: "v1",
  });
});
it("keeps empty replacement consent outside the collapsed editor", async () => {
  form();
  await loaded();
  const { summary, details } = disclosure();
  await userEvent.click(summary);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
    { target: { value: "" } },
  );
  await userEvent.click(summary);
  const consent = screen.getByRole("checkbox", {
    name: "Подтверждаю сохранение пустой задачи",
  });
  expect(details.contains(consent)).toBe(false);
  expect(
    screen
      .getByRole("button", { name: "Сохранить и запустить" })
      .hasAttribute("disabled"),
  ).toBe(true);
  await userEvent.click(consent);
  await userEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    task: "",
    confirmEmptyTask: true,
  });
});
it("reopens the form collapsed while keeping its draft", async () => {
  const drafts = store();
  const view = form(drafts);
  await loaded();
  await userEvent.click(disclosure().summary);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
    { target: { value: "draft" } },
  );
  view.unmount();
  form(drafts);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Сохранить и запустить" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  expect(disclosure().details.open).toBe(false);
  await userEvent.click(disclosure().summary);
  expect(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
  ).toHaveProperty("value", "draft");
});
it("shows task loading errors and retry outside the disclosure", async () => {
  api.readTopicTask.mockRejectedValue(new Error("Cannot read task"));
  form();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Cannot read task",
  );
  expect(
    screen.getByRole("button", { name: /Повторить/ }).closest("details"),
  ).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
});

it("collapses when changing from an existing task to a new topic", async () => {
  form();
  await loaded();
  await userEvent.click(disclosure().summary);
  expect(disclosure().details.open).toBe(true);
  await userEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  await waitFor(() => expect(disclosure().details.open).toBe(false));
  await userEvent.click(disclosure().summary);
  expect(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
  ).toHaveProperty("value", "");
});

it("keeps the clone's nonempty-task prerequisite visible while collapsed", async () => {
  api.readTopicTask.mockResolvedValue({
    text: "",
    exists: false,
    version: "v1",
    path: "todo.md",
    catalogState: "missing-local-metadata",
  });
  render(
    <LaunchForm
      project={project}
      owner={{
        projectId: project.id,
        topic: "main",
        branch: "main",
        year: "2026",
        contextId: "ctx-" + "a".repeat(64),
        revision: "00000000-0000-4000-8000-000000000001",
      }}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  const reason = await screen.findByText(
    "Для запуска в этой копии нужна непустая задача.",
  );
  expect(disclosure().details.open).toBe(false);
  expect(reason.closest("details")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Запустить" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(api.launch).not.toHaveBeenCalled();
});

it("separates the task textarea, hints and reload button with explicit spacing", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/renderer/style.css", "utf8");
  document.head.append(style);
  try {
    form();
    await loaded();
    await userEvent.click(disclosure().summary);
    const hints = disclosure().details.querySelectorAll(".hint");
    expect(hints.length).toBe(2);
    expect(getComputedStyle(hints[0]!).marginTop).toBe("12px");
    expect(getComputedStyle(hints[1]!).marginTop).toBe("8px");
    expect(
      getComputedStyle(
        screen.getByRole("button", { name: "Перечитать задачу" }),
      ).marginTop,
    ).toBe("12px");
  } finally {
    style.remove();
  }
});
