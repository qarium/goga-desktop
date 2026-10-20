// Disposable native Electron acceptance fixture. No production host, app state,
// pipelines, OS clipboard, or network. Only the actual renderer is bundled.
import { build } from "esbuild";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = path.resolve(`work/ui-yaml-${Date.now()}`);
mkdirSync(path.join(root, "home"), { recursive: true });
const config =
  "# Личная конфигурация — synthetic fixture\r\nmodel: \"demo-model\"\nretries: 3\r\nenabled: true\nunknown_field: 'сохранить 🙂'\r\nprompt: |\n  первая строка\r\n  вторая строка\n";
const profile =
  "# Личный профиль — synthetic fixture\nname: \"careful\"\nmax_rounds: 7\nenabled: false\nunknown_field: 'цитата 🙂'\ninstructions: |\n  Первая строка\n  Вторая строка\n";
const renderer = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {EditorView} from '@codemirror/view';
import {undoDepth,redoDepth} from '@codemirror/commands';
import {App} from ${JSON.stringify(path.resolve("src/renderer/App.tsx"))};
import ${JSON.stringify(path.resolve("src/renderer/style.css"))};
const cspViolations=[];document.addEventListener('securitypolicyviolation',e=>cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI}));
const docs={config:{text:${JSON.stringify(config)},version:'v1'},profile:{text:${JSON.stringify(profile)},version:'v1'}};
let runsListener=()=>{};let resolver=null;
const fixture=window.fixture={docs,cspViolations,calls:[],hold:false,rerender:()=>runsListener([]),release:()=>resolver?.(),content:()=>document.querySelector('.yaml-code-editor')?.shadowRoot?.querySelector('.cm-content'),view:()=>EditorView.findFromDOM(fixture.content()),snapshot:()=>{const v=fixture.view();return {doc:v.state.doc.toString(),anchor:v.state.selection.main.anchor,head:v.state.selection.main.head,undo:undoDepth(v.state),redo:redoDepth(v.state),readOnly:v.state.readOnly,editable:v.contentDOM.contentEditable}},captureView:()=>{fixture.original=fixture.view()},sameView:()=>fixture.original===fixture.view()};
window.goga={listProjects:async()=>[{id:'synthetic',name:'YAML acceptance',path:'/synthetic/acceptance'}],runs:async()=>[],onRuns:cb=>{runsListener=cb;return()=>{}},onFocusRun:()=>()=>{},onViewError:()=>()=>{},selectRun:async()=>{},chooseProject:async()=>null,listSettings:async()=>({profiles:['careful']}),readSettings:async kind=>structuredClone(docs[kind]),saveSettings:async(kind,name,text,version)=>{fixture.calls.push({kind,name,text,version});if(fixture.hold)await new Promise(r=>resolver=r);docs[kind]={text,version:'v'+(fixture.calls.length+1)};return structuredClone(docs[kind])},readProjectSettings:async()=>({value:{executable:'goga',profile:'',env:[]},version:'v1',profiles:[]}),launch:async()=>{throw Error('Fixture forbids launch')},stopRun:async()=>{throw Error('Fixture forbids stop')},closeRun:async()=>{throw Error('Fixture forbids close')}};
createRoot(document.getElementById('root')).render(<App/>);
`;

async function runFixture() {
  const { app, BrowserWindow, session } = require("electron");
  const fs = require("node:fs");
  const path = require("node:path");
  const assert = require("node:assert/strict");
  app.setName("Goga disposable YAML acceptance");
  for (const [name, dir] of [
    ["userData", "data"],
    ["sessionData", "session"],
    ["crashDumps", "crashes"],
  ])
    app.setPath(name, path.join(__dirname, dir));
  app.setAppLogsPath(path.join(__dirname, "logs"));
  const watchdog = setTimeout(() => {
    console.error("Fixture timeout");
    app.exit(2);
  }, 60000);
  let win;
  const report = {
    visibleWindows: 0,
    network: "blocked",
    clipboard: "untouched; synthetic ClipboardEvent only",
    host: "fake API; no real preferences or pipelines",
    checks: [],
    screenshots: [],
  };
  try {
    await app.whenReady();
    app.dock?.hide();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_, done) => done({ cancel: true }),
    );
    win = new BrowserWindow({
      show: false,
      width: 1320,
      height: 900,
      useContentSize: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    const wc = win.webContents;
    const ev = (s) => wc.executeJavaScript(s);
    const until = async (s) => {
      for (let i = 0; i < 250; i++) {
        if (await ev(s)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error(`DOM timeout: ${s}`);
    };
    const settle = () =>
      ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const clickText = async (text) => {
      await ev(
        `[...document.querySelectorAll('.settings-panel button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`,
      );
      await settle();
    };
    const key = async (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
      wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      await settle();
    };
    const nativeType = async (text) => {
      await ev("window.fixture.view().focus()");
      await wc.insertText(text);
      await settle();
    };
    const snapshot = () => ev("window.fixture.snapshot()");
    const mark = (name) => report.checks.push(name);
    const shot = async (name, width, height) => {
      win.setContentSize(width, height);
      await settle();
      await new Promise((r) => setTimeout(r, 200));
      const layout = await ev(
        `(()=>{const selectors=['.app-shell','.sidebar','.project-bar','.scroll-area','.settings-panel','.sidebar-footer'];return {overflow:selectors.filter(s=>{const e=document.querySelector(s);return e&&e.scrollWidth>e.clientWidth+1}),footer:(()=>{const e=document.querySelector('.sidebar-footer'),r=e.getBoundingClientRect();return {visible:r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,font:parseFloat(getComputedStyle(e).fontSize)}})(),controls:[...document.querySelectorAll('.settings-panel .form-actions button,.project-actions button')].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent,width:r.width,insideHorizontally:r.left>=0&&r.right<=innerWidth}})}})()`,
      );
      assert.deepEqual(layout.overflow, [], `Horizontal overflow ${name}`);
      assert.ok(
        layout.footer.visible && layout.footer.font >= 10,
        `Footer legibility ${name}`,
      );
      assert.ok(
        layout.controls.every((c) => c.width > 40 && c.insideHorizontally),
        `Controls clipped ${name}`,
      );
      fs.writeFileSync(
        path.join(__dirname, `${name}-${width}x${height}.png`),
        (await wc.capturePage()).toPNG(),
      );
      const reachable = await ev(
        `(()=>{const scroll=document.querySelector('.scroll-area'),top=scroll.scrollTop;const result=[...document.querySelectorAll('.settings-panel .form-actions button')].map(e=>{e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {text:e.textContent,visible:r.top>=0&&r.bottom<=innerHeight}});scroll.scrollTop=top;return result})()`,
      );
      assert.ok(
        reachable.every((c) => c.visible),
        `Controls unreachable ${name}`,
      );
      report.screenshots.push({ name, width, height, layout, reachable });
    };
    await win.loadFile(path.join(__dirname, "index.html"));
    await until("!!document.querySelector('.project-settings-action')");
    assert.equal(win.isVisible(), false);
    assert.equal(
      await ev(
        "document.querySelector('.project-settings-action').textContent",
      ),
      "Настройки",
    );
    assert.equal(
      await ev(
        "document.querySelector('.project-settings-action svg').getAttribute('aria-hidden')",
      ),
      "true",
    );
    assert.equal(
      await ev(
        "document.querySelector('.project-settings-action svg').getAttribute('focusable')",
      ),
      "false",
    );
    const version = require(path.join(process.cwd(), "package.json")).version;
    assert.equal(
      await ev("document.querySelector('.app-version').textContent"),
      `v${version}`,
    );
    assert.equal(
      await ev(
        "document.querySelector('.titlebar').textContent.includes('v" +
          version +
          "')",
      ),
      false,
    );
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ])
      await shot("project-header-footer", w, h);
    await ev("document.querySelector('.project-settings-action').click()");
    await until("!!document.querySelector('.project-settings-panel')");
    assert.equal(
      await ev(
        "document.querySelector('.project-settings-panel h2').textContent",
      ),
      "Настройки проекта",
    );
    mark(
      "scoped project header vector action, navigation and dynamic footer version",
    );
    await ev("document.querySelector('.settings-button').click()");
    await until("!!document.querySelector('.settings-panel')");
    await clickText("Открыть редактор");
    await until("!!window.fixture.content()");
    assert.equal(
      await ev("window.fixture.content().getAttribute('aria-label')"),
      "YAML",
    );
    assert.equal((await snapshot()).editable, "true");
    const checkHighlight = async (mode) => {
      const tokens = await ev(
        `(()=>{const c=window.fixture.content();return [...c.querySelectorAll('span')].filter(e=>e.className&&!e.querySelector('span')).map(e=>({text:e.textContent,class:e.className,color:getComputedStyle(e).color}))})()`,
      );
      const group = (pattern) => tokens.find((t) => pattern.test(t.text));
      const keyToken = group(/^(model|name)$/),
        stringToken = group(/demo-model|careful/),
        numberToken = group(/^(3|7)$/),
        boolToken = group(/^(true|false)$/),
        commentToken = group(/^# /);
      for (const [name, token] of Object.entries({
        keyToken,
        stringToken,
        numberToken,
        boolToken,
        commentToken,
      }))
        assert.ok(token, `Missing ${mode} ${name}: ${JSON.stringify(tokens)}`);
      assert.ok(
        new Set([
          keyToken.color,
          stringToken.color,
          numberToken.color,
          commentToken.color,
        ]).size >= 4,
        `Insufficient token distinction ${mode}: ${JSON.stringify(tokens)}`,
      );
      assert.equal(keyToken.color, "rgb(141, 201, 255)");
      assert.equal(stringToken.color, "rgb(184, 217, 155)");
      assert.equal(numberToken.color, "rgb(239, 184, 140)");
      assert.equal(boolToken.color, "rgb(201, 175, 245)");
      assert.equal(commentToken.color, "rgb(135, 154, 179)");
      report[`${mode}Tokens`] = {
        keyToken,
        stringToken,
        numberToken,
        boolToken,
        commentToken,
      };
      mark(
        `${mode}: actual rendered YAML key/string/number/boolean/comment colors`,
      );
    };
    await checkHighlight("config");
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ])
      await shot("config", w, h);
    const original = await ev("window.fixture.docs.config.text");
    await ev(
      "window.fixture.captureView();window.fixture.view().dispatch({selection:{anchor:5,head:12}})",
    );
    const selection = await snapshot();
    await ev("window.fixture.rerender()");
    await settle();
    assert.deepEqual(await snapshot(), selection);
    assert.equal(await ev("window.fixture.sameView()"), true);
    await ev(
      "window.fixture.view().dispatch({selection:{anchor:window.fixture.view().state.doc.length}})",
    );
    const suffix = "# native typing 🙂";
    await nativeType(suffix);
    assert.ok((await snapshot()).doc.endsWith(suffix), "Native typing missing");
    await ev("window.fixture.hold=true");
    const beforeBusy = await snapshot();
    await clickText("Сохранить");
    await until(
      "window.fixture.calls.length===1&&window.fixture.snapshot().readOnly",
    );
    assert.equal(
      await ev("window.fixture.calls[0].text"),
      original + suffix,
      "Save changed original mixed line endings",
    );
    const busy = await snapshot();
    assert.equal(busy.anchor, beforeBusy.anchor);
    assert.equal(busy.head, beforeBusy.head);
    assert.equal(busy.undo, beforeBusy.undo);
    assert.equal(busy.editable, "false");
    await nativeType("MUST_NOT_INSERT");
    assert.equal((await snapshot()).doc, beforeBusy.doc);
    await ev("window.fixture.release()");
    await until("!window.fixture.snapshot().readOnly");
    assert.equal(await ev("window.fixture.sameView()"), true);
    assert.deepEqual(
      await snapshot(),
      beforeBusy,
      "Same-text save response reset editor state",
    );
    await ev("window.fixture.view().focus()");
    await key("z", ["meta"]);
    assert.equal((await snapshot()).doc, original, "Native undo failed");
    await key("z", ["meta", "shift"]);
    assert.equal((await snapshot()).doc, beforeBusy.doc, "Native redo failed");
    mark(
      "native typing; byte-exact mixed CRLF save; stable view/selection/caret/history through React rerender and busy same-text save; native undo/redo",
    );
    await key("Tab");
    assert.equal(
      await ev(
        "document.activeElement!==document.querySelector('.yaml-code-editor')",
      ),
      true,
      "Tab trapped focus",
    );
    mark("YAML accessible name and native Tab exits editor");
    const malicious =
      '\nunknown_html: "<script>window.__yamlExecuted=true</script><img id=evil-yaml src=x onerror=window.__yamlExecuted=true>"\nunfinished: [\n';
    await ev(
      `(()=>{const v=window.fixture.view();v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(malicious)});v.contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`,
    );
    await settle();
    assert.ok(
      (await snapshot()).doc.endsWith(malicious),
      "Synthetic paste changed unfinished YAML",
    );
    assert.equal(
      await ev(
        "!!window.__yamlExecuted||!!document.querySelector('#evil-yaml')||!!window.fixture.content().querySelector('script,img')",
      ),
      false,
    );
    await nativeType("  # still editable");
    assert.ok((await snapshot()).doc.endsWith("  # still editable"));
    await ev("window.fixture.hold=false");
    await clickText("Сохранить");
    await until(
      "window.fixture.calls.length===2&&!window.fixture.snapshot().readOnly",
    );
    assert.equal(
      await ev("window.fixture.calls[1].text"),
      original + suffix + malicious + "  # still editable",
    );
    mark(
      "synthetic paste; incomplete YAML remains editable; HTML/script inert; exact raw save without serialization",
    );
    await clickText("Скрыть без сохранения");
    assert.equal(await ev("!!window.fixture.content()"), false);
    await ev(
      "(()=>{const e=document.querySelector('.settings-panel select');e.value='profile:careful';e.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
    await settle();
    await clickText("Открыть редактор");
    await until("!!window.fixture.content()");
    assert.equal(await ev("window.fixture.sameView()"), false);
    await checkHighlight("profile");
    for (const [w, h] of [
      [1320, 900],
      [920, 700],
    ])
      await shot("personal-profile", w, h);
    const profileOriginal = await ev("window.fixture.docs.profile.text");
    await clickText("Сохранить");
    await until(
      "window.fixture.calls.length===3&&!window.fixture.snapshot().readOnly",
    );
    assert.equal(await ev("window.fixture.calls[2].text"), profileOriginal);
    assert.equal(await ev("window.fixture.calls[2].name"), "careful");
    mark("personal profile raw save and file/hide editor lifecycle");
    const mixedPaste =
      '# mixed pasted separator\r\nextra: "🙂"\nunknown_block: |\r\n  retain this\n';
    await ev(
      `(()=>{const v=window.fixture.view();v.dispatch({selection:{anchor:v.state.doc.length}});v.focus();const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(mixedPaste)});v.contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`,
    );
    await settle();
    await clickText("Сохранить");
    await until(
      "window.fixture.calls.length===4&&!window.fixture.snapshot().readOnly",
    );
    assert.equal(
      await ev("window.fixture.calls[3].text"),
      profileOriginal + mixedPaste,
      "Synthetic mixed CRLF paste bytes changed",
    );
    mark(
      "synthetic ClipboardEvent preserves CRLF/mixed separators byte-for-byte",
    );
    // Native Chromium events exercise the CRLF edge fix. Each fresh editor
    // loads only the fake profile source; no real file is read or modified.
    const edgeSource = "first: one\r\nsecond: two\nthird: three\r\n";
    const crlfStart = edgeSource.indexOf("\r\n");
    const lfStart = edgeSource.indexOf("\nthird:");
    const edgeCases = [
      ...[
        { separator: "CRLF", start: crlfStart, length: 2 },
        { separator: "LF", start: lfStart, length: 1 },
      ].flatMap(({ separator, start, length }) => [
        {
          name: `${separator}: native Backspace joins lines`,
          anchor: start + length,
          keyCode: "Backspace",
          expected: edgeSource.slice(0, start) + edgeSource.slice(start + length),
        },
        {
          name: `${separator}: native Delete joins lines`,
          anchor: start,
          keyCode: "Delete",
          expected: edgeSource.slice(0, start) + edgeSource.slice(start + length),
        },
      ]),
      {
        name: "CRLF: native End then typing stays before the whole pair",
        anchor: 0,
        endFirst: true,
        insert: "!",
        expected: edgeSource.slice(0, crlfStart) + "!" + edgeSource.slice(crlfStart),
      },
      {
        name: "CRLF: native End then Enter does not split the pair",
        anchor: 0,
        endFirst: true,
        keyCode: "Enter",
        expected: edgeSource.slice(0, crlfStart) + "\n" + edgeSource.slice(crlfStart),
      },
    ];
    report.nativeLineEndingCases = [];
    for (const [index, edge] of edgeCases.entries()) {
      await clickText("Скрыть без сохранения");
      await until("!window.fixture.content()");
      await ev(
        `window.fixture.docs.profile={text:${JSON.stringify(edgeSource)},version:'edge-${index}'}`,
      );
      await clickText("Открыть редактор");
      await until("!!window.fixture.content()");
      assert.equal((await snapshot()).doc, edgeSource, `${edge.name}: source`);
      assert.equal(
        await ev("window.fixture.content().querySelector('.cm-line').textContent"),
        "first: one",
        `${edge.name}: CR decoration must not display a character`,
      );
      await ev(
        `(()=>{const v=window.fixture.view();v.dispatch({selection:{anchor:${edge.anchor}}});v.focus()})()`,
      );
      if (edge.endFirst) {
        await key("End");
        assert.equal(
          (await snapshot()).head,
          crlfStart,
          `${edge.name}: End landed inside CRLF`,
        );
      }
      if (edge.insert !== undefined) await nativeType(edge.insert);
      else await key(edge.keyCode);
      const edited = (await snapshot()).doc;
      assert.equal(edited, edge.expected, edge.name);
      assert.equal(/\r(?!\n)/.test(edited), false, `${edge.name}: orphan CR`);
      const savedCount = await ev("window.fixture.calls.length");
      await clickText("Сохранить");
      await until(
        `window.fixture.calls.length===${savedCount + 1}&&!window.fixture.snapshot().readOnly`,
      );
      assert.equal(
        await ev(`window.fixture.calls[${savedCount}].text`),
        edge.expected,
        `${edge.name}: save must preserve the exact native edit`,
      );
      await ev("window.fixture.view().focus()");
      await key("z", ["meta"]);
      assert.equal((await snapshot()).doc, edgeSource, `${edge.name}: exact undo`);
      await key("z", ["meta", "shift"]);
      assert.equal(
        (await snapshot()).doc,
        edge.expected,
        `${edge.name}: exact redo`,
      );
      await key("z", ["meta"]);
      assert.equal((await snapshot()).doc, edgeSource, `${edge.name}: second undo`);
      report.nativeLineEndingCases.push({
        name: edge.name,
        sourceBytes: Buffer.byteLength(edgeSource),
        editedBytes: Buffer.byteLength(edge.expected),
        exactSave: true,
        exactUndoRedo: true,
        orphanCR: false,
      });
    }
    mark(
      "native mixed-CRLF/LF Backspace/Delete joins and End typing/Enter; no orphan CR; exact save and undo/redo",
    );
    report.cspViolations = await ev("window.fixture.cspViolations");
    assert.deepEqual(report.cspViolations, [], "Production CSP violation");
    mark("unchanged production CSP; no style/script policy violations");
    report.ok = true;
    fs.writeFileSync(
      path.join(__dirname, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log("UI_YAML_SMOKE " + JSON.stringify(report));
    clearTimeout(watchdog);
    win.destroy();
    app.exit(0);
  } catch (error) {
    report.ok = false;
    report.error = error.stack;
    fs.writeFileSync(
      path.join(__dirname, "result.json"),
      JSON.stringify(report, null, 2),
    );
    if (win && !win.isDestroyed())
      fs.writeFileSync(
        path.join(__dirname, "failure.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
    console.error(error);
    clearTimeout(watchdog);
    win?.destroy();
    app.exit(1);
  }
}

await build({
  stdin: { contents: renderer, loader: "tsx", resolveDir: process.cwd() },
  outfile: path.join(root, "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
});
writeFileSync(
  path.join(root, "index.html"),
  readFileSync("index.html", "utf8").replace(
    '<script type="module" src="/src/renderer/index.tsx"></script>',
    '<link rel="stylesheet" href="renderer.css"><script src="renderer.js"></script>',
  ),
);
writeFileSync(path.join(root, "main.cjs"), `(${runFixture.toString()})()`);
const env = { ...process.env, HOME: path.join(root, "home") };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [path.join(root, "main.cjs")], {
  env,
  encoding: "utf8",
  timeout: 75000,
});
writeFileSync(path.join(root, "stdout.log"), result.stdout || "");
writeFileSync(path.join(root, "stderr.log"), result.stderr || "");
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) console.error(result.error);
console.log("fixture:", root);
process.exitCode = result.status ?? 1;
