import { useEffect, useRef, useState } from "react";
import { ChangeSet } from "@codemirror/state";
import type { ScopeRef } from "../shared/context";
import type { GitWorkspaceSnapshot } from "../shared/git-workspace";
import type { GitConflictDocument } from "../shared/git-conflicts";
import type {
  GitConflictResolution,
  GitConflictSavePreview,
} from "../shared/git-conflict-save";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";
import { topicError } from "./TopicsCommon";
import {
  applyConflictBlock,
  editConflictDraft,
  openConflictDraft,
  reconstructConflictDraft,
  resolveConflictBlockManually,
  type ConflictBlockChoice,
  type ConflictDraft,
} from "./git-conflict-draft";
import type { YamlEditorMemory, YamlEditorExternalChange } from "./YamlEditor";

export interface ConflictFileState {
  document: GitConflictDocument;
  draft: ConflictDraft | null;
  editorChange?: YamlEditorExternalChange & { original: ConflictDraft };
  ready: boolean;
  reconstructed: boolean;
  uncertain: boolean;
  saved: boolean;
  log: string;
  memory: Record<"current" | "result" | "incoming", YamlEditorMemory>;
}
const textOrAbsent = (kind: string) => kind === "text" || kind === "absent";
export const supportedConflict = (doc: GitConflictDocument) =>
  [doc.base, doc.current, doc.incoming, doc.working].every((s) =>
    textOrAbsent(s.kind),
  );
