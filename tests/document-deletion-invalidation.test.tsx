import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  openPrototypeDocuments,
  executionButton,
} from "./helpers/prototype-context-fixture";
import { retainedButton } from "./loading-test-helpers";
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
import { EditorView } from "@codemirror/view";
import { App } from "../src/renderer/App";
import { Settings } from "../src/renderer/Settings";
import { ProjectDocuments } from "../src/renderer/ProjectDocuments";
import { ProjectFlatDocuments } from "../src/renderer/ProjectFlatDocuments";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { createDraftStore } from "../src/renderer/task-drafts";
import {
  createSettingsDocuments,
  type DocumentSource,
} from "../src/renderer/settings-documents";
const project = { id: "p", name: "Project", path: "/synthetic/project" };
const source: DocumentSource = {
  scope: "project",
  projectId: "p",
  target: { kind: "tool", tool: "review", path: "env/local.yml" },
};
const profile: DocumentSource = {
  scope: "home",
  kind: "profile",
  name: "personal",
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { resolve, promise };
};
const editor = () => {
  const el = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector('[role="textbox"]');
  return el ? EditorView.findFromDOM(el as HTMLElement)! : null;
};
let store: ReturnType<typeof createSettingsDocuments>;
let api: any;
let discovery: any;
const click = (name: string) =>
  fireEvent.click(
    name === "Запустить"
      ? executionButton()
      : screen.getByRole("button", { name }),
  );
