import { dialog, type BrowserWindow } from "electron";
import type { Run } from "../shared/types";
export async function confirmCloseRun(
  window: BrowserWindow,
  run: Run,
): Promise<boolean> {
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    message: "Остановить конвейер и закрыть вкладку?",
    detail: `${run.pipeline} · ${run.topic}\nСохранённое состояние, история и файлы Goga останутся на месте.`,
    buttons: ["Отмена", "Остановить и закрыть"],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}
