// Explicitly invoked only with approval: real renderer, synthetic bridge/files,
// isolated HOME/profile; no production host, Git, shell, clipboard or network.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = fs.mkdtempSync("/private/tmp/goga-git-conflicts-ui-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));

// Source positions are constructed from independently assembled strings, not
// guessed by matching marker text; the working file deliberately differs.
function conflictFixture(request) {
  const { scope, path: file, revision } = request;
  const prefix = "// " + file + "\r\n" + "// unchanged header\r\n";
  const middle = Array.from(
    { length: 65 },
    (_, i) => `const shared${i} = ${i};\r\n`,
  ).join("");
  const tail =
    Array.from({ length: 65 }, (_, i) => `const tail${i} = ${i};\r\n`).join(
      "",
    ) + "// no final newline";
  const a = ["const mode = 'local';\r\n", "const retry = 3;\r\n"];
  const b = ["const mode = 'remote';\r\n", "const retry = 5;\r\n"];
  const base = ["const mode = 'base';\r\n", "const retry = 1;\r\n"];
  const marker = (i) =>
    `<<<<<<< current\r\n${a[i]}=======\r\n${b[i]}>>>>>>> incoming\r\n`;
  const text = prefix + marker(0) + middle + marker(1) + tail;
  const chunks = [prefix, prefix + marker(0) + middle];
  const part = (s, i) => ({
    text: s[i],
    range: {
      from:
        i === 0 ? prefix.length : prefix.length + s[0].length + middle.length,
      to:
        (i === 0
          ? prefix.length
          : prefix.length + s[0].length + middle.length) + s[i].length,
    },
  });
  const source = (s, oid) => ({
    kind: "text",
    mode: "100644",
    oid: oid.repeat(40),
    text: prefix + s[0] + middle + s[1] + tail,
  });
  return {
    scope,
    path: file,
    revision,
    fingerprint: "c".repeat(64),
    base: source(base, "a"),
    current: source(a, "b"),
    incoming: source(b, "c"),
    working: {
      kind: "text",
      text: "// USER EDIT — preserve until explicit reconstruction\r\n" + text,
    },
    generated: {
      kind: "text",
      text,
      requiresExplicitReconstruction: true,
      blocks: chunks.map((s, i) => ({
        id: "h" + (i + 1),
        resultRange: { from: s.length, to: s.length + marker(i).length },
        base: part(base, i),
        current: part(a, i),
        incoming: part(b, i),
      })),
    },
  };
}

