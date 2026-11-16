// Production main, sandboxed preload and production renderer (requires npm run build).
// All OS and Goga state under a unique temporary HOME; no personal project, Goga
// binary or shared Electron single-instance directory is used by this scenario.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const req = createRequire(import.meta.url),
  repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Optional path to a freshly packaged app; never address a running instance.
const packaged = process.env.GOGA_SMOKE_PACKAGED_EXECUTABLE;
const engine = process.argv.includes("--system") ? "system" : "embedded";
if (packaged && !path.isAbsolute(packaged))
  throw Error("Expected absolute packaged executable");
const { _electron, chromium } = req(
  process.env.GOGA_SMOKE_PLAYWRIGHT_CORE || "playwright-core",
);
const tmp = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "goga-demo-selection-"),
);
const home = path.join(tmp, "home"),
  userData = path.join(tmp, "desktop"),
  localBin = path.join(home, ".local/bin"),
  hostTmp = path.join(tmp, "temp");
const env = {
  HOME: home,
  CFFIXED_USER_HOME: home,
  GOGA_DESKTOP_DATA_DIR: userData,
  TMPDIR: hostTmp,
  PATH: localBin + ":/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/usr/bin/false",
  SSH_ASKPASS: "/usr/bin/false",
};
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
};
const fixture = http.createServer((r, s) => {
  s.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  const isOther = r.url?.startsWith("/b");
  s.end(`<!doctype html><meta charset="utf-8"><title>${isOther ? "Selection B" : "Selection A"}</title>
<style>body{margin:0;padding:38px 48px;font:22px monospace;color:#12213a;background:#fff}p{margin:0 0 30px;white-space:pre}input,textarea,[contenteditable]{font:22px monospace;width:900px;padding:8px;margin:0 0 20px;display:block;box-sizing:border-box;border:1px solid #456}textarea{height:54px;resize:none}#drag-target{width:120px;height:24px;background:#cdf;font-size:14px}</style>
<p id="paragraph">${isOther ? "Other private topic text." : "Alpha selected text inside one page."}</p>
<input id="input" value="Editable input text">
<textarea id="textarea">Textarea chosen text</textarea>
<div id="editable" contenteditable>Editable paragraph text</div>
<input id="password" type="password" value="not-a-real-secret">
<div id="shadow"></div><iframe id="subframe" srcdoc="<p style='font:22px monospace;margin:0'>Nested frame selected text</p>"></iframe>
<script>
window.pointerEvents=[];for(const type of ['mousedown','mousemove','mouseup'])document.addEventListener(type,e=>pointerEvents.push({type,buttons:e.buttons,detail:e.detail,x:e.clientX,y:e.clientY}));
window.pageCopyCount=0;document.addEventListener("copy",e=>{pageCopyCount++;e.clipboardData.setData("text/plain","page-handler-must-not-run");e.preventDefault();});
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<span>Shadow selected text</span>';
</script>`);
});
const reserve = net.createServer();
let app,
  panel,
  agent,
  phase = "prepare";
