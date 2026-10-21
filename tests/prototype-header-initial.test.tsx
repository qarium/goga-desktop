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
  within,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
// Keep App's explicit card-to-preparation boundary real while isolating the
// card editor's separate persistence workflow. Header primary launch no longer
// enters this flow in .51; it opens the original-folder form directly.
vi.mock("../src/renderer/TopicCard", () => ({
  TopicCard: ({ target, year, onPrepare, onClose }: any) => (
    <div role="dialog" aria-label="Карточка топика">
      <button onClick={() => onPrepare(target, year, "Fixture task")}>
        Подготовить запуск
      </button>
      <button onClick={onClose}>Закрыть карточку</button>
    </div>
  ),
}));
let api: any;
let focusRun: (id: string) => void;
let emitRuns: (runs: any[]) => void;
const owner = {
  projectId: "p",
  year: "2026",
  topic: "main",
  branch: "main",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "b".repeat(64),
  projectPath: "/fixture/project",
  gitCommonDir: "/fixture/project/.git",
  path: "/fixture/copies/main",
  ownership: "managed",
  storageKind: "clone",
  state: "ready",
};
const historical = (record = owner, extras: any = {}) => ({
  id: "history",
  projectId: record.projectId,
  kind: "pipeline",
  pipeline: "verify",
  topic: record.topic,
  branch: record.branch,
  context: record,
  status: "exited",
  startedAt: "2026-10-19T12:00:00Z",
  workflow: null,
  profile: null,
  output: { text: "Saved historical output", truncated: false },
  ...extras,
});
const board = (projectId = "p") => ({
  projectId,
  year: "2026",
  revision: "board",
  currentBranch: "main",
  currentTopic: { topic: "main", branch: "main", remote: false },
  baseRef: "main",
  branches: ["main", "feature"],
  dirty: false,
  active: false,
  entries: ["main", "feature"].map((topic) => ({
    topic,
    branch: topic,
    remote: false,
    hosts: [topic],
    statuses: [],
    todo: "",
  })),
  records: [],
  remoteEntries: [],
  remoteRecords: [],
});
beforeEach(() => {
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Fixture", path: "/fixture/project" },
      { id: "q", name: "Second", path: "/fixture/second" },
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
    selectTopicContext: vi.fn(async () => {}),
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    readTopicBoard: vi.fn(async (id) => board(id)),
    listTopicContexts: vi.fn(async () => []),
    ensureTopicContext: vi.fn(async () => owner),
    resolveTopicContext: vi.fn(async () => owner),
    checkTopicContextReadiness: vi.fn(async (ref) => ({ ...owner, ...ref })),
    discover: vi.fn(async () => ({
      pipelines: [{ id: "verify", name: "Verify" }],
      topics: [],
      currentBranch: "main",
      branches: ["main"],
      workflows: [],
      profiles: [],
    })),
    preview: vi.fn(async () => ({
      token: "preview",
      stages: [{ id: "one", title: "One" }],
      workflow: null,
      profile: null,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "Fixture task",
      version: "v",
      exists: true,
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    cancelRead: vi.fn(async () => {}),
    buildContext: vi.fn(async () => ({
      revision: "b",
      branch: "main",
      capabilities: [],
      defaults: { skipReview: false, profile: "" },
      branches: ["main"],
      workflows: [],
      profiles: [],
      historyPlan: { path: "plan.md" },
    })),
    readBuildPlan: vi.fn(async (_scope, path) => ({
      path,
      text: "# Fixture plan",
      version: "v",
    })),
    launch: vi.fn(),
    launchBuild: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
async function mount() {
  render(<App />);
  await screen.findByLabelText("Исполняемый файл");
  await screen.findByRole("button", { name: "Без топика" });
}
function headerPrepare(kind = "Конвейер") {
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: new RegExp(`^${kind}`) }),
  );
}
async function openCard(topic = "main") {
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  fireEvent.click(
    await screen.findByRole("button", { name: `Открыть топик ${topic}` }),
  );
}
async function cardPrepare(topic = "main") {
  await openCard(topic);
  fireEvent.click(screen.getByRole("button", { name: "Подготовить запуск" }));
}
async function choose(topic: string) {
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  // Selection resolves asynchronously and changes the launch menu's owner key.
  // Flush that transition and its passive effects before the next user action;
  // disappearance of the picker alone can precede the menu's reset effect.
  await act(async () => {
    fireEvent.click(
      screen.getByRole("row", { name: new RegExp(`^${topic} `) }),
    );
  });
  await waitFor(() => expect(screen.queryByRole("grid")).toBeNull());
  await screen.findByRole("button", {
    name: `Открыть карточку топика ${topic}`,
  });
}
function assertNoExecution() {
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.launchBuild).not.toHaveBeenCalled();
}
const retryPreparation = () =>
  fireEvent.click(
    screen.getByRole("button", {
      name: "Повторить подготовку",
    }),
  );
it("primary empty history keeps both launch entry points and a separate zero activity badge", async () => {
  await mount();
  const runs = screen.getByRole("button", { name: "Запуски" });
  expect(runs.querySelector(".context-active-count")?.textContent).toBe("0");
  expect(screen.getByRole("button", { name: "Запустить" })).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: /＋ Запустить конвейер|Запустить сборку/,
    }),
  ).toBeNull();
  fireEvent.click(runs);
  const history = screen.getByRole("region", {
    name: "Запуски выбранного топика",
  });
  expect(
    within(history).getByRole("button", { name: "Конвейеры: 0" }),
  ).toBeTruthy();
  expect(
    within(history).getByText("Конвейеры ещё не запускались."),
  ).toBeTruthy();
  fireEvent.click(within(history).getByRole("button", { name: "Сборка" }));
  expect(within(history).getByText("Сборка ещё не запускалась.")).toBeTruthy();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(api.discover).not.toHaveBeenCalled();
  assertNoExecution();
});
it("primary header shows only original-folder runs, activity and launch guards", async () => {
  api.runs.mockResolvedValue([
    historical(owner, { context: undefined, status: "running" }),
    historical(owner, { id: "clone" }),
  ]);
  await mount();
  const runs = screen.getByRole("button", { name: "Запуски" });
  expect(runs.querySelector(".context-active-count")?.textContent).toBe("1");
  fireEvent.click(runs);
  expect(screen.getByRole("button", { name: "Конвейеры: 1" })).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Открыть запуск verify" }),
  ).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(
    screen
      .getAllByRole("menuitem")
      .every((item) => item.hasAttribute("disabled")),
  ).toBe(false);
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  assertNoExecution();
});
it.each(["Конвейер", "Сборка"])(
  "primary %s opens a full inert original-folder form without clone preparation",
  async (kind) => {
    await mount();
    headerPrepare(kind);
    await screen.findByRole("heading", {
      name: kind === "Конвейер" ? "Запустить конвейер" : "Запустить сборку",
    });
    await waitFor(() =>
      expect(
        (kind === "Конвейер" ? api.discover : api.buildContext).mock
          .calls[0]?.[0],
      ).toBe("p"),
    );
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.resolveTopicContext).not.toHaveBeenCalled();
    expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
    expect(api.checkoutBranch).not.toHaveBeenCalled();
    assertNoExecution();
  },
);
it("explicit card intent prepares its exact clone before opening a full inert pipeline form", async () => {
  await mount();
  await cardPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.ensureTopicContext).toHaveBeenCalledExactlyOnceWith({
    projectId: "p",
    year: "2026",
    topic: "main",
    branch: "main",
  });
  expect(api.discover).toHaveBeenCalledWith(
    expect.objectContaining({ contextId: owner.contextId }),
  );
  assertNoExecution();
});
it("explicit initial preparation revalidates a known clone instead of ensuring or creating it", async () => {
  api.listTopicContexts.mockResolvedValue([owner]);
  await mount();
  await cardPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.resolveTopicContext).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ contextId: owner.contextId }),
  );
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  assertNoExecution();
});
it("rejects a host preparation result for a different owner before loading any form", async () => {
  api.ensureTopicContext.mockResolvedValue({
    ...owner,
    topic: "feature",
    branch: "feature",
  });
  await mount();
  await cardPrepare();
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /не соответствует/,
  );
  expect(api.discover).not.toHaveBeenCalled();
  assertNoExecution();
});
it("late initial A preparation cannot replace a subsequently chosen B", async () => {
  let finish!: (value: any) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const feature = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  api.ensureTopicContext.mockImplementation((target: any) =>
    target.topic === "main" ? pending : Promise.resolve(feature),
  );
  await mount();
  await cardPrepare();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^feature / }));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
  await act(async () => finish(owner));
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  assertNoExecution();
});
it("primary header remains usable when clone APIs are unavailable", async () => {
  delete api.ensureTopicContext;
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  expect(
    screen.getByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeTruthy();
  headerPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.discover).toHaveBeenCalledWith("p");
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  assertNoExecution();
});
it.each(["missing", "linked"])(
  "shows historical %s owner without recreation, retaining Runs and Launch reasons",
  async (unavailable) => {
    const recorded =
      unavailable === "missing"
        ? { ...owner, state: "missing" }
        : { ...owner, storageKind: "linked" };
    api.runs.mockResolvedValue([historical(recorded)]);
    api.listTopicContexts.mockResolvedValue([recorded]);
    await mount();
    await act(async () => focusRun("history"));
    expect(screen.getByText("Saved historical output")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
    expect(
      screen.getByRole("button", { name: "Открыть запуск verify" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    expect(
      within(screen.getByRole("menu")).getByText(
        unavailable === "missing"
          ? /Рабочая копия недоступна. История/
          : /Прежняя linked-worktree копия/,
      ),
    ).toBeTruthy();
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    assertNoExecution();
  },
);
it.each(["build", "pipeline"])(
  "ready %s owner activity blocks only a second build",
  async (kind) => {
    api.listTopicContexts.mockResolvedValue([owner]);
    api.runs.mockResolvedValue([
      historical(owner, {
        kind,
        status: "starting",
        build: kind === "build" ? { planPath: "plan.md" } : undefined,
      }),
    ]);
    await mount();
    await act(async () => focusRun("history"));
    expect(
      screen
        .getByRole("button", { name: "Запуски" })
        .querySelector(".context-active-count")?.textContent,
    ).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    if (kind === "build") {
      expect(screen.queryByRole("menuitem", { name: /^Сборка/ })).toBeNull();
      expect(screen.getByText("Сборка уже выполняется")).toBeTruthy();
    } else
      expect(screen.getByRole("menuitem", { name: /^Сборка/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("menuitem", { name: /^Конвейер/ }).hasAttribute("disabled")).toBe(false);
    assertNoExecution();
  },
);
it("another owner's active build does not block ready-owner preparation", async () => {
  const other = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  api.listTopicContexts.mockResolvedValue([owner, other]);
  api.runs.mockResolvedValue([
    historical(),
    historical(other, {
      id: "other",
      kind: "build",
      status: "running",
      build: { planPath: "other.md" },
    }),
  ]);
  await mount();
  await act(async () => focusRun("history"));
  headerPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.discover).toHaveBeenCalledWith(
    expect.objectContaining({ contextId: owner.contextId }),
  );
  assertNoExecution();
});

it("retries a failed inventory without falling back to primary or ensuring an unverified owner", async () => {
  api.listTopicContexts.mockRejectedValueOnce(Error("Inventory unavailable"));
  await mount();
  await cardPrepare();
  expect(screen.getByText("Inventory unavailable")).toBeTruthy();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", {
      name: "Подготовить или выбрать проверенную рабочую копию",
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить проверку рабочих копий" }),
  );
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  assertNoExecution();
});
it.each(["missing", "linked"])(
  "explicitly selected %s inventory remains read-only instead of recreating a historical owner",
  async (unavailable) => {
    api.listTopicContexts.mockResolvedValue([
      unavailable === "missing"
        ? { ...owner, state: "missing" }
        : { ...owner, storageKind: "linked" },
    ]);
    await mount();
    await choose("main");
    fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
    expect(
      screen.getByRole("region", { name: "Запуски выбранного топика" }),
    ).toBeTruthy();
    if (unavailable === "linked")
      expect(
        screen.getByRole("region", { name: "Совместимость рабочей копии" }),
      ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    expect(
      screen
        .getAllByRole("menuitem")
        .every((item) => item.hasAttribute("disabled")),
    ).toBe(true);
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.resolveTopicContext).not.toHaveBeenCalled();
    expect(api.discover).not.toHaveBeenCalled();
    assertNoExecution();
  },
);
it("times out preparation finitely and reuses the in-flight write on explicit retry", async () => {
  let finish!: (value: any) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  api.ensureTopicContext.mockReturnValue(pending);
  await mount();
  await openCard();
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Подготовить запуск" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_001);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/больше 300 с/);
    retryPreparation();
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    await act(async () => finish(owner));
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    assertNoExecution();
  } finally {
    vi.useRealTimers();
  }
});
it("an initial verified owner with another pipeline continues preparing a new pipeline", async () => {
  let finish!: (value: any) => void;
  api.listTopicContexts.mockResolvedValue([owner]);
  api.resolveTopicContext.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await cardPrepare();
  await act(async () => {
    emitRuns([historical(owner, { status: "starting" })]);
    finish(owner);
  });
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(
    screen
      .getByRole("button", { name: "Запуски" })
      .querySelector(".context-active-count")?.textContent,
  ).toBe("1");
  expect(api.discover).toHaveBeenCalled();
  assertNoExecution();
});

it.each(["build", "pipeline"])(
  "explicit known %s owner supplies exact activity and kind-specific admission",
  async (kind) => {
    const other = {
      ...owner,
      topic: "feature",
      branch: "feature",
      contextId: `ctx-${"c".repeat(64)}`,
    };
    api.listTopicContexts.mockResolvedValue([owner, other]);
    api.runs.mockResolvedValue([
      historical(owner, {
        kind,
        status: "starting",
        build: kind === "build" ? { planPath: "plan.md" } : undefined,
      }),
      historical(other, { id: "other", status: "running" }),
    ]);
    await mount();
    await choose("main");
    expect(
      screen
        .getByRole("button", { name: "Запуски" })
        .querySelector(".context-active-count")?.textContent,
    ).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    if (kind === "build") {
      expect(screen.queryByRole("menuitem", { name: /^Сборка/ })).toBeNull();
      expect(screen.getByText("Сборка уже выполняется")).toBeTruthy();
    } else
      expect(screen.getByRole("menuitem", { name: /^Сборка/ }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("menuitem", { name: /^Конвейер/ }).hasAttribute("disabled")).toBe(false);
    expect(api.selectTopicContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ contextId: owner.contextId }),
    );
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.resolveTopicContext).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ contextId: owner.contextId }),
    );
    expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
    assertNoExecution();
  },
);
it("explicit idle known owner supplies exact contextual history and launch verifies readiness", async () => {
  const other = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  api.listTopicContexts.mockResolvedValue([owner, other]);
  api.runs.mockResolvedValue([
    historical(),
    historical(owner, {
      id: "unknown-legacy",
      context: undefined,
      status: "running",
    }),
    historical(other, { id: "other", status: "running" }),
  ]);
  await mount();
  await choose("main");
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  expect(screen.getByRole("button", { name: "Конвейеры: 1" })).toBeTruthy();
  expect(
    screen.getAllByRole("button", { name: "Открыть запуск verify" }),
  ).toHaveLength(1);
  expect(
    screen
      .getByRole("button", { name: "Запуски" })
      .querySelector(".context-active-count")?.textContent,
  ).toBe("0");
  expect(api.selectTopicContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ contextId: owner.contextId }),
  );
  headerPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.checkTopicContextReadiness).toHaveBeenCalledWith(
    expect.objectContaining({ contextId: owner.contextId }),
  );
  assertNoExecution();
});
it("ambiguous explicit card owners fail closed without guessing a copy or inheriting history", async () => {
  const duplicate = {
    ...owner,
    contextId: `ctx-${"d".repeat(64)}`,
    path: "/fixture/copies/duplicate",
  };
  api.listTopicContexts.mockResolvedValue([owner, duplicate]);
  api.runs.mockResolvedValue([
    historical(owner, { status: "running" }),
    historical(duplicate, { id: "duplicate", status: "starting" }),
  ]);
  await mount();
  expect(
    screen
      .getByRole("button", { name: "Запуски" })
      .querySelector(".context-active-count")?.textContent,
  ).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  expect(screen.getByRole("button", { name: "Конвейеры: 0" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Открыть запуск verify" }),
  ).toBeNull();
  await cardPrepare();
  expect(screen.getByText(/Несколько рабочих копий/)).toBeTruthy();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  assertNoExecution();
});
it("initial lookup excludes tombstones and mismatching year or OWN branch", async () => {
  const dead = {
    ...owner,
    contextId: `ctx-${"f".repeat(64)}`,
    deletedAt: "2026-10-19T12:00:00Z",
  };
  const wrongYear = {
    ...owner,
    year: "2025",
    contextId: `ctx-${"d".repeat(64)}`,
  };
  const wrongBranch = {
    ...owner,
    branch: "feature",
    contextId: `ctx-${"e".repeat(64)}`,
  };
  api.listTopicContexts.mockResolvedValue([dead, wrongYear, wrongBranch]);
  api.runs.mockResolvedValue([
    historical(dead, { status: "running" }),
    historical(wrongYear, { id: "wrong-year", status: "running" }),
    historical(wrongBranch, { id: "wrong-branch", status: "running" }),
  ]);
  await mount();
  expect(
    screen
      .getByRole("button", { name: "Запуски" })
      .querySelector(".context-active-count")?.textContent,
  ).toBe("0");
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  expect(screen.getByRole("button", { name: "Конвейеры: 0" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Открыть запуск verify" }),
  ).toBeNull();
  await cardPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.ensureTopicContext).toHaveBeenCalledExactlyOnceWith({
    projectId: "p",
    year: "2026",
    topic: "main",
    branch: "main",
  });
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  assertNoExecution();
});
it("legacy TopicCard preparation cannot open an ownerless primary form when context API is unavailable", async () => {
  delete api.ensureTopicContext;
  await mount();
  await cardPrepare();
  expect((await screen.findByRole("alert")).textContent).toMatch(
    /API рабочих копий недоступен/,
  );
  expect(api.discover).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  assertNoExecution();
});
it("Topics current-context marker follows selected clone B without rewriting native primary-A board", async () => {
  const feature = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  api.ensureTopicContext.mockResolvedValue(feature);
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^feature / }));
  await screen.findByRole("button", { name: "Открыть карточку топика feature" });
  fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  const featureRow = (
    await screen.findByRole("button", { name: "Открыть топик feature" })
  ).closest("tr")!;
  const primaryRow = screen
    .getByRole("button", { name: "Открыть топик main" })
    .closest("tr")!;
  expect(featureRow.getAttribute("aria-current")).toBe("true");
  expect(featureRow.classList.contains("topic-current-row")).toBe(true);
  expect(primaryRow.getAttribute("aria-current")).toBeNull();
  expect((await api.readTopicBoard("p")).currentTopic.topic).toBe("main");
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  assertNoExecution();
});
it("reconciles a completed timed-out preparation on explicit retry instead of issuing a second ensure", async () => {
  let finish!: (value: any) => void;
  api.ensureTopicContext.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await openCard();
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Подготовить запуск" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_001);
    });
    expect(screen.getByRole("alert").textContent).toMatch(/больше 300 с/);
    await act(async () => finish(owner));
    expect(api.discover).not.toHaveBeenCalled();
    retryPreparation();
    await act(async () => {});
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    expect(api.resolveTopicContext).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: owner.contextId }),
    );
    assertNoExecution();
  } finally {
    vi.useRealTimers();
  }
});
it.each(["missing", "linked"])(
  "selects known %s owner read-only without publishing an invalid native execution selection",
  async (unavailable) => {
    const feature = {
      ...owner,
      topic: "feature",
      branch: "feature",
      contextId: `ctx-${"c".repeat(64)}`,
      ...(unavailable === "missing"
        ? { state: "missing" }
        : {
            state: "conflict",
            storageKind: "linked",
            compatibility: "legacy-linked",
          }),
    };
    api.listTopicContexts.mockResolvedValue([feature]);
    api.selectTopicContext.mockImplementation(async (ref: any) => {
      if (ref) throw Error("Unavailable copy cannot become execution owner");
    });
    await mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Выбрать другой топик" }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("row", { name: /^feature / })),
    );
    expect(
      screen.getByRole("button", { name: "Открыть карточку топика feature" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Контекст недоступен" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
    expect(
      screen.getByRole("region", { name: "Запуски выбранного топика" }),
    ).toBeTruthy();
    if (unavailable === "linked")
      expect(
        screen.getByRole("region", { name: "Совместимость рабочей копии" }),
      ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      api.selectTopicContext.mock.calls.every(([ref]: any) => ref === null),
    ).toBe(true);
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.resolveTopicContext).not.toHaveBeenCalled();
    assertNoExecution();
  },
);
it("an explicitly selected ready clone still publishes its narrow native execution reference", async () => {
  api.listTopicContexts.mockResolvedValue([owner]);
  api.runs.mockResolvedValue([historical()]);
  await mount();
  await act(async () => focusRun("history"));
  expect(api.selectTopicContext).toHaveBeenLastCalledWith({
    projectId: owner.projectId,
    year: owner.year,
    topic: owner.topic,
    branch: owner.branch,
    contextId: owner.contextId,
    revision: owner.revision,
  });
  assertNoExecution();
});

it("waits for the inventory before automatically continuing the captured intent", async () => {
  let finish!: (records: any[]) => void;
  api.listTopicContexts.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await cardPrepare();
  expect(screen.getByText("Проверяем доступные копии…")).toBeTruthy();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  assertNoExecution();
  await act(async () => finish([]));
  await waitFor(() => expect(api.discover).toHaveBeenCalled());
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(api.buildContext).not.toHaveBeenCalled();
  assertNoExecution();
});

it("coalesces repeated explicit card intent while preparation is pending", async () => {
  let finish!: (record: any) => void;
  api.ensureTopicContext.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await cardPrepare();
  await waitFor(() => expect(api.ensureTopicContext).toHaveBeenCalledTimes(1));
  await cardPrepare();
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(api.discover).not.toHaveBeenCalled();
  await act(async () => finish(owner));
  await waitFor(() => expect(api.discover).toHaveBeenCalled());
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(api.resolveTopicContext).toHaveBeenCalledWith(
    expect.objectContaining({
      contextId: owner.contextId,
      revision: owner.revision,
    }),
  );
  expect(api.buildContext).not.toHaveBeenCalled();
  assertNoExecution();
});

it("a card preparation failure keeps exact identity for explicit retry", async () => {
  api.ensureTopicContext.mockRejectedValueOnce(
    Error("Fixture preparation failed"),
  );
  await mount();
  await cardPrepare();
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Fixture preparation failed",
  );
  expect(screen.getByText("Топик: main · 2026 · main")).toBeTruthy();
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.buildContext).not.toHaveBeenCalled();
  retryPreparation();
  await waitFor(() => expect(api.discover).toHaveBeenCalled());
  expect(api.ensureTopicContext).toHaveBeenNthCalledWith(2, {
    projectId: "p",
    year: "2026",
    topic: "main",
    branch: "main",
  });
  assertNoExecution();
});