async function remove() {
  click("Удалить");
  await screen.findByRole("dialog");
  click("Переместить в корзину");
  await waitFor(() => expect(api.deleteDocument).toHaveBeenCalled());
}
beforeEach(() => {
  store = createSettingsDocuments();
  discovery = {
    pipelines: [{ id: "run", name: "Run", description: "", project: true }],
    profiles: [{ name: "personal", source: "home" }],
    topics: [
      {
        branch: "main",
        topic: "t",
        current: true,
        remote: false,
        todo: "task",
        statuses: [],
      },
    ],
    branches: ["main"],
    currentBranch: "main",
    workflows: [],
  };
  api = {
    listSettings: vi.fn(async () => ({ profiles: ["personal", "other"] })),
    listProjectTools: vi.fn(async () => [
      {
        name: "review",
        entries: [
          { path: "env", kind: "directory", editable: false },
          { path: "env/local.yml", kind: "file", editable: true },
        ],
      },
    ]),
    listProjectPipelines: vi.fn(async () => [
      { name: "one", path: ".goga/pipelines/one.yml", editable: true },
    ]),
    listProjectWorkflows: vi.fn(async () => [
      { name: "one", path: ".goga/workflows/one.yml", editable: true },
    ]),
    readSettings: vi.fn(async () => ({
      text: "secret: saved\n",
      version: "a".repeat(64),
    })),
    readProjectDocument: vi.fn(async () => ({
      text: "secret: saved\n",
      version: "a".repeat(64),
      exists: true,
      relativePath: ".goga/tools/review/env/local.yml",
    })),
    prepareDocumentDeletion: vi.fn(async () => ({
      token: "ticket",
      name: "local.yml",
      relativePath: ".goga/tools/review/env/local.yml",
    })),
    deleteDocument: vi.fn(async () => ({ status: "trashed" })),
    discover: vi.fn(async () => discovery),
    readTopicTask: vi.fn(async () => ({
      text: "task",
      version: "v1",
      exists: true,
      path: "todo.md",
    })),
    preview: vi.fn(async () => ({
      token: "preview",
      stages: [{ id: "one", title: "One" }],
      profile: null,
      workflow: null,
    })),
    launch: vi.fn(async () => ({ id: "run" })),
    checkoutBranch: vi.fn(async () => "main"),
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  installPrototypeContextFixture(api, [
    { ...project, topic: "t", branch: "main" },
  ]);
  window.goga = api;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
async function tools() {
  render(<ProjectDocuments project={project} tab="tools" store={store} />);
  await screen.findByRole("button", { name: "Папка env" });
  click("Папка env");
  click("Файл env/local.yml");
  click("Открыть редактор");
  await waitFor(() => expect(editor()).not.toBeNull());
  return editor()!;
}
it.each(["uncertain", "catalog-error"])(
  "retains tool editor and expansion on %s refresh with missing catalog file",
  async (outcome) => {
    const view = await tools();
    act(() => view.dispatch({ changes: { from: 0, insert: "# dirty\n" } }));
    api.deleteDocument.mockResolvedValue({
      status: "uncertain",
      message: "Outcome unknown",
    });
    if (outcome === "catalog-error")
      api.listProjectTools.mockRejectedValue(Error("Catalog failed"));
    else
      api.listProjectTools.mockResolvedValue([
        {
          name: "review",
          entries: [{ path: "env", kind: "directory", editable: false }],
        },
      ]);
    await remove();
    await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
    expect(editor()).toBe(view);
    expect(view.state.doc.toString()).toContain("dirty");
    expect(
      screen
        .getByRole("button", { name: "Папка env" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  },
);
it("successful last tool-file deletion clears only its selection without changing expansion", async () => {
  await tools();
  store.createPipeline("p", "keep", []);
  api.listProjectTools.mockResolvedValue([
    {
      name: "review",
      entries: [{ path: "env", kind: "directory", editable: false }],
    },
  ]);
  await remove();
  await waitFor(() => expect(editor()).toBeNull());
  expect(
    screen
      .getByRole("button", { name: "Папка env" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen.getAllByRole("heading", { name: "Выберите файл" }),
  ).toHaveLength(1);
  expect(store.pipelineState("p").drafts).toEqual(["keep"]);
});
it("profiles refresh after success without selecting another profile or dropping unrelated draft", async () => {
  store.createProfile("draft");
  render(<Settings documents={store} />);
  await waitFor(() => expect(api.listSettings).toHaveBeenCalled());
  click("Профили");
  api.listSettings.mockResolvedValue({ profiles: ["other"] });
  await remove();
  await waitFor(() => expect(api.listSettings).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("button", { name: "personal" })).toBeNull();
  expect(screen.getByRole("button", { name: "draft" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "other" }).getAttribute("aria-pressed"),
  ).toBe("false");
});
it("old profile-list responses cannot revive a deleted memory profile", async () => {
  const old = deferred<any>();
  api.listSettings
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ profiles: [] });
  store.createProfile("personal");
  render(<Settings documents={store} />);
  click("Профили");
  expect(screen.queryByRole("button", { name: "personal" })).toBeNull();
  // A background store mutation must invalidate a catalog still being read.
  await act(async () => {
    await store.prepareDeletion(profile);
    await store.delete(profile, store.get(profile).deletion!);
  });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "personal" })).toBeNull(),
  );
  expect(api.listSettings).toHaveBeenCalledTimes(1);
  await act(async () => old.resolve({ profiles: ["personal"] }));
  expect(screen.queryByRole("button", { name: "personal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
});
it.each(["workflow", "pipeline"] as const)(
  "flat %s deletion retains unrelated drafts and clears only matching selection",
  async (kind) => {
    if (kind === "pipeline") store.createPipeline("p", "keep", []);
    else store.createWorkflow("p", "keep", []);
    render(
      <ProjectFlatDocuments kind={kind} project={project} store={store} />,
    );
    await screen.findByRole("button", { name: `Файл .goga/${kind}s/one.yml` });
    click(`Файл .goga/${kind}s/one.yml`);
    api[
      kind === "pipeline" ? "listProjectPipelines" : "listProjectWorkflows"
    ].mockResolvedValue([]);
    await remove();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `Файл .goga/${kind}s/one.yml` }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("button", { name: `Файл .goga/${kind}s/keep.yml` }),
    ).toBeTruthy();
    expect(
      (kind === "pipeline" ? store.pipelineState : store.workflowState)("p")
        .selected,
    ).toBe("");
  },
);
const launch = (revision: string, drafts = createDraftStore()) => (
  <LaunchForm
    project={project}
    draftStore={drafts}
    settingsRevision={revision}
    onCancel={() => {}}
    onLaunched={() => {}}
  />
);
async function ready() {
  await waitFor(() => expect(api.preview).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText("проверяем…")).toBeNull());
}
it.each(["explicit", "default"])(
  "missing %s profile publishes fresh catalog and blocks preparation rather than fallback",
  async (kind) => {
    if (kind === "default")
      discovery.projectSettings = {
        version: "s1",
        profile: "personal",
        executable: "goga",
      };
    const ui = render(launch("1"));
    await ready();
    if (kind === "explicit") {
      fireEvent.change(screen.getByLabelText("Профиль"), {
        target: { value: "personal" },
      });
      await ready();
    }
    const before = api.preview.mock.calls.length;
    discovery = { ...discovery, profiles: [] };
    ui.rerender(launch("2"));
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    await screen.findByRole("option", { name: /personal.*не найден/ });
    expect(api.preview).toHaveBeenCalledTimes(before);
    expect((screen.getByLabelText("Профиль") as HTMLSelectElement).value).toBe(
      kind === "explicit" ? "personal" : "",
    );
    expect(
      screen
        .getByRole("button", { name: /Запустить/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  },
);
it("explicit profile survives launch unmount and remains missing after deletion", async () => {
  const drafts = createDraftStore();
  const ui = render(launch("1", drafts));
  await ready();
  fireEvent.change(screen.getByLabelText("Профиль"), {
    target: { value: "personal" },
  });
  await waitFor(() => expect(drafts.forms.get("p")?.profile).toBe("personal"));
  ui.unmount();
  api.preview.mockClear();
  discovery = { ...discovery, profiles: [] };
  render(launch("2", drafts));
  await screen.findByRole("option", { name: /personal.*не найден/ });
  expect((screen.getByLabelText("Профиль") as HTMLSelectElement).value).toBe(
    "personal",
  );
  expect(api.preview).not.toHaveBeenCalled();
});
it("same-id installed pipeline rediscovery replaces old project preview", async () => {
  const ui = render(launch("1"));
  await ready();
  const pending = deferred<any>();
  api.preview.mockReturnValueOnce(pending.promise);
  discovery = {
    ...discovery,
    pipelines: [
      { id: "run", name: "Installed Run", project: false, description: "" },
    ],
  };
  ui.rerender(launch("2"));
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole("option", { name: "run" })).toBeNull();
  expect(screen.getByRole("status").getAttribute("aria-label")).toContain(
    "Загружаем",
  );
  expect(screen.getByRole("status").textContent).toBe("");
  expect(retainedButton(/Запустить/).hasAttribute("disabled")).toBe(true);
  await act(async () =>
    pending.resolve({
      token: "replacement",
      stages: [{ id: "new", title: "Replacement" }],
      profile: null,
      workflow: null,
    }),
  );
  await waitFor(() => expect(api.preview.mock.calls.length).toBeGreaterThan(1));
  expect(api.preview.mock.calls.at(-1)[0].pipeline).toBe("run");
});
it("tool file recreated after successful deletion can be explicitly selected again", async () => {
  await tools();
  api.listProjectTools.mockResolvedValue([
    {
      name: "review",
      entries: [
        { path: "env", kind: "directory", editable: false },
        { path: "env/local.yml", kind: "file", editable: true },
      ],
    },
  ]);
  await remove();
  await waitFor(() => expect(editor()).toBeNull());
  click("Файл env/local.yml");
  expect(screen.getByRole("button", { name: "Открыть редактор" })).toBeTruthy();
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
});
it("deleting a workflow frees its pipeline-name suggestion without changing typed name", async () => {
  api.listWorkflowSuggestions = vi.fn(async () => [
    { id: "one", name: "Pipeline One", project: true, description: "" },
  ]);
  render(
    <ProjectFlatDocuments kind="workflow" project={project} store={store} />,
  );
  await screen.findByRole("button", { name: "Файл .goga/workflows/one.yml" });
  click("Создать рабочий процесс");
  const input = screen.getByRole("combobox", { name: "Имя рабочего процесса" });
  fireEvent.focus(input);
  await waitFor(() => expect(api.listWorkflowSuggestions).toHaveBeenCalled());
  expect(screen.queryByRole("option", { name: /Pipeline One/ })).toBeNull();
  click("Файл .goga/workflows/one.yml");
  api.listProjectWorkflows.mockResolvedValue([]);
  await remove();
  fireEvent.focus(input);
  await screen.findByRole("option", { name: /Pipeline One/ });
  expect((input as HTMLInputElement).value).toBe("");
  expect(api.listWorkflowSuggestions).toHaveBeenCalledTimes(2);
});
it.each(["profile", "pipeline", "workflow"] as const)(
  "memory-only %s deletion does not cause indirect catalog or preview IPC",
  async (kind) => {
    if (kind === "profile") {
      api.listSettings.mockResolvedValue({ profiles: [] });
      store.createProfile("new");
      render(<Settings documents={store} />);
      await waitFor(() => expect(api.listSettings).toHaveBeenCalledTimes(1));
      click("Профили");
      click("new");
    } else {
      api[
        kind === "pipeline" ? "listProjectPipelines" : "listProjectWorkflows"
      ].mockResolvedValue([]);
      if (kind === "pipeline") store.createPipeline("p", "new", []);
      else store.createWorkflow("p", "new", []);
      render(
        <ProjectFlatDocuments kind={kind} project={project} store={store} />,
      );
      await waitFor(() =>
        expect(
          api[
            kind === "pipeline"
              ? "listProjectPipelines"
              : "listProjectWorkflows"
          ],
        ).toHaveBeenCalledTimes(1),
      );
    }
    vi.clearAllMocks();
    click("Удалить черновик");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(dialog.querySelector("button[data-confirm-delete]")!);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
    expect(store.homeRevision()).toBe(0);
    expect(store.projectRevision("p")).toBe(0);
  },
);
it("stale disk profile catalog cannot revive a deleted existing profile", async () => {
  await store.open(profile);
  const old = deferred<any>();
  api.listSettings
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue({ profiles: ["other"] });
  render(<Settings documents={store} />);
  click("Профили");
  expect(screen.queryByRole("button", { name: "personal" })).toBeNull();
  await act(async () => {
    await store.prepareDeletion(profile);
    await store.delete(profile, store.get(profile).deletion!);
  });
  await waitFor(() => expect(api.listSettings).toHaveBeenCalledTimes(2));
  await act(async () => old.resolve({ profiles: ["personal", "old-only"] }));
  expect(screen.queryByRole("button", { name: "personal" })).toBeNull();
  expect(screen.queryByRole("button", { name: "old-only" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "other" }).getAttribute("aria-pressed"),
  ).toBe("false");
});
function appApi() {
  Object.assign(api, {
    listProjects: vi.fn(async () => [project]),
    runs: vi.fn(async () => []),
    onRuns: vi.fn(() => () => {}),
    onFocusRun: vi.fn(() => () => {}),
    onViewError: vi.fn(() => () => {}),
    selectRun: vi.fn(async () => {}),
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "s1",
      profiles: [],
    })),
  });
}
it.each(["trashed", "uncertain", "bridge-error"])(
  "App invalidates hidden launch preview after tool delete %s and retains task",
  async (status) => {
    appApi();
    render(<App />);
    await openPrototypeLaunch();
    await ready();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
          .value,
      ).toBe("task"),
    );
    fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
      target: { value: "retained task" },
    });
    await openPrototypeDocuments();
    click("Инструменты");
    await screen.findByRole("button", { name: "Папка env" });
    click("Папка env");
    click("Файл env/local.yml");
    const fresh = deferred<any>();
    api.discover.mockReturnValueOnce(fresh.promise);
    if (status === "bridge-error")
      api.deleteDocument.mockRejectedValue(Error("bridge failed"));
    else
      api.deleteDocument.mockResolvedValue(
        status === "trashed" ? { status } : { status, message: "uncertain" },
      );
    await remove();
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    if (screen.queryByRole("button", { name: "← Назад" }))
      fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
    else await openPrototypeLaunch();
    expect(
      retainedButton("Сохранить и запустить").hasAttribute("disabled"),
    ).toBe(true);
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("retained task");
    await act(async () => fresh.resolve(discovery));
    await ready();
    expect(api.launch).not.toHaveBeenCalled();
  },
);
it("App preserves explicit profile through global settings deletion with the launch retained", async () => {
  appApi();
  render(<App />);
  await openPrototypeLaunch();
  await ready();
  fireEvent.change(screen.getByLabelText("Профиль"), {
    target: { value: "personal" },
  });
  await ready();
  click("Настройки");
  await waitFor(() => expect(api.listSettings).toHaveBeenCalled());
  click("Профили");
  api.listSettings.mockResolvedValue({ profiles: ["other"] });
  // The file is absent when deletion publishes its revision. A retained hidden
  // launch can refresh immediately; do not change the mock catalog afterwards.
  discovery = { ...discovery, profiles: [] };
  api.preview.mockClear();
  const readsBeforeDeletion = api.discover.mock.calls.length;
  await remove();
  await waitFor(() =>
    expect(api.discover).toHaveBeenCalledTimes(readsBeforeDeletion + 1),
  );
  if (screen.queryByRole("button", { name: "← Назад" }))
    fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
  else await openPrototypeLaunch();
  await openPrototypeLaunch();
  await screen.findByRole("option", { name: /personal.*не найден/ });
  expect((screen.getByLabelText("Профиль") as HTMLSelectElement).value).toBe(
    "personal",
  );
  expect(api.preview).not.toHaveBeenCalled();
});
it("fresh profile catalog can expose an externally restored profile for explicit selection", async () => {
  render(<Settings documents={store} />);
  await waitFor(() => expect(api.listSettings).toHaveBeenCalled());
  click("Профили");
  await remove();
  await waitFor(() => expect(api.listSettings).toHaveBeenCalledTimes(2));
  const restored = await screen.findByRole("button", { name: "personal" });
  expect(restored.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(restored);
  expect(screen.getByRole("button", { name: "Открыть редактор" })).toBeTruthy();
  expect(api.readSettings).not.toHaveBeenCalled();
});
it.each(["workflow", "pipeline"] as const)(
  "hidden %s selection retains deletion error when refreshed catalog marks it unavailable",
  async (kind) => {
    render(
      <ProjectFlatDocuments kind={kind} project={project} store={store} />,
    );
    await screen.findByRole("button", { name: `Файл .goga/${kind}s/one.yml` });
    click(`Файл .goga/${kind}s/one.yml`);
    api.deleteDocument.mockResolvedValue({
      status: "uncertain",
      message: "Outcome unknown",
    });
    api[
      kind === "pipeline" ? "listProjectPipelines" : "listProjectWorkflows"
    ].mockResolvedValue([
      {
        name: "one",
        path: `.goga/${kind}s/one.yml`,
        editable: false,
        reason: "File changed externally",
      },
    ]);
    await remove();
    await waitFor(() =>
      expect(
        api[
          kind === "pipeline" ? "listProjectPipelines" : "listProjectWorkflows"
        ],
      ).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText("Outcome unknown")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Открыть редактор" }),
    ).toBeTruthy();
    expect(api.readProjectDocument).not.toHaveBeenCalled();
  },
);

it.each(["save", "delete"] as const)(
  "project profile %s refreshes launch source without losing selected profile or task",
  async (action) => {
    appApi();
    api.listProjectProfiles = vi.fn(async () => [
      { name: "personal", path: ".goga/profiles/personal.yml", editable: true },
    ]);
    api.saveProjectDocument = vi.fn(
      async (_id: string, _target: unknown, text: string) => ({
        text,
        version: "b".repeat(64),
        exists: true,
        relativePath: ".goga/profiles/personal.yml",
      }),
    );
    discovery = {
      ...discovery,
      profiles: [
        { name: "personal", source: action === "save" ? "home" : "project" },
      ],
    };
    render(<App />);
    await openPrototypeLaunch();
    await ready();
    fireEvent.change(screen.getByLabelText("Профиль"), {
      target: { value: "personal" },
    });
    await ready();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
          .value,
      ).toBe("task"),
    );
    fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
      target: { value: "unsaved launch task" },
    });
    await openPrototypeDocuments();
    click("Профили");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Файл .goga/profiles/personal.yml",
      }),
    );
    const before = api.discover.mock.calls.length;
    discovery = {
      ...discovery,
      profiles: [
        { name: "personal", source: action === "save" ? "project" : "home" },
      ],
    };
    if (action === "save") {
      click("Открыть редактор");
      await waitFor(() => expect(editor()).not.toBeNull());
      click("Сохранить");
      await waitFor(() => expect(api.saveProjectDocument).toHaveBeenCalled());
    } else await remove();
    await waitFor(() =>
      expect(api.discover.mock.calls.length).toBeGreaterThan(before),
    );
    if (screen.queryByRole("button", { name: "← Назад" }))
      fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
    else await openPrototypeLaunch();
    await ready();
    expect((screen.getByLabelText("Профиль") as HTMLSelectElement).value).toBe(
      "personal",
    );
    expect(
      screen.getByRole("option", {
        name: action === "save" ? "personal · проектный" : "personal · личный",
      }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("unsaved launch task");
    expect(api.launch).not.toHaveBeenCalled();
  },
);