/** All documents, editor history and writes live in the retained context owner. */
export function useGitConflicts({
  scope,
  snapshot,
  file,
  enabled,
  visible,
  onSaved,
}: {
  scope: ScopeRef;
  snapshot: GitWorkspaceSnapshot | null;
  file: string;
  enabled: boolean;
  visible: boolean;
  onSaved(scope: ScopeRef): void;
}) {
  const files = useRef(new Map<string, ConflictFileState>());
  const documentEpoch = useRef(0);
  const documentRead = useRef<AbortController | null>(null);
  const [, redraw] = useState(0);

  const [readFailed, setReadFailed] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<{
    path: string;
    kind: "prepare" | "execute";
  } | null>(null);
  const [preview, setPreview] = useState<GitConflictSavePreview | null>(null);
  const [message, setMessage] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<
    "reload" | "reconstruct" | null
  >(null);
  const alive = useRef(true),
    busy = useRef(false),
    preparing = useRef<AbortController | null>(null);
  const done = useRef(onSaved);
  done.current = onSaved;
  const locked = useRef(false);
  locked.current = busy.current || !!preview;
  const entry = files.current.get(file);
  const scopeId = documentScopeId(scope);
  const revision = snapshot?.revision;
  const repaint = () => redraw((n) => n + 1);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      preparing.current?.abort();
    };
  }, []);
  useEffect(() => {
    // Reads/previews can be cancelled. Execute is deliberately not tied to visibility.
    if (!visible) {
      preparing.current?.abort();
      setPreview(null);
      setConfirmation(null);
    }
  }, [visible]);
  useEffect(() => {
    setConfirmation(null);
  }, [file]);
  useEffect(() => {
    if (!enabled || !file || !revision || files.current.has(file)) return;
    const controller = new AbortController();
    documentRead.current = controller;
    const issuedEpoch = documentEpoch.current;
    const issuedScope = scope,
      issuedPath = file,
      issuedRevision = revision;
    setReadFailed(null);
    void readWithSignal(controller.signal, "readGitConflict", {
      scope: issuedScope,
      path: issuedPath,
      revision: issuedRevision,
    })
      .then((doc) => {
        if (controller.signal.aborted || issuedEpoch !== documentEpoch.current)
          return;
        if (
          documentScopeId(doc.scope) !== documentScopeId(issuedScope) ||
          doc.path !== issuedPath ||
          doc.revision !== issuedRevision
        )
          throw Error(
            "Ответ конфликта устарел или относится к другому файлу/контексту.",
          );
        files.current.set(issuedPath, {
          document: doc,
          draft: doc.working.kind === "text" ? openConflictDraft(doc) : null,
          ready: false,
          reconstructed: false,
          uncertain: false,
          saved: false,
          log: "",
          memory: { current: {}, result: {}, incoming: {} },
        });
        repaint();
      })
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          issuedEpoch === documentEpoch.current
        ) {
          setReadFailed(issuedPath);
          setMessage({
            title: "Не удалось прочитать конфликт",
            text: topicError(error),
          });
        }
      });
    return () => {
      controller.abort();
      if (documentRead.current === controller) documentRead.current = null;
    };
  }, [enabled, file, scopeId, revision, reload]);
  const change = (action: (state: ConflictFileState) => void) => {
    if (!entry || locked.current || entry.saved) return;
    try {
      action(entry);
      repaint();
    } catch (error) {
      setMessage({
        title: "Не удалось изменить блок",
        text: topicError(error),
      });
    }
  };
  const prepare = async (resolution: GitConflictResolution) => {
    if (
      !entry ||
      busy.current ||
      preview ||
      entry.uncertain ||
      entry.saved ||
      !supportedConflict(entry.document)
    )
      return;
    if (
      resolution.kind === "text" &&
      (!entry.draft ||
        !(
          entry.ready ||
          ((entry.reconstructed || entry.draft.blocks.length > 0) &&
            entry.draft.blocks.every((b) => b.choice !== null))
        ))
    )
      return;
    if (
      (resolution.kind === "current" || resolution.kind === "incoming") &&
      !textOrAbsent(entry.document[resolution.kind].kind)
    )
      return;
    const doc = entry.document;
    busy.current = true;
    locked.current = true;
    setPending({ path: doc.path, kind: "prepare" });
    const controller = new AbortController();
    preparing.current = controller;
    try {
      const value = await readWithSignal(
        controller.signal,
        "prepareGitConflictSave",
        {
          scope: doc.scope,
          path: doc.path,
          revision: doc.revision,
          fingerprint: doc.fingerprint,
          resolution,
        },
      );
      if (!alive.current || controller.signal.aborted) return;
      if (
        documentScopeId(value.scope) !== documentScopeId(doc.scope) ||
        value.path !== doc.path ||
        value.resolution !== resolution.kind ||
        value.hooks !== "disabled" ||
        value.canonicalization !== "git-text-attributes"
      )
        throw Error(
          "Подтверждение относится к другому файлу/контексту или разрешению.",
        );
      setPreview(value);
    } catch (error) {
      if (alive.current && !controller.signal.aborted)
        setMessage({
          title: "Не удалось подготовить разрешение",
          text: topicError(error),
        });
    } finally {
      busy.current = false;
      preparing.current = null;
      if (alive.current) setPending(null);
    }
  };
  const execute = async () => {
    if (!preview || busy.current) return;
    const submitted = preview,
      state = files.current.get(preview.path);
    if (!state) return;
    busy.current = true;
    locked.current = true;
    setPreview(null);
    setPending({ path: submitted.path, kind: "execute" });
    try {
      const value = await window.goga.executeGitConflictSave(submitted.token);
      if (!alive.current) return;
      if (
        documentScopeId(value.scope) !== documentScopeId(submitted.scope) ||
        value.path !== submitted.path
      )
        throw Error(
          "Результат относится к другому файлу/контексту. Проверьте состояние Git.",
        );
      const saved =
        value.status === "saved" &&
        value.worktreePublished &&
        value.indexPublished &&
        !value.lockRetained;
      state.saved = saved;
      state.uncertain =
        !saved &&
        (value.status !== "not-saved" ||
          value.worktreePublished ||
          value.indexPublished ||
          value.lockRetained);
      state.log = [
        value.message,
        value.log,
        value.recoveryPath && `Материалы восстановления: ${value.recoveryPath}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      if (saved) done.current(submitted.scope);
      setMessage({
        title: "Результат разрешения файла",
        text:
          state.log ||
          (saved ? "Файл и индекс сохранены." : "Файл не сохранён."),
      });
      repaint();
    } catch (error) {
      if (alive.current) {
        state.uncertain = true;
        state.log = `${topicError(error)}\n\nОтвет не подтверждает отсутствие записи. Проверьте состояние Git; автоматического повтора не будет.`;
        setMessage({ title: "Результат разрешения файла", text: state.log });
        repaint();
      }
    } finally {
      busy.current = false;
      if (alive.current) setPending(null);
    }
  };
  return {
    entry,
    clearCompletedOperation: () => {
      if (busy.current) return;
      // Invalidate synchronously before React can batch a late document reply
      // with operation success. Ordinary external refresh still preserves drafts.
      documentEpoch.current++;
      documentRead.current?.abort();
      documentRead.current = null;
      files.current.clear();
      setPreview(null);
      setMessage(null);
      setConfirmation(null);
      repaint();
    },
    retainedPaths: [...files.current]
      .filter(([, state]) => !state.saved)
      .map(([path]) => path),
    hasRetained: (path: string) => {
      const state = files.current.get(path);
      return !!state && !state.saved;
    },
    pending,
    preview,
    message,
    confirmation,
    loading: enabled && !!file && !entry && readFailed !== file,
    readFailed: readFailed === file,
    stale:
      !!entry &&
      (entry.document.revision !== revision ||
        documentScopeId(entry.document.scope) !== scopeId),
    locked: !!pending || !!preview,
    modalOpen: !!preview || !!message || !!confirmation,
    closeMessage: () => setMessage(null),
    showLog: () =>
      entry?.log &&
      setMessage({ title: "Результат разрешения файла", text: entry.log }),
    closePreview: () => setPreview(null),
    cancelPrepare: () => preparing.current?.abort(),
    requestReload: () => {
      if (!busy.current && !preview) setConfirmation("reload");
    },
    requestReconstruct: () => {
      if (!busy.current && !preview) setConfirmation("reconstruct");
    },
    closeConfirmation: () => setConfirmation(null),
    confirm: () => {
      if (busy.current || preview) return;
      if (confirmation === "reload") {
        files.current.delete(file);
        setReadFailed(null);
        setReload((n) => n + 1);
      }
      if (confirmation === "reconstruct")
        change((state) => {
          state.editorChange = undefined;
          state.draft = reconstructConflictDraft(state.document);
          state.reconstructed = true;
          state.ready = false;
        });
      setConfirmation(null);
    },
    edit: (changes: ChangeSet) =>
      change((state) => {
        if (state.draft) {
          state.editorChange = undefined;
          state.draft = editConflictDraft(state.draft, changes);
          state.ready = false;
        }
      }),
    apply: (id: string, choice: ConflictBlockChoice) =>
      change((state) => {
        if (state.draft) {
          const original = state.draft;
          const next = applyConflictBlock(original, id, choice);
          const block = original.blocks.find((block) => block.id === id)!;
          const insert =
            choice === "both"
              ? block.source.current.text + block.source.incoming.text
              : block.source[choice].text;
          state.editorChange = {
            before: original.text,
            original,
            changes: ChangeSet.of(
              { from: block.from, to: block.to, insert },
              original.text.length,
              "\n",
            ),
          };
          state.draft = next;
          state.ready = false;
        }
      }),
    rejectEditorChange: (actual: string) => {
      const before = entry?.editorChange?.original;
      if (!entry || !before) return;
      // Keep the editor authoritative after a rejected precise edit. Unknown
      // transaction history must not invent verified ranges or enable saving.
      entry.draft =
        actual === before.text
          ? before
          : {
              ...before,
              text: actual,
              blocks: before.blocks.map((block) => ({
                ...block,
                mapped: false,
                choice: null,
              })),
            };
      entry.editorChange = undefined;
      entry.ready = false;
      preparing.current?.abort();
      setPreview(null);
      setMessage({
        title: "Не удалось применить блок",
        text: "Текст редактора изменился до применения блока. Фактический текст, курсор и история сохранены; проверьте результат вручную. Автоматическая замена не выполнена.",
      });
      repaint();
    },
    manual: (id: string) =>
      change((state) => {
        if (state.draft)
          state.draft = resolveConflictBlockManually(state.draft, id);
      }),
    setReady: (ready: boolean) =>
      change((state) => {
        state.ready = ready;
      }),
    prepare,
    execute,
  };
}
export type GitConflictsState = ReturnType<typeof useGitConflicts>;