it("cancelled preparation keeps completed write for verified reentry without opening a late form", async () => {
  let finish!: (record: any) => void;
  api.ensureTopicContext.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await cardPrepare();
  await waitFor(() => expect(api.ensureTopicContext).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "К запускам топика" }));
  await act(async () => finish(owner));
  expect(
    screen.getByRole("region", { name: "Запуски выбранного топика" }),
  ).toBeTruthy();
  expect(api.buildContext).not.toHaveBeenCalled();
  expect(api.discover).not.toHaveBeenCalled();
  expect(
    api.selectTopicContext.mock.calls.every(([ref]: any) => ref === null),
  ).toBe(true);
  await cardPrepare();
  await waitFor(() => expect(api.discover).toHaveBeenCalled());
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(api.resolveTopicContext).toHaveBeenCalledTimes(1);
  assertNoExecution();
});

it("project navigation ignores a late preparation and retains its completed flight for reentry", async () => {
  let finish!: (record: any) => void;
  api.ensureTopicContext.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await cardPrepare();
  await waitFor(() => expect(api.ensureTopicContext).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: /Second/ }));
  await screen.findByRole("heading", { name: "Second" });
  await act(async () => finish(owner));
  expect(api.discover).not.toHaveBeenCalled();
  expect(
    api.selectTopicContext.mock.calls.every(([ref]: any) => ref === null),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Fixture/ }));
  await screen.findByRole("button", { name: "Без топика" });
  await cardPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(api.resolveTopicContext).toHaveBeenCalledTimes(1);
  assertNoExecution();
});

