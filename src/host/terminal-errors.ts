import { t } from "../shared/i18n";
/** Fixed diagnostic codes survive Electron's error serialization without copying
 * native exceptions, cwd, environment, commands or output into a UI/log. */
export type TerminalStartupPhase =
  | "preset-environment"
  | "preset-command"
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
        ? t("hostTerminal.openCancelled")
        : retained
          ? t("hostTerminal.transportRetained")
          : phase === "preset-environment"
            ? t("hostTerminal.presetEnvironmentFailed")
            : phase === "preset-command"
              ? t("hostTerminal.presetCommandFailed")
              : t("hostTerminal.startupFailed")) +
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
    super(t("hostTerminal.closingOrRefreshing"));
    this.name = "TerminalAdmissionClosedError";
  }
}

/** Safe diagnostic only: never contains paths, native stderr or environment. */
export class TerminalInspectorError extends Error {
  constructor(readonly code: "changed" | "unavailable") {
    super(
      code === "changed"
        ? t("hostTerminal.inspectorChanged")
        : t("hostTerminal.inspectorUnavailable"),
    );
    this.name = "TerminalInspectorError";
  }
}
