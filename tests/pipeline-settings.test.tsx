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
import { LaunchForm } from "../src/renderer/LaunchForm";
import { ProjectSettings } from "../src/renderer/ProjectSettings";
import {
  createSettingsDocuments,
  documentKey,
} from "../src/renderer/settings-documents";
const project = { id: "p", name: "Alpha", path: "/synthetic/alpha" };
const other = { id: "q", name: "Beta", path: "/synthetic/beta" };
const raw =
  "\uFEFFname: Обзор 🙂\r\ndescription: Точный источник\r\n---\r\n# комментарий\r\n- id: review\r\n  unknown: [custom, value]\r\n";
const pipeline = (name: string, editable = true) => ({
  name,
  path: `.goga/pipelines/${name}.yml`,
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
  fireEvent.change(screen.getByRole("textbox", { name: "Имя конвейера" }), {
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
  click("Конвейеры");
  await waitFor(() => expect(api.listProjectPipelines).toHaveBeenCalled());
}
async function setup() {
  render(<App />);
  await screen.findByRole("button", { name: "Проект" });
  await openSettings();
}
async function create(name: string) {
  click("Создать конвейер");
  changeName(name);
  click("Создать черновик");
  await waitFor(() => expect(editor()).not.toBeNull());
}
async function reveal(name: string) {
  click(`Файл .goga/pipelines/${name}.yml`);
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
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
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
    listProjectPipelines: vi.fn(async () => [
      pipeline("existing"),
      pipeline("blocked", false),
    ]),
    readProjectDocument: vi.fn(async (_id, t) => ({
      text: raw,
      version: `v-${t.name}`,
      exists: true,
      relativePath: pipeline(t.name).path,
    })),
    saveProjectDocument: vi.fn(async (_id, t, text) => ({
      text,
      version: "saved",
      exists: true,
      relativePath: pipeline(t.name).path,
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
it("lists real pipeline files, protects unsupported files and reveals exact raw source explicitly", async () => {
  await setup();
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("button", {
        name: "Файл .goga/pipelines/blocked.yml",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText("Символическая ссылка")).toBeTruthy();
  await reveal("existing");
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(screen.getByText(".goga/pipelines/existing.yml")).toBeTruthy();
  expect(screen.getByText("YAML")).toBeTruthy();
  expect(
    screen.getByText(/Сохранение не гарантирует возможность запуска/),
  ).toBeTruthy();
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "pipeline", name: "existing" },
      raw,
      "v-existing",
    ),
  );
});
it("creates absent pipeline entirely in memory until explicit Save, then refreshes catalog", async () => {
  api.listProjectPipelines.mockResolvedValue([]);
  await setup();
  await screen.findByText("В проекте пока нет конвейеров");
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
      { kind: "pipeline", name: "new-flow" },
      raw,
      "missing",
    ),
  );
  await waitFor(() =>
    expect(api.listProjectPipelines.mock.calls.length).toBeGreaterThan(1),
  );
});
it("retains named drafts and unfinished name across tabs, Back, and project switching", async () => {
  await setup();
  await create("draft");
  replace(raw);
  click("Создать конвейер");
  changeName("unfinished");
  click("Конфигурация");
  click("Конвейеры");
  expect(
    (screen.getByLabelText("Имя конвейера") as HTMLInputElement).value,
  ).toBe("unfinished");
  await openPrototypeLaunch();
  await openSettings(true);
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(
    (screen.getByLabelText("Имя конвейера") as HTMLInputElement).value,
  ).toBe("unfinished");
  fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
  await openSettings(true);
  await create("draft");
  replace("# beta");
  fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
  await openSettings(true);
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(
    (screen.getByLabelText("Имя конвейера") as HTMLInputElement).value,
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
  api.listProjectPipelines.mockResolvedValue([pipeline(a)]);
  await setup();
  click("Создать конвейер");
  changeName(b);
  click("Создать черновик");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(editor()).toBeNull();
  cleanup();
  api.listProjectPipelines.mockResolvedValue([]);
  await setup();
  await create(a);
  replace(raw);
  click("Создать конвейер");
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
  api.listProjectPipelines.mockRejectedValue(Error("catalog unavailable"));
  click("Конфигурация");
  click("Конвейеры");
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
      { kind: "pipeline", name: "draft" },
      raw,
      "missing",
    ),
  );
});
it("keeps pending reads and failed saves bound to their captured pipeline", async () => {
  let finish!: (v: any) => void;
  api.readProjectDocument.mockImplementationOnce(
    () => new Promise((r) => (finish = r)),
  );
  await setup();
  click("Файл .goga/pipelines/existing.yml");
  click("Открыть редактор");
  await create("another");
  replace("# another");
  await act(async () =>
    finish({
      text: raw,
      version: "original",
      exists: true,
      relativePath: pipeline("existing").path,
    }),
  );
  expect(editor()!.state.doc.toString()).toBe("# another");
  let fail!: (e: Error) => void;
  api.saveProjectDocument.mockImplementationOnce(
    () => new Promise((_r, j) => (fail = j)),
  );
  click("Файл .goga/pipelines/existing.yml");
  replace(raw + "# change");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  click("Файл .goga/pipelines/another.yml");
  await act(async () => fail(Error("conflict")));
  expect(editor()!.state.doc.toString()).toBe("# another");
  click("Файл .goga/pipelines/existing.yml");
  expect(screen.getByText("conflict")).toBeTruthy();
  expect(editor()!.state.doc.toString()).toBe(raw + "# change");
});
it("keys pipeline by project, name and full relative path, distinct from config/tools", () => {
  const key = documentKey({
    scope: "project",
    projectId: "p",
    target: { kind: "pipeline", name: "flow" },
  });
  expect(key).toContain(".goga/pipelines/flow.yml");
  expect(key).not.toBe(
    documentKey({
      scope: "project",
      projectId: "q",
      target: { kind: "pipeline", name: "flow" },
    }),
  );
  expect(key).not.toBe(
    documentKey({
      scope: "project",
      projectId: "p",
      target: { kind: "pipeline", name: "other" },
    }),
  );
});
it("retains pipeline state through actual settings component remount", async () => {
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
  click("Конвейеры");
  await screen.findByRole("button", {
    name: "Файл .goga/pipelines/existing.yml",
  });
  await create("retained");
  replace(raw);
  click("Создать конвейер");
  changeName("typing");
  first.unmount();
  render(<ProjectSettings {...props} />);
  click("Конвейеры");
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(
    (screen.getByLabelText("Имя конвейера") as HTMLInputElement).value,
  ).toBe("typing");
});
it.each(["success", "failure"])(
  "refreshes App launch only after successful pipeline save, retains edited task and ignores stale preview %s",
  async (outcome) => {
    render(<App />);
    await openPrototypeLaunch();
    await screen.findByRole("checkbox", { name: /One/ });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
          .value,
      ).toBe("task"),
    );
    fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
      target: { value: "edited task retained" },
    });
    let stale!: (v: any) => void, staleFailure!: (e: Error) => void;
    api.preview.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          stale = resolve;
          staleFailure = reject;
        }),
    );
    fireEvent.change(screen.getByLabelText("Рабочий процесс"), {
      target: { value: "file:existing" },
    });
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
      pipelines: [
        {
          id: "run",
          name: "Changed Run",
          description: "Changed description",
          project: true,
        },
        {
          id: "new-flow",
          name: "New pipeline",
          description: "",
          project: true,
        },
      ],
    };
    let discover!: (v: any) => void;
    api.discover.mockImplementationOnce(
      () => new Promise((r) => (discover = r)),
    );
    await screen.findByRole("button", { name: "Сохранить" });
    click("Сохранить");
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    await openPrototypeLaunch();
    await act(async () => {
      if (outcome === "success")
        stale({
          token: "stale",
          workflow: "old",
          profile: null,
          stages: [{ id: "old", title: "Obsolete" }],
        });
      else staleFailure(Error("stale preview failure"));
    });
    expect(screen.queryByText("stale preview failure")).toBeNull();
    expect(
      (retainedButton("Сохранить и запустить") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByText("Obsolete")).toBeNull();
    await act(async () => discover(fresh));
    await screen.findByRole("option", { name: /new-flow/ });
    await waitFor(() => expect(screen.queryByText("проверяем…")).toBeNull());
    expect(
      screen.queryByRole("checkbox", { name: /Подтверждаю.*запуск/ }),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Рабочий процесс") as HTMLSelectElement).value,
    ).toBe("file:existing");
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("edited task retained");
    expect(screen.getByText("Changed description")).toBeTruthy();
    click("Сохранить и запустить");
    await waitFor(() =>
      expect(api.launch).toHaveBeenCalledWith(
        expect.objectContaining({ previewToken: "fresh" }),
      ),
    );
  },
);
it("can retry a failed pipeline read without affecting a separate draft", async () => {
  api.readProjectDocument.mockRejectedValueOnce(Error("read denied"));
  await setup();
  click("Файл .goga/pipelines/existing.yml");
  click("Открыть редактор");
  await screen.findByText("read denied");
  await create("safe");
  replace(raw);
  click("Файл .goga/pipelines/existing.yml");
  click("Повторить загрузку");
  await waitFor(() => expect(editor()).not.toBeNull());
  click("Файл .goga/pipelines/safe.yml");
  expect(editor()!.state.doc.toString()).toBe(raw);
});
it("never overwrites an opened existing draft removed externally and keeps it selectable", async () => {
  await setup();
  await reveal("existing");
  replace(raw + "# retained");
  api.listProjectPipelines.mockResolvedValue([]);
  click("Конфигурация");
  click("Конвейеры");
  await waitFor(() =>
    expect(api.listProjectPipelines).toHaveBeenCalledTimes(2),
  );
  click("Создать конвейер");
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
  click("Файл .goga/pipelines/existing.yml");
  expect(editor()!.state.doc.toString()).toBe(raw + "# retained");
});
it("compares actual catalog filenames for aliases and displays unsupported filenames without invented extensions", async () => {
  api.listProjectPipelines.mockResolvedValue([
    {
      name: "Build.YML",
      path: ".goga/pipelines/Build.YML",
      editable: false,
      reason: "Не .yml",
    },
    {
      name: "README.txt",
      path: ".goga/pipelines/README.txt",
      editable: false,
      reason: "Не .yml",
    },
  ]);
  await setup();
  await screen.findByText("README.txt");
  expect(screen.queryByText("README.txt.yml")).toBeNull();
  click("Создать конвейер");
  changeName("build");
  click("Создать черновик");
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(editor()).toBeNull();
});
it("selects and retains the exact pipeline path when unsupported file shares its catalog name", async () => {
  api.listProjectPipelines.mockResolvedValue([
    {
      name: "README.md",
      path: ".goga/pipelines/README.md",
      editable: false,
      reason: "Не .yml",
    },
    pipeline("README.md"),
  ]);
  await setup();
  const unsupported = await screen.findByRole("button", {
    name: "Файл .goga/pipelines/README.md",
  });
  await reveal("README.md");
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(unsupported.getAttribute("aria-pressed")).toBe("false");
  expect(
    screen
      .getByRole("button", { name: "Файл .goga/pipelines/README.md.yml" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  replace(raw + "# draft");
  api.listProjectPipelines.mockResolvedValue([
    {
      name: "README.md",
      path: ".goga/pipelines/README.md",
      editable: false,
      reason: "Не .yml",
    },
  ]);
  click("Конфигурация");
  click("Конвейеры");
  await waitFor(() =>
    expect(api.listProjectPipelines).toHaveBeenCalledTimes(2),
  );
  await create("another");
  click("Файл .goga/pipelines/README.md.yml");
  expect(editor()!.state.doc.toString()).toBe(raw + "# draft");
  expect(
    screen
      .getByRole("button", { name: "Файл .goga/pipelines/README.md" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});
it("keeps a loaded draft selectable when its exact file becomes unsupported, without enabling unsupported siblings", async () => {
  api.listProjectPipelines.mockResolvedValue([pipeline("README.md")]);
  await setup();
  await reveal("README.md");
  replace(raw + "# retained");
  const reason = "Файл больше не является текстовым";
  api.listProjectPipelines.mockResolvedValue([
    {
      name: "README.md",
      path: ".goga/pipelines/README.md",
      editable: false,
      reason,
    },
    { ...pipeline("README.md"), editable: false, reason },
    pipeline("blocked", false),
  ]);
  click("Конфигурация");
  click("Конвейеры");
  await waitFor(() =>
    expect(api.listProjectPipelines).toHaveBeenCalledTimes(2),
  );
  await create("other");
  const retained = screen.getByRole("button", {
    name: "Файл .goga/pipelines/README.md.yml",
  }) as HTMLButtonElement;
  expect(retained.disabled).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Файл .goga/pipelines/README.md",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Файл .goga/pipelines/blocked.yml",
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
  click("Файл .goga/pipelines/other.yml");
  click("Файл .goga/pipelines/README.md.yml");
  expect(editor()!.state.doc.toString()).toBe(raw + "# retained");
  expect(screen.getByText("write denied")).toBeTruthy();
  expect(api.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    { kind: "pipeline", name: "README.md" },
    raw + "# retained",
    "v-README.md",
  );
});
it.each(["success", "failure"])(
  "ignores stale initial discovery %s after a pipeline save refresh",
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
      pipelines: [
        {
          id: "run",
          name: "Changed Run",
          description: "Changed description",
          project: true,
        },
        {
          id: "new-flow",
          name: "New pipeline",
          description: "",
          project: true,
        },
      ],
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
it.each(["success", "failure"])(
  "supersedes an older Reset discovery %s when pipeline saving starts a refresh",
  async (outcome) => {
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
    let reset!: (value: any) => void,
      failReset!: (e: Error) => void,
      refresh!: (value: any) => void;
    api.discover.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          reset = resolve;
          failReset = reject;
        }),
    );
    click("Сбросить");
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    await openSettings();
    await create("new-flow");
    api.discover.mockImplementationOnce(
      () => new Promise((r) => (refresh = r)),
    );
    await screen.findByRole("button", { name: "Сохранить" });
    click("Сохранить");
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
    await openPrototypeLaunch();
    await act(async () => {
      if (outcome === "success") reset(original);
      else failReset(Error("stale reset failure"));
    });
    expect(screen.queryByText("stale reset failure")).toBeNull();
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    fireEvent.click(retainedButton("Сбросить"));
    expect(api.discover).toHaveBeenCalledTimes(3);
    await act(async () =>
      refresh({
        ...original,
        pipelines: [
          {
            id: "run",
            name: "Changed Run",
            description: "Changed description",
            project: true,
          },
          {
            id: "new-flow",
            name: "New pipeline",
            description: "",
            project: true,
          },
        ],
      }),
    );
    await screen.findByRole("option", { name: /new-flow/ });
  },
);

it("has exactly eight project tabs and isolates workflow and pipeline drafts with the same namespace stem", async () => {
  api.listProjectWorkflows = vi.fn(async () => []);
  await setup();
  const navigation = screen.getByRole("navigation", {
    name: "Разделы настроек проекта",
  });
  expect(
    [...navigation.querySelectorAll("button")].map(
      (button) => button.textContent,
    ),
  ).toEqual([
    "Запуск",
    "Конфигурация",
    "Рабочие процессы",
    "Конвейеры",
    "Образ",
    "История",
    "Инструменты",
    "Профили",
  ]);
  await create("review:patch");
  replace(raw);
  click("Создать конвейер");
  changeName("pipeline unfinished");
  click("Рабочие процессы");
  await screen.findByText("В проекте пока нет рабочих процессов");
  click("Создать рабочий процесс");
  fireEvent.change(screen.getByLabelText("Имя рабочего процесса"), {
    target: { value: "review:patch" },
  });
  click("Создать черновик");
  await waitFor(() => expect(editor()).not.toBeNull());
  replace("# independent workflow\nvalue: {{ profile.value }}\n");
  click("Создать рабочий процесс");
  fireEvent.change(screen.getByLabelText("Имя рабочего процесса"), {
    target: { value: "workflow unfinished" },
  });
  click("Конвейеры");
  expect(editor()!.state.doc.toString()).toBe(raw);
  expect(
    (screen.getByLabelText("Имя конвейера") as HTMLInputElement).value,
  ).toBe("pipeline unfinished");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "pipeline", name: "review:patch" },
      raw,
      "missing",
    ),
  );
  click("Рабочие процессы");
  expect(editor()!.state.doc.toString()).toBe(
    "# independent workflow\nvalue: {{ profile.value }}\n",
  );
  expect(
    (screen.getByLabelText("Имя рабочего процесса") as HTMLInputElement).value,
  ).toBe("workflow unfinished");
});
it("keeps raw map-body syntax and invalid structure without parsing or Jinja claims", async () => {
  const source =
    "\uFEFFname: карта 🙂\r\ndescription: header\r\n---\r\n# body comment\r\nstages:\r\n  unknown: [unfinished\r\n";
  api.readProjectDocument.mockResolvedValue({
    text: source,
    exists: true,
    version: "map",
    relativePath: ".goga/pipelines/existing.yml",
  });
  await setup();
  await reveal("existing");
  expect(editor()!.state.doc.toString()).toBe(source);
  expect(screen.queryByText(/Jinja/)).toBeNull();
  expect(
    screen.getByText(/Сохранение не гарантирует возможность запуска/),
  ).toBeTruthy();
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "pipeline", name: "existing" },
      source,
      "map",
    ),
  );
});
it("reserves inflight and opened source names independent of catalog, project and kind", async () => {
  const store = createSettingsDocuments();
  const source = {
    scope: "project" as const,
    projectId: "p",
    target: { kind: "pipeline" as const, name: "review:patch" },
  };
  let finish!: (value: any) => void;
  api.readProjectDocument.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const opening = store.open(source);
  expect(() => store.createPipeline("p", "REVIEW:PATCH", [])).toThrow(
    /уже существует/,
  );
  expect(() => store.createPipeline("q", "review:patch", [])).not.toThrow();
  expect(() => store.createWorkflow("p", "review:patch", [])).not.toThrow();
  finish({
    text: raw,
    exists: true,
    version: "loaded",
    relativePath: ".goga/pipelines/review:patch.yml",
  });
  await opening;
  store.edit(source, raw + "# edit");
  expect(() => store.createPipeline("p", "review:patch", [])).toThrow(
    /уже существует/,
  );
  expect(store.get(source).text).toBe(raw + "# edit");
  expect(
    store.get({ ...source, target: { kind: "workflow", name: "review:patch" } })
      .text,
  ).toBe("");
});
it.each(["discover", "preview"])(
  "blocks launch after pipeline refresh %s failure and retries without losing edited task",
  async (stage) => {
    render(<App />);
    await openPrototypeLaunch();
    await screen.findByRole("checkbox", { name: /One/ });
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
          .value,
      ).toBe("task"),
    );
    fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
      target: { value: "unsaved task edit" },
    });
    await openSettings();
    await create("new-flow");
    api[stage].mockRejectedValueOnce(Error("fresh refresh failed"));
    await screen.findByRole("button", { name: "Сохранить" });
    click("Сохранить");
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    await openPrototypeLaunch();
    await screen.findByText("fresh refresh failed");
    const launch = retainedButton("Сохранить и запустить") as HTMLButtonElement;
    expect(launch.disabled).toBe(true);
    fireEvent.click(launch);
    expect(api.launch).not.toHaveBeenCalled();
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("unsaved task edit");
    click("Повторить обновление каталога");
    await waitFor(() =>
      expect(screen.queryByText("fresh refresh failed")).toBeNull(),
    );
    await waitFor(() => expect(screen.queryByText("проверяем…")).toBeNull());
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("unsaved task edit");
    click("Сохранить и запустить");
    await waitFor(() => expect(api.launch).toHaveBeenCalled());
  },
);
it("blocks a removed selected pipeline and preserves edited task until another pipeline is chosen", async () => {
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
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "unsaved task edit" },
  });
  await openSettings();
  await create("replacement");
  api.discover.mockResolvedValue({
    ...original,
    pipelines: [
      {
        id: "replacement",
        name: "Replacement",
        description: "new",
        project: true,
      },
    ],
  });
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  await openPrototypeLaunch();
  await screen.findByText(/Выбранный конвейер отсутствует/);
  expect((screen.getByLabelText("Конвейер") as HTMLSelectElement).value).toBe(
    "run",
  );
  expect(
    (retainedButton("Сохранить и запустить") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("unsaved task edit");
  fireEvent.change(screen.getByLabelText("Конвейер"), {
    target: { value: "replacement" },
  });
  await waitFor(() => expect(screen.queryByText("проверяем…")).toBeNull());
  click("Сохранить и запустить");
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: "replacement",
        previewToken: "fresh",
      }),
    ),
  );
});

