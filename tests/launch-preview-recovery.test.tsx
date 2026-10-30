import { selectCatalog } from "./helpers/select-catalog";
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
import { LaunchForm } from "../src/renderer/LaunchForm";
import type { TopicContextRef } from "../src/shared/worktrees";
const project = { id: "p", name: "Fixture", path: "/fixture" };
const owner: TopicContextRef = {
  projectId: "p",
  year: "2026",
  topic: "feature",
  branch: "feature",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const reason =
  "Этот конвейер не применяет профиль без рабочего процесса. Выберите рабочий процесс или Автоматически для этого запуска.";
const wrapped = () =>
  Error(`Error invoking remote method 'goga:read-request': Error: ${reason}`);
const catalog = {
  pipelines: [
    { id: "one", name: "One", project: true },
    { id: "two", name: "Two", project: true },
  ],
  topics: [
    {
      topic: "feature",
      branch: "feature",
      current: true,
      remote: false,
      statuses: [],
      todo: "task",
    },
  ],
  currentBranch: "feature",
  branches: ["feature"],
  baseRef: "main",
  workflows: ["custom", "two"],
  profiles: [{ name: "chosen", source: "project" }],
  projectSettings: { profile: "chosen" },
};
const preview = {
  token: "fresh",
  stages: [{ id: "step", title: "Step" }],
  workflow: null,
  profile: null,
};
let api: any;
let rejectComposition: boolean;
beforeEach(() => {
  rejectComposition = true;
  api = {
    discover: vi.fn(async () => catalog),
    preview: vi.fn(async (r: any) => {
      if (
        rejectComposition &&
        r.profileMode !== "auto" &&
        r.workflow !== "file:custom" &&
        r.pipeline !== "two"
      )
        throw wrapped();
      return preview;
    }),
    readTopicTask: vi.fn(async () => ({
      text: "task",
      exists: true,
      version: "v",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "feature"),
    launch: vi.fn(),
    saveTopicTask: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
const form = (context?: TopicContextRef, revision = "v1") => (
  <LaunchForm
    project={project}
    owner={context}
    settingsRevision={revision}
    onCancel={() => {}}
    onLaunched={() => {}}
  />
);
const launchButton = () =>
  screen.getByRole("button", {
    name: /^(Сохранить и запустить|Запустить)$/,
  }) as HTMLButtonElement;
const cases = [
  ["Профиль", "__auto__", { profile: "", profileMode: "auto" }],
  ["Рабочий процесс", "file:custom", { workflow: "file:custom" }],
  ["Конвейер", "two", { pipeline: "two" }],
] as const;
for (const context of [undefined, owner]) {
  it.each(cases)(
    `${context ? "clone" : "primary"}: recover preview validation via %s without losing the task`,
    async (label, value, request) => {
      render(form(context));
      await waitFor(() => expect(api.preview).toHaveBeenCalled());
      // Accessible roles exclude hidden/inert form controls: this is the reported dead end.
      const select = await screen.findByRole("combobox", { name: label });
      expect((select as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole("alert").textContent).toBe(reason);
      expect(launchButton().disabled).toBe(true);
      const task = screen.getByRole("textbox", { name: "Что нужно сделать?" });
      fireEvent.change(task, { target: { value: "unsaved task" } });
      selectCatalog(select, value);
      await waitFor(() => expect(launchButton().disabled).toBe(false));
      expect(screen.queryByText(reason)).toBeNull();
      expect(screen.getByDisplayValue("unsaved task")).toBe(task);
      expect(api.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          projectId: "p",
          ...request,
          ...(context ? { context } : {}),
        }),
      );
      for (const [r] of api.preview.mock.calls)
        expect(r.context).toEqual(context);
      expect(api.launch).not.toHaveBeenCalled();
      expect(api.saveTopicTask).not.toHaveBeenCalled();
    },
  );
}
it("settings refresh with a valid catalog and invalid composition remains correctable", async () => {
  rejectComposition = false;
  const view = render(form(owner));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
    { target: { value: "retained draft" } },
  );
  rejectComposition = true;
  view.rerender(form(owner, "v2"));
  await screen.findByText(reason);
  selectCatalog(screen.getByRole("combobox", { name: "Профиль" }), "__auto__");
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  expect(screen.getByDisplayValue("retained draft")).toBeTruthy();
});
it("failed preview invalidates an old token; retry stays blocked until the new preview succeeds", async () => {
  rejectComposition = false;
  render(form());
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  rejectComposition = true;
  selectCatalog(
    screen.getByRole("combobox", { name: "Рабочий процесс" }),
    "none",
  );
  await screen.findByText(reason);
  expect(launchButton().disabled).toBe(true);
  let resolve!: (p: typeof preview) => void;
  api.preview.mockReturnValueOnce(
    new Promise((ok) => {
      resolve = ok;
    }),
  );
  const button = launchButton();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  expect(button.disabled).toBe(true);
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(3));
  await act(async () => resolve({ ...preview, token: "retry-new" }));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  expect(api.launch).not.toHaveBeenCalled();
});
it("a transient full-stage refresh failure preserves the checklist and skipped stages", async () => {
  const stages = [
    { id: "step", title: "Step" },
    { id: "other", title: "Other" },
  ];
  let failFull = false;
  api.preview.mockImplementation(async (request: any) => {
    if (failFull && !request.skips.length) {
      failFull = false;
      throw Error("temporary full-stage failure");
    }
    return {
      ...preview,
      stages: stages.filter((stage) => !request.skips.includes(stage.id)),
    };
  });
  const view = render(form(owner));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  fireEvent.click(screen.getByRole("checkbox", { name: /other/i }));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  failFull = true;
  view.rerender(form(owner, "v2"));
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  await screen.findByText("temporary full-stage failure");
  expect(launchButton().disabled).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: /other/i }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить обновление каталога" }),
  );
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  expect(
    (screen.getByRole("checkbox", { name: /step/i }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: /other/i }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  expect(api.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ context: owner, skips: ["other"] }),
  );
  expect(api.launch).not.toHaveBeenCalled();
});
