// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
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
import { EditorView } from "@codemirror/view";
import type { DesktopAPI } from "../src/shared/bridge";
import type { OverviewAPI } from "../src/renderer/overview/store";
import { ProjectOverview } from "../src/renderer/overview/ProjectOverview";
import { RetainedViews } from "../src/renderer/RetainedViews";
import * as editorModule from "../src/renderer/overview/OverviewEditor";
import * as languages from "../src/renderer/overview/languages";
import { navigationHistory } from "../src/renderer/overview/navigation/state";
import { installHistoryWorker } from "./helpers/history-worker";
import "./helpers/overview-browser-fixture";

vi.mock("../src/renderer/overview/FileTree", () => ({
  // Only the virtual tree's geometry is replaced; store, editor and navigation are real.
  FileTree: ({ onFile }: { onFile: (path: string) => void }) => (
    <>
      {[
        "file.py",
        "file.js",
        "file.ts",
        "file.go",
        "file.kt",
        "file.swift",
        "file.yaml",
        "file.md",
        "file.jsx",
        "file.tsx",
        "file.txt",
      ].map((path) => (
        <button key={path} onClick={() => onFile(path)}>
          Открыть {path}
        </button>
      ))}
    </>
  ),
}));
const source =
  "def alpha(): pass\nclass A:\n    def alpha(self): pass\nclass B:\n    def alpha(self): pass\n\nalpha()\nunknown.alpha()\n";
const goName = "Перейти к определению",
  backName = "Назад к месту перехода";
function fixture() {
  let text = source;
  const api = {
    listOverviewDirectory: vi.fn(async () => ({
      path: "",
      entries: [],
      truncated: false,
    })),
    searchOverviewFiles: vi.fn(async () => ({
      path: "",
      entries: [],
      truncated: false,
    })),
    readOverviewFile: vi.fn(async (_scope, path) => ({
      relativePath: path,
      text,
      version: text,
      exists: true,
    })),
    saveOverviewFile: vi.fn(async (_scope, path, value) => {
      text = value;
      return { relativePath: path, text, version: text, exists: true };
    }),
    createOverviewEntry: vi.fn(async () => null),
    readOverviewSchema: vi.fn(async () => []),
    readOverviewContract: vi.fn(async () => ({})),
  } satisfies OverviewAPI;
  return {
    api,
    desktop: api as unknown as DesktopAPI,
    changeDisk: (value: string) => {
      text = value;
    },
  };
}
function editor() {
  return EditorView.findFromDOM(
    document
      .querySelector(".yaml-code-editor")!
      .shadowRoot!.querySelector<HTMLElement>(".cm-content")!,
  )!;
}
const button = (name: string) =>
  screen.getByRole<HTMLButtonElement>("button", { name });
async function open(path = "file.py") {
  fireEvent.click(button("Открыть " + path));
  await waitFor(() =>
    expect(
      document
        .querySelector(".yaml-code-editor")
        ?.shadowRoot?.querySelector(".cm-content")?.textContent,
    ).toContain("alpha"),
  );
}
async function ready() {
  await waitFor(() => expect(button(goName).disabled).toBe(false));
}
function jump() {
  act(() =>
    editor().dispatch({
      selection: { anchor: source.indexOf("\nalpha()") + 1 },
    }),
  );
  fireEvent.click(button(goName));
  expect(editor().state.selection.main.from).toBe(4);
}
function candidates() {
  act(() =>
    editor().dispatch({
      selection: { anchor: editor().state.doc.toString().lastIndexOf("alpha") },
    }),
  );
  fireEvent.click(button(goName));
  expect(editor().dom.querySelector('[role="dialog"]')).not.toBeNull();
}
beforeEach(() => {
  installHistoryWorker();
  document.execCommand = () => false;
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "execCommand");
});