it.each([
  ["discover", "success"],
  ["discover", "failure"],
  ["preview", "success"],
  ["preview", "failure"],
])(
  "ignores an older pipeline refresh %s %s after a second successful save",
  async (stage, outcome) => {
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
    fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
      target: { value: "unsaved task edit" },
    });
    await openSettings();
    await create("new-flow");
    let finish!: (value: any) => void, fail!: (error: Error) => void;
    const callsBefore = api[stage].mock.calls.length;
    api[stage].mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    await screen.findByRole("button", { name: "Сохранить" });
    click("Сохранить");
    await waitFor(() =>
      expect(api[stage].mock.calls.length).toBe(callsBefore + 1),
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    api.discover.mockResolvedValue({
      ...original,
      pipelines: [
        {
          id: "run",
          name: "Latest pipeline",
          description: "latest definition",
          project: true,
        },
        {
          id: "new-flow",
          name: "New pipeline",
          description: "latest",
          project: true,
        },
      ],
    });
    api.preview.mockResolvedValue({
      token: "latest-token",
      workflow: null,
      profile: null,
      stages: [{ id: "latest-stage", title: "Latest stage" }],
    });
    replace(raw + "# latest edit");
    await screen.findByRole("button", { name: "Сохранить" });
    click("Сохранить");
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
    await openPrototypeLaunch();
    await screen.findByRole("checkbox", { name: /Latest stage/ });
    await waitFor(() => expect(screen.queryByText("проверяем…")).toBeNull());
    await act(async () => {
      if (outcome === "failure") fail(Error("obsolete refresh failure"));
      else
        finish(
          stage === "discover"
            ? original
            : {
                token: "obsolete",
                workflow: null,
                profile: null,
                stages: [{ id: "obsolete", title: "Obsolete stage" }],
              },
        );
    });
    expect(screen.queryByText("obsolete refresh failure")).toBeNull();
    expect(screen.queryByText("Obsolete stage")).toBeNull();
    expect(screen.getByText("latest definition")).toBeTruthy();
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("unsaved task edit");
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    click("Сохранить и запустить");
    await waitFor(() =>
      expect(api.launch).toHaveBeenCalledWith(
        expect.objectContaining({ previewToken: "latest-token" }),
      ),
    );
  },
);
it.each(["", "../bad", "with space", "a/b", "-flag", "x\\y"])(
  "rejects invalid pipeline draft name %j before read or write",
  async (name) => {
    await setup();
    click("Создать конвейер");
    changeName(name);
    click("Создать черновик");
    await screen.findByRole("alert");
    expect(editor()).toBeNull();
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
  },
);

