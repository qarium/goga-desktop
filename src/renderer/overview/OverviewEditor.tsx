import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { Prec } from "@codemirror/state";
import { overviewSearch, openOverviewSearch } from "./editor-search";
import { EditorView, keymap } from "@codemirror/view";
import { syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { YamlEditor, type YamlEditorMemory } from "../YamlEditor";
import {
  loadOverviewLanguage,
  overviewHighlightStyle,
  resolveOverviewLanguage,
} from "./languages";

export interface OverviewEditorCommands {
  find: () => void;
  replace: () => void;
}

export interface OverviewEditorProps {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  /** Must belong to this file and context, just like the supplied source text. */
  memory?: YamlEditorMemory;
  /** Commands belong to this mounted file; stale handles become inert on cleanup. */
  commands?: Ref<OverviewEditorCommands>;
}

const sourceTheme = EditorView.theme({
  "&.cm-focused": { outline: "none", boxShadow: "none" },
  ".overview-comment": { color: "#879ab3", fontStyle: "italic" },
  ".overview-keyword, .overview-atom": { color: "#c9aff5" },
  ".overview-string, .overview-regexp": { color: "#b8d99b" },
  ".overview-number": { color: "#efb88c" },
  ".overview-type": { color: "#efcf97" },
  ".overview-variable": { color: "#d7e2f2" },
  ".overview-property, .overview-tag, .overview-function": { color: "#8dc9ff" },
  ".overview-punctuation": { color: "#adbed3" },
  ".overview-meta": { color: "#efcf97" },
  ".overview-heading": { color: "#8dc9ff", fontWeight: "bold" },
  ".overview-emphasis": { fontStyle: "italic" },
  ".overview-strong": { fontWeight: "bold" },
  ".overview-link": { color: "#8dc9ff", textDecoration: "underline" },
  ".overview-invalid": { color: "#ff9d9d" },
});

export function OverviewEditor(props: OverviewEditorProps) {
  const owner = useRef({ memory: props.memory, version: 0 });
  if (owner.current.memory !== props.memory) {
    owner.current = {
      memory: props.memory,
      version: owner.current.version + 1,
    };
  }
  // A loaded file or clean reload replaces its memory owner even at the same
  // path. Remount so the editor's lifetime saves state to that owner, not the
  // former loading placeholder. Ordinary edits/dirty refresh retain the owner.
  return (
    <OverviewFileEditor
      key={`${props.path}:${owner.current.version}`}
      {...props}
    />
  );
}

function OverviewFileEditor({
  path,
  value,
  onChange,
  onSave,
  readOnly,
  memory,
  commands,
}: OverviewEditorProps) {
  const description = resolveOverviewLanguage(path);
  const builtin =
    description?.name === "YAML"
      ? "yaml"
      : description?.name === "Dockerfile"
        ? "dockerfile"
        : undefined;
  const [support, setSupport] = useState<LanguageSupport | null>(null);
  const view = useRef<EditorView | null>(null);
  const save = useRef(onSave);
  save.current = onSave;
  useImperativeHandle(
    commands,
    () => ({
      find() {
        if (view.current) openOverviewSearch(view.current);
      },
      replace() {
        const current = view.current;
        if (current && !current.state.readOnly)
          openOverviewSearch(current, true);
      },
    }),
    [],
  );

  useEffect(() => {
    // Keep the existing YAML scalar colors and Dockerfile CRLF adaptation.
    if (builtin || !description) return;
    let current = true;
    loadOverviewLanguage(path).then(
      (loaded) => {
        if (current) setSupport(loaded);
      },
      () => {
        if (current) setSupport(null);
      },
    );
    return () => {
      current = false;
    };
  }, [path, builtin, description]);

  const extensions = useMemo(
    () => [
      support ?? [],
      syntaxHighlighting(overviewHighlightStyle),
      Prec.highest(sourceTheme),
      overviewSearch,
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            run(view) {
              if (!view.state.readOnly) save.current?.();
              return true;
            },
          },
        ]),
      ),
    ],
    [support],
  );

  return (
    <div className="ov-source-editor">
      <YamlEditor
        onView={(current) => {
          view.current = current;
        }}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        memory={memory}
        plainText={!builtin}
        language={builtin}
        label={path}
        extensions={extensions}
      />
    </div>
  );
}