it.each(["py", "js", "ts", "go", "kt", "swift"])(
  "shows accessible icons before search in the existing row for %s",
  async (extension) => {
    const { desktop } = fixture();
    render(<ProjectOverview scope="A" api={desktop} />);
    await open(`file.${extension}`);
    await ready();
    const back = button(backName),
      go = button(goName);
    expect(back.disabled).toBe(true);
    expect(go.title).toContain("F12");
    expect(go.title).toMatch(/Ctrl/);
    expect(go.title).toMatch(/⌘|Cmd/);
    expect(back.title).toContain(backName);
    expect(back.querySelector("svg.lucide-arrow-left")).not.toBeNull();
    expect(go.querySelector("svg.lucide-corner-down-right")).not.toBeNull();
    expect(go.parentElement).toBe(back.parentElement);
    expect(go.parentElement?.className).toBe("ov-file-actions");
    expect(
      [...go.parentElement!.querySelectorAll("button")]
        .slice(0, 4)
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual([backName, goName, "Найти в файле", "Заменить в файле"]);
    expect(document.querySelectorAll(".ov-file-actions")).toHaveLength(1);
    for (const name of [
      "Сохранить",
      "Закрыть без сохранения",
      "Обновить файл с диска",
    ])
      expect(button(name)).not.toBeNull();
  },
);

it.each(["yaml", "md", "jsx", "tsx", "txt"])(
  "does not add navigation to %s or Markdown preview",
  async (extension) => {
    const { desktop } = fixture();
    render(<ProjectOverview scope="A" api={desktop} />);
    await open(`file.${extension}`);
    expect(screen.queryByRole("button", { name: goName })).toBeNull();
    expect(screen.queryByRole("button", { name: backName })).toBeNull();
    if (extension === "md") {
      fireEvent.click(button("Предпросмотр Markdown"));
      expect(document.querySelector(".yaml-code-editor")).toBeNull();
      expect(screen.queryByRole("button", { name: goName })).toBeNull();
      fireEvent.keyDown(document, { key: "F12" });
      expect(screen.getByLabelText("Предпросмотр Markdown")).not.toBeNull();
    }
  },
);

it("disables only Go until the async grammar is installed", async () => {
  const support = await languages.loadOverviewLanguage("file.py");
  let resolve!: (value: typeof support) => void;
  vi.spyOn(languages, "loadOverviewLanguage").mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    }),
  );
  const { desktop } = fixture();
  render(<ProjectOverview scope="A" api={desktop} />);
  await open();
  expect(button(goName).disabled).toBe(true);
  expect(button(backName).disabled).toBe(true);
  expect(button("Найти в файле").disabled).toBe(false);
  expect(editor().state.readOnly).toBe(false);
  await act(async () => resolve(support));
  await ready();
});

it("uses only local navigation, preserves footer save status and existing find/replace/save/close actions", async () => {
  const { desktop, api } = fixture();
  render(<ProjectOverview scope="A" api={desktop} />);
  await open();
  await ready();
  const counts = Object.values(api).map((fn) => fn.mock.calls.length);
  act(() => editor().dispatch({ selection: { anchor: 0 } }));
  fireEvent.click(button(goName));
  const message = document.querySelector<HTMLElement>(
    ".ov-status [role='status']",
  )!;
  expect(message).not.toBeNull();
  expect(message.textContent).toBe(
    "Установите курсор на имя в месте использования.",
  );
  expect(message.title).toBe(message.textContent);
  expect(
    document.querySelector(".ov-document .ov-status")!.textContent,
  ).toContain("Сохранено");
  jump();
  expect(button(backName).disabled).toBe(false);
  expect(document.querySelector(".ov-status [role='status']")).toBeNull();
  candidates();
  fireEvent.mouseDown(button("Найти в файле"), { composed: true });
  fireEvent.click(button("Найти в файле"));
  expect(editor().dom.querySelector('[role="dialog"]')).toBeNull();
  expect(editor().dom.querySelector('[role="search"]')).not.toBeNull();
  fireEvent.click(button("Заменить в файле"));
  expect(
    within(editor().dom).getByRole<HTMLInputElement>("textbox", {
      name: "Заменить на",
    }).disabled,
  ).toBe(false);
  fireEvent.click(button(backName));
  expect(Object.values(api).map((fn) => fn.mock.calls.length)).toEqual(counts);
  act(() =>
    editor().dispatch({
      changes: { from: editor().state.doc.length, insert: "# new\n" },
    }),
  );
  expect(
    document.querySelector(".ov-document .ov-status")!.textContent,
  ).toContain("Не сохранено");
  fireEvent.click(button("Сохранить"));
  await waitFor(() => expect(api.saveOverviewFile).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(button("Сохранить").disabled).toBe(true));
  fireEvent.click(button("Закрыть без сохранения"));
  expect(document.querySelector(".yaml-code-editor")).toBeNull();
});