it("preserves standalone new-topic fields, profile, workflow and skip selection through document refresh", async () => {
  const original = await api.discover();
  api.discover.mockClear();
  api.discover.mockResolvedValue({
    ...original,
    profiles: [{ name: "custom", source: "project" }],
    branches: ["main", "develop"],
  });
  api.preview.mockImplementation(async ({ skips }: { skips: string[] }) => ({
    token: "fresh",
    workflow: "existing",
    profile: "custom",
    stages: [
      { id: "one", title: "One" },
      { id: "two", title: "Two" },
    ].filter((stage) => !skips.includes(stage.id)),
  }));
  const documents = createSettingsDocuments();
  function StandaloneDocumentRefresh() {
    const revision = React.useSyncExternalStore(documents.subscribe, () =>
      documents.projectRevision(project.id),
    );
    const [settings, setSettings] = React.useState(false);
    const guard = React.useRef<any>(null);
    return (
      <>
        <button onClick={() => setSettings(false)}>Показать форму</button>
        <button onClick={() => setSettings(true)}>Показать файлы</button>
        <div role="tabpanel" hidden={settings}>
          <LaunchForm
            project={project}
            settingsRevision={String(revision)}
            suspended={settings}
            onCancel={() => {}}
            onLaunched={() => {}}
          />
        </div>
        <div hidden={!settings}>
          <ProjectSettings
            embedded
            project={project}
            documents={documents}
            guard={guard}
            onBack={() => setSettings(false)}
            onSaved={() => {}}
            onBusy={() => {}}
          />
        </div>
      </>
    );
  }
  render(<StandaloneDocumentRefresh />);
  await screen.findByRole("checkbox", { name: /One/ });
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  fireEvent.change(screen.getByLabelText("Имя нового топика"), {
    target: { value: "new-topic" },
  });
  fireEvent.change(screen.getByLabelText("Исходная ветка"), {
    target: { value: "develop" },
  });
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "new task draft" },
  });
  fireEvent.change(screen.getByLabelText("Рабочий процесс"), {
    target: { value: "file:existing" },
  });
  fireEvent.change(screen.getByLabelText("Профиль"), {
    target: { value: "custom" },
  });
  await screen.findByRole("checkbox", { name: /Two/ });
  fireEvent.click(screen.getByRole("checkbox", { name: /Two/ }));
  await waitFor(() =>
    expect(screen.queryAllByText("проверяем…")).toHaveLength(0),
  );
  click("Показать файлы");
  click("Конвейеры");
  await waitFor(() => expect(api.listProjectPipelines).toHaveBeenCalled());
  await create("new-flow");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
  click("Показать форму");
  await act(async () => {});
  await waitFor(() =>
    expect(screen.queryAllByText("проверяем…")).toHaveLength(0),
  );
  expect((screen.getByLabelText("Конвейер") as HTMLSelectElement).value).toBe(
    "run",
  );
  expect(
    (screen.getByLabelText("Рабочий процесс") as HTMLSelectElement).value,
  ).toBe("file:existing");
  expect((screen.getByLabelText("Профиль") as HTMLSelectElement).value).toBe(
    "custom",
  );
  expect(
    (screen.getByLabelText("Имя нового топика") as HTMLInputElement).value,
  ).toBe("new-topic");
  expect(
    (screen.getByLabelText("Исходная ветка") as HTMLSelectElement).value,
  ).toBe("develop");
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("new task draft");
  expect(
    (screen.getByRole("checkbox", { name: /Two/ }) as HTMLInputElement).checked,
  ).toBe(false);
  click("Запустить");
  expect(api.launch).not.toHaveBeenCalled();
  click("Создать и запустить");
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline: "run",
        workflow: "file:existing",
        profile: "custom",
        skips: ["two"],
        topic: { mode: "new", name: "new-topic", baseRef: "develop" },
      }),
    ),
  );
});

