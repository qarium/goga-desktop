import "./helpers/overview-browser-fixture";
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { BuildForm } from "../src/renderer/BuildForm";
import { App } from "../src/renderer/App";
let api: any;
let emitRuns: (runs: any[]) => void;
const context = {
  revision: "r",
  branch: "main",
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
  branches: ["main"],
  workflows: ["quality"],
  profiles: [{ name: "fast", source: "project" }],
  historyPlan: { path: "plan.md" },
};
const run = {
  id: "b",
  kind: "build",
  projectId: "p",
  pipeline: "Сборка",
  topic: "topic",
  branch: "main",
  status: "exited",
  startedAt: "now",
  workflow: null,
  profile: null,
  build: { planPath: "old.md", clean: false },
  output: { text: "Finished fixture", truncated: false },
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Alpha", path: "/fixture/a" },
      { id: "q", name: "Beta", path: "/fixture/b" },
    ]),
    runs: vi.fn(async () => [run]),
    selectRun: vi.fn(async () => {}),
    onRuns: (cb: typeof emitRuns) => {
      emitRuns = cb;
      return () => {};
    },
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    readTopicBoard: vi.fn(async (projectId) => ({
      projectId,
      year: "2026",
      revision: "v",
      currentBranch: "main",
      currentTopic: null,
      baseRef: "main",
      branches: ["main"],
      dirty: false,
      active: false,
      entries: [],
      records: [],
      remoteEntries: [],
      remoteRecords: [],
    })),
    buildContext: vi.fn(async () => structuredClone(context)),
    readBuildPlan: vi.fn(async (_p, path) => ({
      path,
      text: "# Plan",
      version: "v",
    })),
    discover: vi.fn(async () => ({
      pipelines: [{ id: "verify", name: "Verify" }],
      topics: [{ topic: "main", branch: "main", remote: false }],
      currentBranch: "main",
      workflows: [],
      profiles: [],
      branches: ["main"],
    })),
    preview: vi.fn(async () => ({
      token: "v",
      stages: [{ id: "one", title: "One" }],
      profile: null,
      workflow: null,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "task",
      exists: true,
      version: "v",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    cancelRead: vi.fn(async () => {}),
    launchBuild: vi.fn(async () => ({ ...run, id: "new", status: "running" })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const contextB = {
  projectId: "p",
  year: "2026",
  topic: "feature",
  branch: "feature",
  contextId: "ctx-" + "b".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "a".repeat(64),
  projectPath: "/fixture/a",
  gitCommonDir: "/fixture/a/.git",
  path: "/fixture/home/.goga/desktop/worktrees/feature",
  ownership: "managed",
  storageKind: "linked",
  compatibility: "legacy-linked",
  state: "ready",
};
async function mountContexts(extraRuns: any[] = []) {
  api.ensureTopicContext = vi.fn(async () => contextB);
  api.listTopicContexts = vi.fn(async () => [contextB]);
  api.resolveTopicContext = vi.fn(async () => contextB);
  api.closeRun = vi.fn(async () => true);
  api.stopRun = vi.fn(async () => {});
  api.launch = vi.fn();
  api.readTopicBoard.mockResolvedValue({
    projectId: "p",
    year: "2026",
    revision: "v",
    currentBranch: "main",
    currentTopic: { topic: "main", branch: "main", remote: false },
    baseRef: "main",
    branches: ["main", "feature"],
    dirty: false,
    active: false,
    entries: [
      {
        topic: "main",
        branch: "main",
        remote: false,
        hosts: ["main"],
        statuses: [],
        todo: "",
      },
      {
        topic: "feature",
        branch: "feature",
        remote: false,
        hosts: ["feature"],
        statuses: [],
        todo: "",
      },
    ],
    records: [],
    remoteEntries: [],
    remoteRecords: [],
  });
  api.runs.mockResolvedValue([
    run,
    ...extraRuns,
    {
      ...run,
      id: "ctx-run",
      kind: "pipeline",
      pipeline: "verify",
      topic: "feature",
      branch: "feature",
      context: contextB,
      pipelineDescription: "Actual description",
      status: "running",
    },
  ]);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByLabelText("Исполняемый файл");
  await screen.findByRole("button", { name: "Выбрать другой топик" });
}
async function chooseFeature() {
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^feature / }));
  await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
  await screen.findByRole("button", {
    name: "Открыть карточку топика feature",
  });
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
}
it("explicit run list after topic selection does not open an arbitrary first run", async () => {
  await mountContexts();
  expect(screen.queryByRole("tab", { name: /verify/ })).toBeNull();
  await chooseFeature();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("region", { name: "Совместимость рабочей копии" }),
  ).toBeTruthy();
  expect(screen.getByText("Actual description")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /verify/ })).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.launchBuild).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(
    within(screen.getByRole("menu")).getByText(
      /Прежняя linked-worktree копия доступна только для просмотра/,
    ),
  ).toBeTruthy();
  expect(api.launch).not.toHaveBeenCalled();
});
it("context run tabs open explicitly and closing never calls host close/stop", async () => {
  await mountContexts();
  await chooseFeature();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск verify" }),
  );
  expect(screen.getByRole("tab", { name: /verify/ })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: /Закрыть вкладку verify/ }),
  );
  expect(screen.queryByRole("tab", { name: /verify/ })).toBeNull();
  expect(api.closeRun).not.toHaveBeenCalled();
  expect(api.stopRun).not.toHaveBeenCalled();
  expect(
    screen.getByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeTruthy();
});
it("a vanished contextual run returns to its list without silently selecting a legacy sibling", async () => {
  await mountContexts();
  await chooseFeature();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск verify" }),
  );
  await act(async () => emitRuns([run]));
  expect(
    screen.getByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeTruthy();
  expect(screen.queryByText("Повторить сборку")).toBeNull();
});
it("contextual build history cannot repeat through the legacy primary-cwd API", async () => {
  await mountContexts([
    {
      ...run,
      id: "ctx-build",
      topic: "feature",
      branch: "feature",
      context: contextB,
      build: { planPath: "docs/plan.md", clean: false },
    },
  ]);
  await chooseFeature();
  fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск docs/plan.md" }),
  );
  const repeat = screen.getByRole<HTMLButtonElement>("button", {
    name: "Повторить сборку",
  });
  expect(repeat.disabled).toBe(true);
  fireEvent.click(repeat);
  expect(api.launchBuild).not.toHaveBeenCalled();
});

