// Real Chromium geometry with production React topic selectors and CSS.
// Standalone disposable Electron only; no Goga/Git/user data/processes touched.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const req = createRequire(import.meta.url);
const { _electron } = req(
  process.env.GOGA_SMOKE_PLAYWRIGHT_CORE || "playwright-core",
);
const temp = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "goga-topic-scroll-"),
);
let app, server;
const measurements = [];
try {
  const home = path.join(temp, "home");
  await fs.mkdir(home);
  await build({
    absWorkingDir: repo,
    stdin: {
      resolveDir: repo,
      sourcefile: "scroll-fixture.tsx",
      loader: "tsx",
      contents: `
import React from "react";import {createRoot} from "react-dom/client";
import {TopicContextPicker} from "./src/renderer/TopicContextPicker";
import {TopicSelect} from "./src/renderer/TopicSelect";
const row=i=>({topic:"topic-"+String(i).padStart(3,"0"),branch:"feature/topic-"+i,current:false,remote:false,statuses:[],todo:null,divergence:null,hosts:[]});
const entries=Array.from({length:80},(_,i)=>row(i));
window.goga={ensureTopicContext:async()=>{throw Error("No filesystem actions allowed in scroll fixture");}};
function Fixture(){const [chosen,setChosen]=React.useState("");
return <div className="scroll-area"><h1>Isolated picker scroll test</h1>
<TopicContextPicker project={{id:"fixture",name:"Fixture",path:"/synthetic/fixture"}} board={{projectId:"fixture",year:"2026",entries,records:entries,remoteEntries:[],remoteRecords:[],currentTopic:null,revision:"fixture",currentBranch:"main",baseRef:"main",branches:[],dirty:false,active:false}} selected={null} onSelect={()=>{}} onClear={()=>{}} onOpenCard={()=>{}}/>
<div style={{marginTop:30,width:420}}><TopicSelect topics={entries} value={chosen} onChange={value=>{setChosen(value);window.chosen=value;}} currentBranch="main"/></div>
</div>;}createRoot(document.getElementById("root")).render(<Fixture/>);`,
    },
    outfile: path.join(temp, "fixture.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const base = `*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#dbe5f5;font:14px system-ui}button,input{font:inherit;color:inherit;background:#172135;border:1px solid #3c4d67;padding:8px}.scroll-area{padding:24px;height:600px;overflow:auto}label{display:block}h1{font-size:16px}:root{--surface:#121a2b;--line:#30405b;--muted:#94a8bf;--teal:#18cbb9}`;
  await fs.writeFile(
    path.join(temp, "index.html"),
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>' +
      base +
      '</style><div id="root"></div><script src="/fixture.js"></script>',
  );
  server = http.createServer(async (r, s) => {
    const name = {
      "/": "index.html",
      "/fixture.js": "fixture.js",
      "/fixture.css": "fixture.css",
    }[r.url];
    if (!name) {
      s.writeHead(404);
      return s.end();
    }
    s.setHeader(
      "Content-Type",
      name.endsWith(".js")
        ? "text/javascript"
        : name.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    s.end(await fs.readFile(path.join(temp, name)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await fs.writeFile(
    path.join(temp, "main.cjs"),
    `const {app,BrowserWindow}=require("electron");app.dock?.hide();app.whenReady().then(()=>{const w=new BrowserWindow({width:920,height:760,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL("http://127.0.0.1:${server.address().port}/");});`,
  );
  app = await _electron.launch({
    executablePath: req("electron"),
    args: [
      "--user-data-dir=" + path.join(temp, "profile"),
      "--use-mock-keychain",
      path.join(temp, "main.cjs"),
    ],
    cwd: temp,
    env: {
      HOME: home,
      CFFIXED_USER_HOME: home,
      TMPDIR: temp,
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
    },
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(7000);
  for (const kind of ["context", "launch"]) {
    await page
      .getByRole(kind === "context" ? "button" : "combobox", {
        name: kind === "context" ? "Выбрать другой топик" : "Топик проекта",
        exact: true,
      })
      .click();
    const list = page.getByRole(kind === "context" ? "grid" : "listbox", {
      name: kind === "context" ? "Топики проекта" : "Топик проекта",
      exact: true,
    });
    await list.waitFor();
    const bounds = await list.boundingBox();
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height - 4,
    );
    const start = await list.evaluate((el) => el.scrollTop);
    for (let i = 0; i < 24; i++) {
      await page.mouse.move(
        bounds.x + bounds.width / 2 + (i % 2),
        bounds.y + bounds.height - 4,
      );
      await page.waitForTimeout(25);
    }
    const hovered = await list.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, 180);
    await page.waitForTimeout(150);
    const wheel = await list.evaluate((el) => el.scrollTop);
    const target =
      kind === "context"
        ? page.getByRole("combobox", { name: "Найти топик", exact: true })
        : page.getByRole("combobox", { name: "Топик проекта", exact: true });
    await target.press("End");
    const lastVisible = await list.evaluate((el) => {
      const items = el.querySelectorAll('[role="row"],[role="option"]');
      const item = items[items.length - 1],
        a = el.getBoundingClientRect(),
        b = item.getBoundingClientRect();
      return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
    });
    measurements.push({ kind, start, hovered, wheel, lastVisible });
    if (!process.argv.includes("--measure-only")) {
      assert.equal(hovered, start, "Pointer hover must not scroll " + kind);
      assert(wheel > hovered, "Wheel stopped working");
      assert(lastVisible, "End did not reveal last option");
    }
    await target.press("Home");
    await target.press("ArrowDown");
    await target.press("Enter");
    if (kind === "launch")
      assert.equal(
        await page.evaluate(() => window.chosen),
        "1",
        "Keyboard selection must work after pointer hover",
      );
    else await target.press("Escape");
  }
  console.log(JSON.stringify(measurements));
} finally {
  if (app) {
    await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await app.close().catch(() => {});
  }
  server?.closeAllConnections();
  if (server?.listening) await new Promise((r) => server.close(r));
  await fs.rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  });
}
