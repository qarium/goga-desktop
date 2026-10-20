/** Opt-in, invisible native preload check. No Goga, system notification, or user data. */
import { app, BrowserWindow, dialog } from "electron";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DashboardViews } from "../src/main/views";
const root = path.resolve(
  process.env.GOGA_PREFERENCE_SMOKE_DIR || "work/preferences-native",
);
mkdirSync(root, { recursive: true });
app.setPath("userData", path.join(root, "data"));
app.setPath("sessionData", path.join(root, "session"));
app.setPath("crashDumps", path.join(root, "crashes"));
app.setAppLogsPath(path.join(root, "logs"));
app.setName("Goga preference verification");
const watchdog = setTimeout(() => {
  console.error("Native smoke timed out");
  app.exit(1);
}, 30000);
const html = `<!doctype html><html><head><script>
// Snapshot BEFORE any fixture or AFM-style theme initialization.
window.first = {permission: Notification.permission, enabled:localStorage.getItem('afm-notifications-enabled'), mode: localStorage.getItem('afm-mode'), process:typeof window.process, require:typeof window.require, bridge:typeof window.goga};
// Exact early AFM theme restoration contract.
var mode = localStorage.getItem('afm-mode'); document.documentElement.dataset.theme = mode === 'light' ? 'light' : 'dark';
</script></head><body>Hidden preference verification only</body></html>`;
const server = createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(html);
});
void (async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await app.whenReady();
  app.dock?.hide();
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}`;
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const errors: string[] = [];
  const views = new DashboardViews(
    win,
    () => {
      throw Error("Unexpected focus");
    },
    (_id, error) => errors.push(error),
  );
  // Override only this disposable test process's dialog; no visible windows/prompts.
  dialog.showMessageBox = (async () => ({
    response: 0,
    checkboxChecked: false,
  })) as typeof dialog.showMessageBox;
  await views.ensure("fixture-granted", url);
  const wc = (win.contentView.children[0] as Electron.WebContentsView)
    .webContents;
  const first = await wc.executeJavaScript("window.first");
  assert.deepEqual(first, {
    permission: "granted",
    enabled: "1",
    mode: "dark",
    process: "undefined",
    require: "undefined",
    bridge: "undefined",
  });
  // AFM disable semantics + stale light, then same run reload.
  await wc.executeJavaScript(
    "localStorage.removeItem('afm-notifications-enabled'); localStorage.setItem('afm-mode','light')",
  );
  await wc.loadURL(url);
  const reloaded = await wc.executeJavaScript(
    "({...window.first, theme:document.documentElement.dataset.theme})",
  );
  assert.equal(reloaded.enabled, null);
  assert.equal(reloaded.mode, "dark");
  assert.equal(reloaded.theme, "dark");
  await views.ensure("fixture-new", url);
  const fresh = await (
    win.contentView.children[1] as Electron.WebContentsView
  ).webContents.executeJavaScript("window.first");
  assert.equal(fresh.enabled, "1");
  dialog.showMessageBox = (async () => ({
    response: 1,
    checkboxChecked: false,
  })) as typeof dialog.showMessageBox;
  await views.ensure("fixture-denied", url);
  const denied = await (
    win.contentView.children[2] as Electron.WebContentsView
  ).webContents.executeJavaScript("window.first");
  assert.equal(denied.permission, "denied");
  assert.equal(denied.enabled, null);
  assert.equal(denied.mode, "dark");
  assert.deepEqual(errors, []);
  assert.equal(win.isVisible(), false);
  views.dispose();
  win.destroy();
  const result = {
    ok: true,
    first,
    reloaded,
    fresh,
    denied,
    visibleWindows: false,
    systemNotificationSent: false,
  };
  writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  clearTimeout(watchdog);
  server.close();
  app.exit(0);
})().catch((error) => {
  console.error(error);
  server.close();
  app.exit(1);
});
