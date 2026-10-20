import { app, BrowserWindow, Notification, dialog } from "electron";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DashboardViews } from "../../src/main/views";
const root = process.env.GOGA_NOTIFICATION_TEST_DIR!;
if (!root) throw Error("Explicit disposable path required");
mkdirSync(root, { recursive: true });
for (const [key, sub] of [
  ["userData", "data"],
  ["sessionData", "session"],
  ["crashDumps", "crashes"],
] as const)
  app.setPath(key, path.join(root, sub));
app.setAppLogsPath(path.join(root, "logs"));
app.setName("Goga Notification Test");
app.commandLine.appendSwitch("enable-logging");
const evidence: any = {
  electron: process.versions.electron,
  execPath: process.execPath,
  root,
  events: [],
  fakePipeline: true,
  realNotificationAPI: true,
};
function record(kind: string, details: any = {}) {
  const e = { kind, ...details, time: new Date().toISOString() };
  evidence.events.push(e);
  console.log(JSON.stringify(e));
  writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(evidence, null, 2),
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/fixture.js" ? "text/javascript" : "text/html",
  );
  res.end(
    req.url === "/fixture.js"
      ? readFileSync(path.join(__dirname, "fixture.js"))
      : '<!doctype html><div id="root"></div><script src="/fixture.js"></script>',
  );
});
const keep: Notification[] = [];
setTimeout(() => {
  record("watchdog");
  app.exit(2);
}, 60000).unref();
void (async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  await app.whenReady();
  app.dock?.hide();
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  // Only the fixture's custom per-run consent is supplied. OS permission is untouched.
  dialog.showMessageBox = (async () => ({
    response: 0,
    checkboxChecked: false,
  })) as typeof dialog.showMessageBox;
  const views = new DashboardViews(
    win,
    () => record("unexpected-focus"),
    (_id, error) => record("view-error", { error }),
  );
  const port = (server.address() as any).port;
  await views.ensure("notification-fixture", "http://127.0.0.1:" + port);
  views.select("notification-fixture");
  const wc = (win.contentView.children[0] as Electron.WebContentsView)
    .webContents;
  wc.on("console-message", (_event: any, ...args: any[]) =>
    record("renderer-console", {
      args: args
        .map((v) => (typeof v === "string" ? v : String(v)))
        .slice(0, 4),
    }),
  );
  for (let i = 0; i < 100; i++) {
    if (await wc.executeJavaScript('typeof window.testState==="function"'))
      break;
    await sleep(20);
  }
  record("renderer-state", {
    state: await wc.executeJavaScript("window.testState()"),
    windowVisible: win.isVisible(),
    prefs: wc.getLastWebPreferences(),
    bridge: await wc.executeJavaScript(
      "({process:typeof window.process,require:typeof window.require,goga:typeof window.goga})",
    ),
  });
  await wc.executeJavaScript("window.sendQuestion()");
  await sleep(4000);
  record("after-question", {
    state: await wc.executeJavaScript("window.testState()"),
    events: await wc.executeJavaScript("window.notificationEvidence"),
  });
  await wc.executeJavaScript("window.disableTest()");
  await sleep(100);
  await wc.executeJavaScript("window.sendQuestion()");
  await sleep(1000);
  record("after-manual-off", {
    state: await wc.executeJavaScript("window.testState()"),
    events: await wc.executeJavaScript("window.notificationEvidence"),
  });
  const n = new Notification({
    title: "Goga Desktop — тест уведомления",
    body: "Отдельная проверка доставки macOS. Это не вопрос рабочего пайплайна.",
    silent: true,
  });
  keep.push(n);
  for (const event of ["show", "failed", "click", "close"] as const)
    n.on(event, (_event: any, error?: any) =>
      record("main-" + event, { error }),
    );
  n.show();
  record("main-requested", { supported: Notification.isSupported() });
  await sleep(12000);
  const history = await Notification.getHistory();
  record("system-history", {
    items: history.map((n) => ({ id: n.id, title: n.title, body: n.body })),
  });
  record("final-renderer", {
    events: await wc.executeJavaScript("window.notificationEvidence"),
    state: await wc.executeJavaScript("window.testState()"),
  });
  // Remove only this process's own test notifications. Separate fixture bundle ID.
  for (const n of history) n.close();
  for (const n of keep) n.close();
  views.dispose();
  win.destroy();
  server.close();
  record("done");
  app.exit(0);
})().catch((e) => {
  record("exception", { error: String(e), stack: e.stack });
  app.exit(1);
});
