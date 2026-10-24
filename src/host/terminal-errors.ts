/** Fixed diagnostic codes survive Electron's error serialization without copying
 * native exceptions, cwd, environment, commands or output into a UI/log. */
export type TerminalStartupPhase =
  | "context"
  | "root"
  | "screen"
  | "revalidate"
  | "screen-ready"
  | "spawn"
  | "processes"
  | "native-ready"
  | "screen-bind"
  | "output-subscribe"
  | "native-preflight"
  | "native-spawn"
  | "native-attach"
  | "native-birth"
  | "native-handshake"
  | "native-io";
export class TerminalStartupError extends Error {
  constructor(
    readonly phase: TerminalStartupPhase,
    readonly retained: boolean,
    cancelled = false,
  ) {
    super(
      (cancelled
        ? "Открытие терминала отменено."
        : retained
          ? "Терминальный транспорт недоступен. Процесс сохранён; требуется безопасное завершение."
          : "Не удалось запустить терминал. Проверьте контекст и оболочку; значения окружения скрыты.") +
        " [terminal:" +
        phase +
        "]",
    );
    this.name = "TerminalStartupError";
  }
}

/** Admission refusal is not a renderer/transport failure. Never replay rejected input. */
export class TerminalAdmissionClosedError extends Error {
  constructor() {
    super("Терминал завершает операцию закрытия или обновления.");
    this.name = "TerminalAdmissionClosedError";
  }
}

/** Safe diagnostic only: never contains paths, native stderr or environment. */
export class TerminalInspectorError extends Error {
  constructor(readonly code: "changed" | "unavailable") {
    super(
      code === "changed"
        ? "Служебный файл проверки терминальных процессов изменился после запуска приложения. Безопасная остановка не подтверждена."
        : "Системный адаптер процессов терминала недоступен. Безопасная остановка не подтверждена.",
    );
    this.name = "TerminalInspectorError";
  }
}
