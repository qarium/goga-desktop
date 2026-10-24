import { useEffect, useRef } from "react";
import {
  Annotation,
  Compartment,
  EditorState,
  EditorSelection,
  StateField,
  type Text,
  Transaction,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  standardKeymap,
  history,
  historyKeymap,
  insertNewline,
  transposeChars,
  deleteToLineEnd,
  deleteLineBoundaryForward,
} from "@codemirror/commands";
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { yaml } from "@codemirror/lang-yaml";
import { tags } from "@lezer/highlight";
import "./YamlEditor.css";

// Keep source bytes, but expose each CRLF as one editable line boundary.
// The CR is hidden, while cursor/deletion commands treat both bytes as atomic.
function crlfRanges(doc: Text) {
  const hidden: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  let offset = 0;
  for (const line of doc.iterLines()) {
    const end = offset + line.length;
    if (end < doc.length && line.endsWith("\r")) {
      hidden.push(Decoration.replace({}).range(end - 1, end));
      atomic.push(Decoration.mark({}).range(end - 1, end + 1));
    }
    offset = end + 1;
  }
  return { hidden: Decoration.set(hidden), atomic: Decoration.set(atomic) };
}
const crlf = StateField.define({
  create: (state) => crlfRanges(state.doc),
  update: (ranges, transaction) =>
    transaction.docChanged ? crlfRanges(transaction.newDoc) : ranges,
  provide: (field) => [
    EditorView.decorations.from(field, (ranges) => ranges.hidden),
    EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
  ],
});
const crlfSelection = EditorState.transactionFilter.of((transaction) => {
  // Line-end commands (and programmatic selections) bypass atomicRanges.
  // Snap only endpoints inside CRLF back before the complete newline; never
  // rewrite text or turn an End command into movement to the following line.
  const selection = transaction.newSelection;
  const doc = transaction.newDoc;
  const boundary = (pos: number) =>
    pos > 0 && doc.sliceString(pos - 1, pos + 1) === "\r\n" ? pos - 1 : pos;
  let changed = false;
  const ranges = selection.ranges.map((range) => {
    const anchor = boundary(range.anchor),
      head = boundary(range.head);
    if (anchor === range.anchor && head === range.head) return range;
    changed = true;
    return EditorSelection.range(anchor, head);
  });
  return changed
    ? [
        transaction,
        {
          selection: EditorSelection.create(ranges, selection.mainIndex),
          sequential: true,
        },
      ]
    : transaction;
});

// CodeMirror's logical line end is after the retained CR. Deleting to that
// point would make deleteBy expand through the atomic LF as well. Keep the
// newline until a second deletion is requested from the visible line end.
function deleteToYamlLineEnd(view: EditorView) {
  const { state } = view;
  if (state.readOnly) return false;
  const change = state.changeByRange((range) => {
    let to = range.to;
    if (range.empty) {
      const line = state.doc.lineAt(range.head);
      const end =
        line.to < state.doc.length && line.text.endsWith("\r")
          ? line.to - 1
          : line.to;
      to = range.head < end ? end : Math.min(state.doc.length, line.to + 1);
    }
    return {
      changes: { from: range.from, to },
      range: EditorSelection.cursor(range.from),
    };
  });
  if (change.changes.empty) return false;
  view.dispatch(
    state.update(change, { scrollIntoView: true, userEvent: "delete.forward" }),
  );
  return true;
}

const externalValue = Annotation.define<boolean>();
const highlighting = HighlightStyle.define([
  { tag: tags.propertyName, class: "yaml-key" },
  { tag: [tags.string, tags.content], class: "yaml-string" },
  { tag: tags.comment, class: "yaml-comment" },
]);

// The editor retains CR bytes to preserve mixed line endings. The legacy
// tokenizer expects logical lines without terminators (its anchored regexes
// otherwise miss CRLF comments and continuations). Adapt only its input view;
// neither the document nor token offsets before the CR are changed.
const dockerfileLanguage = StreamLanguage.define({
  ...dockerFile,
  token(stream, state) {
    const original = stream.string;
    if (!original.endsWith("\r")) return dockerFile.token(stream, state);
    if (stream.pos === original.length - 1) {
      stream.skipToEnd();
      return null;
    }
    stream.string = original.slice(0, -1);
    try {
      return dockerFile.token(stream, state);
    } finally {
      stream.string = original;
    }
  },
});
const dockerfileHighlighting = HighlightStyle.define([
  { tag: tags.keyword, class: "dockerfile-keyword" },
  { tag: tags.string, class: "dockerfile-string" },
  { tag: tags.comment, class: "dockerfile-comment" },
  { tag: tags.number, class: "dockerfile-number" },
]);

