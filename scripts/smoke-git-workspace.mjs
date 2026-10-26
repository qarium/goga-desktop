// Explicitly invoked only with user approval. Actual renderer, synthetic bridge,
// temporary HOME/profile, no production host, Git, shell, clipboard or network.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = fs.mkdtempSync("/private/tmp/goga-git-ui-");
for (const dir of ["home", "data", "session", "crashes", "logs", "tmp"])
  fs.mkdirSync(path.join(root, dir));
const renderer = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GitWorkspace} from ${JSON.stringify(path.resolve("src/renderer/GitWorkspace.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
const fixture=window.fixture={calls:[],scope:null};
const files=['src/renderer/Changes.tsx','src/host/selected-files-with-a-long-name.ts','notes/new file.txt'];
const revision='a'.repeat(64);
window.goga={
 readGitWorkspace:async scope=>({scope,root:'/synthetic/'+scope,revision,head:'b'.repeat(40),branch:'feature/git-workspace',upstream:null,ahead:0,behind:0,operation:'none',files:files.map(path=>({path,indexStatus:'.',worktreeStatus:'M',kind:'tracked',submodule:false}))}),
 readGitDiff:async r=>({...r,staged:{kind:'empty',text:''},unstaged:{kind:'patch',text:'@@ -1,2 +1,2 @@\\n-before\\n+after\\n'+Array.from({length:80},(_,i)=>' line '+i).join('\\n')}}),
 prepareGitCommit:async r=>({...r,token:'1'.repeat(64),root:'/synthetic/'+r.scope,branch:'feature/git-workspace',wholeFiles:true,deletedCount:0,author:'Fixture <fixture@example.invalid>',committer:'Fixture <fixture@example.invalid>',signing:true,hooks:'disabled',expiresAt:Date.now()+300000}),
 executeGitCommit:async token=>{fixture.calls.push(token);return {scope:fixture.scope,status:'not-committed',indexPublished:false,message:'Тестовая ошибка подписи: коммит не создан.',log:'SYNTHETIC SIGNER FAILURE — no real Git process was started.'};},
};
function Fixture(){const[scope,setScope]=useState('fixture-wide');const[body,setBody]=useState(null);fixture.scope=scope;fixture.setScope=setScope;
 return <div className="fixture-shell"><header className="fixture-title">Goga <small>DESKTOP · изолированная проверка</small></header>
 <div className="fixture-content"><aside className="fixture-sidebar"><strong>Мой компьютер</strong><p>Тестовый проект</p></aside>
 <main className="fixture-main"><div className="fixture-context"><span>/synthetic/{scope}</span><GitWorkspace scope={scope} open={true} bodyContainer={body} onOpen={()=>{}} onClose={()=>{fixture.closed=true}} revision={0}/></div>
 <div className="git-workspace-stage" ref={setBody}/></main></div></div>;
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
  app.setName("Goga isolated Git UI test");
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
      await until('!!document.querySelector(".git-file-row input")');
      await click(".git-file-row button");
      await until('!!document.querySelector(".git-diff-code")');
      await click(".git-file-row input");
      await ev('document.querySelector(".git-commit-form textarea").focus()');
      await win.webContents.insertText("Выбранные изменения");
      await settle();
      await checkButton(".git-commit-input-row button");
      const layout = await ev(
        '(()=>{const e=document.querySelector(".git-workspace"),f=document.querySelector(".git-workspace-footer"),r=f.getBoundingClientRect();return {overflow:e.scrollWidth>e.clientWidth+1,footer:r.bottom<=innerHeight&&r.top>0};})()',
      );
      assert.equal(layout.overflow, false);
      assert.equal(layout.footer, true);
      await screenshot("changes-" + name);
      await click(".git-commit-input-row button");
      await until('!!document.querySelector(".git-commit-modal[open]")');
      await settle();
      await checkButton(".git-commit-preview button");
      assert.ok(
        await ev(
          'document.querySelector(".git-commit-modal").textContent.includes("Git-хуки не запускаются")',
        ),
      );
      await screenshot("confirmation-" + name);
      await click(".git-commit-preview button");
      await until('!!document.querySelector(".git-workspace-error[open]")');
      await settle();
      assert.ok(
        await ev(
          'document.querySelector(".git-workspace-error").textContent.includes("SYNTHETIC SIGNER FAILURE")',
        ),
      );
      await checkButton(".git-workspace-error header button");
      await screenshot("error-" + name);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await settle();
      await until('!document.querySelector(".git-workspace-error")');
      assert.equal(
        await ev('document.querySelector(".git-commit-form textarea").value'),
        "Выбранные изменения",
      );
      assert.equal(
        await ev('document.querySelector(".git-file-row input").checked'),
        true,
      );
      report.checks.push({
        width,
        height,
        layout,
        preview: true,
        errorClosable: true,
        draftPreserved: true,
      });
    }
    assert.equal(await ev("fixture.calls.length"), 2);
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
