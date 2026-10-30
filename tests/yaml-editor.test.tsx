// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { EditorView, keymap } from "@codemirror/view";
import {
  redo,
  undo,
  undoDepth,
  deleteCharBackward,
  deleteCharForward,
  cursorCharForward,
  cursorCharBackward,
  selectCharForward,
  selectCharBackward,
  cursorLineEnd,
  selectLineEnd,
  insertNewline,
} from "@codemirror/commands";
import { YamlEditor } from "../src/renderer/YamlEditor";

afterEach(cleanup);
const editor = () =>
  EditorView.findFromDOM(
    document
      .querySelector(".yaml-code-editor")!
      .shadowRoot!.querySelector(".cm-content") as HTMLElement,
  )!;
it.each([
  '# комментарий\nunknown: "🙂"\nbody: |\n  literal\nunfinished: [',
  "a: 1\r\nb: true\r\n",
  'a: 1\r\nb: true\nc: "x"\r\ntrailing: yes\r',
])("round-trips original and edited YAML exactly: %j", (value) => {
  const onChange = vi.fn();
  render(<YamlEditor value={value} onChange={onChange} />);
  const view = editor();
  expect(view.state.doc.toString()).toBe(value);
  expect(onChange).not.toHaveBeenCalled();
  const inserted = "\n# pasted\r\nempty: [\r\n";
  act(() =>
    view.dispatch({
      changes: { from: view.state.doc.length, insert: inserted },
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith(value + inserted);
  expect(view.state.doc.toString()).toBe(value + inserted);
});
it("retains the view, selection and history on controlled rerenders and busy cycles with latest callback", () => {
  const first = vi.fn(),
    latest = vi.fn();
  const rendered = render(<YamlEditor value={"a: 1\n"} onChange={first} />);
  const view = editor();
  act(() =>
    view.dispatch({
      changes: { from: 3, to: 4, insert: "2" },
      selection: { anchor: 3, head: 4 },
    }),
  );
  rendered.rerender(<YamlEditor value={"a: 2\n"} onChange={latest} readOnly />);
  expect(editor()).toBe(view);
  expect(view.state.selection.main.from).toBe(3);
  expect(view.state.selection.main.to).toBe(4);
  expect(undoDepth(view.state)).toBe(1);
  expect(view.state.readOnly).toBe(true);
  expect(view.contentDOM.getAttribute("contenteditable")).toBe("false");
  expect(view.contentDOM.getAttribute("aria-readonly")).toBe("true");
  act(() => {
    expect(undo(view)).toBe(false);
  });
  rendered.rerender(<YamlEditor value={"a: 2\n"} onChange={latest} />);
  expect(editor()).toBe(view);
  act(() => {
    expect(undo(view)).toBe(true);
  });
  expect(latest).toHaveBeenLastCalledWith("a: 1\n");
  act(() => {
    expect(redo(view)).toBe(true);
  });
  expect(latest).toHaveBeenLastCalledWith("a: 2\n");
  expect(first).toHaveBeenCalledTimes(1);
});
it("applies an explicitly changed external value without onChange feedback", () => {
  const onChange = vi.fn();
  const rendered = render(<YamlEditor value={"a: 1\n"} onChange={onChange} />);
  const view = editor();
  rendered.rerender(<YamlEditor value={"next: [\r\n"} onChange={onChange} />);
  expect(editor()).toBe(view);
  expect(view.state.doc.toString()).toBe("next: [\r\n");
  expect(onChange).not.toHaveBeenCalled();
});
it("highlights YAML token categories without interpreting content as HTML or scalar schema", () => {
  const value =
    '# comment\nkey: "string"\ncount: 123\nflag: true\nlegacy: yes\nquoted: "123"\nbody: |\n  123\nhtml: "<img src=x onerror=alert(1)>"\nunfinished: [\n';
  render(<YamlEditor value={value} onChange={() => {}} />);
  const view = editor();
  expect(view.dom.querySelector(".yaml-key")?.textContent).toBe("key");
  expect(view.dom.querySelector(".yaml-string")?.textContent).toBe('"string"');
  expect(view.dom.querySelector(".yaml-comment")?.textContent).toBe(
    "# comment",
  );
  expect(
    [...view.dom.querySelectorAll(".yaml-number")].map((e) => e.textContent),
  ).toEqual(["123"]);
  expect(
    [...view.dom.querySelectorAll(".yaml-boolean")].map((e) => e.textContent),
  ).toEqual(["true", "yes"]);
  expect(view.dom.querySelector("img")).toBeNull();
  expect(view.state.doc.toString()).toBe(value);
});
it("does not consume Tab and destroys its view on unmount", () => {
  const rendered = render(<YamlEditor value="a: 1" onChange={() => {}} />);
  const view = editor();
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    code: "Tab",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(view.contentDOM, event);
  expect(event.defaultPrevented).toBe(false);
  expect(view.state.doc.toString()).toBe("a: 1");
  const destroy = vi.spyOn(view, "destroy");
  rendered.unmount();
  expect(destroy).toHaveBeenCalledOnce();
});
it("inserts only a newline on Enter rather than adding indentation", () => {
  render(<YamlEditor value={"body:\n  nested: value"} onChange={() => {}} />);
  const view = editor();
  act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
  fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter" });
  expect(view.state.doc.toString()).toBe("body:\n  nested: value\n");
});

it("isolates CodeMirror styles in a shadow root without relaxing the renderer CSP", () => {
  render(<YamlEditor value="a: 1" onChange={() => {}} />);
  const root = document.querySelector(".yaml-code-editor")!.shadowRoot;
  expect(root).not.toBeNull();
  expect(
    root!.querySelector('[role="textbox"][aria-label="YAML"]'),
  ).not.toBeNull();
});

const mixed = "first: one\r\nsecond: two\nthird: three\r\n";
const breakStart = mixed.indexOf("\r\n");
it.each(["backward", "forward"])(
  "deletes CRLF as one newline %s, with byte-exact undo/redo",
  (direction) => {
    const onChange = vi.fn();
    render(<YamlEditor value={mixed} onChange={onChange} />);
    const view = editor();
    act(() =>
      view.dispatch({
        selection: { anchor: breakStart + (direction === "backward" ? 2 : 0) },
      }),
    );
    act(() => {
      expect(
        (direction === "backward" ? deleteCharBackward : deleteCharForward)(
          view,
        ),
      ).toBe(true);
    });
    const joined = mixed.slice(0, breakStart) + mixed.slice(breakStart + 2);
    expect(view.state.doc.toString()).toBe(joined);
    expect(onChange).toHaveBeenLastCalledWith(joined);
    act(() => {
      expect(undo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(mixed);
    act(() => {
      expect(redo(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(joined);
  },
);
it("moves and extends selections across whole CRLF boundaries before replacement", () => {
  render(<YamlEditor value={mixed} onChange={() => {}} />);
  const view = editor();
  act(() => view.dispatch({ selection: { anchor: breakStart } }));
  act(() => {
    cursorCharForward(view);
  });
  expect(view.state.selection.main.head).toBe(breakStart + 2);
  act(() => {
    cursorCharBackward(view);
  });
  expect(view.state.selection.main.head).toBe(breakStart);
  act(() => {
    selectCharForward(view);
  });
  expect(view.state.selection.main.from).toBe(breakStart);
  expect(view.state.selection.main.to).toBe(breakStart + 2);
  act(() => view.dispatch(view.state.replaceSelection(" / ")));
  expect(view.state.doc.toString()).toBe(
    mixed.slice(0, breakStart) + " / " + mixed.slice(breakStart + 2),
  );
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe(mixed);
  act(() => view.dispatch({ selection: { anchor: breakStart + 2 } }));
  act(() => {
    selectCharBackward(view);
  });
  expect(view.state.selection.main.from).toBe(breakStart);
  expect(view.state.selection.main.to).toBe(breakStart + 2);
});
it.each(["typing", "newline", "selection"])(
  "keeps End %s before the entire CRLF pair",
  (action) => {
    render(<YamlEditor value={mixed} onChange={() => {}} />);
    const view = editor();
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    act(() => {
      (action === "selection" ? selectLineEnd : cursorLineEnd)(view);
    });
    expect(view.state.selection.main.head).toBe(breakStart);
    if (action === "newline")
      act(() => {
        insertNewline(view);
      });
    else act(() => view.dispatch(view.state.replaceSelection("!")));
    const expected =
      action === "newline"
        ? mixed.slice(0, breakStart) + "\n" + mixed.slice(breakStart)
        : action === "selection"
          ? "!" + mixed.slice(breakStart)
          : mixed.slice(0, breakStart) + "!" + mixed.slice(breakStart);
    expect(view.state.doc.toString()).toBe(expected);
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(mixed);
  },
);
it("hides only CRs belonging to CRLF pairs while retaining every original byte", () => {
  render(<YamlEditor value={mixed + "lone: cr\r"} onChange={() => {}} />);
  const view = editor();
  expect(view.state.doc.toString()).toBe(mixed + "lone: cr\r");
  expect(view.contentDOM.querySelector(".cm-line")!.textContent).toBe(
    "first: one",
  );
});
it("updates CRLF boundaries after paste and after an external document replacement", () => {
  const rendered = render(<YamlEditor value="original" onChange={() => {}} />);
  const view = editor();
  const pasted = "first\r\nsecond\r\n";
  act(() =>
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
  );
  act(() => view.dispatch(view.state.replaceSelection(pasted)));
  act(() => view.dispatch({ selection: { anchor: 7 } }));
  act(() => {
    deleteCharBackward(view);
  });
  expect(view.state.doc.toString()).toBe("firstsecond\r\n");
  act(() => {
    undo(view);
  });
  expect(view.state.doc.toString()).toBe(pasted);
  rendered.rerender(<YamlEditor value={mixed} onChange={() => {}} />);
  act(() => view.dispatch({ selection: { anchor: breakStart } }));
  act(() => {
    deleteCharForward(view);
  });
  expect(view.state.doc.toString()).toBe(
    mixed.slice(0, breakStart) + mixed.slice(breakStart + 2),
  );
});

it("consumes macOS Ctrl-T without transposing the CR out of its newline", () => {
  render(<YamlEditor value={mixed} onChange={() => {}} />);
  const view = editor();
  act(() => view.dispatch({ selection: { anchor: breakStart } }));
  // Inspect the platform-specific binding directly so Linux/jsdom runs also
  // exercise the command offered on macOS, without mocking OS detection.
  const binding = view.state
    .facet(keymap)
    .flat()
    .find((item) => item.mac === "Ctrl-t" || item.key === "Ctrl-t")!;
  expect(binding).toBeDefined();
  act(() => {
    expect(binding.run!(view)).toBe(true);
  });
  expect(view.state.doc.toString()).toBe(mixed);
  expect(view.state.selection.main.head).toBe(breakStart);
});
it("does not install advanced line-moving or deletion commands that bypass CRLF atoms", () => {
  render(
    <YamlEditor value={"first: one\r\nsecond: two"} onChange={() => {}} />,
  );
  const view = editor();
  const bindings = view.state.facet(keymap).flat();
  for (const key of [
    "Alt-ArrowUp",
    "Alt-ArrowDown",
    "Shift-Alt-ArrowUp",
    "Shift-Alt-ArrowDown",
    "Shift-Mod-k",
  ]) {
    expect(bindings.some((binding) => binding.key === key)).toBe(false);
  }
  for (const key of ["ArrowUp", "ArrowDown"]) {
    fireEvent.keyDown(view.contentDOM, { key, altKey: true });
  }
  expect(view.state.doc.toString()).toBe("first: one\r\nsecond: two");
});
it.each(["Ctrl-k", "Mod-Delete"])(
  "%s first deletes text to visible line end, then the complete CRLF",
  (key) => {
    render(<YamlEditor value={mixed} onChange={() => {}} />);
    const view = editor();
    const command = view.state
      .facet(keymap)
      .flat()
      .find((binding) => binding.mac === key)!.run!;
    act(() => view.dispatch({ selection: { anchor: 7 } }));
    act(() => {
      expect(command(view)).toBe(true);
    });
    const first = "first: " + mixed.slice(breakStart);
    expect(view.state.doc.toString()).toBe(first);
    act(() => {
      expect(command(view)).toBe(true);
    });
    expect(view.state.doc.toString()).toBe(
      "first: " + mixed.slice(breakStart + 2),
    );
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(mixed);
  },
);
it.each([false, true])(
  "line-end deletion respects existing selections and read-only=%s",
  (readOnly) => {
    render(
      <YamlEditor value={mixed} onChange={() => {}} readOnly={readOnly} />,
    );
    const view = editor();
    const command = view.state
      .facet(keymap)
      .flat()
      .find((binding) => binding.mac === "Ctrl-k")!.run!;
    act(() =>
      view.dispatch({ selection: { anchor: 7, head: breakStart + 2 } }),
    );
    act(() => {
      expect(command(view)).toBe(!readOnly);
    });
    expect(view.state.doc.toString()).toBe(
      readOnly ? mixed : "first: " + mixed.slice(breakStart + 2),
    );
    if (!readOnly) {
      act(() => {
        undo(view);
      });
      expect(view.state.doc.toString()).toBe(mixed);
    }
  },
);
it("plain text mode keeps CRLF and history without YAML highlighting", () => {
  const onChange = vi.fn();
  render(
    <YamlEditor
      plainText
      label="Dockerfile"
      value={"FROM alpine\r\nRUN true\r\n"}
      onChange={onChange}
    />,
  );
  const v = editor();
  expect(v.contentDOM.getAttribute("aria-label")).toBe("Dockerfile");
  expect(v.contentDOM.querySelector('[class^="yaml-"]')).toBeNull();
  act(() =>
    v.dispatch({
      changes: { from: v.state.doc.length, insert: "RUN echo 42\r\n" },
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith(
    "FROM alpine\r\nRUN true\r\nRUN echo 42\r\n",
  );
  act(() => {
    undo(v);
  });
  expect(v.state.doc.toString()).toBe("FROM alpine\r\nRUN true\r\n");
});

it("highlights Dockerfile instructions, comments and strings while preserving raw bytes and undo", () => {
  const original =
    '# build\r\nFROM alpine AS base\r\nRUN ["echo", "ok"]\nEXPOSE 8080\r\n';
  const onChange = vi.fn();
  render(
    <YamlEditor
      language="dockerfile"
      label="Dockerfile"
      value={original}
      onChange={onChange}
    />,
  );
  const v = editor();
  expect(v.contentDOM.querySelector(".dockerfile-keyword")?.textContent).toBe(
    "FROM",
  );
  expect(v.contentDOM.querySelector(".dockerfile-comment")?.textContent).toBe(
    "# build",
  );
  expect(
    v.contentDOM.querySelector(".dockerfile-string")?.textContent,
  ).toContain('"echo"');
  expect(v.contentDOM.querySelector(".dockerfile-number")?.textContent).toBe(
    "8080",
  );
  expect(v.contentDOM.querySelector('[class^="yaml-"]')).toBeNull();
  expect(v.state.doc.toString()).toBe(original);
  expect(onChange).not.toHaveBeenCalled();
  act(() =>
    v.dispatch({
      changes: { from: v.state.doc.length, insert: "RUN {{ [ not YAML\r\n" },
    }),
  );
  expect(onChange).toHaveBeenLastCalledWith(original + "RUN {{ [ not YAML\r\n");
  act(() => {
    undo(v);
  });
  expect(v.state.doc.toString()).toBe(original);
  act(() => {
    redo(v);
  });
  expect(v.state.doc.toString()).toBe(original + "RUN {{ [ not YAML\r\n");
});

it.each(["\n", "\r\n"])(
  "keeps Dockerfile continuation context across %j without coloring shell commands as instructions",
  (newline) => {
    const source = ["RUN echo \\", '  FROM "argument"', "FROM alpine"].join(
      newline,
    );
    render(
      <YamlEditor language="dockerfile" value={source} onChange={() => {}} />,
    );
    const v = editor();
    expect(
      Array.from(
        v.contentDOM.querySelectorAll(".dockerfile-keyword"),
        (node) => node.textContent,
      ),
    ).toEqual(["RUN", "FROM"]);
    expect(v.contentDOM.querySelector(".dockerfile-string")?.textContent).toBe(
      '"argument"',
    );
    expect(v.state.doc.toString()).toBe(source);
  },
);

it.each(["yaml", "dockerfile"] as const)(
  "shows line numbers in %s without changing source",
  (language) => {
    const value = "first\r\nsecond\nthird";
    const onChange = vi.fn();
    render(
      <YamlEditor language={language} value={value} onChange={onChange} />,
    );
    const v = editor();
    const numbers = () =>
      Array.from(
        v.dom.querySelectorAll(".cm-lineNumbers .cm-gutterElement"),
        (e) => e.textContent,
      );
    expect(numbers()).toContain("1");
    expect(numbers()).toContain("2");
    expect(numbers()).toContain("3");
    expect(v.state.doc.toString()).toBe(value);
    expect(onChange).not.toHaveBeenCalled();
    act(() => v.dispatch({ changes: { from: 0, insert: "new\n" } }));
    expect(numbers()).toContain("4");
    act(() => {
      undo(v);
    });
    expect(v.state.doc.toString()).toBe(value);
  },
);
it("exposes exact local ChangeSets and restores editor memory without replaying stale callbacks", () => {
  const memory: import("../src/renderer/YamlEditor").YamlEditorMemory = {};
  const first = vi.fn(),
    second = vi.fn();
  const rendered = render(
    <YamlEditor
      value={"a\r\nb"}
      onChange={() => {}}
      onUpdate={first}
      memory={memory}
    />,
  );
  const view = editor();
  act(() =>
    view.dispatch({
      changes: { from: 0, insert: "new\r\n" },
      selection: { anchor: 2 },
    }),
  );
  expect(first).toHaveBeenCalledOnce();
  expect(first.mock.calls[0][0].changes.length).toBe(4);
  rendered.unmount();
  render(
    <YamlEditor
      value={"new\r\na\r\nb"}
      onChange={() => {}}
      onUpdate={second}
      memory={memory}
    />,
  );
  expect(editor().state.selection.main.anchor).toBe(2);
  expect(undoDepth(editor().state)).toBe(1);
  act(() => editor().dispatch({ changes: { from: 0, insert: "x" } }));
  expect(second).toHaveBeenCalledOnce();
  expect(first).toHaveBeenCalledOnce();
});
it("rejects a mismatched precise controlled change without replacing text, history or selection", () => {
  const rejected = vi.fn();
  const rendered = render(
    <YamlEditor value={"actual\r\ntext"} onChange={() => {}} />,
  );
  const view = editor();
  act(() =>
    view.dispatch({
      changes: { from: 0, insert: "mine" },
      selection: { anchor: 2 },
    }),
  );
  const actual = view.state.doc.toString();
  rendered.rerender(
    <YamlEditor
      value="new result"
      onChange={() => {}}
      externalChange={{
        before: "wrong before",
        changes: view.state.changes({
          from: 0,
          to: view.state.doc.length,
          insert: "new result",
        }),
      }}
      onExternalChangeRejected={rejected}
    />,
  );
  expect(rejected).toHaveBeenCalledWith(actual);
  expect(view.state.doc.toString()).toBe(actual);
  expect(view.state.selection.main.anchor).toBe(2);
  expect(undoDepth(view.state)).toBe(1);
});
it("rejects a precise change whose computed text does not match the requested value", () => {
  const rejected = vi.fn();
  const rendered = render(<YamlEditor value="before" onChange={() => {}} />);
  const view = editor();
  rendered.rerender(
    <YamlEditor
      value="different result"
      onChange={() => {}}
      externalChange={{
        before: "before",
        changes: view.state.changes({ from: 0, to: 6, insert: "actual patch" }),
      }}
      onExternalChangeRejected={rejected}
    />,
  );
  expect(rejected).toHaveBeenCalledWith("before");
  expect(view.state.doc.toString()).toBe("before");
  expect(undoDepth(view.state)).toBe(0);
});

it.each(["\n", "\r\n"])(
  "highlights dash-prefixed YAML keys and a following quoted signature without desynchronizing (%j)",
  (newline) => {
    const signature =
      '"PrettyPlay(cache_key: str, cache_path: str | None, cleanup: bool, hooks: list[StepHooks] | None, config: PrettyConfig | None)"';
    const value = [
      "->PrettyConfig: {}",
      "",
      "->BrowserConfig: {}",
      "",
      "->StepHooks: {}",
      "",
      signature + ":",
      "  location: scenario.py",
      "  annotations: |",
      "    ->not_a_key: remains literal",
      "",
    ].join(newline);
    const onChange = vi.fn();
    render(<YamlEditor value={value} onChange={onChange} />);
    const view = editor();
    expect(
      [...view.dom.querySelectorAll(".yaml-key")].map((e) => e.textContent),
    ).toEqual([
      "->PrettyConfig",
      "->BrowserConfig",
      "->StepHooks",
      signature,
      "location",
      "annotations",
    ]);
    expect(view.state.doc.toString()).toBe(value);
    expect(onChange).not.toHaveBeenCalled();
  },
);

it("keeps YAML mappings, sequences, literals, quoted scalars and updates consistent around indicator-prefixed keys", () => {
  const value = `---
-foo: { ?bar: 123, normal: true }
?flag: yes
sequence:
  - key: "->text: stays a value"
  - item
quoted: '123'
body: |
  ->not_a_key: text
# tail
...
`;
  render(<YamlEditor value={value} onChange={() => {}} />);
  const view = editor();
  const keys = () =>
    [...view.dom.querySelectorAll(".yaml-key")].map((e) => e.textContent);
  expect(keys()).toEqual([
    "-foo",
    "?bar",
    "normal",
    "?flag",
    "sequence",
    "key",
    "quoted",
    "body",
  ]);
  expect(
    [...view.dom.querySelectorAll(".yaml-number")].map((e) => e.textContent),
  ).toEqual(["123"]);
  expect(
    [...view.dom.querySelectorAll(".yaml-boolean")].map((e) => e.textContent),
  ).toEqual(["true", "yes"]);
  expect(view.dom.querySelector(".yaml-comment")?.textContent).toBe("# tail");
  const start = value.indexOf("-foo");
  act(() =>
    view.dispatch({
      changes: { from: start, to: start + 4, insert: "->Renamed" },
    }),
  );
  expect(keys()[0]).toBe("->Renamed");
  act(() => expect(undo(view)).toBe(true));
  expect(keys()[0]).toBe("-foo");
  expect(view.state.doc.toString()).toBe(value);
});
