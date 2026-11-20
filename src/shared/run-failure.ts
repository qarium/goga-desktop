import { t } from "./i18n";

/** A Desktop-authored diagnostic, never an arbitrary string from the child. */
export type RunFailureReason =
  | { kind: "build-exit" | "pipeline-exit"; code: number | null }
  | { kind: "build-spawn" | "dashboard-not-opened" | "dashboard-timeout" };

export function runFailureMessage(reason: RunFailureReason): string {
  switch (reason.kind) {
    case "build-exit":
      return t("host.buildExitedWithCodeValue1", { value1: reason.code ?? "signal" });
    case "pipeline-exit":
      return t("host.gogaExitedWithCodeValue1", { value1: reason.code ?? "signal" });
    case "build-spawn":
      return t("host.couldNotStartTheBuildProcessCheckGogaAndPath");
    case "dashboard-not-opened":
      return t("host.gogaExitedBeforeTheDashboardOpened");
    case "dashboard-timeout":
      return t("host.startupTimedOutTheDashboardDidNotOpenWithinThe");
  }
}
