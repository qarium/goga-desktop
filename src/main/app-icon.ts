import path from "node:path";

/** Called only after Electron is ready. The same asset ships in development and ASAR. */
export function installApplicationIcon(
  application: { dock?: { setIcon(image: string): void } },
  mainDirectory: string,
  platform: string = process.platform,
): string {
  const icon = path.join(mainDirectory, "assets/icon.png");
  if (platform === "darwin") application.dock?.setIcon(icon);
  return icon;
}
