import { useViewActive } from "../src/renderer/RetainedViews";
// @vitest-environment jsdom
import React, { useState } from "react";
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
import { App } from "../src/renderer/App";
vi.mock("../src/renderer/ProjectSettings", () => ({
  ProjectSettings: ({ owner, project }: any) => {
    const [mountedOwner] = useState(owner?.contextId ?? project.id);
    return (
      <div
        data-testid={useViewActive() ? "settings" : "retained-settings"}
        data-owner={JSON.stringify(owner ?? null)}
        data-mounted-owner={mountedOwner}
      >
        Settings owner
      </div>
    );
  },
  ProjectSettingsConfirmation: () => null,
}));
vi.mock("../src/renderer/TerminalSurface", () => ({
  TerminalSurface: () => (
    <div data-testid="terminal-screen">Terminal screen</div>
  ),
}));
function terminalFixture() {
  const projects = new Set<string>();
  const snapshot = (scope: any) => {
    const projectId = typeof scope === "string" ? scope : scope.projectId;
    const context =
      typeof scope === "string"
        ? { kind: "primary", projectId }
        : { kind: "topic", ...scope };
    const tab = {
      id: `common-${projectId}`,
      projectId,
      name: "console",
      scope: { kind: "common" },
    };
    return {
      revision: "v",
      context,
      initialized: projects.has(projectId),
      tabs: projects.has(projectId) ? [tab] : [],
      selectedId: projects.has(projectId) ? tab.id : null,
      sessions: projects.has(projectId)
        ? [
            {
              tabId: tab.id,
              sessionId: `${tab.id}-${typeof scope === "string" ? "primary" : scope.contextId}`,
              generation: "g",
              state: "running",
              context,
            },
          ]
        : [],
    };
  };
  return {
    onChanged: () => () => {},
    request: vi.fn(async (r: any) => {
      if (r.kind === "initialize")
        projects.add(typeof r.scope === "string" ? r.scope : r.scope.projectId);
      if (r.kind === "read" || r.kind === "initialize")
        return snapshot(r.scope);
      throw Error(`Unexpected terminal request: ${r.kind}`);
    }),
  };
}
const completions = new Map<string, (run: any, stale: boolean) => void>();
vi.mock("../src/renderer/LaunchForm", () => ({
  LaunchForm: ({ owner, onLaunched, blocked }: any) => {
    completions.set(`pipeline:${owner?.contextId ?? "primary"}`, onLaunched);
    return (
      <textarea
        aria-label="Pipeline draft"
        disabled={!!blocked}
        data-owner={JSON.stringify(owner ?? null)}
      />
    );
  },
}));
vi.mock("../src/renderer/BuildForm", () => ({
  BuildForm: ({ owner, onLaunched, blocked }: any) => {
    completions.set(`build:${owner?.contextId ?? "primary"}`, onLaunched);
    return (
      <textarea
        aria-label="Build draft"
        disabled={!!blocked}
        data-owner={JSON.stringify(owner ?? null)}
      />
    );
  },
  createBuildDrafts: () => new Map(),
  BuildCleanConfirmation: () => null,
}));
const ownerA = {
  projectId: "p",
  year: "2026",
  topic: "alpha",
  branch: "feature/alpha",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "c".repeat(64),
  projectPath: "/fixture/project",
  gitCommonDir: "/fixture/project/.git",
  path: "/fixture/copies/a",
  storageKind: "clone",
  ownership: "managed",
  state: "ready",
};
const ownerB = {
  ...ownerA,
  topic: "beta",
  branch: "feature/beta",
  contextId: `ctx-${"b".repeat(64)}`,
  path: "/fixture/copies/b",
};
let api: any;
let focusRun: (id: string) => void;
let emitRuns: (runs: any[]) => void;
beforeEach(() => {
  completions.clear();
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Fixture", path: "/fixture/project" },
    ]),
    runs: vi.fn(async () => []),
    onRuns: (cb: typeof emitRuns) => {
      emitRuns = cb;
      return () => {};
    },
    onFocusRun: (cb: typeof focusRun) => {
      focusRun = cb;
      return () => {};
    },
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    stopRun: vi.fn(async () => {}),
    closeRun: vi.fn(async () => true),
    selectTopicContext: vi.fn(async () => {}),
    cancelRead: vi.fn(async () => {}),
    readTopicBoard: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      revision: "b",
      currentTopic: {
        topic: "native-topic",
        branch: "current-branch",
        remote: false,
      },
      currentBranch: "current-branch",
      entries: [ownerA, ownerB].map((o) => ({
        topic: o.topic,
        branch: o.branch,
        remote: false,
      })),
      records: [],
      remoteEntries: [],
      remoteRecords: [],
    })),
    listTopicContexts: vi.fn(async () => [ownerA, ownerB]),
    ensureTopicContext: vi.fn(),
    resolveTopicContext: vi.fn(async (ref: any) =>
      ref.contextId === ownerA.contextId ? ownerA : ownerB,
    ),
    checkTopicContextReadiness: vi.fn(async (ref: any) =>
      ref.contextId === ownerA.contextId ? ownerA : ownerB,
    ),
    checkoutBranch: vi.fn(),
    launch: vi.fn(),
    launchBuild: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
