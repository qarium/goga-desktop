// Executes production main/preload/renderer from the signed ASAR in an isolated,
// hidden Electron harness. No real home, project, clipboard, or pipeline is used.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import electron from "electron";
const bundle = path.resolve(
  process.argv[2] ?? "release-pipelines/mac-arm64/Goga Desktop.app",
);
const archive = path.join(bundle, "Contents/Resources/app.asar");
if (!fs.existsSync(archive)) throw Error("Packaged ASAR missing");
const root = fs.mkdtempSync("/private/tmp/goga-pipeline-smoke-");
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
      { id: "fixture", name: "Pipeline acceptance", path: project },
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
    await ev(
      `window.__styleCalls=[];const originalSetAttribute=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if(name==='style')window.__styleCalls.push({tag:this.tagName,className:this.className,value,phase:window.__testPhase,stack:new Error().stack});return originalSetAttribute.call(this,name,value)};void 0`,
    );
    assert.equal(
      await ev("typeof window.goga.listProjectPipelines"),
      "function",
      "Project pipeline IPC catalog must be exposed",
    );
    const raw =
      "\ufeff# Точный исходник 🙂\r\nname: Проверка\r\ndescription: Пример\r\nunknown: true\r\n---\r\n- name: check\r\n  title: Проверка\r\n  script: echo never-execute\r\n";
    const target = { kind: "pipeline", name: "шаблон" };
    assert.deepEqual(await ev("window.goga.listProjectPipelines('ipc')"), []);
    const original = await ev(
      `window.goga.readProjectDocument('ipc',${JSON.stringify(target)})`,
    );
    assert.equal(original.exists, false);
    assert.equal(fs.existsSync(path.join(root, "ipc-project/.goga")), false);
    const saved = await ev(
      `window.goga.saveProjectDocument('ipc',${JSON.stringify(target)},${JSON.stringify(raw)},${JSON.stringify(original.version)})`,
    );
    assert.equal(saved.text, raw);
    const file = path.join(root, "ipc-project/.goga/pipelines/шаблон.yml");
    assert.deepEqual(fs.readFileSync(file), Buffer.from(raw));
    assert(
      (await ev("window.goga.listProjectPipelines('ipc')")).some(
        (x) => x.name === "шаблон" && x.editable,
      ),
    );
    fs.writeFileSync(file, "# external\n");
    assert(
      await ev(
        `window.goga.saveProjectDocument('ipc',${JSON.stringify(target)},'keep draft',${JSON.stringify(saved.version)}).then(()=>false,()=>true)`,
      ),
    );
    assert.equal(fs.readFileSync(file, "utf8"), "# external\n");
    for (const name of ["../escape", "/absolute", "a/b", "-option", "a\\b"]) {
      assert(
        await ev(
          `window.goga.readProjectDocument('ipc',{kind:'pipeline',name:${JSON.stringify(name)}}).then(()=>false,()=>true)`,
        ),
      );
    }
    report.checks.push(
      "Production IPC: empty catalog and missing read create nothing; explicit save creates dirs and exact BOM/CRLF/Unicode/header-separator-body bytes; catalog refresh; external conflicts and unsafe targets rejected",
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
      const contextPath = await ev(
        "document.querySelector('.editor-pane .context-path')?.textContent ?? null",
      );
      if (contextPath !== null) {
        const expectedPath = await ev(
          "document.querySelector('button.file-row.selected')?.getAttribute('aria-label')?.slice(5)",
        );
        assert.equal(
          contextPath,
          expectedPath,
          name + " exact project-relative context path",
        );
        assert(
          !contextPath.includes(meta.project),
          name + " no absolute project path",
        );
      }
      const spacing = await ev(`(()=>{
        const controls=document.querySelector('.tool-controls');
        const next=controls.nextElementSibling;
        const a=controls.getBoundingClientRect(),b=next.getBoundingClientRect();
        const detail=document.querySelector('.tools-detail');
        const children=detail?[...detail.children]:[];
        const columns=children.map(e=>e.getBoundingClientRect());
        const overflow=[controls,next,detail,...children].filter(Boolean).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className);
        return {gap:b.top-a.bottom,detailPresent:!!detail,
          treeCount:document.querySelectorAll('.tree-pane,.file-tree').length,
          emptyCards:document.querySelectorAll('.empty-file').length,
          chooseCount:[...document.querySelectorAll('h3')].filter(e=>/^Выберите (конвейер|рабочий процесс)$/.test(e.textContent)).length,
          columnsAligned:!detail||Math.abs(columns[0].top-columns[1].top)<1,
          columnsNonOverlapping:!detail||columns[0].right<=columns[1].left,overflow};
      })()`);
      report.screenshots.push({
        file,
        width,
        height,
        layout,
        reachable,
        spacing,
        contextPath,
      });
      assert(
        spacing.gap >= 24 && spacing.gap <= 25,
        name + " toolbar-content gap must be 24px, actual " + spacing.gap,
      );
      const tabs = await ev(`(()=>{
        const nav=document.querySelector('nav[aria-label="Разделы настроек проекта"]');
        return [...nav.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom,visible:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,unclipped:e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1}});
      })()`);
      assert.deepEqual(
        tabs.map((t) => t.text),
        [
          "Запуск",
          "Конфигурация",
          "Инструменты",
          "Рабочие процессы",
          "Конвейеры",
        ],
      );
      assert(
        tabs.every((t) => t.visible && t.unclipped),
        name + " all five translated tabs fully visible",
      );
      assert(
        tabs.every(
          (t, i) =>
            i === 0 ||
            tabs[i - 1].right <= t.left ||
            tabs[i - 1].bottom <= t.top,
        ),
        name + " tabs do not overlap",
      );
      report.screenshots.at(-1).tabs = tabs;
      const emptyLayout = /^(pipeline|workflow)-(empty|create)$/.test(name);
      assert.equal(
        spacing.detailPresent,
        !emptyLayout,
        name + " detail visibility",
      );
      if (emptyLayout) {
        assert.equal(spacing.treeCount, 0, name + " no empty tree");
        assert.equal(spacing.emptyCards, 1, name + " exactly one empty card");
        assert.equal(spacing.chooseCount, 0, name + " no choose placeholder");
      }
      assert(spacing.columnsAligned, name + " column tops must align");
      assert(spacing.columnsNonOverlapping, name + " columns must not overlap");
      assert.deepEqual(
        spacing.overflow,
        [],
        name + " pipeline horizontal overflow",
      );
      assert(
        reachable.every((item) => item.visible),
        name + " controls unreachable",
      );
    };
    const visibleEditorText = () => ev(`(${editor})?.textContent??''`);
    await ev("document.querySelector('.project-settings-action').click()");
    await until(
      "!!document.querySelector('nav[aria-label=\"Разделы настроек проекта\"]')",
    );
    await clickText("Конвейеры");
    await until(
      "[...document.querySelectorAll('button')].some(e=>e.textContent.trim()==='Создать конвейер')",
    );
    assert.equal(
      fs.existsSync(path.join(meta.project, ".goga/pipelines")),
      false,
    );
    await shot("pipeline-empty", 1320, 900);
    await shot("pipeline-empty", 920, 700);
    await clickText("Создать конвейер");
    await setInput("Имя конвейера", "review:nightly");
    await shot("pipeline-create", 1320, 900);
    await shot("pipeline-create", 920, 700);
    await clickText("Создать черновик");
    await until(`!!(${editor})`);
    const draft =
      "# Pipeline source\nname: Nightly\ndescription: Synthetic only\n---\nbuild:\n  title: Build\n  prompt: Keep unknown fields\n";
    await replaceYAML(draft);
    assert.equal(
      fs.existsSync(path.join(meta.project, ".goga/pipelines")),
      false,
    );
    await clickText("Конфигурация");
    await clickText("Конвейеры");
    await until(`(${editor})?.textContent.includes('Pipeline source')`);
    await clickText("← Назад");
    await ev("document.querySelector('.project-settings-action').click()");
    await clickText("Конвейеры");
    await until(`(${editor})?.textContent.includes('Pipeline source')`);
    assert.equal(
      fs.existsSync(path.join(meta.project, ".goga/pipelines")),
      false,
    );
    report.syntaxColors = await ev(
      `(()=>{const root=(${editor}).getRootNode();return Object.fromEntries(['key','comment'].map(kind=>{const e=root.querySelector('.yaml-'+kind);return [kind,e?getComputedStyle(e).color:null]}))})()`,
    );
    assert.deepEqual(report.syntaxColors, {
      key: "rgb(141, 201, 255)",
      comment: "rgb(135, 154, 179)",
    });
    await shot("pipeline-editor", 1320, 900);
    await shot("pipeline-editor", 920, 700);
    await clickText("Сохранить");
    await until(
      `window.goga.readProjectDocument('fixture',{kind:'pipeline',name:'review:nightly'}).then(d=>d.exists&&d.text===${JSON.stringify(draft)})`,
    );
    assert.equal(
      fs.readFileSync(
        path.join(meta.project, ".goga/pipelines/review:nightly.yml"),
        "utf8",
      ),
      draft,
    );
    report.checks.push(
      "Native UI creation and two-segment YAML input, draft survives tabs and Back; no pipeline directory before Save; explicit Save exact source; layout at two sizes",
    );
    const rawTarget = { kind: "pipeline", name: "raw:phases" };
    const rawMissing = await ev(
      `window.goga.readProjectDocument('fixture',${JSON.stringify(rawTarget)})`,
    );
    await ev(
      `window.goga.saveProjectDocument('fixture',${JSON.stringify(rawTarget)},${JSON.stringify(raw)},${JSON.stringify(rawMissing.version)})`,
    );
    await clickText("Конфигурация");
    await clickText("Конвейеры");
    await until(
      `!!document.querySelector('[aria-label="Файл .goga/pipelines/raw:phases.yml"]')`,
    );
    await clickLabel("Файл .goga/pipelines/raw:phases.yml");
    await clickText("Открыть редактор");
    await until(`!!(${editor})`);
    await clickText("Сохранить");
    await until(`!!document.querySelector('.editor-pane .success')`);
    assert.deepEqual(
      fs.readFileSync(
        path.join(meta.project, ".goga/pipelines/raw:phases.yml"),
      ),
      Buffer.from(raw),
    );
    report.checks.push(
      "Actual IPC catalog refresh + explicit editor Save preserves BOM/CRLF/Unicode header/---/phases bytes without rendering or execution",
    );
    await clickLabel("Файл .goga/pipelines/review:nightly.yml");
    await until(`(${editor})?.textContent.includes('Pipeline source')`);
    await shot("pipeline-existing", 1320, 900);
    await shot("pipeline-existing", 920, 700);
    await clickText("Создать конвейер");
    await shot("pipeline-existing-create", 1320, 900);
    await shot("pipeline-existing-create", 920, 700);
    await replaceYAML("# Keep after conflict\nprompt: pending\n");
    fs.writeFileSync(
      path.join(meta.project, ".goga/pipelines/review:nightly.yml"),
      "# External change\n",
    );
    await clickText("Сохранить");
    await until(
      "[...document.querySelectorAll('[role=alert]')].some(e=>e.getClientRects().length)",
    );
    assert((await visibleEditorText()).includes("Keep after conflict"));
    assert.equal(
      fs.readFileSync(
        path.join(meta.project, ".goga/pipelines/review:nightly.yml"),
        "utf8",
      ),
      "# External change\n",
    );
    await shot("pipeline-conflict", 1320, 900);
    report.checks.push(
      "Native UI external conflict retains draft text and external disk contents",
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
  JSON.stringify({
    root,
    home,
    project,
    bundle,
    archive,
    projectSource,
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
