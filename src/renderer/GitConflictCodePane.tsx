import { useMemo, useRef } from "react";
import { RangeSet, type ChangeSet } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  type ViewUpdate,
} from "@codemirror/view";
import type { GitConflictRange } from "../shared/git-conflicts";
import {
  YamlEditor,
  type YamlEditorMemory,
  type YamlEditorExternalChange,
} from "./YamlEditor";

export interface ConflictPaneAction {
  label: string;
  symbol: string;
  disabled: boolean;
  selected?: boolean;
  run(): void;
}
export interface ConflictPaneAnchor {
  range: GitConflictRange;
  actions: ConflictPaneAction[];
  resolved: boolean;
}
class Actions extends GutterMarker {
  constructor(readonly actions: ConflictPaneAction[]) {
    super();
  }
  toDOM() {
    const span = document.createElement("span");
    for (const action of this.actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.symbol;
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      button.setAttribute("aria-pressed", String(!!action.selected));
      button.disabled = action.disabled;
      button.addEventListener("click", action.run);
      span.append(button);
    }
    return span;
  }
}
// Static style modules: do not register a new stylesheet per edit or hunk choice.
function createPaneTheme(side: "current" | "result" | "incoming") {
  return EditorView.theme({
    "&": { height: "100%", fontSize: "12px" },
    ".cm-scroller": {
      height: "100%",
      maxHeight: "none",
      lineHeight: "22px",
    },
    ".cm-content": { minHeight: "100%", padding: "8px 0" },
    ".cm-line": { padding: "0 8px" },
    ".cm-lineNumbers .cm-gutterElement": {
      minWidth: "28px",
      padding: "0 5px",
    },
    ".conflict-current": { backgroundColor: "#322b20", color: "#ead0a4" },
    ".conflict-incoming": { backgroundColor: "#1d2d43", color: "#bdd4f6" },
    ".conflict-result": { backgroundColor: "#3b2824" },
    ".conflict-resolved": { backgroundColor: "#153a32", color: "#b5e3cd" },
    ".conflict-actions": { backgroundColor: "#141d2b" },
    ".conflict-actions .cm-gutterElement": { padding: "0 2px" },
    ".conflict-actions button": {
      font: "12px/18px system-ui",
      padding: "0 3px",
      minWidth: "22px",
      height: "21px",
      border: "1px solid #7d653b",
      borderRadius: "3px",
      color: "#e9c47d",
      backgroundColor: "#3a3021",
      cursor: "pointer",
    },
    ".conflict-actions button:disabled": {
      opacity: ".4",
      cursor: "default",
    },
    ".conflict-actions button[aria-pressed=true]": {
      color: "#b3f0d7",
      borderColor: "#398573",
      backgroundColor: "#174437",
    },
    ...(side === "incoming"
      ? {
          ".conflict-actions button": {
            color: "#bad8ff",
            backgroundColor: "#223751",
            border: "1px solid #486d98",
            borderRadius: "3px",
            minWidth: "22px",
            height: "21px",
            padding: "0 3px",
            cursor: "pointer",
          },
        }
      : {}),
  });
}
const paneThemes = {
  current: createPaneTheme("current"),
  result: createPaneTheme("result"),
  incoming: createPaneTheme("incoming"),
};

export function GitConflictCodePane({
  label,
  value,
  side,
  readOnly,
  memory,
  anchors,
  onEdit,
  externalChange,
  onExternalChangeRejected,
  onView,
  onScroll,
}: {
  label: string;
  value: string;
  side: "current" | "result" | "incoming";
  readOnly: boolean;
  memory: YamlEditorMemory;
  anchors: ConflictPaneAnchor[];
  onEdit?(changes: ChangeSet): void;
  externalChange?: YamlEditorExternalChange;
  onExternalChangeRejected?(actual: string): void;
  onView(view: EditorView | null): void;
  onScroll(view: EditorView): void;
}) {
  const latest = useRef({ onScroll });
  latest.current = { onScroll };
  const extension = useMemo(() => {
    // UTF-16 coordinates originate only in verified host metadata/draft mapping.
    const decorations = anchors.flatMap((anchor) => {
      if (anchor.range.from < 0 || anchor.range.to > value.length) return [];
      const ranges = [];
      let start = value.lastIndexOf("\n", anchor.range.from - 1) + 1;
      if (anchor.range.from === 0) start = 0;
      do {
        ranges.push(
          Decoration.line({
            class: anchor.resolved ? "conflict-resolved" : `conflict-${side}`,
          }).range(start),
        );
        const next = value.indexOf("\n", start);
        if (next < 0) break;
        start = next + 1;
      } while (start < anchor.range.to);
      return ranges;
    });
    const markers = new Map<number, ConflictPaneAction[]>();
    for (const anchor of anchors) {
      const pos =
        anchor.range.from === 0
          ? 0
          : value.lastIndexOf("\n", anchor.range.from - 1) + 1;
      if (pos <= value.length && anchor.actions.length)
        markers.set(pos, [...(markers.get(pos) ?? []), ...anchor.actions]);
    }
    return [
      EditorView.decorations.of(Decoration.set(decorations, true)),
      gutter({
        class: "conflict-actions",
        side: side === "current" ? "after" : "before",
        markers: () =>
          RangeSet.of(
            [...markers]
              .sort((a, b) => a[0] - b[0])
              .map(([pos, actions]) => new Actions(actions).range(pos)),
          ),
      }),
      EditorView.domEventHandlers({
        scroll: (_event, view) => {
          latest.current.onScroll(view);
        },
      }),
      paneThemes[side],
    ];
  }, [anchors, side, value]);
  return (
    <YamlEditor
      value={value}
      onChange={() => {}}
      plainText
      label={label}
      readOnly={readOnly}
      memory={memory}
      extensions={extension}
      externalChange={externalChange}
      onExternalChangeRejected={onExternalChangeRejected}
      onView={onView}
      onUpdate={(update: ViewUpdate) => onEdit?.(update.changes)}
    />
  );
}
