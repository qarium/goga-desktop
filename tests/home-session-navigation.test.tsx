// @vitest-environment jsdom
import "./helpers/overview-browser-fixture";
import React from "react";
import { EditorView } from "@codemirror/view";
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
import type { Run } from "../src/shared/types";
import { App } from "../src/renderer/App";
import {
  executionButton,
  installPrototypeContextFixture,
  openPrototypeLaunch,
  selectPrototypeOwner,
} from "./helpers/prototype-context-fixture";

const projects = [
  { id: "alpha", name: "Alpha", path: "/fixture/alpha" },
  { id: "beta", name: "Beta", path: "/fixture/beta" },
];
const text = "private: editor-only input\n";
function setup(withBetaRun = false) {
  const api = {
    listProjects: vi.fn(async () => projects),
    runs: vi.fn(async (): Promise<Run[]> => []),
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "baseline",
      profiles: [],
    })),
    listOverviewDirectory: vi.fn(async () => ({
      path: "",
      entries: [],
      truncated: false,
    })),
    readOverviewSchema: vi.fn(async () => []),
    readProjectDocument: vi.fn(async () => ({
      text: "disk: true\n",
      exists: true,
      version: "before",
      relativePath: ".goga/config.yml",
    })),
    saveProjectDocument: vi.fn(),
    readGitSummary: vi.fn(async (scope) => ({
      scope,
      branch: "main",
      changedFiles: 0,
      conflicts: 0,
    })),
    discover: vi.fn(async (scope) => ({
      pipelines: [
        { id: "verify", name: "Verify", description: "Verify", project: true },
      ],
      topics: [],
      currentBranch: scope.branch,
      workflows: [],
      profiles: [],
      branches: ["main"],
    })),
    preview: vi.fn(async () => ({
      token: "preview",
      workflow: null,
      profile: null,
      stages: [{ id: "verify", title: "Verify" }],
    })),
    readTopicTask: vi.fn(async () => ({
      text: "saved task",
      exists: true,
      version: "before",
      path: "task.md",
    })),
    buildContext: vi.fn(async () => ({
      revision: "v",
      branch: "same-topic",
      capabilities: [],
      defaults: { skipReview: false, profile: "" },
      branches: ["same-topic"],
      workflows: [],
      profiles: [],
      historyPlan: { path: "plan.md" },
    })),
    readBuildPlan: vi.fn(async (_scope, path) => ({
      path,
      text: "# Plan",
      version: "before",
    })),
    launchBuild: vi.fn(),
    launch: vi.fn(),
    checkoutBranch: vi.fn(async () => "same-topic"),
    resolveTopicContext: vi.fn(),
    listTopicContexts: vi.fn(),
    ensureTopicContext: vi.fn(),
  };
  const fixture = installPrototypeContextFixture(
    api,
    projects.map((p) => ({ ...p, branch: "same-topic", topic: "same-topic" })),
  );
  if (withBetaRun) {
    const context = fixture.owner("beta");
    api.runs.mockResolvedValue([
      {
        id: "beta-live",
        projectId: "beta",
        context,
        kind: "pipeline",
        pipeline: "beta-work",
        topic: context.topic,
        branch: context.branch,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        workflow: null,
        profile: null,
      } as Run,
    ]);
  }
  window.goga = api as never;
  render(<App />);
  return { api, ...fixture };
}
const side = () =>
  within(screen.getByRole("navigation", { name: "Список проектов" }));
