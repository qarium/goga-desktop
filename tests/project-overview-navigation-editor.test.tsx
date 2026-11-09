// @vitest-environment jsdom
import React, { createRef, useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { language, type LanguageSupport } from "@codemirror/language";
import { undo, undoDepth } from "@codemirror/commands";
import {
  OverviewEditor,
  type OverviewEditorCommands,
} from "../src/renderer/overview/OverviewEditor";
import type { YamlEditorMemory } from "../src/renderer/YamlEditor";
import type { NavigationPresentation } from "../src/renderer/overview/navigation/types";
import { navigationHistory } from "../src/renderer/overview/navigation/state";
import {
  createOverviewStore,
  type OverviewAPI,
} from "../src/renderer/overview/store";
import * as languages from "../src/renderer/overview/languages";

const source = "def alpha():\n    return 1\n\nalpha()\n";
const call = source.lastIndexOf("alpha");
const python = await languages.loadOverviewLanguage("file.py");
const javascript = await languages.loadOverviewLanguage("file.js");
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function editor() {
  return EditorView.findFromDOM(
    document
      .querySelector(".yaml-code-editor")!
      .shadowRoot!.querySelector<HTMLElement>(".cm-content")!,
  )!;
}
async function ready(
  reports: ReturnType<typeof vi.fn<(state: NavigationPresentation) => void>>,
) {
  await waitFor(() =>
    expect(reports).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true }),
    ),
  );
}
function jump(
  view: EditorView,
  commands: React.RefObject<OverviewEditorCommands | null>,
) {
  act(() => {
    view.dispatch({
      selection: { anchor: view.state.doc.toString().lastIndexOf("alpha") },
    });
    commands.current!.goToDefinition();
  });
  expect(view.state.selection.main.from).toBe(4);
}
beforeEach(() => {
  document.execCommand = () => false;
  Range.prototype.getClientRects = () =>
    Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "execCommand");
  vi.restoreAllMocks();
});

it("mounts history before async grammar, preserves view and undo, then maps Back through an edit", async () => {
  const loading = deferred<LanguageSupport | null>();
  vi.spyOn(languages, "loadOverviewLanguage").mockReturnValue(loading.promise);
  const commands = createRef<OverviewEditorCommands>();
  const reports = vi.fn<(state: NavigationPresentation) => void>();
  const change = vi.fn();
  render(
    <OverviewEditor
      path="file.py"
      value={source}
      onChange={change}
      commands={commands}
      onNavigationChange={reports}
    />,
  );
  const view = editor();
  expect(view.root).toBeInstanceOf(ShadowRoot);
  expect(view.state.field(navigationHistory, false)).toEqual([]);
  expect(commands.current?.goToDefinition).toBeTypeOf("function");
  act(() => {
    view.dispatch({ selection: { anchor: call } });
    commands.current!.goToDefinition();
    view.dispatch({ changes: { from: source.length, insert: "# pending\n" } });
  });
  expect(view.state.selection.main.head).toBe(call);
  expect(undoDepth(view.state)).toBe(1);
  await act(async () => loading.resolve(python));
  await ready(reports);
  expect(editor()).toBe(view);
  expect(view.state.facet(language)).toBe(python!.language);
  expect(undoDepth(view.state)).toBe(1);
  jump(view, commands);
  act(() => {
    view.dispatch({ changes: { from: 0, insert: "# edit\n" } });
    commands.current!.goBack();
  });
  expect(view.state.selection.main.head).toBe(call + 7);
  expect(view.state.field(navigationHistory)).toEqual([]);
  expect(change).toHaveBeenLastCalledWith("# edit\n" + source + "# pending\n");
});

it("separates same-path memories, restores the original history and makes old handles inert", async () => {
  const first: YamlEditorMemory = {},
    second: YamlEditorMemory = {};
  const commands = createRef<OverviewEditorCommands>();
  const reports = vi.fn<(state: NavigationPresentation) => void>();
  const props = {
    path: "same.py",
    value: source,
    onChange: vi.fn(),
    commands,
    onNavigationChange: reports,
  };
  const rendered = render(<OverviewEditor {...props} memory={first} />);
  await ready(reports);
  jump(editor(), commands);
  const stale = commands.current!;
  rendered.rerender(<OverviewEditor {...props} memory={second} />);
  await ready(reports);
  const secondView = editor();
  expect(secondView.state.field(navigationHistory)).toEqual([]);
  const snapshot = secondView.state;
  act(() => {
    stale.goBack();
    stale.goToDefinition();
    stale.find();
    stale.replace();
  });
  expect(secondView.state).toBe(snapshot);
  rendered.rerender(<OverviewEditor {...props} memory={first} />);
  await ready(reports);
  expect(editor().state.field(navigationHistory)).toHaveLength(1);
  act(() => commands.current!.goBack());
  expect(editor().state.selection.main.head).toBe(call);
  expect(props.onChange).not.toHaveBeenCalled();
  const last = commands.current!;
  rendered.unmount();
  expect(() => {
    last.goToDefinition();
    last.goBack();
  }).not.toThrow();
});