it("isolates primary pipeline saves from an owner form and refreshes only its clone definitions", async () => {
  render(<App />);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /One/ });
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement)
        .value,
    ).toBe("task"),
  );
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "owner draft" },
  });
  const owner = await api.ensureTopicContext.mock.results[0].value;
  const ref = {
    projectId: owner.projectId,
    year: owner.year,
    topic: owner.topic,
    branch: owner.branch,
    contextId: owner.contextId,
    revision: owner.revision,
  };
  expect(api.discover).toHaveBeenLastCalledWith(ref);
  expect(api.readTopicTask).toHaveBeenCalledWith({
    projectId: "p",
    topic: "t",
    branch: "main",
    context: ref,
  });
  const initialReads = api.discover.mock.calls.length;
  await openSettings(true);
  await create("primary-only");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
      "p",
      { kind: "pipeline", name: "primary-only" },
      "",
      "missing",
    ),
  );
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /One/ });
  expect(api.discover).toHaveBeenCalledTimes(initialReads);
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("owner draft");
  await openSettings();
  await create("clone-only");
  await screen.findByRole("button", { name: "Сохранить" });
  click("Сохранить");
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
      ref,
      { kind: "pipeline", name: "clone-only" },
      "",
      "missing",
    ),
  );
  await waitFor(() =>
    expect(api.discover).toHaveBeenCalledTimes(initialReads + 1),
  );
  expect(api.discover).toHaveBeenLastCalledWith(ref);
  await openPrototypeLaunch();
  await screen.findByRole("checkbox", { name: /One/ });
  expect(
    (screen.getByLabelText("Что нужно сделать?") as HTMLTextAreaElement).value,
  ).toBe("owner draft");
  expect(api.launch).not.toHaveBeenCalled();
});
