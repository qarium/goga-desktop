// Explicitly invoked only with approval: real renderer, synthetic bridge/files,
// isolated HOME/profile; no production host, Git, shell, clipboard or network.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = fs.mkdtempSync("/private/tmp/goga-git-conflict-repair-ui-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));

// Source positions are constructed from independently assembled strings, not
// guessed by matching marker text; the working file deliberately differs.
function conflictFixture(request) {
  const { scope, path: file, revision } = request;
  const prefix = "// " + file + "\n// unchanged header\n";
  const middle = "// between blocks\n",
    tail = "// no final newline";
  const current = ["const mode = 'local';\n", "const retry = 3;\n"];
  const incoming = ["const mode = 'remote';\n", "const retry = 5;\n"];
  const base = ["const mode = 'base';\n", "const retry = 1;\n"];
  const marker = (i, n, diff3) =>
    "<".repeat(n) +
    " current\n" +
    current[i] +
    (diff3 ? "|".repeat(n) + " base\n" + base[i] : "") +
    "=".repeat(n) +
    "\n" +
    incoming[i] +
    ">".repeat(n) +
    " incoming\n";
  const generated =
    prefix + marker(0, 31, true) + middle + marker(1, 31, true) + tail;
  const working =
    prefix + marker(0, 7, false) + middle + marker(1, 7, false) + tail;
  const part = (values, i) => {
    const from =
      i === 0
        ? prefix.length
        : prefix.length + values[0].length + middle.length;
    return { text: values[i], range: { from, to: from + values[i].length } };
  };
  const source = (values, oid) => ({
    kind: "text",
    mode: "100644",
    oid: oid.repeat(40),
    text: prefix + values[0] + middle + values[1] + tail,
  });
  return {
    scope,
    path: file,
    revision,
    fingerprint: "c".repeat(64),
    base: source(base, "a"),
    current: source(current, "b"),
    incoming: source(incoming, "c"),
    working: { kind: "text", text: working },
    generated: {
      kind: "text",
      text: generated,
      requiresExplicitReconstruction: true,
      blocks: [0, 1].map((i) => {
        const from =
          i === 0
            ? prefix.length
            : prefix.length + marker(0, 31, true).length + middle.length;
        return {
          id: "h" + (i + 1),
          resultRange: { from, to: from + marker(i, 31, true).length },
          base: part(base, i),
          current: part(current, i),
          incoming: part(incoming, i),
        };
      }),
    },
  };
}

