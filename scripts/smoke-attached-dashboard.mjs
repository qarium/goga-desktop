// Production Desktop/UI/preloads, with a disposable project and local AFM-shaped fixture.
// Requires a current build and playwright-core (or GOGA_SMOKE_PLAYWRIGHT_CORE).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { _electron } = require(
  process.env.GOGA_SMOKE_PLAYWRIGHT_CORE || "playwright-core",
);
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "goga-attached-smoke-"),
);
const home = path.join(tmp, "home"),
  profile = path.join(tmp, "profile"),
  bin = path.join(home, ".local/bin");
const project = {
  id: "fixture-attach",
  name: "Dashboard Fixture",
  path: path.join(tmp, "repo"),
};
const env = {
  HOME: home,
  CFFIXED_USER_HOME: home,
  GOGA_DESKTOP_DATA_DIR: profile,
  PATH: bin + ":/usr/bin:/bin",
  TMPDIR: path.join(tmp, "temp"),
  LANG: "en_US.UTF-8",
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};
const flow = "Attached Smoke Flow",
  id = "fake-afm-17",
  startedAt = new Date().toISOString();
let app,
  phase = "fixture",
  loads = 0,
  probes = 0,
  forbidden = 0,
  upgrades = 0,
  completedGuards = new Set();
