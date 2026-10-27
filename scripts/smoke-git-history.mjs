// Explicit user approval required: synthetic UI in a separate Electron profile.
// No production host, Git commands, shells, network, clipboard or user projects.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";
const root = fs.mkdtempSync("/private/tmp/goga-git-history-ui-");
for (const name of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, name));
const renderer = `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{GitHistory}from ${JSON.stringify(path.resolve("src/renderer/GitHistory.tsx"))};
import{GitWorkspace}from ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.tsx"))};
import{RetainedViews}from ${JSON.stringify(path.resolve("src/renderer/RetainedViews.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
const oid='a'.repeat(40),parent='b'.repeat(40),other='c'.repeat(40);
const fixture=window.fixture={reads:[],fail:false};
const entry=(scope,n=0)=>({oid:n?String(n).padStart(40,'0'):oid,parents:[parent,other],subject:n?'Older commit '+n:'Merge: readable history for '+scope,author:'Fixture Author',authoredAt:'2026-10-27T12:00:00+03:00',committedAt:'2026-10-27T12:00:00+03:00',refs:n?[]:['refs/heads/main','refs/remotes/origin/main']});
window.goga={
readGitSummary:async scope=>({scope,branch:'main',changedFiles:0,conflicts:0}),
readGitWorkspace:async scope=>({scope,root:'/synthetic/'+scope,revision:'a'.repeat(64),head:oid,branch:'main',upstream:null,ahead:0,behind:0,operation:'none',files:[]}),
readGitHistory:async r=>{fixture.reads.push(['list',r]);if(fixture.fail)throw Error('SYNTHETIC HISTORY ERROR');return{...r,currentBranch:'main',tip:oid,commits:Array.from({length:50},(_,i)=>entry(r.scope,i+r.offset)),nextOffset:r.offset?null:50}},
readGitHistoryRefs:async scope=>({scope,currentBranch:'main',local:[{name:'main',ref:'refs/heads/main'},{name:'feature/readable-history',ref:'refs/heads/feature/readable-history'}],remote:[{name:'origin/main',ref:'refs/remotes/origin/main'}]}),
readGitCommit:async r=>{fixture.reads.push(['details',r]);return{...r,commit:entry(r.scope),parent:r.parentIndex?other:parent,message:'Merge message\\n\\nDetailed commit description',files:Array.from({length:45},(_,i)=>({path:(r.parentIndex?'incoming/':'src/')+'file-'+i+'.ts',status:'M',additions:200,deletions:10})),nextFileOffset:null}},
readGitCommitDiff:async r=>{fixture.reads.push(['diff',r]);return{...r,parent:r.parentIndex?other:parent,part:{kind:'patch',text:'@@ -1,600 +1,600 @@\\n'+Array.from({length:600},(_,i)=>'+'+r.scope+' line '+i).join('\\n')}}}
};
function Fixture(){const[scope,setScope]=useState('alpha'),[page,setPage]=useState('terminal'),[collapsed,setCollapsed]=useState(false),[stage,setStage]=useState(null);fixture.setScope=setScope;fixture.setPage=setPage;fixture.collapse=()=>setCollapsed(v=>!v);return <div className="fixture-shell"><header className="fixture-title">Goga <small>DESKTOP · изолированная проверка</small></header><div className="fixture-content"><aside className={'fixture-sidebar'+(collapsed?' collapsed':'')}><button onClick={()=>setScope(scope==='alpha'?'beta':'alpha')}>Проект</button><button onClick={()=>setCollapsed(v=>!v)}>Меню</button></aside><main className="fixture-main"><div className="fixture-context"><span>/synthetic/{scope}</span><RetainedViews activeKey={scope}><><GitWorkspace scope={scope} open={page==='changes'} revision={0} bodyContainer={stage} onOpen={()=>setPage('changes')} onClose={()=>setPage('terminal')} historyOpen={page==='commits'} onHistoryOpen={()=>setPage('commits')} onHistoryClose={()=>setPage('terminal')}/><GitHistory scope={scope} open={page==='commits'} revision={0} bodyContainer={stage} onClose={()=>setPage('terminal')}/></></RetainedViews></div><div className="git-workspace-stage" ref={setStage} hidden={page==='terminal'}/><div className="fixture-terminal" hidden={page!=='terminal'}>Сохранённый экран терминала · только подставной текст</div></main></div></div>}
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
html,body,#root{height:100%;overflow:hidden}.fixture-shell{height:100%;display:flex;flex-direction:column}.fixture-title{height:54px;flex:none;padding:15px 24px;border-bottom:1px solid var(--line);font-size:20px;font-weight:700;color:var(--teal)}.fixture-title small{margin-left:14px;font-size:11px;color:var(--muted)}.fixture-content{display:flex;flex:1;min-height:0}.fixture-sidebar{width:208px;padding:28px 12px;flex:none;background:#0e1424;border-right:1px solid var(--line)}.fixture-sidebar.collapsed{width:72px}.fixture-sidebar button{display:block;font-size:12px;padding:5px;margin-bottom:12px}.fixture-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column}.fixture-context{height:44px;flex:none;display:flex;align-items:center;justify-content:space-between;padding:0 20px;gap:12px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}.fixture-terminal{padding:24px}
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
  app.setName("Goga isolated commit history test");
  for (const [key, name] of [
    ["userData", "data"],
    ["sessionData", "session"],
    ["crashDumps", "crashes"],
  ])
    app.setPath(key, path.join(__dirname, name));
  app.setAppLogsPath(path.join(__dirname, "logs"));
  const report = { ok: false, checks: [], screenshots: [], errors: [] };
  const deadline = setTimeout(() => app.exit(2), 45000);
  let win;
  try {
    await app.whenReady();
    app.dock?.hide();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (_, done) => done({ cancel: true }),
    );
    win = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
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
    const ev = (code) => win.webContents.executeJavaScript(code);
    const settle = () =>
      ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const until = async (code) => {
      for (let i = 0; i < 150; i++) {
        if (await ev(code)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("DOM timeout: " + code);
    };
    const click = async (selector) => {
      await ev(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await settle();
    };
    const fit = async (selector) => {
      const result = await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),at=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {width:r.width,height:r.height,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:!!at&&(at===e||e.contains(at))}})()`,
      );
      assert.ok(
        result.inside && result.hit && result.width > 10 && result.height > 10,
        JSON.stringify({ selector, result }),
      );
    };
    await win.loadFile(path.join(__dirname, "index.html"));
    for (const [width, height, name] of [
      [1440, 900, "wide"],
      [1024, 768, "narrow"],
    ]) {
      win.setContentSize(width, height);
      await ev(`fixture.setScope('${name}');fixture.setPage('terminal')`);
      await settle();
      await fit('button[aria-label="Коммиты"]');
      await click('button[aria-label="Коммиты"]');
      await until(
        'document.querySelector(".git-history:not([hidden]) .git-history-row")',
      );
      assert.equal(
        await ev(
          'document.querySelector(".git-history:not([hidden]) .git-history-details")===null',
        ),
        true,
      );
      await click(".git-history:not([hidden]) .git-history-row");
      await until(
        'document.querySelector(".git-history:not([hidden]) .git-history-files button")',
      );
      await click(".git-history:not([hidden]) .git-history-files button");
      await until(
        'document.querySelector(".git-history:not([hidden]) .git-diff-code")',
      );
      await fit(
        '.git-history:not([hidden]) [aria-label="Закрыть детали коммита"]',
      );
      await fit('.git-history:not([hidden]) [aria-label="Следующие строки"]');
      const scroll = await ev(
        `(()=>{const h=document.querySelector('.git-history:not([hidden])'),d=h.querySelector('.git-history-diff'),f=h.querySelector('.git-history-files'),l=h.querySelector('.git-history-list');d.scrollTop=250;f.scrollTop=120;l.scrollTop=80;return [d.scrollTop,f.scrollTop,l.scrollTop]})()`,
      );
      assert.ok(
        scroll.every((n) => n > 0),
        JSON.stringify(scroll),
      );
      await click('button[aria-label="Изменения, файлов: 0"]');
      await click('button[aria-label="Коммиты"]');
      assert.deepEqual(
        await ev(
          `(()=>{const h=document.querySelector('.git-history:not([hidden])');return ['.git-history-diff','.git-history-files','.git-history-list'].map(s=>h.querySelector(s).scrollTop)})()`,
        ),
        scroll,
      );
      const savedReads = await ev("fixture.reads.length");
      await ev("fixture.setScope('other')");
      await settle();
      await ev(`fixture.setScope('${name}')`);
      await settle();
      assert.deepEqual(
        await ev(
          `(()=>{const h=document.querySelector('.git-history:not([hidden])');return ['.git-history-diff','.git-history-files','.git-history-list'].map(s=>h.querySelector(s).scrollTop)})()`,
        ),
        scroll,
      );
      assert.ok(
        await ev(
          `fixture.reads.slice(${savedReads}).every(row=>row[1].scope==='other')`,
        ),
      );
      await ev("fixture.collapse()");
      await settle();
      await fit(
        '.git-history:not([hidden]) [aria-label="Закрыть историю коммитов"]',
      );
      await ev(
        `(()=>{const h=document.querySelector('.git-history:not([hidden])');h.querySelectorAll('.git-history-list,.git-history-files,.git-history-diff').forEach(e=>e.scrollTop=0)})()`,
      );
      await fit(
        '.git-history:not([hidden]) [aria-label="Текущее состояние Git"]',
      );
      assert.equal(
        await ev(
          `document.querySelector('.git-history:not([hidden]) [aria-label="Текущее состояние Git"]').textContent.includes('main')`,
        ),
        true,
      );
      assert.equal(
        await ev(
          `document.querySelector('.git-history:not([hidden]) button[aria-label^="Ветка просмотра"]')===null`,
        ),
        true,
      );
      assert.equal(
        await ev(
          `fixture.reads.filter(row=>row[0]==='list').every(row=>row[1].ref==='HEAD')`,
        ),
        true,
      );
      await click(".git-history:not([hidden]) .git-history-row");
      await until(
        'document.querySelector(".git-history:not([hidden]) .git-history-files button")',
      );
      await ev(
        `(()=>{const s=document.querySelector('.git-history:not([hidden]) select');s.value='1';s.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      );
      await settle();
      assert.ok(
        await ev(
          `document.querySelector('.git-history:not([hidden]) .git-history-files').textContent.includes('incoming/')`,
        ),
      );
      await click(".git-history:not([hidden]) .git-history-files button");
      await settle();
      await ev(
        `document.querySelector('.git-history:not([hidden]) [role="separator"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`,
      );
      await settle();
      const screenshot = path.join(__dirname, name + ".png");
      fs.writeFileSync(
        screenshot,
        (await win.webContents.capturePage()).toPNG(),
      );
      report.screenshots.push(screenshot);
      await fit(
        '.git-history:not([hidden]) [aria-label="Закрыть детали коммита"]',
      );
      await click('.git-history:not([hidden]) [aria-label^="Закрыть файл"]');
      assert.equal(
        await ev(
          'document.querySelector(".git-history:not([hidden]) .git-diff-code")===null',
        ),
        true,
      );
      await ev("fixture.fail=true");
      await click(
        '.git-history:not([hidden]) [aria-label="Обновить историю коммитов"]',
      );
      await until(
        'document.body.textContent.includes("SYNTHETIC HISTORY ERROR")',
      );
      await fit('[aria-label="Закрыть ошибку истории"]');
      await click('[aria-label="Закрыть ошибку истории"]');
      assert.equal(
        await ev(
          'document.querySelector(".git-history:not([hidden]) [aria-busy=true]")===null',
        ),
        true,
      );
      await ev("fixture.fail=false");
      await click(
        '.git-history:not([hidden]) [aria-label="Закрыть историю коммитов"]',
      );
      assert.equal(
        await ev('document.querySelector(".fixture-terminal").hidden'),
        false,
      );
      report.checks.push({
        width,
        height,
        emptySelection: true,
        independentScroll: true,
        retainedScroll: true,
        currentHeadIndicator: true,
        parentSelection: true,
        linePaging: true,
        sidebarResize: true,
        errorClosable: true,
      });
    }
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
    clearTimeout(deadline);
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