const renderer = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {undo,redo,undoDepth} from '@codemirror/commands';
import {GitWorkspace} from ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.tsx"))};
import {GitBranchPicker} from ${JSON.stringify(path.resolve("src/renderer/GitBranchPicker.tsx"))};
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
const oid='b'.repeat(40);const row=(name,remote=false)=>({name,ref:(remote?'refs/remotes/':'refs/heads/')+name,oid,upstream:null,checkedOut:false});fixture.branchCalls=[];fixture.operation='none';
window.goga = {
readGitBranches:async projectId=>({projectId,root:'/synthetic/'+projectId,revision,head:oid,branch:'main',upstream:'refs/remotes/origin/main',operation:fixture.operation,dirty:false,local:[row('main'),row('feature/git-workspace'),...Array.from({length:60},(_,i)=>row('feature/branch-'+i))],remote:[row('origin/main',true),row('origin/feature/git-workspace',true)]}),
prepareGitBranch:async r=>{fixture.lastPreview=r;const merging=r.action==='merge'||r.action==='abort-merge';return {projectId:r.projectId,token:'1'.repeat(64),root:'/synthetic/'+r.projectId,action:r.action,fromRef:'refs/heads/main',fromOid:oid,toRef:r.action==='switch-remote'?r.ref.replace('refs/remotes/origin/','refs/heads/'):r.action==='pull'||merging?'refs/heads/main':r.ref??'refs/heads/'+r.name,toOid:oid,sourceRef:r.action==='abort-merge'?null:r.action==='pull'?'refs/remotes/origin/main':r.ref??'refs/heads/main',sourceOid:'c'.repeat(40),mergeMode:r.action==='merge'?'ff-or-commit':'abort',autoCommit:r.action==='merge',remote:merging?null:'origin',createsBranch:!merging,switchesBranch:!merging,hooks:'disabled',expiresAt:Date.now()+300000}},
executeGitBranch:async token=>{fixture.branchCalls.push(token);const action=fixture.lastPreview.action;if(action==='merge'){fixture.operation='merge';return {projectId:fixture.lastPreview.projectId,action,status:'conflict',changed:true,conflictCount:1,message:'Тестовый конфликт',log:'CONFLICT synthetic.txt — no real Git process was started.'}}if(action==='abort-merge'){fixture.operation='none';return {projectId:fixture.lastPreview.projectId,action,status:'success',changed:true,message:'Отменено',log:''}}return {projectId:fixture.lastPreview.projectId,action,status:'error',changed:false,message:'Тестовый отказ переключения',log:'SYNTHETIC BRANCH REFUSAL — no real Git process was started.'}},

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
 <div className="run-context"><GitBranchPicker projectId="fixture-p" branch="main" revision={0} onChanged={()=>{}} onShowChanges={()=>{fixture.changesOpened=(fixture.changesOpened||0)+1}}/><span className="workspace-path">/synthetic/{key==='topic'?'topic-alpha':'project'}</span><div className="git-workspace-controls-host"><RetainedViews activeKey={key}><GitWorkspace scope={scopes[key]} open={open} bodyContainer={body} onOpen={()=>setOpen(true)} onClose={()=>{fixture.closed++;setOpen(false)}} onChanged={id=>fixture.changed.push(id)} onOverlayChange={(_,visible)=>{fixture.overlay=visible}} revision={0}/></RetainedViews></div></div>
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
    const clickSelector = async (selector) => {
      await until("!!document.querySelector(" + JSON.stringify(selector) + ")");
      await ev(
        "document.querySelector(" + JSON.stringify(selector) + ").click()",
      );
      await settle();
    };
    for (const [width, height, name, key] of [
      [1280, 800, "wide", "primary"],
      [960, 640, "narrow", "topic"],
    ]) {
      win.setContentSize(width, height);
      await ev(`fixture.setKey(${JSON.stringify(key)});fixture.setOpen(true)`);
      await settle();
      await select("src/settings.ts");
      const initial = await ev("fixture.text()");
      assert.ok(initial.includes("<<<<<<< current\n"));
      assert.equal(initial.includes("|||||||"), false);
      await until("!!fixture.arrow('Блок 2: принять входящую')");
      const visual = await ev(
        `(()=>['current','result','incoming'].map(side=>{const host=document.querySelector('.git-conflict-'+side+' .yaml-code-editor');const root=host.shadowRoot;const colored=[...root.querySelectorAll('.conflict-'+side)];const buttons=[...root.querySelectorAll('button')];return {side,colored:colored.length,colors:colored.map(e=>getComputedStyle(e).backgroundColor),buttons:buttons.map(e=>{const r=e.getBoundingClientRect(),at=root.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:e.getAttribute('aria-label'),disabled:e.disabled,visible:r.width>0&&r.height>0&&r.top>=0&&r.bottom<=innerHeight,clickable:at===e||e.contains(at)}})}}))()`,
      );
      for (const pane of visual) {
        assert.ok(pane.colored >= 2, JSON.stringify(visual));
        assert.ok(pane.colors.every((c) => c !== "rgba(0, 0, 0, 0)"));
        assert.ok(
          pane.buttons.every((b) => !b.disabled) &&
            pane.buttons
              .filter((b) => b.label.startsWith("Блок 1:"))
              .every((b) => b.visible && b.clickable),
          JSON.stringify(visual),
        );
      }
      const layout = await paneLayout();
      await buttonGeometry("Закрыть файл: src/settings.ts");
      await screenshot("conflict-initial-" + name);
      await ev("fixture.arrow('Блок 1: принять текущую').click()");
      await settle();
      const afterCurrent = await ev("fixture.text()");
      assert.notEqual(afterCurrent, initial);
      assert.ok(afterCurrent.includes("const mode = 'local';"));
      assert.equal(afterCurrent.includes("const mode = 'remote';"), false);
      await ev("fixture.editor('Входящая версия').scrollDOM.scrollTop=1000");
      await settle();
      const secondClickable = await ev(
        "(()=>{const e=fixture.arrow('Блок 2: принять входящую'),r=e.getBoundingClientRect(),at=e.getRootNode().elementFromPoint(r.x+r.width/2,r.y+r.height/2);return at===e||e.contains(at)})()",
      );
      assert.ok(secondClickable, "second arrow must be reachable by scrolling");
      await ev("fixture.arrow('Блок 2: принять входящую').click()");
      await settle();
      await ev("fixture.edit('// retained manual draft\\n')");
      await settle();
      const draft = await ev("fixture.text()");
      assert.ok(draft.includes("const retry = 5;"));
      assert.equal(draft.includes("const retry = 3;"), false);
      assert.equal(draft.includes("<<<<<<<"), false);
      assert.ok(draft.endsWith("// no final newline"));
      await clickSelector(".git-conflict-help summary");
      assert.equal(await ev("fixture.text()"), draft);
      await clickSelector(".git-conflict-help summary");
      assert.equal(await ev("fixture.text()"), draft);
      await screenshot("conflict-resolved-" + name);
      const reads = await ev("fixture.reads.length");
      await click("Закрыть файл: src/settings.ts");
      await until("!document.querySelector('.git-conflict-editor')");
      assert.equal(await ev("fixture.closed"), 0);
      assert.ok(await ev("!!fixture.button('src/settings.ts')"));
      await screenshot("conflict-list-" + name);
      await select("src/settings.ts");
      assert.equal(await ev("fixture.text()"), draft);
      assert.equal(await ev("fixture.reads.length"), reads);
      await click("Закрыть файл: src/settings.ts");
      await ev("fixture.operation='none'");
      await clickSelector(".git-branch-trigger");
      await clickSelector(".git-branch-menu-actions button:nth-child(2)");
      await until("!!document.querySelector('.git-merge-branch-list')");
      const listGeometry = await ev(
        `(()=>{const l=document.querySelector('.git-merge-branch-list'),r=l.getBoundingClientRect();return {height:r.height,scroll:l.scrollHeight>l.clientHeight,overflow:getComputedStyle(l).overflowY,options:l.children.length}})()`,
      );
      assert.ok(listGeometry.height >= 160, JSON.stringify(listGeometry));
      assert.equal(listGeometry.scroll, true);
      assert.equal(listGeometry.overflow, "scroll");
      assert.equal(listGeometry.options, 61);
      await ev(
        "document.querySelector('.git-merge-branch-list').scrollTop=100000",
      );
      await settle();
      await buttonGeometry("Продолжить");
      await screenshot("merge-source-scrolled-" + name);
      await ev("document.querySelector('.git-merge-branch-list').scrollTop=0");
      await clickSelector(".git-merge-source [role=option]");
      await clickSelector(".git-merge-source .primary");
      await clickSelector(".git-branch-dialog-actions .primary");
      await until("!!document.querySelector('.git-branch-log')");
      await buttonGeometry("Просмотреть конфликты");
      await buttonGeometry("Закрыть");
      const gap = await ev(
        `(()=>{const a=fixture.button('Просмотреть конфликты').getBoundingClientRect(),b=fixture.button('Закрыть').getBoundingClientRect();return Math.max(b.left-a.right,b.top-a.bottom,a.left-b.right,a.top-b.bottom)})()`,
      );
      assert.ok(gap >= 7, "branch result buttons must be spaced: " + gap);
      await screenshot("branch-conflict-result-" + name);
      await click("Закрыть");
      report.checks.push({
        width,
        height,
        visual,
        layout,
        ordinaryMarkersAutoMapped: true,
        bothSidesApplied: true,
        draftRetainedWithoutRead: true,
        sameMergeList: true,
        branchResultGap: gap,
      });
    }
    assert.equal(await ev("fixture.executes.length"), 0);
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