async function openProject(name: string) {
  fireEvent.click(await side().findByRole("button", { name }));
  await screen.findByRole("heading", { name });
}
async function home() {
  fireEvent.click(screen.getByRole("button", { name: "Главная" }));
  await screen.findByRole("heading", { name: "Главная" });
}
function editor() {
  const el = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector<HTMLElement>(".cm-content");
  return el ? EditorView.findFromDOM(el) : null;
}
async function dirtyConfig() {
  await openProject("Alpha");
  await selectPrototypeOwner();
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  const nav = await screen.findByRole("navigation", {
    name: "Разделы настроек проекта",
  });
  fireEvent.click(within(nav).getByRole("button", { name: "Конфигурация" }));
  const view = await waitFor(() => {
    const v = editor();
    if (!v) throw Error("waiting for project config editor");
    return v;
  });
  act(() =>
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    }),
  );
  await screen.findByText("Есть несохранённый черновик");
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
it("returns from Beta through Home to the original Alpha project editor and original dirty text", async () => {
  const { api, owner } = setup();
  await dirtyConfig();
  await home();
  await openProject("Beta");
  await selectPrototypeOwner();
  await home();
  const dirty = await screen.findByRole("button", {
    name: "1 несохранённый файл",
  });
  expect(document.body.textContent).not.toContain(text);
  api.readProjectDocument.mockClear();
  api.resolveTopicContext.mockClear();
  fireEvent.click(dirty);
  await waitFor(() => expect(editor()?.state.doc.toString()).toBe(text));
  expect(api.resolveTopicContext).toHaveBeenCalledWith(owner("alpha"));
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it.each(["changed", "missing"] as const)(
  "keeps a %s clone's dirty text available without reading or writing a replacement",
  async (mode) => {
    const { api, records, owner } = setup();
    await dirtyConfig();
    await home();
    await openProject("Beta");
    await home();
    const old = owner("alpha"),
      refreshed = {
        ...records[0],
        revision: "12345678-0000-4000-8000-000000000011",
      };
    api.resolveTopicContext.mockImplementation(async (ref) => {
      if (ref.revision === refreshed.revision) return refreshed;
      throw Error("Owner is no longer current");
    });
    api.listTopicContexts.mockResolvedValue(
      mode === "changed" ? [refreshed] : [],
    );
    api.ensureTopicContext.mockClear();
    api.readProjectDocument.mockClear();
    fireEvent.click(
      await screen.findByRole("button", { name: "1 несохранённый файл" }),
    );
    const modal = await screen.findByRole("dialog", {
      name: "Несохранённый файл",
    });
    expect(within(modal).getByRole<HTMLTextAreaElement>("textbox").value).toBe(
      text,
    );
    expect(
      within(modal).getByRole<HTMLTextAreaElement>("textbox").readOnly,
    ).toBe(true);
    expect(api.resolveTopicContext).toHaveBeenCalledWith(old);
    expect(api.listTopicContexts).toHaveBeenCalledWith("alpha");
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    fireEvent.click(
      within(modal).getByRole("button", { name: "Закрыть просмотр" }),
    );
    expect(screen.getByRole("heading", { name: "Главная" })).toBeTruthy();
  },
);
it("does not steal focus if a document target resolves after another project has been opened", async () => {
  const { api, records } = setup();
  await dirtyConfig();
  await home();
  let deliver!: (result: (typeof records)[number]) => void;
  api.resolveTopicContext.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        deliver = resolve;
      }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "1 несохранённый файл" }),
  );
  await openProject("Beta");
  await act(async () => deliver(records[0]));
  expect(screen.getByRole("heading", { name: "Beta" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(editor()).toBeNull();
});
it("returns to Alpha's original pipeline draft after viewing Beta's run in the identically named topic", async () => {
  const { api, owner } = setup(true);
  await openProject("Alpha");
  await openPrototypeLaunch();
  const input = await screen.findByLabelText("Что нужно сделать?");
  await waitFor(() =>
    expect((input as HTMLTextAreaElement).value).toBe("saved task"),
  );
  fireEvent.change(input, { target: { value: "keep this task in alpha" } });
  await home();
  fireEvent.click(await screen.findByRole("button", { name: "beta-work" }));
  await screen.findByRole("heading", { name: "Beta" });
  expect(
    await screen.findByRole("tab", { selected: true, name: /beta-work/ }),
  ).toBeTruthy();
  await home();
  api.resolveTopicContext.mockClear();
  fireEvent.click(
    await screen.findByRole("button", { name: "Черновик конвейера" }),
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("keep this task in alpha"),
  );
  expect(screen.getByRole("heading", { name: "Alpha" })).toBeTruthy();
  expect(api.resolveTopicContext).toHaveBeenCalledWith(owner("alpha"));
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.checkoutBranch).not.toHaveBeenCalled();
});

it.each(["pipeline", "build"] as const)(
  "replaces only the submitted %s after leaving for Home; no MRU promotion or focus theft",
  async (kind) => {
    const { api, owner } = setup();
    const submit = kind === "pipeline" ? api.launch : api.launchBuild;
    let finish!: (v: unknown) => void;
    submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await openProject("Alpha");
    await openPrototypeLaunch(kind);
    await waitFor(() => expect(executionButton().disabled).toBe(false));
    fireEvent.click(executionButton());
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    await home();
    await openProject("Beta");
    await home();
    const ref = owner("alpha");
    await act(async () =>
      finish({
        id: "result-one",
        projectId: "alpha",
        kind,
        pipeline: kind === "build" ? "Сборка" : "Verify",
        topic: ref.topic,
        branch: ref.branch,
        context: ref,
        status: "exited",
        startedAt: "2026-01-01T00:00:00Z",
        workflow: null,
        profile: null,
        output: { text: "synthetic run output", truncated: false },
        ...(kind === "build"
          ? { build: { planPath: "plan.md", clean: false } }
          : {}),
      }),
    );
    expect(screen.getByRole("heading", { name: "Главная" })).toBeTruthy();
    const cards = screen.getAllByRole("button", {
      name: /^Продолжить (Alpha|Beta) ·/,
    });
    expect(cards.map((v) => v.getAttribute("data-recent-project"))).toEqual([
      "beta",
      "alpha",
    ]);
    expect(cards[1].getAttribute("aria-label")).toMatch(/Запуск$/);
    expect(
      screen.queryByRole("button", { name: /^Черновик (конвейера|сборки)/ }),
    ).toBeNull();
    fireEvent.click(cards[1]);
    const selected = await screen.findByRole("tab", { selected: true });
    expect(selected.getAttribute("aria-label") || selected.textContent).toMatch(
      /(Сборка|Verify)/,
    );
    expect(
      screen.queryByRole("tab", { name: /^Нов(ая сборка|ый конвейер)/ }),
    ).toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);
  },
);
