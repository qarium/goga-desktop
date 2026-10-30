/** Strip only Electron's known transport wrapper, never a meaningful host reason. */
export function preparationErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(
    /^Error invoking remote method 'goga:(?:save-project-settings|read-request|read-overview-schema|read-overview-contract|ensure-topic-context|resolve-topic-context|check-topic-context-readiness|create-topic-context)': (?:Error: )?/,
    "",
  );
}
