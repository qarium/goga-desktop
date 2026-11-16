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
if (packaged && !path.isAbsolute(packaged))
  throw Error("Expected absolute packaged executable");
const { _electron, chromium } = req(
  process.env.GOGA_SMOKE_PLAYWRIGHT_CORE || "playwright-core",
);
const tmp = await fs.mkdtemp(
  path.join(await fs.realpath(os.tmpdir()), "goga-demo-electron-"),
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
  if (!["/a", "/b"].includes(r.url)) {
    s.writeHead(404);
    return s.end();
  }
  s.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  s.end(
    "<!doctype html><title>Fixture " +
      r.url +
      "</title><h1>" +
      r.url +
      "</h1><textarea></textarea>",
  );
});
const reserve = net.createServer();
let app,
  panel,
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
  const geometry = [];
  const compactToolbar = async (scope = panel) => {
    assert.equal(await scope.locator(".demo-port-indicator").count(), 0);
    const copy = scope.getByRole("button", {
      name: "Скопировать адрес страницы",
      exact: true,
    });
    const expectedURL = await scope.locator(".demo-page-url").inputValue();
    const openForCopy = !(await copy.isVisible());
    if (openForCopy)
      await scope.getByRole("button", {name:"Показать адрес страницы",exact:true}).click();
    const copiesBefore = await app.evaluate(
      () => globalThis.__demoTestCopies.length,
    );
    if (expectedURL) {
      await copy.click();
      await scope
        .locator(".demo-copy-feedback")
        .filter({ hasText: "Скопировано" })
        .waitFor();
      const copies = await app.evaluate(() => globalThis.__demoTestCopies);
      assert.equal(copies.length, copiesBefore + 1);
      assert.equal(copies.at(-1), expectedURL);
    } else assert.equal(await copy.isDisabled(), true);
    if (openForCopy)
      await scope.getByRole("button", {name:"Показать адрес страницы",exact:true}).click();
    const measured = await scope.locator(".demo-bar").evaluate((el) => {
      const bar = el.getBoundingClientRect();
      const selectors = [
        ".demo-connection-info",
        ".demo-tabs-bar",
        ".demo-page-address",
        'button[aria-label="Обновить страницу"]',
        'button[aria-label="Передать управление"]',
        'button[aria-label="Переключить порт сюда"]',
        'button[aria-label="Подключить порт к этому показу"]',
        'button[aria-label="Развернуть показ"]',
        'button[aria-label="Свернуть показ"]',
      ];
      const parts = selectors
        .flatMap((selector) => [...el.querySelectorAll(selector)])
        .map((part) => {
          const r = part.getBoundingClientRect();
          return {
            name: part.getAttribute("aria-label") || part.className,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        })
        .filter((r) => r.width > 0 && r.height > 0)
        .sort((a, b) => a.left - b.left);
      return {
        height: bar.height,
        width: bar.width,
        left: bar.left,
        right: bar.right,
        top: bar.top,
        bottom: bar.bottom,
        overflow: el.scrollWidth > el.clientWidth + 1,
        tabs: el.querySelector('[role="tablist"]') !== null,
        tabStyles: [...el.querySelectorAll(".demo-tab")].map((tab) => {
          const style = getComputedStyle(tab);
          const label = tab.querySelector('[role="tab"]');
          const close = tab.querySelector(".demo-tab-close");
          const labelStyle = getComputedStyle(label);
          const r = tab.getBoundingClientRect();
          const c = close.getBoundingClientRect();
          return {
            selected: label.getAttribute("aria-selected") === "true",
            radius: style.borderRadius,
            borders: [
              style.borderTopWidth,
              style.borderRightWidth,
              style.borderBottomWidth,
              style.borderLeftWidth,
            ],
            color: style.color,
            underline: style.borderBottomColor,
            shadow: style.boxShadow,
            fontSize: labelStyle.fontSize,
            padding: [labelStyle.paddingLeft, labelStyle.paddingRight],
            closeWidth: c.width,
            closeInside:
              c.left >= r.left &&
              c.right <= r.right + 1 &&
              c.top >= r.top &&
              c.bottom <= r.bottom + 1,
          };
        }),
        createWidth: el
          .querySelector(".demo-tab-create")
          .getBoundingClientRect().width,
        parts,
      };
    });
    assert.equal(
      measured.height,
      42,
      "Панель не должна занимать больше одной строки42px",
    );
    assert.equal(
      measured.tabs,
      true,
      "Вкладки должны находиться внутри toolbar, а не отдельным рядом",
    );
    assert.equal(
      measured.overflow,
      false,
      "Toolbar выходит за границы рабочей области",
    );
    assert(measured.tabStyles.length > 0);
    for (const tabStyle of measured.tabStyles) {
      assert.equal(
        tabStyle.radius,
        "0px",
        "Вкладки должны быть плоскими, как в терминале",
      );
      assert.deepEqual(tabStyle.borders, ["0px", "0px", "2px", "0px"]);
      assert.equal(
        tabStyle.shadow,
        "none",
        "Старая верхняя подсветка не должна оставаться",
      );
      assert.equal(tabStyle.fontSize, "13px");
      assert.deepEqual(tabStyle.padding, ["12px", "12px"]);
      assert.equal(
        tabStyle.color,
        tabStyle.selected ? "rgb(25, 202, 187)" : "rgb(145, 162, 186)",
      );
      if (tabStyle.selected)
        assert.equal(tabStyle.underline, "rgb(25, 202, 187)");
      assert.equal(tabStyle.closeWidth, 26);
      assert(
        tabStyle.closeInside,
        "Крестик не должен выходить за границы вкладки",
      );
    }
    assert.equal(measured.createWidth, 34, "Плюс использует размеры терминала");
    for (const name of [
      "demo-connection-info",
      "demo-tabs-bar",
      "demo-page-address",
      "Обновить страницу",
    ])
      assert(
        measured.parts.some((part) => part.name.includes(name)),
        "Не измерено обязательное действие: " + name,
      );
    for (let i = 0; i < measured.parts.length; i++) {
      const r = measured.parts[i];
      assert(
        r.left >= measured.left - 1 &&
          r.right <= measured.right + 1 &&
          r.top >= measured.top - 1 &&
          r.bottom <= measured.bottom + 1,
        "Действие вне строки: " + r.name,
      );
      if (i)
        assert(
          measured.parts[i - 1].right <= r.left + 1,
          "Пересечение элементов: " +
            measured.parts[i - 1].name +
            " / " +
            r.name,
        );
    }
    geometry.push(measured);
  };
  const openShow = async () => {
    await btn("Запустить").click();
    await panel.getByRole("menuitem", { name: /^Начать демонстрацию/ }).click();
    await tab().waitFor();
    await url().waitFor();
  };
  const choose = async (name) => {
    await panel
      .locator("button.project-button")
      .filter({ hasText: name })
      .click();
  };
  const stop = async () => {
    await btn("Закрыть вкладку Демонстрация").click();
    await panel
      .getByRole("dialog", { name: "Завершить показ?" })
      .getByRole("button", { name: "Завершить показ", exact: true })
      .click();
    await tab().waitFor({ state: "detached" });
  };
  phase = "settings";
  await btn("Настройки").click();
  await btn("Демонстрации").click();
  await panel.getByTestId("demo-port").fill(String(port));
  await panel.getByTestId("demo-port-save").click();
  await until(async () => (await query()).port === port);
  await btn("← Назад").click();
  phase = "first project, open";
  await choose(projects[0].name);
  await openShow();
  const a = (await query()).shows[0];
  assert.equal(a.scope, projects[0].id);
  assert.equal(a.engine, "embedded");
  const agent = await chromium.connectOverCDP("http://127.0.0.1:" + port),
    page = agent.contexts()[0].pages()[0];
  assert.equal(
    await page.evaluate(() => navigator.userAgent.includes("Electron/")),
    true,
    "No external Chrome may serve an embedded demonstration",
  );
  assert.equal(await page.evaluate(() => typeof window.goga), "undefined");
  phase = "address actions";
  await url().fill(origin + "/a");
  await url().press("Enter");
  await page.waitForURL(origin + "/a");
  await page.locator("textarea").fill("A draft");
  const marker = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(() => history.pushState({}, "", "#agent"));
  await until(async () => (await url().inputValue()) === origin + "/a#agent");
  phase = "copy URL rather than an unsent address draft";
  await url().fill("https://unfinished.invalid/");
  await btn("Скопировать адрес страницы").click();
  await until(
    async () =>
      (await app.evaluate(() => globalThis.__demoTestCopies)).at(-1) ===
      origin + "/a#agent",
  );
  assert.equal(await page.evaluate(() => performance.timeOrigin), marker);
  await url().press("Escape");
  phase = "browser tabs in Desktop";
  await page.evaluate(() => {
    document.title = "Первая страница";
  });
  const pagesBar = () => panel.getByRole("tablist", { name: "Вкладки показа" });
  await pagesBar()
    .getByRole("tab", { name: "Первая страница", exact: true })
    .waitFor();
  const firstTabId = (await query()).shows.find(
    (s) => s.showId === a.showId,
  ).activeTabId;
  await btn("Создать вкладку").click();
  await until(async () => {
    const s = (await query()).shows.find((s) => s.showId === a.showId);
    return s.tabs.length === 2 && s.activeTabId !== firstTabId;
  });
  await until(async () => (await url().inputValue()) === "");
  await url().fill(origin + "/b");
  await url().press("Enter");
  await pagesBar()
    .getByRole("tab", { name: "Fixture /b", exact: true, selected: true })
    .waitFor();
  // A pending address draft from this page must never follow another tab.
  await url().fill("http://unfinished.invalid/");
  await pagesBar()
    .getByRole("tab", { name: "Первая страница", exact: true })
    .click();
  await until(async () => (await url().inputValue()) === origin + "/a#agent");
  await panel.locator(".demo-frame.is-ready").waitFor();
  for (const [width, height] of [
    [920, 700],
    [1280, 800],
    [1600, 1000],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) =>
        BrowserWindow.getAllWindows()[0].setSize(width, height),
      { width, height },
    );
    await until(async () => (await panel.evaluate(() => innerWidth)) === width);
    await compactToolbar();
    assert.equal(await pagesBar().getByRole("tab").count(), 2);
    const overflow = await panel
      .locator(".demo-tabs-bar")
      .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(overflow, false);
    await panel.screenshot({
      path: path.join(
        repo,
        "work/demonstrations-desktop/compact-desktop-" + width + ".png",
      ),
    });
  }
  phase = "shared tab keyboard focus";
  const first = pagesBar().getByRole("tab", {
    name: "Первая страница",
    exact: true,
  });
  await first.focus();
  await first.press("ArrowRight");
  const second = pagesBar().getByRole("tab", {
    name: "Fixture /b",
    exact: true,
  });
  await until(
    async () => (await second.getAttribute("aria-selected")) === "true",
  );
  // Host selection temporarily disables controls (existing behaviour). Check
  // the shared focus ring after the command settles, not during that interval.
  await until(() => second.isEnabled());
  await second.focus();
  assert.deepEqual(
    await second.evaluate((el) => {
      const s = getComputedStyle(el);
      return [
        el === document.activeElement,
        el.matches(":focus-visible"),
        s.outlineWidth,
        s.outlineOffset,
      ];
    }),
    [true, true, "2px", "-2px"],
  );
  await second.press("ArrowLeft");
  await until(
    async () => (await first.getAttribute("aria-selected")) === "true",
  );
  phase = "compact many-tab toolbar";
  for (let i = 0; i < 4; i++) {
    await btn("Создать вкладку").click();
    await until(
      async () =>
        (await query()).shows.find((s) => s.showId === a.showId).tabs.length ===
        3 + i,
    );
  }
  await pagesBar()
    .getByRole("tab", { name: "Первая страница", exact: true })
    .click();
  await until(async () => (await url().inputValue()) === origin + "/a#agent");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(920, 700),
  );
  await until(async () => (await panel.evaluate(() => innerWidth)) === 920);
  await compactToolbar();
  assert.equal(
    await panel
      .locator(".demo-tabs")
      .evaluate((el) => el.scrollWidth > el.clientWidth),
    true,
  );
  const tabScroller = panel.locator(".demo-tabs");
  await tabScroller.hover();
  const beforeScroll = await tabScroller.evaluate((el) => el.scrollLeft);
  await panel.mouse.wheel(0, 160);
  await until(
    async () =>
      (await tabScroller.evaluate((el) => el.scrollLeft)) > beforeScroll,
  );
  await panel.screenshot({
    path: path.join(repo, "work/demonstrations-desktop/compact-many-tabs.png"),
  });
  await btn("Развернуть показ").click();
  const full = panel.getByRole("dialog", {
    name: "Развёрнутый показ",
    exact: true,
  });
  await compactToolbar(full);
  assert.equal(
    await full
      .getByRole("tablist", { name: "Вкладки показа" })
      .getByRole("tab")
      .count(),
    6,
  );
  assert.equal(
    await full.getByRole("textbox", { name: "Адрес страницы" }).inputValue(),
    origin + "/a#agent",
  );
  for (const name of [
    "Передать управление",
    "Настройки порта",
    "Открыть в браузере",
  ])
    assert.equal(
      await full.getByRole("button", { name, exact: true }).count(),
      1,
    );
  await full
    .getByRole("button", { name: "Передать управление", exact: true })
    .click();
  await panel.getByTestId("demo-dialog").waitFor();
  await panel.getByTestId("demo-cancel").click();
  assert.equal((await query()).access.owner, a.showId);
  assert.equal((await query()).access.phase, "connected");
  await panel.screenshot({
    path: path.join(repo, "work/demonstrations-desktop/compact-expanded.png"),
  });
  await panel.getByTestId("demo-collapse").click();
  phase = "narrow address overlay";
  // Exercise the extra narrow component breakpoint without changing the real
  // application's minimum window size. This is only our synthetic test DOM.
  await panel.locator(".demo-workspace").evaluate((el) => {
    el.style.maxWidth = "400px";
  });
  assert.equal(await url().isVisible(), false);
  await btn("Показать адрес страницы").click();
  await url().waitFor({ state: "visible" });
  await url().fill("http://draft-only.invalid/");
  await url().press("Escape");
  assert.equal(await url().isVisible(), false);
  await compactToolbar();
  await panel.locator(".demo-workspace").evaluate((el) => {
    el.style.maxWidth = "";
  });
  await url().waitFor({ state: "visible" });
  assert.equal(await url().inputValue(), origin + "/a#agent");
  for (let i = 0; i < 4; i++) {
    await pagesBar()
      .getByRole("button", {
        name: "Закрыть вкладку: Новая вкладка",
        exact: true,
      })
      .last()
      .click();
    await until(
      async () =>
        (await query()).shows.find((s) => s.showId === a.showId).tabs.length ===
        5 - i,
    );
  }
  await pagesBar()
    .getByRole("button", { name: "Закрыть вкладку: Fixture /b", exact: true })
    .click();
  await until(
    async () =>
      (await query()).shows.find((s) => s.showId === a.showId).tabs.length ===
      1,
  );
  phase = "change default engine without disturbing an active show";
  const ownerBefore = (await query()).access;
  await btn("Настройки").click();
  await btn("Демонстрации").click();
  const engineChoice = panel.getByRole("combobox", {
    name: "Браузер демонстрации",
  });
  for (const [engine, label] of [
    ["system", "Системный браузер"],
    ["embedded", "Встроенный Chromium"],
  ]) {
    await engineChoice.click();
    await panel.getByRole("option", { name: label, exact: true }).click();
    await until(async () => (await query()).engine === engine);
    const current = await query();
    assert.deepEqual(current.access, ownerBefore);
    assert.equal(current.port, port);
    assert.equal(
      current.shows.find((s) => s.showId === a.showId).engine,
      "embedded",
    );
    assert.equal(await page.evaluate(() => performance.timeOrigin), marker);
    assert.equal(await page.locator("textarea").inputValue(), "A draft");
  }
  await btn("← Назад").click();
  phase = "second project";
  await choose(projects[1].name);
  await openShow();
  const st = await query(),
    b = st.shows.find((s) => s.scope === projects[1].id);
  assert(b);
  await compactToolbar();
  assert.equal(st.access.owner, a.showId);
  const foreignId = (await query()).shows.find((s) => s.showId === a.showId)
    .tabs[0].tabId;
  const denied = await panel.evaluate(
    async ({ showId, tabId }) => {
      try {
        await window.goga.demoExecute({ action: "tab-close", showId, tabId });
        return false;
      } catch {
        return true;
      }
    },
    { showId: b.showId, tabId: foreignId },
  );
  assert.equal(denied, true);
  const foreignStream = await panel.evaluate(
    async ({ showId, tabId }) => {
      return (
        await Promise.allSettled([
          window.goga.demoNextFrame(showId, tabId, null),
          window.goga.demoExecute({
            action: "input",
            showId,
            tabId,
            input: { action: "text", text: "foreign input" },
          }),
        ])
      ).map((result) => result.status);
    },
    { showId: b.showId, tabId: foreignId },
  );
  assert.deepEqual(foreignStream, ["rejected", "rejected"]);
  assert.equal(
    (await query()).shows.find((s) => s.showId === a.showId).tabs[0].tabId,
    foreignId,
  );
  await url().fill(origin + "/b");
  await url().press("Enter");
  await until(
    async () =>
      (await query()).shows.find((s) => s.showId === b.showId)?.url ===
      origin + "/b",
  );
  assert.deepEqual(
    await page.evaluate(() => [
      performance.timeOrigin,
      document.querySelector("textarea").value,
    ]),
    [marker, "A draft"],
  );
  phase = "explicit transfer";
  await btn("Переключить порт сюда").click();
  await Promise.all([
    once(agent, "disconnected", { signal: AbortSignal.timeout(10000) }),
    panel.getByTestId("demo-confirm").click(),
  ]);
  const next = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
      noDefaults: true,
      timeout: 9000,
    }),
    p2 = next.contexts()[0].pages()[0];
  assert.equal(p2.url(), origin + "/b");
  await p2.locator("textarea").fill("B draft");
  await btn("Передать управление").click();
  await Promise.all([
    once(next, "disconnected", { signal: AbortSignal.timeout(10000) }),
    panel.getByTestId("demo-confirm").click(),
  ]);
  const last = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
    noDefaults: true,
    timeout: 9000,
  });
  assert.equal(
    await last.contexts()[0].pages()[0].locator("textarea").inputValue(),
    "B draft",
  );
  phase = "close";
  await stop();
  const after = await query();
  assert.equal(after.access.owner, null);
  assert.deepEqual(
    after.shows.map((s) => s.showId),
    [a.showId],
  );
  await choose(projects[0].name);
  await tab().click();
  assert.equal(await url().inputValue(), origin + "/a#agent");
  phase = "closing last browser tab keeps show alive";
  await btn("Подключить порт к этому показу").click();
  await until(async () => (await query()).access.owner === a.showId);
  await pagesBar()
    .getByRole("button", {
      name: "Закрыть вкладку: Первая страница",
      exact: true,
    })
    .click();
  await until(async () => {
    const s = (await query()).shows.find((s) => s.showId === a.showId);
    return (
      s?.tabs.length === 1 && s.activeTabId !== firstTabId && s.url === null
    );
  });
  assert.equal((await query()).access.owner, a.showId);
  await until(async () => (await url().inputValue()) === "");
  await stop();
  assert.equal((await query()).shows.length, 0);
  await fs.writeFile(
    path.join(repo, "work/demonstrations-desktop/compact-geometry.json"),
    JSON.stringify(geometry, null, 2),
  );
  console.log(
    "OK: компактный toolbar42px normal/fullscreen на920/1280/1600px,6вкладок с горизонтальной прокруткой без пересечений; все действия, порт/handoff, сброс URL-черновика, изоляция чужого tabId, last blank и stop.",
  );
} catch (e) {
  if (panel) {
    console.error(
      "Состояние тестового показа:",
      JSON.stringify(
        await panel
          .evaluate(async () => ({
            state: await window.goga.demoState(),
            address: document.querySelector('[data-testid="demo-url"]')?.value,
            note: document.querySelector(".demo-inline-note")?.textContent,
          }))
          .catch(() => null),
      ),
    );
    await panel
      .screenshot({
        path: path.join(
          repo,
          "work/demonstrations-desktop/tabs-desktop-failure.png",
        ),
      })
      .catch(() => {});
  }
  const buttons = panel
    ? await panel
        .getByRole("button")
        .allTextContents()
        .catch(() => [])
    : [];
  console.error(
    "Этап:",
    phase,
    "; видимые действия:",
    buttons
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 32)
      .join(" / ")
      .slice(0, 600),
  );
  throw e;
} finally {
  try {
    // This is our private Electron process. Never address an existing instance.
    if (app) {
      if (panel)
        await panel
          .evaluate(async () => {
            for (const s of (await window.goga.demoState()).shows) {
              if (s.scope === "fixture-a" || s.scope === "fixture-b")
                await window.goga.demoExecute({
                  action: "stop",
                  showId: s.showId,
                });
            }
          })
          .catch(() => {});
      const child = app.process();
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, "exit").catch(() => {}),
          timer = setTimeout(() => child.kill("SIGKILL"), 6500);
        timer.unref();
        void app
          .evaluate(({ app }) => {
            setTimeout(() => app.exit(0), 20);
          })
          .catch(() => {});
        await ended;
        clearTimeout(timer);
      }
    }
  } finally {
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise((r) => fixture.close(r));
    if (reserve.listening) await new Promise((r) => reserve.close(r));
    await fs.rm(tmp, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 160,
    });
  }
}
