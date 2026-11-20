import { t as msg } from "../shared/i18n";
import { useEffect, useState } from "react";
import type { DocumentDraft } from "./settings-documents";

export type DocumentSaveStatus = {
  text: string;
  tone: "neutral" | "dirty" | "saving" | "success" | "warning" | "error";
  showSaving: boolean;
  detail?: string;
};


/** Presentation timers never modify a draft. Success expires from the actual
 * write response, not from mounting/revealing a retained editor. */
export function useDocumentSaveStatus(
  draft: DocumentDraft,
  enabled: boolean,
  identity: string,
): DocumentSaveStatus {
  const [progress, setProgress] = useState<{
    draft: DocumentDraft;
    identity: string;
  }>();
  const [, refreshClock] = useState(0);
  useEffect(() => {
    if (!enabled || !draft.saving) return;
    const timer = setTimeout(() => setProgress({ draft, identity }), 250);
    return () => clearTimeout(timer);
  }, [draft, enabled, identity]);
  const showSaving = !!(
    enabled &&
    draft.saving &&
    progress?.draft === draft &&
    progress.identity === identity
  );
  const successDeadline =
    draft.noticeKind === "saved" && draft.savedAt !== undefined
      ? draft.savedAt + 3000
      : undefined;
  useEffect(() => {
    if (!enabled || successDeadline === undefined || draft.saving) return;
    const remaining = successDeadline - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(
      () => refreshClock((value) => value + 1),
      remaining,
    );
    return () => clearTimeout(timer);
  }, [successDeadline, enabled, identity, draft.saving]);

  if (showSaving) return { text: msg("project.saving"), tone: "saving", showSaving };
  if (draft.reloadError)
    return {
      text: msg("project.notRefreshed"),
      tone: "error",
      showSaving,
      detail: draft.reloadError,
    };
  if (draft.error)
    return {
      text: msg("project.notSaved"),
      tone: "error",
      showSaving,
      detail: draft.error,
    };
  if (draft.notice && draft.noticeKind !== "saved")
    return {
      text: msg("project.checkFile"),
      tone: "warning",
      showSaving,
      detail: draft.notice,
    };
  const missing = draft.document?.exists === false;
  if (draft.document && draft.text !== draft.document.text)
    return {
      text: msg("project.fileModified"),
      tone: "dirty",
      showSaving,
      ...(missing ? { detail: msg("project.fileDoesNotExistSavingWillCreateIt") } : {}),
    };
  if (
    !draft.saving &&
    successDeadline !== undefined &&
    Date.now() < successDeadline
  )
    return { text: msg("project.fileSaved"), tone: "success", showSaving };
  return missing
    ? {
        text: msg("project.newFile"),
        tone: "neutral",
        showSaving,
        detail: msg("project.fileDoesNotExistSavingWillCreateIt"),
      }
    : { text: msg("project.fileNoChanges"), tone: "neutral", showSaving };
}
