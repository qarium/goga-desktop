// Real production runtime + scoped browser viewer and a separate Playwright CDP
// client. Only explicit --docker uses an already present Docker image (no pull).
// --embedded uses an isolated Electron main hosting the production runtime;
// the external viewer is driven by an independent test browser in both modes.
// No live Desktop shell, personal browser profile, Goga, network fixture outside
// loopback or existing project is used. No browser/package downloads.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { spawnSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const runFile = promisify(execFile);
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const file = fileURLToPath(import.meta.url),
  repo = path.dirname(path.dirname(file)),
  req = createRequire(import.meta.url);
if (process.argv[2] !== "--isolated-worker") {
  const core = req.resolve(
    process.env.GOGA_SMOKE_PLAYWRIGHT_CORE || "playwright-core",
  );
  const chrome =
    process.env.GOGA_SMOKE_CHROMIUM || req(core).chromium.executablePath();
  await fs.access(chrome);
  const tmp = await fs.mkdtemp(
    path.join(await fs.realpath(os.tmpdir()), "goga-demo-smoke-"),
  );
  try {
    for (const name of ["home", "temp"])
      await fs.mkdir(path.join(tmp, name), { mode: 0o700 });
    await build({
      absWorkingDir: repo,
      stdin: {
        contents:
          'export { Demonstrations } from "./src/host/demonstrations/runtime";export { createDemoBrowser } from "./src/main/demo-browser";',
        resolveDir: repo,
      },
      outfile: path.join(tmp, "runtime.cjs"),
      bundle: true,
      external: ["electron"],
      platform: "node",
      format: "cjs",
      target: "node22",
    });
    const home = path.join(tmp, "home"),
      docker = process.argv.includes("--docker");
    let imageID = "",
      cli = "";
    if (docker) {
      cli = await fs.realpath(
        process.env.GOGA_SMOKE_DOCKER_CLI || "/usr/local/bin/docker",
      );
      await fs.mkdir(path.join(tmp, "docker-config"), { mode: 0o700 });
      try {
        const args = [
          "--config",
          path.join(tmp, "docker-config"),
          "--host",
          "unix:///var/run/docker.sock",
          "image",
          "inspect",
          "prettyplay:latest",
          "--format",
          "{{.Id}} {{json .Config.Volumes}}",
        ];
        const inspected = await runFile(cli, args, {
          env: { HOME: home, PATH: "/usr/bin:/bin" },
          timeout: 5000,
        });
        const match = /^(sha256:[0-9a-f]{64}) (?:null|\{\})$/.exec(
          inspected.stdout.trim(),
        );
        assert(match);
        imageID = match[1];
      } catch {
        throw Error(
          "Docker или локальный prettyplay без автоматических томов недоступен. Ничего не запускалось и не загружалось.",
        );
      }
    }
    const embedded = process.argv.includes("--embedded");
    const workerArgs = [
      file,
      "--isolated-worker",
      tmp,
      core,
      chrome,
      cli,
      imageID,
      embedded ? "embedded" : "system",
    ];
    let args = workerArgs;
    if (embedded) {
      // A test-owned Electron main (not the user's Goga). The helper's dev
      // entrypoint must be the same compiled application that ships the engine.
      const boot = path.join(tmp, "runner.cjs");
      await fs.writeFile(
        boot,
        `
const {app}=require("electron"); app.setAppPath(${JSON.stringify(repo)}); app.dock?.hide();
process.argv=[process.execPath,...${JSON.stringify(workerArgs)}];
app.whenReady().then(()=>import(${JSON.stringify(new URL(import.meta.url).href)})).then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
`,
      );
      args = [
        "--user-data-dir=" + path.join(tmp, "helper-runner-profile"),
        "--use-mock-keychain",
        "--no-first-run",
        boot,
      ];
    }
    const out = spawnSync(embedded ? req("electron") : process.execPath, args, {
      cwd: tmp,
      timeout: 100000,
      stdio: "inherit",
      env: {
        HOME: home,
        CFFIXED_USER_HOME: home,
        TMPDIR: path.join(tmp, "temp"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        LANG: "en_US.UTF-8",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
    });
    if (out.error || out.status !== 0)
      throw Error("Не прошла изолированная проверка демонстраций.");
  } finally {
    await fs.rm(tmp, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 150,
    });
  }
} else {
  const [tmp, core, chrome, cli, imageID, engine] = process.argv.slice(3);
  assert.equal(process.env.HOME, path.join(tmp, "home"));
  assert.equal(process.cwd(), tmp);
  const { Demonstrations, createDemoBrowser } = req(
      path.join(tmp, "runtime.cjs"),
    ),
    { chromium } = req(core);
  const rt = new Demonstrations({
    settingsFile: path.join(tmp, "port.json"),
    ...(engine === "system" ? { chromePath: chrome } : {}),
  });
  const fixture = http.createServer((req, res) => {
    if (!["/blue", "/green"].includes(req.url)) {
      res.writeHead(404);
      return res.end();
    }
    const bg = req.url === "/blue" ? "#0a567a" : "#207040";
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(
      "<!doctype html><title>Demo " +
        req.url.slice(1) +
        "</title><style>body{margin:0;background:" +
        bg +
        ';min-height:3000px}textarea{position:absolute;inset:40% 20%;width:60%;height:20%;box-sizing:border-box}</style><textarea aria-label="Заметка"></textarea>',
    );
  });
  async function listen(server) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return server.address().port;
  }
  let ui, external, agent;
  const tabs = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(read, why) {
    for (let i = 0; i < 90; i++) {
      if (await read()) return;
      await wait(100);
    }
    throw Error(why);
  }
  try {
    const origin = "http://127.0.0.1:" + (await listen(fixture)),
      reserve = net.createServer(),
      port = await listen(reserve);
    await new Promise((r) => reserve.close(r));
    if (engine === "system") await rt.execute({ action: "engine", engine });
    await rt.execute({ action: "port", port });
    await rt.execute({ action: "open", scope: "fixture-a" }, "Показ A");
    await rt.execute({ action: "open", scope: "fixture-b" }, "Показ B");
    const [a, b] = (await rt.state()).shows;
    assert(a.showId !== b.showId);
    assert.equal(a.engine, engine);
    assert.equal(b.engine, engine);
    assert.equal((await rt.state()).engine, engine);
    const show = async (id) =>
      (await rt.state()).shows.find((s) => s.showId === id);
    const activeTab = async (id) => {
      const s = await show(id);
      return s?.tabs?.find((t) => t.tabId === s.activeTabId);
    };
    if (engine === "embedded") {
      const wire = await wireClient(port, "security");
      try {
        const { assertEmbeddedSecurity } =
          await import("./smoke-demo-embedded-security.mjs");
        await assertEmbeddedSecurity({ wire, origin, tmp });
      } finally {
        await wire.close();
      }
      await until(
        async () => (await rt.state()).access.phase === "waiting",
        "Security probe retained a lease",
      );
    }
    agent = await chromium.connectOverCDP("http://127.0.0.1:" + port);
    assert.equal(agent.contexts().length, 1);
    assert.equal(
      agent.contexts()[0].pages().length,
      1,
      "Desktop shell leaked into CDP targets",
    );
    const page = agent.contexts()[0].pages()[0];
    const agentVersion = await page.evaluate(() => navigator.userAgent);
    if (engine === "embedded")
      assert.ok(
        agentVersion.includes("Electron/"),
        "No embedded Electron renderer",
      );
    else
      assert.ok(
        !agentVersion.includes("Electron/"),
        "Expected a system browser",
      );
    assert.deepEqual(
      await page.evaluate(() => [
        typeof require,
        typeof process,
        typeof window.goga,
      ]),
      ["undefined", "undefined", "undefined"],
    );
    const isolated = await agent.newContext();
    try {
      const isolatedPage = await isolated.newPage();
      await isolatedPage.goto(origin + "/blue#context");
      await isolatedPage.evaluate(() => {
        localStorage.setItem("demo-secret", "context");
        document.cookie = "demo_ctx=private";
      });
      // Playwright's browser-level Storage API must refer to this real
      // context, not silently read or mutate the default Chromium session.
      await isolated.addCookies([
        { name: "pw_scope", value: "incognito", url: origin + "/" },
      ]);
      assert.ok(
        (await isolated.cookies(origin)).some(
          (c) => c.name === "pw_scope" && c.value === "incognito",
        ),
      );
      assert.ok(
        !(await page.context().cookies(origin)).some(
          (c) => c.name === "pw_scope",
        ),
      );
      await isolatedPage.bringToFront();
      await until(
        async () =>
          (await activeTab(a.showId))?.url === origin + "/blue#context",
        "Не активировалась вкладка newContext",
      );
      await page.goto(origin + "/blue#default");
      assert.deepEqual(
        await page.evaluate(() => [
          localStorage.getItem("demo-secret"),
          document.cookie,
        ]),
        [null, ""],
      );
      await page.bringToFront();
    } finally {
      await isolated.close();
    }
    await until(
      async () => (await show(a.showId)).tabs.length === 1,
      "Закрытие нового контекста оставило вкладку",
    );

    ui = await chromium.launch({
      executablePath: chrome,
      headless: true,
      args: ["--use-mock-keychain", "--no-first-run"],
    });
    const browser = await ui.newContext({
      viewport: { width: 1200, height: 850 },
      locale: "ru-RU",
    });
    external = createDemoBrowser({
      status: async (id) => {
        const s = await show(id);
        return s
          ? { url: s.url, tabs: s.tabs, activeTabId: s.activeTabId }
          : null;
      },
      frame: (id) => rt.frame(id),
      nextFrame: (id, tab, after) => rt.nextFrame(id, tab, after),
      control: (showId, action) => {
        const { op, tabId, ...params } = action;
        return rt.execute(
          op === "input"
            ? { action: "input", showId, tabId, input: params }
            : { action: op, showId, ...(tabId ? { tabId } : {}), ...params },
        );
      },
      openExternal: async (link) => {
        const view = await browser.newPage();
        view.setDefaultTimeout(10000);
        await view.goto(link);
        tabs.push(view);
      },
    });
    await external.open(a.showId);
    await external.open(b.showId);
    const [viewA, viewB] = tabs;
    async function navigate(view, url) {
      await view.getByLabel("Адрес страницы").fill(url);
      await view.getByLabel("Адрес страницы").press("Enter");
    }
    async function color(view, expected) {
      await view.waitForFunction(
        (expected) => {
          const im = document.querySelector("#frame");
          if (!im.complete || im.naturalWidth < 100) return false;
          const cv = document.createElement("canvas");
          cv.width = cv.height = 1;
          const ctx = cv.getContext("2d");
          ctx.drawImage(im, 0, 0, 1, 1, 0, 0, 1, 1);
          return (
            Array.from(ctx.getImageData(0, 0, 1, 1).data)
              .slice(0, 3)
              .join(",") === expected
          );
        },
        expected,
        { timeout: 15000 },
      );
    }
    async function viewerControl(view, payload) {
      return view.evaluate(
        async (payload) =>
          (
            await fetch("control", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            })
          ).status,
        payload,
      );
    }
    async function viewerStatus(view) {
      return view.evaluate(async () => (await fetch("status")).json());
    }
    await navigate(viewA, origin + "/blue");
    await page.waitForURL(origin + "/blue");
    await page.evaluate(() => {
      localStorage.setItem("project-marker", "first");
      document.cookie = "project_a=first";
    });
    await navigate(viewB, origin + "/green");
    await color(viewA, "10,86,122");
    await color(viewB, "32,112,64");
    await rt.execute({
      action: "input",
      showId: a.showId,
      input: { action: "scroll", x: 0.5, y: 0.2, deltaY: 500 },
    });
    await until(
      async () => (await page.evaluate(() => scrollY)) > 0,
      "Страница показа не прокручивается.",
    );
    await page.evaluate(() => scrollTo(0, 0));
    const img = viewA.locator("#frame");
    await img.click();
    await viewA.keyboard.type("from viewer");
    await until(
      async () =>
        (await page.locator("textarea").inputValue()) === "from viewer",
      "Ввод из внешнего браузера не достиг страницы агента.",
    );
    await page.evaluate(() =>
      history.pushState({}, "", location.pathname + "#agent"),
    );
    await until(
      async () =>
        (await viewA.getByLabel("Адрес страницы").inputValue()) ===
        origin + "/blue#agent",
      "Viewer не отразил адрес агента.",
    );
    assert.equal(
      await viewB.getByLabel("Адрес страницы").inputValue(),
      origin + "/green",
    );
    assert.equal((await rt.state()).access.owner, a.showId);
    const previous = await page.evaluate(() => performance.timeOrigin);
    await viewA
      .getByRole("button", { name: "Обновить страницу", exact: true })
      .click();
    await page.waitForFunction((old) => performance.timeOrigin > old, previous);
    assert.equal(await page.locator("textarea").inputValue(), "");
    if (imageID) {
      const marker = await page.evaluate(() => {
        window.demoSmokeMarker = String(Math.random());
        return window.demoSmokeMarker;
      });
      await page.locator("textarea").fill("local draft");
      const access = (await rt.state()).access;
      assert.equal(access.owner, a.showId);
      assert.ok(access.connectionId);
      await rt.execute({
        action: "handoff",
        showId: a.showId,
        connectionId: access.connectionId,
      });
      await runDocker({ tmp, core, cli, imageID, port, marker });
      agent = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
        noDefaults: true,
        timeout: 8000,
      });
      const same = agent.contexts()[0].pages()[0];
      assert.deepEqual(
        await same.evaluate(() => [
          window.demoSmokeMarker,
          document.querySelector("textarea").value,
        ]),
        [marker, "docker continued"],
      );
      console.log(
        "OK: продуктовый handoff → Docker → тот же документ и черновик → локальный агент.",
      );
    }

    // A primary workspace and a topic of that same project are distinct owners.
    const topicScope = {
      projectId: "fixture-a",
      year: "2026",
      topic: "isolated-topic",
      branch: "topic/isolated",
      contextId: "ctx-" + "a".repeat(64),
      revision: "00000000-0000-4000-8000-000000000001",
    };
    await rt.execute({ action: "open", scope: topicScope }, "Топик A");
    const topic = (await rt.state()).shows.find(
      (s) => typeof s.scope !== "string",
    );
    assert(topic);
    assert.notEqual(topic.showId, a.showId);
    const aTab = (await activeTab(a.showId)).tabId,
      bTab = (await activeTab(b.showId)).tabId,
      topicTab = (await activeTab(topic.showId)).tabId;
    for (const [owner, foreign] of [
      [a.showId, bTab],
      [a.showId, topicTab],
      [topic.showId, aTab],
    ]) {
      await assert.rejects(rt.nextFrame(owner, foreign, null));
      await assert.rejects(
        rt.execute({
          action: "input",
          showId: owner,
          tabId: foreign,
          input: { action: "text", text: "foreign input" },
        }),
      );
      for (const action of ["tab-select", "tab-close"])
        await assert.rejects(
          rt.execute({ action, showId: owner, tabId: foreign }),
        );
    }
    for (const op of ["tab-select", "tab-close"]) {
      assert.equal(await viewerControl(viewA, { op, tabId: bTab }), 400);
      assert.equal(await viewerControl(viewA, { op, tabId: topicTab }), 400);
      assert.equal(await viewerControl(viewB, { op, tabId: aTab }), 400);
    }
    const statusA = await viewerStatus(viewA),
      statusB = await viewerStatus(viewB);
    assert(!statusA.tabs.some((t) => t.tabId === bTab || t.tabId === topicTab));
    assert(!statusB.tabs.some((t) => t.tabId === aTab || t.tabId === topicTab));
    assert.equal((await activeTab(b.showId)).tabId, bTab);
    assert.equal((await activeTab(topic.showId)).tabId, topicTab);
    await rt.execute({ action: "stop", showId: topic.showId });

    // User-created tabs and agent selection refer to one shared tab catalog.
    await viewA
      .getByRole("button", { name: "Новая вкладка", exact: true })
      .click();
    await until(
      async () => (await show(a.showId)).tabs.length === 2,
      "Кнопка + не создала вкладку.",
    );
    const viewerTabId = (await activeTab(a.showId)).tabId;
    assert.notEqual(viewerTabId, aTab);
    await navigate(viewA, origin + "/green#viewer");
    await until(
      async () =>
        agent
          .contexts()[0]
          .pages()
          .some((p) => p.url() === origin + "/green#viewer"),
      "Агент не увидел вкладку пользователя.",
    );
    const original = agent
        .contexts()[0]
        .pages()
        .find((p) => p.url() === origin + "/blue#agent"),
      viewerPage = agent
        .contexts()[0]
        .pages()
        .find((p) => p.url() === origin + "/green#viewer");
    assert(original && viewerPage);
    await original.bringToFront();
    await until(
      async () => (await viewerStatus(viewA)).activeTabId === aTab,
      "Выбор вкладки агентом не отразился в viewer.",
    );
    await color(viewA, "10,86,122");
    await viewA.getByRole("tab", { name: "Demo green", exact: true }).click();
    await until(
      async () => (await show(a.showId)).activeTabId === viewerTabId,
      "Выбор вкладки пользователем не отразился в runtime.",
    );
    await color(viewA, "32,112,64");
    const hostileTitle = '<img src=x onerror="window.demoInjected=true">';
    await viewerPage.evaluate((title) => {
      document.title = title;
    }, hostileTitle);
    await viewA.getByRole("tab", { name: hostileTitle, exact: true }).waitFor();
    assert.equal(await viewA.getByRole("tablist").locator("img").count(), 0);
    assert.equal(await viewA.evaluate(() => window.demoInjected), undefined);
    await viewerPage.evaluate(() => {
      document.title = "Demo green";
    });
    await viewA
      .getByRole("button", { name: "Закрыть вкладку Demo blue", exact: true })
      .click();
    await until(
      async () => (await show(a.showId)).tabs.length === 1,
      "Крестик не закрыл неактивную вкладку.",
    );
    assert.equal((await show(a.showId)).activeTabId, viewerTabId);
    await viewerPage.locator("textarea").fill("landing draft");
    await img.click();
    await viewA.keyboard.type(" appended");
    await until(
      async () =>
        (await viewerPage.locator("textarea").inputValue()) ===
        "landing draft appended",
      "Ввод попал не в выбранную вкладку.",
    );
    await viewA
      .getByRole("button", { name: "Обновить страницу", exact: true })
      .click();
    await until(
      async () => (await viewerPage.locator("textarea").inputValue()) === "",
      "Обновлена не выбранная вкладка.",
    );

    // Exercise ordinary raw CDP root create/activate, not a host-only adapter.
    await agent.close();
    agent = undefined;
    await until(
      async () => (await rt.state()).access.phase === "waiting",
      "CDP клиент не отключился.",
    );
    const rawA = await wireClient(port, "A");
    let rawATargetId;
    try {
      const before = await rawA.send("Target.getTargets");
      assert(before.targetInfos.every((t) => t.url !== origin + "/green"));
      rawATargetId = before.targetInfos.find(
        (t) => t.url === origin + "/green#viewer",
      ).targetId;
      const { targetId } = await rawA.send("Target.createTarget", {
        url: origin + "/blue#landing",
      });
      await rawA.send("Target.activateTarget", { targetId });
      const reused = (await rawA.send("Target.getTargets")).targetInfos.filter(
        (t) => t.url === origin + "/blue#landing",
      );
      assert.deepEqual(
        reused.map((t) => t.targetId),
        [targetId],
      );
      await rawA.send("Target.activateTarget", {
        targetId: reused[0].targetId,
      });
      await until(
        async () =>
          (await viewA.getByLabel("Адрес страницы").inputValue()) ===
          origin + "/blue#landing",
        "Viewer не переключился на явно активированную CDP вкладку.",
      );
      await color(viewA, "10,86,122");
    } finally {
      await rawA.close();
    }
    await until(
      async () => (await rt.state()).access.phase === "waiting",
      "Raw CDP клиент не отключился.",
    );

    // Port handoff revokes a still-open old agent. B's root cannot enumerate,
    // attach or activate a known raw target ID from A's separate Chromium.
    agent = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
      noDefaults: true,
      timeout: 8000,
    });
    const oldPage = agent
      .contexts()[0]
      .pages()
      .find((p) => p.url() === origin + "/green#viewer");
    assert(oldPage);
    const wasDisconnected = once(agent, "disconnected");
    await rt.execute({
      action: "switch-port",
      showId: b.showId,
      fromShowId: a.showId,
    });
    await until(
      async () => !agent.isConnected(),
      "Смена владельца порта не отозвала старого агента.",
    );
    await wasDisconnected;
    assert.equal(agent.isConnected(), false);
    await assert.rejects(
      oldPage.evaluate(() => {
        document.title = "foreign mutation";
      }),
    );
    agent = undefined;
    const rawB = await wireClient(port, "B");
    try {
      const targets = await rawB.send("Target.getTargets");
      assert(targets.targetInfos.some((t) => t.url === origin + "/green"));
      assert(
        !targets.targetInfos.some(
          (t) =>
            t.targetId === rawATargetId ||
            t.url.includes("#landing") ||
            t.url.includes("#viewer"),
        ),
      );
      await assert.rejects(
        rawB.send("Target.attachToTarget", {
          targetId: rawATargetId,
          flatten: true,
        }),
        (error) => error.protocol === true,
      );
      await assert.rejects(
        rawB.send("Target.activateTarget", { targetId: rawATargetId }),
        (error) => error.protocol === true,
      );
      const closeForeign = await rawB
        .send("Target.closeTarget", { targetId: rawATargetId })
        .catch((error) => {
          if (!error.protocol) throw error;
          return { success: false };
        });
      assert.equal(closeForeign.success, false);
    } finally {
      await rawB.close();
    }
    const isolationAgent = await chromium.connectOverCDP(
      "http://127.0.0.1:" + port,
    );
    try {
      const secondProject = isolationAgent.contexts()[0].pages()[0];
      assert.equal(secondProject.url(), origin + "/green");
      assert.deepEqual(
        await secondProject.evaluate(() => [
          localStorage.getItem("project-marker"),
          document.cookie,
        ]),
        [null, ""],
      );
    } finally {
      await isolationAgent.close();
    }
    assert.equal((await rt.state()).access.owner, b.showId);
    assert((await show(a.showId)).tabs.some((t) => t.tabId === viewerTabId));
    await color(viewB, "32,112,64");
    await rt.execute({
      action: "switch-port",
      showId: a.showId,
      fromShowId: b.showId,
    });
    agent = await chromium.connectOverCDP("http://127.0.0.1:" + port, {
      noDefaults: true,
      timeout: 8000,
    });
    const landing = agent
      .contexts()[0]
      .pages()
      .find((p) => p.url() === origin + "/blue#landing");
    assert(landing);
    // Closing the active tab chooses its neighbour without ending the show.
    await landing.close();
    await until(
      async () =>
        (await show(a.showId)).tabs.length === 1 &&
        (await show(a.showId)).activeTabId === viewerTabId,
      "Закрытие активной вкладки не выбрало соседнюю.",
    );
    await color(viewA, "32,112,64");
    // Closing the final tab creates a fresh blank page and preserves show/port.
    const accessBeforeLast = (await rt.state()).access;
    await viewA
      .getByRole("button", { name: "Закрыть вкладку Demo green", exact: true })
      .click();
    await until(async () => {
      const s = await show(a.showId);
      return (
        s &&
        s.tabs.length === 1 &&
        s.tabs[0].url === null &&
        s.tabs[0].tabId !== viewerTabId &&
        s.activeTabId === s.tabs[0].tabId
      );
    }, "Закрытие последней вкладки не оставило пустую вкладку в том же показе.");
    const blank = await show(a.showId),
      afterLast = await rt.state();
    assert.equal(blank.showId, a.showId);
    assert.equal(blank.url, null);
    assert.equal(afterLast.port, port);
    assert.equal(afterLast.access.owner, a.showId);
    assert.equal(afterLast.access.connectionId, accessBeforeLast.connectionId);
    assert.equal(agent.isConnected(), true);
    await until(
      async () =>
        (await viewA.getByLabel("Адрес страницы").inputValue()) === "",
      "Адрес закрытой последней страницы остался в viewer.",
    );
    await viewA
      .getByRole("button", { name: "Новая вкладка", exact: true })
      .waitFor({ state: "visible" });
    assert.equal(
      await viewA
        .getByRole("button", { name: "Новая вкладка", exact: true })
        .isEnabled(),
      true,
    );
    // A show-wide stop, unlike a tab close, revokes viewers and releases port.
    await rt.execute({ action: "stop", showId: a.showId });
    await until(async () => {
      const probe = net.createServer();
      return new Promise((r) => {
        probe.once("error", () => r(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => r(true)));
      });
    }, "После остановки показа порт всё ещё занят.");
    await viewA.getByRole("status").filter({ hasText: "завершён" }).waitFor();
    await color(viewB, "32,112,64");
    const final = await rt.state();
    assert.equal(final.access.owner, null);
    assert.deepEqual(
      final.shows.map((s) => s.showId),
      [b.showId],
    );
    assert.equal(final.shows[0].url, origin + "/green");
    await rt.execute({ action: "stop", showId: b.showId });
    console.log(
      "OK: два isolated Chromium и внешних viewer; безопасные вкладки +/выбор/закрытие, CDP и пользователь синхронизированы; primary/topic и разные проекты изолированы; foreign tabId/targetId запрещены; handoff отзывает агента; последняя вкладка сохраняет show/порт, stop освобождает порт.",
    );
  } finally {
    try {
      try {
        await agent?.close();
      } finally {
        await external?.close();
      }
    } finally {
      try {
        await ui?.close();
      } finally {
        try {
          await rt.close();
        } finally {
          fixture.closeAllConnections();
          if (fixture.listening) await new Promise((r) => fixture.close(r));
        }
      }
    }
  }
}

