/** Main-owned shutdown lease. Never accept this capability from a renderer.
 * Preparation freezes admissions but MUST NOT stop processes. A failing prepare
 * releases its own gate. Release restores admissions, never restarts old work.
 */
export interface ShutdownItem {
  id: string;
  label: string;
}
export interface PreparedShutdown {
  items: ShutdownItem[];
  requiresConfirmation: boolean;
  validate(): void;
  stop(): Promise<void>;
  /** Optional keep capability is all-or-nothing. Check every participant before
   * stopping ordinary sessions; keep failures MUST NOT fall back to stop(). */
  validateKeep?(): Promise<void>;
  keep?(): Promise<void>;
  /** Exact IDs from this prepared inventory, never a wildcard or another owner. */
  retained?(): string[];
  remaining(): string[];
  release(): void;
}
export interface ShutdownParticipant {
  prepare(): Promise<PreparedShutdown>;
}

/** Only fixed host diagnostics may cross the shutdown/UI boundary. */
export class ShutdownKeepError extends Error {
  constructor(
    readonly code: "unsupported" | "unavailable" | "changed" | "incomplete",
  ) {
    const messages = {
      unsupported:
        "Активный запуск не поддерживает сохранение после выхода. Выберите остановку процессов или отмените выход.",
      unavailable:
        "Сохранение запущенных процессов после выхода сейчас недоступно. Приложение остаётся открытым.",
      changed:
        "Состав сохраняемых процессов изменился. Требуется новое подтверждение выхода.",
      incomplete:
        "Безопасное сохранение запущенных процессов после выхода не подтверждено. Приложение остаётся открытым.",
    };
    super(messages[code] ?? messages.incomplete);
    this.name = "ShutdownKeepError";
  }
}
