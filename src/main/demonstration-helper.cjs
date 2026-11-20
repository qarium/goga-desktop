const { getLocale, isSupportedLocale, setLocale, t } = require("../shared/i18n.ts");
// This process contains *only* untrusted demonstration pages. No Goga host,
// privileged preload, Node inspector, Desktop window or per-user registry.
const { app, BrowserWindow, session, Menu } = require("electron");
const { randomUUID } = require("node:crypto");
const { createInterface } = require("node:readline");
const { resolve, join } = require("node:path");
const { startPage } = require("../host/demonstrations/start-page.cjs");
const profile = join(process.env.HOME || "", "profile");
if (
  !process.env.HOME ||
  !app.commandLine.hasSwitch("remote-debugging-pipe") ||
  app.commandLine.hasSwitch("remote-debugging-port") ||
  resolve(app.commandLine.getSwitchValue("user-data-dir")) !== profile
)
  throw Error("Invalid isolated demonstration process");
const language = app.commandLine.getSwitchValue("goga-interface-language");
if (isSupportedLocale(language)) setLocale(language);
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setPath("temp", process.env.TMPDIR);
app.enableSandbox();
if (process.platform === "darwin") app.setActivationPolicy("prohibited");
app.on("window-all-closed", () => {});
app.on("login", (event, _wc, _details, _info, respond) => {
  event.preventDefault();
  respond();
});
app.on("select-client-certificate", (e, _wc, _url, _list, respond) => {
  e.preventDefault();
  respond();
});
const pages = new Map();
const contexts = new Map();
const maxPages = 128;
let defaultContextId;
function safeURL(url) {
  try {
    return (
      ["https:", "http:", "data:", "blob:"].includes(new URL(url).protocol) ||
      url === "about:blank" ||
      url === "about:srcdoc"
    );
  } catch {
    return false;
  }
}
function secure(ses) {
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_wc, _name, respond) => respond(false));
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, respond) => respond({}));
  ses.on("will-download", (e) => e.preventDefault());
  ses.webRequest.onBeforeRequest((details, cb) => {
    const allow = safeURL(details.url) || /^wss?:/i.test(details.url);
    cb({ cancel: !allow });
  });
}
const prefs = (ses) => ({
  session: ses,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  webviewTag: false,
  webSecurity: true,
  navigateOnDragDrop: false,
  backgroundThrottling: false,
  disableDialogs: true,
  offscreen: { deviceScaleFactor: 2 },
});
app.on("web-contents-created", (_event, wc) => {
  wc.on("will-attach-webview", (e) => e.preventDefault());
  wc.on("will-frame-navigate", (e) => {
    if (!safeURL(e.url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (pages.size >= maxPages || (url && !safeURL(url)))
      return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        show: false,
        width: 1100,
        height: 578,
        useContentSize: true,
        webPreferences: prefs(wc.session),
      },
    };
  });
});
app.on("browser-window-created", (_event, win) => {
  const id = win.webContents.getOrCreateDevToolsTargetId();
  pages.set(id, win);
  win.on("closed", () => pages.delete(id));
});
function newWindow(ses) {
  return new BrowserWindow({
    width: 1100,
    height: 578,
    useContentSize: true,
    show: false,
    frame: false,
    skipTaskbar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: prefs(ses),
  });
}
function probeFor(ses) {
  const win = newWindow(ses);
  process.stdout.write(
    "goga-demo:" +
      JSON.stringify({ hide: win.webContents.getOrCreateDevToolsTargetId() }) +
      "\n",
  );
  return win;
}
const validParams = (p, keys) => {
  if (
    !p ||
    Array.isArray(p) ||
    typeof p !== "object" ||
    Object.keys(p).some((k) => !keys.includes(k))
  )
    throw Error("GOGA_DEMO_HELPER:helperParams");
};
function byContext(id) {
  if (id === undefined || id === defaultContextId)
    return session.defaultSession;
  const ses = contexts.get(id);
  if (!ses) throw Error("GOGA_DEMO_HELPER:browserContextUnknown");
  return ses;
}
async function handle(method, p) {
  switch (method) {
    case "Browser.setDownloadBehavior":
      // Parent acknowledges only the deny policy. Enforced on all sessions here.
      if (p.behavior !== "deny")
        throw Error("GOGA_DEMO_HELPER:downloadsForbidden");
      byContext(p.browserContextId);
      return {};
    case "Storage.getCookies":
    case "Storage.setCookies":
    case "Storage.clearCookies": {
      validParams(
        p,
        method === "Storage.setCookies"
          ? ["browserContextId", "cookies"]
          : ["browserContextId"],
      );
      const ses = byContext(p.browserContextId);
      // Native page-scoped Network commands preserve CHIPS, expiration and
      // other native CDP cookie attributes rather than guessing a conversion.
      const existing = [...pages.values()].find(
        (w) => w.webContents.session === ses,
      );
      const win = existing || probeFor(ses);
      const dbg = win.webContents.debugger;
      let attached = false;
      try {
        dbg.attach("1.3");
        attached = true;
        return await dbg.sendCommand(
          {
            "Storage.getCookies": "Network.getAllCookies",
            "Storage.setCookies": "Network.setCookies",
            "Storage.clearCookies": "Network.clearBrowserCookies",
          }[method],
          method === "Storage.setCookies" ? { cookies: p.cookies } : {},
        );
      } finally {
        if (attached && !win.isDestroyed()) dbg.detach();
        if (!existing) win.destroy();
      }
    }
    case "Target.getBrowserContexts":
      validParams(p, []);
      return { browserContextIds: [...contexts.keys()] };
    case "Target.createBrowserContext": {
      validParams(p, ["disposeOnDetach"]);
      if (
        p.disposeOnDetach !== undefined &&
        typeof p.disposeOnDetach !== "boolean"
      )
        throw Error("GOGA_DEMO_HELPER:contextLifetimeInvalid");
      if (contexts.size >= 64) throw Error("GOGA_DEMO_HELPER:contextLimit");
      const ses = session.fromPartition("goga-demo-" + randomUUID());
      secure(ses);
      // Electron doesn't publish the BrowserContextID of a Session. Ask
      // Chromium for its actual ID, so native events/targets agree with CDP.
      const probe = probeFor(ses);
      try {
        const dbg = probe.webContents.debugger;
        dbg.attach("1.3");
        const { targetInfo } = await dbg.sendCommand("Target.getTargetInfo");
        const id = targetInfo.browserContextId;
        if (!id) throw Error("GOGA_DEMO_HELPER:contextCreationFailed");
        contexts.set(id, ses);
        return { browserContextId: id };
      } finally {
        probe.destroy();
      }
    }
    case "Target.disposeBrowserContext": {
      validParams(p, ["browserContextId"]);
      if (!contexts.has(p.browserContextId))
        throw Error("GOGA_DEMO_HELPER:browserContextUnknown");
      const ses = contexts.get(p.browserContextId);
      contexts.delete(p.browserContextId);
      for (const win of [...pages.values()])
        if (win.webContents.session === ses) win.destroy();
      await ses.clearStorageData();
      return {};
    }
    case "Target.createTarget": {
      validParams(p, [
        "url",
        "browserContextId",
        "background",
        "newWindow",
        "forTab",
        "windowState",
      ]);
      // This helper allocates real, offscreen page targets, never Chrome's
      // tab container or a visible/minimized native window. Do not silently
      // pretend to create a different target type or window state.
      if (
        (p.forTab !== undefined && p.forTab !== false) ||
        (p.windowState !== undefined && p.windowState !== "normal") ||
        ["background", "newWindow"].some(
          (k) => p[k] !== undefined && typeof p[k] !== "boolean",
        )
      )
        throw Error("GOGA_DEMO_HELPER:tabTypeUnsupported");
      if (pages.size >= maxPages) throw Error("GOGA_DEMO_HELPER:tabLimit");
      const url = p.url === "" ? "about:blank" : p.url;
      if (!safeURL(url)) throw Error("GOGA_DEMO_HELPER:addressUnavailable");
      const win = newWindow(byContext(p.browserContextId));
      // Publish immediately like CDP; navigation progresses asynchronously.
      void win.loadURL(url).catch(() => {});
      return { targetId: win.webContents.getOrCreateDevToolsTargetId() };
    }
    case "Target.closeTarget":
    case "Target.activateTarget": {
      validParams(p, ["targetId"]);
      const win = pages.get(p.targetId);
      if (!win || win.isDestroyed()) throw Error("GOGA_DEMO_HELPER:tabMissing");
      if (method === "Target.closeTarget") {
        win.destroy();
        return { success: true };
      }
      win.webContents.focus();
      return {};
    }
    default:
      throw Error("GOGA_DEMO_HELPER:commandUnavailable");
  }
}
app
  .whenReady()
  .then(async () => {
    Menu.setApplicationMenu(null);
    secure(session.defaultSession);
    const initial = newWindow(session.defaultSession);
    const initialDebugger = initial.webContents.debugger;
    initialDebugger.attach("1.3");
    try {
      const { targetInfo } = await initialDebugger.sendCommand(
        "Target.getTargetInfo",
      );
      defaultContextId = targetInfo.browserContextId;
    } finally {
      initialDebugger.detach();
    }
    await initial.loadURL(startPage(getLocale(), t("hostTerminal.startPageTitle"), t("hostTerminal.startPageHint")));
    const parser = createInterface({ input: process.stdin });
    let tail = Promise.resolve();
    parser.on("line", (line) => {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) return app.exit(1);
      tail = tail
        .then(async () => {
          const { id, method, params } = JSON.parse(line);
          if (!Number.isSafeInteger(id)) throw Error("Bad id");
          let reply;
          try {
            reply = { id, result: await handle(method, params) };
          } catch (e) {
            reply = { id, error: e.message };
          }
          process.stdout.write("goga-demo:" + JSON.stringify(reply) + "\n");
        })
        .catch(() => app.exit(1));
    });
    parser.on("close", () => app.exit());
  })
  .catch(() => app.exit(1));