it("restores history after a full unmount without reviving a transient candidate popup", async () => {
  const value =
    "def alpha(): pass\nclass A:\n    def alpha(self): pass\nclass B:\n    def alpha(self): pass\n\nalpha()\nunknown.alpha()\n";
  const memory: YamlEditorMemory = {};
  const commands = createRef<OverviewEditorCommands>();
  const reports = vi.fn<(state: NavigationPresentation) => void>();
  const props = {
    path: "same.py",
    value,
    onChange: vi.fn(),
    commands,
    onNavigationChange: reports,
    memory,
  };
  let rendered = render(<OverviewEditor {...props} />);
  await ready(reports);
  act(() => {
    editor().dispatch({
      selection: { anchor: value.indexOf("\nalpha()") + 1 },
    });
    commands.current!.goToDefinition();
  });
  expect(editor().state.field(navigationHistory)).toHaveLength(1);
  act(() => {
    editor().dispatch({ selection: { anchor: value.lastIndexOf("alpha") } });
    commands.current!.goToDefinition();
  });
  expect(editor().dom.querySelector('[role="dialog"]')).not.toBeNull();
  rendered.unmount();
  rendered = render(<OverviewEditor {...props} />);
  await ready(reports);
  expect(editor().state.field(navigationHistory)).toHaveLength(1);
  expect(editor().dom.querySelector('[role="dialog"]')).toBeNull();
  rendered.unmount();
});

it("ignores late successful or failed grammar results from the former file", async () => {
  const old = deferred<LanguageSupport | null>(),
    current = deferred<LanguageSupport | null>();
  vi.spyOn(languages, "loadOverviewLanguage").mockImplementation((path) =>
    path.endsWith("py") ? old.promise : current.promise,
  );
  const commands = createRef<OverviewEditorCommands>();
  const reports = vi.fn<(state: NavigationPresentation) => void>();
  const props = { onChange: vi.fn(), commands, onNavigationChange: reports };
  const rendered = render(
    <OverviewEditor {...props} path="old.py" value={source} />,
  );
  rendered.rerender(
    <OverviewEditor
      {...props}
      path="new.js"
      value="function alpha() {}\nalpha();"
    />,
  );
  const view = editor();
  await act(async () => old.resolve(python));
  expect(view.state.facet(language)).toBeNull();
  expect(reports).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: false }),
  );
  await act(async () => current.resolve(javascript));
  await ready(reports);
  expect(editor()).toBe(view);
  expect(view.state.facet(language)).toBe(javascript!.language);
  // Repeat with a rejected stale owner after the new language is already ready.
  const stale = deferred<LanguageSupport | null>();
  vi.mocked(languages.loadOverviewLanguage).mockImplementation((path) =>
    path.endsWith("py") ? stale.promise : Promise.resolve(javascript),
  );
  rendered.rerender(<OverviewEditor {...props} path="old.py" value={source} />);
  rendered.rerender(
    <OverviewEditor
      {...props}
      path="new.js"
      value="function alpha() {}\nalpha();"
    />,
  );
  await ready(reports);
  await act(async () => stale.reject(new Error("late failure")));
  expect(editor().state.facet(language)).toBe(javascript!.language);
  expect(reports).toHaveBeenLastCalledWith(
    expect.objectContaining({ ready: true }),
  );
});

