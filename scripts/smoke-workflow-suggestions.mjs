// Executes production main/preload/renderer from the signed ASAR in an isolated,
// hidden Electron harness. No real home, project, clipboard, or pipeline is used.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
const root = fs.mkdtempSync("/private/tmp/goga-workflow-suggestions-smoke-");
const home = path.join(root, "home"),
  project = path.join(root, "project");
fs.mkdirSync(path.join(root, "ipc-project"));
for (const dir of [
  "home/.goga/desktop",
  "home/.goga/profiles",
  "project/.goga/tools/review-kit/environments/local",
  "project/.goga/tools/review-kit/environments/ci",
  "project/.goga/tools/docs-kit",
  "project/.goga/tools/empty-kit",
])
  fs.mkdirSync(path.join(root, dir), { recursive: true });
const projectSource =
  '# Синтетический проект 🙂\r\nproject: "fixture"\nenabled: true\n';
fs.writeFileSync(
  path.join(home, ".goga/desktop/projects.json"),
  JSON.stringify({
    schemaVersion: 1,
    revision: "00000000-0000-4000-8000-000000000001",
    projects: [
      { id: "fixture", name: "Workflow acceptance", path: project },
      { id: "ipc", name: "IPC fixture", path: path.join(root, "ipc-project") },
    ],
  }),
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(home, ".goga/config.yml"),
  "# Домашняя конфигурация\ncustom: true\n",
);
fs.writeFileSync(
  path.join(home, ".goga/profiles/personal.yml"),
  "# Личный профиль\nagent: codex\n",
);
fs.writeFileSync(path.join(project, ".goga/config.yml"), projectSource);
for (const [file, text] of Object.entries({
  "review-kit/config.yml":
    '# Root configuration\nenabled: true\nretries: 3\nlabel: "demo"\n',
  "review-kit/environments/local/config.yml": "# local\nmode: local\n",
  "review-kit/environments/ci/config.yml": "# ci\nmode: ci\n",
  "docs-kit/site.yml": "title: demo\n",
  "docs-kit/navigation.yml": "sections: []\n",
  "review-kit/image.bin": "not a YAML file",
}))
  fs.writeFileSync(path.join(project, ".goga/tools", file), text);