async function mount() {
  render(<App />);
  await screen.findByTestId("settings");
  await waitFor(() => expect(api.listTopicContexts).toHaveBeenCalled());
}
async function choose(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(
    screen.getByRole("row", { name: new RegExp(`^${name}( |$)`) }),
  );
  await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
  await screen.findByRole("button", {
    name: name === "Без топика" ? name : `Открыть карточку топика ${name}`,
  });
}
function settings() {
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
}
function launch(kind: string) {
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: new RegExp(`^${kind}`) }),
  );
}
it("starts explicitly Without topic, never inferring the native current topic or clone", async () => {
  await mount();
  expect(screen.getByRole("button", { name: "Без топика" }).textContent).toBe(
    "Без топика",
  );
  expect(
    screen.queryByRole("button", {
      name: "Открыть карточку топика native-topic",
    }),
  ).toBeNull();
  expect(screen.getByTestId("settings").dataset.owner).toBe("null");
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(api.checkoutBranch).not.toHaveBeenCalled();
});
it("mounts settings on exact A then B then explicit primary scope, without a separate documents route", async () => {
  await mount();
  for (const owner of [ownerA, ownerB]) {
    await choose(owner.topic);
    settings();
    const view = await screen.findByTestId("settings");
    expect(JSON.parse(view.dataset.owner!)).toEqual({
      projectId: owner.projectId,
      year: owner.year,
      topic: owner.topic,
      branch: owner.branch,
      contextId: owner.contextId,
      revision: owner.revision,
    });
    expect(view.dataset.mountedOwner).toBe(owner.contextId);
    expect(
      screen.queryByRole("button", { name: "Файлы и конфигурация топика" }),
    ).toBeNull();
  }
  await choose("Без топика");
  expect(screen.getByTestId("settings").dataset.owner).toBe("null");
  expect(screen.getByTestId("settings").dataset.mountedOwner).toBe("p");
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.checkoutBranch).not.toHaveBeenCalled();
});
it.each([
  ["Конвейер", "Pipeline draft"],
  ["Сборка", "Build draft"],
])(
  "primary %s opens the existing no-owner form without ensure or resolve",
  async (kind, label) => {
    await mount();
    launch(kind);
    expect((await screen.findByLabelText(label)).dataset.owner).toBe("null");
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.resolveTopicContext).not.toHaveBeenCalled();
    expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
    expect(api.checkoutBranch).not.toHaveBeenCalled();
  },
);
it("does not route an unavailable selected clone to primary settings or launch", async () => {
  api.listTopicContexts.mockResolvedValue([{ ...ownerA, state: "missing" }]);
  await mount();
  await choose("alpha");
  settings();
  expect(screen.queryByTestId("settings")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain("недоступна");
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(
    screen
      .getByRole("menuitem", { name: /^Конвейер/ })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.queryByLabelText("Pipeline draft")).toBeNull();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
});
it("keeps mounted A and primary preparation drafts bound to their captured owners", async () => {
  await mount();
  await choose("alpha");
  launch("Конвейер");
  const a = await screen.findByLabelText("Pipeline draft");
  fireEvent.change(a, { target: { value: "Captured A" } });
  await choose("Без топика");
  launch("Конвейер");
  const forms = screen.getAllByLabelText("Pipeline draft");
  expect(forms).toHaveLength(2);
  expect(forms[0]).toBe(a);
  expect(JSON.parse(a.dataset.owner!).contextId).toBe(ownerA.contextId);
  expect((a as HTMLTextAreaElement).value).toBe("Captured A");
  expect(forms[1].dataset.owner).toBe("null");
});

it("shows primary history and activity only for ownerless runs of this project", async () => {
  api.runs.mockResolvedValue([
    {
      id: "primary",
      projectId: "p",
      pipeline: "primary-pipeline",
      topic: "native-topic",
      branch: "current-branch",
      status: "running",
      startedAt: "2026-10-20T10:00:00Z",
    },
    {
      id: "clone",
      projectId: "p",
      pipeline: "clone-pipeline",
      topic: ownerA.topic,
      branch: ownerA.branch,
      context: ownerA,
      status: "running",
      startedAt: "2026-10-20T10:00:00Z",
    },
    {
      id: "foreign",
      projectId: "q",
      pipeline: "foreign-pipeline",
      topic: "other",
      branch: "other",
      status: "running",
      startedAt: "2026-10-20T10:00:00Z",
    },
  ]);
  await mount();
  const runs = screen.getByRole("button", { name: "Запуски" });
  expect(runs.querySelector(".context-active-count")?.textContent).toBe("1");
  fireEvent.click(runs);
  expect(
    screen.getByRole("button", { name: "Открыть запуск primary-pipeline" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Открыть запуск clone-pipeline" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Открыть запуск foreign-pipeline" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(
    screen
      .getByRole("menuitem", { name: /^Конвейер/ })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("keeps Without topic usable even without clone APIs or a readable topic catalog", async () => {
  delete api.ensureTopicContext;
  delete api.resolveTopicContext;
  api.readTopicBoard.mockRejectedValue(Error("Catalog unavailable"));
  render(<App />);
  await screen.findByTestId("settings");
  fireEvent.click(screen.getByRole("button", { name: "Без топика" }));
  expect(screen.getByRole("row", { name: /^Без топика / })).toBeTruthy();
  fireEvent.click(screen.getByRole("row", { name: /^Без топика / }));
  launch("Сборка");
  expect((await screen.findByLabelText("Build draft")).dataset.owner).toBe(
    "null",
  );
});

it.each([
  ["legacy marker on a clone", { compatibility: "legacy-linked" }],
  ["external owner", { ownership: "external" }],
  ["unfinished preparation", { preparation: "pending" }],
  ["deleted owner", { deletedAt: "2026-10-20T00:00:00Z" }],
  ["invalid owner reference", { contextId: "invalid-owner" }],
])(
  "never loads primary settings/forms for a historical %s",
  async (_label, change) => {
    const invalid = { ...ownerA, ...change };
    api.listTopicContexts.mockResolvedValue([invalid]);
    api.runs.mockResolvedValue([
      {
        id: "invalid-history",
        projectId: "p",
        pipeline: "verify",
        topic: invalid.topic,
        branch: invalid.branch,
        context: invalid,
        status: "exited",
        startedAt: "2026-10-20T10:00:00Z",
        output: { text: "Historical output", truncated: false },
      },
    ]);
    await mount();
    await act(async () => focusRun("invalid-history"));
    settings();
    expect(screen.queryByTestId("settings")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Контекст недоступен" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    expect(
      screen
        .getByRole("menuitem", { name: /^Конвейер/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("menuitem", { name: /^Сборка/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.resolveTopicContext).not.toHaveBeenCalled();
  },
);

const ownedRun = (id: string, owner?: typeof ownerA) => ({
  id,
  projectId: "p",
  kind: "pipeline",
  pipeline: id,
  topic: owner?.topic ?? "primary",
  branch: owner?.branch ?? "main",
  ...(owner ? { context: owner } : {}),
  status: "running",
  url: `http://127.0.0.1:8000/${id}`,
  startedAt: "2026-10-21T10:00:00Z",
});
async function openRun(id: string) {
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  fireEvent.click(
    await screen.findByRole("button", { name: `Открыть запуск ${id}` }),
  );
}
it("shows only the selected owner's open run tabs and restores them without closing or stopping runs", async () => {
  api.runs.mockResolvedValue([
    ownedRun("primary"),
    ownedRun("run-a", ownerA),
    ownedRun("run-b", ownerB),
  ]);
  await mount();
  await openRun("primary");
  await choose("alpha");
  expect(screen.queryByRole("tab", { name: /^primary ·/ })).toBeNull();
  await openRun("run-a");
  await choose("beta");
  expect(screen.queryByRole("tab", { name: /^run-a ·/ })).toBeNull();
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith(null));
  await openRun("run-b");
  await choose("alpha");
  expect(screen.queryByRole("tab", { name: /^run-b ·/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /^run-a ·/ }));
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith("run-a"));
  await choose("Без топика");
  expect(screen.queryByRole("tab", { name: /^run-a ·/ })).toBeNull();
  expect(screen.getByRole("tab", { name: /^primary ·/ })).toBeTruthy();
  expect(api.stopRun).not.toHaveBeenCalled();
  expect(api.closeRun).not.toHaveBeenCalled();
});
it("filters draft tabs by owner while retaining their mounted drafts across A/B/primary switches", async () => {
  await mount();
  launch("Конвейер");
  const primary = await screen.findByLabelText("Pipeline draft");
  fireEvent.change(primary, { target: { value: "primary text" } });
  await choose("alpha");
  expect(screen.queryByRole("tab", { name: "Новый запуск" })).toBeNull();
  launch("Конвейер");
  await screen.findByRole("tab", { name: /Новый конвейер · alpha/ });
  const alpha = screen
    .getAllByLabelText("Pipeline draft")
    .find((e) => e.dataset.owner !== "null")!;
  fireEvent.change(alpha, { target: { value: "alpha text" } });
  await choose("beta");
  expect(
    screen.queryByRole("tab", { name: /Новый конвейер · alpha/ }),
  ).toBeNull();
  launch("Сборка");
  await screen.findByRole("tab", { name: /Новая сборка · beta/ });
  await choose("alpha");
  expect(screen.queryByRole("tab", { name: /Новая сборка · beta/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /Новый конвейер · alpha/ }));
  expect(alpha.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(
    false,
  );
  expect((alpha as HTMLTextAreaElement).value).toBe("alpha text");
  expect(primary.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(
    true,
  );
  await choose("Без топика");
  fireEvent.click(screen.getByRole("tab", { name: "Новый запуск" }));
  expect((primary as HTMLTextAreaElement).value).toBe("primary text");
});
it("keeps Project open and remounts it in the selected scope with its actual path", async () => {
  const a = { ...ownerA, path: "/Users/fixture/.goga/desktop/clones/a" };
  api.listTopicContexts.mockResolvedValue([a, ownerB]);
  api.resolveTopicContext.mockImplementation(async (r: any) =>
    r.topic === a.topic ? a : ownerB,
  );
  api.checkTopicContextReadiness.mockImplementation(async (r: any) =>
    r.contextId === a.contextId ? a : ownerB,
  );
  await mount();
  await choose("alpha");
  expect(screen.getByTestId("settings").dataset.mountedOwner).toBe(a.contextId);
  let path = screen.getByLabelText("Путь выбранного контекста");
  expect(path.textContent).toBe("~/.goga/desktop/clones/a");
  expect(path.title).toBe(a.path);
  await choose("beta");
  expect(screen.getByTestId("settings").dataset.mountedOwner).toBe(
    ownerB.contextId,
  );
  expect(screen.getByLabelText("Путь выбранного контекста").textContent).toBe(
    ownerB.path,
  );
  await choose("Без топика");
  expect(screen.getByTestId("settings").dataset.mountedOwner).toBe("p");
  expect(screen.getByLabelText("Путь выбранного контекста").textContent).toBe(
    "/fixture/project",
  );
});
it("does not display a foreign clone when the selected primary run disappears", async () => {
  const primary = ownedRun("primary"),
    foreign = ownedRun("run-a", ownerA);
  api.runs.mockResolvedValue([primary, foreign]);
  await mount();
  await openRun("primary");
  await act(async () => emitRuns([foreign]));
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith(null));
  expect(screen.queryByRole("tab", { name: /^run-a ·/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Без топика" })).toBeTruthy();
});

it.each(["pipeline", "build"])(
  "a late %s launch stays registered but cannot navigate from B back to A",
  async (kind) => {
    await mount();
    await choose("alpha");
    launch(kind === "build" ? "Сборка" : "Конвейер");
    await waitFor(() =>
      expect(completions.has(`${kind}:${ownerA.contextId}`)).toBe(true),
    );
    const complete = completions.get(`${kind}:${ownerA.contextId}`)!;
    await choose("beta");
    settings();
    await act(async () =>
      complete(
        {
          ...ownedRun("late-a", ownerA),
          kind,
          build:
            kind === "build" ? { planPath: "late-a", clean: false } : undefined,
        },
        false,
      ),
    );
    expect(screen.getByTestId("settings").dataset.mountedOwner).toBe(
      ownerB.contextId,
    );
    expect(screen.getByLabelText("Путь выбранного контекста").textContent).toBe(
      ownerB.path,
    );
    expect(screen.queryByRole("tab")).toBeNull();
    expect(api.selectRun).not.toHaveBeenCalledWith("late-a");
    await choose("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
    if (kind === "build")
      fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Открыть запуск late-a" }),
    );
    expect(screen.getByRole("tab", { selected: true })).toBeTruthy();
  },
);

it.each(["primary", "clone"])(
  "allows many pipelines plus one build in %s, retaining independent form gates",
  async (scope) => {
    const owner = scope === "clone" ? ownerA : undefined;
    const pipeline = ownedRun("pipeline-1", owner);
    api.runs.mockResolvedValue([pipeline]);
    await mount();
    if (owner) await choose("alpha");
    launch("Конвейер");
    const pipelineDraft = await screen.findByLabelText("Pipeline draft");
    expect(pipelineDraft.hasAttribute("disabled")).toBe(false);
    launch("Сборка");
    const buildDraft = await screen.findByLabelText("Build draft");
    expect(buildDraft.hasAttribute("disabled")).toBe(false);
    const build = {
      ...ownedRun("build-1", owner),
      kind: "build",
      build: { planPath: "plan.md", clean: false },
    };
    await act(async () => emitRuns([pipeline, build]));
    expect(buildDraft.hasAttribute("disabled")).toBe(true);
    launch("Конвейер");
    expect(pipelineDraft.hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    expect(screen.queryByRole("menuitem", { name: /^Сборка/ })).toBeNull();
    expect(screen.getByText("Сборка уже выполняется")).toBeTruthy();
    await act(async () => emitRuns([pipeline, { ...build, status: "exited" }]));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Сборка/ }));
    expect(buildDraft.hasAttribute("disabled")).toBe(false);
    expect(api.stopRun).not.toHaveBeenCalled();
  },
);
it.each(["primary", "clone"])(
  "permits repeating a finished build alongside pipelines but not another build in %s",
  async (scope) => {
    const owner = scope === "clone" ? ownerA : undefined;
    const pipeline = ownedRun("pipeline", owner);
    const finished = {
      ...ownedRun("finished", owner),
      kind: "build",
      status: "exited",
      build: { planPath: "plan.md", clean: false },
    };
    api.runs.mockResolvedValue([pipeline, finished]);
    await mount();
    if (owner) await choose("alpha");
    fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
    fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Открыть запуск plan.md" }),
    );
    const repeat = screen.getByRole<HTMLButtonElement>("button", {
      name: "Повторить сборку",
    });
    expect(repeat.disabled).toBe(false);
    await act(async () =>
      emitRuns([
        pipeline,
        finished,
        { ...finished, id: "active-build", status: "starting" },
      ]),
    );
    expect(repeat.disabled).toBe(true);
  },
);
it("keeps Terminal between Project and Topics, follows selector context without affecting run tabs", async () => {
  api.terminal = terminalFixture();
  await mount();
  const nav = screen.getByRole("tablist", { name: "Разделы проекта" });
  expect(
    within(nav)
      .getAllByRole("button")
      .slice(0, 3)
      .map((b) => b.textContent),
  ).toEqual(["Проект", "Терминал", "Топики"]);
  fireEvent.click(screen.getByRole("button", { name: "Терминал" }));
  await screen.findByTestId("terminal-screen");
  await choose("alpha");
  await waitFor(() =>
    expect(api.terminal.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "read",
        scope: expect.objectContaining({ contextId: ownerA.contextId }),
      }),
    ),
  );
  expect(
    screen
      .getByRole("button", { name: "Терминал" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await screen.findByTestId("terminal-screen");
  expect(
    screen.getByRole("tab", { name: /console — Общий терминал/ }),
  ).toBeTruthy();
  expect(
    api.terminal.request.mock.calls.filter(
      ([r]: any) => r.kind === "initialize",
    ),
  ).toHaveLength(1);
  const reads = api.terminal.request.mock.calls.length;
  await choose("Без топика");
  await screen.findByTestId("terminal-screen");
  expect(api.terminal.request.mock.calls).toHaveLength(reads);
  expect(
    screen
      .getByRole("button", { name: "Терминал" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});

it("returns to each project section instead of resetting to Project", async () => {
  api.listProjects.mockResolvedValue([
    { id: "p", name: "Fixture", path: "/fixture/project" },
    { id: "q", name: "Other", path: "/fixture/other" },
  ]);
  api.terminal = terminalFixture();
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Терминал" }));
  const savedScreen = await screen.findByTestId("terminal-screen");
  expect(
    screen.getByRole("tab", { name: /console — Общий терминал/ }),
  ).toBeTruthy();
  expect(
    api.terminal.request.mock.calls.filter(
      ([r]: any) => r.kind === "initialize",
    ),
  ).toHaveLength(1);
  api.terminal.request.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  await screen.findByTestId("settings");
  fireEvent.click(screen.getByRole("button", { name: "Fixture" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Терминал" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(await screen.findByTestId("terminal-screen")).toBe(savedScreen);
  expect(
    api.terminal.request.mock.calls.filter(([r]: any) => r.kind === "read"),
  ).toEqual([]);
});

it("restores the same topics table and filter while return-time catalog reads are delayed", async () => {
  api.listProjects.mockResolvedValue([
    { id: "p", name: "Fixture", path: "/fixture/project" },
    { id: "q", name: "Other", path: "/fixture/other" },
  ]);
  const board = await api.readTopicBoard("p");
  board.records = [
    {
      topic: "alpha",
      branch: "feature/alpha",
      remote: false,
      statuses: [],
      task: "",
    },
  ];
  board.entries = board.records.map((r: any) => ({
    ...r,
    todo: "",
    hosts: [],
    divergence: null,
  }));
  api.readTopicBoard.mockImplementation(async (id: string) => ({
    ...board,
    projectId: id,
  }));
  api.readTopicTable = vi.fn(async (id: string) => ({
    ...board,
    projectId: id,
    revision: "display:table",
  }));
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  const row = await screen.findByRole("button", {
    name: "Открыть топик alpha",
  });
  expect(api.readTopicTable).toHaveBeenCalledWith("p", "2026");
  const filter = screen.getByRole("searchbox");
  fireEvent.change(filter, { target: { value: "alpha" } });
  const table = screen.getByRole("table");
  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  await screen.findByTestId("settings");
  api.readTopicBoard.mockImplementation(() => new Promise(() => {}));
  api.readTopicTable.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Fixture" }));
  expect(screen.getByRole("table")).toBe(table);
  expect(screen.getByRole("button", { name: "Открыть топик alpha" })).toBe(row);
  expect(screen.getByRole("searchbox")).toBe(filter);
  expect((filter as HTMLInputElement).value).toBe("alpha");
  expect(screen.queryByText("Загружаем топики…")).toBeNull();
});

it.each([false, true])(
  "deletes selected clone then commits primary navigation before Goga (failure=%s)",
  async (fail) => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    api.readTopicOverview = vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      target: { topic: ownerA.topic, branch: ownerA.branch, remote: false },
      text: "Task",
      exists: true,
      version: "v",
      editable: false,
    }));
    api.contextDeletionRecovery = vi.fn(async () => null);
    api.prepareContextDeletion = vi.fn(async () => ({
      token: "delete-alpha",
      contextId: ownerA.contextId,
      stage: "prepared",
      clonePath: ownerA.path,
      details: ["Move clone to Trash"],
    }));
    let trash!: () => void;
    api.deleteContext = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        trash = resolve;
      });
      return {
        projectId: "p",
        status: "success",
        cloneRemoved: true,
        stage: "clone-trashed",
        message: "Moved",
      };
    });
    api.finishContextDeletion = vi.fn(async () => {
      expect(screen.getByRole("button", { name: "Без топика" })).toBeTruthy();
      expect(
        screen.getByLabelText("Путь выбранного контекста").textContent,
      ).toBe("/fixture/project");
      expect(api.selectTopicContext).toHaveBeenLastCalledWith(null);
      expect(screen.queryByRole("dialog", { name: /Топик alpha/ })).toBeNull();
      if (fail) throw Error("Goga delete failed");
      return {
        projectId: "p",
        status: "success",
        cloneRemoved: true,
        message: "Deleted",
      };
    });
    await mount();
    await choose("alpha");
    fireEvent.click(
      screen.getByRole("button", { name: "Открыть карточку топика alpha" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Удалить топик…" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Подтвердить удаление" }),
    );
    await waitFor(() => expect(trash).toBeDefined());
    expect(
      screen.getByRole("button", { name: "Открыть карточку топика alpha" }),
    ).toBeTruthy();
    expect(api.finishContextDeletion).not.toHaveBeenCalled();
    await act(async () => trash());
    await waitFor(() =>
      expect(api.finishContextDeletion).toHaveBeenCalledTimes(1),
    );
    expect(screen.getByRole("button", { name: "Без топика" })).toBeTruthy();
    if (fail)
      expect(await screen.findByRole("alert")).toHaveProperty(
        "textContent",
        "Goga delete failed",
      );
  },
);

it("keeps primary visible but stops before Goga until selection is durably saved", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api.readTopicOverview = vi.fn(async () => ({
    projectId: "p",
    year: "2026",
    target: { topic: ownerA.topic, branch: ownerA.branch, remote: false },
    text: "Task",
    exists: true,
    version: "v",
    editable: false,
  }));
  api.contextDeletionRecovery = vi.fn(async () => null);
  api.prepareContextDeletion = vi.fn(async () => ({
    token: "persist-alpha",
    contextId: ownerA.contextId,
    stage: "prepared",
    details: [],
  }));
  api.deleteContext = vi.fn(async () => ({
    projectId: "p",
    status: "success",
    cloneRemoved: true,
    stage: "clone-trashed",
    message: "Moved",
  }));
  api.finishContextDeletion = vi.fn(async () => ({
    projectId: "p",
    status: "success",
    message: "Done",
  }));
  await mount();
  await choose("alpha");
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть карточку топика alpha" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Удалить топик…" }),
  );
  const confirm = await screen.findByRole("button", {
    name: "Подтвердить удаление",
  });
  const persist = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("Storage denied");
    });
  try {
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Без топика" })).toBeTruthy(),
    );
    await screen.findByRole("alert");
    expect(api.finishContextDeletion).not.toHaveBeenCalled();
    expect(api.selectTopicContext).toHaveBeenLastCalledWith(null);
  } finally {
    persist.mockRestore();
  }
  fireEvent.click(screen.getByRole("button", { name: "Продолжить удаление" }));
  await waitFor(() =>
    expect(api.finishContextDeletion).toHaveBeenCalledTimes(1),
  );
  const key = `goga.desktop.selection.v1:${JSON.stringify(["p", "/fixture/project", ""])}`;
  expect(localStorage.getItem(key)).toBe("null");
});

it("keeps the selected context and card after failed clone trash", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api.readTopicOverview = vi.fn(async () => ({
    projectId: "p",
    year: "2026",
    target: { topic: ownerA.topic, branch: ownerA.branch, remote: false },
    text: "Task",
    exists: true,
    version: "v",
    editable: false,
  }));
  api.contextDeletionRecovery = vi.fn(async () => null);
  api.prepareContextDeletion = vi.fn(async () => ({
    token: "before-trash",
    contextId: ownerA.contextId,
    stage: "prepared",
    details: [],
  }));
  api.deleteContext = vi.fn(async () => ({
    projectId: "p",
    status: "failed",
    cloneRemoved: false,
    message: "Trash denied",
  }));
  api.finishContextDeletion = vi.fn();
  await mount();
  await choose("alpha");
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть карточку топика alpha" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Удалить топик…" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Подтвердить удаление" }),
  );
  await screen.findByText("Trash denied");
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика alpha" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Путь выбранного контекста").textContent).toBe(
    ownerA.path,
  );
  expect(api.finishContextDeletion).not.toHaveBeenCalled();
});

