import { scopeProjectId, type ScopeRef } from "../shared/context";
import { preparationErrorMessage } from "./preparation-error";
import { readRequest } from "./read-request";
import { documentScopeId, type SettingsDocuments } from "./settings-documents";
import type { WorkspaceLeaveFile } from "./workspace-leave";

/** Capture only dirty editors owned by this exact project/worktree revision.
 * The documents store outlives editor mounts; never reconstruct a path from UI
 * selection or issue a write through a different project's current editor. */
export function getProjectLeaveFiles(
  store: SettingsDocuments,
  scope: ScopeRef,
  onReveal: (tab: string) => void,
): WorkspaceLeaveFile[] {
  const owner = documentScopeId(scope);
  return store
    .dirtyProjectDocuments()
    .flatMap(({ source, instance, relativePath }) => {
      const srcScope = source.context ?? source.projectId;
      if (
        source.projectId !== scopeProjectId(scope) ||
        documentScopeId(srcScope) !== owner
      )
        return [];
      const captured = store.get(source);
      const readText = () => store.readSessionBuffer(source, instance);
      function checkDraft() {
        const current = store.get(source);
        if (
          readText() !== captured.text ||
          current.document?.version !== captured.document?.version
        )
          throw new Error(
            "Черновик изменился. Проверьте правки перед сохранением.",
          );
        if (current.busy || current.deletion)
          throw new Error("Дождитесь окончания операции с файлом.");
      }
      return [
        {
          path: relativePath,
          readText,
          async preflight() {
            checkDraft();
            try {
              const disk = await readRequest(
                "readProjectDocument",
                srcScope,
                source.target,
              );
              if (disk.version !== captured.document?.version)
                throw new Error(
                  "Файл изменился на диске. Черновик остался в редакторе.",
                );
            } catch (error) {
              const reason = preparationErrorMessage(error);
              // A tool editor reads existing leaves only. For a new file the host
              // reports ENOENT; its guarded create below still requires "missing".
              if (!(
                source.target.kind === "tool" &&
                captured.document?.version === "missing" &&
                /^ENOENT\b/.test(reason)
              ))
                throw new Error(reason);
            }
            checkDraft();
          },
          async save() {
            checkDraft();
            if (!(await store.save(source)))
              throw new Error(
                store.get(source).error ||
                  "Не удалось сохранить файл. Правки остались в редакторе.",
              );
          },
          reveal() {
            const tab = store.revealSessionDocument(source, instance);
            if (tab) onReveal(tab);
          },
        },
      ];
    });
}
