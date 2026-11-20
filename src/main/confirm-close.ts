import { t } from "../shared/i18n";
import { dialog, type BrowserWindow } from "electron";
import type { Run } from "../shared/types";
export async function confirmCloseRun(
  window: BrowserWindow,
  run: Run,
): Promise<boolean> {
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    message: t("native.stopAndCloseQuestion"),
    detail: t("native.runCloseDetail", { pipeline: run.pipeline, topic: run.topic ?? "" }),
    buttons: [t("native.cancel"), t("native.stopAndClose")],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}