// One ordinary broker client, with no host capabilities or upstream address.
async function wireClient(port, label) {
  const Wire = req("ws"),
    wire = new Wire("ws://127.0.0.1:" + port + "/devtools/browser");
  await once(wire, "open");
  let serial = 0;
  return {
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++serial;
        const finish = (error, value) => {
          clearTimeout(timer);
          wire.off("message", receive);
          wire.off("close", closed);
          error ? reject(error) : resolve(value);
        };
        const receive = (data) => {
          const result = JSON.parse(data.toString());
          if (result.id === id)
            finish(
              result.error
                ? Object.assign(Error(result.error.message), {
                    protocol: true,
                    code: result.error.code,
                  })
                : null,
              result.result,
            );
        };
        const closed = () => finish(Error("CDP disconnected"));
        const timer = setTimeout(
          () => finish(Error("CDP timed out: " + label + " " + method)),
          8000,
        );
        wire.on("message", receive);
        wire.on("close", closed);
        wire.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    async close() {
      if (wire.readyState === Wire.CLOSED) return;
      const disconnected = once(wire, "close");
      wire.close();
      await disconnected;
    },
  };
}

// Only the copied client distribution is mounted read-only; no project, user
// files, proxy variables, Docker settings or Docker socket enters the container.
async function runDocker({ tmp, core, cli, imageID, port, marker }) {
  const mount = path.join(tmp, "docker-client");
  await fs.mkdir(mount, { mode: 0o755 });
  const dist = path.dirname(core),
    sdk = path.join(mount, "playwright-core");
  await fs.mkdir(sdk, { mode: 0o755 });
  for (const item of ["index.js", "package.json", "browsers.json", "lib"])
    await fs.cp(path.join(dist, item), path.join(sdk, item), {
      recursive: true,
      filter: async (file) => {
        if ((await fs.lstat(file)).isSymbolicLink())
          throw Error("Symlink in client copy");
        return true;
      },
    });
  // Both command-line parameters are synthetic test data, not connection credentials.
  const client = `const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('./playwright-core');
 const [port,marker]=process.argv.slice(2);const finish=code=>{fs.writeSync(1,code?'failed':'ok');process.exit(code);};setTimeout(()=>finish(1),20000);
 (async()=>{const b=await chromium.connectOverCDP('http://host.docker.internal:'+port,{noDefaults:true,timeout:10000});
 assert.equal(b.contexts().length,1);assert.equal(b.contexts()[0].pages().length,1);const page=b.contexts()[0].pages()[0];
 assert.deepEqual(await page.evaluate(()=>[window.demoSmokeMarker,document.querySelector('textarea').value]),[marker,'local draft']);
 await page.locator('textarea').fill('docker continued');assert.equal(await page.evaluate(()=>window.demoSmokeMarker),marker);finish(0);})().catch(()=>finish(1));`;
  await fs.writeFile(path.join(mount, "client.cjs"), client, { mode: 0o644 });
  try {
    const { stdout } = await runFile(
      cli,
      [
        "--config",
        path.join(tmp, "docker-config"),
        "--host",
        "unix:///var/run/docker.sock",
        "run",
        "--rm",
        "--pull=never",
        "--read-only",
        "--no-healthcheck",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "256m",
        "--cpus",
        "1",
        "--user",
        "65534:65534",
        "--workdir",
        "/agent",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=24m,mode=1777",
        "--mount",
        "type=bind,source=" + mount + ",target=/agent,readonly",
        "--entrypoint",
        "/usr/bin/env",
        imageID,
        "-i",
        "HOME=/tmp",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "node",
        "/agent/client.cjs",
        String(port),
        marker,
      ],
      {
        timeout: 30000,
        maxBuffer: 8192,
        env: { HOME: process.env.HOME, PATH: "/usr/bin:/bin" },
      },
    );
    assert.equal(stdout, "ok");
  } catch {
    throw Error("Тестовый контейнер не подтвердил тот же документ.");
  }
}
