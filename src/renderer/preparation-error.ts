/** Strip only Electron's known transport wrapper, never a meaningful host reason. */
export function preparationErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(
    /^Error invoking remote method 'goga:(?:repeat-pipeline|launch|save-project-settings|save-project-document|save-overview-file|save-settings|read-request|read-overview-schema|read-overview-contract|ensure-topic-context|resolve-topic-context|check-topic-context-readiness|create-topic-context|copy-overview-entries|paste-overview-entries|copy-overview-paths|prepare-overview-paste|execute-overview-paste)': (?:Error: )?/,
    "",
  );
}

/** Save failures never clear source text, its baseline or editor history. */
export function documentSaveErrorMessage(error: unknown): string {
  const reason = preparationErrorMessage(error);
  return reason.startsWith("Конфликт сохранения:")
    ? `${reason} Ваш черновик остался в редакторе.`
    : reason;
}
