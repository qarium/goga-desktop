import { selectCatalog } from "./helpers/select-catalog";
// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ExistingTopicLaunchForm as LaunchForm } from "./helpers/existing-pipeline-draft";
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

const selectableStages = [
  { id: "step", title: "Step" },
  { id: "other", title: "Other" },
];
function heldPreview() {
  let resolve!: (value: typeof preview) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<typeof preview>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
for (const context of [undefined, owner]) {
  const label = context ? "clone" : "primary";
  it(`${label}: toggles stages in place, permits rapid toggles and ignores an older preview`, async () => {
    api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
    api.launch.mockResolvedValue({ id: "run" });
    render(form(context));
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    const textarea = screen.getByRole("textbox", {
      name: "Что нужно сделать?",
    });
    fireEvent.change(textarea, { target: { value: "Unsaved task" } });
    const other = screen.getByRole<HTMLInputElement>("checkbox", {
      name: /other/i,
    });
    other.focus();
    const first = heldPreview(),
      latest = heldPreview();
    api.preview
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    fireEvent.click(other);
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    expect(document.querySelector(".loading-state")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /other/i })).toBe(other);
    expect(document.activeElement).toBe(other);
    expect(other.checked).toBe(false);
    expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
      textarea,
    );
    expect(launchButton().disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "Edited while checking" } });
    fireEvent.click(other);
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(3));
    expect(other.checked).toBe(true);
    expect(document.querySelector(".loading-state")).toBeNull();
    await act(async () =>
      first.resolve({
        ...preview,
        token: "old-token",
        stages: [selectableStages[0]],
      }),
    );
    expect(launchButton().disabled).toBe(true);
    expect(other.checked).toBe(true);
    await act(async () =>
      latest.resolve({
        ...preview,
        token: "latest-token",
        stages: selectableStages,
      }),
    );
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    expect(textarea).toHaveProperty("value", "Edited while checking");
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    expect(api.preview.mock.calls[1][0].skips).toEqual(["other"]);
    expect(api.preview.mock.calls[2][0].skips).toEqual([]);
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
    expect(api.launch.mock.calls[0][0]).toMatchObject({
      ...(context ? { context } : {}),
      previewToken: "latest-token",
      skips: [],
      task: "Edited while checking",
    });
  });
  it(`${label}: failed stage validation keeps the form editable and launch blocked through retry`, async () => {
    api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
    render(form(context));
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    const checking = heldPreview();
    api.preview.mockReturnValueOnce(checking.promise);
    fireEvent.click(screen.getByRole("checkbox", { name: /other/i }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    await act(async () => checking.reject(Error("Stage check failed")));
    await screen.findByText("Stage check failed");
    expect(document.querySelector(".loading-state")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /other/i })).toHaveProperty(
      "checked",
      false,
    );
    expect(launchButton().disabled).toBe(true);
    fireEvent.click(launchButton());
    expect(api.launch).not.toHaveBeenCalled();
    const retry = heldPreview();
    api.preview.mockReturnValueOnce(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(3));
    expect(document.querySelector(".loading-state")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /other/i })).toHaveProperty(
      "checked",
      false,
    );
    expect(launchButton().disabled).toBe(true);
    await act(async () =>
      retry.resolve({
        ...preview,
        token: "retry-stage-token",
        stages: [selectableStages[0]],
      }),
    );
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ skips: ["other"] }),
    );
    expect(api.launch).not.toHaveBeenCalled();
  });
}
it.each(["stages", "pipeline"])(
  "a pending %s preview cannot reopen the form or supply a token after the owner changes",
  async (change) => {
    api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
    const view = render(form(owner));
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    const old = heldPreview();
    api.preview.mockReturnValueOnce(old.promise);
    if (change === "pipeline")
      selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "two");
    else fireEvent.click(screen.getByRole("checkbox", { name: /other/i }));
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    let resolveCatalog!: (value: typeof catalog) => void;
    api.discover.mockReturnValueOnce(
      new Promise<typeof catalog>((resolve) => {
        resolveCatalog = resolve;
      }),
    );
    const nextOwner = {
      ...owner,
      revision: "00000000-0000-4000-8000-000000000002",
    };
    api.preview.mockResolvedValue({
      ...preview,
      token: "new-owner-token",
      stages: selectableStages,
    });
    view.rerender(form(nextOwner));
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    expect(document.querySelector(".loading-state")).not.toBeNull();
    await act(async () =>
      old.resolve({
        ...preview,
        token: "old-owner-token",
        stages: [selectableStages[0]],
      }),
    );
    expect(document.querySelector(".loading-state")).not.toBeNull();
    expect(screen.queryByRole("checkbox", { name: /other/i })).toBeNull();
    await act(async () => resolveCatalog(catalog));
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ context: nextOwner }),
    );
    expect(api.launch).not.toHaveBeenCalled();
  },
);
it("changing pipeline after stage toggles still requires a fresh preview, locally", async () => {
  api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
  render(form(owner));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  fireEvent.click(screen.getByRole("checkbox", { name: /other/i }));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  const checking = heldPreview();
  api.preview.mockReturnValueOnce(checking.promise);
  selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "two");
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(3));
  const area = screen.getByRole("region", { name: "Стадии запуска" });
  expect(
    within(area).getByRole("status", { name: "Загружаем стадии конвейера…" }),
  ).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Конвейер" })).toBeTruthy();
  expect(launchButton().disabled).toBe(true);
  expect(api.launch).not.toHaveBeenCalled();
  await act(async () =>
    checking.resolve({ ...preview, stages: selectableStages }),
  );
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  expect(api.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ pipeline: "two", skips: [] }),
  );
});
it("keeps the stage checklist available with all stages skipped, without allowing an empty run", async () => {
  api.preview.mockImplementation(async (request: any) => ({
    ...preview,
    stages: selectableStages.filter(
      (stage) => !request.skips.includes(stage.id),
    ),
  }));
  render(form(owner));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  fireEvent.click(screen.getByRole("checkbox", { name: /other/i }));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  fireEvent.click(screen.getByRole("checkbox", { name: /step/i }));
  await screen.findByText("Нельзя запустить пустой набор стадий.");
  expect(launchButton().disabled).toBe(true);
  expect(document.querySelector(".loading-state")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: /step/i }));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  expect(api.launch).not.toHaveBeenCalled();
});