// The official YAML grammar calls all plain values Literal. Decorate only
// complete scalar nodes, never keys, quoted strings or literal-block contents.
// This is presentation only; host YAML validation remains authoritative.
function scalarDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        if (node.name !== "Literal" || node.node.parent?.name === "Key") return;
        const text = view.state.sliceDoc(node.from, node.to);
        const scalar = text.trim();
        const kind = /^(?:true|false|yes|no|on|off)$/i.test(scalar)
          ? "boolean"
          : /^[+-]?(?:0x[\da-f]+|0o[0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|\.inf|\.nan)$/i.test(
                scalar,
              )
            ? "number"
            : null;
        if (kind)
          ranges.push(
            Decoration.mark({ class: `yaml-${kind}` }).range(
              node.from,
              node.to,
            ),
          );
      },
    });
  }
  return Decoration.set(ranges, true);
}
const scalars = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = scalarDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = scalarDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const theme = EditorView.theme(
  {
    "&": {
      color: "#d7e2f2",
      backgroundColor: "#0d1726",
      fontSize: "12px",
      height: "var(--settings-editor-height, auto)",
    },
    "&.cm-focused": { outline: "2px solid #6da9ff", outlineOffset: "-2px" },
    ".cm-scroller": {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      lineHeight: "1.75",
      overflow: "auto",
      maxHeight: "var(--settings-editor-height, 460px)",
    },
    ".cm-content": {
      minHeight: "var(--settings-editor-min-height, 330px)",
      padding: "12px 0",
      caretColor: "#ffffff",
    },
    ".cm-line": { padding: "0 12px" },
    ".cm-gutters": {
      backgroundColor: "#0d1726",
      color: "#879ab3",
      borderRight: "1px solid #2d405a",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px", minWidth: "32px" },
    ".cm-content ::selection, .cm-content::selection": {
      backgroundColor: "#34577c",
    },
    ".dockerfile-keyword": { color: "#8dc9ff" },
    ".dockerfile-string": { color: "#b8d99b" },
    ".dockerfile-comment": { color: "#879ab3", fontStyle: "italic" },
    ".dockerfile-number": { color: "#efb88c" },
    ".yaml-key": { color: "#8dc9ff" },
    ".yaml-string": { color: "#b8d99b" },
    ".yaml-number, .yaml-number .yaml-string": { color: "#efb88c" },
    ".yaml-boolean, .yaml-boolean .yaml-string": { color: "#c9aff5" },
    ".yaml-comment": { color: "#879ab3", fontStyle: "italic" },
  },
  { dark: true },
);

export interface YamlEditorProps {
  value: string;
  onChange: (text: string) => void;
  readOnly?: boolean;
  plainText?: boolean;
  language?: "yaml" | "dockerfile";
  label?: string;
}

export function YamlEditor({
  value,
  onChange,
  readOnly = false,
  plainText = false,
  language = "yaml",
  label = "YAML",
}: YamlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callback = useRef(onChange);
  const initial = useRef({ value, readOnly });
  const editable = useRef(new Compartment());
  callback.current = onChange;

  useEffect(() => {
    // In Electron, style-mod uses constructable stylesheets for ShadowRoot.
    // This preserves the strict style-src 'self' policy without inline styles
    // or a hand-maintained copy of CodeMirror's base layout rules.
    const root =
      host.current!.shadowRoot ?? host.current!.attachShadow({ mode: "open" });
    const editor = new EditorView({
      parent: root,
      root,
      state: EditorState.create({
        doc: initial.current.value,
        extensions: [
          // An explicit LF separator retains literal CRs, including mixed CRLF/LF
          // input. Never serialize/format YAML or silently normalize its bytes.
          EditorState.lineSeparator.of("\n"),
          lineNumbers(),
          crlf,
          crlfSelection,
          ...(plainText
            ? []
            : language === "dockerfile"
              ? [dockerfileLanguage, syntaxHighlighting(dockerfileHighlighting)]
              : [yaml(), syntaxHighlighting(highlighting), scalars]),
          theme,
          history(),
          keymap.of([
            { key: "Enter", run: insertNewline, shift: insertNewline },
            // Transposition is not part of this focused editor. The state-only
            // command cannot respect atomic CRLF boundaries; consume it rather
            // than allowing native contenteditable transposition as a fallback.
            { mac: "Ctrl-t", run: () => true },
            // Keep platform-standard editing only, not advanced line-moving,
            // copying, deletion or formatting commands that bypass atoms.
            ...standardKeymap
              .filter((binding) => binding.run !== transposeChars)
              .map((binding) =>
                binding.run === deleteToLineEnd ||
                binding.run === deleteLineBoundaryForward
                  ? { ...binding, run: deleteToYamlLineEnd }
                  : binding,
              ),
            ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({
            "aria-label": label,
            spellcheck: "false",
          }),
          editable.current.of([
            EditorState.readOnly.of(initial.current.readOnly),
            EditorView.editable.of(!initial.current.readOnly),
          ]),
          EditorView.updateListener.of((update) => {
            if (
              update.docChanged &&
              !update.transactions.some((tr) => tr.annotation(externalValue))
            )
              callback.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && value !== editor.state.doc.toString()) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
        annotations: [
          externalValue.of(true),
          Transaction.addToHistory.of(false),
        ],
      });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  return <div ref={host} className="yaml-code-editor" />;
}
