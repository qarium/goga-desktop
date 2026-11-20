// Runs only when copied into an isolated temp application. The actual bundled
// main, preload and renderer drive the test; only external OS side effects are blocked.
"use strict";
const assert = require("node:assert/strict"),
  os = require("node:os"),
  path = require("node:path"),
  fs = require("node:fs"),
  Module = require("node:module");
const { app, BrowserWindow, Menu, ipcMain } = require("electron"),
  root = __dirname;
const expected = process.env.GOGA_QA_LOCALE_START,
  target = process.env.GOGA_QA_LOCALE_END;
assert.match(path.basename(root), /^goga-language-smoke-/);
assert.equal(os.homedir(), path.join(root, "home"));
assert.equal(process.env.GOGA_DESKTOP_DATA_DIR, path.join(root, "profile"));
assert.ok(["en", "ru"].includes(expected) && ["en", "ru"].includes(target));
for (const [key, sub] of [
  ["home", "home"],
  ["appData", "appdata"],
  ["userData", "profile"],
  ["sessionData", "session"],
  ["temp", "tmp"],
  ["crashDumps", "logs"],
])
  app.setPath(key, path.join(root, sub));
app.setAppLogsPath(path.join(root, "logs"));
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
let shellWindow,
  failure,
  finished = false;
let phase = "starting";
const wait = async (check, label) => {
  phase = label;
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw Error("Timed out: " + label);
};
const fail =
  (label) =>
  (..._args) => {
    failure = Error("Unexpected external operation: " + label);
    throw failure;
  };
const denied = (name) =>
  new Proxy({}, { get: (_, key) => fail(name + "." + String(key)) });
const HiddenWindow = class extends BrowserWindow {
  constructor(options) {
    super({
      ...options,
      show: false,
      webPreferences: {
        ...options.webPreferences,
        backgroundThrottling: false,
      },
    });
    shellWindow ??= this;
  }
  show() {}
  focus() {}
};
const protectedElectron = Object.create(require("electron"));
Object.defineProperties(
  protectedElectron,
  Object.fromEntries(
    Object.entries({
      BrowserWindow: HiddenWindow,
      shell: denied("shell"),
      clipboard: denied("clipboard"),
      Notification: Object.assign(
        class {
          constructor() {
            fail("notification")();
          }
        },
        { isSupported: () => false, getHistory: async () => [] },
      ),
      dialog: {
        showMessageBox: async () => {
          throw Error("Unexpected native dialog");
        },
        showErrorBox: (_name, reason) => {
          failure = Error("Desktop startup: " + reason);
        },
      },
    }).map(([k, v]) => [k, { value: v }]),
  ),
);
const cp = require("node:child_process");
const restrictedChild = Object.create(cp);
for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
])
  Object.defineProperty(restrictedChild, name, { value: fail(name) });