for (const context of [undefined, owner]) {
  const label = context ? "clone" : "primary";
  it(`${label}: changing pipeline loads only stages while preserving editable controls and task`, async () => {
    api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
    api.launch.mockResolvedValue({ id: "run" });
    render(form(context));
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    const task = screen.getByRole("textbox", { name: "Что нужно сделать?" });
    fireEvent.change(task, { target: { value: "Unsaved pipeline task" } });
    const picker = screen.getByRole("combobox", { name: "Конвейер" });
    const checking = heldPreview();
    api.preview.mockReturnValueOnce(checking.promise);
    selectCatalog(picker, "two");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("combobox", { name: "Конвейер" })).toBe(picker);
    expect(document.activeElement).toBe(picker);
    for (const name of ["Рабочий процесс", "Профиль"])
      expect(
        screen.getByRole<HTMLButtonElement>("combobox", { name }).disabled,
      ).toBe(false);
    expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
      task,
    );
    fireEvent.change(task, {
      target: { value: "Edited during pipeline loading" },
    });
    const area = screen.getByRole("region", { name: "Стадии запуска" });
    expect(
      within(area).getByRole("status", { name: "Загружаем стадии конвейера…" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Загружаем параметры конвейера…" }),
    ).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /other/i })).toBeNull();
    expect(screen.getAllByText("проверяем…")).toHaveLength(2);
    expect(launchButton().disabled).toBe(true);
    fireEvent.click(launchButton());
    expect(api.launch).not.toHaveBeenCalled();
    await act(async () =>
      checking.resolve({
        ...preview,
        token: "pipeline-two-token",
        stages: [{ id: "new", title: "New stage" }],
      }),
    );
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    expect(within(area).getByRole("checkbox", { name: /new/i })).toBeTruthy();
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
    expect(api.launch.mock.calls[0][0]).toMatchObject({
      ...(context ? { context } : {}),
      pipeline: "two",
      previewToken: "pipeline-two-token",
      skips: [],
      task: "Edited during pipeline loading",
    });
  });
  it(`${label}: pipeline failure and retry stay in the stage area without hiding the rest of the form`, async () => {
    api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
    render(form(context));
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    const checking = heldPreview();
    api.preview.mockReturnValueOnce(checking.promise);
    selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "two");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    await act(async () => checking.reject(Error("Selected pipeline failed")));
    await screen.findByText("Selected pipeline failed");
    const area = screen.getByRole("region", { name: "Стадии запуска" });
    expect(within(area).getByRole("alert").textContent).toBe(
      "Selected pipeline failed",
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Конвейер" })).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Что нужно сделать?" }),
    ).toBeTruthy();
    expect(launchButton().disabled).toBe(true);
    const retry = heldPreview();
    api.preview.mockReturnValueOnce(retry.promise);
    fireEvent.click(
      within(area).getByRole("button", { name: "Повторить загрузку" }),
    );
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(3));
    expect(
      within(area).getByRole("status", { name: "Загружаем стадии конвейера…" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Загружаем параметры конвейера…" }),
    ).toBeNull();
    expect(screen.getByRole("combobox", { name: "Конвейер" })).toBeTruthy();
    expect(launchButton().disabled).toBe(true);
    await act(async () =>
      retry.resolve({
        ...preview,
        token: "retry-pipeline-token",
        stages: selectableStages,
      }),
    );
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    expect(screen.queryByText("Selected pipeline failed")).toBeNull();
    expect(api.launch).not.toHaveBeenCalled();
  });
  it(`${label}: a late pipeline response cannot replace the latest selection even after returning to the first pipeline`, async () => {
    api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
    api.launch.mockResolvedValue({ id: "run" });
    render(form(context));
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    const old = heldPreview(),
      latest = heldPreview();
    api.preview
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise);
    selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "two");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "one");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(3));
    expect(launchButton().disabled).toBe(true);
    await act(async () =>
      latest.resolve({
        ...preview,
        token: "returned-one-token",
        stages: [{ id: "current", title: "Current" }],
      }),
    );
    await waitFor(() => expect(launchButton().disabled).toBe(false));
    await act(async () =>
      old.resolve({
        ...preview,
        token: "late-two-token",
        stages: [{ id: "stale", title: "Stale" }],
      }),
    );
    expect(screen.queryByRole("checkbox", { name: /stale/i })).toBeNull();
    expect(screen.getByRole("checkbox", { name: /current/i })).toBeTruthy();
    fireEvent.click(launchButton());
    await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
    expect(api.launch.mock.calls[0][0]).toMatchObject({
      pipeline: "one",
      previewToken: "returned-one-token",
    });
  });
}
it("an empty pipeline result stays local and cannot be launched", async () => {
  api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
  render(form(owner));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  api.preview.mockResolvedValueOnce({ ...preview, stages: [] });
  selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "two");
  await screen.findByText("Нельзя запустить пустой набор стадий.");
  const area = screen.getByRole("region", { name: "Стадии запуска" });
  expect(within(area).getByRole("alert").textContent).toBe(
    "Нельзя запустить пустой набор стадий.",
  );
  expect(screen.getByRole("combobox", { name: "Конвейер" })).toBeTruthy();
  expect(launchButton().disabled).toBe(true);
  expect(api.launch).not.toHaveBeenCalled();
});

