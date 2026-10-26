/** Preserve facts separately: unchecked locks are not known retained or absent. */
interface GitDiagnostics {
  status: string;
  message: string;
  log: string;
  commit?: string;
  nativeWarning?: boolean;
  lockRetained?: boolean;
  retainedLocks?: string[];
  uncheckedLocks?: string[];
  recoveryPath?: string;
  recoveryUnverified?: boolean;
}
export const hasGitDiagnostics = (value: GitDiagnostics) =>
  value.status !== "success" ||
  !!value.nativeWarning ||
  !!value.lockRetained ||
  !!value.retainedLocks?.length ||
  !!value.uncheckedLocks?.length ||
  !!value.recoveryPath ||
  !!value.recoveryUnverified;
export function formatGitDiagnostics(value: GitDiagnostics): string {
  return [
    value.message,
    value.commit && `Коммит: ${value.commit}`,
    value.log,
    value.nativeWarning &&
      "Git сообщил предупреждение; проверьте журнал и состояние рабочей копии.",
    value.recoveryPath && `Материалы восстановления: ${value.recoveryPath}`,
    value.recoveryUnverified &&
      "Наличие материалов восстановления не проверено; путь указан по последним известным данным.",
    value.lockRetained &&
      "Блокировка сохранена; не удаляйте её без проверки состояния Git.",
    value.retainedLocks?.length &&
      `Сохранённые блокировки: ${value.retainedLocks.join(", ")}`,
    value.uncheckedLocks?.length &&
      `Непроверенные блокировки: ${value.uncheckedLocks.join(", ")}. Их наличие и владелец не подтверждены.`,
    value.status === "uncertain" &&
      "Результат не определён. Проверьте состояние Git; ответ не подтверждает отсутствие изменений.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
