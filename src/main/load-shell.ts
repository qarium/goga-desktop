import type { BrowserWindow } from "electron";
export async function loadShell(
  win: Pick<BrowserWindow, "loadFile" | "webContents">,
  html: string,
) {
  await win.loadFile(html);
  await win.webContents.setVisualZoomLevelLimits(1, 1);
}
