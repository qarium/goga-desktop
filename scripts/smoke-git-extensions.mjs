// Explicit approval required: isolated Electron, real renderer, synthetic bridge.
// No production Host, Git, shell, clipboard, network or user profile access.
// After approval: node scripts/smoke-git-extensions.mjs (run from repo root).
// Effects: temporary fixture bundle/profile, one hidden Electron window, screenshots
// and result.json/stdout.log/stderr.log under /private/tmp; files remain for review.
// This is renderer validation with synthetic replies, not host/native-Git proof.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = fs.mkdtempSync("/private/tmp/goga-git-extensions-ui-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));
const renderer = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GitWorkspace} from ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.tsx"))};
import {GitUpdateHandoff} from ${JSON.stringify(path.resolve("src/renderer/GitUpdateHandoff.tsx"))};
import {useGitUpdateHandoff} from ${JSON.stringify(path.resolve("src/renderer/useGitUpdateHandoff.ts"))};
import {RetainedViews} from ${JSON.stringify(path.resolve("src/renderer/RetainedViews.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
const scopes={primary:'fixture-p',other:'fixture-q',topic:{projectId:'fixture-p',year:'2026',topic:'topic-alpha',branch:'topic-alpha',contextId:'ctx-'+ 'c'.repeat(64),revision:'11111111-1111-4111-8111-111111111111'}};
const id=s=>JSON.stringify(s),tickets=new Map(),nl=String.fromCharCode(10);
const fixture=window.fixture={reads:[],prepares:[],executes:[],changed:[],opened:[],cancelled:[],closed:0,mode:'success',handoffMode:'conflict',wait:false,prepareWait:false,handoffReadError:false,operations:new Map(),conflicts:new Set()};
const operation=s=>fixture.operations.get(id(s))??'cherry-pick';
const root=s=>'/synthetic/'+(typeof s==='string'?s:s.topic);
const branch=s=>typeof s==='string'?'feature/fixture':s.branch;
const paths=Array.from({length:18},(_,i)=>'src/features/component-'+i+'/long-but-realistic-file-name.ts');
const journal=()=>Array.from({length:90},(_,i)=>'SYNTHETIC diagnostic line '+i).join(nl);
const token=()=>fixture.prepares.length.toString(16).padStart(64,'0');
const waitPrepare=async()=>{if(fixture.prepareWait)await new Promise(r=>fixture.resolvePrepare=r);};
window.goga={
 cancelRead:async request=>{fixture.cancelled.push(request);},
 readGitWorkspace:async scope=>{fixture.reads.push(scope);const conflict=fixture.conflicts.has(id(scope));return {scope,root:root(scope),revision:(conflict?'e':'a').repeat(64),head:'b'.repeat(40),branch:branch(scope),upstream:null,ahead:0,behind:0,operation:operation(scope),files:conflict?[{path:'next-conflict.txt',kind:'conflict',indexStatus:'U',worktreeStatus:'U',submodule:false}]:[]};},
 readGitConflict:async r=>{const src=t=>({kind:'text',text:t+nl,oid:'b'.repeat(40),mode:'100644'});return {...r,fingerprint:'c'.repeat(64),base:src('base'),current:src('ours'),incoming:src('theirs'),working:{kind:'text',text:['<<<<<<< current','ours','=======','theirs','>>>>>>> incoming',''].join(nl)},generated:{kind:'text',text:['<<<<<<< current','ours','=======','theirs','>>>>>>> incoming',''].join(nl),requiresExplicitReconstruction:true,blocks:[]}};},
 prepareGitSequencerOperation:async request=>{fixture.prepares.push({kind:'sequencer',...request});await waitPrepare();const p={...request,token:token(),root:root(request.scope),branch:branch(request.scope),head:'b'.repeat(40),original:'c'.repeat(40),current:'d'.repeat(40),paths,discardedResolutionPaths:request.action==='abort'?paths:[],effects:request.action==='abort'?'Восстановить исходное дерево, удалить перечисленные решения конфликтов.':'Продолжить последовательность до следующего конфликта или завершения.',hooks:'disabled',requiresCommitWarning:request.operation==='revert'&&request.action==='continue',expiresAt:Date.now()+300000};tickets.set(p.token,p);return p;},
 executeGitSequencerOperation:async token=>{fixture.executes.push({kind:'sequencer',token});const p=tickets.get(token);if(!p)throw Error('Unknown synthetic token');if(fixture.wait)await new Promise(r=>fixture.resolve=r);const success=fixture.mode==='success',continued=p.action==='continue';if(success){fixture.operations.set(id(p.scope),'none');fixture.conflicts.delete(id(p.scope));}return {scope:p.scope,operation:p.operation,action:p.action,status:success?'success':'uncertain',changed:true,mutationStarted:true,worktreeRestored:!continued&&success,worktreeUpdated:continued,indexPublished:success,branchPublished:success,metadataCleared:success,metadataPublished:success,objectsPublished:continued,publishedObjectCount:continued?3:0,lockRetained:!success,retainedLocks:success?[]:['/synthetic/.git/config.lock'],uncheckedLocks:success?[]:['/synthetic/.git/index.lock'],recoveryStatus:success?'retained':'unverified',recoveryPath:success?'/synthetic/recovery':undefined,lastKnownRecoveryPath:'/synthetic/recovery',message:success?'Операция подтверждена':'Неопределённый результат тестовой операции',log:success?'SYNTHETIC VERIFIED':journal()};},
 prepareGitUpdateHandoff:async request=>{fixture.prepares.push({kind:'handoff',...request});await waitPrepare();if(fixture.handoffReadError)throw Error('SYNTHETIC handoff read rejected');const candidate=fixture.candidate;if(request.candidateId!==candidate.candidateId||id(request.scope)!==id(candidate.scope))throw Error('Wrong synthetic candidate');const p={candidate,token:token(),hooks:'disabled',publishes:false,effects:'Только локальные файлы и индекс. Остановка на конфликте; продолжение и отмена требуют нового подтверждения.',expiresAt:candidate.expiresAt};tickets.set(p.token,p);return p;},
 executeGitUpdateHandoff:async token=>{fixture.executes.push({kind:'handoff',token});const p=tickets.get(token);if(!p)throw Error('Unknown synthetic token');if(fixture.wait)await new Promise(r=>fixture.resolve=r);const c=p.candidate,status=fixture.handoffMode;if(status==='conflict'){fixture.operations.set(id(c.scope),c.algorithm);fixture.conflicts.add(id(c.scope));}return {scope:c.scope,root:c.root,algorithm:c.algorithm,status,changed:true,conflicts:status==='conflict'?['next-conflict.txt']:[],message:status==='conflict'?'Конфликт подготовлен':'SYNTHETIC uncertain handoff',log:status==='conflict'?'SYNTHETIC HANDOFF VERIFIED':journal()};},
};
fixture.button=label=>[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&(b.getAttribute('aria-label')||b.textContent.trim())===label);
function Fixture(){const[key,setKey]=useState('primary'),[collapsed,setCollapsed]=useState(false),[body,setBody]=useState(null),[open,setOpen]=useState(true),[revision,setRevision]=useState(0),[error,setError]=useState('');fixture.setKey=setKey;fixture.key=key;fixture.scope=scopes[key];fixture.reset=operation=>{fixture.operations.set(id(scopes[key]),operation);fixture.conflicts.delete(id(scopes[key]));setRevision(n=>n+1);setOpen(true);};
 const handoff=useGitUpdateHandoff({scope:scopes[key],onError:setError,onChanged:scope=>{fixture.opened.push(scope);setOpen(true);setRevision(n=>n+1);}});
 const offer=()=>{const algorithm=key==='topic'?'rebase':'merge';const candidate={candidateId:'a'.repeat(64),scope:scopes[key],root:root(scopes[key]),targetBranch:branch(scopes[key]),targetHead:'b'.repeat(40),sourceRef:'refs/desktop/probe-base',sourceOid:'c'.repeat(40),baseRef:'main',strategy:algorithm==='rebase'?'ff-else-rebase':'ff-else-merge',algorithm,conflicts:paths,expiresAt:Date.now()+300000};fixture.candidate=candidate;void handoff.open(candidate);};
 return <div className={'app-shell fixture-shell'+(collapsed?' sidebar-collapsed':'')}><header className="titlebar"><span className="wordmark"><b>Goga</b><small>DESKTOP · изолированная проверка E6</small></span></header><aside className="sidebar"><button type="button" className="icon-button sidebar-toggle" aria-label={collapsed?'Развернуть меню':'Свернуть меню'} onClick={()=>setCollapsed(v=>!v)}>☰</button><span className="eyebrow">Мой компьютер</span><p>Тестовый проект</p></aside><main className="main-area"><div className="project-bar"><div className="project-heading"><span className="eyebrow">Мой компьютер / ПРОЕКТ</span><h1>Тестовый проект</h1></div><div className="project-heading-context">{key==='topic'?'topic-alpha':'Без топика'}</div></div><nav className="tabs"><span className="fixture-tab">Проект</span><span className="fixture-tab">Терминал</span><span className="fixture-tab">Топики</span></nav><div className="run-context"><span className="workspace-path">{root(scopes[key])}</span><button type="button" onClick={offer}>Разрешить конфликт вручную…</button><div className="git-workspace-controls-host"><RetainedViews activeKey={key}><GitWorkspace scope={scopes[key]} open={open} bodyContainer={body} revision={revision} onOpen={()=>setOpen(true)} onClose={()=>{fixture.closed++;setOpen(false)}} onChanged={(project,scope)=>fixture.changed.push({project,scope})}/></RetainedViews></div></div><div className="git-workspace-stage" ref={setBody}/>{error&&<p role="alert">{error}</p>}</main>{handoff.candidate&&<GitUpdateHandoff candidate={handoff.candidate} autoPrepare onClose={handoff.close} onChanged={handoff.changed}/>}</div>;
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
  app.setName("Goga isolated Git extensions test");
  app.commandLine.appendSwitch("disable-background-networking");
  for (const [key, dir] of [
    ["userData", "data"],
    ["sessionData", "session"],
    ["crashDumps", "crashes"],
  ])
    app.setPath(key, path.join(__dirname, dir));
  app.setAppLogsPath(path.join(__dirname, "logs"));
  const report = { ok: false, checks: [], screenshots: [], errors: [] };
  let win;
  const timeout = setTimeout(() => app.exit(2), 90000);
  try {
    await app.whenReady();
    app.dock?.hide();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_, done) => done({ cancel: true }),
    );
    session.defaultSession.setPermissionRequestHandler((_, __, done) =>
      done(false),
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
      await ev(
        "fixture.button(" +
          JSON.stringify(label) +
          ").focus();fixture.button(" +
          JSON.stringify(label) +
          ").click()",
      );
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
    const noDialog = () => until('!document.querySelector("dialog[open]")');
    const ready = (label) =>
      until(
        "!!fixture.button(" +
          JSON.stringify(label) +
          ")&&!fixture.button(" +
          JSON.stringify(label) +
          ").disabled",
      );
    const dialogHas = async (text) =>
      assert.ok(
        await ev(
          'document.querySelector("dialog[open]").textContent.includes(' +
            JSON.stringify(text) +
            ")",
        ),
        text,
      );
    const focusInside = async () =>
      assert.ok(
        await ev(
          'document.querySelector("dialog[open]").contains(document.activeElement)',
        ),
        "Focus must enter the modal",
      );
    const focused = async (label) =>
      assert.ok(
        await ev(
          "document.activeElement===fixture.button(" +
            JSON.stringify(label) +
            ")",
        ),
        "Focus did not return to " + label,
      );
    const stableWrites = async (count) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        await ev("fixture.executes.length"),
        count,
        "Unexpected automatic write or retry",
      );
    };
    for (const [width, height, key, collapsed] of [
      [1280, 800, "primary", false],
      [960, 640, "topic", true],
    ]) {
      win.setContentSize(width, height);
      await win.loadFile(path.join(__dirname, "index.html"));
      await until('!!window.fixture?.button("Свернуть меню")');
      await ev("fixture.setKey(" + JSON.stringify(key) + ")");
      await settle();
      if (collapsed) await click("Свернуть меню");
      assert.equal(
        await ev(
          'document.querySelector(".app-shell").classList.contains("sidebar-collapsed")',
        ),
        collapsed,
      );
      for (const operation of ["cherry-pick", "revert"]) {
        const start = "Продолжить " + operation + "…",
          confirm = "Продолжить " + operation;
        const abort = "Отменить " + operation,
          close = "Закрыть подтверждение " + operation,
          result = "Закрыть результат " + operation;
        await ev(
          "fixture.reset(" +
            JSON.stringify(operation) +
            ');fixture.mode="success"',
        );
        await ready(start);
        await geometry(start);
        await geometry(abort + "…");
        const initialWrites = await ev("fixture.executes.length");
        const initialChanges = await ev("fixture.changed.length");
        await ev("fixture.prepareWait=true;fixture.resolvePrepare=null");
        await click(start);
        await until("!!fixture.resolvePrepare");
        assert.ok(
          await ev('!!document.querySelector("dialog[open] [role=status]")'),
        );
        await focusInside();
        await geometry(close);
        await screenshot(operation + "-loading-" + key);
        await escape();
        await noDialog();
        await focused(start);
        await ev("fixture.resolvePrepare();fixture.prepareWait=false");
        await settle();
        await stableWrites(initialWrites);
        assert.ok(await ev("fixture.cancelled.length>0"));
        await click(start);
        await ready(confirm);
        if (operation === "revert") await dialogHas("--no-commit");
        await dialogHas("Git-хуки отключены");
        await geometry(confirm);
        await focusInside();
        await screenshot(operation + "-continue-" + key);
        const scroll = await ev(
          '(()=>{const e=document.querySelector(".git-merge-operation-details");e.scrollTop=e.scrollHeight;return {max:e.scrollHeight-e.clientHeight,top:e.scrollTop}})()',
        );
        assert.ok(scroll.top >= scroll.max - 1);
        await geometry(confirm);
        await geometry(close);
        await click(close);
        await noDialog();
        await focused(start);
        await stableWrites(initialWrites);
        await click(start);
        await ready(confirm);
        await click(confirm);
        await ready(result);
        await dialogHas("SYNTHETIC VERIFIED");
        await until("fixture.changed.length===" + String(initialChanges + 1));
        assert.equal(
          await ev(
            "JSON.stringify(fixture.changed.at(-1).scope)===JSON.stringify(fixture.scope)",
          ),
          true,
        );
        await screenshot(operation + "-continued-" + key);
        await click(result);
        await noDialog();
        await ev("fixture.reset(" + JSON.stringify(operation) + ")");
        await ready(abort + "…");
        await click(abort + "…");
        await ready(abort);
        await dialogHas("решения конфликтов будут удалены");
        await dialogHas("Будут удалены решения в файлах");
        await geometry(abort);
        await screenshot(operation + "-abort-" + key);
        await click(abort);
        await ready(result);
        await dialogHas("Отмена операции подтверждена");
        await until("fixture.changed.length===" + String(initialChanges + 2));
        await escape();
        await noDialog();
        await stableWrites(initialWrites + 2);
        assert.equal(
          await ev("fixture.closed"),
          0,
          "Modal Escape closed the workspace",
        );
        report.checks.push({
          width,
          height,
          context: key,
          collapsed,
          operation,
          continue: true,
          abort: true,
          revertCommitWarning: operation === "revert",
          cancelledRead: true,
          focus: true,
          closeAndEscape: true,
          scroll,
        });
      }
      // Sequencer uncertainty keeps the journal/locks visible and remains closable.
      await ev('fixture.reset("revert");fixture.mode="uncertain"');
      await ready("Отменить revert…");
      const sequencerChanges = await ev("fixture.changed.length");
      await click("Отменить revert…");
      await ready("Отменить revert");
      await click("Отменить revert");
      await ready("Закрыть результат revert");
      await dialogHas("/synthetic/.git/index.lock");
      await dialogHas("/synthetic/recovery");
      await dialogHas("SYNTHETIC diagnostic line 89");
      await geometry("Закрыть результат revert");
      await screenshot("sequencer-uncertain-" + key);
      const uncertainWrites = await ev("fixture.executes.length");
      await stableWrites(uncertainWrites);
      assert.equal(await ev("fixture.changed.length"), sequencerChanges);
      await escape();
      await noDialog();
      // E5 uses the real main-renderer handoff component/controller and workspace.
      const offer = "Разрешить конфликт вручную…",
        confirm = "Подтвердить переход к конфликту",
        close = "Закрыть подтверждение перехода";
      await ev(
        'fixture.reset("none");fixture.prepareWait=true;fixture.resolvePrepare=null',
      );
      await click(offer);
      await until("!!fixture.resolvePrepare");
      await dialogHas("Проверяем состояние Git");
      await focusInside();
      await geometry(close);
      await escape();
      await noDialog();
      await focused(offer);
      await ev("fixture.resolvePrepare();fixture.prepareWait=false");
      await settle();
      await stableWrites(uncertainWrites);
      await ev("fixture.handoffReadError=true");
      await click(offer);
      await until('!!document.querySelector("dialog[open] [role=alert]")');
      await dialogHas("SYNTHETIC handoff read rejected");
      await geometry(close);
      await screenshot("handoff-read-error-" + key);
      await click(close);
      await noDialog();
      await focused(offer);
      await stableWrites(uncertainWrites);
      await ev("fixture.handoffReadError=false");
      await click(offer);
      await ready(confirm);
      for (const field of [
        "root",
        "targetBranch",
        "sourceOid",
        "baseRef",
        "strategy",
        "algorithm",
      ]) {
        const expected = await ev("fixture.candidate." + field);
        await dialogHas(expected);
      }
      await dialogHas("Git-хуки отключены");
      await dialogHas("не публикуется на сервер");
      await geometry(confirm);
      await geometry(close);
      const footer = await ev(`(()=>{
        const button=fixture.button('Подтвердить переход к конфликту');
        const wrapper=button.closest('.git-merge-operation-confirm');
        if(!wrapper)return null;
        const css=getComputedStyle(wrapper),rect=button.getBoundingClientRect(),dialog=wrapper.closest('dialog').getBoundingClientRect();
        return {paddingTop:parseFloat(css.paddingTop),paddingBottom:parseFloat(css.paddingBottom),paddingLeft:parseFloat(css.paddingLeft),paddingRight:parseFloat(css.paddingRight),borderTop:parseFloat(css.borderTopWidth),flexShrink:css.flexShrink,bottomGap:dialog.bottom-rect.bottom,rightGap:dialog.right-rect.right};
      })()`);
      assert.ok(
        footer,
        "Handoff actions require the standard confirmation footer",
      );
      assert.ok(
        footer.paddingTop >= 16 &&
          footer.paddingBottom >= 16 &&
          footer.paddingLeft >= 20 &&
          footer.paddingRight >= 20 &&
          footer.borderTop >= 1 &&
          footer.flexShrink === "0",
        JSON.stringify(footer),
      );
      assert.ok(
        footer.bottomGap >= 16 && footer.rightGap >= 20,
        "Handoff buttons touch the modal edge: " + JSON.stringify(footer),
      );
      await geometry("Отмена");
      await screenshot("handoff-preview-" + key);
      await stableWrites(uncertainWrites);
      await click("Отмена");
      await noDialog();
      await focused(offer);
      await ev('fixture.handoffMode="uncertain"');
      await click(offer);
      await ready(confirm);
      await click(confirm);
      await until('!!document.querySelector("dialog[open] pre[role=status]")');
      await dialogHas("SYNTHETIC uncertain handoff");
      await dialogHas("SYNTHETIC diagnostic line 89");
      await dialogHas("Автоматического повтора не будет");
      await geometry(close);
      await screenshot("handoff-uncertain-" + key);
      assert.equal(await ev("fixture.opened.length"), 0);
      await stableWrites(uncertainWrites + 1);
      await escape();
      await noDialog();
      await focused(offer);
      await ev(
        'fixture.handoffMode="conflict";fixture.wait=true;fixture.resolve=null',
      );
      await click(offer);
      await ready(confirm);
      await click(confirm);
      await until("!!fixture.resolve");
      await geometry(close);
      await dialogHas("запись не отменяется");
      await ev('fixture.setKey("other")');
      await settle();
      await ev("fixture.resolve();fixture.wait=false");
      await settle();
      assert.equal(
        await ev("fixture.opened.length"),
        0,
        "Late handoff navigated a different owner",
      );
      await noDialog();
      await ev("fixture.setKey(" + JSON.stringify(key) + ")");
      await settle();
      await ev('fixture.reset("none")');
      await ready(offer);
      await click(offer);
      await ready(confirm);
      await click(confirm);
      await until("fixture.opened.length===1");
      assert.equal(
        await ev(
          "JSON.stringify(fixture.opened[0])===JSON.stringify(fixture.scope)",
        ),
        true,
      );
      await noDialog();
      await ready("next-conflict.txt");
      await click("next-conflict.txt");
      await until('!!document.querySelector(".git-conflict-editor")');
      await screenshot("handoff-conflict-workspace-" + key);
      await stableWrites(uncertainWrites + 3);
      assert.equal(
        await ev("document.documentElement.scrollWidth>innerWidth+1"),
        false,
      );
      assert.equal(await ev("fixture.closed"), 0);
      if (collapsed) {
        await click("Развернуть меню");
        await geometry("Свернуть меню");
      }
      report.checks.push({
        width,
        height,
        context: key,
        collapsed,
        handoffPreview: true,
        footer,
        noAutomaticExecution: true,
        cancelAndReadError: true,
        uncertainJournal: true,
        noAutomaticRetry: true,
        lateOwnerIgnored: true,
        confirmedSameOwnerWorkspace: true,
        conflictEditor: true,
        focusRestored: true,
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
  timeout: 105000,
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