it("keeps a failed language editable and saveable with navigation disabled", async () => {
  vi.spyOn(languages, "loadOverviewLanguage").mockRejectedValue(
    new Error("offline grammar"),
  );
  const commands = createRef<OverviewEditorCommands>();
  const reports = vi.fn<(state: NavigationPresentation) => void>();
  const change = vi.fn(),
    save = vi.fn();
  render(
    <OverviewEditor
      path="file.py"
      value={source}
      onChange={change}
      onSave={save}
      commands={commands}
      onNavigationChange={reports}
    />,
  );
  await waitFor(() =>
    expect(reports).toHaveBeenLastCalledWith(
      expect.objectContaining({ supported: true, ready: false }),
    ),
  );
  const view = editor();
  act(() => {
    view.dispatch({ selection: { anchor: call } });
    commands.current!.goToDefinition();
    view.dispatch({ changes: { from: source.length, insert: "# editable" } });
  });
  expect(view.state.selection.main.head).toBe(call);
  expect(view.state.field(navigationHistory)).toEqual([]);
  expect(change).toHaveBeenCalledWith(source + "# editable");
  fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", ctrlKey: true });
  expect(save).toHaveBeenCalledTimes(1);
});

it("allows readonly navigation, disables inactive commands and reports only real changes to the latest callback", async () => {
  const commands = createRef<OverviewEditorCommands>();
  const oldReport = vi.fn<(state: NavigationPresentation) => void>();
  const latest = vi.fn<(state: NavigationPresentation) => void>();
  const props = {
    path: "file.py",
    value: source,
    onChange: vi.fn(),
    commands,
    readOnly: true,
  };
  const rendered = render(
    <OverviewEditor {...props} onNavigationChange={oldReport} />,
  );
  await ready(oldReport);
  rendered.rerender(<OverviewEditor {...props} onNavigationChange={latest} />);
  const count = oldReport.mock.calls.length;
  const view = editor();
  jump(view, commands);
  expect(oldReport).toHaveBeenCalledTimes(count);
  expect(latest).toHaveBeenLastCalledWith(
    expect.objectContaining({ canBack: true }),
  );
  const reported = latest.mock.calls.length;
  act(() => {
    view.dispatch({ selection: { anchor: 0 } });
    fireEvent.mouseMove(view.contentDOM, { clientX: 10, clientY: 10 });
  });
  expect(latest).toHaveBeenCalledTimes(reported);
  rendered.rerender(
    <OverviewEditor {...props} onNavigationChange={latest} active={false} />,
  );
  const snapshot = view.state;
  act(() => {
    commands.current!.goBack();
    commands.current!.goToDefinition();
  });
  fireEvent.keyDown(view.contentDOM, { key: "F12" });
  expect(view.state).toBe(snapshot);
  expect(view.state.field(navigationHistory)).toHaveLength(1);
  rendered.rerender(
    <OverviewEditor {...props} onNavigationChange={latest} active />,
  );
  act(() => commands.current!.goBack());
  expect(view.state.selection.main.head).toBe(call);
  expect(props.onChange).not.toHaveBeenCalled();
});

it.each([source, "#x\n\nalpha = 1\nalpha\n"])(
  "retains history and undo on real store save/dirty conflict refresh, but resets them for a clean replacement memory: %s",
  async (source) => {
    let disk = {
      relativePath: "file.py",
      text: source,
      version: "initial",
      exists: true,
    };
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
      readOverviewFile: vi.fn(async () => ({ ...disk })),
      saveOverviewFile: vi.fn(async (_scope, _path, text) => {
        disk = { ...disk, text, version: "saved" };
        return { ...disk };
      }),
      createOverviewEntry: vi.fn(async () => null),
      readOverviewSchema: vi.fn(async () => []),
      readOverviewContract: vi.fn(async () => ({})),
    } satisfies OverviewAPI;
    const store = createOverviewStore(api, "project");
    const commands = createRef<OverviewEditorCommands>();
    const reports = vi.fn<(state: NavigationPresentation) => void>();
    function Host() {
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
      const file = state.files["file.py"];
      return file ? (
        <OverviewEditor
          path="file.py"
          value={file.text}
          memory={file.memory}
          onChange={(text) => store.edit("file.py", text)}
          commands={commands}
          onNavigationChange={reports}
        />
      ) : null;
    }
    const rendered = render(<Host />);
    await act(async () => {
      await store.open("file.py");
    });
    await ready(reports);
    const view = editor();
    jump(view, commands);
    act(() =>
      view.dispatch({ changes: { from: source.length, insert: "# local\n" } }),
    );
    const memory = store.getSnapshot().files["file.py"].memory;
    const depth = undoDepth(view.state);
    await act(async () => {
      await store.save("file.py");
    });
    expect(store.getSnapshot().files["file.py"].memory).toBe(memory);
    expect(editor()).toBe(view);
    expect(undoDepth(view.state)).toBe(depth);
    expect(view.state.field(navigationHistory)).toHaveLength(1);
    act(() =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "# dirty\n" },
      }),
    );
    disk = { ...disk, text: source + "# disk\n", version: "external" };
    await act(async () => {
      await store.refreshAll();
    });
    expect(store.getSnapshot().files["file.py"].changedExternally).toBe(true);
    expect(store.getSnapshot().files["file.py"].memory).toBe(memory);
    expect(editor()).toBe(view);
    expect(view.state.field(navigationHistory)).toHaveLength(1);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    await act(async () => {
      await store.save("file.py");
    });
    disk = { ...disk, text: "# new disk\n" + source, version: "replacement" };
    await act(async () => {
      await store.refreshAll();
    });
    await ready(reports);
    expect(store.getSnapshot().files["file.py"].memory).not.toBe(memory);
    expect(editor()).not.toBe(view);
    expect(editor().state.field(navigationHistory)).toEqual([]);
    expect(undoDepth(editor().state)).toBe(0);
    rendered.unmount();
    store.dispose();
  },
);

