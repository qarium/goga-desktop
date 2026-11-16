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
function renderProjectDocument(target: ProjectDocumentTarget) {
  // jsdom reports Safari but omits its shadow-selection command.
  document.execCommand = () => false;
  const store = createSettingsDocuments();
  api.readProjectDocument = vi.fn(async () => ({
    text: source,
    version: "v1",
    exists: true,
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
    <main className="main-area">
      <div className="project-page">
        <div className="scroll-area">
          <RetainedViews activeKey={active ? "editor" : "other"}>
            {active ? content : <input aria-label="Другая форма" />}
          </RetainedViews>
        </div>
      </div>
    </main>
  );
  const ui = render(shell(true));
  return (active: boolean) => ui.rerender(shell(active));
}
const sizeButton = (expanded: boolean) =>
  screen.getByRole("button", {
    name: expanded ? "Свернуть документ" : "Развернуть документ",
  });

it.each(projectTargets)(
  "expands and collapses the same project $kind editor beside its save actions",
  async (target) => {
    renderProjectDocument(target);
    await screen.findByRole("button", { name: "Сохранить" });
    const button = sizeButton(false);
    expect(
      button
        .closest(".document-save-actions")
        ?.contains(screen.getByRole("button", { name: "Отменить изменения" })),
    ).toBe(true);
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
    view.scrollDOM.scrollTop = 270;
    view.scrollDOM.scrollLeft = 30;
    fireEvent.click(button);
    expect(sizeButton(true).getAttribute("aria-expanded")).toBe("true");
    expect(view.scrollDOM.scrollTop).toBe(270);
    view.scrollDOM.scrollLeft = 7; // user changed the horizontal reading position
    expect(
      fireEvent.keyDown(view.contentDOM, { key: "Escape", composed: true }),
    ).toBe(false);
    expect(sizeButton(false).getAttribute("aria-expanded")).toBe("false");
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
  fireEvent.click(sizeButton(false));
  show(false);
  const other = screen.getByRole("textbox", { name: "Другая форма" });
  other.focus();
  expect(fireEvent.keyDown(other, { key: "Escape" })).toBe(true);
  expect(document.activeElement).toBe(other);
  show(true);
  expect(sizeButton(false).getAttribute("aria-expanded")).toBe("false");
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
  await screen.findByText(/Сохранено\./);
  expect(api.saveProjectDocument).toHaveBeenCalledWith(
    "p",
    target,
    "# saved\n" + source,
    "v1",
  );
  act(() => view.dispatch({ changes: { from: 0, insert: "# discarded\n" } }));
  fireEvent.click(screen.getByRole("button", { name: "Отменить изменения" }));
  expect(view.state.doc.toString()).toBe("# saved\n" + source);
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
