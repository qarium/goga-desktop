// Executes production main/preload/renderer from the signed ASAR in an isolated,
// hidden Electron harness. No real home, project, clipboard, or pipeline is used.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import electron from "electron";
const bundle = path.resolve(
  process.argv[2] ??
    (() => {
      throw Error("Explicit isolated release bundle path required");
    })(),
);
const archive = path.join(bundle, "Contents/Resources/app.asar");
if (!fs.existsSync(archive)) throw Error("Packaged ASAR missing");
const archiveHash = createHash("sha256")
  .update(fs.readFileSync(archive))
  .digest("hex");
if (process.env.HOME_BUILD_ASAR_SHA256 !== archiveHash)
  throw Error(
    "Explicit verified ASAR SHA256 required; bundle must be reviewed before execution",
  );
const root = fs.mkdtempSync("/private/tmp/goga-home-build-smoke-");
const home = path.join(root, "home"),
  project = path.join(root, "project");
const fixtures = {
  "home/.goga/config.yml": "# home sentinel\n",
  "project/.goga/config.yml":
    "tools:\n  autonomous/basic-build: latest\nbuild:\n  review:\n    skip: null\n",
  "project/.goga/tools/mkdocs/config.yml": "value: unchanged\n",
  "second-project/.goga/config.yml": "# isolated second project\n",
  "project/docs/custom-plan.md": "# Alternative plan\n",
  "project/.goga/tools/fixture-tool/config.yml": "value: unchanged\n",
};
for (const [relative, text] of Object.entries(fixtures)) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}
fs.mkdirSync(path.join(home, ".goga/desktop"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".goga/desktop/projects.json"),
  JSON.stringify({
    schemaVersion: 1,
    revision: "00000000-0000-4000-8000-000000000001",
    projects: [
      { id: "fixture", name: "Home/build acceptance", path: project },
      {
        id: "second",
        name: "Second draft fixture",
        path: path.join(root, "second-project"),
      },
    ],
  }),
  { mode: 0o600 },
);
async function fixture() {
  const electron = require("electron"),
    { app, session } = electron;
  const fs = require("node:fs"),
    path = require("node:path"),
    assert = require("node:assert/strict");
  const root = __dirname,
    meta = JSON.parse(fs.readFileSync(path.join(root, "meta.json"), "utf8"));
  const NativeWindow = electron.BrowserWindow,
    createdWindows = [];
  // Defense in depth: even an erroneous UI action cannot spawn Goga/Git/a pipeline.
  const childProcess = require("node:child_process");
  const blockedSpawns = [];
  for (const name of [
    "spawn",
    "spawnSync",
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "fork",
  ])
    childProcess[name] = (...args) => {
      blockedSpawns.push({ method: name, command: String(args[0]) });
      throw Error("Fixture forbids subprocesses");
    };
  // Packaged host/IPC/plan reader run unchanged for the regression scenario.
  // Only the OS process boundary is replaced by an exact read-only allowlist.
  // Config stdout below was captured from installed Goga with a real test hook.
  let actualBuildBackend = true,
    effectiveMode = "null";
  const hostCommands = [];
  childProcess.spawn = (exe, args, options) => {
    assert.equal(options.cwd, meta.project);
    assert.equal(options.env.HOME, meta.home);
    const key = args.join(" ");
    let output;
    if (exe === "git" && key === "rev-parse HEAD") output = "fixture-head\n";
    else if (exe === "git" && key === "branch --show-current")
      output = "feature/catalog\n";
    else if (
      exe === "git" &&
      key === "for-each-ref --format=%(refname:short) refs/heads refs/remotes"
    )
      output = "main\nfeature/catalog\n";
    else if (exe === "goga" && key === "build --help")
      output = capabilities.map((x) => "--" + x).join(" ");
    else if (exe === "goga" && key === "history path -f plan.md")
      output = planPath + "\n";
    else if (exe === "goga" && key === "config build.review.skip")
      output = meta.reviewSamples.results.find(
        (x) => x.mode === effectiveMode,
      ).stdout;
    else {
      blockedSpawns.push({ exe, args });
      throw Error("Non-read-only process forbidden");
    }
    hostCommands.push({ exe, args, mode: effectiveMode });
    const { EventEmitter } = require("node:events"),
      { PassThrough } = require("node:stream");
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const controlledCatalogCalls = [];
  const report = {
    ok: false,
    kind: "packaged-ASAR-production-main-preload-renderer-in-hidden-harness",
    bundle: meta.bundle,
    checks: [],
    screenshots: [],
    visibleWindows: 0,
    pipelinesLaunched: false,
    clipboardTouched: false,
    realOSTrashUsed: false,
    trashCalls: [],
    ipcCalls: [],
    asarSha256: meta.archiveHash,
    realUserDataUsed: false,
    blockedSpawns,
    hostCommands,
    realConfigProbe: meta.reviewSamples,
    controlledCatalogCalls,
    processTransport:
      "all subprocesses blocked; mocked Topics/discovery IPC; production packaged main/preload/renderer",
    prepareRequests: [],
    executeCalls: [],
  };
  // Intercept only window visibility in this test process. ASAR files are unchanged.
  const testElectron = Object.create(electron);
  Object.defineProperty(testElectron, "BrowserWindow", {
    value: class extends NativeWindow {
      constructor(options) {
        super({ ...options, show: false });
        createdWindows.push(this);
        this.on("show", () => report.visibleWindows++);
      }
      show() {}
      showInactive() {}
      focus() {}
    },
  });
  Object.defineProperty(testElectron, "app", {
    value: new Proxy(app, {
      get(target, key) {
        if (key === "isPackaged") return true;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  });
  // Read-only acceptance: reject writes, launch and all OS shell operations.
  const controlledShell = Object.create(electron.shell);
  for (const key of [
    "trashItem",
    "openExternal",
    "openPath",
    "showItemInFolder",
  ])
    Object.defineProperty(controlledShell, key, {
      value: () => {
        throw Error("Shell action forbidden");
      },
    });
  Object.defineProperty(testElectron, "shell", { value: controlledShell });
  const year = String(new Date().getFullYear());
  const record = (topic, branch, statuses, todo, remote = false) => ({
    topic,
    branch,
    statuses,
    todo,
    remote,
    current: branch === "feature/catalog",
    divergence: "up-to-date",
  });
  const a = record(
      "feature-catalog",
      "feature/catalog",
      ["todo", "tool.ready"],
      "Обновить каталог товаров и сохранить совместимость API.",
    ),
    b = record(
      "fix-search",
      "fix/search",
      ["done"],
      "Исправить поиск по названию и добавить проверку Unicode.",
    ),
    host = record(
      a.topic,
      "main",
      ["merged"],
      "Предыдущая версия задачи в основной ветке.",
    ),
    remote = record(
      "feature-export",
      "origin/feature/export",
      ["review"],
      "Экспорт отчёта в CSV и XLSX",
      true,
    );
  const board = {
    projectId: "fixture",
    year,
    revision: "fixture-revision",
    currentBranch: a.branch,
    currentTopic: a,
    baseRef: "main",
    branches: ["main", a.branch, b.branch, remote.branch],
    dirty: false,
    active: false,
    entries: [
      { ...a, hosts: [a.branch, "main"] },
      { ...b, hosts: [b.branch] },
      { ...remote, hosts: [remote.branch] },
    ],
    records: [a, host, b, remote],
    remoteEntries: [{ ...remote, hosts: [remote.branch] }],
    remoteRecords: [remote],
  };
  const oldRun = {
    id: "historic",
    projectId: "fixture",
    pipeline: "fixture:verify",
    topic: b.topic,
    branch: b.branch,
    status: "exited",
    startedAt: year + "-10-19T00:00:00Z",
    workflow: null,
    profile: null,
    taskSnapshot: {
      text: "Снимок задачи на момент запуска.\nТекущая задача уже другая.",
      year,
      topic: b.topic,
      branch: b.branch,
    },
  };
  let taskVersion = "fixture-task";
  let cardReadGate = null,
    releaseCardRead = () => {},
    cardReadFailure = "";
  const planPath = ".goga/history/" + year + "/feature-catalog/plan.md";
  let fixtureRuns = [],
    requestHistory = [],
    oldCLI = false;
  let chooserMode = "normal";
  const longSegment = "очень-длинное-название-папки-".repeat(4);
  const longLocation =
    ".goga/history/2026/" + Array(3).fill(longSegment).join("/") + "/plans";
  report.buildRequests = [];
  report.repeatRequests = [];
  report.stops = [];
  const capabilities = [
    "workflow",
    "profile",
    "session-timeout",
    "idle-timeout",
    "wait",
    "max-iterations",
    "review-patience",
    "base-ref",
    "env",
    "add-host",
    "proxy",
    "clean",
    "update",
    "skip-review",
    "no-skip-review",
    "skip-manifest-check",
  ];
  const publish = () =>
    createdWindows[0].webContents.send(
      "goga:runs",
      structuredClone(fixtureRuns),
    );
  const tickets = new Map();
  const gates = new Map();
  function gate(name, error = "") {
    let release;
    const promise = new Promise((r) => (release = r));
    const value = { promise, error };
    gates.set(name, value);
    return () => {
      release();
    };
  }
  const releaseInitialSettings = gate("read-project-settings");
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, handler) =>
    originalHandle(channel, async (event, ...args) => {
      report.ipcCalls.push(channel);
      const name = channel.replace(/^goga:/, "");
      const pending = gates.get(name);
      if (pending) {
        await pending.promise;
        if (gates.get(name) === pending) gates.delete(name);
        if (pending.error) throw Error(pending.error);
      }
      if (
        actualBuildBackend &&
        ["build-context", "read-build-plan", "list-build-files"].includes(name)
      )
        return handler(event, ...args);
      if (name === "build-context")
        return {
          revision: "fixture-build-context",
          branch: a.branch,
          capabilities: oldCLI
            ? capabilities.filter((x) => !["workflow", "profile"].includes(x))
            : capabilities,
          defaults: { skipReview: false, profile: oldCLI ? "fast" : "" },
          branches: board.branches,
          workflows: ["quality"],
          profiles: [{ name: "fast", source: "project" }],
          historyPlan: { path: planPath },
        };
      if (name === "read-build-plan") {
        assert(["fixture", "second"].includes(args[0]));
        if (args[1].includes("..") || args[1] === "missing.md")
          throw Error("[build-plan:outside]");
        return {
          path: args[1],
          text: "# План разработки\n\n- [ ] Проверить реальные компоненты\n- [ ] Сохранить совместимость",
          version: "fixture-plan-version",
        };
      }
      if (name === "list-build-files") {
        assert(["fixture", "second"].includes(args[0]));
        if (chooserMode === "loading") return new Promise(() => {});
        if (chooserMode === "error") throw Error("[build-plan:denied]");
        if (chooserMode === "empty") return { directory: args[1], entries: [] };
        if (chooserMode === "history")
          return {
            directory: args[1],
            entries:
              args[1] === ""
                ? [{ name: ".goga", path: ".goga", directory: true }]
                : args[1] === ".goga"
                  ? [
                      {
                        name: "history",
                        path: ".goga/history",
                        directory: true,
                      },
                    ]
                  : [
                      {
                        name: "2026",
                        path: ".goga/history/2026",
                        directory: true,
                      },
                    ],
          };
        if (chooserMode === "long")
          return {
            directory: args[1],
            entries: args[1]
              ? Array.from({ length: 100 }, (_, i) => ({
                  name: longSegment + i + ".md",
                  path: args[1] + "/plan-" + i + ".md",
                  directory: false,
                }))
              : [{ name: longSegment, path: longLocation, directory: true }],
          };

        assert(["", "docs"].includes(args[1]));
        return {
          directory: args[1],
          entries: args[1]
            ? [
                {
                  name: "custom-plan.md",
                  path: "docs/custom-plan.md",
                  directory: false,
                },
              ]
            : [
                { name: "docs", path: "docs", directory: true },
                { name: "README.md", path: "README.md", directory: false },
              ],
        };
      }
      if (name === "launch-build") {
        const request = args[0];
        report.buildRequests.push(structuredClone(request));
        requestHistory.push(request);
        const run = {
          id: "build-" + report.buildRequests.length,
          update: request.options.update === true,
          kind: "build",
          projectId: "fixture",
          pipeline: "Сборка",
          topic: "",
          branch: a.branch,
          status: "running",
          workflow: request.options.workflow || null,
          profile: null,
          startedAt: new Date().toISOString(),
          output: {
            text: "Начата проверочная сборка\nШаг 1: чтение плана\n",
            truncated: false,
          },
          build: {
            planPath: request.planPath,
            planVersion: request.planVersion,
            clean: !!request.options.clean,
            update: !!request.options.update,
            skipManifestCheck: !!request.options.skipManifestCheck,
          },
        };
        fixtureRuns.push(run);
        publish();
        return structuredClone(run);
      }
      if (name === "stop-run") {
        report.stops.push(args[0]);
        const run = fixtureRuns.find((r) => r.id === args[0]);
        run.status = "stopped";
        run.endedAt = new Date().toISOString();
        run.output.text += "Сборка остановлена\n";
        publish();
        return;
      }
      if (name === "repeat-build") {
        report.repeatRequests.push(args);
        const old = fixtureRuns.find((r) => r.id === args[0]);
        assert(!old.build.clean || args[1] === true);
        const run = {
          ...structuredClone(old),
          id: "repeat-" + report.repeatRequests.length,
          status: "running",
          endedAt: undefined,
          output: { text: "Повтор исходного плана\n", truncated: false },
        };
        fixtureRuns.push(run);
        publish();
        return structuredClone(run);
      }
      if (name === "read-project-settings")
        return {
          version: "settings-v",
          value: { executable: "goga", profile: "", env: [] },
          profiles: [],
        };
      if (
        name === "list-project-tools" ||
        name === "list-project-workflows" ||
        name === "list-project-pipelines" ||
        name === "list-project-profiles"
      )
        return [];
      if (name === "read-project-document")
        return {
          text: "# Fixture project configuration\nbuild: {}\n",
          version: "doc-v",
          exists: true,
          relativePath: ".goga/config.yml",
        };
      if (name === "read-topic-board")
        return { ...board, projectId: args[0], year: args[1] };
      if (name === "read-topic-details") {
        assert.deepEqual(
          Object.keys(args[2]).sort(),
          ["branch", "remote", "topic"],
          "Card read carries identity only",
        );
        const detail = {
          projectId: "fixture",
          year: args[1],
          target: args[2],
          text:
            "Полная задача " +
            args[2].topic +
            "\n\nСохранить существующее поведение. Проверить Unicode 🐈 и несколько строк.",
          exists: true,
          version: taskVersion,
          editable: args[2].branch === a.branch,
        };
        if (cardReadFailure) return Promise.reject(new Error(cardReadFailure));
        return cardReadGate ? cardReadGate.then(() => detail) : detail;
      }
      if (name === "prepare-topic-operation") {
        if (args[0].target)
          assert.deepEqual(
            Object.keys(args[0].target).sort(),
            ["branch", "remote", "topic"],
            "Card operation carries identity only",
          );
        const request = args[0];
        report.prepareRequests.push(request);
        const token = "fixture-token-" + report.prepareRequests.length;
        tickets.set(token, request);
        return {
          token,
          projectId: "fixture",
          year,
          action: request.action,
          title:
            request.action === "delete"
              ? "Удаление топиков"
              : "Подтвердите действие",
          expiresAt: Date.now() + 300000,
          details:
            request.action === "delete"
              ? [
                  "fix-search: локальная ветка fix/search; удалённая ветка origin/fix/search.",
                  "Каталог .goga/history/" +
                    year +
                    "/fix-search сохраняется в других ветках.",
                  "Удаление без корзины.",
                ]
              : [
                  "Создать " + request.branch + " от " + request.baseRef,
                  "Публикация: " +
                    request.publish +
                    "; переключение: " +
                    request.switch,
                  "Все изменения в этой проверке имитируются; реальные ветки не меняются.",
                ],
        };
      }
      if (name === "execute-topic-operation") {
        assert(tickets.has(args[0]));
        tickets.delete(args[0]);
        report.executeCalls.push(args[0]);
        return {
          projectId: "fixture",
          status: "partial",
          message:
            "Тестовый частичный результат: топик опубликован, переключение не выполнено. Повторно создание не запускайте.",
        };
      }
      if (name === "runs") return fixtureRuns;
      if (name === "discover")
        return {
          pipelines: [
            {
              id: "fixture:verify",
              name: "Verify",
              description: "Изолированный каталог для проверки UI",
              project: true,
            },
          ],
          topics: [a, b],
          branches: board.branches,
          currentBranch: a.branch,
          baseRef: "main",
          workflows: [],
          profiles: [],
        };
      if (name === "preview")
        return {
          token: "fixture-preview",
          stages: [{ id: "checks", title: "Проверки" }],
          workflow: null,
          profile: null,
        };
      if (name === "read-topic-task")
        return {
          text: "Черновик формы запуска",
          exists: true,
          version: "fixture-task",
          path: ".goga/history/" + year + "/" + args[0].topic + "/todo.md",
        };
      if (name === "checkout-branch") return a.branch;
      if (
        /save-|delete-|launch|stop-run|close-run|choose-project|checkout/.test(
          channel,
        )
      )
        throw Error("Read-only fixture forbids action: " + channel);
      return handler(event, ...args);
    });
  electron.dialog.showMessageBox = async () => {
    throw Error("Native dialog forbidden");
  };
  const Module = require("node:module"),
    originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "electron"
      ? testElectron
      : originalLoad.call(this, request, parent, isMain);
  };
  app.setPath("home", meta.home);
  app.setPath("userData", path.join(root, "data"));
  app.setPath("sessionData", path.join(root, "session"));
  app.setPath("crashDumps", path.join(root, "crashes"));
  app.setAppLogsPath(path.join(root, "logs"));
  electron.dialog.showErrorBox = (title, message) => {
    console.error(title + ": " + message);
    app.exit(2);
  };
  const watchdog = setTimeout(() => {
    console.error("Fixture timeout");
    app.exit(2);
  }, 120000);
  watchdog.unref();
  app.whenReady().then(() => {
    app.dock?.hide();
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*"] },
      (_, done) => done({ cancel: true }),
    );
  });
  require(path.join(meta.archive, "dist-electron/index.cjs"));
  try {
    await app.whenReady();
    let win;
    for (let i = 0; i < 200; i++) {
      win = createdWindows[0];
      if (win && !win.webContents.isLoading()) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    report.createdWindows = createdWindows.length;
    assert(win, "Production window was not created");
    const wc = win.webContents,
      ev = async (s) => {
        try {
          return await wc.executeJavaScript(s);
        } catch (error) {
          throw new Error(String(error) + "\nRenderer expression: " + s);
        }
      };
    const until = async (s) => {
      for (let i = 0; i < 750; i++) {
        if (await ev(s)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("Timeout: " + s);
    };
    const visible = (s) =>
      `[...document.querySelectorAll(${JSON.stringify(s)})].filter(e=>e.getClientRects().length)`;
    const ready = () => until(visible(".loading-state") + ".length===0");
    const loading = () => until(visible(".loading-state") + ".length===1");
    const settle = () =>
      ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const click = async (text) => {
      await ev(
        `(()=>{const b=[...(document.querySelector('dialog[open]')||document).querySelectorAll('button')].find(e=>e.getClientRects().length&&(e.textContent.trim()===${JSON.stringify(text)}||e.getAttribute('aria-label')===${JSON.stringify(text)}));if(!b)throw Error('Missing visible button '+${JSON.stringify(text)});b.click()})()`,
      );
      await settle();
    };
    const shot = async (label, isLoading = false) => {
      for (const [width, height] of [
        [1320, 900],
        [920, 700],
      ]) {
        win.setContentSize(width, height);
        await settle();
        if (isLoading) await loading();
        else await ready();
        const state = await ev(
          `(()=>{const seen=s=>[...document.querySelectorAll(s)].filter(e=>e.getClientRects().length);const loaders=seen('.loading-state'),hidden=seen('.loading-content[hidden]');return {loaders:loaders.length,hiddenLeaked:hidden.length,topTabs:seen('.tabs').length,spinner:loaders[0]?getComputedStyle(loaders[0].querySelector('.loading-spinner')).animationName:null,overflow:seen('.scroll-area,.build-form,.launch-panel,.topics-workspace').filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)};})()`,
        );
        assert.equal(state.hiddenLeaked, 0);
        assert.equal(state.loaders, isLoading ? 1 : 0);
        assert.deepEqual(state.overflow, []);
        const file = path.join(root, `${label}-${width}x${height}.png`);
        fs.writeFileSync(file, (await wc.capturePage()).toPNG());
        report.screenshots.push({ file, width, height, state });
      }
    };
    const input = async (selector, value) => {
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await settle();
    };
    const noForm = async (selector) =>
      assert.equal(await ev(visible(selector) + ".length"), 0);
    await until("!!document.querySelector('.app-version')");
    report.version = await ev(
      "document.querySelector('.app-version').textContent",
    );
    assert(report.version.includes(meta.expectedVersion));
    await loading();
    await shot("home-loading", true);
    releaseInitialSettings();
    await ready();
    await shot("home-ready");
    let releaseContext = gate("build-context"),
      releasePlan = gate("read-build-plan");
    await click("Запустить сборку");
    await loading();
    await noForm(".build-form input");
    await shot("build-context-loading", true);
    releaseContext();
    await until(
      "document.querySelector('.build-form').textContent.includes('Проверяем план')",
    );
    await loading();
    await noForm(".build-form input");
    await shot("build-plan-loading", true);
    releasePlan();
    await ready();
    await until(
      "document.body.innerText.includes('План не найден. Выберите существующий файл плана.')",
    );
    await shot("build-missing-ready");
    let releaseFiles = gate("list-build-files");
    await click("Выбрать файл…");
    await loading();
    await noForm("dialog .build-file-toolbar");
    await shot("chooser-loading", true);
    await click("Отмена");
    releaseFiles();
    await ready();
    assert.equal(await ev("document.querySelectorAll('dialog').length"), 0);
    await click("Выбрать файл…");
    await ready();
    await click("Открыть папку docs");
    await ready();
    await click("Выбрать custom-plan.md");
    await ready();
    await shot("build-valid-ready");
    const saved = await ev("document.querySelector('#build-plan').value");
    releaseContext = gate("build-context", "Controlled context failure");
    await click("Обновить данные");
    await loading();
    await shot("build-refresh-loading", true);
    releaseContext();
    await ready();
    await shot("build-error");
    await click("Повторить загрузку");
    await ready();
    assert.equal(
      await ev("document.querySelector('#build-plan').value"),
      saved,
    );
    await shot("build-retry-ready");
    let releaseBoard = gate("read-topic-board");
    await click("Топики");
    await loading();
    await noForm(".topic-search-row,.topic-table,.topic-warning");
    await shot("topics-loading", true);
    releaseBoard();
    await ready();
    await shot("topics-ready");
    await input(".topic-search-row input[type=search]", "catalog");
    releaseBoard = gate("read-topic-board", "Controlled board failure");
    await click("Обновить список");
    await loading();
    releaseBoard();
    await ready();
    await shot("topics-error");
    await click("Повторить загрузку");
    await ready();
    assert.equal(
      await ev(
        "document.querySelector('.topic-search-row input[type=search]').value",
      ),
      "catalog",
    );
    await shot("topics-retry-ready");
    let releaseDetails = gate("read-topic-details");
    await click("Открыть топик feature-catalog");
    await loading();
    await shot("card-loading", true);
    releaseDetails();
    await ready();
    await shot("card-ready");
    await click("Закрыть карточку");
    let releaseDiscovery = gate("discover"),
      releasePreview = gate("preview"),
      releaseTask = gate("read-topic-task");
    await click("＋ Запустить конвейер");
    await loading();
    await noForm(".launch-panel fieldset");
    await shot("pipeline-discovery-loading", true);
    releaseDiscovery();
    await until("document.querySelector('.launch-panel select')!==null");
    await loading();
    await shot("pipeline-dependent-loading", true);
    releaseTask();
    await loading();
    await noForm(".launch-panel textarea");
    releasePreview();
    await ready();
    await shot("pipeline-ready");
    await input(".launch-panel textarea", "Retained launch draft");
    releaseTask = gate("read-topic-task", "Controlled task failure");
    await click("Перечитать задачу");
    await click("Перечитать и сбросить");
    await loading();
    await shot("pipeline-task-loading", true);
    releaseTask();
    await ready();
    await shot("pipeline-task-error");
    assert.equal(
      await ev("document.querySelector('.launch-panel textarea').value"),
      "Retained launch draft",
    );
    await click("Перечитать задачу");
    await click("Перечитать и сбросить");
    await ready();
    await shot("pipeline-task-retry-ready");
    await input(".launch-panel textarea", "Retained launch draft");
    // A dependent preview failure is recoverable without resetting the task draft.
    releasePreview = gate("preview", "Controlled preview failure");
    await ev(
      "document.querySelector('.launch-panel .stage-card input').click()",
    );
    await loading();
    await shot("pipeline-preview-loading", true);
    releasePreview();
    await ready();
    await shot("pipeline-preview-error");
    await click("Повторить загрузку");
    await ready();
    assert.equal(
      await ev("document.querySelector('.launch-panel textarea').value"),
      "Retained launch draft",
    );
    await shot("pipeline-retry-ready");
    await click("Главная");
    await ready();
    let releaseCatalog = gate("list-project-pipelines");
    await click("Конвейеры");
    await loading();
    await shot("catalog-loading", true);
    releaseCatalog();
    await ready();
    await shot("catalog-empty-ready");
    await click("Конфигурация");
    let releaseDocument = gate("read-project-document");
    await click("Открыть редактор");
    await loading();
    await shot("document-loading", true);
    releaseDocument();
    await ready();
    await shot("document-ready");
    // Verify reduced motion in the actual packaged renderer without changing OS settings.
    releaseCatalog = gate("list-project-tools");
    await click("Инструменты");
    await loading();
    wc.debugger.attach("1.3");
    await wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await settle();
    assert.equal(
      await ev(
        "getComputedStyle(document.querySelector('.loading-spinner')).animationName",
      ),
      "none",
    );
    wc.debugger.detach();
    releaseCatalog();
    await ready();
    assert.equal(report.visibleWindows, 0);
    assert.deepEqual(blockedSpawns, []);
    assert.equal(report.buildRequests.length, 0);
    assert.equal(report.executeCalls.length, 0);
    for (const [relative, text] of Object.entries(meta.fixtures))
      assert.equal(fs.readFileSync(path.join(root, relative), "utf8"), text);
    report.checks = [
      "Atomic Home loading",
      "Build context → plan with missing as completed state; valid selection; error/retry keeps path",
      "File chooser cancellation during load",
      "Topics whole board/filter loading; error/retry keeps filters",
      "Topic card shared loader",
      "Pipeline catalog → task and preview; task refresh error retains draft",
      "Catalog and explicit YAML document loading; unopened data not awaited",
      "Reduced motion respected; headers/tabs/close remain available; no launches or mutations",
    ];
    report.limitations = [
      "Read-only production host/IPC for Build file scenarios with controlled command transport; other IPC uses deterministic fixtures. No real Goga/Docker execution, user projects or running app touched.",
    ];
    report.status = "pass";
    report.ok = true;
  } catch (e) {
    report.error = String(e);
    report.stack = e.stack;
    try {
      const win = createdWindows[0];
      if (win)
        fs.writeFileSync(
          path.join(root, "failure.png"),
          (await win.webContents.capturePage()).toPNG(),
        );
    } catch {}
  }
  fs.writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}
fs.writeFileSync(
  path.join(root, "meta.json"),
  JSON.stringify({
    root,
    home,
    project,
    bundle,
    archive,
    fixtures,
    reviewSamples: JSON.parse(
      fs.readFileSync("/private/tmp/build-effective-cli.json", "utf8"),
    ),
    archiveHash,
    fixtureExecutable: path.join(root, "never-executed-fixture-goga"),
    expectedVersion: JSON.parse(fs.readFileSync("package.json", "utf8"))
      .version,
  }),
);
fs.writeFileSync(
  path.join(root, "main.cjs"),
  `(${fixture.toString()})().catch(e=>{console.error(e);require("electron").app.exit(2)});`,
);
const env = {
  ...process.env,
  HOME: home,
  GOGA_DESKTOP_DATA_DIR: path.join(root, "data"),
  TMPDIR: root,
};
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, [path.join(root, "main.cjs")], {
  env,
  encoding: "utf8",
  timeout: 130000,
});
fs.writeFileSync(path.join(root, "stdout.log"), result.stdout ?? "");
fs.writeFileSync(path.join(root, "stderr.log"), result.stderr ?? "");
console.log("result:", path.join(root, "result.json"));
if (result.status !== 0) console.error((result.stderr ?? "").slice(-3000));
console.log("fixture:", root);
console.log(
  "harness-process:",
  JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
  }),
);
if (
  createHash("sha256").update(fs.readFileSync(archive)).digest("hex") !==
  archiveHash
)
  throw Error("ASAR changed during smoke");
const reportFile = path.join(root, "result.json");
const passed =
  fs.existsSync(reportFile) &&
  JSON.parse(fs.readFileSync(reportFile, "utf8")).ok === true;
process.exitCode = result.status === 0 && passed ? 0 : 1;