fs.mkdirSync(path.join(project, ".goga/workflows"), { recursive: true });
fs.writeFileSync(
  path.join(project, ".goga/workflows/existing.yml"),
  "# untouched existing\n",
);
fs.mkdirSync(path.join(project, ".goga/workflows/occupied-directory.yml"));
fs.writeFileSync(path.join(root, "symlink-target.yml"), "# untouched target\n");
fs.symlinkSync(
  path.join(root, "symlink-target.yml"),
  path.join(project, ".goga/workflows/occupied-link.yml"),
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
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const controlledCatalogCalls = [];
  let mode = "catalog",
    delay = 0;
  const catalog = [
    { id: "development", name: "Разработка", project: true },
    { id: "acme:spec", name: "Спецификация", project: false },
    { id: "existing", name: "Уже существует", project: true },
    { id: "occupied-link", name: "Занятая ссылка", project: false },
    { id: "occupied-directory", name: "Занятый каталог", project: false },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `long-${String(i).padStart(2, "0")}-${"identifier".repeat(10)}`,
      name: `Длинное название ${i} ${"проверка переноса ".repeat(12)}`,
      project: i % 2 === 0,
    })),
  ];
  const denySpawn = childProcess.spawn;
  childProcess.spawn = (exe, args, options) => {
    if (
      exe !== meta.fixtureExecutable ||
      options?.cwd !== meta.project ||
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
  }, 90000);
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
    const input = "document.querySelector('input[role=combobox]')";
    const options = "[...document.querySelectorAll('[role=option]')]";
    const treeSnapshot = () => {
      const visit = (dir) =>
        fs
          .readdirSync(dir)
          .sort()
          .flatMap((name) => {
            const file = path.join(dir, name),
              rel = path.relative(meta.project, file),
              stat = fs.lstatSync(file);
            return stat.isSymbolicLink()
              ? [[rel, "symlink", fs.readlinkSync(file)]]
              : stat.isDirectory()
                ? [[rel, "directory"], ...visit(file)]
                : [[rel, "file", fs.readFileSync(file).toString("base64")]];
          });
      return visit(meta.project);
    };
    const baseline = treeSnapshot();
    const unchanged = () =>
      assert.deepEqual(
        treeSnapshot(),
        baseline,
        "Suggestion/UI-only actions must not write project files",
      );
    const initialSettings = await ev(
      "window.goga.readProjectSettings('fixture')",
    );
    const settingsValue = {
      ...initialSettings.value,
      executable: meta.fixtureExecutable,
      env: [
        {
          key: "SUGGESTION_FIXTURE",
          value: "fixture-private-value",
          secret: true,
          runtime: false,
        },
      ],
    };
    await ev(
      `window.goga.saveProjectSettings('fixture',${JSON.stringify(settingsValue)},${JSON.stringify(initialSettings.version)}).then(()=>true)`,
    );
    const apiCatalog = await ev(
      "window.goga.listWorkflowSuggestions('fixture')",
    );
    assert.deepEqual(
      apiCatalog.map(({ id, name, project }) => ({ id, name, project })),
      catalog.filter(
        (p) => !p.id.startsWith("occupied-") && p.id !== "existing",
      ),
    );
    unchanged();
    report.checks.push(
      "Production settings IPC persisted fixture executable/env; production suggestion IPC returns exact project/installed IDs and titles and filters occupied files, symlinks, directories; no project writes",
    );
    const focus = async () => {
      await ev(
        `${input}.focus();${input}.dispatchEvent(new FocusEvent('focusin',{bubbles:true}))`,
      );
      await settle();
    };
    const name = async (value) => {
      await setInput("Имя рабочего процесса", value);
      await focus();
    };
    const shot = async (label, width, height, popupExpected = false) => {
      win.setContentSize(width, height);
      await settle();
      await ev("document.querySelector('.scroll-area').scrollTop=0");
      await settle();
      if (popupExpected) await focus();
      await new Promise((r) => setTimeout(r, 100));
      const layout = await ev(`(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
        const area=document.querySelector('.scroll-area');
        const tabs=[...document.querySelector('nav[aria-label="Разделы настроек проекта"]').querySelectorAll('button')].map(e=>({...rect(e),text:e.textContent,unclipped:e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1}));
        const controls=document.querySelector('.tool-controls');
        const popup=document.querySelector('[role=listbox]');
        const long=popup?.querySelectorAll('[role=option]')[2];
        return {width:innerWidth,height:innerHeight,viewport:rect(area),tabs,tabBottom:document.querySelector('.project-settings-panel > .section-tabs').getBoundingClientRect().bottom,
          popup:popup?{...rect(popup),scrollHeight:popup.scrollHeight,clientHeight:popup.clientHeight}:null,
          longWrapped:long?long.querySelector('span').getBoundingClientRect().height>parseFloat(getComputedStyle(long.querySelector('span')).lineHeight):null,
          overflow:[...document.querySelectorAll('.app-shell,.scroll-area,.project-settings-panel,.workflow-name-form,.workflow-name-input,.workflow-name-popup,.workflow-name-option')].filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1).map(e=>e.className),
          gap:controls.nextElementSibling.getBoundingClientRect().top-controls.getBoundingClientRect().bottom};})()`);
      assert.deepEqual(
        layout.tabs.map((t) => t.text),
        [
          "Запуск",
          "Конфигурация",
          "Инструменты",
          "Рабочие процессы",
          "Конвейеры",
        ],
      );
      assert(
        layout.tabs.every(
          (t) =>
            t.unclipped &&
            t.left >= 0 &&
            t.right <= width &&
            t.top >= 0 &&
            t.bottom <= height,
        ),
        label + " translated tabs visible",
      );
      assert.deepEqual(layout.overflow, [], label + " horizontal overflow");
      assert(layout.gap >= 24 && layout.gap <= 25, label + " 24px toolbar gap");
      if (popupExpected) {
        assert(layout.popup, label + " popup visible");
        assert(
          layout.popup.top >=
            Math.max(layout.viewport.top, layout.tabBottom) - 1,
          label + " popup above tabs/clipped viewport",
        );
        assert(
          layout.popup.bottom <= Math.min(layout.viewport.bottom, height) + 1,
          label + " popup bottom outside viewport",
        );
        assert(
          layout.popup.left >= layout.viewport.left &&
            layout.popup.right <= layout.viewport.right,
          label + " popup horizontal bounds",
        );
        assert(
          layout.popup.scrollHeight > layout.popup.clientHeight,
          label + " long catalog scrollable",
        );
        assert(layout.longWrapped, label + " long title wraps");
      }
      const file = `${label}-${width}x${height}.png`;
      fs.writeFileSync(path.join(root, file), (await wc.capturePage()).toPNG());
      report.screenshots.push({ file, width, height, layout });
    };
    await ev("document.querySelector('.project-settings-action').click()");
    await until(
      "!!document.querySelector('nav[aria-label=\"Разделы настроек проекта\"]')",
    );
    await clickText("Рабочие процессы");
    await until("!!document.querySelector('.workflow-controls')");
    await clickText("Создать рабочий процесс");
    await focus();
    await until(`${options}.length===42`);
    assert.equal(await ev(`${input}.value`), "");
    assert.equal(
      await ev(`${input}.getAttribute('aria-activedescendant')`),
      null,
    );
    await key("Enter");
    assert.equal(await ev(`${input}.value`), "");
    assert.equal(
      await ev("document.querySelectorAll('.yaml-code-editor').length"),
      0,
    );
    for (const [width, height] of [
      [1320, 900],
      [920, 700],
    ]) {
      await shot("suggestions-popup", width, height, true);
      const outer = await ev(
        "document.querySelector('.scroll-area').scrollTop",
      );
      for (let i = 0; i < 41; i++) await key("Down");
      assert.equal(
        await ev("document.querySelector('.scroll-area').scrollTop"),
        outer,
        "Keyboard must not scroll outer viewport",
      );
      assert(
        await ev("document.querySelector('[role=listbox]').scrollTop>0"),
        "Keyboard scrolls options",
      );
      await key("Escape");
      await focus();
    }
    await name("");
    await key("Up");
    assert.equal(
      await ev(
        `document.getElementById(${input}.getAttribute('aria-activedescendant')).querySelector('small').textContent`,
      ),
      catalog.at(-1).id + ".yml",
    );
    await key("Escape");
    await name("СпЕцИф");
    await until(`${options}.length===1`);
    assert.equal(
      await ev(`${options}[0].querySelector('small').textContent`),
      "acme:spec.yml",
    );
    await name("acme:spec");
    await until(`${options}.length===1`);
    await name("Разработка");
    await until(`${options}.length===1`);
    assert.equal(
      await ev(`${options}[0].querySelector('small').textContent`),
      "development.yml",
    );
    await name("");
    await key("Down");
    await key("Escape");
    assert.equal(
      await ev("document.querySelector('[role=listbox]')===null"),
      true,
    );
    await name("my-manual-name");
    assert.equal(await ev(`${input}.value`), "my-manual-name");
    await name("");
    await key("Tab");
    assert.equal(
      await ev("document.querySelector('[role=listbox]')===null"),
      true,
    );
    await focus();
    await key("Down");
    await ev(
      `${input}.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}))`,
    );
    await key("Enter");
    assert.equal(await ev(`${input}.value`), "");
    await ev(
      `${input}.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}))`,
    );
    await name("Спецификация");
    await key("Down");
    await key("Enter");
    assert.equal(await ev(`${input}.value`), "acme:spec");
    assert.equal(
      await ev("document.querySelectorAll('.yaml-code-editor').length"),
      0,
    );
    unchanged();
    report.checks.push(
      "Native Arrow/Enter/Escape/Tab events: no initial selection or accidental form submit, title and exact-ID filtering, manual name, choice fills exact acme:spec only; synthetic composition guard (not native IME)",
    );
    await clickText("Создать черновик");
    await until(`!!(${editor})`);
    unchanged();
    const draft =
      "# Namespace workflow 🙂\n{% if worker %}\nstages:\n  build:\n    agent: {{ worker.agent }}\n{% endif %}\n";
    await replaceYAML(draft);
    unchanged();
    await shot("suggestions-draft", 1320, 900);
    await shot("suggestions-draft", 920, 700);
    await clickText("Создать рабочий процесс");
    await name("");
    await until(`${options}.length===41`);
    assert(
      !(await ev(
        `${options}.some(e=>e.querySelector('small').textContent==='acme:spec.yml')`,
      )),
    );
    assert(
      (await ev(`(${editor}).textContent`)).includes("Namespace workflow"),
    );
    unchanged();
    await key("Escape");
    await clickText("Сохранить");
    await until(
      `window.goga.readProjectDocument('fixture',{kind:'workflow',name:'acme:spec'}).then(d=>d.exists&&d.text===${JSON.stringify(draft)})`,
    );
    const savedPath = path.join(meta.project, ".goga/workflows/acme:spec.yml");
    assert.deepEqual(fs.readFileSync(savedPath), Buffer.from(draft));
    assert.deepEqual(
      treeSnapshot().filter((e) => e[0] !== ".goga/workflows/acme:spec.yml"),
      baseline,
    );
    report.checks.push(
      "Create keeps draft and editor only in memory; reopening excludes draft alias and preserves source; only explicit Save creates exact acme:spec.yml raw Unicode/Jinja bytes; every pre-existing file/symlink/directory unchanged",
    );
    const refresh = async (newMode) => {
      mode = newMode;
      await clickText("Конфигурация");
      await clickText("Рабочие процессы");
      await until(`!!${input}`);
      await name("");
    };
    await refresh("empty");
    await until(
      "document.querySelector('.workflow-name-hint').textContent.includes('Нет доступных')",
    );
    await name("empty-fallback");
    assert.equal(await ev(`${input}.value`), "empty-fallback");
    assert.equal(
      await ev("document.querySelector('[role=listbox]')===null"),
      true,
    );
    await refresh("error");
    await until(
      "document.querySelector('.workflow-name-hint').textContent.includes('недоступны')",
    );
    await name("error-fallback");
    assert.equal(await ev(`${input}.value`), "error-fallback");
    delay = 500;
    await refresh("catalog");
    await name("typed-while-loading");
    await until(
      "!document.querySelector('.workflow-name-hint').textContent.includes('Загружаем')",
    );
    assert.equal(await ev(`${input}.value`), "typed-while-loading");
    report.checks.push(
      "Native production UI empty/error fallback keeps manual editing; delayed catalog response preserves text entered while loading",
    );
    const waitCall = async (count) => {
      for (let i = 0; i < 200; i++) {
        if (controlledCatalogCalls.length > count) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw Error("Transport did not start");
    };
    let count = controlledCatalogCalls.length;
    await ev(
      "window.__staleSettings=window.goga.listWorkflowSuggestions('fixture').then(()=>({rejected:false}),e=>({rejected:true}));void 0",
    );
    await waitCall(count);
    const changedSettings = await ev(
      "window.goga.readProjectSettings('fixture')",
    );
    await ev(
      `window.goga.saveProjectSettings('fixture',${JSON.stringify({ ...settingsValue, env: [...settingsValue.env, { key: "SECOND_FIXTURE", value: "new", secret: false, runtime: false }] })},${JSON.stringify(changedSettings.version)}).then(()=>true)`,
    );
    assert.equal((await ev("window.__staleSettings")).rejected, true);
    count = controlledCatalogCalls.length;
    await ev(
      "window.__staleDocument=window.goga.listWorkflowSuggestions('fixture').then(()=>({rejected:false}),e=>({rejected:true}));void 0",
    );
    await waitCall(count);
    const savedDoc = await ev(
      "window.goga.readProjectDocument('fixture',{kind:'workflow',name:'acme:spec'})",
    );
    await ev(
      `window.goga.saveProjectDocument('fixture',{kind:'workflow',name:'acme:spec'},${JSON.stringify(draft)},${JSON.stringify(savedDoc.version)}).then(()=>true)`,
    );
    assert.equal((await ev("window.__staleDocument")).rejected, true);
    delay = 0;
    assert.deepEqual(fs.readFileSync(savedPath), Buffer.from(draft));
    assert.deepEqual(
      treeSnapshot().filter((e) => e[0] !== ".goga/workflows/acme:spec.yml"),
      baseline,
    );
    assert(controlledCatalogCalls.length > 0);
    assert(
      controlledCatalogCalls.every(
        (c) =>
          c.executableMatched &&
          c.cwdMatched &&
          c.savedEnvMatched &&
          c.isolatedHomeMatched &&
          c.noShell,
      ),
    );
    report.checks.push(
      "Production IPC in-flight catalogs reject after saved settings or project-document save; exact scoped argv/executable/cwd and saved env verified only as booleans; no real command execution",
    );
    assert.equal(win.isVisible(), false);
    assert.deepEqual(blockedSpawns, []);
    report.cspViolations = await ev("window.__cspViolations");
    report.zeroCSP = report.cspViolations.length === 0;
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
    report.warnings = report.zeroCSP
      ? []
      : [
          "Native editor character input triggered blocked inline styles. CSP unchanged; zero-CSP not claimed.",
        ];
    report.status = report.zeroCSP ? "pass" : "functional-pass-with-warning";
    report.limitations = [
      "Catalog process transport is controlled; no real Goga executable was invoked.",
      "IME composition uses renderer CompositionEvents, not a native OS IME.",
      "Hidden-window focus uses DOM focus/focusin, name setup uses DOM input events; arrows/Enter/Escape/Tab and editor text use native Electron input events.",
      "Project switching / renderer settings-epoch unit coverage is not claimed as native coverage.",
    ];
    assert.equal(report.visibleWindows, 0);
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
    projectSource,
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
  timeout: 100000,
});
fs.writeFileSync(path.join(root, "stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(root, "stderr.log"), result.stderr ?? "");
console.log(result.stdout ?? "");
console.error(result.stderr ?? "");
console.log("fixture:", root);
console.log(
  "harness-process:",
  JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  }),
);
const reportFile = path.join(root, "result.json");
const passed =
  fs.existsSync(reportFile) &&
  JSON.parse(fs.readFileSync(reportFile, "utf8")).ok === true;
process.exitCode = result.status === 0 && passed ? 0 : 1;
