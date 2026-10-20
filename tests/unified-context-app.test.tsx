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
        data-testid="settings"
        data-owner={JSON.stringify(owner ?? null)}
        data-mounted-owner={mountedOwner}
      >
        Settings owner
      </div>
    );
  },
  ProjectSettingsConfirmation: () => null,
}));
vi.mock("../src/renderer/LaunchForm", () => ({
  LaunchForm: ({ owner }: any) => (
    <textarea
      aria-label="Pipeline draft"
      data-owner={JSON.stringify(owner ?? null)}
    />
  ),
}));
vi.mock("../src/renderer/BuildForm", () => ({
  BuildForm: ({ owner }: any) => (
    <textarea
      aria-label="Build draft"
      data-owner={JSON.stringify(owner ?? null)}
    />
  ),
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
beforeEach(() => {
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Fixture", path: "/fixture/project" },
    ]),
    runs: vi.fn(async () => []),
    onRuns: () => () => {},
    onFocusRun: (cb: typeof focusRun) => {
      focusRun = cb;
      return () => {};
    },
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
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
  ).toBe(true);
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
