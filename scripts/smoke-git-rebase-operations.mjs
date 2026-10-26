// Explicit approval required: isolated Electron, real renderer, synthetic bridge.
// No production Host, Git, shell, clipboard, network or user profile access.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = fs.mkdtempSync("/private/tmp/goga-git-rebase-operations-ui-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));
const renderer = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GitWorkspace} from ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.tsx"))};
import {RetainedViews} from ${JSON.stringify(path.resolve("src/renderer/RetainedViews.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
const scopes={primary:'fixture-p',other:'fixture-q',topic:{projectId:'fixture-p',year:'2026',topic:'topic-alpha',branch:'topic-alpha',contextId:'ctx-'+ 'c'.repeat(64),revision:'11111111-1111-4111-8111-111111111111'}};
const id=s=>JSON.stringify(s), tickets=new Map(), nl=String.fromCharCode(10);
const fixture=window.fixture={reads:[],prepares:[],executes:[],changed:[],closed:0,mode:'success',wait:false,prepareWait:false,operations:new Map(),conflicts:new Set(),overlays:new Map(),busy:new Map()};
const operation=s=>fixture.operations.get(id(s))??'rebase';
const root=s=>'/synthetic/'+(typeof s==='string'?s:s.topic);
const branch=s=>typeof s==='string'?'feature/fixture':s.branch;
window.goga={
 cancelRead:async()=>{},
 readGitWorkspace:async scope=>{fixture.reads.push(scope);const conflict=fixture.conflicts.has(id(scope));return {scope,root:root(scope),revision:(conflict?'e':'a').repeat(64),head:(conflict?'f':'b').repeat(40),branch:operation(scope)==='none'?branch(scope):null,upstream:null,ahead:0,behind:0,operation:operation(scope),files:conflict?[{path:'next-conflict.txt',kind:'conflict',indexStatus:'U',worktreeStatus:'U',submodule:false}]:[]};},
 readGitConflict:async r=>{const src=t=>({kind:'text',text:t+nl,oid:'b'.repeat(40),mode:'100644'});return {...r,fingerprint:'c'.repeat(64),base:src('base'),current:src('ours'),incoming:src('theirs'),working:{kind:'text',text:['<<<<<<< current','ours','=======','theirs','>>>>>>> incoming',''].join(nl)},generated:{kind:'text',text:['<<<<<<< current','ours','=======','theirs','>>>>>>> incoming',''].join(nl),requiresExplicitReconstruction:true,blocks:[]}};},
 prepareGitRebaseOperation:async request=>{fixture.prepares.push(request);if(fixture.prepareWait)await new Promise(r=>fixture.resolvePrepare=r);const p={...request,token:fixture.prepares.length.toString(16).padStart(64,'0'),root:root(request.scope),operation:'rebase',backend:'merge',branch:branch(request.scope),head:(fixture.conflicts.has(id(request.scope))?'f':'b').repeat(40),original:'c'.repeat(40),paths:Array.from({length:18},(_,i)=>'src/features/component-'+i+'/long-but-realistic-file-name.ts'),effects:request.action==='abort'?'Отмена только проверенного исходного конфликта; изменённые рабочие файлы не отбрасываются автоматически.':'Текущий разрешённый коммит и максимум один следующий. Может возникнуть следующий конфликт.',hooks:'disabled',expiresAt:Date.now()+300000};tickets.set(p.token,p);return p;},
 executeGitRebaseOperation:async token=>{fixture.executes.push(token);const p=tickets.get(token);if(!p)throw Error('Unknown synthetic token');if(fixture.wait)await new Promise(r=>fixture.resolve=r);const success=fixture.mode==='success',conflict=fixture.mode==='conflict',continued=p.action==='continue';if(success){fixture.operations.set(id(p.scope),'none');fixture.conflicts.delete(id(p.scope));}if(conflict)fixture.conflicts.add(id(p.scope));return {scope:p.scope,operation:'rebase',action:p.action,status:success?'success':conflict?'conflict':'uncertain',changed:true,mutationStarted:true,worktreeRestored:!continued&&success,worktreeUpdated:continued,indexPublished:true,headPublished:success||conflict,metadataCleared:success,objectsPublished:continued, publishedObjectCount:continued?3:0,branchPublished:continued&&success,metadataPublished:continued&&(success||conflict),lockRetained:!success&&!conflict,retainedLocks:success||conflict?[]:['/synthetic/.git/config.lock'],uncheckedLocks:success||conflict?[]:['/synthetic/.git/index.lock'],recoveryStatus:success||conflict?'retained':'unverified',recoveryPath:success||conflict?'/synthetic/recovery':undefined,lastKnownRecoveryPath:'/synthetic/recovery',message:success?'Операция подтверждена':conflict?'Следующий конфликт':'Неопределённый результат тестовой операции',log:success||conflict?'SYNTHETIC VERIFIED':Array.from({length:90},(_,i)=>'SYNTHETIC diagnostic line '+i).join(nl)};},
};
fixture.button=label=>[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===label);
function Fixture(){const [key,setKey]=useState('primary'),[collapsed,setCollapsed]=useState(false),[body,setBody]=useState(null),[open,setOpen]=useState(true);fixture.setKey=setKey;fixture.setCollapsed=setCollapsed;fixture.key=key;fixture.scope=scopes[key];
 return <div className={'app-shell fixture-shell'+(collapsed?' sidebar-collapsed':'')}><header className="titlebar"><span className="wordmark"><b>Goga</b><small>DESKTOP · изолированная проверка</small></span></header><aside className="sidebar"><span className="eyebrow">Мой компьютер</span><p>Тестовый проект</p></aside><main className="main-area"><div className="project-bar"><div className="project-heading"><span className="eyebrow">Мой компьютер / ПРОЕКТ</span><h1>Тестовый проект</h1></div><div className="project-heading-context">{key==='topic'?'topic-alpha':'Без топика'}</div><div className="project-actions">Запуски · 0</div></div><nav className="tabs"><span className="fixture-tab">Проект</span><span className="fixture-tab">Терминал</span><span className="fixture-tab">Топики</span></nav><div className="run-context"><span className="workspace-path">/synthetic/{key}</span><div className="git-workspace-controls-host"><RetainedViews activeKey={key}><GitWorkspace scope={scopes[key]} open={open} bodyContainer={body} revision={0} onOpen={()=>setOpen(true)} onClose={()=>{fixture.closed++;setOpen(false)}} onChanged={(project,scope)=>fixture.changed.push({project,scope})} onOverlayChange={(project,visible,owner)=>fixture.overlays.set(owner,visible)} onBranchBusyChange={(project,busy,owner)=>fixture.busy.set(owner,busy)}/></RetainedViews></div></div><div className="git-workspace-stage" ref={setBody}/></main></div>;
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
  "html,body,#root{height:100%;overflow:hidden}.fixture-tab{display:flex;align-items:center;padding:0 20px}.fixture-shell.sidebar-collapsed .sidebar p{display:none}",
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
  const { app, BrowserWindow, session } = require("electron"),
    fs = require("node:fs"),
    path = require("node:path"),
    assert = require("node:assert/strict");
  app.setName("Goga isolated rebase operation test");
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
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") report.errors.push(e.message);
    });
    const ev = (s) => win.webContents.executeJavaScript(s),
      settle = () =>
        ev(
          "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
        );
    const until = async (s) => {
      for (let i = 0; i < 200; i++) {
        if (await ev(s)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("DOM timeout: " + s);
    };
    const click = async (label) => {
      await until("!!fixture.button(" + JSON.stringify(label) + ")");
      await ev("fixture.button(" + JSON.stringify(label) + ").click()");
      await settle();
    };
    const escape = async () => {
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await settle();
    };
    const screenshot = async (name) => {
      // DOM completion alone can precede the hidden window's composited frame.
      await settle();
      await new Promise((r) => setTimeout(r, 100));
      const p = path.join(__dirname, name + ".png");
      fs.writeFileSync(p, (await win.webContents.capturePage()).toPNG());
      report.screenshots.push(p);
    };
    const geometry = async (label) => {
      const r = await ev(
        `(()=>{const e=fixture.button(${JSON.stringify(label)}),r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,clickable:!!hit&&(hit===e||e.contains(hit)),width:r.width,height:r.height}})()`,
      );
      assert.ok(
        r.inside && r.clickable && r.width > 24 && r.height > 24,
        JSON.stringify({ label, ...r }),
      );
      return r;
    };
    for (const [width, height, key, collapsed] of [
      [1280, 800, "primary", false],
      [960, 640, "topic", true],
    ]) {
      win.setContentSize(width, height);
      await win.loadFile(path.join(__dirname, "index.html"));
      await until('!!window.fixture?.button("Продолжить rebase…")');
      await ev(`fixture.setKey('${key}');fixture.setCollapsed(${collapsed})`);
      await settle();
      await until(
        '!!fixture.button("Продолжить rebase…")&&!fixture.button("Продолжить rebase…").disabled',
      );
      await geometry("Продолжить rebase…");
      await geometry("Отменить rebase…");
      await screenshot("footer-" + key);
      await ev("fixture.prepareWait=true");
      await click("Продолжить rebase…");
      await until("!!fixture.resolvePrepare");
      assert.equal(await ev("fixture.executes.length"), 0);
      assert.ok(
        await ev('!!document.querySelector("dialog[open] [role=status]")'),
      );
      await screenshot("prepare-" + key);
      await ev("fixture.resolvePrepare();fixture.prepareWait=false");
      await until(
        '!!fixture.button("Продолжить rebase")&&!fixture.button("Продолжить rebase").disabled',
      );
      await geometry("Продолжить rebase");
      await geometry("Закрыть подтверждение rebase");
      assert.equal(
        await ev('!!document.querySelector("dialog[open] textarea")'),
        false,
      );
      assert.ok(
        await ev(
          'document.querySelector("dialog[open]").textContent.includes("reflog")',
        ),
      );
      assert.ok(await ev("[...fixture.overlays.values()].some(Boolean)"));
      await screenshot("continue-" + key);
      const detailsScroll = await ev(
        `(()=>{const e=document.querySelector('.git-merge-operation-details');e.scrollTop=e.scrollHeight;return {max:e.scrollHeight-e.clientHeight,top:e.scrollTop}})()`,
      );
      assert.ok(detailsScroll.top >= detailsScroll.max - 1);
      if (width === 960) assert.ok(detailsScroll.max > 0);
      assert.ok(
        await ev(
          `(()=>{const e=document.querySelector('.git-merge-operation-details ul');e.scrollTop=e.scrollHeight;return e.scrollTop>0})()`,
        ),
      );
      await geometry("Продолжить rebase");
      await geometry("Закрыть подтверждение rebase");
      await screenshot("continue-bottom-" + key);
      await escape();
      await until('!document.querySelector("dialog[open]")');
      assert.equal(await ev("fixture.closed"), 0);
      await click("Продолжить rebase…");
      await until(
        '!!fixture.button("Продолжить rebase")&&!fixture.button("Продолжить rebase").disabled',
      );
      await ev("fixture.wait=true");
      await click("Продолжить rebase");
      await until("fixture.executes.length===1");
      await ev('fixture.setKey("other")');
      await settle();
      await ev("fixture.resolve()");
      await until("fixture.changed.length===1");
      assert.equal(
        await ev(
          'typeof fixture.changed[0].scope==="string"?fixture.changed[0].scope:fixture.changed[0].scope.topic',
        ),
        key === "primary" ? "fixture-p" : "topic-alpha",
      );
      assert.equal(await ev('!!document.querySelector("dialog[open]")'), false);
      await ev(`fixture.setKey('${key}')`);
      await settle();
      await until('!!fixture.button("Закрыть результат rebase")');
      await click("Закрыть результат rebase");
      await until('!fixture.button("Продолжить rebase…")');
      await ev(
        'fixture.operations.set(JSON.stringify(fixture.scope),"rebase");fixture.wait=false;fixture.mode="conflict"',
      );
      await click("Обновить изменения");
      await until(
        '!!fixture.button("Продолжить rebase…")&&!fixture.button("Продолжить rebase…").disabled',
      );
      await click("Продолжить rebase…");
      await until(
        '!!fixture.button("Продолжить rebase")&&!fixture.button("Продолжить rebase").disabled',
      );
      await click("Продолжить rebase");
      await until('!!fixture.button("Закрыть результат rebase")');
      await click("Закрыть результат rebase");
      await until('!!fixture.button("next-conflict.txt")');
      assert.equal(
        await ev('fixture.button("Продолжить rebase…").disabled'),
        true,
      );
      await click("next-conflict.txt");
      await until('!!document.querySelector(".git-conflict-editor")');
      await screenshot("next-conflict-" + key);
      await ev('fixture.mode="uncertain"');
      await click("Отменить rebase…");
      await until(
        '!!fixture.button("Отменить rebase")&&!fixture.button("Отменить rebase").disabled',
      );
      await geometry("Отменить rebase");
      await screenshot("abort-" + key);
      await click("Отменить rebase");
      await until('!!fixture.button("Закрыть результат rebase")');
      for (const expected of [
        "/synthetic/recovery",
        "/synthetic/.git/index.lock",
        "/synthetic/.git/config.lock",
      ])
        assert.ok(
          await ev(
            `document.querySelector('dialog[open]').textContent.includes(${JSON.stringify(expected)})`,
          ),
        );
      await geometry("Закрыть результат rebase");
      await screenshot("uncertain-" + key);
      assert.ok(
        await ev(
          `(()=>{const e=document.querySelector('.git-workspace-error pre');e.scrollTop=e.scrollHeight;return e.scrollTop>0})()`,
        ),
      );
      await geometry("Закрыть результат rebase");
      await screenshot("uncertain-bottom-" + key);
      await escape();
      await until('!document.querySelector("dialog[open]")');
      assert.equal(await ev("fixture.closed"), 0);
      assert.equal(await ev("fixture.executes.length"), 3);
      assert.equal(
        await ev("document.documentElement.scrollWidth>innerWidth+1"),
        false,
      );
      report.checks.push({
        width,
        height,
        context: key,
        collapsed,
        anchoredActions: true,
        loaderVisible: true,
        readOnlyPreview: true,
        lateSuccessOriginalOwner: true,
        nextConflictReadable: true,
        uncertainDiagnosticsClosable: true,
        scrollKeepsActionsVisible: true,
        detailsScroll,
        noAutoRetry: true,
      });
    }
    assert.deepEqual(report.errors, []);
    report.ok = true;
  } catch (e) {
    report.error = String(e.stack ?? e);
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