it("navigates a readonly variable without editing or adding undo", async () => {
  const value = "const limit=3;\nconsole.log(limit);",
    origin = value.lastIndexOf("limit");
  const commands = createRef<OverviewEditorCommands>(),
    reports = vi.fn<(state: NavigationPresentation) => void>(),
    change = vi.fn();
  render(
    <OverviewEditor
      path="file.js"
      value={value}
      readOnly
      onChange={change}
      commands={commands}
      onNavigationChange={reports}
    />,
  );
  await ready(reports);
  const view = editor();
  act(() => {
    view.dispatch({ selection: { anchor: origin } });
    commands.current!.goToDefinition();
  });
  expect(view.state.selection.main.from).toBe(6);
  expect(change).not.toHaveBeenCalled();
  expect(undoDepth(view.state)).toBe(0);
  act(() => commands.current!.goBack());
  expect(view.state.selection.main.head).toBe(origin);
});

it("properties keep contextual history, stale candidates are inert, and HTML stays text", async () => {
  const value =
    'class Box {value="<img src=x onerror=alert(1)>";}\nunknown.value;';
  const commands = createRef<OverviewEditorCommands>(),
    reports = vi.fn<(state: NavigationPresentation) => void>(),
    change = vi.fn();
  const first: YamlEditorMemory = {},
    second: YamlEditorMemory = {};
  const props = {
    path: "same.js",
    value,
    onChange: change,
    commands,
    onNavigationChange: reports,
  };
  const rendered = render(<OverviewEditor {...props} memory={first} />);
  await ready(reports);
  const view = editor(),
    origin = value.lastIndexOf("value");
  act(() => {
    view.dispatch({ selection: { anchor: origin } });
    commands.current!.goToDefinition();
  });
  const dialog = view.dom.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain(
    "Найдено несколько возможных объявлений или точная связь не установлена.",
  );
  expect(dialog.querySelector("img")).toBeNull();
  expect(dialog.textContent).toContain("<img src=x");
  const stale = dialog.querySelector<HTMLButtonElement>("[data-candidate]")!;
  act(() => view.dispatch({ changes: { from: 0, insert: "// unsaved\n" } }));
  const edited = view.state;
  act(() => stale.click());
  expect(view.state).toBe(edited);
  act(() => {
    view.dispatch({ selection: { anchor: origin + 11 } });
    commands.current!.goToDefinition();
  });
  const candidate =
    view.dom.querySelector<HTMLButtonElement>("[data-candidate]")!;
  act(() => candidate.click());
  expect(view.state.selection.main.from).toBe(value.indexOf("value") + 11);
  expect(undoDepth(view.state)).toBe(1);
  rendered.rerender(
    <OverviewEditor
      {...props}
      value={view.state.doc.toString()}
      memory={first}
      active={false}
    />,
  );
  const inactive = view.state;
  act(() => commands.current!.goBack());
  expect(view.state).toBe(inactive);
  rendered.rerender(<OverviewEditor {...props} memory={second} />);
  await ready(reports);
  expect(editor().state.field(navigationHistory)).toEqual([]);
  rendered.rerender(
    <OverviewEditor {...props} value={edited.doc.toString()} memory={first} />,
  );
  await ready(reports);
  act(() => commands.current!.goBack());
  expect(editor().state.selection.main.head).toBe(origin + 11);
  expect(editor().state.doc.toString()).toBe("// unsaved\n" + value);
});
