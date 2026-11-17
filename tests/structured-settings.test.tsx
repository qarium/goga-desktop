import "./helpers/overview-browser-fixture";
// @vitest-environment jsdom
import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  executionButton,
} from "./helpers/prototype-context-fixture";
import React from "react";
import userEvent from "@testing-library/user-event";
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
import { Settings } from "../src/renderer/Settings";
import { openFirstProject } from "./helpers/open-first-project";
import { App } from "../src/renderer/App";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
import { ProjectSaveGuardShell } from "../src/renderer/ProjectSaveGuardShell";
const project = { id: "p", name: "Alpha", path: "/synthetic/alpha" };
let api: any;
const editor = () => {
  const el = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector('[role="textbox"]');
  return el ? EditorView.findFromDOM(el as HTMLElement)! : null;
};
async function projectEditor() {
  await waitFor(() => expect(editor()).not.toBeNull());
  return editor()!;
}
async function reveal() {
  fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
  await waitFor(() => expect(editor()).not.toBeNull());
  return editor()!;
}
beforeEach(() => {
  api = {
    listSettings: vi.fn(async () => ({ profiles: ["personal"] })),
    readSettings: vi.fn(async () => ({
      text: "# домашний\r\nvalue: 🙂\r\n",
      version: "h1",
    })),
    saveSettings: vi.fn(async (_k, _n, text) => ({ text, version: "h2" })),
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
    listProjectTools: vi.fn(async () => [
      {
        name: "review",
        entries: [
          { path: "env", kind: "directory", editable: false },
          { path: "env/local", kind: "directory", editable: false },
          { path: "env/local/config.yml", kind: "file", editable: true },
          { path: "env/ci", kind: "directory", editable: false },
          { path: "env/ci/config.yml", kind: "file", editable: true },
          {
            path: "README.md",
            kind: "file",
            editable: false,
            reason: "Не YAML",
          },
        ],
      },
      { name: "empty", entries: [] },
    ]),
    readProjectDocument: vi.fn(async (_id, target) => ({
      text: `# ${target.path ?? "project"}\r\nvalue: 🙂\r\n`,
      version: target.path ?? "missing",
      exists: target.kind !== "config",
      relativePath: target.path
        ? `.goga/tools/${target.tool}/${target.path}`
        : ".goga/config.yml",
    })),
    saveProjectDocument: vi.fn(async (_id, target, text) => ({
      text,
      version: "v2",
      exists: true,
      relativePath: target.path ?? ".goga/config.yml",
    })),
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  installPrototypeContextFixture(api, [
    { ...project, topic: "main", branch: "main" },
  ]);
  window.goga = api;
});
afterEach(cleanup);
it("separates personal tabs, retains drafts through profile creation and reads only after consent", async () => {
  render(<Settings />);
  await waitFor(() => expect(api.listSettings).toHaveBeenCalled());
  expect(
    screen.getByRole("navigation", { name: "Разделы общих настроек" }),
  ).toBeTruthy();
  expect(api.readSettings).not.toHaveBeenCalled();
  const view = await reveal();
  act(() => view.dispatch({ changes: { from: 0, insert: "# draft\n" } }));
  fireEvent.click(screen.getByRole("button", { name: "Профили" }));
  expect(editor()).toBeNull();
  expect(api.readSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /Новый профиль/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Имя профиля" }), {
    target: { value: "new-profile" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
  expect(api.saveSettings).not.toHaveBeenCalled();
  await waitFor(() => expect(editor()).not.toBeNull());
  expect(editor()!.state.doc.toString()).toBe("{}\n");
  expect(api.readSettings).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  expect(editor()!.state.doc.toString()).toContain("# draft\n");
});
async function projectTools() {
  render(<App />);
  await openFirstProject();
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByRole("textbox", { name: "Исполняемый файл" });
  fireEvent.click(screen.getByRole("button", { name: "Инструменты" }));
  await screen.findByRole("combobox", { name: "Инструмент" });
}
it("lists actual tools with all folders collapsed and retains full-path drafts and expansion after Back", async () => {
  await projectTools();
  expect(
    screen
      .getByRole("button", { name: "Папка env" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    screen.queryByRole("button", { name: "Файл env/local/config.yml" }),
  ).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Файл README.md" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Папка env" }));
  fireEvent.click(screen.getByRole("button", { name: "Папка env/local" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/local/config.yml" }),
  );
  const local = await projectEditor();
  act(() =>
    local.dispatch({ changes: { from: 0, insert: "# local draft\n" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Папка env/ci" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/ci/config.yml" }),
  );
  await projectEditor();
  expect(editor()!.state.doc.toString()).not.toContain("local draft");
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/local/config.yml" }),
  );
  expect(editor()!.state.doc.toString()).toContain("local draft");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "tool", tool: "review", path: "env/local/config.yml" },
      expect.stringContaining("local draft"),
      "env/local/config.yml",
    ),
  );
  expect(
    screen
      .getByRole("button", { name: "Папка env/local" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  act(() =>
    editor()!.dispatch({ changes: { from: 0, insert: "# across Back\n" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  fireEvent.click(await screen.findByRole("button", { name: "Без сохранения" }));
  fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  fireEvent.click(screen.getByRole("button", { name: "Инструменты" }));
  await screen.findByRole("combobox", { name: "Инструмент" });
  expect(
    screen
      .getByRole("button", { name: "Папка env" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(
    screen
      .getByRole("button", { name: "Папка env/local" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/local/config.yml" }),
  );
  expect(editor()!.state.doc.toString()).toContain("across Back");
});
it("shows empty tools and missing config with explicit save only", async () => {
  await projectTools();
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "empty" },
  });
  expect(screen.getByText(/пока нет конфигурационных файлов/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  await projectEditor();
  expect(
    screen.getByRole("status", { description: /будет создан/ }),
  ).toBeTruthy();
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenCalledWith(
      "p",
      { kind: "config" },
      expect.any(String),
      "missing",
    ),
  );
});
it("retains an unopened new profile after Back and rejects names longer than host limit", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
  fireEvent.click(screen.getByRole("button", { name: "Профили" }));
  await screen.findByRole("button", { name: "personal" });
  fireEvent.click(screen.getByRole("button", { name: /Новый профиль/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Имя профиля" }), {
    target: { value: "x".repeat(181) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Имя профиля" }), {
    target: { value: "new.profile" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
  fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  fireEvent.click(screen.getByRole("button", { name: "Профили" }));
  expect(
    await screen.findByRole("button", { name: "new.profile" }),
  ).toBeTruthy();
  expect(api.readSettings).not.toHaveBeenCalled();
});
it("retains manual folder expansion through Launch and disables unsupported directories with a reason", async () => {
  api.listProjectTools.mockResolvedValue([
    {
      name: "review",
      entries: [
        { path: "env", kind: "directory", editable: false },
        {
          path: "bad",
          kind: "directory",
          editable: false,
          reason: "Недопустимое имя или путь",
        },
      ],
    },
  ]);
  await projectTools();
  expect(
    screen.getByRole("button", { name: "Папка bad" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByText("Недопустимое имя или путь")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Папка env" }));
  fireEvent.click(screen.getByRole("button", { name: "Запуск" }));
  fireEvent.click(screen.getByRole("button", { name: "Инструменты" }));
  await screen.findByRole("combobox", { name: "Инструмент" });
  expect(
    screen
      .getByRole("button", { name: "Папка env" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});
it("allows leaving during a pending read without showing its result in a different document", async () => {
  let finish!: (doc: any) => void;
  api.readSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
  fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
  fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
  expect(screen.queryByRole("heading", { name: "Общие настройки" })).toBeNull();
  await act(async () => finish({ text: "late: value\r\n", version: "late1" }));
  expect(editor()).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  expect(editor()!.state.doc.toString()).toBe("late: value\r\n");
});
it("keeps late tool reads under their original full-path identity", async () => {
  let finish!: (doc: any) => void;
  api.readProjectDocument.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await projectTools();
  fireEvent.click(screen.getByRole("button", { name: "Папка env" }));
  fireEvent.click(screen.getByRole("button", { name: "Папка env/local" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/local/config.yml" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Папка env/ci" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/ci/config.yml" }),
  );
  await projectEditor();
  const ci = editor()!;
  act(() => ci.dispatch({ changes: { from: 0, insert: "# ci draft\n" } }));
  await act(async () =>
    finish({
      text: "# late local\r\n",
      version: "local1",
      exists: true,
      relativePath: ".goga/tools/review/env/local/config.yml",
    }),
  );
  expect(editor()).toBe(ci);
  expect(ci.state.doc.toString()).toContain("# ci draft");
  expect(ci.state.doc.toString()).not.toContain("late local");
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/local/config.yml" }),
  );
  expect(editor()!.state.doc.toString()).toBe("# late local\r\n");
});
it("restores normal disabled presentation for overlapping non-document writes without unlocking actions", async () => {
  const documents = createSettingsDocuments();
  function Fixture() {
    const activity = React.useSyncExternalStore(
      documents.subscribe,
      documents.writeActivity,
    );
    return (
      <ProjectSaveGuardShell
        projectSaveOnly={activity === "project-save"}
        className="app-shell"
      >
        <button disabled={activity !== "idle"}>Действие</button>
      </ProjectSaveGuardShell>
    );
  }
  const source = {
    scope: "project",
    projectId: "p",
    target: { kind: "config" },
  } as const;
  await documents.open(source);
  let finish!: () => void;
  api.saveProjectDocument.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ text: "ok", exists: true, version: "saved" });
      }),
  );
  render(<Fixture />);
  const button = screen.getByRole("button", {
    name: "Действие",
  }) as HTMLButtonElement;
  let saving!: Promise<boolean>;
  act(() => {
    saving = documents.save(source);
  });
  expect(button.hasAttribute("data-project-save-guard")).toBe(true);
  act(() =>
    documents.updateRegistryDraft("p", (draft) => ({ ...draft, saving: true })),
  );
  expect(button.disabled).toBe(true);
  expect(button.hasAttribute("data-project-save-guard")).toBe(false);
  await act(async () => {
    finish();
    await saving;
  });
  expect(button.disabled).toBe(true);
  expect(button.hasAttribute("data-project-save-guard")).toBe(false);
  act(() =>
    documents.updateRegistryDraft("p", (draft) => ({
      ...draft,
      saving: false,
    })),
  );
  expect(button.disabled).toBe(false);
});
it("retains failed save A and its version while selecting B, blocking App navigation until the write settles", async () => {
  let fail!: (error: Error) => void;
  api.saveProjectDocument.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  await projectTools();
  fireEvent.click(screen.getByRole("button", { name: "Папка env" }));
  fireEvent.click(screen.getByRole("button", { name: "Папка env/local" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/local/config.yml" }),
  );
  const view = await projectEditor();
  act(() => view.dispatch({ changes: { from: 0, insert: "# unsaved A\r\n" } }));
  const textA = view.state.doc.toString();
  const launch = screen.getByRole("button", { name: "Запустить" });
  const alreadyUnavailable = [
    ...document.querySelectorAll<HTMLButtonElement>("button:disabled"),
  ];
  expect(alreadyUnavailable.length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(launch.hasAttribute("data-project-save-guard")).toBe(true);
  expect(
    alreadyUnavailable.every(
      (button) => !button.hasAttribute("data-project-save-guard"),
    ),
  ).toBe(true);
  expect(view.state.readOnly).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(screen.getByRole("heading", { name: "Проект" })).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Настройки" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Папка env/ci" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/ci/config.yml" }),
  );
  const b = await projectEditor();
  act(() => b.dispatch({ changes: { from: 0, insert: "# draft B\n" } }));
  const textB = b.state.doc.toString();
  await act(async () => fail(Error("Файл изменился вне приложения")));
  expect(document.querySelector("[data-project-save-guard]")).toBeNull();
  expect(editor()).toBe(b);
  expect(b.state.doc.toString()).toBe(textB);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Настройки" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Файл env/local/config.yml" }),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Файл изменился вне приложения",
  );
  expect(editor()!.state.doc.toString()).toBe(textA);
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
      "p",
      { kind: "tool", tool: "review", path: "env/local/config.yml" },
      textA,
      "env/local/config.yml",
    ),
  );
});
it("uses the returned version after successful A save while B remains selected", async () => {
  let finish!: (doc: any) => void;
  api.saveProjectDocument.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await projectTools();
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  const a = await projectEditor();
  act(() => a.dispatch({ changes: { from: 0, insert: "# A\r\n" } }));
  const text = a.state.doc.toString();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  fireEvent.click(screen.getByRole("button", { name: "Инструменты" }));
  await screen.findByRole("combobox", { name: "Инструмент" });
  await act(async () =>
    finish({
      text,
      version: "after-save",
      relativePath: ".goga/config.yml",
      exists: true,
    }),
  );
  expect(editor()).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  expect(editor()!.state.doc.toString()).toBe(text);
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveProjectDocument).toHaveBeenLastCalledWith(
      "p",
      { kind: "config" },
      text,
      "after-save",
    ),
  );
});
it("retains home drafts after Back and does not turn successful saves into catalog refresh failures", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
  await waitFor(() => expect(api.listSettings).toHaveBeenCalledOnce());
  const view = await reveal();
  act(() =>
    view.dispatch({ changes: { from: 0, insert: "# retained home\r\n" } }),
  );
  const text = view.state.doc.toString();
  fireEvent.click(screen.getByRole("button", { name: "← Назад" }));
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  expect(editor()!.state.doc.toString()).toBe(text);
  await waitFor(() => expect(api.listSettings).toHaveBeenCalledTimes(2));
  api.listSettings.mockRejectedValue(Error("catalog denied"));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("status");
  expect(api.saveSettings).toHaveBeenCalledWith(
    "config",
    undefined,
    text,
    "h1",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(api.listSettings).toHaveBeenCalledTimes(2);
});
it("retains rejected environment input errors across inner tabs", async () => {
  api.readProjectSettings.mockResolvedValue({
    value: {
      executable: "goga",
      profile: "",
      env: [{ key: "TOKEN", value: "before", secret: true, runtime: false }],
    },
    version: "s1",
    profiles: [],
  });
  render(<App />);
  await openFirstProject();
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  const value = await screen.findByLabelText("Значение 1");
  fireEvent.paste(value, { clipboardData: { getData: () => "bad\nvalue" } });
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запуск" }));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect((screen.getByLabelText("Значение 1") as HTMLInputElement).value).toBe(
    "before",
  );
  expect(
    (
      screen.getByRole("switch", {
        name: "Скрывать значение 1",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});
it("supports keyboard folder expansion and keeps manual state across tool selection", async () => {
  const user = userEvent.setup();
  await projectTools();
  const folder = screen.getByRole("button", { name: "Папка env" });
  folder.focus();
  await user.keyboard(" ");
  expect(folder.getAttribute("aria-expanded")).toBe("true");
  const nested = screen.getByRole("button", { name: "Папка env/local" });
  nested.focus();
  await user.keyboard("{Enter}");
  expect(nested.getAttribute("aria-expanded")).toBe("true");
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "empty" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "review" },
  });
  expect(
    screen
      .getByRole("button", { name: "Папка env/local" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  screen.getByRole("button", { name: "Папка env" }).focus();
  await user.keyboard(" ");
  expect(
    screen.queryByRole("button", { name: "Файл env/local/config.yml" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  fireEvent.click(screen.getByRole("button", { name: "Инструменты" }));
  await screen.findByRole("combobox", { name: "Инструмент" });
  expect(
    screen
      .getByRole("button", { name: "Папка env" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});

it("places configuration and personal profiles inside the constrained retained settings viewport", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
  const settings = screen
    .getByRole("heading", { name: "Общие настройки" })
    .closest(".settings-panel")!;
  const viewport = settings.closest(".scroll-area")!;
  expect(viewport.classList.contains("global-settings-scroll-area")).toBe(true);
  const retained = viewport.closest(".retained-view")!;
  expect(retained.parentElement?.classList.contains("main-area")).toBe(true);
  expect(
    screen
      .getByRole("region", { name: "Конфигурация Goga" })
      .closest(".scroll-area"),
  ).toBe(viewport);
  fireEvent.click(screen.getByRole("button", { name: "Профили" }));
  await screen.findByRole("button", { name: "personal" });
  expect(
    screen.getByRole("region", { name: "personal" }).closest(".scroll-area"),
  ).toBe(viewport);
});

it("shares the opt-in between workspace reminders and general settings; defaults to asking", async () => {
  const { readAutoSaveOnLeave, setAutoSaveOnLeave } =
    await import("../src/renderer/workspace-leave-preferences");
  const key = "goga.desktop.autoSaveOnLeave.v1";
  const old = localStorage.getItem(key);
  try {
    localStorage.setItem(key, "malformed");
    expect(readAutoSaveOnLeave()).toBe(false);
    const ui = render(<Settings selectedTab="workspace" />);
    expect(api.listSettings).not.toHaveBeenCalled();
    const toggle = screen.getByRole("switch", {
      name: "Автосохранение при переходе",
    });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    act(() => setAutoSaveOnLeave(true)); // Opted in from a successful save in the dialog.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(key)).toBe("true");
    fireEvent.click(toggle);
    expect(readAutoSaveOnLeave()).toBe(false);
    ui.unmount();
    render(<Settings selectedTab="workspace" />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe(
      "false",
    );
  } finally {
    if (old === null) localStorage.removeItem(key);
    else localStorage.setItem(key, old);
  }
});

it("lists paths as text, expands without losing the opt-in, and only requests remembering on save", async () => {
  const { WorkspaceLeaveDialog } =
    await import("../src/renderer/WorkspaceLeaveDialog");
  const props = {
    files: [
      "one.yml",
      "two.yml",
      "sub/three.yml",
      "four.yml",
      "five.yml",
      "six.yml",
      "seven.yml",
    ],
    launching: true,
    onStay: vi.fn(),
    onKeep: vi.fn(),
    onSave: vi.fn(),
    onReveal: vi.fn(),
  };
  {
    const ui = render(<WorkspaceLeaveDialog {...props} />);
    const modal = screen.getByRole("dialog", { name: "Сохранить правки?" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Остаться" }),
    );
    expect(modal.querySelectorAll("li")).toHaveLength(3);
    const check = screen.getByRole("checkbox", {
      name: /Больше не спрашивать/,
    }) as HTMLInputElement;
    expect(check.checked).toBe(false);
    fireEvent.click(check);
    fireEvent.click(screen.getByRole("button", { name: "Ещё 4 файла" }));
    expect(modal.querySelectorAll("li")).toHaveLength(7);
    expect(modal.querySelectorAll("code, input[type=text]")).toHaveLength(0);
    expect(check.checked).toBe(true);
    const backgroundEscape = vi.fn();
    window.addEventListener("keydown", backgroundEscape);
    try {
      fireEvent.keyDown(check, { key: "Escape" });
      expect(backgroundEscape).not.toHaveBeenCalled();
    } finally { window.removeEventListener("keydown", backgroundEscape); }
    fireEvent(modal, new Event("cancel", { cancelable: true }));
    expect(props.onStay).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Без сохранения" }));
    expect(props.onKeep).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Сохранить и продолжить" }),
    );
    expect(props.onSave).toHaveBeenCalledWith(true);
    ui.rerender(<WorkspaceLeaveDialog {...props} busy />);
    fireEvent(modal, new Event("cancel", { cancelable: true }));
    expect(props.onStay).toHaveBeenCalledOnce();
    expect(check.disabled).toBe(true);
    ui.rerender(
      <WorkspaceLeaveDialog
        {...props}
        failure={{ path: "sub/three.yml", message: "Файл изменился на диске." }}
      />,
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Файл изменился на диске",
    );
    fireEvent.click(screen.getByRole("button", { name: "К файлу" }));
    expect(props.onReveal).toHaveBeenCalledOnce();
    ui.rerender(
      <WorkspaceLeaveDialog
        {...props}
        failure={{ path: "", message: "Не удалось сохранить настройку." }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Не удалось сохранить настройку.",
    );
    expect(screen.queryByRole("button", { name: "К файлу" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Остаться" }));
    expect(props.onStay).toHaveBeenCalledTimes(2);
    ui.unmount();
  }
});
