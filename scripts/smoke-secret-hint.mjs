// Executes production main/preload/renderer from the signed ASAR in an isolated,
// hidden Electron harness. No real home, project, clipboard, or pipeline is used.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import electron from "electron";
const bundle = path.resolve(
  process.argv[2] ??
    (() => {
      throw Error("Explicit isolated release bundle path required");
    })(),
);
const archive = path.join(bundle, "Contents/Resources/app.asar");
if (!fs.existsSync(archive)) throw Error("Packaged ASAR missing");
const archiveHash = createHash("sha256")
  .update(fs.readFileSync(archive))
  .digest("hex");
if (process.env.SECRET_HINT_ASAR_SHA256 !== archiveHash)
  throw Error(
    "Explicit verified ASAR SHA256 required; bundle must be reviewed before execution",
  );
const root = fs.mkdtempSync("/private/tmp/goga-secret-hint-smoke-");
const home = path.join(root, "home"),
  project = path.join(root, "project");
const fixtures = {
  "home/.goga/config.yml": "# home sentinel\n",
  "project/.goga/config.yml": "tools:\n  fixture-tool: latest\n",
  "project/.goga/tools/fixture-tool/config.yml": "value: unchanged\n",
};
for (const [relative, text] of Object.entries(fixtures)) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}
fs.mkdirSync(path.join(home, ".goga/desktop"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".goga/desktop/projects.json"),
  JSON.stringify({
    schemaVersion: 1,
    revision: "00000000-0000-4000-8000-000000000001",
    projects: [
      { id: "fixture", name: "Secret hint acceptance", path: project },
    ],
  }),
  { mode: 0o600 },
);
async function fixture() {
  const electron = require("electron"),
    { app, session } = electron;
  const fs = require("node:fs"),
    path = require("node:path"),
    assert = require("node:assert/strict");
  const root = __dirname,
    meta = JSON.parse(fs.readFileSync(path.join(root, "meta.json"), "utf8"));
  const NativeWindow = electron.BrowserWindow,
    createdWindows = [];
  // Defense in depth: even an erroneous UI action cannot spawn Goga/Git/a pipeline.
  const childProcess = require("node:child_process");
  const blockedSpawns = [];
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ])
    childProcess[name] = (...args) => {
      blockedSpawns.push({ method: name, command: String(args[0]) });
      throw Error("Fixture forbids subprocesses");
    };
  const controlledCatalogCalls = [];
  const report = {
    ok: false,
    kind: "packaged-ASAR-production-main-preload-renderer-in-hidden-harness",
    bundle: meta.bundle,
    checks: [],
    screenshots: [],
    visibleWindows: 0,
    pipelinesLaunched: false,
    clipboardTouched: false,
    realOSTrashUsed: false,
    trashCalls: [],
    ipcCalls: [],
    asarSha256: meta.archiveHash,
    realUserDataUsed: false,
    blockedSpawns,
    controlledCatalogCalls,
    processTransport:
      "all subprocesses blocked; real settings read/IPC with temporary home",
  };
  // Intercept only window visibility in this test process. ASAR files are unchanged.
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, "BrowserWindow", {
    value: class extends NativeWindow {
      constructor(options) {
        super({ ...options, show: false });
        createdWindows.push(this);
        this.on("show", () => report.visibleWindows++);
      }
      show() {}
      showInactive() {}
      focus() {}
    },
  });
  Object.defineProperty(testElectron, "app", {
    value: new Proxy(app, {
      get(target, key) {
        if (key === "isPackaged") return true;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  // Read-only acceptance: reject writes, launch and all OS shell operations.
  const controlledShell = Object.create(electron.shell);
  for (const key of [
    "trashItem",
    "openExternal",
    "openPath",
    "showItemInFolder",
  ])
    Object.defineProperty(controlledShell, key, {
      value: () => {
        throw Error("Shell action forbidden");
      },
    });
  Object.defineProperty(testElectron, "shell", { value: controlledShell });
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, handler) =>
    originalHandle(channel, (event, ...args) => {
      report.ipcCalls.push(channel);
      if (
        /save-|delete-|launch|stop-run|close-run|choose-project|checkout/.test(
          channel,
        )
      )
        throw Error("Read-only fixture forbids action: " + channel);
      return handler(event, ...args);
    });
  electron.dialog.showMessageBox = async () => {
    throw Error("Native dialog forbidden");
  };
  const Module = require("node:module"),
    originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "electron"
      ? testElectron
      : originalLoad.call(this, request, parent, isMain);
  };
  app.setPath("home", meta.home);
  app.setPath("userData", path.join(root, "data"));
  app.setPath("sessionData", path.join(root, "session"));
  app.setPath("crashDumps", path.join(root, "crashes"));
  app.setAppLogsPath(path.join(root, "logs"));
  electron.dialog.showErrorBox = (title, message) => {
    console.error(title + ": " + message);
    app.exit(2);
  };
  const watchdog = setTimeout(() => {
    console.error("Fixture timeout");
    app.exit(2);
  }, 120000);
  watchdog.unref();
  app.whenReady().then(() => {
    app.dock?.hide();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_, done) => done({ cancel: true }),
    );
  });
  require(path.join(meta.archive, "dist-electron/index.cjs"));
  try {
    await app.whenReady();
    let win;
    for (let i = 0; i < 200; i++) {
      win = createdWindows[0];
      if (win && !win.webContents.isLoading()) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    report.createdWindows = createdWindows.length;
    assert(win, "Production window was not created");
    const wc = win.webContents;
    const ev = (s) => wc.executeJavaScript(s);
    const until = async (s) => {
      for (let i = 0; i < 750; i++) {
        if (await ev(s)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("DOM timeout: " + s);
    };
    await until(
      "!!window.goga && !!document.querySelector('.project-settings-action')",
    );
    assert.equal(win.isVisible(), false);
    assert(
      wc.getURL().startsWith("file://" + meta.archive.replaceAll(" ", "%20")),
    );
    report.version = await ev(
      "document.querySelector('.app-version').textContent",
    );
    assert(report.version.includes(meta.expectedVersion));
    const prefs = wc.getLastWebPreferences();
    report.security = {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
      webSecurity: prefs.webSecurity,
    };
    assert.deepEqual(report.security, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
    assert.equal(await ev("typeof require"), "undefined");
    await ev(
      "window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI,source:e.sourceFile,line:e.lineNumber,sample:e.sample,phase:window.__testPhase}))",
    );
    const settle = () =>
      ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const clickText = async (text) => {
      await ev(
        `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Button absent: '+${JSON.stringify(text)});e.click()})()`,
      );
      await settle();
    };
    const clickLabel = async (label) => {
      await ev(
        `document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']').click()`,
      );
      await settle();
    };
    const untouched = () => {
      for (const [relative, original] of Object.entries(meta.fixtures))
        assert.equal(
          fs.readFileSync(path.join(root, relative), "utf8"),
          original,
        );
    };
    const shot = async (label, width, height) => {
      win.setContentSize(width, height);
      await settle();
      await ev("document.querySelector('.scroll-area').scrollTop=0");
      await settle();
      await new Promise((r) => setTimeout(r, 80));
      const layout = await ev(`(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
        const tabs=[...document.querySelectorAll('.section-tabs button')].filter(e=>e.getClientRects().length).map(e=>({...rect(e),text:e.textContent,unclipped:e.scrollWidth<=e.clientWidth+1}));
        const dialog=document.querySelector('dialog[open]');
        const controls=document.querySelector('.tool-controls');
        return {tabs,dialog:dialog?rect(dialog):null,gap:controls?controls.nextElementSibling.getBoundingClientRect().top-controls.getBoundingClientRect().bottom:null,
          overflow:[...document.querySelectorAll('.app-shell,.scroll-area,.project-settings-panel,.master-detail,.editor-pane')].filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
      })()`);
      assert.deepEqual(layout.overflow, [], label + " horizontal overflow");
      assert(
        layout.tabs.every(
          (t) => t.unclipped && t.left >= 0 && t.right <= width,
        ),
        label + " tabs visible",
      );
      if (layout.dialog)
        assert(
          layout.dialog.left >= 0 &&
            layout.dialog.right <= width &&
            layout.dialog.top >= 0 &&
            layout.dialog.bottom <= height,
          label + " dialog bounds",
        );

      if (label === "launch-help") {
        await ev(
          "document.querySelector('#startup-timeout-help').scrollIntoView({block:'start'})",
        );
        await settle();
      }
      const screenshot = path.join(root, `${label}-${width}x${height}.png`);
      fs.writeFileSync(screenshot, (await wc.capturePage()).toPNG());
      report.screenshots.push({ file: screenshot, width, height, layout });
    };
    const pair = async (label) => {
      await shot(label, 1320, 900);
      await shot(label, 920, 700);
    };
    await ev("document.querySelector('.project-settings-action').click()");
    await until("!!document.querySelector('#startup-timeout-help')");
    const expected =
      "Скрытие маскирует значение только на экране. Значения сохраняются без шифрования. Не показывайте их посторонним";
    const hints = await ev(
      "[...document.querySelectorAll('p.hint')].map(e=>e.textContent.replace(/\\s+/g,' ').trim())",
    );
    assert.equal(hints.filter((text) => text === expected).length, 1);
    const visible = await ev("document.body.innerText");
    assert(!visible.includes("~/.goga/desktop"));
    assert(!visible.includes("0600"));
    assert(!visible.includes("права файла"));
    await pair("launch-help");
    await clickText("Конфигурация");
    await until("document.body.innerText.includes('Конфигурация проекта')");
    assert((await ev("document.body.innerText")).includes(".goga/config.yml"));
    untouched();
    assert.deepEqual(blockedSpawns, []);
    assert.equal(report.visibleWindows, 0);
    assert(createdWindows.every((w) => !w.isVisible()));
    report.cspViolations = await ev("window.__cspViolations");
    assert.deepEqual(report.cspViolations, []);
    report.checks = [
      "Exact privacy hint once; no app-data directory, 0600 or file permissions in launch settings copy",
      "Useful relative project configuration path retained",
      "Two wide/narrow screenshots, no horizontal overflow",
      "Read-only temporary fixtures, no process, notification, shell action or visible window",
    ];
    report.limitations = [
      "Text-only packaged acceptance; storage, Secret behavior and CRUD unchanged, not retested here.",
    ];
    report.status = "pass";
    report.ok = true;
  } catch (e) {
    report.error = String(e);
    report.stack = e.stack;
    try {
      const win = createdWindows[0];
      if (win)
        fs.writeFileSync(
          path.join(root, "failure.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
    } catch {}
  }
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}
fs.writeFileSync(
  path.join(root, "meta.json"),
  JSON.stringify({
    root,
    home,
    project,
    bundle,
    archive,
    fixtures,
    archiveHash,
    fixtureExecutable: path.join(root, "never-executed-fixture-goga"),
    expectedVersion: JSON.parse(fs.readFileSync("package.json", "utf8"))
      .version,
  }),
);
fs.writeFileSync(
  path.join(root, "main.cjs"),
  `(${fixture.toString()})().catch(e=>{console.error(e);require("electron").app.exit(2)});`,
);
const env = {
  ...process.env,
  HOME: home,
  GOGA_DESKTOP_DATA_DIR: path.join(root, "data"),
  TMPDIR: root,
};
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [path.join(root, "main.cjs")], {
  env,
  encoding: "utf8",
  timeout: 130000,
});
fs.writeFileSync(path.join(root, "stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(root, "stderr.log"), result.stderr ?? "");
console.log("result:", path.join(root, "result.json"));
if (result.status !== 0) console.error((result.stderr ?? "").slice(-3000));
console.log("fixture:", root);
console.log(
  "harness-process:",
  JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  }),
);
if (
  createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !==
  archiveHash
)
  throw Error("ASAR changed during smoke");
const reportFile = path.join(root, "result.json");
const passed =
  fs.existsSync(reportFile) &&
  JSON.parse(fs.readFileSync(reportFile, "utf8")).ok === true;
process.exitCode = result.status === 0 && passed ? 0 : 1;