it("rejects a late presentation from the old memory even when the path is unchanged", async () => {
  const realEditor = editorModule.OverviewEditor;
  const renders: editorModule.OverviewEditorProps[] = [];
  vi.spyOn(editorModule, "OverviewEditor").mockImplementation((props) => {
    renders.push(props);
    return realEditor(props);
  });
  const { desktop, changeDisk } = fixture();
  render(<ProjectOverview scope="A" api={desktop} />);
  await open();
  await ready();
  jump();
  const old = renders.at(-1)!;
  changeDisk("# new memory\n" + source);
  fireEvent.click(button("Обновить файл с диска"));
  await waitFor(() => expect(renders.at(-1)!.memory).not.toBe(old.memory));
  await ready();
  expect(button(backName).disabled).toBe(true);
  act(() =>
    old.onNavigationChange!({
      supported: true,
      ready: true,
      canBack: true,
      message: "stale owner",
    }),
  );
  expect(button(backName).disabled).toBe(true);
  expect(
    document.querySelector(".ov-document .ov-status")!.textContent,
  ).not.toContain("stale owner");
});

it.each(["Проект", "Конвейер", "Другой топик"])(
  "closes retained A candidates on %s and keeps same-path histories isolated",
  async (destination) => {
    const a = fixture(),
      b = fixture();
    const content = (key: string) =>
      key === "A" ? (
        <ProjectOverview scope="A" api={a.desktop} />
      ) : key === "B" ? (
        <ProjectOverview scope="B" api={b.desktop} />
      ) : (
        <p>{key}</p>
      );
    const rendered = render(
      <RetainedViews activeKey="A">{content("A")}</RetainedViews>,
    );
    await open();
    await ready();
    jump();
    candidates();
    const first = editor();
    const destinationKey = destination === "Другой топик" ? "B" : destination;
    rendered.rerender(
      <RetainedViews activeKey={destinationKey}>
        {content(destinationKey)}
      </RetainedViews>,
    );
    expect(first.dom.isConnected).toBe(false);
    expect(first.dom.querySelector('[role="dialog"]')).toBeNull();
    expect(first.state.field(navigationHistory)).toHaveLength(1);
    if (destinationKey === "B") {
      await open();
      await ready();
      expect(editor()).not.toBe(first);
      expect(button(backName).disabled).toBe(true);
      expect(editor().state.field(navigationHistory)).toEqual([]);
    }
    rendered.rerender(
      <RetainedViews activeKey="A">{content("A")}</RetainedViews>,
    );
    await ready();
    expect(editor()).toBe(first);
    expect(first.dom.querySelector('[role="dialog"]')).toBeNull();
    expect(button(backName).disabled).toBe(false);
    fireEvent.click(button(backName));
    expect(first.state.selection.main.head).toBe(
      source.indexOf("\nalpha()") + 1,
    );
  },
);

it("keeps the compact message shrinkable without displacing save status or adding a focus outline", () => {
  const css = readFileSync(
    `${process.cwd()}/src/renderer/overview/overview.css`,
    "utf8",
  );
  expect(css).toMatch(
    /\.ov-status \.ov-navigation-message\s*\{[^}]*min-width:\s*0/,
  );
  expect(css).toMatch(
    /\.ov-status \.ov-navigation-message\s*\{[^}]*text-overflow:\s*ellipsis/,
  );
  expect(css).toMatch(/\.ov-status \.ov-save-status\s*\{[^}]*flex-shrink:\s*0/);
});
