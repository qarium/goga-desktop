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
if (process.env.RUN_OUTPUT_ASAR_SHA256 !== archiveHash)
  throw Error(
    "Explicit verified ASAR SHA256 required; bundle must be reviewed before execution",
  );
const root = fs.mkdtempSync("/private/tmp/goga-run-output-smoke-");
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
fs.mkdirSync(path.join(project, ".git"), { recursive: true });
fs.mkdirSync(path.join(home, ".goga/desktop"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".goga/desktop/projects.json"),
  JSON.stringify({
    schemaVersion: 1,
    revision: "00000000-0000-4000-8000-000000000001",
    projects: [{ id: "fixture", name: "Run output acceptance", path: project }],
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
  const controlledCatalogCalls = [],
    runChildren = [],
    createdViews = [];
  const { EventEmitter } = require("node:events"),
    { PassThrough } = require("node:stream");
  const http = require("node:http");
  let holdBrowser = false;
  const pendingResponses = [];
  const httpRequests = [];
  const server = http.createServer((req, res) => {
    httpRequests.push({ url: req.url, time: Date.now(), holdBrowser });
    if (req.url === "/api/status") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ flow_name: "Fixture flow", stages: [] }));
    } else if (holdBrowser) {
      pendingResponses.push(res);
    } else {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        '<!doctype html><title>Isolated Dashboard</title><style>body{background:#101827;color:#e6eaf2;font:16px sans-serif;padding:32px}input{font:inherit;padding:12px}</style><h1>Fixture Dashboard</h1><input id="state" value="preserved page state"><p>Controlled local browser fixture, not Goga/AFM.</p>',
      );
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
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
        output = "main\n";
      else if (key === JSON.stringify(["rev-parse", "--git-common-dir"]))
        output = ".git\n";
      else if (
        key === JSON.stringify(["rev-parse", "HEAD"]) ||
        key ===
          JSON.stringify(["rev-parse", "--verify", "refs/heads/main^{commit}"])
      )
        output = "a".repeat(40) + "\n";
      else if (key === JSON.stringify(["status", "--porcelain"])) output = "";
    } else if (exe === "goga") {
      if (key === JSON.stringify(["pipeline", "--list", "--info"]))
        output =
          "* build (project)\n  name: Сборка\n  description: Изолированная проверка вывода\n";
      else if (
        key === JSON.stringify(["topics", "board", "--json", "--per-host"])
      )
        output = JSON.stringify([
          {
            branch: "main",
            topic: "main",
            current: true,
            remote: false,
            todo: "",
            statuses: [],
          },
        ]);
      else if (key === JSON.stringify(["pipeline", "build", "--info"]))
        output = "name: Сборка\n---\n* work:\n  title: Выполнение\n";
      else if (
        key === JSON.stringify(["pipeline", "build", "--update"]) ||
        key === JSON.stringify(["pipeline", "build"])
      ) {
        const child = new EventEmitter();
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        runChildren.push(child);
        controlledCatalogCalls.push({
          exe,
          args,
          kind: "in-memory pipeline transport",
        });
        setTimeout(() => {
          child.stdout.write("Fixture preparation started\n");
          child.stdout.write("\x1b[36mUTF-8: ");
          const bytes = Buffer.from("Привет 🙂");
          child.stdout.write(bytes.subarray(0, 4));
          child.stdout.write(bytes.subarray(4));
          child.stdout.write("\x1b[0m\n");
          child.stderr.write("fixture-secret-");
          setTimeout(
            () =>
              child.stderr.write("value dependency output\rnext output line\n"),
            20,
          );
        }, 20);
        return child;
      }
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
    browserLoads: [],
    browserEvents: [],
    httpRequests,
    notificationPrompts: 0,
    asarSha256: meta.archiveHash,
    realUserDataUsed: false,
    blockedSpawns,
    controlledCatalogCalls,
    processTransport:
      "allowlisted metadata and in-memory child output; real Host/IPC/browser lifecycle; no real Goga/Git/Docker process",
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
  const NativeView = electron.WebContentsView;
  Object.defineProperty(testElectron, "WebContentsView", {
    value: class extends NativeView {
      constructor(options) {
        super(options);
        createdViews.push(this);
        for (const event of [
          "did-start-loading",
          "dom-ready",
          "did-finish-load",
          "did-stop-loading",
          "did-fail-load",
          "render-process-gone",
        ]) {
          this.webContents.on(event, (_e, ...args) =>
            report.browserEvents.push({
              event,
              time: Date.now(),
              args: args.map(String),
            }),
          );
        }
        const load = this.webContents.loadURL.bind(this.webContents);
        this.webContents.loadURL = (url, ...args) => {
          report.browserLoads.push(url);
          return load(url, ...args);
        };
      }
    },
  });
  electron.dialog.showMessageBox = async (_win, options) => {
    if (options.title === "Уведомления AFM") {
      report.notificationPrompts++;
      return { response: 1 };
    }
    throw Error("Unexpected native confirmation");
  };
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
      if (channel === "goga:launch") report.launchRequests.push(args[0]);
      if (
        /^goga:(save-|delete-document$)/.test(channel) &&
        channel !== "goga:save-project-settings"
      )
        throw Error("Fixture forbids project writes/deletion");
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
  }, 150000);
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
    const setValue = async (selector, value) => {
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:e.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value").set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==="SELECT"?"change":"input",{bubbles:true}))})()`,
      );
      await settle();
    };
    const shot = async (label, width, height) => {
      win.setContentSize(width, height);
      await settle();
      if (label === "settings")
        await ev(
          "document.querySelector('input[aria-describedby=\"startup-timeout-help\"]').scrollIntoView({block:'center'})",
        );
      await new Promise((r) => setTimeout(r, 100));
      const layout = await ev(
        `(()=>({overflow:[...document.querySelectorAll('.scroll-area,.run-output-page,.project-settings-panel')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className),heading:[...document.querySelectorAll('h2,h3')].filter(e=>e.getClientRects().length).map(e=>e.textContent)}))()`,
      );
      assert.deepEqual(layout.overflow, []);
      const file = path.join(root, `${label}-${width}x${height}.png`);
      fs.writeFileSync(file, (await wc.capturePage()).toPNG());
      report.screenshots.push({ file, width, height, layout });
    };
    const both = async (label) => {
      for (const [w, h] of [
        [1320, 900],
        [920, 700],
      ])
        await shot(label, w, h);
    };
    const ready = () =>
      until("!!document.querySelector('.split-launch-main:not(:disabled)')");
    const runs = () => ev("window.goga.runs()");
    // Only this disposable home gets settings; the fixture project stays byte-identical.
    await ev(
      `(async()=>{const doc=await window.goga.readProjectSettings('fixture');await window.goga.saveProjectSettings('fixture',{...doc.value,env:[{key:'FIXTURE_TOKEN',value:'fixture-secret-value',secret:true,runtime:false}]},doc.version)})()`,
    );
    await clickText("Настройки");
    await until(
      "!!document.querySelector('input[aria-describedby=\"startup-timeout-help\"]')",
    );
    assert.equal(
      await ev(
        "document.querySelector('input[aria-describedby=\"startup-timeout-help\"]').value",
      ),
      "10",
    );
    await setValue('input[aria-describedby=\"startup-timeout-help\"]', "1");
    await clickText("Сохранить");
    await until("document.body.textContent.includes('Сохранено.')");
    await both("settings");
    await clickText("← Назад");
    await clickText("＋ Запустить конвейер");
    await ready();
    await clickLabel("Варианты запуска");
    await ev("document.querySelector('[role=menuitem]').click()");
    await until(
      "!!document.querySelector('.run-output-page') && document.querySelector('.run-output-text').textContent.includes('next output line')",
    );
    assert.equal(runChildren.length, 1);
    assert.equal((await runs())[0].startupTimeoutMs, 60000);
    assert.equal(
      await ev(
        "document.querySelector('.run-output-text').textContent.includes('fixture-secret-value')",
      ),
      false,
    );
    assert.equal(
      await ev(
        "document.querySelector('.run-output-text').textContent.includes('Привет 🙂')",
      ),
      true,
    );
    assert.equal(report.launchRequests[0].update, true);
    assert.equal(createdViews.length, 0);
    await both("preparing");
    runChildren[0].stdout.write("dashboard: " + origin + "\n");
    await until(
      "document.querySelector('.run-output-toggle')?.textContent.includes('Работает')",
    );
    assert.equal((await runs())[0].dashboardOpened, true);
    assert.equal(createdViews.length, 1);
    assert.equal(report.browserLoads.length, 1);
    const dashboard = createdViews[0].webContents;
    await dashboard.executeJavaScript(
      "document.querySelector('#state').value='state survives journal toggle'",
    );
    runChildren[0].stderr.write("after Dashboard ready output\n");
    await new Promise((r) => setTimeout(r, 150));
    await ev("document.querySelector('.run-output-toggle').click()");
    await until("!!document.querySelector('.run-output-text')");
    assert.match(
      await ev("document.querySelector('.run-output-text').textContent"),
      /after Dashboard ready output/,
    );
    assert.equal(createdViews[0].getVisible(), false);
    await both("journal");
    wc.focus();
    await ev("document.querySelector('.run-output-toggle').focus()");
    wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    wc.sendInputEvent({ type: "char", keyCode: "\r" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await until("!!document.querySelector('.afm-placeholder')");
    assert.equal(createdViews[0].getVisible(), true);
    assert.equal(
      await dashboard.executeJavaScript(
        "document.querySelector('#state').value",
      ),
      "state survives journal toggle",
    );
    await ev(
      "document.querySelector('.run-output-toggle').click();document.querySelector('.run-output-toggle').click()",
    );
    await settle();
    assert.equal(report.browserLoads.length, 1);
    assert.equal(createdViews.length, 1);
    runChildren[0].stderr.write("controlled exit diagnostic\n");
    runChildren[0].stdout.end();
    runChildren[0].stderr.end();
    runChildren[0].emit("close", 2);
    await until(
      "document.querySelector('.run-output-text')?.textContent.includes('controlled exit diagnostic') && document.body.textContent.includes('кодом 2')",
    );
    await both("error");
    assert.equal((await runs())[0].status, "failed");
    // A second ordinary run has a responsive /api/status but browser body never opens.
    // Real one-minute deadline must terminate this new fixture, not the earlier run.
    holdBrowser = true;
    await clickText("＋ Запустить конвейер");
    await ready();
    await ev("document.querySelector('.split-launch-main').click()");
    await until(
      "document.querySelector('.run-output-text')?.textContent.includes('Fixture preparation started')",
    );
    assert.equal(runChildren.length, 2);
    runChildren[1].stdout.write("second run only\ndashboard: " + origin + "\n");
    for (let i = 0; i < 400 && pendingResponses.length === 0; i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(pendingResponses.length, 1);
    const pendingWebContents = createdViews[1].webContents;
    const started = Date.now();
    let last;
    while (Date.now() - started < 70000) {
      last = (await runs())[1];
      if (last?.status === "failed") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(last.status, "failed");
    assert.match(last.error, /Время запуска истекло/);
    assert.equal(last.dashboardOpened, false);
    assert.equal(last.url, undefined);
    assert.match(last.output.text, /second run only/);
    assert(!last.output.text.includes("after Dashboard ready output"));
    await until("document.body.textContent.includes('Время запуска истекло')");
    await both("timeout");
    assert.equal(pendingWebContents.isDestroyed(), true);
    assert.equal((await runs())[0].error, "Goga завершилась с кодом 2");
    assert.equal(report.launchRequests[1].update, false);
    report.runSummaries = (await runs()).map((r) => ({
      id: r.id,
      status: r.status,
      dashboardOpened: r.dashboardOpened,
      startupTimeoutMs: r.startupTimeoutMs,
      error: r.error,
      outputBytes: Buffer.byteLength(r.output.text),
    }));
    report.deadlineWaitMs = Date.now() - started;
    for (const [relative, text] of Object.entries(meta.fixtures))
      assert.equal(
        fs.readFileSync(path.join(root, relative), "utf8"),
        text,
        "fixture file changed",
      );
    assert.deepEqual(report.trashCalls, []);
    assert.deepEqual(blockedSpawns, []);
    assert(
      !report.ipcCalls.some(
        (c) =>
          /^goga:(save-|delete-document$)/.test(c) &&
          c !== "goga:save-project-settings",
      ),
    );
    assert.equal(report.visibleWindows, 0);
    report.cspViolations = await ev("window.__cspViolations");
    assert.deepEqual(report.cspViolations, []);
    report.checks = [
      "Production signed ASAR main/preload/renderer and Host lifecycle; temporary settings and safe controlled process transport",
      "UTF-8/ANSI/CR/known secret masking before UI; output before/after browser load, error and timeout",
      "Status click/Enter/double click hides/shows retained native view; input state persists; loadURL exactly once per run",
      "One real one-minute startup deadline expires during browser body load after status endpoint ready; pending view destroyed; prior run unaffected",
      "Ten inspected wide/narrow screenshots; no horizontal overflow; zero visible windows, real commands or Docker",
    ];
    report.status = "pass";
    report.limitations = [
      "No actual Goga/Docker execution. Child streams and metadata responses are controlled in-memory fixtures; HTTP/browser lifecycle is real localhost.",
      "Known fixture secrets masked; unknown external secrets cannot be guaranteed safe.",
    ];
    report.ok = true;
  } catch (e) {
    report.error = String(e);
    report.stack = e.stack;
    try {
      const win = createdWindows[0];
      if (win) {
        report.failureRuns =
          await win.webContents.executeJavaScript("window.goga.runs()");
        report.failureBody = await win.webContents.executeJavaScript(
          "document.body.innerText",
        );
      }
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
  pendingResponses.forEach((res) => res.destroy());
  server.close();
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
  timeout: 160000,
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