const renderer = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {undo,redo,undoDepth} from '@codemirror/commands';
import {GitWorkspace} from ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.tsx"))};
import {RetainedViews} from ${JSON.stringify(path.resolve("src/renderer/RetainedViews.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
const makeDocument = ${conflictFixture.toString()};
const fixture = window.fixture = { reads:[], prepares:[], executes:[], changed:[], closed:0, saved:[], mode:'partial', pendingPreview:null, scope:'fixture-p', overlay:false };
const scopes = {
 primary:'fixture-p', other:'fixture-q',
 topic:{projectId:'fixture-p',year:'2026',topic:'topic-alpha',branch:'topic-alpha',contextId:'ctx-'+ 'c'.repeat(64),revision:'11111111-1111-4111-8111-111111111111'}
};
const revision='a'.repeat(64), paths=['src/settings.ts','src/options.ts'];
const scopeId = scope => JSON.stringify(scope);
window.goga = {
 readGitWorkspace: async scope => ({scope,root:'/synthetic/'+(typeof scope==='string'?scope:scope.topic),revision,head:'b'.repeat(40),branch:typeof scope==='string'?'main':scope.branch,upstream:null,ahead:0,behind:0,operation:'merge',files:paths.map(path=>({path,kind:fixture.saved.includes(scopeId(scope)+path)?'tracked':'conflict',indexStatus:'U',worktreeStatus:'U',submodule:false}))}),
 readGitConflict: async request => {fixture.reads.push(request);return makeDocument(request);},
 readGitDiff: async request => ({...request,staged:{kind:'patch',text:'@@ -1 +1 @@\\n-before\\n+saved'},unstaged:{kind:'empty',text:''}}),
 prepareGitConflictSave: async request => {fixture.prepares.push(request);fixture.pendingPreview=request;return {scope:request.scope,path:request.path,token:String(fixture.prepares.length).padStart(64,'0'),branch:typeof request.scope==='string'?'main':request.scope.branch,resolution:request.resolution.kind,bytes:new TextEncoder().encode(request.resolution.text??'').length,hooks:'disabled',canonicalization:'git-text-attributes',expiresAt:Date.now()+300000};},
 executeGitConflictSave: async token => {fixture.executes.push(token);const request=fixture.pendingPreview;if(fixture.mode==='transport')throw Error('SYNTHETIC LOST REPLY — no real write');const saved=fixture.mode==='saved';if(saved)fixture.saved.push(scopeId(request.scope)+request.path);return {scope:request.scope,path:request.path,status:saved?'saved':'partial',worktreePublished:true,indexPublished:saved,lockRetained:!saved,recoveryPath:'/synthetic/recovery',message:saved?'Тестовый файл сохранён':'Тестовая частичная запись',log:'SYNTHETIC ONLY — no user files or Git processes'};},
};
fixture.editor = label => [...document.querySelectorAll('.yaml-code-editor')].map(host=>host.shadowRoot?.querySelector('[aria-label="'+label+'"]')).filter(Boolean).map(node=>EditorView.findFromDOM(node))[0];
fixture.button = label => [...document.querySelectorAll('button')].find(node=>(node.getAttribute('aria-label')||node.textContent.trim())===label);
fixture.arrow = label => [...document.querySelectorAll('.yaml-code-editor')].flatMap(host=>[...host.shadowRoot.querySelectorAll('button')]).find(node=>node.getAttribute('aria-label')===label);
fixture.text = () => fixture.editor('Результат разрешения')?.state.doc.toString();
fixture.undo = () => undo(fixture.editor('Результат разрешения'));
fixture.redo = () => redo(fixture.editor('Результат разрешения'));
fixture.undoDepth = () => undoDepth(fixture.editor('Результат разрешения').state);
fixture.edit = text => {const view=fixture.editor('Результат разрешения');view.dispatch({changes:{from:0,insert:text},selection:{anchor:text.length}});};
function Fixture() {
 const [key,setKey]=useState('primary'),[collapsed,setCollapsed]=useState(false),[body,setBody]=useState(null),[open,setOpen]=useState(true);
 fixture.scope=scopes[key]; fixture.setKey=setKey; fixture.setCollapsed=setCollapsed; fixture.setOpen=setOpen;
 return <div className={'app-shell fixture-shell'+(collapsed?' sidebar-collapsed':'')}>
 <header className="titlebar"><span className="wordmark"><b>Goga</b><small>DESKTOP · изолированная проверка</small></span></header>
 <aside className="sidebar"><span className="eyebrow">Мой компьютер</span><p>Тестовый проект</p></aside>
 <main className="main-area"><div className="project-bar"><div className="project-heading"><span className="eyebrow">Мой компьютер / ПРОЕКТ</span><h1>Тестовый проект</h1></div><div className="project-heading-context">{key==='topic'?'topic-alpha':'Без топика'}</div><div className="project-actions">Запуски · 0</div></div>
 <nav className="tabs"><span className="fixture-tab">Проект</span><span className="fixture-tab">Терминал</span><span className="fixture-tab">Топики</span></nav>
 <div className="run-context"><span className="workspace-path">/synthetic/{key==='topic'?'topic-alpha':'project'}</span><div className="git-workspace-controls-host"><RetainedViews activeKey={key}><GitWorkspace scope={scopes[key]} open={open} bodyContainer={body} onOpen={()=>setOpen(true)} onClose={()=>{fixture.closed++;setOpen(false)}} onChanged={id=>fixture.changed.push(id)} onOverlayChange={(_,visible)=>{fixture.overlay=visible}} revision={0}/></RetainedViews></div></div>
 <div className="git-workspace-stage" ref={setBody}/></main></div>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
await build({
  stdin: { contents: renderer, loader: "tsx", resolveDir: process.cwd() },
  outfile: path.join(root, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
fs.appendFileSync(
  path.join(root, "renderer.css"),
  `
html,body,#root{height:100%;overflow:hidden}.fixture-tab{display:flex;align-items:center;padding:0 20px}.fixture-shell .sidebar p{color:var(--teal)}.fixture-shell.sidebar-collapsed .sidebar p{display:none}
`,
);
fs.writeFileSync(
  path.join(root, "index.html"),
  fs
    .readFileSync("index.html", "utf8")
    .replace(
      '<script type="module" src="/src/renderer/index.tsx"></script>',
      '<link rel="stylesheet" href="renderer.css"><script src="renderer.js"></script>',
    ),
);

async function nativeFixture() {
  const { app, BrowserWindow, session } = require("electron");
  const fs = require("node:fs"),
    path = require("node:path"),
    assert = require("node:assert/strict");
  app.setName("Goga isolated conflict editor test");
  for (const [key, dir] of [
    ["userData", "data"],
    ["sessionData", "session"],
    ["crashDumps", "crashes"],
  ])
    app.setPath(key, path.join(__dirname, dir));
  app.setAppLogsPath(path.join(__dirname, "logs"));
  const report = { ok: false, checks: [], screenshots: [], errors: [] };
  let win;
  const timeout = setTimeout(() => app.exit(2), 60000);
  try {
    await app.whenReady();
    app.dock?.hide();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_, done) => done({ cancel: true }),
    );
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") report.errors.push(event.message);
    });
    const ev = (script) => win.webContents.executeJavaScript(script);
    const settle = () =>
      ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const until = async (script) => {
      for (let i = 0; i < 200; i++) {
        if (await ev(script)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("DOM timeout: " + script);
    };
    const click = async (label) => {
      await until(`!!fixture.button(${JSON.stringify(label)})`);
      await ev(`fixture.button(${JSON.stringify(label)}).click()`);
      await settle();
    };
    const escape = async () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await settle();
    };
    const screenshot = async (name) => {
      const target = path.join(__dirname, name + ".png");
      fs.writeFileSync(target, (await win.webContents.capturePage()).toPNG());
      report.screenshots.push(target);
    };
    const buttonGeometry = async (label) => {
      const value = await ev(
        `(()=>{const e=fixture.button(${JSON.stringify(label)}),r=e.getBoundingClientRect(),at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,clickable:!!at&&(at===e||e.contains(at)),width:r.width,height:r.height};})()`,
      );
      assert.ok(
        value.inside &&
          value.clickable &&
          value.width > 24 &&
          value.height > 24,
        JSON.stringify({ label, ...value }),
      );
    };
    const select = async (file) => {
      await click(file);
      await until("!!fixture.editor('Результат разрешения')");
      await settle();
    };
    const reconstruct = async () => {
      await click("Восстановить блоки…");
      await click("Заменить черновик реконструкцией");
      await until("!!fixture.arrow('Блок 1: принять текущую')");
    };
    const paneLayout = async () => {
      const value = await ev(
        `(()=>{const labels=['Текущая версия','Результат разрешения','Входящая версия'];return labels.map(label=>{const v=fixture.editor(label),r=v.dom.getBoundingClientRect();return {label,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,containerBottom:v.dom.getRootNode().host.closest('.git-conflict-code').getBoundingClientRect().bottom,readOnly:v.state.readOnly};});})()`,
      );
      assert.equal(value.length, 3);
      assert.equal(value[0].readOnly, true);
      assert.equal(value[1].readOnly, false);
      assert.equal(value[2].readOnly, true);
      for (const r of value) {
        assert.ok(r.height > 90 && r.width > 120, JSON.stringify(value));
        assert.ok(r.bottom <= (await ev("innerHeight")), JSON.stringify(value));
        assert.ok(r.bottom <= r.containerBottom + 1, JSON.stringify(value));
      }
      assert.ok(
        value[0].right <= value[1].x + 1 && value[1].right <= value[2].x + 1,
        JSON.stringify(value),
      );
      assert.ok(
        Math.max(...value.map((r) => r.y)) -
          Math.min(...value.map((r) => r.y)) <
          3,
        JSON.stringify(value),
      );
      assert.equal(
        await ev("document.documentElement.scrollWidth>innerWidth+1"),
        false,
      );
      return value;
    };
    await win.loadFile(path.join(__dirname, "index.html"));
    for (const [width, height, name, key] of [
      [1280, 800, "wide", "primary"],
      [960, 640, "narrow", "topic"],
    ]) {
      win.setContentSize(width, height);
      await ev(
        `fixture.setKey(${JSON.stringify(key)});fixture.setOpen(true);fixture.setCollapsed(false)`,
      );
      await settle();
      await select("src/settings.ts");
      assert.ok((await ev("fixture.text()")).startsWith("// USER EDIT"));
      await click("Восстановить блоки…");
      await escape();
      assert.equal(await ev("fixture.closed"), 0);
      assert.ok((await ev("fixture.text()")).startsWith("// USER EDIT"));
      await reconstruct();
      await ev("fixture.edit('// outside edit\\r\\n')");
      await settle();
      const beforeArrow = await ev("fixture.text()");
      const selectionBeforeArrow = await ev(
        "fixture.editor('Результат разрешения').state.selection.main.anchor",
      );
      await ev("fixture.arrow('Блок 1: принять текущую').click()");
      await settle();
      const afterArrow = await ev("fixture.text()");
      assert.equal(
        await ev(
          "fixture.editor('Результат разрешения').state.selection.main.anchor",
        ),
        selectionBeforeArrow,
      );
      assert.ok(await ev("fixture.undoDepth()>=2"));
      assert.equal(await ev("fixture.undo()"), true);
      await settle();
      assert.equal(await ev("fixture.text()"), beforeArrow);
      assert.equal(await ev("fixture.undo()"), true);
      await settle();
      assert.ok(!(await ev("fixture.text()")).startsWith("// outside edit"));
      assert.equal(await ev("fixture.redo()"), true);
      await settle();
      assert.equal(await ev("fixture.text()"), beforeArrow);
      assert.equal(await ev("fixture.redo()"), true);
      await settle();
      assert.equal(await ev("fixture.text()"), afterArrow);
      // Undo metadata is deliberately conservative; reaffirm the first choice.
      await ev("fixture.arrow('Блок 1: принять текущую').click()");
      await settle();
      assert.ok((await ev("fixture.text()")).startsWith("// outside edit\r\n"));
      assert.ok(
        (await ev("fixture.text()")).includes("const mode = 'local';\r\n"),
      );
      await ev("fixture.editor('Входящая версия').scrollDOM.scrollTop=1350");
      await until("!!fixture.arrow('Блок 2: принять входящую')");
      await ev("fixture.arrow('Блок 2: принять входящую').click()");
      await settle();
      assert.ok((await ev("fixture.text()")).endsWith("// no final newline"));
      assert.equal((await ev("fixture.text()")).includes("<<<<<<<"), false);
      await ev("fixture.editor('Результат разрешения').scrollDOM.scrollTop=0");
      await settle();
      const layout = await paneLayout();
      await screenshot("conflict-" + name);
      await ev(
        "fixture.editor('Результат разрешения').scrollDOM.scrollTop=800",
      );
      await settle();
      await until(
        "fixture.editor('Текущая версия').scrollDOM.scrollTop>100&&fixture.editor('Входящая версия').scrollDOM.scrollTop>100",
      );
      await ev(
        "fixture.editor('Результат разрешения').scrollDOM.scrollTop=fixture.editor('Результат разрешения').scrollDOM.scrollHeight",
      );
      await settle();
      const endVisible = await ev(
        "(()=>{const v=fixture.editor('Результат разрешения'),last=v.contentDOM.lastElementChild.getBoundingClientRect(),box=v.dom.getRootNode().host.closest('.git-conflict-code').getBoundingClientRect();return last.bottom<=box.bottom+1;})()",
      );
      assert.equal(
        endVisible,
        true,
        "last line must remain inside the visible editor",
      );
      await ev(
        "fixture.editor('Результат разрешения').scrollDOM.scrollTop=0;fixture.setCollapsed(true)",
      );
      await settle();
      const collapsed = await paneLayout();
      assert.ok(collapsed[1].width > layout[1].width + 25);
      await screenshot("conflict-collapsed-" + name);
      const text = await ev("fixture.text()");
      await select("src/options.ts");
      assert.ok((await ev("fixture.text()")).startsWith("// USER EDIT"));
      await select("src/settings.ts");
      assert.equal(await ev("fixture.text()"), text);
      await ev("fixture.setKey('other')");
      await settle();
      await select("src/settings.ts");
      assert.ok((await ev("fixture.text()")).startsWith("// USER EDIT"));
      await ev(`fixture.setKey(${JSON.stringify(key)})`);
      await until("!!fixture.editor('Результат разрешения')");
      await settle();
      assert.equal(await ev("fixture.text()"), text);
      await ev("fixture.setOpen(false)");
      await settle();
      await ev("fixture.setOpen(true)");
      await until("!!fixture.editor('Результат разрешения')");
      await settle();
      assert.equal(await ev("fixture.text()"), text);
      await buttonGeometry("Сохранить файл…");
      await click("Сохранить файл…");
      await until("!!document.querySelector('dialog[open]')");
      await buttonGeometry("Записать файл и индекс");
      assert.equal(
        await ev("fixture.editor('Результат разрешения').state.readOnly"),
        true,
      );
      assert.equal(await ev("fixture.prepares.at(-1).resolution.text"), text);
      await screenshot("save-preview-" + name);
      await ev(
        `fixture.mode=${JSON.stringify(key === "topic" ? "saved" : "partial")}`,
      );
      await click("Записать файл и индекс");
      await until("!!fixture.button('Закрыть результат разрешения')");
      await buttonGeometry("Закрыть результат разрешения");
      await screenshot("save-result-" + name);
      await escape();
      await until("!document.querySelector('dialog[open]')");
      assert.equal(await ev("fixture.closed"), 0);
      if (key === "primary") {
        assert.equal(await ev("fixture.text()"), text);
        assert.equal(
          await ev("fixture.button('Сохранить файл…').disabled"),
          true,
        );
      }
      report.checks.push({
        width,
        height,
        layout,
        collapsed,
        exactText: true,
        hunkUndoRedo: true,
        linkedScroll: true,
        retainedAcrossFilesAndContexts: true,
        previewConfirmed: true,
        resultClosable: true,
      });
    }
    assert.equal(await ev("fixture.executes.length"), 2);
    assert.deepEqual(await ev("fixture.changed"), ["fixture-p"]);
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (error) {
    report.error = String(error.stack ?? error);
    if (win && !win.isDestroyed())
      fs.writeFileSync(
        path.join(__dirname, "failure.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
  } finally {
    fs.writeFileSync(
      path.join(__dirname, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
    clearTimeout(timeout);
    win?.destroy();
    app.exit(report.ok ? 0 : 1);
  }
}
fs.writeFileSync(
  path.join(root, "main.cjs"),
  `(${nativeFixture.toString()})();`,
);
const run = spawnSync(electron, [path.join(root, "main.cjs")], {
  env: {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    LANG: "en_US.UTF-8",
  },
  encoding: "utf8",
  timeout: 75000,
});
fs.writeFileSync(path.join(root, "stdout.log"), run.stdout ?? "");
fs.writeFileSync(path.join(root, "stderr.log"), run.stderr ?? "");
console.log(run.stdout ?? "");
console.error(run.stderr ?? "");
console.log("fixture:", root);
if (run.error) console.error(run.error);
if (run.status !== 0)
  console.error(JSON.stringify({ exitCode: run.status, signal: run.signal }));
process.exitCode = run.status ?? 1;