it("keeps launch admission errors at form level after a successful local pipeline refresh", async () => {
  api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
  api.launch.mockRejectedValue(Error("Launch denied by owner guard"));
  render(form(owner));
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "two");
  await waitFor(() => expect(launchButton().disabled).toBe(false));
  fireEvent.click(launchButton());
  await screen.findByText("Launch denied by owner guard");
  const area = screen.getByRole("region", { name: "Стадии запуска" });
  expect(area.contains(screen.getByRole("alert"))).toBe(false);
  expect(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeTruthy();
});

it("gives the pipeline stage area explicit breathing room without resizing cards or changing other stage grids", async () => {
  const style = document.createElement("style");
  style.textContent = ["style.css", "LoadingBoundary.css", "LaunchForm.css"]
    .map((file) => readFileSync(`src/renderer/${file}`, "utf8"))
    .join("\n");
  document.head.append(style);
  try {
    api.preview.mockResolvedValue({ ...preview, stages: selectableStages });
    const view = render(
      <>
        <LaunchForm
          project={project}
          owner={owner}
          onCancel={() => {}}
          onLaunched={() => {}}
        />
        <div className="stage-cards" data-testid="other-stage-grid" />
      </>,
    );
    await waitFor(() =>
      expect(
        view.container
          .querySelector(".launch-panel")
          ?.getAttribute("aria-busy"),
      ).toBe("false"),
    );
    selectCatalog(screen.getByRole("combobox", { name: "Конвейер" }), "two");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(view.container.querySelector(".stage-cards input")).not.toBeNull(),
    );
    const area = view.container.querySelector<HTMLElement>(".pipeline-stages")!;
    const cards = area.querySelector<HTMLElement>(".stage-cards")!;
    const hints = area.querySelectorAll<HTMLElement>(
      ".loading-content > .hint",
    );
    expect(hints).toHaveLength(2);
    expect(getComputedStyle(cards).marginTop).toBe("0px");
    expect(getComputedStyle(area).marginTop).toBe("8px");
    expect(
      getComputedStyle(area.querySelector<HTMLElement>(".section-heading")!)
        .marginBottom,
    ).toBe("16px");
    expect(getComputedStyle(cards).gap).toBe("12px");
    expect(getComputedStyle(hints[0]).marginTop).toBe("14px");
    expect(getComputedStyle(hints[1]).marginTop).toBe("8px");
    expect(
      getComputedStyle(area.nextElementSibling as HTMLElement).marginTop,
    ).toBe("8px");
    expect(
      getComputedStyle(cards.querySelector<HTMLElement>(".stage-card")!)
        .padding,
    ).toBe("12px");
    expect(
      getComputedStyle(cards.querySelector<HTMLElement>("strong")!).fontSize,
    ).toBe("12px");
    const other = screen.getByTestId("other-stage-grid");
    expect(getComputedStyle(other).gap).toBe("8px");
    expect(getComputedStyle(other).marginTop).toBe("-13px");
    expect(api.launch).not.toHaveBeenCalled();
  } finally {
    style.remove();
  }
});

