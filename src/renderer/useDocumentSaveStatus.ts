import { useEffect, useState } from "react";
import type { DocumentDraft } from "./settings-documents";

export type DocumentSaveStatus = {
  text: string;
  tone: "neutral" | "dirty" | "saving" | "success" | "warning" | "error";
  showSaving: boolean;
  detail?: string;
};
const missingFileHint =
  "Файл отсутствует и будет создан при сохранении.";

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
    draft.notice === "Сохранено" && draft.savedAt !== undefined
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

  if (showSaving) return { text: "Сохраняем…", tone: "saving", showSaving };
  if (draft.reloadError)
    return {
      text: "Не обновлено",
      tone: "error",
      showSaving,
      detail: draft.reloadError,
    };
  if (draft.error)
    return {
      text: "Не сохранено",
      tone: "error",
      showSaving,
      detail: draft.error,
    };
  if (draft.notice && draft.notice !== "Сохранено")
    return {
      text: "Проверьте файл",
      tone: "warning",
      showSaving,
      detail: draft.notice,
    };
  const missing = draft.document?.exists === false;
  if (draft.document && draft.text !== draft.document.text)
    return {
      text: "Файл: есть изменения",
      tone: "dirty",
      showSaving,
      ...(missing ? { detail: missingFileHint } : {}),
    };
  if (
    !draft.saving &&
    successDeadline !== undefined &&
    Date.now() < successDeadline
  )
    return { text: "Файл: сохранен", tone: "success", showSaving };
  return missing
    ? {
        text: "Новый файл",
        tone: "neutral",
        showSaving,
        detail: missingFileHint,
      }
    : { text: "Файл: нет изменений", tone: "neutral", showSaving };
}
