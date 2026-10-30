// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { language } from "@codemirror/language";
import { deleteCharForward, redo, undo, undoDepth } from "@codemirror/commands";
import type { YamlEditorMemory } from "../src/renderer/YamlEditor";
import { OverviewEditor } from "../src/renderer/overview/OverviewEditor";
import * as languages from "../src/renderer/overview/languages";

afterEach(() => {
  cleanup();
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
