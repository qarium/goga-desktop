// Explicitly invoked only with user approval. Actual renderer, synthetic bridge,
// temporary HOME/profile, no production host, Git, shell, clipboard or network.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = fs.mkdtempSync("/private/tmp/goga-git-branches-ui-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));
const renderer = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GitBranchPicker} from ${JSON.stringify(path.resolve("src/renderer/GitBranchPicker.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
import ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.css"))};
const fixture=window.fixture={calls:[],scope:null,operation:'none',lastPreview:null,changesOpened:0};const revision='a'.repeat(64),oid='b'.repeat(40);
const row=(name,remote=false)=>({name,ref:(remote?'refs/remotes/':'refs/heads/')+name,oid,upstream:null,checkedOut:false});
window.goga={
readGitBranches:async projectId=>({projectId,root:'/synthetic/'+projectId,revision,head:oid,branch:'main',upstream:'refs/remotes/origin/main',operation:fixture.operation,dirty:false,local:[row('main'),row('feature/git-workspace')],remote:[row('origin/main',true),row('origin/feature/git-workspace',true)]}),
prepareGitBranch:async r=>{fixture.lastPreview=r;const merging=r.action==='merge'||r.action==='abort-merge';return {projectId:r.projectId,token:'1'.repeat(64),root:'/synthetic/'+r.projectId,action:r.action,fromRef:'refs/heads/main',fromOid:oid,toRef:r.action==='switch-remote'?r.ref.replace('refs/remotes/origin/','refs/heads/'):r.action==='pull'||merging?'refs/heads/main':r.ref??'refs/heads/'+r.name,toOid:oid,sourceRef:r.action==='abort-merge'?null:r.action==='pull'?'refs/remotes/origin/main':r.ref??'refs/heads/main',sourceOid:'c'.repeat(40),mergeMode:r.action==='merge'?'ff-or-commit':'abort',autoCommit:r.action==='merge',remote:merging?null:'origin',createsBranch:!merging,switchesBranch:!merging,hooks:'disabled',expiresAt:Date.now()+300000}},
executeGitBranch:async token=>{fixture.calls.push(token);const action=fixture.lastPreview.action;if(action==='merge'){fixture.operation='merge';return {projectId:fixture.scope,action,status:'conflict',changed:true,conflictCount:1,message:'Тестовый конфликт',log:'CONFLICT synthetic.txt — no real Git process was started.'}}if(action==='abort-merge'){fixture.operation='none';return {projectId:fixture.scope,action,status:'success',changed:true,message:'Отменено',log:''}}return {projectId:fixture.scope,action,status:'error',changed:false,message:'Тестовый отказ переключения',log:'SYNTHETIC BRANCH REFUSAL — no real Git process was started.'}},
};
function Fixture(){const[scope,setScope]=useState('fixture-wide');fixture.scope=scope;fixture.setScope=setScope;return <div className="fixture-shell"><header className="fixture-title">Goga <small>DESKTOP · изолированная проверка</small></header><div className="fixture-content"><aside className="fixture-sidebar"><strong>Мой компьютер</strong><p>Тестовый проект</p></aside><main className="fixture-main"><div className="fixture-context"><span>/synthetic/{scope}</span><GitBranchPicker projectId={scope} branch="main" revision={0} onChanged={()=>{}} onShowChanges={()=>{fixture.changesOpened++}}/></div><section style={{padding:24}}><h2>Проект</h2><p>Подставное содержимое — пользовательские файлы не загружаются.</p></section></main></div></div>}
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
html,body,#root{height:100%;overflow:hidden}.fixture-shell{height:100%;display:flex;flex-direction:column}.fixture-title{height:54px;flex-shrink:0;padding:15px 24px;border-bottom:1px solid var(--line);font-size:22px;font-weight:700;color:var(--teal)}.fixture-title small{margin-left:14px;font-size:11px;color:var(--muted)}.fixture-content{display:flex;flex:1;min-height:0}.fixture-sidebar{width:208px;padding:28px 20px;flex-shrink:0;background:#0e1424;border-right:1px solid var(--line)}.fixture-sidebar p{color:var(--teal);margin-top:32px}.fixture-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}.fixture-context{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}
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
  app.setName("Goga isolated branch UI test");
  for (const [key, dir] of [
    ["userData", "data"],
    ["sessionData", "session"],
    ["crashDumps", "crashes"],
  ])
    app.setPath(key, path.join(__dirname, dir));
  app.setAppLogsPath(path.join(__dirname, "logs"));
  const report = { ok: false, checks: [], screenshots: [], errors: [] };
  let win;
  const timeout = setTimeout(() => app.exit(2), 45000);
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
    const ev = (s) => win.webContents.executeJavaScript(s);
    const settle = () =>
      ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const until = async (s) => {
      for (let i = 0; i < 150; i++) {
        if (await ev(s)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("DOM timeout: " + s);
    };
    const click = async (s) => {
      await ev(`document.querySelector(${JSON.stringify(s)}).click()`);
      await settle();
    };
    const screenshot = async (name) => {
      const target = path.join(__dirname, name + ".png");
      fs.writeFileSync(target, (await win.webContents.capturePage()).toPNG());
      report.screenshots.push(target);
    };
    const checkButton = async (selector) => {
      const geometry = await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();const at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,clickable:!!at&&(at===e||e.contains(at)),width:r.width,height:r.height};})()`,
      );
      assert.ok(
        geometry.inside &&
          geometry.clickable &&
          geometry.width > 24 &&
          geometry.height > 24,
        JSON.stringify({ selector, ...geometry }),
      );
    };
    await win.loadFile(path.join(__dirname, "index.html"));
    for (const [width, height, name] of [
      [1280, 800, "wide"],
      [960, 640, "narrow"],
    ]) {
      win.setContentSize(width, height);
      await ev(`fixture.setScope('fixture-${name}')`);
      await settle();
      await click(".git-branch-trigger");
      await until(
        'document.querySelectorAll(".git-branch-list button").length===2',
      );
      await checkButton(".git-branch-list button:last-child");
      assert.ok(
        await ev(
          '!document.querySelector(".git-branch-list").textContent.includes("origin/")',
        ),
      );
      await screenshot("local-" + name);
      await click(".git-branch-groups button:last-child");
      await ev('document.querySelector("input[type=search]").focus()');
      await win.webContents.insertText("feature");
      await settle();
      assert.equal(
        await ev('document.querySelectorAll(".git-branch-list button").length'),
        1,
      );
      await checkButton(".git-branch-menu-actions button");
      await screenshot("remote-" + name);
      await click(".git-branch-list button");
      await until(
        '!!document.querySelector(".topic-dialog[open] .git-branch-dialog-actions")',
      );
      await checkButton(".git-branch-dialog-actions .primary");
      await screenshot("branch-confirmation-" + name);
      await click(".git-branch-dialog-actions .primary");
      await until('!!document.querySelector(".git-branch-log")');
      await checkButton(
        ".topic-dialog[open] .git-branch-dialog-actions > button",
      );
      await screenshot("branch-error-" + name);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await until('!document.querySelector(".topic-dialog[open]")');
      await click(".git-branch-trigger");
      await until('!!document.querySelector(".git-branch-menu")');
      await click(".git-branch-groups button:first-child");
      await until(
        'document.querySelectorAll(".git-branch-list button").length===2',
      );
      await click(".git-branch-menu-actions button:first-child");
      await until(
        '!!document.querySelector(".topic-dialog[open] input[aria-label]")',
      );
      await ev(
        'document.querySelector(".topic-dialog[open] input[aria-label]").focus()',
      );
      await win.webContents.insertText("new-feature");
      await settle();
      await checkButton(".git-branch-dialog-actions .primary");
      const checkLayout = await ev(
        `(()=>{const label=document.querySelector('.git-branch-check'),box=label.querySelector('input').getBoundingClientRect(),range=document.createRange();range.selectNodeContents(label.lastChild);const text=range.getBoundingClientRect();return Math.abs(box.y+box.height/2-text.y-text.height/2);})()`,
      );
      assert.ok(
        checkLayout < 3,
        "checkbox and label must share a row: " + checkLayout,
      );
      await screenshot("create-" + name);
      await click(".topic-dialog header button");
      await click(".git-branch-trigger");
      await until(
        '!!document.querySelector(".git-branch-menu-actions button:nth-child(3)")',
      );
      await click(".git-branch-menu-actions button:nth-child(3)");
      await until(
        '!!document.querySelector(".topic-dialog[open] .git-branch-summary")',
      );
      assert.ok(
        await ev(
          'document.querySelector(".git-branch-summary").textContent.includes("origin/main")',
        ),
      );
      await checkButton(".git-branch-dialog-actions .primary");
      await screenshot("pull-" + name);
      await click(".topic-dialog header button");
      await click(".git-branch-trigger");
      await until(
        '!!document.querySelector(".git-branch-list button:not(:disabled)")',
      );
      await click(".git-branch-menu-actions button:nth-child(2)");
      await until('!!document.querySelector(".git-merge-source")');
      await ev(
        'document.querySelector(".git-merge-source input[type=search]").focus()',
      );
      await win.webContents.insertText("workspace");
      await settle();
      assert.equal(
        await ev(
          'document.querySelectorAll(".git-merge-source [role=option]").length',
        ),
        1,
      );
      await checkButton(".git-merge-source [role=option]");
      await screenshot("merge-source-" + name);
      await click(".git-merge-source [role=option]");
      await checkButton(".git-merge-source .primary");
      await click(".git-merge-source .primary");
      await until('!!document.querySelector(".git-branch-summary")');
      assert.ok(
        await ev(
          'document.querySelector(".git-branch-summary").textContent.includes("cccccccc")',
        ),
      );
      await checkButton(".git-branch-dialog-actions .primary");
      await screenshot("merge-confirmation-" + name);
      await click(".git-branch-dialog-actions .primary");
      await until('!!document.querySelector(".git-branch-log")');
      assert.ok(
        await ev(
          'document.querySelector(".topic-dialog h2").textContent.includes("конфликты")',
        ),
      );
      await checkButton(
        ".topic-dialog[open] .git-branch-dialog-actions > button",
      );
      await screenshot("merge-conflict-" + name);
      await click(".topic-dialog[open] .git-branch-dialog-actions > button");
      await click(".git-branch-trigger");
      await until(
        '!!document.querySelector(".git-branch-menu-actions .danger")',
      );
      await click(".git-branch-menu-actions .danger");
      await until(
        '!!document.querySelector(".git-branch-dialog-actions .danger")',
      );
      await checkButton(".git-branch-dialog-actions .danger");
      await screenshot("merge-abort-" + name);
      await click(".git-branch-dialog-actions .danger");
      await until('!document.querySelector(".git-branch-running")');
      assert.equal(await ev("fixture.operation"), "none");
      report.checks.push({
        width,
        height,
        pullSourceShown: true,
        separateLists: true,
        substringSearch: true,
        createFits: true,
        confirmationFits: true,
        errorClosable: true,
        mergeSourceFits: true,
        mergeConfirmationFits: true,
        conflictNavigation: true,
        abortConfirmationFits: true,
      });
    }
    assert.equal(await ev("fixture.calls.length"), 6);
    assert.equal(await ev("fixture.changesOpened"), 2);
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
  timeout: 60000,
});
fs.writeFileSync(path.join(root, "stdout.log"), run.stdout ?? "");
fs.writeFileSync(path.join(root, "stderr.log"), run.stderr ?? "");
console.log(run.stdout ?? "");
console.error(run.stderr ?? "");
console.log("fixture:", root);
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
