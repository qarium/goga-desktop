import { openCatalog, selectCatalog } from "./helpers/select-catalog";
import "./helpers/overview-browser-fixture";
import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  openPrototypeDocuments,
  executionButton,
  retainedExecutionButton,
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
import { ProjectSettings } from "../src/renderer/ProjectSettings";
import {
  createSettingsDocuments,
  documentKey,
} from "../src/renderer/settings-documents";
const project = { id: "p", name: "Alpha", path: "/synthetic/alpha" };
const other = { id: "q", name: "Beta", path: "/synthetic/beta" };
const raw =
  "\uFEFF# комментарий 🙂\r\n{% if profile %}\r\nvalue: {{ profile.value }}\r\n{% endif %}\r\n";
const workflow = (name: string, editable = true) => ({
  name,
  path: `.goga/workflows/${name}.yml`,
  editable,
  ...(!editable ? { reason: "Символическая ссылка" } : {}),
});
let api: any;
const editor = () => {
  const el = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector('[role="textbox"]');
  return el ? EditorView.findFromDOM(el as HTMLElement)! : null;
};
function click(name: string) {
  fireEvent.click(
    name === "Запустить"
      ? executionButton()
      : screen.getByRole("button", { name }),
  );
}
function changeName(name: string) {
  fireEvent.change(screen.getByLabelText("Имя рабочего процесса"), {
    target: { value: name },
  });
}
async function openSettings(primary = false) {
  if (
    primary &&
    screen.queryByRole("button", { name: /^Открыть карточку топика / })
  ) {
    fireEvent.click(
      screen.getByRole("button", { name: "Выбрать другой топик" }),
    );
    fireEvent.click(screen.getByRole("row", { name: /^Без топика / }));
  }
  if (!primary && document.querySelector(".launch-panel"))
    await openPrototypeDocuments();
  else {
    click("Проект");
    await screen.findByRole("heading", { name: "Проект" });
  }
  click("Рабочие процессы");
  await waitFor(() => expect(api.listProjectWorkflows).toHaveBeenCalled());
}
async function setup() {
  render(<App />);
  await screen.findByRole("button", { name: "Проект" });
  await openSettings();
}
async function create(name: string) {
  click("Создать рабочий процесс");
  changeName(name);
  click("Создать черновик");
  await waitFor(() => expect(editor()).not.toBeNull());
}
async function reveal(name: string) {
  click(`Файл .goga/workflows/${name}.yml`);
  click("Открыть редактор");
  await waitFor(() => expect(editor()).not.toBeNull());
}
function replace(text: string) {
  act(() => {
    const view = editor()!;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
}
beforeEach(() => {
  api = {
    listProjects: vi.fn(async () => [project, other]),
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
    listProjectTools: vi.fn(async () => []),
    listProjectWorkflows: vi.fn(async () => [
      workflow("existing"),
      workflow("blocked", false),
    ]),
    readProjectDocument: vi.fn(async (_id, t) => ({
      text: raw,
      version: `v-${t.name}`,
      exists: true,
      relativePath: workflow(t.name).path,
    })),
    saveProjectDocument: vi.fn(async (_id, t, text) => ({
      text,
      version: "saved",
      exists: true,
      relativePath: workflow(t.name).path,
    })),
    discover: vi.fn(async () => ({
      pipelines: [{ id: "run", name: "Run", description: "", project: true }],
      workflows: ["existing"],
      profiles: [],
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
      baseRef: "main",
    })),
    preview: vi.fn(async () => ({
      token: "fresh",
      stages: [{ id: "one", title: "One" }],
      workflow: null,
      profile: null,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "task",
      exists: true,
      version: "t1",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    launch: vi.fn(async (request) => ({
      id: "run",
      projectId: request.projectId,
      kind: "pipeline",
      pipeline: request.pipeline,
      topic: request.context?.topic ?? request.topic.topic,
      branch: request.context?.branch ?? request.topic.branch,
      context: request.context,
      status: "exited",
      startedAt: "now",
      workflow: null,
      profile: null,
    })),
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  installPrototypeContextFixture(api, [
    { ...project, topic: "t", branch: "main" },
    { ...other, topic: "t", branch: "main" },
  ]);
  window.goga = api;
});
afterEach(cleanup);
it("lists real workflow files, protects unsupported files and reveals exact raw source explicitly", async () => {
  await setup();
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: "Файл .goga/workflows/blocked.yml",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText("Символическая ссылка")).toBeTruthy();
  await reveal("existing");
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(screen.getByText(".goga/workflows/existing.yml")).toBeTruthy();
  expect(screen.getByText("YAML / Jinja")).toBeTruthy();
  expect(
    screen.getByText(/Goga проверяет рабочий процесс после рендеринга/),
  ).toBeTruthy();
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "workflow", name: "existing" },
      raw,
      "v-existing",
    ),
  );
});
it("creates absent workflow entirely in memory until explicit Save, then refreshes catalog", async () => {
  api.listProjectWorkflows.mockResolvedValue([]);
  await setup();
  await screen.findByText("В проекте пока нет рабочих процессов");
  await create("new-flow");
  expect(editor()!.state.doc.toString()).toBe("");
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
  replace(raw);
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "workflow", name: "new-flow" },
      raw,
      "missing",
    ),
  );
  await waitFor(() =>
    expect(api.listProjectWorkflows.mock.calls.length).toBeGreaterThan(1),
  );
});
it("retains named drafts and unfinished name across tabs, Back, and project switching", async () => {
  await setup();
  await create("draft");
  replace(raw);
  click("Создать рабочий процесс");
  changeName("unfinished");
  click("Конфигурация");
  click("Рабочие процессы");
  expect(
    (screen.getByLabelText("Имя рабочего процесса") as HTMLInputElement).value,
  ).toBe("unfinished");
  await openPrototypeLaunch();
  await openSettings(true);
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(
    (screen.getByLabelText("Имя рабочего процесса") as HTMLInputElement).value,
  ).toBe("unfinished");
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  await openSettings(true);
  await create("draft");
  replace("# beta");
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  await openSettings(true);
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(
    (screen.getByLabelText("Имя рабочего процесса") as HTMLInputElement).value,
  ).toBe("unfinished");
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
});
it.each([
  ["ß", "ss"],
  ["Σ", "ς"],
  ["ﬀ", "ff"],
  ["É", "e\u0301"],
  ["Flow", "flow"],
])("rejects alias %s / %s against disk and drafts", async (a, b) => {
  api.listProjectWorkflows.mockResolvedValue([workflow(a)]);
  await setup();
  click("Создать рабочий процесс");
  changeName(b);
  click("Создать черновик");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(editor()).toBeNull();
  cleanup();
  api.listProjectWorkflows.mockResolvedValue([]);
  await setup();
  await create(a);
  replace(raw);
  click("Создать рабочий процесс");
  changeName(b);
  click("Создать черновик");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
});
it("retains usable draft when catalog refresh fails and save conflict preserves text/version", async () => {
  await setup();
  await create("draft");
  replace(raw);
  api.listProjectWorkflows.mockRejectedValue(Error("catalog unavailable"));
  click("Конфигурация");
  click("Рабочие процессы");
  await screen.findByText("catalog unavailable");
  expect(editor()!.state.doc.toString()).toBe(raw);
  api.saveProjectDocument.mockRejectedValueOnce(
    Error("Файл изменился вне приложения"),
  );
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await screen.findByText("Файл изменился вне приложения");
  expect(editor()!.state.doc.toString()).toBe(raw);
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
      "p",
      { kind: "workflow", name: "draft" },
      raw,
      "missing",
    ),
  );
});
it("keeps pending reads and failed saves bound to their captured workflow", async () => {
  let finish!: (v: any) => void;
  api.readProjectDocument.mockImplementationOnce(
    () => new Promise((r) => (finish = r)),
  );
  await setup();
  click("Файл .goga/workflows/existing.yml");
  click("Открыть редактор");
  await create("another");
  replace("# another");
  await act(async () =>
    finish({
      text: raw,
      version: "original",
      exists: true,
      relativePath: workflow("existing").path,
    }),
  );
  expect(editor()!.state.doc.toString()).toBe("# another");
  let fail!: (e: Error) => void;
  api.saveProjectDocument.mockImplementationOnce(
    () => new Promise((_r, j) => (fail = j)),
  );
  click("Файл .goga/workflows/existing.yml");
  replace(raw + "# change");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  click("Файл .goga/workflows/another.yml");
  await act(async () => fail(Error("conflict")));
  expect(editor()!.state.doc.toString()).toBe("# another");
  click("Файл .goga/workflows/existing.yml");
  expect(screen.getByText("conflict")).toBeTruthy();
  expect(editor()!.state.doc.toString()).toBe(raw + "# change");
});
it("keys workflow by project, name and full relative path, distinct from config/tools", () => {
  const key = documentKey({
    scope: "project",
    projectId: "p",
    target: { kind: "workflow", name: "flow" },
  });
  expect(key).toContain(".goga/workflows/flow.yml");
  expect(key).not.toBe(
    documentKey({
      scope: "project",
      projectId: "q",
      target: { kind: "workflow", name: "flow" },
    }),
  );
  expect(key).not.toBe(
    documentKey({
      scope: "project",
      projectId: "p",
      target: { kind: "workflow", name: "other" },
    }),
  );
});
it("retains workflow state through actual settings component remount", async () => {
  const store = createSettingsDocuments();
  const props = {
    project,
    documents: store,
    onBack: () => {},
    onSaved: () => {},
    guard: { current: null },
    onBusy: () => {},
  };
  const first = render(<ProjectSettings {...props} />);
  click("Рабочие процессы");
  await screen.findByRole("button", {
    name: "Файл .goga/workflows/existing.yml",
  });
  await create("retained");
  replace(raw);
  click("Создать рабочий процесс");
  changeName("typing");
  first.unmount();
  render(<ProjectSettings {...props} />);
  click("Рабочие процессы");
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(
    (screen.getByLabelText("Имя рабочего процесса") as HTMLInputElement).value,
  ).toBe("typing");
});
it("refreshes App launch discovery only after successful save and rejects a pending stale preview", async () => {
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /One/ });
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("task"),
  );
  let stale!: (v: any) => void;
  api.preview.mockImplementationOnce(() => new Promise((r) => (stale = r)));
  selectCatalog(screen.getByLabelText("Рабочий процесс"), "file:existing");
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  await openSettings();
  await create("new-flow");
  replace(raw);
  api.saveProjectDocument.mockRejectedValueOnce(Error("conflict"));
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await screen.findByText("conflict");
  expect(api.discover).toHaveBeenCalledTimes(1);
  const fresh = {
    ...(await api.discover.mock.results[0].value),
    workflows: ["existing", "new-flow"],
  };
  let discover!: (v: any) => void;
  api.discover.mockImplementationOnce(() => new Promise((r) => (discover = r)));
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  await openPrototypeLaunch();
  await act(async () =>
    stale({
      token: "stale",
      workflow: "old",
      profile: null,
      stages: [{ id: "old", title: "Obsolete" }],
    }),
  );
  expect((retainedExecutionButton() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText("Obsolete")).toBeNull();
  await act(async () => discover(fresh));
  openCatalog(await screen.findByRole("combobox", { name: "Рабочий процесс" }));
  await screen.findByRole("option", { name: /new-flow/ });
  await waitFor(() => expect(screen.queryByText("проверяем…")).toBeNull());
  expect(
    screen.queryByRole("checkbox", { name: /Подтверждаю.*запуск/ }),
  ).toBeNull();
  expect(
    (screen.getByLabelText("Рабочий процесс") as HTMLButtonElement).value,
  ).toBe("file:existing");
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  click("Запустить");
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({ previewToken: "fresh" }),
    ),
  );
});
it("can retry a failed workflow read without affecting a separate draft", async () => {
  api.readProjectDocument.mockRejectedValueOnce(Error("read denied"));
  await setup();
  click("Файл .goga/workflows/existing.yml");
  click("Открыть редактор");
  await screen.findByText("read denied");
  await create("safe");
  replace(raw);
  click("Файл .goga/workflows/existing.yml");
  click("Повторить загрузку");
  await waitFor(() => expect(editor()).not.toBeNull());
  click("Файл .goga/workflows/safe.yml");
  expect(editor()!.state.doc.toString()).toBe(raw);
});
it("never overwrites an opened existing draft removed externally and keeps it selectable", async () => {
  await setup();
  await reveal("existing");
  replace(raw + "# retained");
  api.listProjectWorkflows.mockResolvedValue([]);
  click("Конфигурация");
  click("Рабочие процессы");
  await waitFor(() =>
    expect(api.listProjectWorkflows).toHaveBeenCalledTimes(2),
  );
  click("Создать рабочий процесс");
  changeName("EXISTING");
  click("Создать черновик");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(editor()!.state.doc.toString()).toBe(raw + "# retained");
  changeName("existing");
  click("Создать черновик");
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(editor()!.state.doc.toString()).toBe(raw + "# retained");
  changeName("another");
  click("Создать черновик");
  click("Файл .goga/workflows/existing.yml");
  expect(editor()!.state.doc.toString()).toBe(raw + "# retained");
});
it("compares actual catalog filenames for aliases and displays unsupported filenames without invented extensions", async () => {
  api.listProjectWorkflows.mockResolvedValue([
    {
      name: "Build.YML",
      path: ".goga/workflows/Build.YML",
      editable: false,
      reason: "Не .yml",
    },
    {
      name: "README.txt",
      path: ".goga/workflows/README.txt",
      editable: false,
      reason: "Не .yml",
    },
  ]);
  await setup();
  await screen.findByText("README.txt");
  expect(screen.queryByText("README.txt.yml")).toBeNull();
  click("Создать рабочий процесс");
  changeName("build");
  click("Создать черновик");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(editor()).toBeNull();
});
it("selects and retains the exact workflow path when unsupported file shares its catalog name", async () => {
  api.listProjectWorkflows.mockResolvedValue([
    {
      name: "README.md",
      path: ".goga/workflows/README.md",
      editable: false,
      reason: "Не .yml",
    },
    workflow("README.md"),
  ]);
  await setup();
  const unsupported = await screen.findByRole("button", {
    name: "Файл .goga/workflows/README.md",
  });
  await reveal("README.md");
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(unsupported.getAttribute("aria-pressed")).toBe("false");
  expect(
    screen
      .getByRole("button", { name: "Файл .goga/workflows/README.md.yml" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  replace(raw + "# draft");
  api.listProjectWorkflows.mockResolvedValue([
    {
      name: "README.md",
      path: ".goga/workflows/README.md",
      editable: false,
      reason: "Не .yml",
    },
  ]);
  click("Конфигурация");
  click("Рабочие процессы");
  await waitFor(() =>
    expect(api.listProjectWorkflows).toHaveBeenCalledTimes(2),
  );
  await create("another");
  click("Файл .goga/workflows/README.md.yml");
  expect(editor()!.state.doc.toString()).toBe(raw + "# draft");
  expect(
    screen
      .getByRole("button", { name: "Файл .goga/workflows/README.md" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});
it("keeps a loaded draft selectable when its exact file becomes unsupported, without enabling unsupported siblings", async () => {
  api.listProjectWorkflows.mockResolvedValue([workflow("README.md")]);
  await setup();
  await reveal("README.md");
  replace(raw + "# retained");
  const reason = "Файл больше не является текстовым";
  api.listProjectWorkflows.mockResolvedValue([
    {
      name: "README.md",
      path: ".goga/workflows/README.md",
      editable: false,
      reason,
    },
    { ...workflow("README.md"), editable: false, reason },
    workflow("blocked", false),
  ]);
  click("Конфигурация");
  click("Рабочие процессы");
  await waitFor(() =>
    expect(api.listProjectWorkflows).toHaveBeenCalledTimes(2),
  );
  await create("other");
  const retained = screen.getByRole("button", {
    name: "Файл .goga/workflows/README.md.yml",
  }) as HTMLButtonElement;
  expect(retained.disabled).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Файл .goga/workflows/README.md",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Файл .goga/workflows/blocked.yml",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(retained);
  expect(editor()!.state.doc.toString()).toBe(raw + "# retained");
  expect(screen.getByText(/Черновик сохранён в памяти/).textContent).toContain(
    reason,
  );
  api.saveProjectDocument.mockRejectedValueOnce(Error("write denied"));
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await screen.findByText("write denied");
  click("Файл .goga/workflows/other.yml");
  click("Файл .goga/workflows/README.md.yml");
  expect(editor()!.state.doc.toString()).toBe(raw + "# retained");
  expect(screen.getByText("write denied")).toBeTruthy();
  expect(api.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    { kind: "workflow", name: "README.md" },
    raw + "# retained",
    "v-README.md",
  );
});
it.each(["success", "failure"])(
  "ignores stale initial discovery %s after a workflow save refresh",
  async (outcome) => {
    const original = await api.discover();
    api.discover.mockClear();
    let finish!: (value: any) => void, fail!: (error: Error) => void;
    api.discover.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    api.discover.mockResolvedValue({
      ...original,
      workflows: ["existing", "new-flow"],
    });
    render(<App />);
    await openPrototypeLaunch();
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(1));
    await openSettings();
    await create("new-flow");
    replace(raw);
    await screen.findByRole("button", { name: "Сохранить" });
    click("Сохранить");
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    await openPrototypeLaunch();
    openCatalog(
      await screen.findByRole("combobox", { name: "Рабочий процесс" }),
    );
    await screen.findByRole("option", { name: /new-flow/ });
    await act(async () => {
      if (outcome === "success") finish(original);
      else fail(Error("stale discovery failure"));
    });
    expect(screen.queryByRole("option", { name: /new-flow/ })).not.toBeNull();
    expect(screen.queryByText("stale discovery failure")).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Сбросить" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  },
);
it("releases the discovery lock if refresh supersedes a pending initial discovery and fails", async () => {
  api.discover.mockImplementationOnce(() => new Promise(() => {}));
  api.discover.mockRejectedValue(Error("fresh catalog unavailable"));
  render(<App />);
  await openPrototypeLaunch();
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(1));
  await openSettings();
  await create("new-flow");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  await openPrototypeLaunch();
  await screen.findByText("fresh catalog unavailable");
  click("Сбросить");
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
});
it("supersedes an older Reset discovery when workflow saving starts a refresh", async () => {
  const original = await api.discover();
  api.discover.mockClear();
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /One/ });
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("task"),
  );
  let reset!: (value: any) => void, refresh!: (value: any) => void;
  api.discover.mockImplementationOnce(() => new Promise((r) => (reset = r)));
  click("Сбросить");
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  await openSettings();
  await create("new-flow");
  api.discover.mockImplementationOnce(() => new Promise((r) => (refresh = r)));
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
  await openPrototypeLaunch();
  await act(async () => reset(original));
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  fireEvent.click(retainedButton("Сбросить"));
  expect(api.discover).toHaveBeenCalledTimes(3);
  await act(async () =>
    refresh({ ...original, workflows: ["existing", "new-flow"] }),
  );
  openCatalog(await screen.findByRole("combobox", { name: "Рабочий процесс" }));
  await screen.findByRole("option", { name: /new-flow/ });
});