it("deletes a different topic without replacing the selected context", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const board = await api.readTopicBoard("p");
  board.entries = [ownerA, ownerB].map((o) => ({
    topic: o.topic,
    branch: o.branch,
    remote: false,
    hosts: [],
    statuses: [],
    divergence: null,
    todo: "",
  }));
  board.records = board.entries;
  api.readTopicTable = vi.fn(async () => board);
  api.contextDeletionRecovery = vi.fn(async () => null);
  api.prepareContextDeletion = vi.fn(async () => ({
    token: "delete-beta",
    contextId: ownerB.contextId,
    stage: "prepared",
    details: [],
  }));
  api.deleteContext = vi.fn(async () => ({
    projectId: "p",
    status: "success",
    cloneRemoved: true,
    stage: "clone-trashed",
    message: "Moved",
  }));
  api.finishContextDeletion = vi.fn(async () => ({
    projectId: "p",
    status: "success",
    message: "Done",
  }));
  await mount();
  await choose("alpha");
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Удалить топик beta" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Подтвердить удаление" }),
  );
  await waitFor(() =>
    expect(api.finishContextDeletion).toHaveBeenCalledTimes(1),
  );
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика alpha" }),
  ).toBeTruthy();
  expect(screen.getByLabelText("Путь выбранного контекста").textContent).toBe(
    ownerA.path,
  );
  const saved = JSON.parse(
    localStorage.getItem(
      `goga.desktop.selection.v1:${JSON.stringify(["p", "/fixture/project", ""])}`,
    )!,
  );
  expect(saved.contextId).toBe(ownerA.contextId);
});
