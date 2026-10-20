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
const root = fs.mkdtempSync("/private/tmp/goga-document-trash-smoke-");
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
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const controlledCatalogCalls = [];
  let mode = "catalog",
    delay = 0;
  const catalog = [];
  const denySpawn = childProcess.spawn;
  childProcess.spawn = (exe, args, options) => {
    if (
      exe !== meta.fixtureExecutable ||
      options?.cwd !== meta.project ||
      options?.shell !== false ||
      options?.env?.HOME !== meta.home ||
      JSON.stringify(args) !== JSON.stringify(["pipeline", "--list", "--info"])
    )
      return denySpawn(exe, args, options);
    controlledCatalogCalls.push({
      executableMatched: true,
      cwdMatched: true,
      savedEnvMatched:
        options.env.SUGGESTION_FIXTURE === "fixture-private-value",
      isolatedHomeMatched: options.env.HOME === meta.home,
      noShell: options.shell === false,
      args,
    });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const responseMode = mode;
    setTimeout(() => {
      child.stdout.end(
        responseMode === "catalog"
          ? catalog
              .map(
                (p) =>
                  `* ${p.id}${p.project ? " (project)" : ""}\n  name: ${p.name}\n  description: fixture`,
              )
              .join("\n")
          : "",
      );
      child.stderr.end(
        responseMode === "error" ? "controlled catalog failure" : "",
      );
      child.emit("close", responseMode === "error" ? 1 : 0);
    }, delay);
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
  let trashMode = "move";
  Object.defineProperty(controlledShell, "trashItem", {
    value: async (absolutePath) => {
      const accepted =
        typeof absolutePath === "string" &&
        meta.allowedTrash.includes(absolutePath);
      report.trashCalls.push({ path: absolutePath, mode: trashMode, accepted });
      if (!accepted) throw Error("Fixture rejects non-allowlisted trash path");
      assert.equal(fs.lstatSync(absolutePath).isFile(), true);
      assert.equal(fs.realpathSync(absolutePath), absolutePath);
      if (trashMode === "reject")
        throw Error("Controlled rejection before move");
      const destination = path.join(
        root,
        "fixture-trash",
        String(report.trashCalls.length) + "-" + path.basename(absolutePath),
      );
      fs.renameSync(absolutePath, destination);
      report.trashCalls.at(-1).destination = destination;
      if (trashMode === "move-reject")
        throw Error("Controlled rejection after move");
    },
  });
  Object.defineProperty(testElectron, "shell", { value: controlledShell });
  // Observe real registered IPC handlers, without replacing their return values.
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, handler) =>
    originalHandle(channel, (event, ...args) => {
      report.ipcCalls.push(channel);
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
    const setInput = async (label, value) => {
      await ev(
        `(()=>{const e=document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']')??[...document.querySelectorAll('label')].find(l=>l.textContent.trim()===${JSON.stringify(label)})?.querySelector('input');if(!e)throw Error('Input absent');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`,
      );
      await settle();
    };
    const key = async (keyCode, modifiers = []) => {
      await ev(`window.__testPhase=${JSON.stringify("key " + keyCode)}`);
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await settle();
    };
    const editor =
      "[...document.querySelectorAll('.yaml-code-editor')].find(e=>e.getClientRects().length)?.shadowRoot?.querySelector('.cm-content')";
    const replaceYAML = async (text) => {
      await until(`!!(${editor})`);
      await ev(`window.__testPhase='focus';(${editor}).focus()`);
      await key("A", ["meta"]);
      await ev(`window.__testPhase='native typing'`);
      // Type lines with Enter, exercising the real editor keymap. CSP observations
      // are captured separately; no policy is disabled by this harness.
      for (const [i, line] of text.split("\n").entries()) {
        if (i) await key("Enter");
        if (line) {
          await ev(`window.__testPhase='native character input'`);
          for (const character of line)
            wc.sendInputEvent({ type: "char", keyCode: character });
        }
        await settle();
      }
      await ev(`window.__testPhase='after native typing'`);
    };
    const file = (relative) => path.join(root, relative);
    const untouched = () => {
      for (const [relative, original] of Object.entries(meta.fixtures)) {
        const absolute = file(relative);
        if (meta.allowedTrash.includes(absolute)) continue;
        assert.equal(
          fs.readFileSync(absolute, "utf8"),
          original,
          relative + " changed",
        );
      }
      for (const relative of [
        "project/.goga",
        "project/.goga/pipelines",
        "project/.goga/workflows",
        "project/.goga/tools/review-kit/environments/local",
        "home/.goga/profiles",
      ])
        assert(
          fs.statSync(file(relative)).isDirectory(),
          relative + " directory removed",
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
      if (layout.gap !== null)
        assert(layout.gap >= 24 && layout.gap <= 25, label + " gap24");
      if (label === "failure-before-move" || label === "uncertain-workflow") {
        await ev(
          "document.querySelector('.editor-pane .error').scrollIntoView({block:'center'})",
        );
        await settle();
        layout.error = await ev(
          "(()=>{const e=document.querySelector('.editor-pane .error'),r=e.getBoundingClientRect();return {text:e.textContent,top:r.top,bottom:r.bottom,left:r.left,right:r.right}})()",
        );
        assert(
          layout.error.top >= 0 &&
            layout.error.bottom <= height &&
            layout.error.left >= 0 &&
            layout.error.right <= width,
          label + " error visible",
        );
      }
      const screenshot = path.join(root, `${label}-${width}x${height}.png`);
      fs.writeFileSync(screenshot, (await wc.capturePage()).toPNG());
      report.screenshots.push({ file: screenshot, width, height, layout });
    };
    const pair = async (label) => {
      await shot(label, 1320, 900);
      await shot(label, 920, 700);
    };
    const selectFile = async (label) => {
      await until(
        `!!document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']')`,
      );
      await clickLabel(label);
      await until("!!document.querySelector('.editor-pane')");
    };
    const prepare = async (memory = false) => {
      await clickText(memory ? "Удалить черновик" : "Удалить");
      await until("!!document.querySelector('dialog[open]')");
      assert.equal(
        await ev("document.activeElement.textContent.trim()"),
        "Отмена",
        "Cancel initially focused",
      );
    };
    const confirm = async () => {
      await ev("document.querySelector('[data-confirm-delete]').click()");
      await until("!document.querySelector('dialog[open]')");
      await settle();
    };
    const moved = (relative) => {
      const absolute = file(relative),
        call = report.trashCalls.find(
          (c) => c.path === absolute && c.destination,
        );
      assert(call, "expected move missing");
      assert(!fs.existsSync(absolute));
      assert.equal(
        fs.readFileSync(call.destination, "utf8"),
        meta.fixtures[relative],
        "exact saved source bytes moved",
      );
      untouched();
    };
    const settings = await ev("window.goga.readProjectSettings('fixture')");
    await ev(
      `window.goga.saveProjectSettings('fixture',${JSON.stringify({ ...settings.value, executable: meta.fixtureExecutable })},${JSON.stringify(settings.version)}).then(()=>true)`,
    );
    report.checks.push(
      "Supporting setup uses real settings IPC; no renderer API mock; production sandbox/CSP unchanged",
    );
    await ev("document.querySelector('.project-settings-action').click()");
    await until("!!document.querySelector('.section-tabs')");
    await clickText("Конфигурация");
    assert.equal(
      await ev(
        "[...document.querySelectorAll('.editor-pane button')].some(e=>e.textContent.trim()==='Удалить')",
      ),
      false,
    );
    await clickText("Конвейеры");
    await selectFile("Файл .goga/pipelines/target.yml");
    assert.equal(await ev(`!!(${editor})`), false);
    const pipelinePath = file("project/.goga/pipelines/target.yml");
    await prepare();
    const dialogText = await ev("document.querySelector('dialog').textContent");
    assert(dialogText.includes(".goga/pipelines/target.yml"));
    assert(!dialogText.includes("PRIVATE SENTINEL"));
    assert.equal(await ev(`!!(${editor})`), false);
    assert.equal(report.trashCalls.length, 0);
    await pair("hidden-confirmation");
    await clickText("Отмена");
    await until("!document.querySelector('dialog[open]')");
    await prepare();
    await key("Escape");
    await until("!document.querySelector('dialog[open]')");
    assert.equal(report.trashCalls.length, 0);
    assert(fs.existsSync(pipelinePath));
    report.checks.push(
      "Hidden pipeline confirmation reveals relative path only, not source; Cancel focus, Cancel and native Escape preserve disk/editor privacy",
    );
    await clickText("Открыть редактор");
    await replaceYAML("# DIRTY PIPELINE RETAINED");
    await prepare();
    assert(
      (await ev("document.querySelector('dialog').textContent")).includes(
        "Несохранённые изменения будут потеряны",
      ),
    );
    assert(
      (await ev("document.querySelector('dialog').textContent")).includes(
        "сохранённая версия",
      ),
    );
    trashMode = "reject";
    await confirm();
    await until("!!document.querySelector('.editor-pane .error')");
    assert(
      (await ev(`(${editor}).textContent`)).includes("DIRTY PIPELINE RETAINED"),
    );
    assert(fs.existsSync(pipelinePath));
    await pair("failure-before-move");
    await ev(`(${editor}).focus()`);
    await key("Z", ["meta"]);
    assert.notEqual(
      await ev(`(${editor}).textContent`),
      "# DIRTY PIPELINE RETAINED",
      "Undo history survives rejected deletion",
    );
    await key("Z", ["meta", "shift"]);
    assert.equal(
      await ev(`(${editor}).textContent`),
      "# DIRTY PIPELINE RETAINED",
    );
    trashMode = "move";
    await prepare();
    await confirm();
    moved("project/.goga/pipelines/target.yml");
    await until(
      "!document.querySelector('.editor-pane')&&document.querySelectorAll('.empty-file').length===1",
    );
    await pair("last-pipeline-success");
    report.checks.push(
      "Dirty saved pipeline: warning distinguishes saved bytes; pre-move failure retains editor/text/Undo; confirmed success moves exact saved bytes, clears only selection, one last-file empty state",
    );
    await clickText("Рабочие процессы");
    await selectFile("Файл .goga/workflows/target.yml");
    await clickText("Открыть редактор");
    await replaceYAML("# DIRTY WORKFLOW RETAINED");
    trashMode = "move-reject";
    await prepare();
    await confirm();
    await until("!!document.querySelector('.editor-pane .error')");
    assert(
      (await ev(`(${editor}).textContent`)).includes("DIRTY WORKFLOW RETAINED"),
    );
    moved("project/.goga/workflows/target.yml");
    await pair("uncertain-workflow");
    await ev(`(${editor}).focus()`);
    await key("Z", ["meta"]);
    assert.notEqual(
      await ev(`(${editor}).textContent`),
      "# DIRTY WORKFLOW RETAINED",
    );
    await key("Z", ["meta", "shift"]);
    assert.equal(
      await ev(`(${editor}).textContent`),
      "# DIRTY WORKFLOW RETAINED",
    );
    await clickText("Конфигурация");
    await clickText("Рабочие процессы");
    await until(`!!(${editor})`);
    assert(
      (await ev(`(${editor}).textContent`)).includes("DIRTY WORKFLOW RETAINED"),
      "catalog refresh must retain uncertain editor",
    );
    report.checks.push(
      "Workflow move-then-reject is uncertain: error retains editor/text/Undo; catalog refresh after missing source keeps draft",
    );
    await clickText("Инструменты");
    await until(
      "!!document.querySelector('[aria-label=\"Папка environments\"]')",
    );
    await clickLabel("Папка environments");
    await clickLabel("Папка environments/local");
    await selectFile("Файл environments/local/sibling.yml");
    await clickText("Открыть редактор");
    await replaceYAML("# OTHER TOOL DRAFT RETAINED");
    await selectFile("Файл environments/local/target.yml");
    trashMode = "move";
    await prepare();
    await confirm();
    moved("project/.goga/tools/review-kit/environments/local/target.yml");
    await until("!document.querySelector('.editor-pane')");
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\"Папка environments/local\"]').getAttribute('aria-expanded')",
      ),
      "true",
    );
    await selectFile("Файл environments/local/sibling.yml");
    assert(
      (await ev(`(${editor}).textContent`)).includes(
        "OTHER TOOL DRAFT RETAINED",
      ),
    );
    report.checks.push(
      "Nested tool confirmed success moves only selected YAML; config/sibling bytes and folders unchanged; tree expansion and unrelated draft retained",
    );
    await ev("document.querySelector('.settings-button').click()");
    await until("!!document.querySelector('.structured-settings')");
    assert.equal(
      await ev(
        "[...document.querySelectorAll('.editor-pane button')].some(e=>e.textContent.trim()==='Удалить')",
      ),
      false,
    );
    await clickText("Профили");
    await clickText("personal");
    await prepare();
    await confirm();
    moved("home/.goga/profiles/personal.yml");
    await until("!document.querySelector('.editor-pane')");
    await clickText("＋ Новый профиль");
    await setInput("Имя профиля", "memory-profile");
    await clickText("Создать черновик");
    await until(`!!(${editor})`);
    assert.equal(await ev(`(${editor}).textContent`), "{}");
    await clickText("Скрыть без сохранения");
    await until("!!document.querySelector('.privacy-note')");
    const callsBefore = report.ipcCalls.length,
      trashBefore = report.trashCalls.length;
    await prepare(true);
    await confirm();
    await until("!document.querySelector('.editor-pane')");
    assert.equal(
      report.ipcCalls.length,
      callsBefore,
      "memory-only deletion must not call IPC",
    );
    assert.equal(report.trashCalls.length, trashBefore);
    assert(!fs.existsSync(file("home/.goga/profiles/memory-profile.yml")));
    report.checks.push(
      "Personal profile confirmed success; new profile is explicit memory-only {}; hide→delete draft performs no IPC/trash/file creation; both config editors have no Delete",
    );
    untouched();
    assert(report.trashCalls.every((c) => c.accepted));
    assert.equal(report.blockedSpawns.length, 0);
    assert.equal(report.visibleWindows, 0);
    assert(createdWindows.every((w) => !w.isVisible()));
    report.cspViolations = await ev("window.__cspViolations");
    assert(
      report.cspViolations.every(
        (v) =>
          v.directive === "style-src-attr" &&
          v.blocked === "inline" &&
          v.source === "" &&
          v.line === 0 &&
          v.phase === "native character input",
      ),
      "Unexpected CSP violation",
    );
    report.warnings = report.cspViolations.length
      ? [
          "Native editor character input triggered blocked inline styles; CSP unchanged; zero-CSP not claimed.",
        ]
      : [];
    report.limitations = [
      "Controlled allowlisted rename transport, not real OS Trash; no real Goga/Git command, Windows/Linux or native catalog fallback acceptance claimed.",
      "DOM click/focus/input setup; editor typing and Escape/Undo/Redo use native Electron input. Main/preload/renderer are unchanged signed ASAR, single-instance guard retained.",
      "Advanced source-change/race/process guards are unit-covered separately, not claimed by this reduced native smoke.",
    ];
    report.status = report.warnings.length
      ? "functional-pass-with-warning"
      : "pass";
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
