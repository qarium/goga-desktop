// Explicit approval required. Isolated native Electron smoke; never starts the app host.
// Effects: builds fixture bundles under /private/tmp; launches one test Electron process
// with temporary HOME/data/session/logs/temp. No Git, shell, PTY, clipboard or network.
// Real: Terminal renderer+xterm+FitAddon, TopicPickerPopup+TopicPopup+registerIPC guard,
// GitWorkspace/useGitSummary. Synthetic: topic/branch menu items and all service data.
// Run from repository root: node scripts/smoke-git-polish.mjs
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";
const root = fs.mkdtempSync("/private/tmp/goga-git-polish-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));
const source = (p) => JSON.stringify(path.resolve(p));
const renderer = `
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {Terminal as RealTerminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {mountTerminalRenderer} from ${source("src/terminal/index.ts")};
import ${source("src/renderer/style.css")};
import ${source("src/terminal/terminal.css")};
import {TopicPickerPopup} from ${source("src/renderer/TopicPickerPopup.tsx")};
import {GitWorkspace} from ${source("src/renderer/GitWorkspace.tsx")};
const f=window.fixture={errors:[],resizes:[],acks:[],selection:[],sequence:0,scope:'fixture-project',revision:0};
const grant={sessionId:'geometry',generation:'00000000-0000-4000-8000-000000000001',capability:'00000000-0000-4000-8000-000000000002'};
let command,frame;
class Terminal extends RealTerminal{constructor(o){super(o);f.term=this;}}
f.dispose=mountTerminalRenderer(document.getElementById('terminal-root'),{ready(){},link(){throw Error('links disabled')},ack(v){f.acks.push(v)},input(){throw Error('input disabled')},resize(v){f.resizes.push(v)},fault(v){f.errors.push(v)},onFrame(fn){frame=fn;return()=>{}},onCommand(fn){command=fn;return()=>{}}},{Terminal,FitAddon});
command({kind:'grant',grant});command({kind:'select',grant,focus:false});
f.fill=()=>{const text=Array.from({length:f.term.rows*3},(_,i)=>'SYNTHETIC row '+i).join('\\r\\n')+'\\r\\nBOTTOM_VISIBLE_'+f.term.cols+'x'+f.term.rows;frame({...grant,sequence:++f.sequence,text});return f.sequence;};
f.metrics=()=>{const r=document.getElementById('terminal-root').getBoundingClientRect(),s=document.querySelector('.xterm-screen').getBoundingClientRect(),cell=f.term._core._renderService.dimensions.css.cell;const b=f.term.buffer.active;return {cols:f.term.cols,rows:f.term.rows,cell,root:{top:r.top,bottom:r.bottom,width:r.width,height:r.height},screen:{top:s.top,bottom:s.bottom,left:s.left,right:s.right,width:s.width,height:s.height},lastLine:b.getLine(b.viewportY+f.term.rows-1)?.translateToString(true),lastRowBottom:s.top+cell.height*f.term.rows,bottomGap:r.bottom-(s.top+cell.height*f.term.rows),viewportY:b.viewportY,baseY:b.baseY};};
const originalOpen=window.open.bind(window);window.open=(...args)=>{const p=originalOpen(...args);f.popup=p;return p;};
function Fixture(){const anchor=useRef(null),[menu,setMenu]=useState(null),[scope,setScope]=useState('fixture-project'),[revision,setRevision]=useState(0),[open,setOpen]=useState(false),[body,setBody]=useState(null);f.setMenu=x=>flushSync(()=>setMenu(x));f.setScope=x=>{f.scope=x;setScope(x)};f.refresh=()=>setRevision(v=>v+1);f.open=open;
return <><header className="fixture-header"><b>Изолированная native проверка</b><button ref={anchor} onClick={()=>setMenu('topic')}>Топик / ветка</button><GitWorkspace scope={scope} revision={revision} open={open} bodyContainer={body} onOpen={()=>setOpen(true)} onClose={()=>setOpen(false)}/></header><div className="fixture-body" ref={setBody}/>{menu&&<TopicPickerPopup key={menu} anchor={anchor} label={'Тестовое меню '+menu} onClose={()=>setMenu(current=>current===menu?null:current)}><div style={{padding:20,background:'#142033',color:'white'}}><h2>{menu}</h2><button role="menuitem" onClick={async()=>{const result=await window.goga.readGitSummary('fixture-project');f.selection.push({menu,result});setMenu(null)}}>Выбрать {menu}</button></div></TopicPickerPopup>}</>};
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
  "html,body,#root{margin:0;height:100%;overflow:hidden}.fixture-header{height:96px;display:flex;align-items:center;gap:24px;padding:0 24px;background:#101a2b;color:white}#terminal-root{position:absolute;top:96px;bottom:0;height:calc(100% - 96px);width:100%}.fixture-body{position:absolute;inset:96px 0 0;z-index:3;pointer-events:none}.fixture-body:has(.git-workspace:not([hidden])){pointer-events:auto;background:#101a2b}",
);
fs.writeFileSync(
  path.join(root, "index.html"),
  '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' \'unsafe-inline\'; script-src \'self\'; connect-src \'none\'"><link rel="stylesheet" href="renderer.css"></head><body><div id="terminal-root"></div><div id="root"></div><script src="renderer.js"></script></body></html>',
);
fs.writeFileSync(
  path.join(root, "preload.cjs"),
  `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('goga',{readGitSummary:s=>ipcRenderer.invoke('goga:read-git-summary',s),readGitWorkspace:s=>ipcRenderer.invoke('goga:read-git-workspace',s),setTopicPopupBounds:(...a)=>ipcRenderer.invoke('goga:set-topic-popup-bounds',...a),closeTopicPopup:id=>ipcRenderer.invoke('goga:close-topic-popup',id),onTopicPopupClosed:fn=>{const cb=(_,id)=>fn(id);ipcRenderer.on('goga:topic-popup-closed',cb);return()=>ipcRenderer.removeListener('goga:topic-popup-closed',cb)}});`,
);
async function nativeFixture() {
  const { app, BrowserWindow, session, ipcMain } = require("electron"),
    fs = require("node:fs"),
    path = require("node:path"),
    assert = require("node:assert/strict"),
    { pathToFileURL } = require("node:url");
  app.setName("Goga isolated polish test");
  app.commandLine.appendSwitch("disable-background-networking");
  for (const [k, v] of [
    ["home", "home"],
    ["userData", "data"],
    ["sessionData", "session"],
    ["temp", "tmp"],
    ["crashDumps", "crashes"],
  ])
    app.setPath(k, path.join(__dirname, v));
  app.setAppLogsPath(path.join(__dirname, "logs"));
  const report = {
    ok: false,
    layer:
      "Real renderer+xterm/FitAddon, real native TopicPopup and registerIPC; synthetic menus and service data. No production HostService, PTY or Git.",
    checks: [],
    screenshots: [],
    ipc: [],
    errors: [],
  };
  let win, popup, foreign;
  let count = 2,
    conflicts = 0,
    readError = false;
  const deadline = setTimeout(() => app.exit(2), 90000);
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
    session.defaultSession.setPermissionCheckHandler(() => false);
    win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 800,
      useContentSize: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const shellURL = pathToFileURL(path.join(__dirname, "index.html")).href;
    popup = new TopicPopup(win, shellURL);
    const admitted = new Set([
      "goga:set-topic-popup-bounds",
      "goga:close-topic-popup",
      "goga:read-git-summary",
      "goga:read-git-workspace",
    ]);
    registerIPC(
      {
        handle(name, handler) {
          if (!admitted.has(name)) return;
          ipcMain.handle(name, async (event, ...args) => {
            const entry = {
              name,
              sender: event.sender.id,
              isShell: event.sender === win.webContents,
              mainFrame: event.senderFrame?.parent === null,
              url: event.senderFrame?.url,
            };
            report.ipc.push(entry);
            try {
              if (name === "goga:close-topic-popup")
                await new Promise((r) => setTimeout(r, 80));
              const value = await handler(event, ...args);
              entry.allowed = true;
              return value;
            } catch (e) {
              entry.allowed = false;
              entry.error = String(e);
              throw e;
            }
          });
        },
      },
      {
        window: win,
        shellURL,
        topicPopup: popup,
        service: {
          readGitSummary(scope) {
            if (readError) throw Error("SYNTHETIC summary unavailable");
            return {
              scope,
              branch: "feature/synthetic",
              changedFiles: count,
              conflicts,
            };
          },
          readGitWorkspace(scope) {
            return {
              scope,
              root: "/synthetic/fixture",
              revision: "a".repeat(64),
              head: "b".repeat(40),
              branch: "feature/synthetic",
              upstream: null,
              ahead: 0,
              behind: 0,
              operation: "none",
              files: [],
            };
          },
        },
      },
    );
    win.webContents.on("console-message", (e) => {
      if (e.level === "error") report.errors.push(e.message);
    });
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    const ev = (s) => win.webContents.executeJavaScript(s),
      wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (s, ms = 6000) => {
      for (let i = 0; i < ms / 25; i++) {
        if (await ev(s)) return;
        await wait(25);
      }
      throw Error("Timeout: " + s);
    };
    const shot = async (name, wc = win.webContents) => {
      await wait(120);
      const p = path.join(__dirname, name + ".png");
      fs.writeFileSync(p, (await wc.capturePage()).toPNG());
      report.screenshots.push(p);
    };
    await win.loadFile(path.join(__dirname, "index.html"));
    await until("!!window.fixture?.setMenu");
    // show:false avoids activating or disturbing user Goga; backgroundThrottling:false
    // gives Chromium a visible document for timer-based summary updates.
    assert.equal(await ev("document.visibilityState"), "visible");
    for (const [width, height] of [
      [1280, 800],
      [960, 640],
    ]) {
      win.setContentSize(width, height);
      await wait(150);
      await ev('window.dispatchEvent(new Event("resize"))');
      await wait(100);
      const seq = await ev("fixture.fill()");
      await until("fixture.acks.some(x=>x.sequence===" + seq + ")");
      await wait(100);
      const m = await ev("fixture.metrics()");
      assert.ok(m.rows > 10 && m.cols > 20, JSON.stringify(m));
      assert.ok(m.bottomGap >= 7.5, JSON.stringify(m));
      assert.ok(m.bottomGap < 8 + m.cell.height + 1, JSON.stringify(m));
      assert.ok(m.screen.right <= width - 7, JSON.stringify(m));
      assert.equal(m.lastLine, "BOTTOM_VISIBLE_" + m.cols + "x" + m.rows);
      assert.equal(m.viewportY, m.baseY);
      assert.deepEqual(await ev("fixture.errors"), []);
      await shot("terminal-" + width + "x" + height);
      report.checks.push({
        kind: "real-xterm-fit-bottom",
        width,
        height,
        ...m,
      });
      // Constrain only the host viewport (window unchanged): a sidebar-width step and
      // non-row-multiple 201px height above a simulated footer. The real renderer resize
      // event is dispatched because this fixture uses a DOM host instead of terminal WebContentsView.
      await ev(
        'document.getElementById("terminal-root").style.cssText="position:absolute;top:96px;width:calc(100% - 236px);height:201px;bottom:auto";window.dispatchEvent(new Event("resize"))',
      );
      await wait(100);
      const constrainedSequence = await ev("fixture.fill()");
      await until(
        "fixture.acks.some(x=>x.sequence===" + constrainedSequence + ")",
      );
      await wait(100);
      const constrained = await ev("fixture.metrics()");
      assert.equal(constrained.root.height, 201);
      assert.equal(constrained.root.width, width - 236);
      assert.ok(
        constrained.bottomGap >= 7.5 &&
          constrained.bottomGap < 8 + constrained.cell.height + 1,
        JSON.stringify(constrained),
      );
      assert.ok(constrained.screen.right <= width - 236 - 7);
      assert.equal(
        constrained.lastLine,
        "BOTTOM_VISIBLE_" + constrained.cols + "x" + constrained.rows,
      );
      await shot("terminal-host-201px-" + width);
      report.checks.push({
        kind: "real-xterm-host-resize",
        windowUnchanged: true,
        resizeNotification:
          "explicit DOM resize event, not native terminal WebContentsView",
        ...constrained,
      });
      await ev(
        'document.getElementById("terminal-root").removeAttribute("style");window.dispatchEvent(new Event("resize"))',
      );
      await wait(100);
      await until(
        'document.querySelector(".git-changes-count")?.textContent==="' +
          count +
          '"',
      );
      count = 7;
      conflicts = 2;
      await until(
        'document.querySelector(".git-changes-count")?.textContent==="7"',
        7000,
      );
      assert.ok(await ev('!!document.querySelector(".git-changes-warning")'));
      await shot("summary-conflicts-" + width);
      count = 0;
      conflicts = 0;
      await until(
        'document.querySelector(".git-changes-count")?.textContent==="0"',
        7000,
      );
      assert.ok(
        await ev(
          'document.querySelector(".git-changes-count").classList.contains("quiet")',
        ),
      );
      assert.equal(
        await ev('!!document.querySelector(".git-changes-warning")'),
        false,
      );
      report.checks.push({
        kind: "summary-timer-poll",
        width,
        height,
        states: width === 1280 ? [2, 7, 0] : [0, 7, 0],
        conflictsWarningCleared: true,
      });
      // Popup callbacks below execute in the original shell closure even though their
      // DOM lives inside the adopted native WebContentsView.
      await ev('fixture.setMenu("topic")');
      await until('!!fixture.popup?.document.querySelector("[role=menuitem]")');
      await wait(150);
      assert.ok(popup.isOpen);
      const child = () =>
        win.contentView.children.find((v) => v.webContents)?.webContents;
      assert.ok(child());
      await shot("native-topic-" + width, child());
      const popupBridge = await child().executeJavaScript("typeof window.goga");
      assert.equal(
        popupBridge,
        "undefined",
        "Production native child must not acquire a bridge",
      );
      foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      foreign.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      await foreign.loadURL(shellURL);
      const foreignDenied = await foreign.webContents.executeJavaScript(
        'window.goga.readGitSummary(\"fixture-project\").then(()=>false,e=>String(e).includes(\"доступ запрещён\"))',
      );
      assert.equal(
        foreignDenied,
        true,
        "Foreign renderer with same URL must not gain shell authority",
      );
      foreign.destroy();
      foreign = null;
      await ev(
        'fixture.popup.document.querySelector("[role=menuitem]").click()',
      );
      await until("fixture.selection.length>0");
      await wait(120);
      assert.equal(popup.isOpen, false);
      // Two immediate replacements, with real close acknowledgement delayed 80ms.
      await ev('fixture.setMenu("topic-again")');
      await until('!!fixture.popup?.document.querySelector("[role=menuitem]")');
      await ev(
        'fixture.setMenu("branch-intermediate");fixture.setMenu("branch-final")',
      );
      await until(
        'fixture.popup?.document.querySelector("[role=menuitem]")?.textContent==="Выбрать branch-final"',
      );
      await wait(150);
      assert.ok(popup.isOpen);
      assert.equal(win.contentView.children.length, 1);
      assert.equal(await ev('!!document.querySelector("[role=alert]")'), false);
      await shot("native-branch-final-" + width, child());
      const before = await ev("fixture.selection.length");
      await ev(
        'fixture.popup.document.querySelector("[role=menuitem]").click()',
      );
      await until("fixture.selection.length===" + String(before + 1));
      await wait(120);
      assert.equal(popup.isOpen, false);
      assert.equal(win.contentView.children.length, 0);
      report.checks.push({
        kind: "native-popup-lifecycle",
        width,
        height,
        rapidReplacement: true,
        noOrphanView: true,
        portalCallbackAuthorized: true,
        popupBridgeAbsent: true,
        foreignSameURLIPCDenied: true,
      });
    }
    readError = true;
    await until(
      'document.querySelector(".git-changes-count")?.textContent==="—"',
      7000,
    );
    assert.ok(await ev('!!document.querySelector(".git-changes-warning")'));
    await shot("summary-read-error");
    readError = false;
    count = 4;
    await until(
      'document.querySelector(".git-changes-count")?.textContent==="4"',
      7000,
    );
    report.checks.push({
      kind: "summary-error-recovery",
      errorShown: true,
      recovered: 4,
    });
    assert.ok(report.ipc.some((e) => !e.isShell && !e.allowed));
    assert.ok(
      report.ipc
        .filter((e) => e.allowed)
        .every((e) => e.isShell && e.mainFrame && e.url === shellURL),
    );
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
    clearTimeout(deadline);
    foreign?.destroy();
    popup?.dispose();
    win?.destroy();
    app.exit(report.ok ? 0 : 1);
  }
}
const main = `import {TopicPopup} from ${source("src/main/topic-popup.ts")};import {registerIPC} from ${source("src/main/ipc.ts")};(${nativeFixture.toString()})();`;
await build({
  stdin: { contents: main, loader: "ts", resolveDir: process.cwd() },
  outfile: path.join(root, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const run = spawnSync(electron, [path.join(root, "main.cjs")], {
  env: {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "home"),
    XDG_CACHE_HOME: path.join(root, "data"),
    TMPDIR: path.join(root, "tmp"),
    LANG: "en_US.UTF-8",
  },
  encoding: "utf8",
  timeout: 100000,
});
fs.writeFileSync(path.join(root, "stdout.log"), run.stdout ?? "");
fs.writeFileSync(path.join(root, "stderr.log"), run.stderr ?? "");
console.log(run.stdout ?? "");
console.error(run.stderr ?? "");
console.log("fixture:", root);
if (run.error) console.error(run.error);
process.exitCode = run.status ?? 1;