it.each([
  ["missing", { state: "missing" }],
  ["legacy", { storageKind: "linked" }],
  ["pending", { preparation: "pending" }],
  ["deleted", { deletedAt: "2026-10-19T12:00:00Z" }],
  ["external", { ownership: "external" }],
  ["invalid context", { contextId: "not-a-host-context" }],
  ["invalid revision", { revision: "not-a-host-revision" }],
])(
  "rejects %s preparation result without selecting it or loading a form",
  async (_name, change) => {
    api.ensureTopicContext.mockResolvedValue({
      ...owner,
      ...(change as object),
    });
    await mount();
    await cardPrepare();
    await screen.findByRole("alert");
    expect(api.discover).not.toHaveBeenCalled();
    expect(api.buildContext).not.toHaveBeenCalled();
    expect(
      api.selectTopicContext.mock.calls.every(([ref]: any) => ref === null),
    ).toBe(true);
    assertNoExecution();
  },
);

it("a historical external copy remains viewable without publishing an execution owner", async () => {
  const external = { ...owner, ownership: "external" };
  api.listTopicContexts.mockResolvedValue([external]);
  api.runs.mockResolvedValue([historical(external)]);
  await mount();
  await act(async () => focusRun("history"));
  expect(screen.getByText("Saved historical output")).toBeTruthy();
  expect(
    api.selectTopicContext.mock.calls.every(([ref]: any) => ref === null),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(
    screen
      .getAllByRole("menuitem")
      .every((item) => item.hasAttribute("disabled")),
  ).toBe(true);
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  assertNoExecution();
});

it.each([
  ["context", { contextId: `ctx-${"d".repeat(64)}` }],
  ["revision", { revision: "00000000-0000-4000-8000-000000000002" }],
])(
  "reconciliation never accepts a substituted %s from an existing cached flight",
  async (_name, change) => {
    let finish!: (record: any) => void;
    api.ensureTopicContext.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    api.resolveTopicContext.mockResolvedValue({
      ...owner,
      ...(change as object),
    });
    await mount();
    await cardPrepare();
    await waitFor(() =>
      expect(api.ensureTopicContext).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "К запускам топика" }));
    await act(async () => finish(owner));
    await cardPrepare();
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /не соответствует/,
    );
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    expect(api.discover).not.toHaveBeenCalled();
    assertNoExecution();
  },
);