for (const context of [undefined, owner]) {
  it.each(cases)(
    `${context ? "clone" : "primary"}: changing %s loads only stages and retains task through a late preview`,
    async (label, value) => {
      rejectComposition = false;
      render(form(context));
      await waitFor(() => expect(launchButton().disabled).toBe(false));
      const task = screen.getByRole("textbox", { name: "Что нужно сделать?" });
      fireEvent.change(task, { target: { value: "Draft must stay visible" } });
      const checking = heldPreview();
      api.preview.mockReturnValueOnce(checking.promise);
      selectCatalog(screen.getByRole("combobox", { name: label }), value);
      await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
      expect(screen.getByRole("textbox", { name: "Что нужно сделать?" })).toBe(
        task,
      );
      expect(screen.getByRole("combobox", { name: label })).toBeTruthy();
      expect(
        screen.queryByRole("status", {
          name: "Загружаем параметры конвейера…",
        }),
      ).toBeNull();
      expect(
        within(
          screen.getByRole("region", { name: "Стадии запуска" }),
        ).getByRole("status", { name: "Загружаем стадии конвейера…" }),
      ).toBeTruthy();
      expect(launchButton().disabled).toBe(true);
      fireEvent.change(task, { target: { value: "Edited while stages load" } });
      await act(async () =>
        checking.resolve({ ...preview, token: "changed-composition" }),
      );
      await waitFor(() => expect(launchButton().disabled).toBe(false));
      expect(task).toHaveProperty("value", "Edited while stages load");
      expect(api.discover).toHaveBeenCalledTimes(1);
      expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    },
  );
}
