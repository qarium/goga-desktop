import { selectCatalog } from "./helpers/select-catalog";
// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
  act,
} from "@testing-library/react";
import { BuildForm } from "../src/renderer/BuildForm";
const project = { id: "p", name: "Alpha", path: "/project" };
const context = {
  revision: "r",
  branch: "feature/a",
  capabilities: [
    "workflow",
    "profile",
    "session-timeout",
    "idle-timeout",
    "wait",
    "max-iterations",
    "review-patience",
    "base-ref",
    "env",
    "add-host",
    "proxy",
    "clean",
    "update",
    "skip-review",
    "no-skip-review",
    "skip-manifest-check",
  ],
  defaults: { skipReview: false, profile: "" },
  branches: ["main", "origin/dev"],
  workflows: ["quality"],
  profiles: [{ name: "fast", source: "project" }],
  historyPlan: { path: ".goga/history/2026/feature-a/plan.md" },
};
let api: any, launched: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  launched = vi.fn();
  api = {
    buildContext: vi.fn(async () => structuredClone(context)),
    readBuildPlan: vi.fn(async (_p, path) => ({
      path,
      text: "# Plan\nDo work",
      version: "v",
    })),
    listBuildFiles: vi.fn(async (_p, d) => ({
      directory: d,
      entries: d
        ? [{ name: "plan.md", path: "docs/plan.md", directory: false }]
        : [{ name: "docs", path: "docs", directory: true }],
    })),
    launchBuild: vi.fn(async (r) => ({
      id: "build",
      kind: "build",
      projectId: r.projectId,
      status: "running",
      build: { planPath: r.planPath, clean: r.options.clean },
      output: { text: "started", truncated: false },
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
function mount(props = {}) {
  return render(
    <BuildForm
      project={project}
      onLaunched={launched}
      onCancel={() => {}}
      {...props}
    />,
  );
}
it("searches shared build catalogs by label and submits their exact values", async () => {
  mount();
  await screen.findByText("План доступен");
  const workflow = screen.getByRole("combobox", { name: "Рабочий процесс" });
  expect(workflow.tagName).toBe("BUTTON");
  expect(workflow.textContent).toContain("Из конфигурации");
  const profile = screen.getByRole("combobox", { name: "Профиль" });
  expect((profile as HTMLButtonElement).value).toBe("__project__");
  expect(profile.textContent).toContain("Из настроек проекта");
  fireEvent.click(workflow);
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Поиск рабочего процесса" }),
    {
      target: { value: "QUALITY" },
    },
  );
  fireEvent.click(screen.getByRole("option", { name: "quality" }));
  await waitFor(() =>
    expect(api.buildContext).toHaveBeenLastCalledWith("p", {
      workflow: "quality",
      profile: undefined,
      env: [],
    }),
  );
  await screen.findByText("План доступен");
  fireEvent.click(screen.getByRole("combobox", { name: "Профиль" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Поиск профиля" }), {
    target: { value: "fast" },
  });
  fireEvent.click(screen.getByRole("option", { name: "fast" }));
  await waitFor(() =>
    expect(api.buildContext).toHaveBeenLastCalledWith("p", {
      workflow: "quality",
      profile: "fast",
      env: [],
    }),
  );
  await screen.findByText("План доступен");
  fireEvent.click(
    screen.getByRole("combobox", { name: "База сравнения", hidden: true }),
  );
  fireEvent.change(
    screen.getByRole("searchbox", {
      name: "Поиск базы сравнения",
      hidden: true,
    }),
    {
      target: { value: "ORIGIN" },
    },
  );
  fireEvent.click(
    screen.getByRole("option", { name: "origin/dev", hidden: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalledTimes(1));
  expect(api.launchBuild.mock.calls[0][0]).toMatchObject({
    options: { workflow: "quality", profile: "fast", baseRef: "origin/dev" },
  });
});
it("loads history plan, uses review switch and keeps clean always visible; plain launch has no update or dry-run", async () => {
  mount();
  await screen.findByDisplayValue(context.historyPlan.path);
  await screen.findByText("План доступен");
  expect(
    screen
      .getByRole("switch", { name: "Пропустить ревью" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    screen
      .getByLabelText("Очистить состояние предыдущей сборки")
      .closest("details"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalledTimes(1));
  expect(api.launchBuild.mock.calls[0][0]).toMatchObject({
    expectedBranch: "feature/a",
    planVersion: "v",
    options: { update: false, clean: false, skipManifestCheck: false },
  });
  expect(api.launchBuild.mock.calls[0][0].options).not.toHaveProperty(
    "skipReview",
  );
  expect(JSON.stringify(api.launchBuild.mock.calls)).not.toContain("dryRun");
});
it("confirms clean before any side effects and supports explicit image update", async () => {
  mount();
  await screen.findByText("План доступен");
  fireEvent.click(
    screen.getByLabelText("Очистить состояние предыдущей сборки"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Варианты запуска" }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Запустить с обновлением образа" }),
  );
  expect(api.launchBuild).not.toHaveBeenCalled();
  fireEvent.click(
    await screen.findByRole("button", { name: "Очистить и запустить" }),
  );
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalled());
  expect(api.launchBuild.mock.calls[0][0]).toMatchObject({
    confirmClean: true,
    options: { clean: true, update: true },
  });
});
it("project chooser starts root; cancellation preserves previous plan and selected file gets validated", async () => {
  mount();
  await screen.findByText("План доступен");
  fireEvent.click(screen.getByRole("button", { name: "Выбрать файл…" }));
  await screen.findByRole("button", { name: "Открыть папку docs" });
  expect(api.listBuildFiles).toHaveBeenCalledWith("p", "");
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Отмена" }),
  );
  expect((screen.getByLabelText("План сборки") as HTMLInputElement).value).toBe(
    context.historyPlan.path,
  );
  fireEvent.click(screen.getByRole("button", { name: "Выбрать файл…" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть папку docs" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Выбрать plan.md" }),
  );
  await waitFor(() =>
    expect(api.readBuildPlan).toHaveBeenCalledWith("p", "docs/plan.md"),
  );
});
it("keeps review drafts while skipped but excludes them from request, then restores on toggle", async () => {
  mount();
  await screen.findByText("План доступен");
  selectCatalog(screen.getByLabelText("База сравнения"), "origin/dev");
  fireEvent.change(screen.getByLabelText("Повторные раунды без изменений"), {
    target: { value: "3" },
  });
  fireEvent.click(screen.getByRole("switch", { name: "Пропустить ревью" }));
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalled());
  const o = api.launchBuild.mock.calls[0][0].options;
  expect(o.skipReview).toBe(true);
  expect(o).not.toHaveProperty("baseRef");
  expect(o).not.toHaveProperty("reviewPatience");
});
it("shows unavailable plan errors without creating a file or launching", async () => {
  api.readBuildPlan.mockRejectedValue(new Error("[build-plan:missing]"));
  mount();
  expect(
    await screen.findByText(
      "План для текущего топика ещё не создан. Выберите другой файл.",
    ),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "../outside.md" },
  });
  await waitFor(() =>
    expect(api.readBuildPlan).toHaveBeenCalledWith("p", "../outside.md"),
  );
  expect(api.launchBuild).not.toHaveBeenCalled();
});
it("ignores stale context after switching project", async () => {
  let done: any;
  api.buildContext.mockImplementationOnce(() => new Promise((r) => (done = r)));
  const v = mount();
  await waitFor(() => expect(api.buildContext).toHaveBeenCalledTimes(1));
  v.rerender(
    <BuildForm
      key="q"
      project={{ ...project, id: "q" }}
      onLaunched={launched}
      onCancel={() => {}}
    />,
  );
  await screen.findByText("План доступен");
  await act(async () =>
    done({ ...context, historyPlan: { path: "old-project.md" } }),
  );
  expect(screen.queryByDisplayValue("old-project.md")).toBeNull();
});
it("does not silently ignore a project profile on older CLI", async () => {
  api.buildContext.mockResolvedValue({
    ...context,
    capabilities: context.capabilities.filter(
      (x: string) => !["workflow", "profile"].includes(x),
    ),
    defaults: { skipReview: true, profile: "fast" },
  });
  mount();
  await screen.findByText("План доступен");
  expect(
    screen
      .getByRole("switch", { name: "Пропустить ревью" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  const workflow = screen.getByRole("combobox", { name: "Рабочий процесс" });
  fireEvent.click(workflow);
  const unsupportedWorkflow = screen.getByRole("option", {
    name: "quality",
  }) as HTMLButtonElement;
  expect(unsupportedWorkflow.disabled).toBe(true);
  fireEvent.click(unsupportedWorkflow);
  expect((workflow as HTMLButtonElement).value).toBe("");
  fireEvent.keyDown(
    screen.getByRole("searchbox", { name: "Поиск рабочего процесса" }),
    { key: "Escape" },
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Профиль" }));
  const unsupportedProfile = screen.getByRole("option", {
    name: "fast",
  }) as HTMLButtonElement;
  expect(unsupportedProfile.disabled).toBe(true);
  fireEvent.click(unsupportedProfile);
  expect((screen.getByLabelText("Профиль") as HTMLButtonElement).value).toBe(
    "__project__",
  );
  selectCatalog(screen.getByLabelText("Профиль"), "");
  api.buildContext.mockResolvedValue({
    ...context,
    capabilities: context.capabilities.filter(
      (x: string) => !["workflow", "profile"].includes(x),
    ),
    defaults: { skipReview: true, profile: "" },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Пропустить ревью" }));
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalled());
  expect(api.launchBuild.mock.calls[0][0].options).toMatchObject({
    profile: "",
    skipReview: false,
  });
});
it("rejects multiline secret paste without browser sanitation or leaking bytes, blocks launch until correction", async () => {
  mount();
  await screen.findByText("План доступен");
  fireEvent.click(
    screen.getByText("Окружение", { exact: false }).closest("summary")!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Добавить переменную" }));
  fireEvent.change(screen.getByLabelText("Имя переменной 1"), {
    target: { value: "TOKEN" },
  });
  fireEvent.change(screen.getByLabelText("Значение переменной 1"), {
    target: { value: "keep" },
  });
  const input = screen.getByLabelText(
    "Значение переменной 1",
  ) as HTMLInputElement;
  fireEvent.paste(input, {
    clipboardData: { getData: () => "secret-a\nsecret-b" },
  });
  expect(input.value).toBe("keep");
  expect((await screen.findByRole("alert")).textContent).not.toContain(
    "secret-a",
  );
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "fixed" } });
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
it("invalid numeric and host values never cross launch IPC", async () => {
  mount();
  await screen.findByText("План доступен");
  fireEvent.change(screen.getByLabelText("Максимальное число итераций"), {
    target: { value: "1.5" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(api.launchBuild).not.toHaveBeenCalled();
});
it("retains per-project drafts and ignores a late plan response", async () => {
  const drafts = new Map();
  let resolve: any;
  api.readBuildPlan.mockImplementationOnce(
    () => new Promise((r) => (resolve = r)),
  );
  const v = mount({ drafts });
  await screen.findByDisplayValue(context.historyPlan.path);
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "chosen.md" },
  });
  await screen.findByText("План доступен");
  await act(async () =>
    resolve({ path: "stale.md", text: "stale", version: "old" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Посмотреть план" }));
  expect(screen.getByText("chosen.md")).toBeTruthy();
  expect(screen.queryByText("stale")).toBeNull();
  v.unmount();
  mount({ drafts });
  expect(await screen.findByDisplayValue("chosen.md")).toBeTruthy();
});
it("recomputes the context revision and effective review when runtime environment changes", async () => {
  api.buildContext.mockImplementation(async (_id: string, selection: any) => ({
    ...context,
    revision: selection?.env?.length ? "with-env" : "r",
    defaults: {
      skipReview:
        selection?.env?.some((e: any) => e.key === "GOGA_WORKFLOW") ?? false,
      profile: "",
    },
  }));
  mount();
  await screen.findByText("План доступен");
  fireEvent.click(
    screen.getByText("Окружение", { exact: false }).closest("summary")!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Добавить переменную" }));
  fireEvent.change(screen.getByLabelText("Имя переменной 1"), {
    target: { value: "GOGA_WORKFLOW" },
  });
  fireEvent.change(screen.getByLabelText("Значение переменной 1"), {
    target: { value: "quality" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("switch", { name: "Пропустить ревью" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalled());
  expect(api.launchBuild.mock.calls[0][0]).toMatchObject({
    contextRevision: "with-env",
    options: { env: [{ key: "GOGA_WORKFLOW", value: "quality" }] },
  });
});
it("rejects multiline proxy without leaking or silently changing credentials", async () => {
  mount();
  await screen.findByText("План доступен");
  fireEvent.click(
    screen.getByText("Окружение", { exact: false }).closest("summary")!,
  );
  const input = screen.getByLabelText("Прокси") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "https://valid.example" } });
  fireEvent.paste(input, {
    clipboardData: { getData: () => "https://user:sec\nret@proxy.example" },
  });
  expect(input.value).toBe("https://valid.example");
  const error = screen.getByRole("alert");
  expect(error.textContent).toMatch(/Ввод отклонён/);
  expect(error.textContent).not.toContain("sec");
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("shows one compact missing-plan state without IPC details; alternative plan recovers", async () => {
  const message =
    "План для текущего топика ещё не создан. Выберите другой файл.";
  api.buildContext.mockResolvedValue({
    ...context,
    historyPlan: { path: context.historyPlan.path, error: message },
  });
  api.readBuildPlan.mockRejectedValue(
    Error(
      "Error invoking remote method 'goga:read-build-plan': Error: [build-plan:missing]",
    ),
  );
  mount();
  await waitFor(() => expect(screen.getAllByText(message)).toHaveLength(1));
  await screen.findByRole("button", { name: "Посмотреть план" });
  expect(screen.getByText(message).getAttribute("role")).toBe("status");
  expect(document.body.textContent).not.toMatch(
    /Error invoking|read-build-plan|build-plan:|однозначно/,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Посмотреть план",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen
      .getByRole("switch", { name: "Пропустить ревью" })
      .getAttribute("aria-checked"),
  ).toBe("false");
  api.readBuildPlan.mockResolvedValue({
    path: "docs/plan.md",
    text: "# Plan",
    version: "new",
  });
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "docs/plan.md" },
  });
  await screen.findByText("План доступен");
  expect(screen.queryByText(message)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it.each([
  ["denied", "Нет доступа"],
  ["outside", "за пределами"],
  ["read", "Не удалось прочитать"],
])("shows safe distinct %s errors", async (code, message) => {
  api.readBuildPlan.mockRejectedValue(
    Error(
      `Error invoking remote method 'goga:read-build-plan': Error: [build-plan:${code}]`,
    ),
  );
  mount();
  await screen.findByText(new RegExp(message));
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(document.body.textContent).not.toMatch(/Error invoking|build-plan:/);
});

it("explicit review override and return to effective setting preserve tri-state", async () => {
  api.buildContext.mockResolvedValue({
    ...context,
    defaults: { skipReview: true, profile: "" },
  });
  mount();
  await screen.findByText("План доступен");
  const toggle = screen.getByRole("switch", { name: "Пропустить ревью" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(
    screen.getByRole("button", { name: "Использовать настройку проекта" }),
  );
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launchBuild).toHaveBeenCalled());
  expect(api.launchBuild.mock.calls[0][0].options).not.toHaveProperty(
    "skipReview",
  );
});
it("late rejection for the missing old plan cannot replace the selected valid plan", async () => {
  let reject!: (e: Error) => void;
  api.readBuildPlan.mockImplementationOnce(
    () => new Promise((_r, j) => (reject = j)),
  );
  mount();
  await waitFor(() => expect(api.readBuildPlan).toHaveBeenCalled());
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "docs/plan.md" },
  });
  await screen.findByText("План доступен");
  await act(async () => reject(Error("[build-plan:missing]")));
  expect(screen.queryByText(/ещё не создан/)).toBeNull();
  expect(screen.getByText("План доступен")).toBeTruthy();
});
it("does not display Electron transport details on context CLI failure", async () => {
  api.buildContext.mockRejectedValue(
    Error(
      "Error invoking remote method 'goga:build-context': Error: Не удалось выполнить команду Goga. Проверьте исполняемый файл.",
    ),
  );
  mount();
  await screen.findByText(
    "Не удалось выполнить команду Goga. Проверьте исполняемый файл.",
  );
  expect(document.body.textContent).not.toContain("Error invoking");
});
it("file chooser does not leak path markers or IPC wrappers on denied directory", async () => {
  api.listBuildFiles.mockRejectedValue(
    Error(
      "Error invoking remote method 'goga:list-build-files': Error: [build-plan:denied]",
    ),
  );
  mount();
  await screen.findByText("План доступен");
  fireEvent.click(screen.getByRole("button", { name: "Выбрать файл…" }));
  await screen.findByText(/Нет доступа/);
  expect(document.body.textContent).not.toMatch(/Error invoking|build-plan:/);
});
it("Назад means parent directory, not browsing history; chooser still starts at root", async () => {
  mount();
  await screen.findByText("План доступен");
  fireEvent.click(screen.getByRole("button", { name: "Выбрать файл…" }));
  await screen.findByRole("button", { name: "Открыть папку docs" });
  expect(
    (
      screen.getByRole("button", {
        name: "Назад",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "На уровень выше" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Открыть папку docs" }));
  await screen.findByRole("button", { name: "Выбрать plan.md" });
  fireEvent.click(screen.getByRole("button", { name: "Назад" }));
  await screen.findByRole("button", { name: "Открыть папку docs" });
  expect(api.listBuildFiles.mock.calls.map((c: any[]) => c[1])).toEqual([
    "",
    "docs",
    "",
  ]);
  expect(screen.getByRole("button", { name: "Корень проекта" })).toBeTruthy();
});
it("all four disclosure sections have a local spaced content region without changing field defaults", async () => {
  mount();
  await screen.findByText("План доступен");
  const groups = [...document.querySelectorAll(".build-group")];
  expect(groups).toHaveLength(4);
  for (const group of groups)
    expect(
      group.querySelector(":scope > summary + .build-group-body"),
    ).toBeTruthy();
  expect(
    document.querySelectorAll(".build-environment > .build-environment-block"),
  ).toHaveLength(2);
  expect(
    (
      screen.getByLabelText(
        "Разрешить сборку с незакоммиченными контрактами",
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(
    screen
      .getByRole("switch", { name: "Пропустить ревью" })
      .getAttribute("aria-checked"),
  ).toBe("false");
});
const missingLaunchText = "План не найден. Выберите файл плана";
it("shows the shared compact lock before disabled launch controls and removes it after valid plan read", async () => {
  api.readBuildPlan.mockRejectedValue(Error("[build-plan:missing]"));
  mount();
  const reason = (await screen.findByText(missingLaunchText)).closest(
    ".build-launch-reason",
  )!;
  const footer = document.querySelector(".build-footer")!;
  expect(footer.contains(reason)).toBe(true);
  expect(reason.classList.contains("action-reason")).toBe(true);
  expect(reason.classList.contains("topic-action-reason")).toBe(false);
  expect(reason.querySelector("details, [hidden], .sr-only")).toBeNull();
  expect(reason.nextElementSibling?.classList.contains("split-launch")).toBe(
    true,
  );
  expect(reason.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(reason.querySelector("svg")?.getAttribute("focusable")).toBe("false");
  for (const name of ["Запустить", "Варианты запуска"]) {
    const button = screen.getByRole("button", { name });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
  }
  expect(
    screen.getByText(
      "План для текущего топика ещё не создан. Выберите другой файл.",
    ),
  ).toBeTruthy();
  api.readBuildPlan.mockResolvedValue({
    path: "docs/plan.md",
    text: "# Plan",
    version: "new",
  });
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "docs/plan.md" },
  });
  await screen.findByText("План доступен");
  expect(screen.queryByText(missingLaunchText)).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Запустить" })
      .getAttribute("aria-describedby"),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Варианты запуска" }));
  expect(
    screen.getByRole("menuitem", { name: "Запустить с обновлением образа" }),
  ).toBeTruthy();
  expect(api.launchBuild).not.toHaveBeenCalled();
});
it.each(["denied", "outside", "invalid", "format", "changed", "read"])(
  "does not call %s plan errors a missing file",
  async (code) => {
    api.readBuildPlan.mockRejectedValue(Error(`[build-plan:${code}]`));
    mount();
    await screen.findByRole("alert");
    expect(screen.queryByText(missingLaunchText)).toBeNull();
  },
);
it("does not infer missing from error wording without a typed missing result", async () => {
  api.readBuildPlan.mockRejectedValue(Error("Файл плана не найден"));
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByText(missingLaunchText)).toBeNull();
});
it("waits for confirmed absence and hides the reason while the replacement plan is loading", async () => {
  let reject!: (e: Error) => void, resolve!: (p: unknown) => void;
  api.buildContext.mockResolvedValue({
    ...context,
    historyPlan: {
      ...context.historyPlan,
      error: "План для текущего топика ещё не создан. Выберите другой файл.",
    },
  });
  api.readBuildPlan.mockImplementationOnce(
    () => new Promise((_r, j) => (reject = j)),
  );
  mount();
  await screen.findByText("Проверяем план…");
  expect(screen.queryByText(missingLaunchText)).toBeNull();
  await act(async () => reject(Error("[build-plan:missing]")));
  await screen.findByText(missingLaunchText);
  api.readBuildPlan.mockImplementationOnce(
    () => new Promise((r) => (resolve = r)),
  );
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "new.md" },
  });
  await screen.findByText("Проверяем план…");
  expect(screen.queryByText(missingLaunchText)).toBeNull();
  await act(async () =>
    resolve({ path: "new.md", text: "plan", version: "v2" }),
  );
  await screen.findByText("План доступен");
  expect(screen.queryByText(missingLaunchText)).toBeNull();
});
it("ignores stale missing responses after selecting a valid plan", async () => {
  let reject!: (e: Error) => void;
  api.readBuildPlan.mockImplementationOnce(
    () => new Promise((_r, j) => (reject = j)),
  );
  mount();
  await screen.findByText("Проверяем план…");
  fireEvent.change(screen.getByLabelText("План сборки"), {
    target: { value: "new.md" },
  });
  await screen.findByText("План доступен");
  await act(async () => reject(Error("[build-plan:missing]")));
  expect(screen.queryByText(missingLaunchText)).toBeNull();
});
it.each(["cli", "history", "review", "profile", "running"])(
  "does not mislabel a %s blocker as a missing plan",
  async (kind) => {
    if (kind === "cli")
      api.buildContext.mockRejectedValue(Error("CLI unavailable"));
    else if (kind === "history")
      api.buildContext.mockResolvedValue({
        ...context,
        historyPlan: {
          path: "",
          error: "Не удалось получить путь плана из Goga.",
        },
      });
    else if (kind === "review")
      api.buildContext.mockResolvedValue({
        ...context,
        defaults: {
          ...context.defaults,
          reviewError: "Не удалось прочитать настройку ревью",
        },
      });
    else if (kind === "profile")
      api.buildContext.mockResolvedValue({
        ...context,
        capabilities: [],
        defaults: { skipReview: false, profile: "fast" },
      });
    api.readBuildPlan.mockRejectedValue(Error("[build-plan:missing]"));
    mount({ blocked: kind === "running" });
    await waitFor(() => expect(api.buildContext).toHaveBeenCalled());
    await waitFor(() =>
      expect(document.querySelector('[aria-busy="true"]')).toBeNull(),
    );
    expect(screen.queryByText(missingLaunchText)).toBeNull();
  },
);
it("clears the old project's missing reason when the new project's read is pending", async () => {
  api.readBuildPlan.mockRejectedValue(Error("[build-plan:missing]"));
  const view = mount();
  await screen.findByText(missingLaunchText);
  api.readBuildPlan.mockImplementation(() => new Promise(() => {}));
  view.rerender(
    <BuildForm
      project={{ ...project, id: "other" }}
      onLaunched={launched}
      onCancel={() => {}}
    />,
  );
  await screen.findByText("Проверяем план…");
  expect(screen.queryByText(missingLaunchText)).toBeNull();
});

it("places the missing-plan reason before the launch button, retaining both descriptions", async () => {
  api.readBuildPlan.mockRejectedValue(Error("[build-plan:missing]"));
  mount();
  const reason = await screen.findByText(missingLaunchText);
  const p = reason.closest("p")!;
  const button = screen.getByRole("button", { name: "Запустить" });
  expect(
    p.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(button.getAttribute("aria-describedby")).toBe(p.id);
  expect(p.closest(".build-launch-action")).toBe(
    button.closest(".build-launch-action"),
  );
});
it("uses the same badge markup for topic-create and build-launch reasons", async () => {
  api.readBuildPlan.mockRejectedValue(Error("[build-plan:missing]"));
  mount();
  const reason = await waitFor(() => {
    const badge = document.querySelector(".build-launch-reason");
    expect(badge).not.toBeNull();
    return badge!;
  });
  expect(reason.classList.contains("action-reason")).toBe(true);
  expect(reason.querySelector(":scope > .action-reason-text")).not.toBeNull();
});