it("ordinary project, board, history and card viewing never prepares a clone", async () => {
  await mount();
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть топик main" }),
  );
  await screen.findByRole("dialog");
  expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.buildContext).not.toHaveBeenCalled();
  assertNoExecution();
});

it("late A preparation cannot replace the full intended form already opened for B", async () => {
  let finish!: (record: any) => void;
  const feature = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  api.ensureTopicContext.mockImplementation((target: any) =>
    target.topic === "main"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(feature),
  );
  api.resolveTopicContext.mockImplementation(async (ref: any) =>
    ref.contextId === feature.contextId ? feature : owner,
  );
  await mount();
  await cardPrepare();
  await waitFor(() => expect(api.ensureTopicContext).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^feature / }));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
  await screen.findByRole("button", {
    name: "Открыть карточку топика feature",
  });
  headerPrepare("Сборка");
  await screen.findByRole("heading", { name: "Запустить сборку" });
  await waitFor(() => expect(api.buildContext).toHaveBeenCalled());
  await act(async () => finish(owner));
  expect(
    screen.getByRole("heading", { name: "Запустить сборку" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature" }),
  ).toBeTruthy();
  expect(api.buildContext.mock.calls[0][0]).toEqual(
    expect.objectContaining({ contextId: feature.contextId }),
  );
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.selectTopicContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ contextId: feature.contextId }),
  );
  assertNoExecution();
});

