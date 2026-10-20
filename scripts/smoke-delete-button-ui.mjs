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
if (process.env.DOCUMENT_TRASH_ASAR_SHA256 !== archiveHash)
  throw Error(
    "Explicit verified ASAR SHA256 required; bundle must be reviewed before execution",
  );
const root = fs.mkdtempSync("/private/tmp/goga-delete-button-ui-smoke-");
const home = path.join(root, "home"),
  project = path.join(root, "project");
const fixtures = {
  "home/.goga/config.yml": "# HOME CONFIG SENTINEL\ncustom: true\n",
  "home/.goga/profiles/personal.yml":
    "# PROFILE PRIVATE SENTINEL\nagent: codex\n",
  "project/.goga/config.yml": "# PROJECT CONFIG SENTINEL\nproject: fixture\n",
  "project/.goga/pipelines/target.yml":
    "# PIPELINE PRIVATE SENTINEL 🙂\r\nname: fixture\n---\nsteps: []\n",
  "project/.goga/workflows/target.yml":
    "# WORKFLOW PRIVATE SENTINEL\n{% if worker %}\nstages: []\n{% endif %}\n",
  "project/.goga/tools/review-kit/environments/local/target.yml":
    "# TOOL PRIVATE SENTINEL\nmode: local\n",
  "project/.goga/tools/review-kit/environments/local/sibling.yml":
    "# SIBLING SENTINEL\nmode: untouched\n",
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
      { id: "fixture", name: "Document trash acceptance", path: project },
    ],
  }),
  { mode: 0o600 },
);
const allowedTrash = [
  "project/.goga/pipelines/target.yml",
  "project/.goga/workflows/target.yml",
  "project/.goga/tools/review-kit/environments/local/target.yml",
  "home/.goga/profiles/personal.yml",
].map((relative) => path.join(root, relative));
fs.mkdirSync(path.join(root, "fixture-trash"));
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
    processTransport: "controlled catalog stub; no real Goga command",
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
  // Preserve the real shell; only its trash transport is replaced. Production
  // service validation, ticket consumption and post-move verification stay real.
  const originalShell = electron.shell;
  const controlledShell = Object.create(originalShell);
  Object.defineProperty(controlledShell, "trashItem", {
    value: async () => {
      report.trashCalls.push("FORBIDDEN");
      throw Error("Visual-only fixture forbids trash");
    },
  });
  Object.defineProperty(testElectron, "shell", { value: controlledShell });
  // Observe real registered IPC handlers, without replacing their return values.
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, handler) =>
    originalHandle(channel, (event, ...args) => {
      report.ipcCalls.push(channel);
      if (/^goga:(save-|delete-document$|launch$)/.test(channel))
        throw Error("Visual-only fixture forbids writes and launches");
      return handler(event, ...args);
    });
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
      for (let i = 0; i < 250; i++) {
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
    const shot = async (label, width, height) => {
      win.setContentSize(width, height);
      await settle();
      await ev(
        `document.querySelector(${JSON.stringify(label === "open" ? ".savebar" : ".privacy-note")})?.scrollIntoView({block:"center"})`,
      );
      await settle();
      await new Promise((r) => setTimeout(r, 100));
      const layout = await ev(`(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom}};
        const buttons=[...document.querySelectorAll('${label === "confirmation" ? "dialog[open]" : label === "open" ? ".document-save-actions" : ".document-reveal-actions"} button')];
        return {buttons:buttons.map(e=>({text:e.textContent.trim(),...rect(e),background:getComputedStyle(e).backgroundColor,color:getComputedStyle(e).color})),overflow:[...document.querySelectorAll('.scroll-area,.editor-pane')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
      })()`);
      assert.deepEqual(layout.overflow, []);
      assert(layout.buttons.length >= 2);
      for (const b of layout.buttons)
        assert(
          b.left >= 0 && b.right <= width && b.top >= 0 && b.bottom <= height,
          `button clipped: ${b.text}`,
        );
      const screenshot = path.join(root, `${label}-${width}x${height}.png`);
      fs.writeFileSync(screenshot, (await wc.capturePage()).toPNG());
      report.screenshots.push({ file: screenshot, width, height, layout });
    };
    await ev("document.querySelector('.project-settings-action').click()");
    await until("!!document.querySelector('.section-tabs')");
    await clickText("Конвейеры");
    await until(
      "!!document.querySelector('[aria-label=\"Файл .goga/pipelines/target.yml\"]')",
    );
    await clickLabel("Файл .goga/pipelines/target.yml");
    for (const [width, height] of [
      [1320, 900],
      [920, 700],
    ]) {
      assert.equal(
        await ev(
          "document.querySelectorAll('.editor-pane button.danger').length",
        ),
        1,
      );
      assert.equal(
        await ev(
          "!!document.querySelector('.privacy-note .document-reveal-actions button.danger')",
        ),
        true,
      );
      assert.equal(
        await ev("!!document.querySelector('.editor-pane > .form-actions')"),
        false,
      );
      await shot("hidden", width, height);
    }
    await clickText("Удалить");
    await until("!!document.querySelector('dialog[open]')");
    assert.equal(
      await ev("document.activeElement.textContent.trim()"),
      "Отмена",
    );
    assert.equal(
      await ev(
        "document.querySelector('[data-confirm-delete]').classList.contains('danger')",
      ),
      true,
    );
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ])
      await shot("confirmation", w, h);
    await clickText("Отмена");
    await clickText("Открыть редактор");
    await until("!!document.querySelector('.yaml-code-editor')");
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ]) {
      assert.equal(
        await ev(
          "document.querySelectorAll('.editor-pane button.danger').length",
        ),
        1,
      );
      assert.equal(
        await ev(
          "!!document.querySelector('.savebar > .document-save-actions > button.danger')",
        ),
        true,
      );
      await shot("open", w, h);
    }
    for (const [relative, text] of Object.entries(meta.fixtures))
      assert.equal(
        fs.readFileSync(path.join(root, relative), "utf8"),
        text,
        "fixture file changed",
      );
    assert.deepEqual(report.trashCalls, []);
    assert.deepEqual(blockedSpawns, []);
    assert(
      !report.ipcCalls.some((c) =>
        /^goga:(save-|delete-document$|launch$)/.test(c),
      ),
    );
    assert.equal(report.visibleWindows, 0);
    report.cspViolations = await ev("window.__cspViolations");
    assert.deepEqual(report.cspViolations, []);
    report.checks = [
      "One red action inside privacy panel; one red action in bottom savebar when open, separated from Save",
      "Red final confirmation, neutral Cancel initially focused",
      "Six wide/narrow screenshots, button bounds and no horizontal overflow",
      "No save/delete/launch IPC; all fixture contents unchanged; zero visible windows",
    ];
    report.status = "pass";
    report.limitations = [
      "Visual-only hidden Electron, synthetic fixture; no actual save/deletion/launch or user window interaction",
    ];
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
    allowedTrash,
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