try {
  for (const d of [localBin, userData, hostTmp, path.join(home, ".goga")])
    await fs.mkdir(d, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, ".goga/config.yml"), "{}\n");
  const projects = [];
  for (const [id, name] of [
    ["fixture-a", "Demo Acceptance A"],
    ["fixture-b", "Demo Acceptance B"],
  ]) {
    const local = path.join(tmp, id);
    await fs.mkdir(path.join(local, ".goga"), { recursive: true });
    await fs.writeFile(
      path.join(local, ".goga/config.yml"),
      "topics:\n  base_ref: main\n",
    );
    execFileSync("/usr/bin/git", ["init", "-q", "-b", "main", local], {
      env,
      stdio: "ignore",
    });
    execFileSync("/usr/bin/git", ["-C", local, "add", ".goga/config.yml"], {
      env,
      stdio: "ignore",
    });
    execFileSync(
      "/usr/bin/git",
      [
        "-C",
        local,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { env, stdio: "ignore" },
    );
    projects.push({ id, name, path: local });
  }
  await fs.writeFile(
    path.join(userData, "projects.json"),
    JSON.stringify(projects),
  );
  const fake = path.join(localBin, "goga");
  await fs.writeFile(
    fake,
    `#!/bin/sh
case "$*" in
 "pipeline --list --info") printf '%s\\n' '* example (project)' '  name: Fixture' '---';;
 "topics board --json --per-host"|"topics board --per-host --json") printf '%s\\n' '[{"branch":"main","topic":"main","current":true,"remote":false,"todo":"","statuses":[]}]';;
 *) exit 1;;
esac
`,
    { mode: 0o700 },
  );
  const port = await listen(reserve);
  await new Promise((r) => reserve.close(r));
  const origin = "http://127.0.0.1:" + (await listen(fixture));
  phase = "launch isolated Electron";
  app = await _electron.launch({
    executablePath: packaged || req("electron"),
    args: [
      "--user-data-dir=" + userData,
      "--no-first-run",
      "--use-mock-keychain",
      "--disable-background-networking",
      ...(packaged ? [] : [repo]),
    ],
    cwd: tmp,
    env,
    timeout: 25000,
  });
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), !!packaged);
  const actual = await app.evaluate(({ app }) => [
    app.getPath("userData"),
    process.env.HOME,
    process.env.PATH.split(":")[0],
  ]);
  assert.deepEqual(actual, [userData, home, localBin]);
  // This process is disposable. Never exercise the user's real OS clipboard.
  await app.evaluate(({ clipboard }) => {
    globalThis.__demoTestCopies = [];
    clipboard.writeText = async (text) => {
      globalThis.__demoTestCopies.push(text);
    };
  });
  panel = await app.firstWindow();
  panel.setDefaultTimeout(10000);
  const btn = (name) => panel.getByRole("button", { name, exact: true }),
    tab = () =>
      panel
        .getByRole("tablist", { name: "Разделы проекта" })
        .getByRole("tab", { name: "Демонстрация", exact: true });
  const query = () => panel.evaluate(() => window.goga.demoState());
  const url = () =>
    panel.getByRole("textbox", { name: "Адрес страницы", exact: true });
  const until = async (fn) => {
    for (let i = 0; i < 85; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("Не дождались состояния: " + phase);
  };

  const readCopies = () => app.evaluate(() => globalThis.__demoTestCopies);
  const currentShow = async () => {
    const state = await query();
    return state.shows.find((s) => s.scope === "fixture-a");
  };
  const openShow = async () => {
    await btn("Запустить").click();
    await panel.getByRole("menuitem", { name: /^Начать демонстрацию/ }).click();
    await tab().waitFor();
  };
  const choose = async (name) =>
    panel.locator("button.project-button").filter({ hasText: name }).click();
  await btn("Настройки").click();
  await btn("Демонстрации").click();
  await panel.getByTestId("demo-port").fill(String(port));
  await panel.getByTestId("demo-port-save").click();
  await until(async () => (await query()).port === port);
  await btn("← Назад").click();
  await panel.evaluate(
    (engine) => window.goga.demoExecute({ action: "engine", engine }),
    engine,
  );
  await choose(projects[0].name);
  await openShow();
  const a = await currentShow();
  assert.equal(a.engine, engine);
  agent = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  const source = agent.contexts()[0].pages()[0];
  assert.equal(
    await source.evaluate(() => navigator.userAgent.includes("Electron/")),
    engine === "embedded",
  );
  await source.goto(origin + "/a");
  await until(async () => (await currentShow()).url === origin + "/a");
  const surface = () => panel.locator(".demo-frame.is-ready");
  await surface().waitFor();
  async function canvasPoint(p) {
    return surface().evaluate((cv, p) => {
      const r = cv.getBoundingClientRect(),
        scale = Math.min(r.width / cv.width, r.height / cv.height);
      return {
        x:
          r.left +
          (r.width - cv.width * scale) / 2 +
          (p.x / p.width) * cv.width * scale,
        y:
          r.top +
          (r.height - cv.height * scale) / 2 +
          (p.y / p.height) * cv.height * scale,
      };
    }, p);
  }
  async function sourcePoints(selector, count) {
    return source.evaluate(
      ({ selector, count }) => {
        const frame = selector.startsWith("#subframe ")
          ? document.querySelector("#subframe")
          : null;
        const el = frame
          ? frame.contentDocument.querySelector(
              selector.slice("#subframe ".length),
            )
          : selector.startsWith("#shadow ")
            ? document
                .querySelector("#shadow")
                .shadowRoot.querySelector(selector.slice("#shadow ".length))
            : document.querySelector(selector);
        const style = getComputedStyle(el),
          rect = el.getBoundingClientRect();
        const value = ("value" in el ? el.value : el.textContent).slice(
          0,
          count,
        );
        let x, y, width;
        if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement
        ) {
          const cv = document.createElement("canvas"),
            ctx = cv.getContext("2d");
          ctx.font = style.font;
          x = rect.left + parseFloat(style.paddingLeft) + 1;
          y =
            rect.top +
            parseFloat(style.paddingTop) +
            parseFloat(style.fontSize) / 2;
          width = ctx.measureText(value).width;
        } else {
          const range = document.createRange();
          range.setStart(el.firstChild, 0);
          range.setEnd(el.firstChild, count);
          const r = range.getBoundingClientRect();
          x = r.left + 0.1;
          y = r.top + r.height / 2;
          width = r.width;
        }
        if (frame) {
          const r = frame.getBoundingClientRect();
          x += r.left + frame.clientLeft;
          y += r.top + frame.clientTop;
        }
        return {
          start: { x, y, width: innerWidth, height: innerHeight },
          end: {
            x: x + width - 0.2,
            y,
            width: innerWidth,
            height: innerHeight,
          },
          value,
        };
      },
      { selector, count },
    );
  }
  async function readSelection(selector) {
    return source.evaluate((selector) => {
      const frame = selector.startsWith("#subframe ")
        ? document.querySelector("#subframe")
        : null;
      const el = frame
        ? frame.contentDocument.querySelector(
            selector.slice("#subframe ".length),
          )
        : selector.startsWith("#shadow ")
          ? document
              .querySelector("#shadow")
              .shadowRoot.querySelector(selector.slice("#shadow ".length))
          : document.querySelector(selector);
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
        : (frame ? frame.contentWindow : window).getSelection()?.toString() ||
            "";
    }, selector);
  }
  async function drag(selector, count) {
    const points = await sourcePoints(selector, count),
      start = await canvasPoint(points.start),
      end = await canvasPoint(points.end);
    const sample = {
      ...points.start,
      x: points.start.x + 4,
      y: points.start.y + 8,
    };
    const pixel = () =>
      surface().evaluate(
        (cv, p) =>
          Array.from(
            cv
              .getContext("2d")
              .getImageData(
                Math.floor((p.x / p.width) * cv.width),
                Math.floor((p.y / p.height) * cv.height),
                1,
                1,
              ).data,
          ),
        sample,
      );
    const before = selector === "#paragraph" ? await pixel() : null;
    await panel.mouse.move(start.x, start.y);
    await panel.mouse.down();
    await panel.mouse.move(end.x, end.y, { steps: 12 });
    await panel.mouse.up();
    await until(async () => (await readSelection(selector)) === points.value);
    if (before)
      await until(
        async () => JSON.stringify(await pixel()) !== JSON.stringify(before),
      );
    return { expected: points.value, end };
  }
  async function copyKey(key, expected) {
    const before = (await readCopies()).length;
    await surface().focus();
    await panel.keyboard.press(key);
    await until(async () => (await readCopies()).length === before + 1);
    assert.equal((await readCopies()).at(-1), expected);
    await panel.waitForTimeout(100);
    assert.equal(
      (await readCopies()).length,
      before + 1,
      "Shortcut caused duplicate clipboard writes",
    );
  }
  if (process.argv.includes("--foreground-drag")) {
    phase = "native foreground sibling during original drag";
    const original = (await currentShow()).activeTabId,
      points = await sourcePoints("#paragraph", 19);
    const start = await canvasPoint(points.start),
      end = await canvasPoint(points.end);
    await source.evaluate(() => (window.pointerEvents = []));
    await panel.mouse.move(start.x, start.y);
    await panel.mouse.down();
    await until(async () =>
      (await source.evaluate(() => pointerEvents)).some(
        (e) => e.type === "mousedown",
      ),
    );
    const sibling = await agent.contexts()[0].newPage();
    await sibling.goto(origin + "/b");
    assert.equal(
      (await currentShow()).activeTabId,
      original,
      "Sibling creation must not select the host show",
    );
    const started = Date.now();
    await panel.mouse.move(end.x, end.y, { steps: 12 });
    await panel.mouse.up();
    await until(
      async () => (await readSelection("#paragraph")) === points.value,
    );
    await until(async () =>
      (await source.evaluate(() => pointerEvents)).some(
        (e) => e.type === "mouseup",
      ),
    );
    console.log(
      "FOREGROUND-DRAG " +
        engine +
        " " +
        (Date.now() - started) +
        "ms; selection=" +
        (await readSelection("#paragraph")),
    );
  } else {
    phase = "mouse paragraph selection and Cmd+C";
    const selected = await drag("#paragraph", 19);
    assert.deepEqual(
      await readCopies(),
      [],
      "Selection alone must not write clipboard",
    );
    await copyKey("Meta+C", selected.expected);
    phase = "double click selects a word";
    const word = await canvasPoint((await sourcePoints("#paragraph", 1)).start);
    await panel.mouse.dblclick(word.x + 3, word.y);
    await until(async () => (await readSelection("#paragraph")) === "Alpha");
    await copyKey("Control+C", "Alpha");
    phase = "triple click selects a paragraph";
    // Start an independent triple-click sequence on a different word. Three
    // additional clicks at the immediately preceding double-click coordinate
    // would intentionally be the continuation of a five-click sequence.
    await panel.mouse.click(word.x + 100, word.y, { clickCount: 3 });
    await until(
      async () =>
        (await readSelection("#paragraph")).trimEnd() ===
        "Alpha selected text inside one page.",
    );
    await copyKey("Control+C", await readSelection("#paragraph"));
    phase = "textarea drag and Ctrl+C";
    await copyKey("Control+C", (await drag("#textarea", 14)).expected);
    phase = "input and context menu copy";
    const chosen = await drag("#input", 14);
    await panel.mouse.click(chosen.end.x, chosen.end.y, { button: "right" });
    await panel
      .getByRole("menuitem", { name: "Копировать", exact: true })
      .click();
    await until(async () => (await readCopies()).at(-1) === chosen.expected);
    phase = "context-menu keyboard copy";
    const edited = await drag("#editable", 18);
    await panel.mouse.click(edited.end.x, edited.end.y, { button: "right" });
    await panel
      .getByRole("menuitem", { name: "Копировать", exact: true })
      .focus();
    const menuBefore = (await readCopies()).length;
    await panel.keyboard.press("Control+C");
    await until(async () => (await readCopies()).length === menuBefore + 1);
    assert.equal((await readCopies()).at(-1), edited.expected);
    await panel.waitForTimeout(100);
    assert.equal((await readCopies()).length, menuBefore + 1);
    phase = "open shadow DOM selection";
    await copyKey("Control+C", (await drag("#shadow span", 12)).expected);
    phase = "same-origin iframe selection";
    await copyKey("Control+C", (await drag("#subframe p", 12)).expected);
    assert.equal(
      await source.evaluate(() => pageCopyCount),
      0,
      "Remote copy handler must never read or replace OS clipboard",
    );
    phase = "empty and password selections never overwrite clipboard";
    let before = (await readCopies()).length;
    await source.evaluate(() => {
      getSelection().removeAllRanges();
      document
        .querySelector("#subframe")
        .contentWindow.getSelection()
        .removeAllRanges();
      document
        .querySelector("#shadow")
        .shadowRoot.getSelection?.()
        ?.removeAllRanges();
      document.activeElement?.blur();
    });
    await surface().focus();
    await panel.keyboard.press("Control+C");
    await panel.waitForTimeout(200);
    assert.equal((await readCopies()).length, before);
    await drag("#password", 10);
    await surface().focus();
    await panel.keyboard.press("Control+C");
    await panel.waitForTimeout(200);
    assert.equal(
      (await readCopies()).length,
      before,
      "Password copied to OS transport",
    );
    phase = "stale tab copy cannot use replacement page";
    const originalTab = (await currentShow()).activeTabId;
    await panel.evaluate(
      async (id) =>
        window.goga.demoExecute({ action: "tab-create", showId: id }),
      a.showId,
    );
    await until(async () => (await currentShow()).activeTabId !== originalTab);
    const stale = await panel.evaluate(
      async ({ showId, tabId }) => {
        try {
          await window.goga.demoCopySelection(
            showId,
            tabId,
            crypto.randomUUID(),
          );
          return false;
        } catch (error) {
          if (error.message.includes("Некоррект")) throw error;
          return true;
        }
      },
      { showId: a.showId, tabId: originalTab },
    );
    assert.equal(stale, true);
    assert.equal((await readCopies()).length, before);
    const replacementTab = (await currentShow()).activeTabId;
    const sibling = agent
      .contexts()[0]
      .pages()
      .find((p) => p !== source);
    assert(sibling);
    await sibling.goto(origin + "/b");
    await sibling.evaluate(() => (window.pointerEvents = []));
    await panel.evaluate(
      async ({ showId, tabId }) =>
        window.goga.demoExecute({ action: "tab-select", showId, tabId }),
      { showId: a.showId, tabId: originalTab },
    );
    await until(async () => (await currentShow()).activeTabId === originalTab);
    await surface().waitFor();
    phase = "switch mid-drag releases the original page";
    const p = await sourcePoints("#paragraph", 14),
      start = await canvasPoint(p.start),
      end = await canvasPoint(p.end);
    await source.evaluate(() => (window.pointerEvents = []));
    await panel.mouse.move(start.x, start.y);
    await panel.mouse.down();
    await panel.mouse.move(end.x, end.y, { steps: 5 });
    await until(async () =>
      (await source.evaluate(() => pointerEvents)).some(
        (e) => e.type === "mousedown",
      ),
    );
    await panel.evaluate(
      async ({ showId, tabId }) =>
        window.goga.demoExecute({ action: "tab-select", showId, tabId }),
      { showId: a.showId, tabId: replacementTab },
    );
    await until(
      async () => (await currentShow()).activeTabId === replacementTab,
    );
    await panel.mouse.up();
    await until(async () =>
      (await source.evaluate(() => pointerEvents)).some(
        (e) => e.type === "mouseup" && e.buttons === 0,
      ),
    );
    assert.equal((await readCopies()).length, before);
    assert.equal(
      (await sibling.evaluate(() => pointerEvents)).some((e) =>
        ["mousedown", "mouseup"].includes(e.type),
      ),
      false,
      "Retired drag reached the replacement page",
    );
    phase = "foreign workspace cannot borrow selection";
    await choose(projects[1].name);
    await openShow();
    const b = (await query()).shows.find((s) => s.scope === "fixture-b");
    assert(b);
    const foreign = await panel.evaluate(
      async ({ showId, tabId }) => {
        try {
          await window.goga.demoCopySelection(
            showId,
            tabId,
            crypto.randomUUID(),
          );
          return false;
        } catch (error) {
          if (error.message.includes("Некоррект")) throw error;
          return true;
        }
      },
      { showId: b.showId, tabId: originalTab },
    );
    assert.equal(foreign, true);
    assert.equal((await readCopies()).length, before);
    console.log(
      "OK: " +
        engine +
        " real canvas drag + visible highlight, double/triple click, text/textarea/input/contenteditable/shadow/iframe, Cmd+C/Ctrl+C and custom menu; clipboard stub, no empty/password/stale/foreign writes or remote copy handler; switch mid-drag released original page.",
    );
  }
} catch (e) {
  console.error("Selection smoke failed at:", phase);
  if (agent)
    console.error(
      "Source diagnostic:",
      await agent
        .contexts()[0]
        .pages()[0]
        .evaluate(() => ({
          selected: getSelection()?.toString(),
          events: window.pointerEvents?.slice(-15),
        }))
        .catch(() => null),
    );
  if (panel) {
    console.error(
      await panel
        .evaluate(() => ({
          state: window.goga.demoState ? null : "no bridge",
          alerts: [...document.querySelectorAll("[role=alert]")].map(
            (e) => e.textContent,
          ),
        }))
        .catch(() => null),
    );
    await panel
      .screenshot({
        path: path.join(
          repo,
          "work/demonstrations-desktop/selection-failure.png",
        ),
      })
      .catch(() => {});
  }
  throw e;
} finally {
  await agent?.close().catch(() => {});
  if (app) {
    if (panel)
      await panel
        .evaluate(async () => {
          for (const s of (await window.goga.demoState()).shows)
            await window.goga.demoExecute({ action: "stop", showId: s.showId });
        })
        .catch(() => {});
    const child = app.process();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").catch(() => {}),
        timer = setTimeout(() => child.kill("SIGKILL"), 6500);
      timer.unref();
      void app.evaluate(({ app }) => app.exit(0)).catch(() => {});
      await exited;
      clearTimeout(timer);
    }
  }
  fixture.closeAllConnections();
  if (fixture.listening) await new Promise((r) => fixture.close(r));
  if (reserve.listening) await new Promise((r) => reserve.close(r));
  await fs.rm(tmp, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 150,
  });
}
