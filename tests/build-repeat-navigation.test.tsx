// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
const owner = {
  projectId: "p",
  year: "2026",
  topic: "topic",
  branch: "topic",
  contextId: "ctx-" + "a".repeat(64),
  revision: "a6814931-f12f-4bf0-ae2f-cce2f9e47c70",
};
const record = {
  ...owner,
  storageKind: "clone",
  repositoryKey: "a".repeat(64),
  projectPath: "/synthetic/project",
  gitCommonDir: "/synthetic/project/.git",
  path: "/synthetic/clones/topic",
  ownership: "managed",
  state: "ready",
};
const run = {
  id: "old-run",
  kind: "build",
  projectId: "p",
  pipeline: "Сборка",
  topic: "topic",
  branch: "topic",
  status: "exited",
  startedAt: "2026-10-20T00:00:00.000Z",
  workflow: null,
  profile: null,
  build: {
    planPath: "recorded.md",
    clean: true,
    update: true,
    skipManifestCheck: false,
    planVersion: "old-version",
  },
  output: { text: "Synthetic old output", truncated: false },
};
let api: any;
let focusRun: (id: string) => void;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Alpha", path: "/synthetic/project" },
    ]),
    runs: vi.fn(async () => [run]),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: (callback: typeof focusRun) => {
      focusRun = callback;
      return () => {};
    },
    onViewError: () => () => {},
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    buildContext: vi.fn(async () => ({
      revision: "current",
      branch: "topic",
      capabilities: ["clean", "update", "env", "proxy"],
      defaults: { skipReview: false, profile: "" },
      branches: ["topic"],
      workflows: [],
      profiles: [],
      historyPlan: { path: "unrelated-current-plan.md" },
    })),
    readBuildPlan: vi.fn(async (_scope, path) => ({
      path,
      text: "# Synthetic plan",
      version: "current-plan",
    })),
    prepareBuildRepeat: vi.fn(async () => ({
      sourceRunId: "old-run",
      projectId: "p",
      planPath: "recorded.md",
      options: { clean: true, update: true },
      requiredEnvKeys: ["TOKEN"],
      requiresProxy: true,
      requiresReview: true,
    })),
    repeatBuild: vi.fn(async () => ({
      ...run,
      id: "new-run",
      status: "running",
    })),
    launchBuild: vi.fn(async () => ({
      ...run,
      id: "new-run",
      status: "running",
    })),
    resolveTopicContext: vi.fn(async () => record),
    listTopicContexts: vi.fn(async () => [record]),
    selectTopicContext: vi.fn(async () => {}),
  };
  window.goga = api;
});
afterEach(cleanup);
async function openRun() {
  render(<App />);
  await screen.findByLabelText("Исполняемый файл");
  await act(async () => focusRun("old-run"));
  await screen.findByText("Synthetic old output");
}
it("prepares rather than launches a repeated build and reopens a source-plan form, not a clean-launch dialog", async () => {
  await openRun();
  fireEvent.click(screen.getByRole("button", { name: "Повторить сборку" }));
  await waitFor(() =>
    expect(api.prepareBuildRepeat).toHaveBeenCalledWith("old-run"),
  );
  await screen.findByRole("region", { name: "Подготовка повторной сборки" });
  expect((screen.getByLabelText("План сборки") as HTMLInputElement).value).toBe(
    "recorded.md",
  );
  expect(
    screen.queryByRole("heading", {
      name: "Очистить состояние предыдущей сборки?",
    }),
  ).toBeNull();
  expect(api.repeatBuild).not.toHaveBeenCalled();
  expect(api.launchBuild).not.toHaveBeenCalled();
  expect(
    (
      within(screen.getByRole("region", { name: "Новая сборка" })).getByRole(
        "button",
        { name: "Запустить" },
      ) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it("binds repetition to the recorded owner, resolving without recreating a clone", async () => {
  api.prepareBuildRepeat.mockResolvedValue({
    sourceRunId: "old-run",
    projectId: "p",
    context: owner,
    planPath: "recorded.md",
    options: {},
    requiredEnvKeys: [],
    requiresProxy: false,
    requiresReview: true,
  });
  await openRun();
  api.ensureTopicContext = vi.fn(async () => record);
  fireEvent.click(screen.getByRole("button", { name: "Повторить сборку" }));
  await screen.findByRole("region", { name: "Подготовка повторной сборки" });
  expect(api.resolveTopicContext).toHaveBeenCalledWith(owner);
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.buildContext).toHaveBeenCalledWith(owner, { env: [] });
  expect(api.readBuildPlan).toHaveBeenCalledWith(owner, "recorded.md");
  expect(api.launchBuild).not.toHaveBeenCalled();
});
it("shows a preparation error without launching or opening an incomplete form", async () => {
  api.prepareBuildRepeat.mockRejectedValue(
    Error("Запись не содержит параметров повторной сборки"),
  );
  await openRun();
  fireEvent.click(screen.getByRole("button", { name: "Повторить сборку" }));
  expect(
    await screen.findByText("Запись не содержит параметров повторной сборки"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Подготовка повторной сборки" }),
  ).toBeNull();
  expect(api.repeatBuild).not.toHaveBeenCalled();
  expect(api.launchBuild).not.toHaveBeenCalled();
});

it("reconciles a recovered process only on explicit click and enables stop only after host confirmation", async () => {
  api.runs.mockResolvedValue([
    {
      ...run,
      status: "running",
      recovery: "unverified",
      recoveryMessage: "Нужно проверить владение процессом",
    },
  ]);
  api.reconcileRun = vi.fn(async () => ({
    ...run,
    status: "running",
    recovery: "confirmed",
    recoveryMessage: "Процесс принадлежит этому запуску",
  }));
  api.stopRun = vi.fn(async () => {});
  await openRun();
  expect(
    (screen.getByRole("button", { name: "Остановить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText("Нужно проверить владение процессом")).toBeTruthy();
  expect(api.reconcileRun).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Проверить состояние процесса" }),
  );
  await waitFor(() => expect(api.reconcileRun).toHaveBeenCalledWith("old-run"));
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Остановить" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  expect(screen.getByText("Процесс принадлежит этому запуску")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
  await waitFor(() => expect(api.stopRun).toHaveBeenCalledWith("old-run"));
});

it("preserves an existing build draft when a separately edited repeat is cancelled", async () => {
  api.ensureTopicContext = vi.fn(async () => record);
  api.runs.mockResolvedValue([{ ...run, context: owner }]);
  api.prepareBuildRepeat.mockResolvedValue({
    ...(await api.prepareBuildRepeat()),
    context: owner,
  });
  await openRun();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Сборка/ }));
  const settledForm = async () => {
    const form = await screen.findByRole("region", { name: "Новая сборка" });
    await waitFor(() => expect(form.getAttribute("aria-busy")).toBe("false"));
    form.querySelectorAll("details").forEach((detail) => {
      detail.open = true;
    });
    return within(form);
  };
  const original = await settledForm();
  const change = (
    form: ReturnType<typeof within>,
    label: string | RegExp,
    value: string,
  ) => fireEvent.change(form.getByLabelText(label), { target: { value } });
  change(original, "План сборки", "unsaved-original-plan.md");
  change(original, /^Максимальное время одной сессии/, "2h");
  await settledForm();
  fireEvent.click(
    original.getByRole("button", { name: "Добавить переменную" }),
  );
  change(original, "Имя переменной 1", "ORIGINAL_TOKEN");
  change(original, "Значение переменной 1", "original-secret-value");
  change(
    original,
    "Прокси",
    "https://original-user:original-pass@original-proxy.test",
  );
  await settledForm();
  fireEvent.click(screen.getByRole("tab", { name: /Сборка/ }));
  fireEvent.click(screen.getByRole("button", { name: "Повторить сборку" }));
  await screen.findByRole("region", { name: "Подготовка повторной сборки" });
  const repeat = await settledForm();
  change(repeat, "План сборки", "separate-repeat-plan.md");
  change(repeat, "Значение переменной 1", "repeat-secret-value");
  change(repeat, "Прокси", "https://repeat-proxy.test");
  await settledForm();
  // Returning to the old draft must not discard either preparation.
  fireEvent.click(screen.getByRole("tab", { name: "Новая сборка · topic" }));
  const unchanged = await settledForm();
  expect(
    (unchanged.getByLabelText("План сборки") as HTMLInputElement).value,
  ).toBe("unsaved-original-plan.md");
  fireEvent.click(screen.getByRole("tab", { name: /^Повтор сборки/ }));
  const resumedRepeat = await settledForm();
  expect(
    (resumedRepeat.getByLabelText("План сборки") as HTMLInputElement).value,
  ).toBe("separate-repeat-plan.md");
  expect(
    (resumedRepeat.getByLabelText("Значение переменной 1") as HTMLInputElement)
      .value,
  ).toBe("repeat-secret-value");
  fireEvent.click(resumedRepeat.getByRole("button", { name: "Отмена" }));
  fireEvent.click(screen.getByRole("tab", { name: "Новая сборка · topic" }));
  const restored = await settledForm();
  for (const [label, expected] of [
    ["План сборки", "unsaved-original-plan.md"],
    [/^Максимальное время одной сессии/, "2h"],
    ["Имя переменной 1", "ORIGINAL_TOKEN"],
    ["Значение переменной 1", "original-secret-value"],
    ["Прокси", "https://original-user:original-pass@original-proxy.test"],
  ] as const)
    expect((restored.getByLabelText(label) as HTMLInputElement).value).toBe(
      expected,
    );
  expect(api.launchBuild).not.toHaveBeenCalled();
  expect(api.repeatBuild).not.toHaveBeenCalled();
});
