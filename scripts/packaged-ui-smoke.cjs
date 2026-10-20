// Explicit opt-in acceptance entry, never shipped in app.asar or run by npm test.
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const asar = process.env.GOGA_VERIFY_ASAR,
  data = process.env.GOGA_DESKTOP_DATA_DIR;
assert.ok(
  asar && data && process.env.HOME,
  "Isolated verification paths required",
);
assert.equal(process.arch, process.env.GOGA_VERIFY_ARCH);
assert.equal(process.versions.electron, process.env.GOGA_VERIFY_ELECTRON);
fs.mkdirSync(data, { recursive: true });
app.setPath("userData", data);
app.setPath("sessionData", path.join(data, "session"));
app.setPath("crashDumps", path.join(data, "crashes"));
app.setAppLogsPath(path.join(data, "logs"));
const watchdog = setTimeout(() => app.exit(1), 45000);
let service;
(async () => {
  await app.whenReady();
  app.dock?.hide();
  const { HostService, SettingsStore, registerIPC } = require(
    path.join(asar, "dist-electron", "acceptance-host.cjs"),
  );
  const blocked = () => {
    throw Error("External command/pipeline forbidden during packaged UI smoke");
  };
  const settings = new SettingsStore(process.env.HOME);
  service = new HostService({
    home: process.env.HOME,
    dataDir: data,
    settings,
    goga: "/nonexistent/disabled",
    runner: { command: blocked, start: blocked, kill: blocked },
  });
  await service.initialize();
  assert.deepEqual(await service.listProjects(), []);
  const win = new BrowserWindow({
    show: false,
    width: 1320,
    height: 900,
    webPreferences: {
      preload: path.join(asar, "dist-electron", "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const errors = [];
  win.webContents.on("preload-error", (_e, _p, error) =>
    errors.push(error.message),
  );
  win.webContents.on("render-process-gone", (_e, details) =>
    errors.push(details.reason),
  );
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.session.setPermissionRequestHandler((_c, _p, cb) =>
    cb(false),
  );
  const html = path.join(asar, "dist", "index.html");
  registerIPC(ipcMain, {
    service,
    settings,
    window: win,
    shellURL: pathToFileURL(html).href,
    choose: async () => null,
    select: () => {},
    confirmClose: async () => false,
    stop: async () => blocked(),
  });
  await win.loadFile(html);
  let snapshot;
  for (let attempt = 0; attempt < 150; attempt++) {
    snapshot = await win.webContents.executeJavaScript(
      `(async()=>({version:document.querySelector('.app-version')?.textContent,projects:await window.goga.listProjects(),runs:await window.goga.runs()}))()`,
    );
    if (snapshot.version) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(win.isVisible(), false);
  assert.equal(snapshot.version, `v${process.env.GOGA_VERIFY_VERSION}`);
  assert.deepEqual(snapshot.projects, []);
  assert.deepEqual(snapshot.runs, []);
  assert.deepEqual(errors, []);
  await service.dispose();
  service = null;
  win.destroy();
  clearTimeout(watchdog);
  console.log(
    "Packaged host + production preload + renderer startup verified (isolated hidden window).",
  );
  app.exit(0);
})().catch(async (error) => {
  console.error(error);
  try {
    await service?.dispose();
  } finally {
    clearTimeout(watchdog);
    app.exit(1);
  }
});