it("B transition intent invalidates pending initial A even before B preparation finishes", async () => {
  let finishA!: (record: any) => void;
  let finishB!: (record: any) => void;
  const feature = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  api.ensureTopicContext.mockImplementation(
    (identity: any) =>
      new Promise((resolve) => {
        if (identity.topic === "main") finishA = resolve;
        else finishB = resolve;
      }),
  );
  await mount();
  await cardPrepare();
  await waitFor(() => expect(api.ensureTopicContext).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^feature / }));
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(2);
  await act(async () => finishA(owner));
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.buildContext).not.toHaveBeenCalled();
  expect(
    api.selectTopicContext.mock.calls.every(([ref]: any) => ref === null),
  ).toBe(true);
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  await act(async () => finishB(feature));
  await screen.findByRole("region", { name: "Запуски выбранного топика" });
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature" }),
  ).toBeTruthy();
  expect(api.discover).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(screen.getByRole("row", { name: /^Без топика / }));
  await screen.findByLabelText("Исполняемый файл");
  await cardPrepare();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(2);
  expect(api.resolveTopicContext).toHaveBeenCalledWith(
    expect.objectContaining({
      contextId: owner.contextId,
      revision: owner.revision,
    }),
  );
  assertNoExecution();
});

it("opening the picker without requesting a transition does not cancel the initial intent", async () => {
  let finish!: (record: any) => void;
  api.ensureTopicContext.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await cardPrepare();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  await act(async () => finish(owner));
  await screen.findByRole("heading", { name: "Запустить конвейер" });
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  assertNoExecution();
});