const server = http.createServer((req, res) => {
  res.setHeader("cache-control", "no-store");
  if (req.method !== "GET") {
    forbidden++;
    return res.writeHead(405).end();
  }
  if (/^\/checked-[0-9]+$/.test(req.url)) {
    completedGuards.add(Number(req.url.slice(9)));
    return res.writeHead(204).end();
  }
  if (req.url === "/api/status") {
    probes++;
    return res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        flow_name: flow,
        run_id: id,
        run_status: "running",
        started_at: startedAt,
        stages: [],
      }),
    );
  }
  if (req.url === "/") {
    loads++;
    return res
      .writeHead(200, { "content-type": "text/html;charset=utf-8" })
      .end(
        "<!doctype html><title>Test AFM " +
          loads +
          "</title><p>Fixture document " +
          loads +
          "</p>" +
          `<script>
            const write=fetch("/forbidden",{method:"POST"}).catch(()=>{});
            const upgrade=new Promise(resolve=>{const ws=new WebSocket("ws://"+location.host+"/forbidden");ws.onerror=resolve;ws.onopen=()=>{ws.close();resolve()};});
            Promise.all([write,upgrade]).then(()=>fetch("/checked-${loads}"));
          </script>`,
      );
  }
  return res.writeHead(404).end();
});
server.on("upgrade", (_request, socket) => {
  upgrades++;
  socket.destroy();
});
async function until(fn) {
  const end = Date.now() + 10000;
  do {
    if (await fn()) return;
    await delay(75);
  } while (Date.now() < end);
  throw Error("Timed out: " + phase);
}
try {
  const settingsDir = path.join(home, ".goga/desktop/settings");
  for (const dir of [
    settingsDir,
    env.TMPDIR,
    bin,
    profile,
    path.join(project.path, ".goga"),
  ])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, ".goga/config.yml"), "{}\n");
  await fs.writeFile(
    path.join(project.path, ".goga/config.yml"),
    "topics:\n  base_ref: main\n",
  );
  const git = (...args) =>
    execFileSync("/usr/bin/git", ["-C", project.path, ...args], {
      env,
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  git("add", ".goga/config.yml");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const fake = path.join(bin, "goga");
  await fs.writeFile(
    fake,
    `#!/bin/sh
case "$*" in
  "pipeline --list --info") printf '%s\\n' '* example (project)' '  name: Fixture' '---';;
  "topics board --json --per-host"|"topics board --per-host --json") printf '[]\\n';;
  *) exit 1;;
esac
`,
    { mode: 0o700 },
  );
  // Pin the *absolute* fake executable and safe PATH: never discover the user's Goga or start Docker.
  const key = createHash("sha256").update(project.id).digest("hex");
  await fs.writeFile(
    path.join(settingsDir, key + ".json"),
    JSON.stringify({
      schemaVersion: 1,
      revision: randomUUID(),
      projectId: project.id,
      value: {
        executable: fake,
        profile: "",
        env: [{ key: "PATH", value: env.PATH, secret: false, runtime: false }],
      },
    }),
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(profile, "projects.json"),
    JSON.stringify([project]),
    { mode: 0o600 },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  phase = "launch private Desktop";
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [
      "--user-data-dir=" + profile,
      "--no-first-run",
      "--use-mock-keychain",
      "--disable-background-networking",
      repo,
    ],
    cwd: tmp,
    env,
    timeout: 25000,
  });
  assert.deepEqual(
    await app.evaluate(({ app }) => [
      app.getPath("userData"),
      process.env.HOME,
    ]),
    [profile, home],
  );
  const shell = await app.firstWindow();
  shell.setDefaultTimeout(10000);
  const button = (name) => shell.getByRole("button", { name, exact: true });
  const state = () =>
    app.evaluate(({ BrowserWindow }, origin) => {
      const child = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
        (child) => child.webContents?.getURL() === origin + "/",
      );
      return (
        child && {
          visible: child.getVisible(),
          width: child.getBounds().width,
          title: child.webContents.getTitle(),
        }
      );
    }, origin);
  async function ready(before) {
    await until(async () => {
      const v = await state();
      return (
        loads > before &&
        v?.visible &&
        v.width > 0 &&
        v.title === "Test AFM " + loads &&
        (await reload.isEnabled())
      );
    });
  }
  phase = "select project";
  await shell
    .getByRole("button", { name: new RegExp(project.name) })
    .filter({ hasText: project.name })
    .first()
    .click();
  phase = "connect explicit URL";
  await button("Запуски").click();
  await button("Подключить конвейер").click();
  const dialog = shell.getByRole("dialog", { name: "Подключить конвейер" });
  await dialog.getByRole("textbox", { name: "Адрес панели" }).fill(origin);
  await dialog.getByRole("button", { name: "Подключить", exact: true }).click();
  const tab = shell.getByRole("tab", { name: new RegExp(flow) });
  const reload = button("Обновить страницу панели");
  await tab.waitFor();
  await ready(0);
  assert(probes >= 2, "confirm the pin again after load");
  phase = "launch menu above a real native dashboard";
  const menuChecks=[];
  for(const [width,height] of [[920,700],[1320,900],[1600,1000]]){
    await app.evaluate(({BrowserWindow},[w,h])=>BrowserWindow.getAllWindows()[0].setSize(w,h),[width,height]);
    const previousLoads=loads;
    const popupReady=shell.waitForEvent("popup",{timeout:5000});
    await button("Запустить").click();
    const popup=await popupReady;
    const menu=popup.getByRole("menu",{name:"Подготовить новый запуск"});
    await menu.waitFor();
    await popup.getByRole("menuitem",{name:/^Сборка/}).waitFor();
    await until(async()=>{
      const v=await app.evaluate(({BrowserWindow},origin)=>{
        const children=BrowserWindow.getAllWindows()[0].contentView.children;
        const dashboard=children.findIndex(v=>v.webContents?.getURL()===origin+"/");
        const overlay=children.findIndex(v=>v.webContents?.getTitle()==="Подготовить новый запуск");
        return {above:overlay>dashboard&&dashboard>=0,shown:overlay>=0&&children[overlay].getVisible()};
      },origin);
      return v.above&&v.shown;
    });
    const bounds=await menu.evaluate(node=>{
      const rect=node.getBoundingClientRect();
      return {top:rect.top,bottom:rect.bottom,height:rect.height,viewport:innerHeight,scroll:node.scrollHeight,client:node.clientHeight};
    });
    assert(bounds.top>=0&&bounds.bottom<=bounds.viewport,"entire launch menu must fit the native overlay");
    assert(bounds.height>0);
    assert.equal(loads,previousLoads,"opening launch menu must not reload the dashboard");
    const closed=popup.waitForEvent("close");
    await popup.keyboard.press("Escape").catch(error=>{if(!popup.isClosed())throw error});await closed;
    await until(async()=>await button("Запустить").evaluate(node=>node===node.ownerDocument.activeElement));
    assert((await state())?.visible,"dashboard remains selected after closing launch menu");
    menuChecks.push({width,height,panelVisible:true,menuAboveDashboard:true});
  }
  phase = "launch menu native keyboard and outside dismissal";
  const keyboardReady=shell.waitForEvent("popup",{timeout:5000});
  await button("Запустить").focus();await button("Запустить").press("ArrowUp");
  const keyboardPopup=await keyboardReady;
  await keyboardPopup.getByRole("menu",{name:"Подготовить новый запуск"}).waitFor();
  await until(async()=>await keyboardPopup.evaluate(()=>{
    const items=[...document.querySelectorAll('[role="menu"] button:not(:disabled)')];
    return items.length>0&&document.activeElement===items.at(-1);
  }));
  await keyboardPopup.keyboard.press("Home");
  assert(await keyboardPopup.evaluate(()=>document.activeElement===document.querySelector('[role="menu"] button:not(:disabled)')));
  const keyClosed=keyboardPopup.waitForEvent("close");
  await keyboardPopup.keyboard.press("Escape").catch(error=>{if(!keyboardPopup.isClosed())throw error});await keyClosed;
  const outsideReady=shell.waitForEvent("popup",{timeout:5000});await button("Запустить").click();const outsidePopup=await outsideReady;
  await outsidePopup.getByRole("menu",{name:"Подготовить новый запуск"}).waitFor();
  const outsideClosed=outsidePopup.waitForEvent("close");await shell.getByRole("heading",{name:project.name,exact:true}).click();await outsideClosed;
  phase = "refresh button";
  const first = loads,
    firstProbes = probes;
  await reload.click();
  await ready(first);
  assert(probes >= firstProbes + 2, "pin checks on both sides of reload");
  phase = "F5 from native page";
  const second = loads,
    secondProbes = probes;
  await app.evaluate(({ webContents }, origin) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => w.getURL() === origin + "/");
    if (!wc) throw Error("Missing AFM web contents");
    wc.focus();
    wc.sendInputEvent({ type: "keyDown", keyCode: "F5" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "F5" });
  }, origin);
  await ready(second);
  assert(
    probes >= secondProbes + 2,
    "F5 must use the checked refresh path, not native unguarded reload",
  );
  await until(async () => completedGuards.has(loads));
  assert.equal(
    forbidden,
    0,
    "the external AFM page must not send POST requests",
  );
  assert.equal(upgrades, 0, "the external AFM page must not open a WebSocket");
  phase = "close without stopping AFM";
  await shell.getByRole("button", { name: "Отключить панель " + flow }).click();
  await tab.waitFor({ state: "detached" });
  await until(async () => !(await state()));
  const status = await fetch(origin + "/api/status", {
    redirect: "error",
    signal: AbortSignal.timeout(1000),
  });
  assert.equal((await status.json()).run_id, id);
  phase = "expand a real project editor without remounting or saving the draft";
  await button("Проект").click();
  await button("Конфигурация").click();
  const editor=shell.locator(".editor-pane .cm-content:visible");
  await editor.waitFor();
  const reader=shell.locator(".editor-pane .cm-scroller:visible");
  const before=await reader.boundingBox();
  await editor.click();
  await shell.keyboard.press("Control+End");
  await shell.keyboard.insertText("# draft-only");
  await editor.evaluate(node=>{node.dataset.smokeEditorIdentity="same"});
  await button("Развернуть документ").click();
  await button("Свернуть документ").waitFor();
  const after=await reader.boundingBox();
  assert(after.height>before.height+50, "expanded editor should gain working height");
  assert.equal(await editor.getAttribute("data-smoke-editor-identity"),"same");
  assert((await editor.innerText()).includes("draft-only"));
  await shell.keyboard.press("Escape");
  await button("Развернуть документ").waitFor();
  assert.equal(await editor.getAttribute("data-smoke-editor-identity"),"same");
  assert((await editor.innerText()).includes("draft-only"));
  assert.equal(await fs.readFile(path.join(project.path,".goga/config.yml"),"utf8"),"topics:\n  base_ref: main\n");
  console.log(
    JSON.stringify({
      result: "passed",
      launchMenuChecks:menuChecks,
      editorExpanded: [before.height,after.height],
      documentLoads: loads,
      statusChecks: probes,
      forbiddenRequests: forbidden,
      webSocketUpgrades: upgrades,
      serverAliveAfterDetach: true,
    }),
  );
} catch (error) {
  console.error("Failure during " + phase);
  throw error;
} finally {
  try {
    if (app) {
      const child = app.process();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"),
          timer = setTimeout(() => child.kill("SIGKILL"), 6500);
        timer.unref();
        try {
          void app
            .evaluate(({ app }) => setTimeout(() => app.exit(0), 20))
            .catch(() => {});
          await exited;
        } finally {
          clearTimeout(timer);
        }
      }
    }
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 150,
    });
  }
}
