// Explicit approval required: isolated Electron, real renderer, synthetic bridge.
// No production Host, Git, shell, clipboard, network or user profile access.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = fs.mkdtempSync("/private/tmp/goga-git-merge-operations-ui-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));
const renderer = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GitWorkspace} from ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.tsx"))};
import {RetainedViews} from ${JSON.stringify(path.resolve("src/renderer/RetainedViews.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
const scopes={primary:'fixture-p',other:'fixture-q',topic:{projectId:'fixture-p',year:'2026',topic:'topic-alpha',branch:'topic-alpha',contextId:'ctx-'+ 'c'.repeat(64),revision:'11111111-1111-4111-8111-111111111111'}};
const id=s=>JSON.stringify(s), rev='a'.repeat(64), tickets=new Map();
const fixture=window.fixture={reads:[],prepares:[],executes:[],changed:[],closed:0,mode:'success',wait:false,operations:new Map(),overlays:new Map(),busy:new Map()};
const operation=s=>fixture.operations.get(id(s))??'merge';
window.goga={
 readGitWorkspace:async scope=>{fixture.reads.push(scope);return {scope,root:'/synthetic/'+(typeof scope==='string'?scope:scope.topic),revision:rev,head:'b'.repeat(40),branch:typeof scope==='string'?'main':scope.branch,upstream:null,ahead:0,behind:0,operation:operation(scope),files:[]};},
 prepareGitMergeOperation:async request=>{fixture.prepares.push(request);const p={...request,token:fixture.prepares.length.toString(16).padStart(64,'0'),root:'/synthetic/'+(typeof request.scope==='string'?request.scope:request.scope.topic),operation:'merge',branch:typeof request.scope==='string'?'main':request.scope.branch,head:'b'.repeat(40),sourceOid:'c'.repeat(40),paths:Array.from({length:18},(_,i)=>'src/features/component-'+i+'/long-but-realistic-file-name.ts'),effects:request.action==='abort'?'Отменить незавершённое слияние, сохранив посторонние изменения.':'Создать локальный merge-коммит из разрешённого слияния.',message:request.message??'Merge topic into main',author:'Fixture User <fixture@example.invalid>',committer:'Fixture User <fixture@example.invalid>',signing:false,hooks:'disabled',expiresAt:Date.now()+300000};tickets.set(p.token,p);return p;},
 executeGitMergeOperation:async token=>{fixture.executes.push(token);const p=tickets.get(token);if(!p)throw Error('Unknown synthetic token');if(fixture.wait)await new Promise(r=>fixture.resolve=r);const success=fixture.mode==='success';if(success)fixture.operations.set(id(p.scope),'none');return {scope:p.scope,operation:'merge',action:p.action,status:success?'success':'uncertain',changed:true,commit:p.action==='continue'?'d'.repeat(40):undefined,lockRetained:!success,recoveryPath:success?undefined:'/synthetic/recovery',retainedLocks:success?[]:['/synthetic/.git/config.lock'],uncheckedLocks:success?[]:['/synthetic/.git/index.lock'],recoveryUnverified:!success,message:success?'Слияние обработано':'Неопределённый результат тестовой операции',log:success?'SYNTHETIC SUCCESS':Array.from({length:90},(_,i)=>'SYNTHETIC diagnostic line '+i).join('\\n')};},
};
fixture.button=label=>[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent.trim())===label);
fixture.edit=text=>{const t=document.querySelector('textarea[aria-label="Сообщение merge-коммита"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,text);t.dispatchEvent(new Event('input',{bubbles:true}));};
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
  app.setName("Goga isolated merge operation test");
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
      await until('!!window.fixture?.button("Завершить слияние…")');
      await ev(`fixture.setKey('${key}');fixture.setCollapsed(${collapsed})`);
      await settle();
      await until(
        '!!fixture.button("Завершить слияние…")&&!fixture.button("Завершить слияние…").disabled',
      );
      await geometry("Завершить слияние…");
      await geometry("Отменить слияние…");
      await screenshot("footer-" + key);
      await click("Завершить слияние…");
      await until('!!fixture.button("Создать merge-коммит")');
      await geometry("Создать merge-коммит");
      assert.ok(
        await ev(`(() => {
        const footer = document.querySelector('.git-merge-operation-confirm');
        const notice = [...footer.querySelectorAll('p')].find(p => p.textContent.includes('Git-хуки отключены'));
        if (!notice) return false;
        const r = notice.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight;
      })()`),
      );
      await screenshot("continue-" + key);
      await ev('fixture.edit("Reviewed merge message")');
      await settle();
      assert.ok(
        await ev(
          '!fixture.button("Создать merge-коммит")||fixture.button("Создать merge-коммит").disabled',
        ),
      );
      await click("Проверить сообщение");
      await until(
        '!!fixture.button("Создать merge-коммит")&&!fixture.button("Создать merge-коммит").disabled',
      );
      assert.equal(
        await ev("fixture.prepares.at(-1).message"),
        "Reviewed merge message",
      );
      await ev("fixture.wait=true");
      await click("Создать merge-коммит");
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
      await ev(`fixture.setKey('${key}')`);
      await settle();
      await until('!fixture.button("Завершить слияние…")');
      await ev(
        'fixture.operations.set(JSON.stringify(fixture.scope),"merge");fixture.wait=false;fixture.mode="uncertain"',
      );
      await click("Обновить изменения");
      await until(
        '!!fixture.button("Отменить слияние…")&&!fixture.button("Отменить слияние…").disabled',
      );
      await click("Отменить слияние…");
      await until('!!fixture.button("Отменить слияние")');
      await geometry("Отменить слияние");
      await screenshot("abort-" + key);
      await click("Отменить слияние");
      await until('!!fixture.button("Закрыть результат слияния")');
      assert.ok(
        await ev(
          'document.querySelector("dialog[open]").textContent.includes("/synthetic/recovery")',
        ),
      );
      assert.ok(
        await ev(
          'document.querySelector("dialog[open]").textContent.includes("/synthetic/.git/index.lock")',
        ),
      );
      await geometry("Закрыть результат слияния");
      await screenshot("uncertain-" + key);
      await escape();
      await until('!document.querySelector("dialog[open]")');
      assert.equal(await ev("fixture.closed"), 0);
      assert.equal(await ev("fixture.executes.length"), 2);
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
        confirmationVisible: true,
        messageTokenReprepared: true,
        lateSuccessRoutedToOriginal: true,
        uncertainDiagnosticsClosable: true,
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
