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
import { undo } from "@codemirror/commands";
import { Settings } from "../src/renderer/Settings";
import { SettingsDocument } from "../src/renderer/SettingsDocument";
import { ProjectStatusShell } from "./helpers/project-status-shell";
import { RetainedViews } from "../src/renderer/RetainedViews";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
import type { ProjectDocumentTarget } from "../src/shared/project-documents";

const source =
  '# Комментарий\r\nunknown: "🙂"\nflag: true\r\nbody: |\n  <img src=x onerror=alert(1)>\n';
let api: any;
beforeEach(() => {
  api = {
    listSettings: vi.fn(async () => ({ profiles: ["personal"] })),
    readSettings: vi.fn(async () => ({ text: source, version: "v1" })),
    saveSettings: vi.fn(async (_kind: string, _name: string, text: string) => ({
      text,
      version: "v2",
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
const input = () =>
  (document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector(
      '[role="textbox"][aria-label="YAML"]',
    ) as HTMLElement | null) ?? null;
async function openEditor() {
  fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
  await waitFor(() => expect(input()).not.toBeNull());
  expect(input()!.closest(".cm-editor")).not.toBeNull();
  return EditorView.findFromDOM(input()!)!;
}
it("opens the real YAML editor only after explicit consent and preserves unedited source in IPC", async () => {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  await waitFor(() => expect(api.listSettings).toHaveBeenCalled());
  expect(api.readSettings).not.toHaveBeenCalled();
  expect(input()).toBeNull();
  const view = await openEditor();
  expect(
    screen.queryByRole("button", { name: "Развернуть документ" }),
  ).toBeNull();
  expect(view.state.doc.toString()).toBe(source);
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("status");
  expect(api.saveSettings).toHaveBeenCalledWith(
    "config",
    undefined,
    source,
    "v1",
  );
  expect(EditorView.findFromDOM(input()!)).toBe(view);
});
it.each(["invalid YAML", "Файл изменился вне приложения", "write denied"])(
  "keeps draft, history and version after %s",
  async (error) => {
    api.saveSettings.mockRejectedValueOnce(Error(error));
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
    const view = await openEditor();
    const draft = source + "unfinished: [\r\n";
    act(() =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "unfinished: [\r\n" },
        selection: { anchor: draft.length },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect((await screen.findByRole("alert")).textContent).toBe(error);
    expect(view.state.doc.toString()).toBe(draft);
    expect(view.state.selection.main.head).toBe(draft.length);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      "config",
      undefined,
      draft,
      "v1",
    );
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(source);
  },
);
it("keeps one view and history during save, then uses the returned version", async () => {
  let resolve!: (value: { text: string; version: string }) => void;
  api.saveSettings.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  const view = await openEditor();
  act(() =>
    view.dispatch({
      changes: { from: 0, insert: "# edit\n" },
      selection: { anchor: 4 },
    }),
  );
  const draft = view.state.doc.toString();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(view.state.readOnly).toBe(true);
  expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
  expect(EditorView.findFromDOM(input()!)).toBe(view);
  await act(async () => resolve({ text: draft, version: "v2" }));
  expect(view.state.readOnly).toBe(false);
  expect(view.state.selection.main.head).toBe(4);
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(api.saveSettings).toHaveBeenLastCalledWith(
      "config",
      undefined,
      draft,
      "v2",
    ),
  );
  await waitFor(() => expect(view.state.readOnly).toBe(false));
  act(() => {
    expect(undo(view)).toBe(true);
  });
  expect(view.state.doc.toString()).toBe(source);
});
it("unmounts hidden/switched documents and explicitly opens personal profiles", async () => {
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  const old = await openEditor();
  const destroy = vi.spyOn(old, "destroy");
  fireEvent.click(
    screen.getByRole("button", { name: "Скрыть без сохранения" }),
  );
  expect(destroy).toHaveBeenCalledOnce();
  expect(input()).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Профили" }));
  fireEvent.click(await screen.findByRole("button", { name: "personal" }));
  expect(api.readSettings).toHaveBeenCalledTimes(1);
  const profile = await openEditor();
  expect(
    screen.queryByRole("button", { name: "Развернуть документ" }),
  ).toBeNull();
  expect(profile).not.toBe(old);
  expect(api.readSettings).toHaveBeenLastCalledWith("profile", "personal");
  act(() => profile.dispatch({ changes: { from: 0, insert: "# profile\n" } }));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("status");
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    "profile",
    "personal",
    "# profile\n" + source,
    "v1",
  );
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  expect(input()).toBeNull();
});

it.each(["config", "profile"])(
  "supports line indentation in the %s editor without touching source line endings",
  async (kind) => {
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
    if (kind === "profile") {
      fireEvent.click(await screen.findByRole("button", { name: "Профили" }));
      fireEvent.click(await screen.findByRole("button", { name: "personal" }));
    }
    const view = await openEditor();
    act(() =>
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
    );
    fireEvent.keyDown(view.contentDOM, {
      key: "Tab",
      keyCode: 9,
      bubbles: true,
      cancelable: true,
    });
    expect(view.state.doc.toString()).toBe(
      source
        .split("\n")
        .map((line, i, all) => (i === all.length - 1 ? line : "  " + line))
        .join("\n"),
    );
    fireEvent.keyDown(view.contentDOM, {
      key: "Tab",
      keyCode: 9,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(view.state.doc.toString()).toBe(source);
    expect(api.saveSettings).not.toHaveBeenCalled();
  },
);

const projectTargets: ProjectDocumentTarget[] = [
  { kind: "config" },
  { kind: "dockerfile", path: ".goga/Dockerfile" },
  { kind: "workflow", name: "review" },
  { kind: "pipeline", name: "checks" },
  { kind: "tool", tool: "review", path: "config.yml" },
  { kind: "profile", name: "dev" },
];
const contextSlot = () => screen.getByTestId("context-bar-file-status");
function expectFileStatus(owner: Element, text: string) {
  // Query the full document so an accidental second live status fails the test.
  const status = screen.getByRole("status");
  expect(owner.contains(status)).toBe(true);
  expect(status.textContent).toBe(text);
  return status;
}
function expectNoFileStatus() {
  expect(document.querySelector(".document-save-feedback")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
}
function renderProjectDocument(
  target: ProjectDocumentTarget,
  exists = true,
  store = createSettingsDocuments(),
) {
  // jsdom reports Safari but omits its shadow-selection command.
  document.execCommand = () => false;
  api.readProjectDocument = vi.fn(async () => ({
    text: source,
    version: exists ? "v1" : "missing",
    exists,
  }));
  const content = (
    <SettingsDocument
      store={store}
      source={{ scope: "project", projectId: "p", target }}
      title="Документ"
      path="synthetic/source"
      description="Описание"
    />
  );
  const shell = (active: boolean) => (
    <ProjectStatusShell>
      <main className="main-area">
        <div className="project-page">
          <div className="scroll-area">
            <RetainedViews activeKey={active ? "editor" : "other"}>
              {active ? content : <input aria-label="Другая форма" />}
            </RetainedViews>
          </div>
        </div>
      </main>
    </ProjectStatusShell>
  );
  const ui = render(shell(true));
  return (active: boolean) => ui.rerender(shell(active));
}
const sizeButton = (expanded: boolean) =>
  screen.getByRole("button", {
    name: expanded ? "Свернуть документ" : "Развернуть документ",
  });

it.each(projectTargets)(
  "expands and collapses the same project $kind editor from its header",
  async (target) => {
    renderProjectDocument(target);
    await screen.findByRole("button", { name: "Сохранить" });
    const button = sizeButton(false);
    const heading = document.querySelector(".editor-heading")!;
    const tools = heading.querySelector(".document-heading-tools");
    expect(heading.querySelector(".document-save-feedback")).toBeNull();
    const rename = target.kind === "config" || target.kind === "dockerfile" ? [] : [screen.getByRole("button", { name: "Переименовать файл" })];
    expect(Array.from(tools!.children)).toEqual([
      heading.querySelector(".format"),
      ...rename,
      screen.getByRole("button", { name: "Обновить с диска" }),
      button,
    ]);
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("16");
    expect(heading.contains(button)).toBe(true);
    expect(
      document.querySelector(".document-editor-footer")!.contains(button),
    ).toBe(false);
    expectFileStatus(contextSlot(), "Файл: нет изменений");
    expect(
      document.querySelector(".document-editor-footer > .hint"),
    ).toBeNull();
    expect(heading.querySelector(".format")?.getAttribute("title")).toContain(
      "атомар",
    );
    const host = document.querySelector(".yaml-code-editor")!;
    const view = EditorView.findFromDOM(
      host.shadowRoot!.querySelector<HTMLElement>('[role="textbox"]')!,
    )!;
    act(() =>
      view.dispatch({
        changes: { from: 0, insert: "# draft\n" },
        selection: { anchor: 6, head: 2 },
      }),
    );
    const slot = contextSlot();
    expectFileStatus(slot, "Файл: есть изменения");
    view.scrollDOM.scrollTop = 270;
    view.scrollDOM.scrollLeft = 30;
    fireEvent.click(button);
    expect(sizeButton(true).getAttribute("aria-expanded")).toBe("true");
    expectFileStatus(tools!, "Файл: есть изменения");
    expect(slot.childElementCount).toBe(0);
    expect(Array.from(tools!.children)).toEqual([
      screen.getByRole("status"),
      heading.querySelector(".format"),
      ...rename,
      screen.getByRole("button", { name: "Обновить с диска" }),
      sizeButton(true),
    ]);
    expect(view.scrollDOM.scrollTop).toBe(270);
    view.scrollDOM.scrollLeft = 7; // user changed the horizontal reading position
    expect(
      fireEvent.keyDown(view.contentDOM, { key: "Escape", composed: true }),
    ).toBe(false);
    expect(sizeButton(false).getAttribute("aria-expanded")).toBe("false");
    expectFileStatus(slot, "Файл: есть изменения");
    expect(heading.querySelector(".document-save-feedback")).toBeNull();
    expect(document.querySelector(".yaml-code-editor")).toBe(host);
    expect(
      EditorView.findFromDOM(
        host.shadowRoot!.querySelector<HTMLElement>('[role="textbox"]')!,
      ),
    ).toBe(view);
    expect(view.state.selection.main).toMatchObject({ anchor: 6, head: 2 });
    expect(view.state.doc.toString()).toBe("# draft\n" + source);
    expect([view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft]).toEqual([
      270, 7,
    ]);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(source);
    expectFileStatus(contextSlot(), "Файл: нет изменений");
  },
);

it("restores the pre-expansion scroll when the larger viewport clamps it", async () => {
  renderProjectDocument({ kind: "config" });
  await screen.findByRole("button", { name: "Сохранить" });
  const view = EditorView.findFromDOM(input()!)!;
  const button = sizeButton(false);
  let top = 850;
  Object.defineProperty(view.scrollDOM, "scrollTop", {
    configurable: true,
    get: () => top,
    // Stand in for Chromium's maximum scroll offset in a larger viewport.
    set: (value) => {
      top = Math.min(
        value,
        button.getAttribute("aria-expanded") === "true" ? 450 : 850,
      );
    },
  });
  fireEvent.click(button);
  expect(top).toBe(450);
  fireEvent.click(sizeButton(true));
  expect(top).toBe(850);
});

it("releases expansion when a retained project is hidden without claiming another form's Escape", async () => {
  const show = renderProjectDocument({ kind: "config" });
  await screen.findByRole("button", { name: "Сохранить" });
  const original = EditorView.findFromDOM(input()!)!;
  act(() =>
    original.dispatch({ changes: { from: 0, insert: "# retained\n" } }),
  );
  fireEvent.click(sizeButton(false));
  expectFileStatus(
    document.querySelector(".document-heading-tools")!,
    "Файл: есть изменения",
  );
  show(false);
  expectNoFileStatus();
  const other = screen.getByRole("textbox", { name: "Другая форма" });
  other.focus();
  expect(fireEvent.keyDown(other, { key: "Escape" })).toBe(true);
  expect(document.activeElement).toBe(other);
  show(true);
  expect(sizeButton(false).getAttribute("aria-expanded")).toBe("false");
  expectFileStatus(contextSlot(), "Файл: есть изменения");
  expect(EditorView.findFromDOM(input()!)).toBe(original);
});

it("keeps normal save, discard and deletion confirmation behavior while expanded", async () => {
  const target = { kind: "workflow", name: "review" } as const;
  renderProjectDocument(target);
  api.saveProjectDocument = vi.fn(async (_id, _target, text) => ({
    text,
    version: "v2",
    exists: true,
  }));
  api.prepareDocumentDeletion = vi.fn(async () => ({
    token: "ticket",
    name: "review",
    relativePath: ".goga/workflows/review.yml",
  }));
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  await screen.findByRole("button", { name: "Сохранить" });
  const view = EditorView.findFromDOM(input()!)!;
  fireEvent.click(sizeButton(false));
  act(() => view.dispatch({ changes: { from: 0, insert: "# saved\n" } }));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByText("Файл: сохранен");
  expectFileStatus(
    document.querySelector(".document-heading-tools")!,
    "Файл: сохранен",
  );
  expect(api.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    target,
    "# saved\n" + source,
    "v1",
  );
  act(() => view.dispatch({ changes: { from: 0, insert: "# discarded\n" } }));
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения" }));
  expect(view.state.doc.toString()).toBe("# saved\n" + source);
  expectFileStatus(
    document.querySelector(".document-heading-tools")!,
    "Файл: нет изменений",
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    fireEvent.keyDown(screen.getByRole("button", { name: "Отмена" }), {
      key: "Escape",
    }),
  ).toBe(true);
  fireEvent(dialog, new Event("cancel", { bubbles: false, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sizeButton(true).getAttribute("aria-expanded")).toBe("true");
  expect(EditorView.findFromDOM(input()!)).toBe(view);
});

it("keeps the first-save hint in the context bar, without removing a row above the editor", async () => {
  const target = { kind: "config" } as const;
  renderProjectDocument(target, false);
  api.saveProjectDocument = vi.fn(async (_id, _target, text) => ({
    text,
    version: "v1",
    exists: true,
  }));
  const save = await screen.findByRole("button", { name: "Сохранить" });
  const view = EditorView.findFromDOM(input()!)!;
  const status = expectFileStatus(contextSlot(), "Новый файл");
  expect(status.title).toContain("будет создан");
  const host = document.querySelector(".yaml-code-editor")!;
  const preceding = host.previousElementSibling;
  act(() => view.dispatch({ changes: { from: 0, insert: "# new\n" } }));
  expectFileStatus(contextSlot(), "Файл: есть изменения");
  expect(status.title).toContain("будет создан");
  fireEvent.click(save);
  await screen.findByText("Файл: сохранен");
  expect(screen.getByRole("status")).toBe(status);
  expect(status.title).not.toContain("будет создан");
  expect(host.previousElementSibling).toBe(preceding);
  expect(EditorView.findFromDOM(input()!)).toBe(view);
});

it.each([40, 249, 250, 800])(
  "keeps project save controls stable and delays visual progress for %i ms",
  async (duration) => {
    renderProjectDocument({ kind: "config" });
    await screen.findByRole("button", { name: "Сохранить" });
    const view = EditorView.findFromDOM(input()!)!;
    const save = screen.getByRole("button", {
      name: "Сохранить",
    }) as HTMLButtonElement;
    expectFileStatus(contextSlot(), "Файл: нет изменений");
    // A hidden leading icon placeholder offsets the centered label even at rest.
    expect(save.childElementCount).toBe(0);
    let finish!: (v: any) => void;
    api.saveProjectDocument = vi.fn(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    vi.useFakeTimers();
    try {
      fireEvent.click(save);
      expect(save.disabled).toBe(true);
      fireEvent.click(save);
      expect(api.saveProjectDocument).toHaveBeenCalledTimes(1);
      expect(save.textContent).toBe("Сохранить");
      expect(
        document.querySelector(".document-save-feedback .loading-spinner"),
      ).toBeNull();
      act(() => vi.advanceTimersByTime(duration));
      expect(
        !!document.querySelector(".document-save-feedback .loading-spinner"),
      ).toBe(duration >= 250);
      if (duration >= 250) expectFileStatus(contextSlot(), "Сохраняем…");
      else expectFileStatus(contextSlot(), "Файл: нет изменений");
      expect(save.childElementCount).toBe(0);
      await act(async () =>
        finish({ text: source, version: "v2", exists: true }),
      );
      const feedback = expectFileStatus(contextSlot(), "Файл: сохранен");
      expect(feedback.getAttribute("data-tone")).toBe("success");
      expect(
        document.querySelector(".document-editor-footer > .success"),
      ).toBeNull();
      expect(
        document.querySelector(".document-save-feedback .loading-spinner"),
      ).toBeNull();
      expect(save.disabled).toBe(false);
      expect(EditorView.findFromDOM(input()!)).toBe(view);
      act(() => vi.advanceTimersByTime(1000));
      expect(
        document.querySelector(".document-save-feedback .loading-spinner"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("keeps project conflict errors and the draft while cancelling delayed save progress", async () => {
  renderProjectDocument({ kind: "workflow", name: "review" });
  await screen.findByRole("button", { name: "Сохранить" });
  const view = EditorView.findFromDOM(input()!)!;
  act(() => view.dispatch({ changes: { from: 0, insert: "# local\n" } }));
  let reject!: (reason: Error) => void;
  api.saveProjectDocument = vi.fn(
    () =>
      new Promise((_, no) => {
        reject = no;
      }),
  );
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await act(async () => reject(new Error("Файл изменён извне")));
    const error = expectFileStatus(contextSlot(), "Не сохранено");
    expect(error.getAttribute("data-tone")).toBe("error");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("извне");
    expect(
      document.querySelector(".document-editor-footer")!.contains(alert),
    ).toBe(true);
    expect(view.state.doc.toString()).toBe("# local\n" + source);
    expect(view.state.readOnly).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    expect(
      document.querySelector(".document-save-feedback .loading-spinner"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Сохранить" })
        .hasAttribute("disabled"),
    ).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps external-change details with the draft and only its compact warning in the context bar", async () => {
  const store = createSettingsDocuments();
  const show = renderProjectDocument({ kind: "config" }, true, store);
  await screen.findByRole("button", { name: "Сохранить" });
  const view = EditorView.findFromDOM(input()!)!;
  act(() => view.dispatch({ changes: { from: 0, insert: "# local\n" } }));
  await act(async () => store.refreshProject("p"));
  const warning = expectFileStatus(contextSlot(), "Проверьте файл");
  expect(warning.getAttribute("data-tone")).toBe("warning");
  const details = screen.getByText(/Ваш черновик сохранён/);
  expect(
    document.querySelector(".document-editor-footer")!.contains(details),
  ).toBe(true);
  expect(warning.getAttribute("aria-description")).toBe(details.textContent);
  show(false);
  expectNoFileStatus();
  show(true);
  expectFileStatus(contextSlot(), "Проверьте файл");
  expect(view.state.doc.toString()).toBe("# local\n" + source);
});

it.each(["another file", "another project"])(
  "does not transfer progress or a late success to %s",
  async (change) => {
    const store = createSettingsDocuments();
    const a = {
      scope: "project",
      projectId: "a",
      target: { kind: "config" },
    } as const;
    const b =
      change === "another project"
        ? { ...a, projectId: "b" }
        : { ...a, target: { kind: "workflow", name: "review" } as const };
    api.readProjectDocument = vi.fn(async () => ({
      text: source,
      version: "v1",
      exists: true,
    }));
    await store.open(a);
    await store.open(b);
    const panel = (s: typeof a | typeof b) => (
      <ProjectStatusShell>
        <SettingsDocument
          store={store}
          source={s}
          title="Документ"
          path="source"
          description="Описание"
        />
      </ProjectStatusShell>
    );
    const ui = render(panel(a));
    let finish!: (v: unknown) => void;
    api.saveProjectDocument = vi.fn(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      act(() => vi.advanceTimersByTime(300));
      expect(
        document.querySelector(".document-save-feedback .loading-spinner"),
      ).not.toBeNull();
      expectFileStatus(contextSlot(), "Сохраняем…");
      ui.rerender(panel(b));
      expect(
        document.querySelector(".document-save-feedback .loading-spinner"),
      ).toBeNull();
      expectFileStatus(contextSlot(), "Файл: нет изменений");
      await act(async () =>
        finish({ text: source, version: "v2", exists: true }),
      );
      expectFileStatus(contextSlot(), "Файл: нет изменений");
      act(() => vi.advanceTimersByTime(1000));
      expect(
        document.querySelector(".document-save-feedback .loading-spinner"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  },
);

it("shows green success in the context bar for exactly three seconds without bringing it back on return", async () => {
  const show = renderProjectDocument({ kind: "config" });
  await screen.findByRole("button", { name: "Сохранить" });
  const view = EditorView.findFromDOM(input()!)!;
  const initialStatus = expectFileStatus(contextSlot(), "Файл: нет изменений");
  expect(initialStatus.getAttribute("data-tone")).toBe("neutral");
  api.saveProjectDocument = vi.fn(async (_id, _target, text) => ({
    text,
    version: "v2",
    exists: true,
  }));
  vi.useFakeTimers();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await act(async () => {});
    const status = expectFileStatus(contextSlot(), "Файл: сохранен");
    expect(status).toBe(initialStatus);
    expect(status.getAttribute("data-tone")).toBe("success");
    act(() => vi.advanceTimersByTime(1000));
    show(false);
    expectNoFileStatus();
    act(() => vi.advanceTimersByTime(500));
    show(true);
    expectFileStatus(contextSlot(), "Файл: сохранен");
    fireEvent.click(sizeButton(false));
    const headingTools = document.querySelector(".document-heading-tools")!;
    const expandedStatus = expectFileStatus(headingTools, "Файл: сохранен");
    act(() => vi.advanceTimersByTime(1499));
    expectFileStatus(headingTools, "Файл: сохранен");
    act(() => vi.advanceTimersByTime(1));
    expectFileStatus(headingTools, "Файл: нет изменений");
    expect(screen.getByRole("status")).toBe(expandedStatus);
    expect(expandedStatus.getAttribute("data-tone")).toBe("neutral");
    show(false);
    act(() => vi.advanceTimersByTime(5000));
    show(true);
    expectFileStatus(contextSlot(), "Файл: нет изменений");
    expect(EditorView.findFromDOM(input()!)).toBe(view);
    expect(document.body.textContent).not.toContain(
      "Изменения применятся к следующим запускам.",
    );
  } finally {
    vi.useRealTimers();
  }
});

it("reloads a clean open document in place and offers a safe way out of a save conflict", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  renderProjectDocument({ kind: "config" });
  await screen.findByRole("button", { name: "Сохранить" });
  const reload = screen.getByRole("button", { name: "Обновить с диска" });
  const view = EditorView.findFromDOM(input()!)!;
  api.readProjectDocument.mockResolvedValue({
    text: "external: true",
    version: "v2",
    exists: true,
  });
  fireEvent.click(reload);
  await waitFor(() => expect(view.state.doc.toString()).toBe("external: true"));
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() =>
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\nlocal: true" },
    }),
  );
  api.saveProjectDocument = vi
    .fn()
    .mockRejectedValue(Error("Конфликт сохранения: файл изменился."));
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("alert");
  fireEvent.click(reload);
  await screen.findByRole("dialog", { name: "Обновить файл с диска?" });
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(view.state.doc.toString()).toContain("local: true");
  expect(api.readProjectDocument).toHaveBeenCalledTimes(2);
  fireEvent.click(reload);
  fireEvent.click(screen.getByRole("button", { name: "Загрузить с диска" }));
  await waitFor(() => expect(view.state.doc.toString()).toBe("external: true"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(EditorView.findFromDOM(input()!)).toBe(view);
  expect(api.saveProjectDocument).toHaveBeenCalledTimes(1);
});
