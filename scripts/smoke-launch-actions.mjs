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
if (process.env.LAUNCH_ACTIONS_ASAR_SHA256 !== archiveHash)
  throw Error(
    "Explicit verified ASAR SHA256 required; bundle must be reviewed before execution",
  );
const root = fs.mkdtempSync("/private/tmp/goga-launch-actions-smoke-");
const home = path.join(root, "home"),
  project = path.join(root, "project");
const fixtures = {
  "home/.goga/config.yml": "# Isolated test home\n",
  "project/.goga/config.yml": "topics:\n  base_ref: main\n",
  "project/.goga/pipelines/build.yml":
    "name: Build\n---\n- name: work\n  title: Work\n",
  [`project/.goga/history/${new Date().getFullYear()}/main/todo.md`]:
    "Saved fixture task\n",
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
      { id: "fixture", name: "Launch actions acceptance", path: project },
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
  const { EventEmitter } = require("node:events"),
    { PassThrough } = require("node:stream");
  const denySpawn = childProcess.spawn;
  childProcess.spawn = (exe, args, options) => {
    if (
      options?.cwd !== meta.project ||
      options.shell !== false ||
      options.env.HOME !== meta.home
    )
      return denySpawn(exe, args, options);
    let output;
    const key = JSON.stringify(args);
    if (exe === "git") {
      if (key === JSON.stringify(["branch", "--show-current"]))
        output = "main\n";
      else if (
        key ===
        JSON.stringify([
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
          "refs/remotes",
        ])
      )
        output = "main\nother\n";
      else if (
        key === JSON.stringify(["rev-parse", "HEAD"]) ||
        ["main", "other"].some(
          (b) =>
            key ===
            JSON.stringify([
              "rev-parse",
              "--verify",
              `refs/heads/${b}^{commit}`,
            ]),
        )
      )
        output = "a".repeat(40) + "\n";
      else if (
        key === JSON.stringify(["ls-tree", "-z", "a".repeat(40), "--", ".goga"])
      )
        output = "";
    } else if (exe === "goga") {
      if (key === JSON.stringify(["pipeline", "--list", "--info"]))
        output =
          "* build (project)\n  name: Сборка\n  description: Изолированная проверка интерфейса\n";
      else if (
        key === JSON.stringify(["topics", "board", "--json", "--per-host"])
      )
        output = JSON.stringify(
          ["main", "other"].map((branch) => ({
            branch,
            topic: branch,
            current: branch === "main",
            remote: false,
            todo: "",
            statuses: [],
          })),
        );
      else if (key === JSON.stringify(["pipeline", "build", "--info"]))
        output = "name: Сборка\n---\n* work:\n  title: Выполнение\n";
    }
    if (output === undefined) return denySpawn(exe, args, options);
    controlledCatalogCalls.push({ exe, args });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setTimeout(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", 0);
    }, 5);
    return child;
  };
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
    launchRequests: [],
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
      if (channel === "goga:launch") {
        report.launchRequests.push(args[0]);
        throw Error("Controlled test: launch suppressed before host mutations");
      }
      if (/^goga:(save-|delete-document$)/.test(channel))
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
    report.consoleErrors = [];
    wc.on("console-message", (_event, ...args) =>
      report.consoleErrors.push(args.map(String)),
    );
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
    const setValue = async (selector, value) => {
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:e.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==="SELECT"?"change":"input",{bubbles:true}))})()`,
      );
      await settle();
    };
    const key = async (keyCode) => {
      wc.sendInputEvent({ type: "keyDown", keyCode });
      wc.sendInputEvent({ type: "keyUp", keyCode });
      await settle();
    };
    const shot = async (label, width, height) => {
      win.setContentSize(width, height);
      await settle();
      if (!(await ev("!!document.querySelector('dialog[open]')")))
        await ev(
          "document.querySelector('.split-launch').scrollIntoView({block:'center'})",
        );
      await settle();
      await new Promise((r) => setTimeout(r, 100));
      const layout = await ev(`(()=>{
        const selector=document.querySelector('dialog[open]')?'dialog[open] button':'.split-launch button';
        return {buttons:[...document.querySelectorAll(selector)].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent.trim(),left:r.left,right:r.right,top:r.top,bottom:r.bottom}}),overflow:[...document.querySelectorAll('.scroll-area,.launch-panel')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
      })()`);
      assert.deepEqual(layout.overflow, []);
      assert(layout.buttons.length >= 2);
      for (const b of layout.buttons)
        assert(
          b.left >= 0 && b.right <= width && b.top >= 0 && b.bottom <= height,
          `Clipped ${b.text}`,
        );
      const file = path.join(root, `${label}-${width}x${height}.png`);
      fs.writeFileSync(file, (await wc.capturePage()).toPNG());
      report.screenshots.push({ file, width, height, layout });
    };
    const ready = () =>
      until("!!document.querySelector('.split-launch-main:not(:disabled)')");
    const menu = async () => {
      await ready();
      await clickLabel("Варианты запуска");
      await until("!!document.querySelector('[role=menuitem]')");
    };
    const ordinary = async () => {
      await ready();
      await ev("document.querySelector('.split-launch-main').click()");
      await settle();
    };
    const update = async () => {
      await menu();
      await ev("document.querySelector('[role=menuitem]').click()");
      await settle();
    };
    await clickText("＋ Запустить конвейер");
    await ready();
    assert.equal(
      await ev("document.querySelector('.split-launch-main').textContent"),
      "Запустить",
    );
    assert.equal(
      await ev(
        "[...document.querySelectorAll('label')].some(e=>/Подтверждаю.*запуск/.test(e.textContent))",
      ),
      false,
    );
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ]) {
      await shot("ordinary", w, h);
      await menu();
      await shot("menu", w, h);
      assert.equal(
        await ev("document.activeElement.getAttribute('role')"),
        "menuitem",
      );
      await key("Escape");
      assert.equal(
        await ev("document.activeElement.getAttribute('aria-label')"),
        "Варианты запуска",
      );
    }
    assert.equal(report.launchRequests.length, 0);
    await ordinary();
    await until("!!document.querySelector('[role=alert]')");
    assert.equal(report.launchRequests.length, 1);
    assert.equal(report.launchRequests[0].update, false);
    assert.equal(await ev("!!document.querySelector('dialog[open]')"), false);
    await update();
    await until(
      "!!document.querySelector('.split-launch-main:not(:disabled)')",
    );
    assert.equal(report.launchRequests.length, 2);
    assert.equal(report.launchRequests[1].update, true);
    assert.equal(report.launchRequests[1].clean, false);
    // New branch modal, exact source and no effects until approval. Cancel twice.
    await ev(
      "[...document.querySelectorAll('input[type=radio]')].find(e=>e.parentElement.textContent.includes('Создать новый')).click()",
    );
    await settle();
    await setValue(
      'input[placeholder="feature/export-report"]',
      "feature/exact",
    );
    await ready();
    await update();
    await until("!!document.querySelector('dialog[open]')");
    assert.equal(
      await ev("document.activeElement.textContent.trim()"),
      "Отмена",
    );
    assert.match(
      await ev("document.querySelector('dialog').textContent"),
      /feature\/exact/,
    );
    assert.match(
      await ev("document.querySelector('dialog').textContent"),
      /main/,
    );
    assert.match(
      await ev("document.querySelector('dialog').textContent"),
      /обновит образ/,
    );
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ])
      await shot("new-update", w, h);
    await key("Escape");
    assert.equal(await ev("!!document.querySelector('dialog[open]')"), false);
    assert.equal(report.launchRequests.length, 2);
    await ordinary();
    await clickText("Отмена");
    assert.equal(report.launchRequests.length, 2);
    await ordinary();
    await clickText("Создать и запустить");
    await ready();
    assert.equal(report.launchRequests.length, 3);
    assert.deepEqual(report.launchRequests[2].topic, {
      mode: "new",
      name: "feature/exact",
      baseRef: "HEAD",
    });
    assert.equal(report.launchRequests[2].update, false);
    // Other branch: real guarded task reader returns a missing committed fixture task.
    await ev(
      "[...document.querySelectorAll('input[type=radio]')].find(e=>e.parentElement.textContent.includes('Существующий')).click()",
    );
    await settle();
    await ev("document.querySelector('[role=combobox]').click()");
    await settle();
    await ev(
      "[...document.querySelectorAll('[role=option]')].find(e=>e.textContent.includes('other')).click()",
    );
    await ready();
    await setValue("textarea", "Dirty fixture task");
    await ready();
    assert.equal(
      await ev("document.querySelector('.split-launch-main').textContent"),
      "Сохранить и запустить",
    );
    await update();
    await until("!!document.querySelector('dialog[open]')");
    assert.match(
      await ev("document.querySelector('dialog').textContent"),
      /сохранена/,
    );
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ])
      await shot("other-dirty-update", w, h);
    await key("Tab");
    assert.equal(
      await ev("document.activeElement.textContent.trim()"),
      "Переключиться и запустить",
    );
    await key("Tab");
    assert.equal(
      await ev("document.activeElement.textContent.trim()"),
      "Отмена",
    );
    await clickText("Отмена");
    assert.equal(report.launchRequests.length, 3);
    assert.equal(
      await ev("document.querySelector('textarea').value"),
      "Dirty fixture task",
    );
    await update();
    await clickText("Переключиться и запустить");
    await ready();
    assert.equal(report.launchRequests.length, 4);
    assert.equal(report.launchRequests[3].update, true);
    assert.equal(report.launchRequests[3].task, "Dirty fixture task");
    assert.equal(report.launchRequests[3].confirmBranchSwitch, true);
    for (const [relative, text] of Object.entries(meta.fixtures))
      assert.equal(
        fs.readFileSync(path.join(root, relative), "utf8"),
        text,
        "fixture file changed",
      );
    assert.deepEqual(report.trashCalls, []);
    assert.deepEqual(blockedSpawns, []);
    assert(
      !report.ipcCalls.some((c) => /^goga:(save-|delete-document$)/.test(c)),
    );
    assert.equal(report.visibleWindows, 0);
    report.cspViolations = await ev("window.__cspViolations");
    assert.deepEqual(report.cspViolations, []);
    assert(
      controlledCatalogCalls.every(
        (c) => !c.args.includes("--update") && !c.args.includes("--clean"),
      ),
    );
    report.checks = [
      "Production signed ASAR main/preload/renderer; real discovery/preview/task parsing with allowlisted in-memory read-only process transport",
      "Current branch ordinary/update IPC requests; new/other branch modal, exact branch/source, dirty task/update text",
      "Escape, focus return, native modal Tab trap, neutral Cancel initially focused",
      "Eight wide/narrow screenshots; no clipped buttons or horizontal overflow",
      "No save/delete IPC; all fixture bytes unchanged; no real subprocess, branch mutation, Goga/Docker or visible windows",
    ];
    report.status = "pass";
    report.limitations = [
      "Final launch IPC captured and deliberately rejected before handler/host side effects. IPC boolean validation and host --update argv are covered by separate tests; no actual Docker update or pipeline run.",
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
