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
