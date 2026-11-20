import { t as msg } from "../shared/i18n";
import type { ScopeRef } from "../shared/context";
import type { HomeSessions } from "./home/session-summary";
import type { OverviewStore } from "./overview/store";
import { documentScopeId } from "./settings-documents";
import type { WorkspaceLeaveFile } from "./workspace-leave";

/** Only project names/paths are shown to the dialog. Text stays in its original
 * retained store; saving never mounts an editor or reconstructs a file path. */
export function getOverviewLeaveFiles(
  sessions: HomeSessions,
  scope: ScopeRef,
): WorkspaceLeaveFile[] {
  return sessions.overviewLeaveFiles(scope);
}

export function overviewLeaveFile(
  store: OverviewStore,
  path: string,
  scope: ScopeRef,
  memory: object,
  attached: () => boolean,
  onReveal: (path: string) => void,
): WorkspaceLeaveFile {
  const current = () => {
    if (
      !attached() ||
      documentScopeId(store.sessionScope()) !== documentScopeId(scope)
    )
      return null;
    const file = store.getSnapshot().files[path];
    return file?.memory === memory ? file : null;
  };
  const requireFile = () => {
    const file = current();
    if (!file)
      throw Error(
        msg("workspace.theFileOrItsWorkspaceHasChangedReturnToThe"),
      );
    if (
      file.text !== file.document.text && file.dirtyOrigin &&
      documentScopeId(file.dirtyOrigin) !== documentScopeId(scope)
    )
      throw Error(
        msg("workspace.theWorkingCopyHasChangedSinceEditingBeganReviewThe"),
      );
    return file;
  };
  const checkSaved = () => {
    const file = requireFile();
    if (file.text !== file.document.text)
      throw Error(
        msg("workspace.newEditsWereMadeWhileSavingTheyRemainInThe"),
      );
  };
  let alreadyOnDisk = false;
  return {
    path,
    readText: () => current()?.text ?? null,
    reveal: () => {
      if (current()) onReveal(path);
    },
    preflight: async () => {
      requireFile();
      alreadyOnDisk = await store.verifyDiskForLeave(path);
      requireFile();
    },
    acceptSavedText: async () => {
      requireFile();
      await store.verifyDiskForLeave(path, true);
      checkSaved();
    },
    save: async () => {
      const file = requireFile();
      if (file.text === file.document.text) return;
      if (alreadyOnDisk) {
        await store.verifyDiskForLeave(path, true);
      } else if (!(await store.save(path, file.text))) {
        throw Error(
          current()?.error ||
            msg("workspace.couldNotSaveTheFileYourEditsRemainInThe"),
        );
      }
      checkSaved();
    },
  };
}
