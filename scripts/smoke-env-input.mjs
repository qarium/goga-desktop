// Isolated hidden Chromium regression. Only synthetic event payloads: never the
// OS clipboard, production bundle, real preferences, Goga, or a runtime process.
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";

const root = mkdtempSync(path.join(tmpdir(), "goga-env-input-"));
const renderer = `
import React from "react";
import {createRoot} from "react-dom/client";
import {ProjectSettings} from ${JSON.stringify(path.resolve("src/renderer/ProjectSettings.tsx"))};
const initial = {value:{executable:"goga",profile:"",env:[{key:"TOKEN",value:"saved",secret:true,runtime:false}]},version:"v1",profiles:[]};
window.fixture = {saved:structuredClone(initial),calls:[],guard:{current:null}};
window.goga = {
  readProjectSettings:async()=>structuredClone(window.fixture.saved),
  saveProjectSettings:async(id,value,version)=>{
    window.fixture.calls.push(structuredClone({id,value,version}));
    window.fixture.saved={...initial,value:structuredClone(value),version:"v2"};
    return structuredClone(window.fixture.saved);
  }
};
createRoot(document.getElementById("root")).render(<ProjectSettings project={{id:"fixture",name:"Fixture",path:"/unused"}} onBack={()=>{}} onSaved={()=>{}} guard={window.fixture.guard} onBusy={()=>{}} />);
`;

async function exercise() {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  const assert = (condition, description) => {
    if (!condition) throw Error(description);
  };
  for (
    let attempt = 0;
    !document.querySelector('[aria-label="Значение 1"]');
    attempt++
  ) {
    assert(attempt < 200, "Fixture did not mount");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const input = () => document.querySelector('[aria-label="Значение 1"]');
  const alert = () => document.querySelector('[role="alert"]');
  const set = async (value) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await pause();
  };
  const transfer = (kind, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    const event =
      kind === "paste"
        ? new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: data,
          })
        : new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: data,
          });
    input().dispatchEvent(event);
    return event;
  };
  const save = async () => {
    document
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await pause();
  };
  let cases = 0;
  for (const secret of [true, false]) {
    const secretControl = document.querySelector('[aria-label="Secret 1"]');
    if (secretControl.checked !== secret) secretControl.click();
    await pause();
    assert(
      input().type === (secret ? "password" : "text"),
      "Input mode mismatch",
    );
    for (const kind of ["paste", "drop", "beforeinput"]) {
      for (const fragment of ["\n", "\r", "\r\n", "\0", "\ud800", "\udfff"]) {
        await set("prior-unsaved");
        input().focus();
        input().setSelectionRange(2, 5);
        const payload = `secret-marker${fragment}tail`;
        const event =
          kind === "beforeinput"
            ? new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: payload,
              })
            : transfer(kind, payload);
        if (kind === "beforeinput") input().dispatchEvent(event);
        await pause();
        assert(event.defaultPrevented, `${kind}: default not prevented`);
        assert(input().value === "prior-unsaved", `${kind}: draft changed`);
        assert(
          alert() && !alert().textContent.includes("secret-marker"),
          `${kind}: missing/unsafe error`,
        );
        await save();
        assert(
          window.fixture.calls.length === 0,
          `${kind}: invalid save reached IPC`,
        );
        assert(
          window.fixture.saved.value.env[0].value === "saved",
          `${kind}: saved document changed`,
        );
        assert(window.fixture.guard.current.dirty, `${kind}: dirty guard lost`);
        cases++;
      }
    }
  }
  await set("prior-unsaved");
  input().dispatchEvent(
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: false,
      inputType: "insertReplacementText",
      data: "secret-marker\nvalue",
    }),
  );
  await pause();
  await set("secret-markervalue");
  assert(
    input().value === "prior-unsaved",
    "Noncancelable event accepted sanitized value",
  );
  await save();
  assert(
    window.fixture.calls.length === 0,
    "Noncancelable event saved sanitized value",
  );
  cases++;

  const valid = "\\n\t'\"🙂 $HOME; $(echo nope) ";
  for (const kind of ["paste", "drop"]) {
    await set("abcdef");
    input().focus();
    input().setSelectionRange(2, 4);
    const inserted = valid + kind;
    const event = transfer(kind, inserted);
    await pause();
    assert(event.defaultPrevented, `${kind}: valid default not prevented`);
    assert(input().value === `ab${inserted}ef`, `${kind}: valid bytes changed`);
    assert(
      input().selectionStart === 2 + inserted.length,
      `${kind}: caret lost`,
    );
    assert(!alert(), `${kind}: corrective edit did not clear error`);
    await save();
    assert(
      window.fixture.calls.at(-1).value.env[0].value === `ab${inserted}ef`,
      `${kind}: saved bytes changed`,
    );
    cases++;
  }
  await set("x".repeat(50000));
  document.querySelector('[aria-label="Передавать в runtime 1"]').click();
  await pause();
  const calls = window.fixture.calls.length;
  await save();
  assert(
    window.fixture.calls.length === calls,
    "Oversized runtime payload reached IPC",
  );
  assert(
    input().value.length === 50000 && alert(),
    "Oversized draft lost or error missing",
  );
  cases++;
  return {
    cases,
    savedCalls: window.fixture.calls.length,
    clipboard: "untouched; synthetic event data only",
    visibleWindows: 0,
  };
}

try {
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
    '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="renderer.js"></script>',
  );
  writeFileSync(
    path.join(root, "main.cjs"),
    `
const {app,BrowserWindow,session}=require("electron");
const path=require("node:path");
app.setName("Goga Environment Input Fixture");
app.setPath("userData",path.join(__dirname,"user-data"));
const timeout=setTimeout(()=>{console.error("Fixture timeout");app.exit(1)},30000);
app.whenReady().then(async()=>{
  if(app.dock)app.dock.hide();
  session.defaultSession.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},(_details,done)=>done({cancel:true}));
  const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  await window.loadFile(path.join(__dirname,"index.html"));
  const result=await window.webContents.executeJavaScript(${JSON.stringify(`(${exercise.toString()})()`)});
  console.log("ENV_INPUT_SMOKE "+JSON.stringify(result));
  clearTimeout(timeout);window.destroy();app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(timeout);app.exit(1)});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(electron, [path.join(root, "main.cjs")], {
    env,
    encoding: "utf8",
    timeout: 40000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) console.error(result.error);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