const real = Module._load;
Module._load = function (request, parent, ...rest) {
  if (
    parent?.filename?.startsWith(path.join(root, "dist-electron") + path.sep)
  ) {
    if (request === "electron") return protectedElectron;
    if (["node:child_process", "child_process"].includes(request))
      return restrictedChild;
    if (request.includes("node-pty")) return denied("pty");
  }
  return Reflect.apply(real, this, [request, parent, ...rest]);
};
app.whenReady().then(() => {
  require("electron").session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (_details, cb) => cb({ cancel: true }),
  );
});
function report(result) {
  if (finished) return;
  finished = true;
  const state = { ...result, phase };
  fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(state));
  // This is an abrupt restart test, not the shutdown/quit dialog. The runner
  // has already proved this process owns only its disposable directory. End
  // only this harness PID so no cleanup can perform a last-minute preference write.
  process.kill(process.pid, "SIGKILL");
}
const timeout = setTimeout(
  () => report({ ok: false, reason: String(failure ?? "deadline") }),
  22000,
);
const wm = {
  en: {
    settings: "Settings",
    general: "General",
    menu: "Edit",
    terminal: "Terminal",
  },
  ru: {
    settings: "Настройки",
    general: "Общие",
    menu: "Правка",
    terminal: "Терминал",
  },
};
async function check() {
  await wait(
    () =>
      shellWindow &&
      !shellWindow.webContents.isLoading() &&
      shellWindow.webContents.getURL().startsWith("file:"),
    "shell",
  );
  const js = (s) => shellWindow.webContents.executeJavaScript(s, true);
  const select = ".interface-language-settings select";
  const waitLang = async (tag) => {
    await wait(
      () =>
        js(
          "document.documentElement.lang===" +
            JSON.stringify(tag) +
            ' && document.querySelector(".settings-button")?.getAttribute("aria-label")===' +
            JSON.stringify(wm[tag].settings),
        ),
      "shell text " + tag,
    );
    assert.equal(await js("window.goga.getInterfaceLanguage()"), tag);
    assert.ok(
      Menu.getApplicationMenu()?.items.some((x) => x.label === wm[tag].menu),
      "native menu: " + tag,
    );
  };
  await waitLang(expected);
  assert.equal(await js("window.goga.initialInterfaceLanguage"), expected);
  assert.equal(shellWindow.isVisible(), false);
  await js('document.querySelector(".settings-button").click()');
  await wait(
    () =>
      js(
        'Array.from(document.querySelectorAll(".settings-panel button")).some(b=>b.textContent.trim()===' +
          JSON.stringify(wm[expected].general) +
          ")",
      ),
    "general settings tab",
  );
  await js(
    'Array.from(document.querySelectorAll(".settings-panel button")).find(b=>b.textContent.trim()===' +
      JSON.stringify(wm[expected].general) +
      ").click()",
  );
  await wait(
    () =>
      js(
        "document.querySelector(" +
          JSON.stringify(select) +
          ")?.value===" +
          JSON.stringify(expected),
      ),
    "language control",
  );
  if (target !== expected) {
    await js(
      "const el=document.querySelector(" +
        JSON.stringify(select) +
        ");window.__fixtureSelect=el;el.value=" +
        JSON.stringify(target) +
        ';el.dispatchEvent(new Event("change",{bubbles:true}))',
    );
    await waitLang(target);
    assert.equal(
      await js(
        "window.__fixtureSelect===document.querySelector(" +
          JSON.stringify(select) +
          ") && window.__fixtureSelect.value===" +
          JSON.stringify(target),
      ),
      true,
    );
  }
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(root, "profile/interface-language.json"),
        "utf8",
      ),
    ).language,
    target,
  );
  const terminal = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(root, "dist-electron/terminal-preload.cjs"),
    },
  });
  const ready = new Promise((resolve) =>
    ipcMain.once("terminal-screen:ready", (event) => {
      assert.equal(event.sender, terminal.webContents);
      resolve();
    }),
  );
  await terminal.loadFile(path.join(root, "dist/terminal/index.html"));
  phase = "terminal bridge ready";
  await ready;
  terminal.webContents.send("terminal-screen:command", {
    kind: "language",
    language: target,
  });
  await wait(
    () =>
      terminal.webContents.executeJavaScript(
        "document.documentElement.lang===" +
          JSON.stringify(target) +
          " && document.title===" +
          JSON.stringify(wm[target].terminal) +
          " && !window.goga",
      ),
    "isolated terminal",
  );
  assert.equal(terminal.isVisible(), false);
  assert.equal(failure, undefined);
  clearTimeout(timeout);
  report({
    ok: true,
    start: expected,
    end: target,
    settings: true,
    nativeMenu: true,
    terminalScreen: true,
    noPty: true,
  });
}
require(path.join(root, "dist-electron/index.cjs"));
check().catch((e) => {
  clearTimeout(timeout);
  report({ ok: false, reason: String(e) });
});
