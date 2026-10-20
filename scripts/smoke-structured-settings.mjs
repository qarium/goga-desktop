// Executes production main/preload/renderer from the signed ASAR in an isolated,
// hidden Electron harness. No real home, project, clipboard, or pipeline is used.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import electron from "electron";
const bundle = path.resolve(
  process.argv[2] ?? "release-structured-settings/mac-arm64/Goga Desktop.app",
);
const archive = path.join(bundle, "Contents/Resources/app.asar");
if (!fs.existsSync(archive)) throw Error("Packaged ASAR missing");
const root = fs.mkdtempSync("/private/tmp/goga-structured-smoke-");
const home = path.join(root, "home"),
  project = path.join(root, "project");
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
    projects: [{ id: "fixture", name: "Settings acceptance", path: project }],
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
    assert(report.version.includes("0.1.12"));
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
    await ev(
      `window.__styleCalls=[];const originalSetAttribute=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if(name==='style')window.__styleCalls.push({tag:this.tagName,className:this.className,value,phase:window.__testPhase,stack:new Error().stack});return originalSetAttribute.call(this,name,value)};void 0`,
    );
    const tools = await ev("window.goga.listProjectTools('fixture')");
    assert(tools.some((t) => t.name === "review-kit"));
    assert(tools.find((t) => t.name === "empty-kit").entries.length === 0);
    report.checks.push(
      "Packaged production IPC lists real temporary tools and empty directories",
    );
    const target = {
      kind: "tool",
      tool: "review-kit",
      path: "environments/local/config.yml",
    };
    const original = await ev(
      `window.goga.readProjectDocument('fixture',${JSON.stringify(target)})`,
    );
    const replacement =
      "# Native IPC roundtrip 🙂\r\nmode: local\nunknown: true\r\n";
    const saved = await ev(
      `window.goga.saveProjectDocument('fixture',${JSON.stringify(target)},${JSON.stringify(replacement)},${JSON.stringify(original.version)})`,
    );
    assert.equal(saved.text, replacement);
    assert.equal(
      fs.readFileSync(
        path.join(
          meta.project,
          ".goga/tools/review-kit/environments/local/config.yml",
        ),
        "utf8",
      ),
      replacement,
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          meta.project,
          ".goga/tools/review-kit/environments/ci/config.yml",
        ),
        "utf8",
      ),
      "# ci\nmode: ci\n",
    );
    fs.writeFileSync(
      path.join(
        meta.project,
        ".goga/tools/review-kit/environments/local/config.yml",
      ),
      "external: true\n",
    );
    const conflict = await ev(
      `window.goga.saveProjectDocument('fixture',${JSON.stringify(target)},'value: false',${JSON.stringify(saved.version)}).then(()=>false,()=>true)`,
    );
    assert(conflict);
    assert.equal(
      fs.readFileSync(
        path.join(
          meta.project,
          ".goga/tools/review-kit/environments/local/config.yml",
        ),
        "utf8",
      ),
      "external: true\n",
    );
    report.checks.push(
      "Exact mixed-newline Unicode tool save, duplicate basename isolation and external conflict through production IPC",
    );
    for (const bad of [
      { kind: "tool", tool: "../x", path: "config.yml" },
      { kind: "tool", tool: "review-kit", path: "../../config.yml" },
      { kind: "tool", tool: "review-kit", path: "image.bin" },
    ])
      assert(
        await ev(
          `window.goga.readProjectDocument('fixture',${JSON.stringify(bad)}).then(()=>false,()=>true)`,
        ),
      );
    report.checks.push(
      "Production IPC rejects traversal and unsupported file reads",
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
    const shot = async (name, width, height) => {
      win.setContentSize(width, height);
      await settle();
      await ev(
        `(()=>{const area=document.querySelector('.scroll-area');if(area)area.scrollTop=0;const target=${JSON.stringify(name)}.includes('launch-switches')?document.querySelector('.project-env-row'):${JSON.stringify(name)}.includes('tools-editor')?document.querySelector('.editor-pane'):null;target?.scrollIntoView({block:'center'})})()`,
      );
      await settle();
      await new Promise((r) => setTimeout(r, 150));
      const layout = await ev(
        `(()=>{const selectors=['.app-shell','.sidebar','.project-bar','.scroll-area','.settings-panel','.project-settings-panel'];return {overflow:selectors.filter(s=>{const e=document.querySelector(s);return e&&e.getClientRects().length&&e.scrollWidth>e.clientWidth+1}),footer:(()=>{const e=document.querySelector('.sidebar-footer'),r=e.getBoundingClientRect();return {visible:r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,font:parseFloat(getComputedStyle(e).fontSize)}})()}})()`,
      );
      assert.deepEqual(layout.overflow, [], name + " horizontal overflow");
      assert(
        layout.footer.visible && layout.footer.font >= 10,
        name + " footer",
      );
      const file = `${name}-${width}x${height}.png`;
      fs.writeFileSync(path.join(root, file), (await wc.capturePage()).toPNG());
      const reachable = await ev(
        `(()=>{const area=document.querySelector('.scroll-area'),top=area?.scrollTop;const result=[...document.querySelectorAll('.savebar button,.form-actions button,[role=switch]')].filter(e=>e.getClientRects().length).map(e=>{e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {label:e.getAttribute('aria-label')??e.textContent,rect:{top:r.top,bottom:r.bottom,left:r.left,right:r.right},visible:r.top>=-1&&r.bottom<=innerHeight+1&&r.left>=-1&&r.right<=innerWidth+1}});if(area)area.scrollTop=top;return result})()`,
      );
      report.screenshots.push({ file, width, height, layout, reachable });
      assert(
        reachable.every((item) => item.visible),
        name + " controls unreachable",
      );
    };
    const selectTool = async (name) => {
      await ev(
        `(()=>{const e=document.querySelector('.tool-controls select');e.value=${JSON.stringify(name)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      );
      await settle();
    };
    const visibleEditorText = () => ev(`(${editor})?.textContent??''`);
    await ev("document.querySelector('.project-settings-action').click()");
    await until(
      "!!document.querySelector('nav[aria-label=\"Разделы настроек проекта\"]')",
    );
    await until(
      "[...document.querySelectorAll('button')].some(e=>e.textContent.includes('Добавить переменную'))",
    );
    await clickText("＋ Добавить переменную");
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\"Передавать в runtime 1\"]').checked",
      ),
      false,
    );
    await setInput("Имя 1", "TOKEN");
    await setInput("Значение 1", "fixture-value");
    await clickLabel("Скрывать значение 1");
    assert.equal(
      await ev("document.querySelector('[aria-label=\"Значение 1\"]').type"),
      "password",
    );
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\"Передавать в runtime 1\"]').checked",
      ),
      false,
    );
    await clickLabel("Передавать в runtime 1");
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\"Скрывать значение 1\"]').checked",
      ),
      true,
    );
    await shot("launch-switches", 1320, 900);
    await shot("launch-switches", 920, 700);
    await clickText("Сохранить");
    await until(
      "window.goga.readProjectSettings('fixture').then(d=>d.value.env[0]?.runtime===true)",
    );
    report.checks.push(
      "Native independent masking/runtime switches; OFF default; launch settings save via real production IPC",
    );
    await clickText("Конфигурация");
    assert.equal(await ev(`!!(${editor})`), false);
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    const projectDraft = "# Unsaved project draft\ncustom: true\n";
    await replaceYAML(projectDraft);
    await clickText("Инструменты");
    await until("!!document.querySelector('.tool-controls select')");
    await selectTool("review-kit");
    await until(
      "!!document.querySelector('[aria-label=\"Папка environments\"]')",
    );
    assert.equal(
      await ev(
        "[...document.querySelectorAll('[aria-label^=\"Папка \"]')].every(e=>e.getAttribute('aria-expanded')==='false')",
      ),
      true,
    );
    await shot("tools-collapsed", 1320, 900);
    await shot("tools-collapsed", 920, 700);
    await clickLabel("Файл config.yml");
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    report.paletteBefore = await ev(
      `(()=>{const root=(${editor}).getRootNode();return Object.fromEntries(['key','string','number','boolean','comment'].map(kind=>{const e=[...root.querySelectorAll('.yaml-'+kind)].find(e=>kind!=='string'||!e.closest('.yaml-boolean,.yaml-number'));return [kind,e?getComputedStyle(e).color:null]}))})()`,
    );
    assert.deepEqual(report.paletteBefore, {
      key: "rgb(141, 201, 255)",
      string: "rgb(184, 217, 155)",
      number: "rgb(239, 184, 140)",
      boolean: "rgb(201, 175, 245)",
      comment: "rgb(135, 154, 179)",
    });
    const rootDraft = "# Root draft\nflag: true\n";
    await replaceYAML(rootDraft);
    await clickLabel("Папка environments");
    await clickLabel("Папка environments/local");
    await clickLabel("Файл environments/local/config.yml");
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    const localDraft = "# Local native draft\nmode: local\n";
    await replaceYAML(localDraft);
    await clickLabel("Папка environments/ci");
    await clickLabel("Файл environments/ci/config.yml");
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    assert((await visibleEditorText()).includes("mode: ci"));
    await clickLabel("Файл environments/local/config.yml");
    await until(`(${editor})?.textContent.includes('Local native draft')`);
    await clickText("Сохранить");
    await until(
      `window.goga.readProjectDocument('fixture',${JSON.stringify(target)}).then(d=>d.text===${JSON.stringify(localDraft)})`,
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          meta.project,
          ".goga/tools/review-kit/environments/local/config.yml",
        ),
        "utf8",
      ),
      localDraft,
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          meta.project,
          ".goga/tools/review-kit/environments/ci/config.yml",
        ),
        "utf8",
      ),
      "# ci\nmode: ci\n",
    );
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\"Папка environments\"]').getAttribute('aria-expanded')",
      ),
      "true",
    );
    report.paletteAfter = await ev(
      `(()=>{const root=(${editor}).getRootNode();return Object.fromEntries(['key','string','comment'].map(kind=>{const e=[...root.querySelectorAll('.yaml-'+kind)].find(e=>kind!=='string'||!e.closest('.yaml-boolean,.yaml-number'));return [kind,e?getComputedStyle(e).color:null]}))})()`,
    );
    for (const [kind, color] of Object.entries(report.paletteAfter))
      assert.equal(color, report.paletteBefore[kind]);
    await shot("tools-editor", 1320, 900);
    await shot("tools-editor", 920, 700);
    const conflictDraft = "# Keep after conflict\nmode: draft\n";
    await replaceYAML(conflictDraft);
    fs.writeFileSync(
      path.join(
        meta.project,
        ".goga/tools/review-kit/environments/local/config.yml",
      ),
      "external: changed\n",
    );
    await clickText("Сохранить");
    await until(
      "[...document.querySelectorAll('[role=alert]')].some(e=>e.getClientRects().length)",
    );
    assert((await visibleEditorText()).includes("Keep after conflict"));
    assert.equal(
      fs.readFileSync(
        path.join(
          meta.project,
          ".goga/tools/review-kit/environments/local/config.yml",
        ),
        "utf8",
      ),
      "external: changed\n",
    );
    await clickLabel("Файл config.yml");
    await until(`(${editor})?.textContent.includes('Root draft')`);
    await selectTool("docs-kit");
    await selectTool("review-kit");
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\"Папка environments\"]').getAttribute('aria-expanded')",
      ),
      "true",
    );
    await clickText("Конфигурация");
    await until(`(${editor})?.textContent.includes('Unsaved project draft')`);
    assert.equal(
      fs.readFileSync(path.join(meta.project, ".goga/config.yml"), "utf8"),
      meta.projectSource,
    );
    await clickText("← Назад");
    await ev("document.querySelector('.project-settings-action').click()");
    await clickText("Конфигурация");
    await until(`(${editor})?.textContent.includes('Unsaved project draft')`);
    report.checks.push(
      "Collapsed nested tool tree, stable manual expansion, full-path duplicate-basename drafts, exact selected-file UI save, conflict preserves draft/disk, project draft survives Back",
    );
    await ev("document.querySelector('.settings-button').click()");
    await until(
      "!!document.querySelector('nav[aria-label=\"Разделы общих настроек\"]')",
    );
    assert.equal(await ev(`!!(${editor})`), false);
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    await shot("general-config", 1320, 900);
    await shot("general-config", 920, 700);
    await replaceYAML("# Home draft\ncustom: false\n");
    await clickText("Профили");
    await until(
      "[...document.querySelectorAll('.item-list button')].some(e=>e.textContent==='personal')",
    );
    await clickText("personal");
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    assert((await visibleEditorText()).includes("agent: codex"));
    await clickText("＋ Новый профиль");
    await setInput("Имя профиля", "native-profile");
    await clickText("Создать черновик");
    assert.equal(
      fs.existsSync(path.join(meta.home, ".goga/profiles/native-profile.yml")),
      false,
    );
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    await replaceYAML("# Native personal profile\nagent: codex\n");
    await clickText("Сохранить");
    await until(
      "window.goga.listSettings().then(m=>m.profiles.includes('native-profile'))",
    );
    assert.equal(
      fs.readFileSync(
        path.join(meta.home, ".goga/profiles/native-profile.yml"),
        "utf8",
      ),
      "# Native personal profile\nagent: codex\n",
    );
    await shot("personal-profiles", 1320, 900);
    await shot("personal-profiles", 920, 700);
    report.checks.push(
      "Personal profile creation is draft-only until explicit save; saved via original production home-settings API",
    );
    await clickText("Конфигурация");
    await until(`(${editor})?.textContent.includes('Home draft')`);
    assert.equal(
      fs.readFileSync(path.join(meta.home, ".goga/config.yml"), "utf8"),
      "# Домашняя конфигурация\ncustom: true\n",
    );
    report.checks.push(
      "Separate personal settings tabs, explicit reveal, unsaved home draft survives tab navigation without touching disk",
    );
    assert.equal(win.isVisible(), false);
    assert.deepEqual(blockedSpawns, []);
    report.styleCalls = await ev("window.__styleCalls");
    report.cspViolations = await ev("window.__cspViolations");
    report.zeroCSP = report.cspViolations.length === 0;
    // Known observed Chromium contenteditable behavior, not a policy exemption:
    // native character input attempts transient inline styles, which CSP blocks.
    // No JavaScript style-attribute writes were observed; exact text and token
    // colors are separately checked. Keep this warning explicit, never claim zero CSP.
    assert.deepEqual(report.styleCalls, []);
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
          "Native character input triggered " +
            report.cspViolations.length +
            " blocked inline style attributes; zero-CSP acceptance NOT passed. Text persistence and computed syntax colors passed; CSP unchanged.",
        ];
    report.status = report.zeroCSP ? "pass" : "functional-pass-with-warning";
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
  JSON.stringify({ root, home, project, bundle, archive, projectSource }),
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
const reportFile = path.join(root, "result.json");
const passed =
  fs.existsSync(reportFile) &&
  JSON.parse(fs.readFileSync(reportFile, "utf8")).ok === true;
process.exitCode = result.status === 0 && passed ? 0 : 1;