it("a catalog error stays in topic selection and can be retried without blocking Without topic", async () => {
  api.readTopicBoard.mockRejectedValueOnce(Error("Доска временно недоступна"));
  await mountContexts();
  expect(screen.queryByText("Доска временно недоступна")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  const picker = screen.getByRole("region", { name: "Выбор топика" });
  expect(
    await within(picker).findByText("Доска временно недоступна"),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить загрузку топиков" }),
  );
  await waitFor(() =>
    expect(screen.queryByText("Доска временно недоступна")).toBeNull(),
  );
});
it("closing a background contextual tab preserves the current project page", async () => {
  await mountContexts();
  await chooseFeature();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть запуск verify" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await screen.findByRole("region", { name: "Контекст недоступен" });
  fireEvent.click(
    screen.getByRole("button", { name: /Закрыть вкладку verify/ }),
  );
  expect(
    screen.getByRole("region", { name: "Контекст недоступен" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeNull();
});

it("keeps completed pipeline output and exposes catalog retry only inside topic selection", async () => {
  const pipeline = {
    ...run,
    kind: "pipeline",
    pipeline: "refinement",
    status: "running",
  };
  api.runs.mockResolvedValue([pipeline]);
  render(<App />);
  await screen.findByRole("button", { name: /Alpha/ });
  await waitFor(() => expect(api.readTopicBoard).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть запуск refinement" }),
  );
  const reason =
    "Данные проекта меняются во время загрузки топиков. Повторите загрузку через несколько секунд.";
  api.readTopicBoard.mockRejectedValueOnce(
    new Error(
      `Error invoking remote method 'goga:read-request': Error: ${reason}`,
    ),
  );
  await act(async () => emitRuns([{ ...pipeline, status: "exited" }]));
  expect(screen.queryByText(reason)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  const alert = await within(
    screen.getByRole("region", { name: "Выбор топика" }),
  ).findByRole("alert");
  expect(alert.textContent).toBe(reason);
  expect(
    screen.getByRole("heading", { name: "Процесс завершён" }),
  ).toBeTruthy();
  expect(screen.getByText("Finished fixture")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить загрузку топиков" }),
  );
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByText("Finished fixture")).toBeTruthy();
  expect(api.launchBuild).not.toHaveBeenCalled();
});

it("does not leak catalog errors into the dashboard or sidebar while a pipeline is visible", async () => {
  const pipeline = {
    ...run,
    kind: "pipeline",
    pipeline: "refinement",
    status: "running",
    url: "http://127.0.0.1:8000",
  };
  api.runs.mockResolvedValue([pipeline]);
  api.readTopicBoard.mockRejectedValue(new Error("Catalog unavailable"));
  render(<App />);
  await screen.findByRole("button", { name: /Alpha/ });
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть запуск refinement" }),
  );
  await waitFor(() =>
    expect(api.selectRun).toHaveBeenLastCalledWith(pipeline.id),
  );
  expect(screen.queryByText("Catalog unavailable")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Повторить загрузку топиков" }),
  ).toBeNull();
  expect(document.querySelector(".main-area .context-board-error")).toBeNull();
});

it("keeps identity separate from context controls on the same header", async () => {
  render(<App />);
  const title = await screen.findByRole("heading", { name: "Alpha" });
  const heading = title.closest(".project-heading");
  expect(heading).not.toBeNull();
  const row = heading!.nextElementSibling!;
  expect(row).not.toBeNull();
  expect(heading!.querySelector(":scope > .eyebrow")?.textContent).toContain(
    "Мой компьютер / ПРОЕКТ",
  );
  expect(row.querySelector(".topic-context-picker")?.parentElement).toBe(row);
  expect(title.parentElement).toBe(heading);
  expect(row.classList.contains("project-heading-context")).toBe(true);
});

it("collapses only sidebar while retaining the selected workspace", async () => {
  render(<App />);
  const toggle = await screen.findByRole("button", {
    name: "Свернуть боковую панель",
  });
  expect(toggle.closest(".sidebar-footer")).not.toBeNull();
  const main = document.querySelector(".main-area");
  fireEvent.click(toggle);
  expect(
    document
      .querySelector(".app-shell")
      ?.classList.contains("sidebar-collapsed"),
  ).toBe(true);
  expect(document.querySelector(".main-area")).toBe(main);
  const expand = screen.getByRole("button", {
    name: "Развернуть боковую панель",
  });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(expand);
  expect(
    document
      .querySelector(".app-shell")
      ?.classList.contains("sidebar-collapsed"),
  ).toBe(false);
});

it("shows project name and full path on hover and focus in the collapsed sidebar", async () => {
  render(<App />);
  const project = await screen.findByRole("button", { name: "Alpha" });
  fireEvent.click(
    screen.getByRole("button", { name: "Свернуть боковую панель" }),
  );
  fireEvent.mouseEnter(project);
  expect(screen.getByRole("tooltip").textContent).toContain("Alpha");
  expect(screen.getByRole("tooltip").textContent).toContain("/fixture/a");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.focus(project);
  expect(screen.getByRole("tooltip").textContent).toContain("Alpha");
  fireEvent.blur(project);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("dismisses a dashboard presentation failure without reopening it in a loop", async () => {
  const pipeline = {
    ...run,
    kind: "pipeline",
    pipeline: "refinement",
    status: "running",
    url: "http://127.0.0.1:8000",
  };
  api.runs.mockResolvedValue([pipeline]);
  api.selectRun.mockImplementation(async (id: string | null) => {
    if (id) throw Error("Synthetic native view failure");
  });
  render(<App />);
  await screen.findByRole("button", { name: /Alpha/ });
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть запуск refinement" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Не удалось выполнить операцию",
  });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Закрыть сообщение" }),
  );
  await act(async () => {});
  expect(
    screen.queryByRole("dialog", { name: "Не удалось выполнить операцию" }),
  ).toBeNull();
  expect(
    api.selectRun.mock.calls.filter(
      ([id]: [string | null]) => id === pipeline.id,
    ),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  expect(await screen.findByRole("heading", { name: "Проект" })).toBeTruthy();
});
it.each([false, true])(
  "opens Changes for verified handoff only in the still-current project (switched=%s)",
  async (switched) => {
    const handoff = {
      candidateId: "a".repeat(64),
      scope: "p",
      root: "/fixture/a",
      targetBranch: "main",
      targetHead: "b".repeat(40),
      sourceRef: "refs/source",
      sourceOid: "c".repeat(40),
      baseRef: "base",
      strategy: "merge",
      algorithm: "merge",
      conflicts: ["file.txt"],
      expiresAt: Date.now() + 300000,
    };
    let finish!: (value: any) => void;
    api.runRepositoryAction = vi.fn(async (request: any) => ({
      ...request,
      status: "error",
      log: "original conflict log",
      handoff,
    }));
    api.readGitWorkspace = vi.fn(async (scope: string) => ({
      scope,
      root: scope === "p" ? "/fixture/a" : "/fixture/b",
      branch: "main",
      head: "b".repeat(40),
      revision: "e".repeat(64),
      operation: "none",
      files: [],
      upstream: null,
      ahead: 0,
      behind: 0,
    }));
    api.prepareGitUpdateHandoff = vi.fn(async () => ({
      candidate: handoff,
      token: "d".repeat(64),
      expiresAt: handoff.expiresAt,
      hooks: "disabled",
      publishes: false,
      effects: "Changes files",
    }));
    api.executeGitUpdateHandoff = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Синхронизировать текущую ветку",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Разрешить конфликт вручную…",
      }),
    );
    const confirmation = await screen.findByRole("button", {
      name: "Подтвердить переход к конфликту",
    });
    expect(confirmation.ownerDocument).toBe(document);
    expect(api.executeGitUpdateHandoff).not.toHaveBeenCalled();
    fireEvent.click(confirmation);
    if (switched) {
      fireEvent.click(screen.getByRole("button", { name: "Beta" }));
      await screen.findByRole("heading", { name: "Beta" });
    }
    await act(async () =>
      finish({
        scope: "p",
        root: "/fixture/a",
        algorithm: "merge",
        status: "conflict",
        changed: true,
        conflicts: ["file.txt"],
        message: "ready",
        log: "verified",
      }),
    );
    if (switched)
      expect(screen.queryByRole("heading", { name: "Изменения" })).toBeNull();
    else
      expect(
        await screen.findByRole("heading", { name: "Изменения" }),
      ).toBeTruthy();
  },
);
