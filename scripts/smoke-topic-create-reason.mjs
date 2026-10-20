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
  "second-project/docs/second-plan.md": "# Second project plan\n",
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
    assert(
      [meta.project, path.join(root, "second-project")].includes(options.cwd),
    );
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
      output =
        (options.cwd === meta.project
          ? planPath
          : path.join(root, "second-project/docs/second-plan.md")) + "\n";
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
    readCalls: [],
    readCompletions: [],
    cacheReturns: [],
    topicCreateChecks: [],
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
  const registeredHandlers = new Map();
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, handler) => {
    registeredHandlers.set(channel, handler);
    return originalHandle(channel, async (event, ...args) => {
      let actualHandler = handler;
      report.ipcCalls.push(channel);
      let name = channel.replace(/^goga:/, "");
      if (name === "read-request") {
        const [id, method, params] = args;
        name = method.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
        args = params;
        actualHandler = registeredHandlers.get("goga:" + name);
        if (!actualHandler)
          throw Error("Missing registered read handler " + name);
      }
      if (name === "cancel-read") return actualHandler(event, ...args);
      if (["build-context", "read-build-plan"].includes(name))
        report.readCalls.push({ method: name, projectId: args[0] });
      const pending = gates.get(name);
      if (pending) {
        await pending.promise;
        if (gates.get(name) === pending) gates.delete(name);
        if (pending.error) throw Error(pending.error);
      }
      if (
        actualBuildBackend &&
        ["build-context", "read-build-plan", "list-build-files"].includes(name)
      ) {
        try {
          return await actualHandler(event, ...args);
        } finally {
          if (["build-context", "read-build-plan"].includes(name))
            report.readCompletions.push({ method: name, projectId: args[0] });
        }
      }
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
      return actualHandler(event, ...args);
    });
  };
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
    const topicExpectations = new Map();
    const shot = async (label, isLoading = false) => {
      for (const [width, height] of [
        [1320, 900],
        [920, 700],
      ]) {
        win.setContentSize(width, height);
        await settle();
        if (label === "build-missing-horizontal") {
          await ev(
            "document.querySelector('.scroll-area').scrollTop=document.querySelector('.scroll-area').scrollHeight",
          );
          await settle();
        }
        if (isLoading) await loading();
        else await ready();
        const state = await ev(
          `(()=>{const seen=s=>[...document.querySelectorAll(s)].filter(e=>e.getClientRects().length);const loaders=seen('.loading-state'),hidden=seen('.loading-content[hidden]');return {topicRadios:seen('.launch-panel .topic-mode input').length,checkedModes:seen('.launch-panel .topic-mode input:checked').length,loaders:loaders.length,hiddenLeaked:hidden.length,topTabs:seen('.tabs').length,spinner:loaders[0]?getComputedStyle(loaders[0].querySelector('.loading-spinner')).animationName:null,overflow:seen('.scroll-area,.build-form,.launch-panel,.topics-workspace').filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)};})()`,
        );
        if (state.topicRadios) assert.equal(state.checkedModes, 1);
        if (
          [
            "pipeline-preview-error",
            "catalog-timeout-error",
            "second-project-dependent-error",
          ].includes(label)
        ) {
          state.launchBlocked = await ev(
            "[...document.querySelectorAll('.launch-panel .split-launch-main')].filter(e=>e.getClientRects().length).every(e=>e.disabled)",
          );
          assert.equal(state.launchBlocked, true);
        }
        assert.equal(state.hiddenLeaked, 0);
        assert.equal(state.loaders, isLoading ? 1 : 0);
        assert.deepEqual(state.overflow, []);
        if (label === "build-missing-horizontal") {
          const geometry = await ev(
            `(()=>{const r=document.querySelector('.build-launch-reason'),b=document.querySelector('.build-launch-action .split-launch');const a=r.getBoundingClientRect(),c=b.getBoundingClientRect();return {left:a.right<=c.left-8,sameRow:Math.abs((a.top+a.bottom)/2-(c.top+c.bottom)/2)<2,visible:a.top>=0&&a.bottom<=innerHeight&&c.bottom<=innerHeight,described:[...b.querySelectorAll('button')].every(x=>x.getAttribute('aria-describedby')===r.id),overflow:document.querySelector('.build-footer').scrollWidth>document.querySelector('.build-footer').clientWidth+1}})()`,
          );
          assert(
            geometry.left &&
              geometry.sameRow &&
              geometry.visible &&
              geometry.described &&
              !geometry.overflow,
            JSON.stringify(geometry),
          );
          state.warningGeometry = geometry;
          report.checks.push({ label, width, geometry });
        }
        if (label.startsWith("both-tabs")) {
          const visibleCloses = await ev(
            `(()=>{const a=document.querySelector('.tabs').getBoundingClientRect();return [...document.querySelectorAll('.close-tab')].filter(e=>e.getClientRects().length&&/Новая сборка|Новый запуск/.test(e.getAttribute('aria-label'))).map(e=>{const r=e.getBoundingClientRect();return r.left>=a.left&&r.right<=a.right})})()`,
          );
          assert.deepEqual(visibleCloses, [true, true]);
        }
        if (label.startsWith("topic-create-")) {
          const measured = await ev(
            `(()=>{const root=[...document.querySelectorAll('.topics-workspace')].find(e=>e.getClientRects().length),button=[...root.querySelectorAll('button')].find(e=>e.textContent.trim()==='Создать топик'),reason=root.querySelector('.topic-create-reason'),heading=root.querySelector('.topics-heading'),table=root.querySelector('.topic-table-wrap'),rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {reason:reason?.textContent.trim()??null,disabled:button.disabled,describedBy:button.getAttribute('aria-describedby'),reasonId:reason?.id??null,lock:!!reason?.querySelector('svg[aria-hidden="true"][focusable="false"]'),alert:reason?.getAttribute('role')==='alert',button:rect(button),warning:reason?rect(reason):null,heading:rect(heading),table:table?.getClientRects().length?rect(table):null,firstRowBottom:table?.getClientRects().length?table.querySelector('tbody tr')?.getBoundingClientRect().bottom??table.querySelector('thead').getBoundingClientRect().bottom:null,firstRowContentBottom:table?.getClientRects().length?Math.max(...[...table.querySelectorAll('tbody tr:first-child button,tbody tr:first-child p,tbody tr:first-child small,tbody tr:first-child span,tbody tr:first-child input,tbody tr:first-child summary')].filter(e=>e.getClientRects().length&&(!e.closest('details:not([open])')||e.tagName==='SUMMARY')).map(e=>e.getBoundingClientRect().bottom)):null,dialogOpen:!!document.querySelector('dialog[open]'),overflow:root.scrollWidth>root.clientWidth+1,boardLoading:root.getAttribute('aria-busy')==='true'}})()`,
          );
          const expected = topicExpectations.get(label);
          assert(expected, "Unknown topic create expectation " + label);
          assert.equal(measured.reason, expected.reason);
          assert.equal(measured.disabled, expected.disabled);
          assert.equal(measured.boardLoading, expected.boardLoading ?? false);
          assert.equal(measured.overflow, false);
          assert(
            measured.button.left >= 0 &&
              measured.button.right <= width &&
              measured.button.top >= 0 &&
              measured.button.bottom <= height,
          );
          if (expected.reason) {
            assert.equal(measured.describedBy, measured.reasonId);
            assert.equal(measured.lock, true);
            assert.equal(measured.alert, false);
            assert(
              measured.warning.right <= measured.button.left - 8,
              JSON.stringify(measured),
            );
            assert(
              Math.abs(
                (measured.warning.top + measured.warning.bottom) / 2 -
                  (measured.button.top + measured.button.bottom) / 2,
              ) < 2,
            );
          } else assert.equal(measured.describedBy, null);
          if (measured.table) {
            // Preserve readable first-row content for the new warning states.
            // Row border/padding may continue below the viewport; an operation
            // modal intentionally obscures the background table, as before.
            if (expected.reason && !measured.dialogOpen)
              assert(
                measured.firstRowContentBottom <= height,
                "First-row content not visible: " + JSON.stringify(measured),
              );
            assert(measured.table.width > width - 330, "Table was narrowed");
          }
          report.topicCreateChecks.push({ label, width, height, ...measured });
        }
        const file = path.join(root, `${label}-${width}x${height}.png`);
        fs.writeFileSync(file, (await wc.capturePage()).toPNG());
        report.screenshots.push({ file, width, height, state });
      }
    };
    const input = async (selector, value) => {
      await ev(
        `(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.getClientRects().length);Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await settle();
    };
    const buildCounts = () => ({
      context: report.readCalls.filter((x) => x.method === "build-context")
        .length,
      plan: report.readCalls.filter((x) => x.method === "read-build-plan")
        .length,
    });
    const cacheRoundtrip = async (label, away) => {
      const before = buildCounts();
      await ev(
        `(()=>{window.cacheForm=[...document.querySelectorAll('.build-form')].find(e=>e.getClientRects().length);window.cacheSawLoader=false;window.cacheWatch=new MutationObserver(records=>{for(const record of records)for(const n of record.addedNodes)if(n.nodeType===1&&(n.matches?.('.loading-state')||n.querySelector?.('.loading-state')))window.cacheSawLoader=true});window.cacheWatch.observe(window.cacheForm,{childList:true,subtree:true});return true})()`,
      );
      if (away === "settings") {
        await ev("document.querySelector('.settings-button').click()");
        await settle();
        await ready();
        await click("← Назад");
      } else await click(away);
      await click("Новая сборка");
      const atReturn = await ev(
        "[...document.querySelectorAll('.build-form .loading-state')].filter(e=>e.getClientRects().length).length",
      );
      await new Promise((r) => setTimeout(r, 260));
      await settle();
      const state = await ev(
        `(()=>{const same=window.cacheForm===[...document.querySelectorAll('.build-form')].find(e=>e.getClientRects().length),saw=window.cacheSawLoader;window.cacheWatch.disconnect();delete window.cacheWatch;delete window.cacheForm;return {sameForm:same,sawLoader:saw}})()`,
      );
      const after = buildCounts();
      assert.deepEqual(after, before);
      assert.equal(atReturn, 0);
      assert.equal(state.sameForm, true);
      assert.equal(state.sawLoader, false);
      report.cacheReturns.push({
        label,
        away,
        before,
        after,
        loaderAtReturn: atReturn,
        ...state,
      });
      await ev("document.querySelector('.scroll-area').scrollTop=0");
      await shot("cache-" + label + "-return");
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
    await cacheRoundtrip("missing", "Проект");
    await ev(
      "document.querySelector('.scroll-area').scrollTop=document.querySelector('.scroll-area').scrollHeight",
    );
    await shot("build-missing-horizontal");
    await ev("document.querySelector('.scroll-area').scrollTop=0");
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
    const saved = await ev(
      "[...document.querySelectorAll('.build-plan-row input')].find(e=>e.getClientRects().length || e.closest('.build-form')?.getClientRects().length).value",
    );
    releaseContext = gate("build-context", "Controlled context failure");
    await click("Обновить данные");
    await loading();
    await shot("build-refresh-loading", true);
    releaseContext();
    await ready();
    await shot("build-error");
    await cacheRoundtrip("error", "Проект");
    await click("Повторить загрузку");
    await ready();
    assert.equal(
      await ev(
        "[...document.querySelectorAll('.build-plan-row input')].find(e=>e.getClientRects().length || e.closest('.build-form')?.getClientRects().length).value",
      ),
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
    await click("Проект");
    await ready();
    await shot("both-tabs-home");
    await click("Новый запуск");
    await ready();
    assert.equal(
      await ev("document.querySelector('.launch-panel textarea').value"),
      "Retained launch draft",
    );
    await click("Новая сборка");
    await ready();
    await shot("both-tabs-build");
    for (const [label, away] of [
      ["project", "Проект"],
      ["topics", "Топики"],
      ["launch", "Новый запуск"],
      ["settings", "settings"],
    ])
      await cacheRoundtrip("ready-" + label, away);
    await click("Новый запуск");
    await ready();
    await click("＋ Запустить конвейер");
    await ready();
    assert.equal(
      await ev(
        "[...document.querySelectorAll('[role=tab]')].filter(e=>e.getClientRects().length&&e.textContent.trim()==='Новый запуск').length",
      ),
      1,
    );
    await ev(
      "[...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes('Second draft fixture')).click()",
    );
    await ready();
    const releaseSecondTask = gate("read-topic-task"),
      releaseSecondPreview = gate(
        "preview",
        "Controlled early dependent failure",
      );
    await click("＋ Запустить конвейер");
    await loading();
    await shot("second-project-dependent-loading", true);
    releaseSecondPreview();
    await ready();
    await shot("second-project-dependent-error");
    // The old task transport deliberately never answers. A retry must replace it.
    gates.delete("read-topic-task");
    await click("Повторить загрузку");
    await ready();
    await shot("second-project-dependent-retry-ready");
    await input(".launch-panel textarea", "Second project launch draft");
    releaseSecondTask();
    await settle();
    assert.equal(
      await ev(
        "[...document.querySelectorAll('.launch-panel textarea')].find(e=>e.getClientRects().length).value",
      ),
      "Second project launch draft",
    );
    await shot("second-project-launch");
    await ev(
      "[...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes('Home/build acceptance')).click()",
    );
    await ready();
    await click("Новый запуск");
    await ready();
    assert.equal(
      await ev(
        "[...document.querySelectorAll('.launch-panel textarea')].find(e=>e.getClientRects().length).value",
      ),
      "Retained launch draft",
    );
    await shot("first-project-retained-launch");
    await click("Новая сборка");
    await ready();
    const alphaPlan = await ev(
      "[...document.querySelectorAll('.build-plan-row input')].find(e=>e.getClientRects().length).value",
    );
    await ev(
      "[...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes('Second draft fixture')).click()",
    );
    await ready();
    await click("Запустить сборку");
    await ready();
    await shot("second-project-build-ready");
    const betaPlan = await ev(
      "[...document.querySelectorAll('.build-plan-row input')].find(e=>e.getClientRects().length).value",
    );
    assert.notEqual(alphaPlan, betaPlan);
    const beforeSwitch = buildCounts();
    for (const [projectName, value, label] of [
      ["Home/build acceptance", alphaPlan, "alpha"],
      ["Second draft fixture", betaPlan, "beta"],
    ]) {
      await ev(
        `[...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes(${JSON.stringify(projectName)})).click()`,
      );
      await ready();
      await click("Новая сборка");
      assert.equal(
        await ev(
          "[...document.querySelectorAll('.build-form .loading-state')].filter(e=>e.getClientRects().length).length",
        ),
        0,
      );
      assert.equal(
        await ev(
          "[...document.querySelectorAll('.build-plan-row input')].find(e=>e.getClientRects().length).value",
        ),
        value,
      );
      await new Promise((r) => setTimeout(r, 260));
      assert.deepEqual(buildCounts(), beforeSwitch);
      await shot("cached-project-" + label);
    }
    report.cacheReturns.push({
      label: "two-projects",
      before: beforeSwitch,
      after: buildCounts(),
      loaderAtReturn: 0,
    });
    await click("Закрыть вкладку Новая сборка");
    await ready();
    await ev(
      "[...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes('Home/build acceptance')).click()",
    );
    await ready();
    await click("Новый запуск");
    await ready();
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
    await click("Проект");
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
    await click("Закрыть вкладку Новый запуск");
    assert.equal(
      await ev(
        "[...document.querySelectorAll('[role=tab]')].filter(e=>e.getClientRects().length&&e.textContent.trim()==='Новый запуск').length",
      ),
      0,
    );
    assert(
      await ev(
        "[...document.querySelectorAll('[role=tab]')].some(e=>e.getClientRects().length&&e.textContent.trim()==='Новая сборка')",
      ),
    );
    const releaseSilent = gate("discover");
    await ev(
      "(()=>{window.fixtureNativeTimeout=window.setTimeout;window.setTimeout=(f,ms,...args)=>window.fixtureNativeTimeout(f,ms>=30000?500:ms,...args);return true})()",
    );
    await click("＋ Запустить конвейер");
    await loading();
    await shot("silent-catalog-loading", true);
    await until(
      "document.body.innerText.includes('Превышено время ожидания чтения (300 с)')",
    );
    await ev(
      "window.setTimeout=window.fixtureNativeTimeout;delete window.fixtureNativeTimeout",
    );
    await ready();
    await shot("catalog-timeout-error");
    releaseSilent();
    await click("Повторить загрузку");
    await ready();
    await shot("catalog-timeout-retry-ready");
    await click("Закрыть вкладку Новый запуск");
    await click("Новая сборка");
    await ready();
    await click("Закрыть вкладку Новая сборка");
    await ready();
    const releasePending = gate("build-context");
    const pendingBase = buildCounts();
    const completionsBefore = report.readCompletions.length;
    await click("Запустить сборку");
    await loading();
    const waitHost = async (predicate, description) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) {
        if (Date.now() > deadline) throw Error("Timeout: " + description);
        await new Promise((r) => setTimeout(r, 30));
      }
    };
    await waitHost(
      () => buildCounts().context === pendingBase.context + 1,
      "original context dispatched",
    );
    const pendingStarted = buildCounts();
    await click("Проект");
    releasePending();
    await waitHost(
      () => report.readCompletions.length >= completionsBefore + 2,
      "context and dependent plan settled while hidden",
    );
    await settle();
    const completedHidden = buildCounts();
    await click("Новая сборка");
    assert.equal(
      await ev(
        "[...document.querySelectorAll('.build-form .loading-state')].filter(e=>e.getClientRects().length).length",
      ),
      0,
    );
    await new Promise((r) => setTimeout(r, 260));
    assert.deepEqual(buildCounts(), completedHidden);
    report.cacheReturns.push({
      label: "pending-completed-hidden",
      before: completedHidden,
      after: buildCounts(),
      pendingBase,
      pendingStarted,
      loaderAtReturn: 0,
    });
    await shot("pending-completed-hidden-return");
    await click("Закрыть вкладку Новая сборка");
    await ready();
    assert.equal(
      await ev(
        "[...document.querySelectorAll('[role=tab]')].filter(e=>e.getClientRects().length&&/Новый запуск|Новая сборка/.test(e.textContent)).length",
      ),
      0,
    );
    report.checks.push(
      "Persistent launch tab across Home/Build and two projects; no duplicate; independent close; horizontal reason; silent catalog timeout/retry/ready",
    );
    // Presentation-only create guard scenarios, after the complete 0.1.40 suite.
    const createReasonText = (parts) =>
      parts.length
        ? "Создание топика недоступно: " + parts.join("; ") + "."
        : null;
    const createShot = async (label, parts, options = {}) => {
      const key = "topic-create-" + label;
      topicExpectations.set(key, {
        reason: createReasonText(parts),
        disabled: parts.length > 0 || !!options.boardLoading,
        boardLoading: !!options.boardLoading,
      });
      await ev("document.querySelector('.scroll-area').scrollTop=0");
      await shot(key, !!options.loading);
    };
    const refreshBoard = async (dirty, active) => {
      board.dirty = dirty;
      board.active = active;
      await click("Обновить список");
      await ready();
    };
    await click("Топики");
    await ready();
    await input(".topic-search-row input[type=search]", "");
    await createShot("available", []);
    await refreshBoard(true, false);
    await createShot("dirty", ["в проекте есть незакоммиченные изменения"]);
    let releaseCreateBoard = gate("read-topic-board");
    await click("Обновить список");
    await loading();
    await createShot("refresh-loading", [], {
      loading: true,
      boardLoading: true,
    });
    board.dirty = false;
    releaseCreateBoard();
    await ready();
    await createShot("dirty-cleared", []);
    await refreshBoard(false, true);
    await createShot("active", ["в проекте работает запуск"]);
    await refreshBoard(true, true);
    await createShot("active-dirty", [
      "в проекте работает запуск",
      "в проекте есть незакоммиченные изменения",
    ]);
    await refreshBoard(true, false);
    const releaseCreateOperation = gate(
      "prepare-topic-operation",
      "Controlled operation failure",
    );
    await ev(
      "document.querySelector('input[aria-label=\"Выбрать топик fix-search в fix/search\"]').click()",
    );
    await settle();
    await click("Удалить выбранные…");
    await loading();
    await createShot(
      "dirty-operation",
      [
        "в проекте есть незакоммиченные изменения",
        "выполняется операция с топиками",
      ],
      { loading: true },
    );
    releaseCreateOperation();
    await ready();
    await click("Закрыть карточку");
    await createShot("operation-ended", [
      "в проекте есть незакоммиченные изменения",
    ]);
    await refreshBoard(false, false);
    const releaseCleanOperation = gate(
      "prepare-topic-operation",
      "Controlled operation failure",
    );
    await click("Удалить выбранные…");
    await loading();
    await createShot("operation", ["выполняется операция с топиками"], {
      loading: true,
    });
    releaseCleanOperation();
    await ready();
    await click("Закрыть карточку");
    await createShot("operation-cleared", []);
    releaseCreateBoard = gate("read-topic-board", "Controlled refresh failure");
    await click("Обновить список");
    await loading();
    releaseCreateBoard();
    await ready();
    await createShot("clean-refresh-error", []);
    await click("Проект");
    await ready();
    releaseCreateBoard = gate(
      "read-topic-board",
      "Controlled initial board failure",
    );
    await click("Топики");
    await loading();
    await createShot("initial-loading", [], {
      loading: true,
      boardLoading: true,
    });
    releaseCreateBoard();
    await ready();
    await createShot("board-error", ["не удалось загрузить список топиков"]);
    releaseCreateBoard = gate("read-topic-board");
    await click("Повторить загрузку");
    await loading();
    await createShot("error-retry-loading", [], {
      loading: true,
      boardLoading: true,
    });
    releaseCreateBoard();
    await ready();
    await createShot("error-retry-ready", []);
    await input('.topic-search-row input[aria-label="Год"]', "20");
    await ready();
    await createShot("invalid-year", ["укажите год из четырёх цифр"]);
    await input('.topic-search-row input[aria-label="Год"]', year);
    await ready();
    await refreshBoard(true, false);
    releaseCreateBoard = gate("read-topic-board");
    await ev(
      "[...document.querySelectorAll('.project-button')].find(e=>e.textContent.includes('Second draft fixture')).click()",
    );
    await settle();
    board.dirty = false;
    board.active = true;
    await click("Топики");
    await loading();
    await createShot("project-change-loading", [], {
      loading: true,
      boardLoading: true,
    });
    releaseCreateBoard();
    await ready();
    await createShot("second-project-active", ["в проекте работает запуск"]);
    await refreshBoard(false, false);
    await createShot("second-project-cleared", []);
    board.dirty = false;
    board.active = false;
    report.checks.push(
      "Create reason matches unchanged guard; all reasons combined; no stale reason while board loads; active/dirty/operation/missing board/invalid year and removal; same-row warning/button and table width in both sizes",
    );
    assert.equal(report.visibleWindows, 0);
    assert.deepEqual(blockedSpawns, []);
    assert.equal(report.buildRequests.length, 0);
    assert.equal(report.executeCalls.length, 0);
    for (const [relative, text] of Object.entries(meta.fixtures))
      assert.equal(fs.readFileSync(path.join(root, relative), "utf8"), text);
    report.checks.push(
      ...[
        "Atomic Home loading",
        "Build context → plan with missing as completed state; valid selection; error/retry keeps path",
        "File chooser cancellation during load",
        "Topics whole board/filter loading; error/retry keeps filters",
        "Topic card shared loader",
        "Pipeline catalog → task and preview; task refresh error retains draft",
        "Catalog and explicit YAML document loading; unopened data not awaited",
        "Reduced motion respected; headers/tabs/close remain available; no launches or mutations",
      ],
    );
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
  timeout: 240000,
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