it("picker quick-sync does not cancel an initial preparation intent or switch its owner", async () => {
  let finish!: (record: any) => void;
  const feature = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  const syncState = {
    projectId: feature.projectId,
    contextId: feature.contextId,
    revision: feature.revision,
    status: "synced",
    waitingRunIds: [],
    reasons: [],
    updatedAt: "2026-10-20T00:00:00Z",
  };
  api.listTopicContexts.mockResolvedValue([feature]);
  api.ensureTopicContext.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  api.topicSyncStatus = vi.fn(async () => syncState);
  api.syncTopicContext = vi.fn(async () => syncState);
  await mount();
  await cardPrepare();
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Синхронизировать коммиты · feature/2026/feature",
    }),
  );
  await waitFor(() => expect(api.syncTopicContext).toHaveBeenCalledTimes(1));
  expect(
    api.selectTopicContext.mock.calls.every(([ref]: any) => ref === null),
  ).toBe(true);
  await act(async () => finish(owner));
  await screen.findByRole("heading", { name: "Запустить конвейер" });
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика main" }),
  ).toBeTruthy();
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  assertNoExecution();
});
it("blocks explicit ready-owner working intent before mounting either full form, preserving meaningful IPC reason", async () => {
  api.listTopicContexts.mockResolvedValue([owner]);
  api.checkTopicContextReadiness = vi.fn(async () => {
    throw Error(
      "Error invoking remote method 'goga:check-topic-context-readiness': Error: Описание задачи не сохранено в Git. Сохраните данные задачи коммитом.",
    );
  });
  await mount();
  expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
  await cardPrepare();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "Описание задачи не сохранено в Git. Сохраните данные задачи коммитом.",
  );
  expect(api.checkTopicContextReadiness).toHaveBeenCalledWith(
    expect.objectContaining({
      contextId: owner.contextId,
      revision: owner.revision,
      year: "2026",
    }),
  );
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.readTopicTask).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Описание задачи")).toBeNull();
});
it("does not require todo metadata to prepare Build, which only reads the plan", async () => {
  api.listTopicContexts.mockResolvedValue([owner]);
  api.checkTopicContextReadiness.mockRejectedValue(
    Error("Описание задачи не сохранено в Git."),
  );
  await mount();
  await choose("main");
  headerPrepare("Сборка");
  await waitFor(() => expect(api.buildContext).toHaveBeenCalled());
  expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
});
it("cancelled card preflight cannot ensure a clone after primary Build is intended", async () => {
  let finish!: (value: any) => void;
  api.checkTopicContextReadiness.mockImplementation((ref: any) =>
    "contextId" in ref
      ? Promise.resolve({ ...owner, ...ref })
      : new Promise((resolve) => {
          finish = resolve;
        }),
  );
  await mount();
  await cardPrepare();
  await waitFor(() =>
    expect(api.checkTopicContextReadiness).toHaveBeenCalledTimes(1),
  );
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "К запускам топика" }));
  headerPrepare("Сборка");
  await screen.findByRole("heading", { name: "Запустить сборку" });
  await act(async () => finish(null));
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  await waitFor(() => expect(api.buildContext.mock.calls[0]?.[0]).toBe("p"));
  expect(api.discover).not.toHaveBeenCalled();
  expect(
    screen.getByRole("heading", { name: "Запустить сборку" }),
  ).toBeTruthy();
});
it("does not publish a late exact-owner readiness reply after selecting B", async () => {
  let finish!: (value: any) => void;
  const feature = {
    ...owner,
    topic: "feature",
    branch: "feature",
    contextId: `ctx-${"c".repeat(64)}`,
  };
  api.listTopicContexts.mockResolvedValue([owner, feature]);
  api.resolveTopicContext.mockImplementation(async (ref: any) =>
    ref.contextId === feature.contextId ? feature : owner,
  );
  api.checkTopicContextReadiness.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await cardPrepare();
  await waitFor(() =>
    expect(api.checkTopicContextReadiness).toHaveBeenCalled(),
  );
  await choose("feature");
  await act(async () => finish(owner));
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature" }),
  ).toBeTruthy();
  expect(api.selectTopicContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ contextId: feature.contextId }),
  );
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  assertNoExecution();
});
it("blocks fresh pipeline intent during source preflight without asking ensure or mounting form", async () => {
  api.checkTopicContextReadiness.mockRejectedValue(
    Error(
      "Описание задачи выбранного топика не сохранено в Git. Сохраните данные задачи коммитом.",
    ),
  );
  await mount();
  await cardPrepare();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "не сохранено в Git",
  );
  expect(api.checkTopicContextReadiness).toHaveBeenCalledExactlyOnceWith({
    projectId: "p",
    year: "2026",
    topic: "main",
    branch: "main",
  });
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.readTopicTask).not.toHaveBeenCalled();
});
it("shows the exact readiness reason through the real renderer readRequest bridge path", async () => {
  const reason =
    "Описание задачи выбранного топика не сохранено в Git. Сохраните необходимые данные задачи коммитом в основной папке и повторите подготовку. Изменения в рабочую копию не переносятся.";
  api.readRequest = vi.fn(
    async (_id: string, method: string, args: unknown[]) => {
      if (method === "checkTopicContextReadiness")
        throw Error(
          `Error invoking remote method 'goga:read-request': Error: ${reason}`,
        );
      return api[method](...args);
    },
  );
  await mount();
  await cardPrepare();
  expect((await screen.findByRole("alert")).textContent).toBe(reason);
  expect(api.readRequest).toHaveBeenCalledWith(
    expect.any(String),
    "checkTopicContextReadiness",
    [{ projectId: "p", year: "2026", topic: "main", branch: "main" }],
  );
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.readTopicTask).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
});
