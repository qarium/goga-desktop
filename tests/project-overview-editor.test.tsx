// @vitest-environment jsdom
import React, { createRef, useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import {
  deleteCharForward,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import {
  getSearchQuery,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { YamlEditorMemory } from "../src/renderer/YamlEditor";
import {
  OverviewEditor,
  type OverviewEditorCommands,
  type OverviewEditorProps,
} from "../src/renderer/overview/OverviewEditor";
import * as languages from "../src/renderer/overview/languages";

afterEach(() => {
  cleanup();
  delete (document as any).execCommand;
  vi.restoreAllMocks();
});
const editor = () =>
  EditorView.findFromDOM(
    document
      .querySelector(".yaml-code-editor")!
      .shadowRoot!.querySelector(".cm-content") as HTMLElement,
  )!;

it.each([
  ["main.ts", '\ufeffconst name = "🙂";\r\n// next\n'],
  ["CODEMANIFEST", '\ufeffname: "🙂"\r\nflag: true\n'],
  ["Dockerfile", '# note\r\nRUN echo "🙂" \\\r\n  && echo end\r\n'],
  ["notes.unknown", "\ufeff<unknown>\r\nraw\nend\r"],
])(
  "keeps BOM, CRLF and incomplete source byte-exact for %s",
  async (path, value) => {
    const onChange = vi.fn();
    render(<OverviewEditor path={path} value={value} onChange={onChange} />);
    const view = editor();
    const support = await languages.loadOverviewLanguage(path);
    if (support && !["CODEMANIFEST", "Dockerfile"].includes(path)) {
      await waitFor(() =>
        expect(view.state.facet(language)).toBe(support.language),
      );
    }
    expect(view.state.doc.toString()).toBe(value);
    expect(onChange).not.toHaveBeenCalled();
    const pasted = "\r\n# pasted\n[unfinished\r";
    act(() =>
      view.dispatch({
        changes: { from: view.state.doc.length, insert: pasted },
      }),
    );
    expect(onChange).toHaveBeenLastCalledWith(value + pasted);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(value);
    act(() => {
      expect(redo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(value + pasted);
  },
);

it("uses ready-made category colors and a source editor, never Markdown or HTML rendering", async () => {
  const value = "# Heading\n\n<script>window.bad = true</script>\n**bold**";
  render(<OverviewEditor path="README.md" value={value} onChange={() => {}} />);
  await waitFor(() =>
    expect(
      [...editor().dom.querySelectorAll(".overview-heading")]
        .map((node) => node.textContent)
        .join(""),
    ).toContain("Heading"),
  );
  expect(editor().state.doc.toString()).toBe(value);
  expect(editor().dom.querySelector("script, h1, strong")).toBeNull();
  expect(editor().contentDOM.getAttribute("aria-label")).toBe("README.md");
  expect(
    document.querySelector(".yaml-code-editor")!.shadowRoot,
  ).not.toBeNull();
});

it("preserves YAML scalar colors and Dockerfile CRLF comments and continuations", () => {
  const rendered = render(
    <OverviewEditor
      path="CODEMANIFEST"
      value={"count: 123\r\nflag: true\r\n"}
      onChange={() => {}}
    />,
  );
  expect(editor().dom.querySelector(".yaml-number")?.textContent).toBe("123");
  expect(editor().dom.querySelector(".yaml-boolean")?.textContent).toBe("true");
  rendered.rerender(
    <OverviewEditor
      path="Dockerfile"
      value={
        '# note\r\nRUN echo "hello" \\\r\n  && echo end\r\nFROM alpine\r\n'
      }
      onChange={() => {}}
    />,
  );
  expect(editor().dom.querySelector(".dockerfile-comment")?.textContent).toBe(
    "# note",
  );
  expect(
    [...editor().dom.querySelectorAll(".dockerfile-keyword")].map(
      (node) => node.textContent,
    ),
  ).toEqual(["RUN", "FROM"]);
});

it("retains the host and undo, updates callbacks, respects read-only and saves with Mod-S", async () => {
  const first = vi.fn(),
    latest = vi.fn(),
    save = vi.fn(),
    latestSave = vi.fn();
  const value = 'const value = "hello";\r\n';
  const rendered = render(
    <OverviewEditor
      path="main.ts"
      value={value}
      onChange={first}
      onSave={save}
    />,
  );
  const view = editor();
  act(() =>
    view.dispatch({
      changes: { from: 0, insert: "// edit\r\n" },
      selection: { anchor: 3 },
    }),
  );
  const edited = view.state.doc.toString();
  rendered.rerender(
    <OverviewEditor
      path="main.ts"
      value={edited}
      onChange={latest}
      onSave={latestSave}
      readOnly
    />,
  );
  expect(editor()).toBe(view);
  expect(view.state.selection.main.head).toBe(3);
  expect(undoDepth(view.state)).toBe(1);
  expect(view.state.readOnly).toBe(true);
  fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", ctrlKey: true });
  expect(latestSave).not.toHaveBeenCalled();
  rendered.rerender(
    <OverviewEditor
      path="main.ts"
      value={edited}
      onChange={latest}
      onSave={latestSave}
    />,
  );
  act(() => {
    expect(undo(view)).toBe(true);
  });
  expect(latest).toHaveBeenLastCalledWith(value);
  fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", ctrlKey: true });
  expect(latestSave).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(first).toHaveBeenCalledTimes(1);
});

it("keeps CRLF atomic for a dynamically highlighted source", async () => {
  const value = "const a = 1;\r\nconst b = 2;\n";
  render(<OverviewEditor path="main.js" value={value} onChange={() => {}} />);
  const support = await languages.loadOverviewLanguage("main.js");
  const view = editor();
  await waitFor(() =>
    expect(view.state.facet(language)).toBe(support!.language),
  );
  const pos = value.indexOf("\r\n");
  act(() => view.dispatch({ selection: { anchor: pos } }));
  act(() => {
    deleteCharForward(view);
  });
  expect(view.state.doc.toString()).toBe(
    value.slice(0, pos) + value.slice(pos + 2),
  );
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe(value);
});

it("isolates file histories and restores the owner's state and scroll from memory", () => {
  const first: YamlEditorMemory = {},
    second: YamlEditorMemory = {};
  const rendered = render(
    <OverviewEditor
      path="one.txt"
      value="first"
      onChange={() => {}}
      memory={first}
    />,
  );
  const original = editor();
  act(() =>
    original.dispatch({
      changes: { from: 5, insert: "!" },
      selection: { anchor: 2 },
    }),
  );
  original.scrollDOM.scrollTop = 120;
  original.scrollDOM.scrollLeft = 31;
  rendered.rerender(
    <OverviewEditor
      path="two.txt"
      value="second"
      onChange={() => {}}
      memory={second}
    />,
  );
  expect(editor()).not.toBe(original);
  expect(editor().state.doc.toString()).toBe("second");
  expect(undoDepth(editor().state)).toBe(0);
  rendered.rerender(
    <OverviewEditor
      path="one.txt"
      value="first!"
      onChange={() => {}}
      memory={first}
    />,
  );
  expect(editor().state.doc.toString()).toBe("first!");
  expect(editor().state.selection.main.head).toBe(2);
  expect(editor().scrollDOM.scrollTop).toBe(120);
  expect(editor().scrollDOM.scrollLeft).toBe(31);
  act(() => {
    expect(undo(editor())).toBe(true);
  });
  expect(editor().state.doc.toString()).toBe("first");
});

it("ignores a previous file's late language and keeps edits made while loading", async () => {
  const python = await languages.loadOverviewLanguage("one.py");
  const typescript = await languages.loadOverviewLanguage("two.ts");
  let resolvePython!: (support: typeof python) => void;
  let resolveTypescript!: (support: typeof typescript) => void;
  vi.spyOn(languages, "loadOverviewLanguage").mockImplementation(
    (path) =>
      new Promise((resolve) => {
        if (path.endsWith(".py")) resolvePython = resolve;
        else resolveTypescript = resolve;
      }),
  );
  const onChange = vi.fn();
  const rendered = render(
    <OverviewEditor
      path="one.py"
      value="def hello(): pass"
      onChange={onChange}
    />,
  );
  rendered.rerender(
    <OverviewEditor path="two.ts" value="const two = 2;" onChange={onChange} />,
  );
  const view = editor();
  act(() =>
    view.dispatch({
      changes: { from: view.state.doc.length, insert: " // edit" },
      selection: { anchor: 4 },
    }),
  );
  await act(async () => {
    resolveTypescript(typescript);
  });
  expect(view.state.facet(language)).toBe(typescript!.language);
  await act(async () => {
    resolvePython(python);
  });
  expect(editor()).toBe(view);
  expect(view.state.facet(language)).toBe(typescript!.language);
  expect(view.state.doc.toString()).toBe("const two = 2; // edit");
  expect(view.state.selection.main.head).toBe(4);
  expect(undoDepth(view.state)).toBe(1);
  expect(onChange).toHaveBeenCalledOnce();
});

it("keeps unknown source editable if a language chunk fails", async () => {
  vi.spyOn(languages, "loadOverviewLanguage").mockRejectedValue(
    new Error("local chunk unavailable"),
  );
  const onChange = vi.fn();
  render(
    <OverviewEditor path="main.py" value="unfinished" onChange={onChange} />,
  );
  await act(async () => {});
  act(() => editor().dispatch({ changes: { from: 10, insert: "!" } }));
  expect(editor().state.doc.toString()).toBe("unfinished!");
  expect(onChange).toHaveBeenLastCalledWith("unfinished!");
});

it("uses distinct readable source colors for keywords, strings and comments in the shadow stylesheet", async () => {
  render(
    <OverviewEditor
      path="palette.ts"
      value={'const name = "hello"; // note\n'}
      onChange={() => {}}
    />,
  );
  const view = editor();
  await waitFor(() =>
    expect(view.dom.querySelector(".overview-comment")?.textContent).toBe(
      "// note",
    ),
  );
  expect(view.dom.querySelector(".overview-keyword")?.textContent).toBe(
    "const",
  );
  expect(view.dom.querySelector(".overview-string")?.textContent).toBe(
    '"hello"',
  );
  const root = document.querySelector(".yaml-code-editor")!.shadowRoot!;
  const css = [...root.querySelectorAll("style")]
    .map((style) => style.textContent)
    .join("\n");
  expect(css).toMatch(/\.overview-keyword[^{}]*\{[^}]*color:\s*#c9aff5/i);
  expect(css).toMatch(/\.overview-string[^{}]*\{[^}]*color:\s*#b8d99b/i);
  expect(css).toMatch(/\.overview-comment[^{}]*\{[^}]*color:\s*#879ab3/i);
});

it("never applies a former grammar after switching to an unknown plain-text file", async () => {
  const python = await languages.loadOverviewLanguage("stale.py");
  let resolvePython!: (support: typeof python) => void;
  vi.spyOn(languages, "loadOverviewLanguage").mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePython = resolve;
      }),
  );
  const rendered = render(
    <OverviewEditor
      path="stale.py"
      value="def old(): pass"
      onChange={() => {}}
    />,
  );
  rendered.rerender(
    <OverviewEditor path="new.unknown" value="new text" onChange={() => {}} />,
  );
  const view = editor();
  await act(async () => {
    resolvePython(python);
  });
  expect(editor()).toBe(view);
  expect(view.state.facet(language)).toBeNull();
  expect(view.state.doc.toString()).toBe("new text");
});

it("binds loaded-file history and selection to replacement memory rather than its empty placeholder", () => {
  const placeholder: YamlEditorMemory = {};
  const loaded: YamlEditorMemory = {};
  const other: YamlEditorMemory = {};
  const onChange = vi.fn();
  const rendered = render(
    <OverviewEditor
      path="loaded.txt"
      value=""
      onChange={onChange}
      readOnly
      memory={placeholder}
    />,
  );
  rendered.rerender(
    <OverviewEditor
      path="loaded.txt"
      value="loaded"
      onChange={onChange}
      memory={loaded}
    />,
  );
  const loadedView = editor();
  act(() =>
    loadedView.dispatch({
      changes: { from: 6, insert: "!" },
      selection: { anchor: 3 },
    }),
  );
  rendered.rerender(
    <OverviewEditor
      path="loaded.txt"
      value="loaded!"
      onChange={onChange}
      memory={loaded}
    />,
  );
  expect(editor()).toBe(loadedView);
  rendered.rerender(
    <OverviewEditor
      path="other.txt"
      value="other"
      onChange={onChange}
      memory={other}
    />,
  );
  expect(loaded.state?.doc.toString()).toBe("loaded!");
  expect(loaded.state?.selection.main.head).toBe(3);
  expect(undoDepth(loaded.state!)).toBe(1);
  expect(placeholder.state?.doc.toString()).toBe("");
  rendered.rerender(
    <OverviewEditor
      path="loaded.txt"
      value="loaded!"
      onChange={onChange}
      memory={loaded}
    />,
  );
  expect(editor().state.doc.toString()).toBe("loaded!");
  expect(editor().state.selection.main.head).toBe(3);
  act(() => {
    expect(undo(editor())).toBe(true);
  });
  expect(editor().state.doc.toString()).toBe("loaded");
});

it("keeps dirty-refresh history for the same memory but resets it on clean reload with new memory", () => {
  const original: YamlEditorMemory = {};
  const refreshed: YamlEditorMemory = {};
  const other: YamlEditorMemory = {};
  const onChange = vi.fn();
  const rendered = render(
    <OverviewEditor
      path="reload.txt"
      value="original"
      onChange={onChange}
      memory={original}
    />,
  );
  const originalView = editor();
  act(() =>
    originalView.dispatch({
      changes: { from: 8, insert: "!" },
      selection: { anchor: 4 },
    }),
  );
  rendered.rerender(
    <OverviewEditor
      path="reload.txt"
      value="original!"
      onChange={onChange}
      memory={original}
    />,
  );
  expect(editor()).toBe(originalView);
  expect(undoDepth(editor().state)).toBe(1);
  expect(editor().state.selection.main.head).toBe(4);
  rendered.rerender(
    <OverviewEditor
      path="reload.txt"
      value="disk reload"
      onChange={onChange}
      memory={refreshed}
    />,
  );
  expect(undoDepth(editor().state)).toBe(0);
  expect(editor()).not.toBe(originalView);
  expect(editor().state.doc.toString()).toBe("disk reload");
  expect(original.state?.doc.toString()).toBe("original!");
  act(() => {
    expect(undo(editor())).toBe(false);
  });
  act(() =>
    editor().dispatch({
      changes: { from: 11, insert: "!" },
      selection: { anchor: 2 },
    }),
  );
  rendered.rerender(
    <OverviewEditor
      path="other.txt"
      value="other"
      onChange={onChange}
      memory={other}
    />,
  );
  expect(refreshed.state?.doc.toString()).toBe("disk reload!");
  expect(refreshed.state?.selection.main.head).toBe(2);
  rendered.rerender(
    <OverviewEditor
      path="reload.txt"
      value="disk reload!"
      onChange={onChange}
      memory={refreshed}
    />,
  );
  act(() => {
    expect(undo(editor())).toBe(true);
  });
  expect(editor().state.doc.toString()).toBe("disk reload");
});

it("uses consistent YAML key colors for CODEMANIFEST, including long raw signatures after arrow keys", () => {
  const signature =
    '"Example(argument: map[string]any, fallback: Value | None)"';
  const value = `->Config: {}\r\n->Hooks: {}\r\n${signature}:\r\n  location: main.go\r\n`;
  render(
    <OverviewEditor path="CODEMANIFEST" value={value} onChange={() => {}} />,
  );
  const view = editor();
  const lines = [...view.contentDOM.querySelectorAll(".cm-line")];
  const keySpans = [...view.contentDOM.querySelectorAll(".yaml-key")];
  expect(keySpans.map((e) => e.textContent)).toEqual([
    "->Config",
    "->Hooks",
    signature,
    "location",
  ]);
  // No parts of the opaque signature are presented as separate values/types.
  expect(
    lines[2].querySelector(".yaml-string,.overview-string,.overview-type"),
  ).toBeNull();
  expect(view.state.doc.toString()).toBe(value);
});

it.each(["CODEMANIFEST", "README.md", "main.go", "index.ts"])(
  "shares line indentation in the file editor for %s",
  (path) => {
    render(
      <OverviewEditor
        path={path}
        value={"first\nsecond"}
        onChange={() => {}}
      />,
    );
    const content = document
      .querySelector(".yaml-code-editor")!
      .shadowRoot!.querySelector(".cm-content")!;
    const view = EditorView.findFromDOM(content as HTMLElement)!;
    act(() =>
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
    );
    fireEvent.keyDown(content, {
      key: "Tab",
      keyCode: 9,
      bubbles: true,
      cancelable: true,
    });
    expect(view.state.doc.toString()).toBe("  first\n  second");
    fireEvent.keyDown(content, {
      key: "Tab",
      keyCode: 9,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(view.state.doc.toString()).toBe("first\nsecond");
  },
);

// Standalone editor tests exercise the same public commands as the file toolbar.
function EditorWithExternalActions(props: OverviewEditorProps) {
  const commands = useRef<OverviewEditorCommands>(null);
  return (
    <>
      <button
        aria-label="Найти в файле"
        onClick={() => commands.current?.find()}
      >
        Найти
      </button>
      <button
        aria-label="Заменить в файле"
        disabled={props.readOnly}
        onClick={() => commands.current?.replace()}
      >
        Заменить
      </button>
      <OverviewEditor {...props} commands={commands} />
    </>
  );
}

it("scopes external commands to one editor lifetime and refuses readonly replacement", () => {
  const commands = createRef<OverviewEditorCommands>();
  const rendered = render(
    <OverviewEditor
      path="one.txt"
      value="one"
      onChange={vi.fn()}
      commands={commands}
    />,
  );
  const first = editor();
  expect(commands.current).not.toBeNull();
  const stale = commands.current!;
  rendered.rerender(
    <OverviewEditor
      path="two.txt"
      value="two"
      onChange={vi.fn()}
      commands={commands}
      readOnly
    />,
  );
  const current = editor();
  expect(current).not.toBe(first);
  act(() => {
    stale.find();
    stale.replace();
  });
  expect(first.dom.querySelector('input[name="search"]')).toBeNull();
  expect(current.dom.querySelector('input[name="search"]')).toBeNull();
  act(() => commands.current!.replace());
  expect(current.dom.querySelector('input[name="replace"]')).toBeNull();
  act(() => commands.current!.find());
  expect(current.dom.querySelector('input[name="search"]')).not.toBeNull();
  const last = commands.current!;
  rendered.unmount();
  expect(commands.current).toBeNull();
  expect(() =>
    act(() => {
      last.find();
      last.replace();
    }),
  ).not.toThrow();
});

it("removes only Overview's whole-editor focus outline while retaining caret, selection and search focus rules", () => {
  render(
    <OverviewEditor path="main.yaml" value="flag: true" onChange={vi.fn()} />,
  );
  const view = editor();
  const modules = view.state
    .facet(EditorView.styleModule)
    .map((module) => module.getRules());
  // CodeMirror resolves equal-specificity themes in facet precedence order.
  const focused = modules.flatMap(
    (rules) => rules.match(/[^{}]*\.cm-focused[^{}]*\{[^}]*\}/g) ?? [],
  );
  expect(focused[0]).toMatch(/outline:\s*none/);
  expect(focused[0]).toMatch(/box-shadow:\s*none/);
  expect(modules.join("\n")).toMatch(/caret-color:\s*#ffffff/);
  expect(modules.join("\n")).toMatch(/::selection/);
  expect(modules.join("\n")).toMatch(/cm-overview-search input:focus-visible/);
  act(() => view.dispatch({ selection: { anchor: 0, head: 4 } }));
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe("flag");
  expect(view.dom.querySelector(".yaml-boolean")?.textContent).toBe("true");
});

it("supports external search and replacement, scopes shortcuts to this editor and keeps exact source with Undo", () => {
  // jsdom lacks the browser method used by CodeMirror when restoring focus.
  (document as any).execCommand = vi.fn(() => false);
  const changed = vi.fn();
  const value = "\ufeffone\r\none\nend\r";
  const rendered = render(
    <EditorWithExternalActions
      path="file.txt"
      value={value}
      onChange={changed}
    />,
  );
  const view = editor();
  fireEvent.click(rendered.getByRole("button", { name: "Найти в файле" }));
  const root = document.querySelector(".yaml-code-editor")!.shadowRoot!;
  const query = root.querySelector('input[name="search"]') as HTMLInputElement;
  expect(query).not.toBeNull();
  fireEvent.input(query, { target: { value: "one" } });
  fireEvent.click(root.querySelector('button[name="next"]')!);
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe("one");
  fireEvent.click(rendered.getByRole("button", { name: "Заменить в файле" }));
  const replacement = root.querySelector(
    'input[name="replace"]',
  ) as HTMLInputElement;
  fireEvent.input(replacement, { target: { value: "two" } });
  fireEvent.click(root.querySelector('button[name="replaceAll"]')!);
  expect(changed).toHaveBeenLastCalledWith("\ufefftwo\r\ntwo\nend\r");
  act(() => {
    expect(undo(view)).toBe(true);
  });
  expect(view.state.doc.toString()).toBe(value);
  fireEvent.keyDown(replacement, { key: "Escape", code: "Escape" });
  expect(root.querySelector('input[name="search"]')).toBeNull();
  fireEvent.keyDown(view.contentDOM, { key: "f", code: "KeyF", ctrlKey: true });
  expect(root.querySelector('input[name="search"]')).not.toBeNull();
  fireEvent.keyDown(view.contentDOM, { key: "r", code: "KeyR", ctrlKey: true });
  expect(root.activeElement).toBe(root.querySelector('input[name="replace"]'));
});

it("permits readonly search but never readonly replacement, including when the file becomes busy", () => {
  const changed = vi.fn();
  const rendered = render(
    <EditorWithExternalActions
      path="locked.txt"
      value="one one"
      onChange={changed}
    />,
  );
  const view = editor();
  fireEvent.click(rendered.getByRole("button", { name: "Заменить в файле" }));
  rendered.rerender(
    <EditorWithExternalActions
      path="locked.txt"
      value="one one"
      onChange={changed}
      readOnly
    />,
  );
  expect(
    (
      rendered.getByRole("button", {
        name: "Заменить в файле",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const root = document.querySelector(".yaml-code-editor")!.shadowRoot!;
  const query = root.querySelector('input[name="search"]') as HTMLInputElement;
  fireEvent.input(query, { target: { value: "one" } });
  fireEvent.click(root.querySelector('button[name="next"]')!);
  expect(
    view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    ),
  ).toBe("one");
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    'button[name="replace"], button[name="replaceAll"]',
  ))
    expect(button.disabled).toBe(true);
  expect(changed).not.toHaveBeenCalled();
});

it("navigates both directions and replaces a single match through the visible controls", () => {
  const changed = vi.fn();
  const rendered = render(
    <EditorWithExternalActions
      path="one.txt"
      value="one one"
      onChange={changed}
    />,
  );
  const view = editor();
  fireEvent.click(rendered.getByRole("button", { name: "Заменить в файле" }));
  const root = document.querySelector(".yaml-code-editor")!.shadowRoot!;
  fireEvent.input(root.querySelector('input[name="search"]')!, {
    target: { value: "one" },
  });
  fireEvent.click(root.querySelector('button[name="next"]')!);
  expect(view.state.selection.main.from).toBe(0);
  fireEvent.click(root.querySelector('button[name="next"]')!);
  expect(view.state.selection.main.from).toBe(4);
  fireEvent.click(root.querySelector('button[name="prev"]')!);
  expect(view.state.selection.main.from).toBe(0);
  fireEvent.input(root.querySelector('input[name="replace"]')!, {
    target: { value: "two" },
  });
  fireEvent.click(root.querySelector('button[name="replace"]')!);
  expect(changed).toHaveBeenLastCalledWith("two one");
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe("one one");
});

it("consumes readonly replace shortcuts without modifying the source and does not intercept another input", () => {
  const changed = vi.fn();
  const rendered = render(
    <>
      <input aria-label="Вне редактора" />
      <EditorWithExternalActions
        path="one.txt"
        value="one one"
        onChange={changed}
        readOnly
      />
    </>,
  );
  const view = editor();
  fireEvent.keyDown(rendered.getByRole("textbox", { name: "Вне редактора" }), {
    key: "r",
    code: "KeyR",
    ctrlKey: true,
  });
  const root = document.querySelector(".yaml-code-editor")!.shadowRoot!;
  expect(root.querySelector('input[name="search"]')).toBeNull();
  fireEvent.keyDown(view.contentDOM, { key: "r", code: "KeyR", ctrlKey: true });
  fireEvent.input(root.querySelector('input[name="search"]')!, {
    target: { value: "one" },
  });
  const replacement = root.querySelector('input[name="replace"]')!;
  expect((replacement as HTMLInputElement).disabled).toBe(true);
  fireEvent.input(replacement, { target: { value: "changed" } });
  fireEvent.keyDown(replacement, { key: "Enter", code: "Enter" });
  expect(view.state.doc.toString()).toBe("one one");
  expect(changed).not.toHaveBeenCalled();
});

it("leaves Enter on search buttons to native button activation", () => {
  const rendered = render(
    <EditorWithExternalActions
      path="one.txt"
      value="one one"
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(rendered.getByRole("button", { name: "Заменить в файле" }));
  const root = document.querySelector(".yaml-code-editor")!.shadowRoot!;
  fireEvent.input(root.querySelector('input[name="search"]')!, {
    target: { value: "one" },
  });
  for (const name of [
    "prev",
    "next",
    "clear",
    "close",
    "replace",
    "replaceAll",
  ]) {
    const button = root.querySelector(`button[name="${name}"]`);
    expect(button).not.toBeNull();
    expect(
      fireEvent.keyDown(button!, {
        key: "Enter",
        code: "Enter",
      }),
    ).toBe(true);
  }
});

it("clears the query and actual highlights without changing replacement, source, selection or history", () => {
  const value = "\ufeffone\r\none\nend\r";
  const changed = vi.fn();
  const rendered = render(
    <EditorWithExternalActions
      path="file.txt"
      value={value}
      onChange={changed}
    />,
  );
  const view = editor();
  act(() =>
    view.dispatch({ changes: { from: view.state.doc.length, insert: "!" } }),
  );
  fireEvent.click(rendered.getByRole("button", { name: "Заменить в файле" }));
  const panel = view.dom.querySelector<HTMLElement>('[role="search"]')!;
  const query = within(panel).getByRole("textbox", {
    name: "Найти",
  }) as HTMLInputElement;
  const replacement = within(panel).getByRole("textbox", {
    name: "Заменить на",
  }) as HTMLInputElement;
  fireEvent.input(query, { target: { value: "one" } });
  fireEvent.input(replacement, { target: { value: "two" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Далее" }));
  expect(view.dom.querySelectorAll(".cm-searchMatch")).toHaveLength(2);
  const selection = view.state.selection.toJSON();
  const undoBefore = undoDepth(view.state);
  const redoBefore = redoDepth(view.state);
  changed.mockClear();
  const clear = within(panel).getByRole("button", { name: "Очистить поиск" });
  const close = within(panel).getByRole("button", { name: "Закрыть поиск" });
  expect(clear).not.toBe(close);
  expect(query.parentElement!.contains(clear)).toBe(true);
  expect(query.parentElement!.contains(close)).toBe(false);
  expect(clear.title).toBe("Очистить поиск");
  expect(clear.textContent).toBe("");
  expect(clear.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  act(() => clear.focus());
  fireEvent.click(clear);
  expect(view.dom.querySelector('[role="search"]')).toBe(panel);
  expect(query.value).toBe("");
  expect(getSearchQuery(view.state).search).toBe("");
  expect(getSearchQuery(view.state).replace).toBe("two");
  expect(replacement.value).toBe("two");
  expect(replacement.disabled).toBe(false);
  expect(view.dom.querySelectorAll(".cm-searchMatch")).toHaveLength(0);
  expect(view.root.activeElement).toBe(query);
  expect(view.state.doc.toString()).toBe(value + "!");
  expect(view.state.selection.toJSON()).toEqual(selection);
  expect(undoDepth(view.state)).toBe(undoBefore);
  expect(redoDepth(view.state)).toBe(redoBefore);
  expect(changed).not.toHaveBeenCalled();
  act(() => expect(undo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(value);
  act(() => expect(redo(view)).toBe(true));
  expect(view.state.doc.toString()).toBe(value + "!");
});

it("shows clear only for a nonempty query and synchronizes programmatic query changes", () => {
  const commands = createRef<OverviewEditorCommands>();
  render(
    <OverviewEditor
      path="file.txt"
      value="one two"
      onChange={vi.fn()}
      commands={commands}
    />,
  );
  const view = editor();
  act(() => commands.current!.find());
  const panel = view.dom.querySelector<HTMLElement>('[role="search"]')!;
  const query = within(panel).getByRole("textbox", {
    name: "Найти",
  }) as HTMLInputElement;
  expect(
    within(panel).queryByRole("button", { name: "Очистить поиск" }),
  ).toBeNull();
  fireEvent.input(query, { target: { value: "one" } });
  const clear = within(panel).getByRole("button", {
    name: "Очистить поиск",
  }) as HTMLButtonElement;
  expect(clear.hidden).toBe(false);
  act(() =>
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({ search: "", replace: "saved", literal: true }),
      ),
    }),
  );
  expect(query.value).toBe("");
  expect(clear.hidden).toBe(true);
  expect(
    within(panel).queryByRole("button", { name: "Очистить поиск" }),
  ).toBeNull();
  act(() =>
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: "two",
          replace: "saved",
          literal: true,
          caseSensitive: true,
          wholeWord: true,
        }),
      ),
    }),
  );
  expect(query.value).toBe("two");
  expect(within(panel).getByRole("button", { name: "Очистить поиск" })).toBe(
    clear,
  );
  fireEvent.click(clear);
  expect(getSearchQuery(view.state)).toMatchObject({
    search: "",
    replace: "saved",
    literal: true,
    caseSensitive: true,
    wholeWord: true,
  });
  expect(clear.hidden).toBe(true);
  fireEvent.input(query, { target: { value: " " } });
  expect(within(panel).getByRole("button", { name: "Очистить поиск" })).toBe(
    clear,
  );
  fireEvent.input(query, { target: { value: "" } });
  expect(clear.hidden).toBe(true);
});

it("closes with a separate rightmost accessible icon and remembers the query through shortcuts and reopen", () => {
  (document as any).execCommand = vi.fn(() => false);
  const changed = vi.fn();
  const rendered = render(
    <EditorWithExternalActions
      path="file.txt"
      value="one one"
      onChange={changed}
    />,
  );
  const view = editor();
  fireEvent.click(rendered.getByRole("button", { name: "Заменить в файле" }));
  const panel = view.dom.querySelector<HTMLElement>('[role="search"]')!;
  fireEvent.input(within(panel).getByRole("textbox", { name: "Найти" }), {
    target: { value: "one" },
  });
  fireEvent.input(within(panel).getByRole("textbox", { name: "Заменить на" }), {
    target: { value: "two" },
  });
  const close = within(panel).getByRole("button", { name: "Закрыть поиск" });
  expect(close.title).toBe("Закрыть поиск");
  expect(close.textContent).toBe("");
  expect(close.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  expect(panel.firstElementChild!.lastElementChild).toBe(close);
  act(() => close.focus());
  fireEvent.click(close);
  expect(view.dom.querySelector('[role="search"]')).toBeNull();
  expect(view.root.activeElement).toBe(view.contentDOM);
  expect(getSearchQuery(view.state)).toMatchObject({
    search: "one",
    replace: "two",
  });
  fireEvent.keyDown(view.contentDOM, { key: "f", code: "KeyF", ctrlKey: true });
  const reopened = view.dom.querySelector<HTMLElement>('[role="search"]')!;
  const query = within(reopened).getByRole("textbox", {
    name: "Найти",
  }) as HTMLInputElement;
  expect(query.value).toBe("one");
  expect(view.root.activeElement).toBe(query);
  expect(
    within(reopened).getByRole("button", { name: "Очистить поиск" }),
  ).not.toBeNull();
  fireEvent.keyDown(query, { key: "r", code: "KeyR", ctrlKey: true });
  // jsdom may cache the former hidden row's computed style inside a shadow root.
  const replacement = within(reopened).getByLabelText(
    "Заменить на",
  ) as HTMLInputElement;
  expect(replacement.parentElement!.hidden).toBe(false);
  expect(replacement.value).toBe("two");
  expect(view.root.activeElement).toBe(replacement);
  fireEvent.keyDown(replacement, { key: "Escape", code: "Escape" });
  expect(view.dom.querySelector('[role="search"]')).toBeNull();
  expect(view.root.activeElement).toBe(view.contentDOM);
  fireEvent.click(rendered.getByRole("button", { name: "Найти в файле" }));
  expect(
    (view.dom.querySelector('input[name="search"]') as HTMLInputElement).value,
  ).toBe("one");
  expect(view.state.doc.toString()).toBe("one one");
  expect(changed).not.toHaveBeenCalled();
});

it("keeps the clear icon usable in readonly search without enabling replacement", () => {
  const changed = vi.fn();
  const rendered = render(
    <EditorWithExternalActions
      path="locked.txt"
      value={"one\r\none"}
      onChange={changed}
      readOnly
    />,
  );
  const view = editor();
  fireEvent.click(rendered.getByRole("button", { name: "Найти в файле" }));
  const panel = view.dom.querySelector<HTMLElement>('[role="search"]')!;
  const query = within(panel).getByRole("textbox", { name: "Найти" });
  fireEvent.input(query, { target: { value: "one" } });
  fireEvent.click(within(panel).getByRole("button", { name: "Далее" }));
  expect(view.dom.querySelectorAll(".cm-searchMatch")).toHaveLength(2);
  const selection = view.state.selection.toJSON();
  const clear = within(panel).getByRole("button", {
    name: "Очистить поиск",
  }) as HTMLButtonElement;
  expect(clear.disabled).toBe(false);
  fireEvent.click(clear);
  expect(getSearchQuery(view.state).search).toBe("");
  expect(view.dom.querySelectorAll(".cm-searchMatch")).toHaveLength(0);
  expect(view.state.selection.toJSON()).toEqual(selection);
  expect(view.root.activeElement).toBe(query);
  fireEvent.keyDown(query, { key: "r", code: "KeyR", ctrlKey: true });
  const replacement = panel.querySelector<HTMLInputElement>(
    'input[name="replace"]',
  )!;
  expect(replacement.disabled).toBe(true);
  for (const button of panel.querySelectorAll<HTMLButtonElement>(
    'button[name="replace"], button[name="replaceAll"]',
  )) {
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(view.state.doc.toString()).toBe("one\r\none");
  expect(undoDepth(view.state)).toBe(0);
  expect(changed).not.toHaveBeenCalled();
});

it("keeps source-path queries literal before and after clearing", () => {
  const path = String.raw`C:\temp\file.txt`;
  const changed = vi.fn();
  const rendered = render(
    <EditorWithExternalActions
      path="paths.txt"
      value={`${path}\r\n${path}`}
      onChange={changed}
    />,
  );
  const view = editor();
  fireEvent.click(rendered.getByRole("button", { name: "Найти в файле" }));
  const panel = view.dom.querySelector<HTMLElement>('[role="search"]')!;
  const query = within(panel).getByRole("textbox", { name: "Найти" });
  for (let i = 0; i < 2; i++) {
    fireEvent.input(query, { target: { value: path } });
    fireEvent.click(within(panel).getByRole("button", { name: "Далее" }));
    expect(
      view.state.sliceDoc(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe(path);
    expect(getSearchQuery(view.state).literal).toBe(true);
    fireEvent.click(
      within(panel).getByRole("button", { name: "Очистить поиск" }),
    );
  }
  expect(view.state.doc.toString()).toBe(`${path}\r\n${path}`);
  expect(changed).not.toHaveBeenCalled();
});

it("retains a cleared query only in its owner memory when the same path changes context", () => {
  const first: YamlEditorMemory = {},
    second: YamlEditorMemory = {};
  const commands = createRef<OverviewEditorCommands>();
  const changed = vi.fn();
  const props = {
    path: "same.txt",
    value: "one two",
    onChange: changed,
    commands,
  };
  const rendered = render(<OverviewEditor {...props} memory={first} />);
  act(() => commands.current!.replace());
  const stale = commands.current!;
  const firstView = editor();
  const firstPanel =
    firstView.dom.querySelector<HTMLElement>('[role="search"]')!;
  fireEvent.input(within(firstPanel).getByRole("textbox", { name: "Найти" }), {
    target: { value: "one" },
  });
  fireEvent.input(
    within(firstPanel).getByRole("textbox", { name: "Заменить на" }),
    { target: { value: "saved" } },
  );
  fireEvent.click(
    within(firstPanel).getByRole("button", { name: "Очистить поиск" }),
  );
  rendered.rerender(<OverviewEditor {...props} memory={second} />);
  const secondView = editor();
  act(() => {
    stale.find();
    stale.replace();
  });
  expect(secondView.dom.querySelector('[role="search"]')).toBeNull();
  act(() => commands.current!.find());
  fireEvent.input(secondView.dom.querySelector('input[name="search"]')!, {
    target: { value: "two" },
  });
  rendered.rerender(<OverviewEditor {...props} memory={first} />);
  act(() => commands.current!.replace());
  expect(getSearchQuery(editor().state)).toMatchObject({
    search: "",
    replace: "saved",
  });
  expect(
    within(editor().dom).queryByRole("button", { name: "Очистить поиск" }),
  ).toBeNull();
  rendered.rerender(<OverviewEditor {...props} memory={second} />);
  act(() => commands.current!.find());
  expect(getSearchQuery(editor().state).search).toBe("two");
  expect(
    within(editor().dom).getByRole("button", { name: "Очистить поиск" }),
  ).not.toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("reserves input space for the clear icon and keeps compact wrapping and keyboard focus styles local", () => {
  render(<OverviewEditor path="file.txt" value="one" onChange={vi.fn()} />);
  const css = editor()
    .state.facet(EditorView.styleModule)
    .map((module) => module.getRules())
    .join("\n");
  expect(css).toMatch(
    /\.cm-overview-search-field[^{}]*\{[^}]*position:\s*relative/,
  );
  expect(css).toMatch(/\.cm-overview-search-field[^{}]*\{[^}]*min-width:\s*0/);
  expect(css).toMatch(
    /\.cm-overview-search-field input[^{}]*\{[^}]*padding-right:\s*28px/,
  );
  expect(css).toMatch(
    /\.cm-overview-search-clear[^{}]*\{[^}]*position:\s*absolute/,
  );
  expect(css).toMatch(/\.cm-overview-search-clear[^{}]*\{[^}]*right:\s*4px/);
  expect(css).toMatch(
    /\.cm-overview-search[^{}]*> div[^{}]*\{[^}]*flex-wrap:\s*wrap/,
  );
  expect(css).toMatch(
    /\.cm-overview-search-close[^{}]*\{[^}]*margin-left:\s*auto/,
  );
  expect(css).toMatch(
    /\.cm-overview-search button:focus-visible[^{}]*\{[^}]*outline:/,
  );
});
