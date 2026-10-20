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
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, handler) =>
    originalHandle(channel, (event, ...args) => {
      report.ipcCalls.push(channel);
      const name = channel.replace(/^goga:/, "");
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
    const wc = win.webContents;
    const ev = (s) => wc.executeJavaScript(s);
    const until = async (s) => {
      for (let i = 0; i < 750; i++) {
        if (await ev(s)) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error("DOM timeout: " + s);
    };
    await until(
      "!!window.goga && !!document.querySelector('.project-home-panel')",
    );
    assert.equal(win.isVisible(), false);
    assert(
      wc.getURL().startsWith("file://" + meta.archive.replaceAll(" ", "%20")),
    );
    report.version = await ev(
      "document.querySelector('.app-version').textContent",
    );
    assert(report.version.includes(meta.expectedVersion));
    const prefs = wc.getLastWebPreferences();
    report.security = {
      sandbox: prefs.sandbox,
      contextIsolation: prefs.contextIsolation,
      nodeIntegration: prefs.nodeIntegration,
      webSecurity: prefs.webSecurity,
    };
    assert.deepEqual(report.security, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
    assert.equal(await ev("typeof require"), "undefined");
    await ev(
      "window.__cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.__cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI,source:e.sourceFile,line:e.lineNumber,sample:e.sample,phase:window.__testPhase}))",
    );
    const settle = () =>
      ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const clickText = async (text) => {
      await ev(
        `(()=>{const e=[...(document.querySelector('dialog[open]')||document).querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Button absent: '+${JSON.stringify(text)});e.click()})()`,
      );
      await settle();
    };
    const clickLabel = async (label) => {
      await ev(
        `document.querySelector('[aria-label='+${JSON.stringify(JSON.stringify(label))}+']').click()`,
      );
      await settle();
    };
    const untouched = () => {
      for (const [relative, original] of Object.entries(meta.fixtures))
        assert.equal(
          fs.readFileSync(path.join(root, relative), "utf8"),
          original,
        );
    };
    const shot = async (label, width, height) => {
      win.setContentSize(width, height);
      await settle();
      await ev("document.querySelector('.scroll-area').scrollTop=0");
      await settle();
      await new Promise((r) => setTimeout(r, 80));
      const layout = await ev(`(()=>{
        const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
        const tabs=[...document.querySelectorAll('.section-tabs button')].filter(e=>e.getClientRects().length).map(e=>({...rect(e),text:e.textContent,unclipped:e.scrollWidth<=e.clientWidth+1}));
        const dialog=document.querySelector('dialog[open]');
        const controls=document.querySelector('.tool-controls');
        return {tabs,dialog:dialog?rect(dialog):null,gap:controls?controls.nextElementSibling.getBoundingClientRect().top-controls.getBoundingClientRect().bottom:null,
          overflow:[...document.querySelectorAll('.app-shell,.scroll-area,.project-settings-panel,.master-detail,.editor-pane,.build-form,.build-plan-row,.build-grid,.project-bar')].filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
      })()`);
      layout.actionReasons = await ev(`(()=>{
        return [...document.querySelectorAll('.topic-action-reason')].map(e=>{
          const style=getComputedStyle(e), icon=e.querySelector('svg'), button=e.parentElement.querySelector('button'), r=e.getBoundingClientRect(), b=button.getBoundingClientRect();
          return {text:e.textContent,border:parseFloat(style.borderTopWidth),background:style.backgroundColor,padding:parseFloat(style.paddingLeft),color:style.color,iconHidden:icon?.getAttribute('aria-hidden')==='true',decorative:icon?.getAttribute('focusable')==='false',iconWidth:icon?.getBoundingClientRect().width,associated:button.getAttribute('aria-describedby')===e.id,disabled:button.disabled,unclipped:e.scrollWidth<=e.clientWidth+1,gap:r.top-b.bottom};
        });
      })()`);
      assert(
        layout.actionReasons.every(
          (r) =>
            r.border >= 1 &&
            r.padding >= 10 &&
            !["transparent", "rgba(0, 0, 0, 0)"].includes(r.background) &&
            r.iconHidden &&
            r.decorative &&
            r.iconWidth === 16 &&
            r.associated &&
            r.disabled &&
            r.unclipped &&
            r.gap >= 8,
        ),
        label + " compact reason styling and association",
      );
      assert.deepEqual(layout.overflow, [], label + " horizontal overflow");
      assert(
        layout.tabs.every(
          (t) => t.unclipped && t.left >= 0 && t.right <= width,
        ),
        label + " tabs visible",
      );
      if (layout.dialog)
        assert(
          layout.dialog.left >= 0 &&
            layout.dialog.right <= width &&
            layout.dialog.top >= 0 &&
            layout.dialog.bottom <= height,
          label + " dialog bounds",
        );

      if (
        label.startsWith("draft-tab-") &&
        label !== "draft-tab-explicitly-closed"
      ) {
        layout.draftTab = await ev(
          `(()=>{const t=document.querySelector('.build-draft-tab'),c=t.parentElement.querySelector('.close-tab'),r=t.getBoundingClientRect(),b=c.getBoundingClientRect(),v=t.closest('.tabs').getBoundingClientRect();return {left:r.left,right:b.right,viewportLeft:v.left,viewportRight:v.right,selected:t.getAttribute('aria-selected'),fits:r.left>=v.left&&b.right<=v.right,unclipped:t.scrollWidth<=t.clientWidth+1};})()`,
        );
        assert(
          layout.draftTab.fits && layout.draftTab.unclipped,
          "Draft tab and close button visibly reachable at " +
            width +
            ": " +
            JSON.stringify(layout.draftTab),
        );
      }
      if (label.startsWith("build-launch-")) {
        await ev(
          "document.querySelector('.build-footer').scrollIntoView({block:'end'})",
        );
        await settle();
        const measure = await ev(`(()=>{
          const f=document.querySelector('.build-footer'), reason=f.querySelector('.build-launch-reason'), main=f.querySelector('.split-launch-main'), arrow=f.querySelector('.split-launch-arrow'), area=document.querySelector('.scroll-area').getBoundingClientRect();
          const b=main.getBoundingClientRect(),r=reason?.getBoundingClientRect();
          return {text:reason?.textContent, mainDisabled:main.disabled, associated:!!reason&&[main,arrow].every(e=>e.getAttribute('aria-describedby')===reason.id), undescribed:[main,arrow].every(e=>!e.hasAttribute('aria-describedby')), gap:r?r.top-b.bottom:null, visible:r?r.top>=area.top&&r.bottom<=Math.min(area.bottom,innerHeight)&&r.left>=0&&r.right<=innerWidth:false, buttonVisible:b.top>=area.top&&b.bottom<=Math.min(area.bottom,innerHeight)};
        })()`);
        report.launchReasonMeasurements ??= [];
        report.launchReasonMeasurements.push({
          label,
          width,
          height,
          ...measure,
        });
        assert(measure.buttonVisible, "Launch button in viewport");
        if (label === "build-launch-missing") {
          assert.equal(
            measure.text,
            "План не найден. Выберите существующий файл плана.",
          );
          assert(measure.associated && measure.mainDisabled && measure.visible);
          assert(measure.gap >= 8 && measure.gap <= 12);
        } else {
          assert.equal(measure.text, undefined);
          assert(measure.undescribed && !measure.mainDisabled);
        }
      }
      if (label === "build-options") {
        await ev(
          "document.querySelector('.build-footer').scrollIntoView({block:'end'})",
        );
        await settle();
      }
      if (label.endsWith("-actions")) {
        await ev(
          "document.querySelector('dialog').scrollTop=document.querySelector('dialog').scrollHeight",
        );
        await settle();
      }
      if (label === "launch-help") {
        await ev(
          "document.querySelector('#startup-timeout-help').scrollIntoView({block:'start'})",
        );
        await settle();
      }
      if (label === "topics-partial")
        assert(
          await ev(
            "(()=>{const n=document.querySelector('dialog [role=status]'),d=document.querySelector('dialog');const r=n.getBoundingClientRect(),b=d.getBoundingClientRect();return r.top>=b.top&&r.bottom<=b.bottom;})()",
          ),
          "Partial outcome is visibly in the dialog viewport",
        );
      if (label.startsWith("topics-card")) {
        const gaps = await ev(`(()=>{
          return [...document.querySelectorAll('dialog section.topic-card-section')].flatMap(section=>{
            const blocks=[...section.children].filter(e=>e.getClientRects().length&&!e.classList.contains('sr-only'));
            return blocks.slice(1).map((e,i)=>({before:blocks[i].tagName,after:e.tagName,gap:e.getBoundingClientRect().top-blocks[i].getBoundingClientRect().bottom}));
          });
        })()`);
        layout.cardGaps = gaps;
        assert(
          gaps.length > 0 && gaps.every((g) => g.gap >= 12),
          label + " vertical card gaps: " + JSON.stringify(gaps),
        );
      }
      if (label === "build-chooser-long-end") {
        await ev(
          "(()=>{const d=document.querySelector('dialog[open]'),l=d.querySelector('.build-file-list');l.scrollTop=l.scrollHeight;d.scrollTop=d.scrollHeight;})()",
        );
        await settle();
        assert(
          await ev(
            "(()=>{const d=document.querySelector('dialog[open]'),b=d.querySelector('.form-actions button'),r=b.getBoundingClientRect(),v=d.getBoundingClientRect();return r.top>=v.top && r.bottom<=v.bottom;})()",
          ),
          "Cancel reachable after scrolling the long list",
        );
      }
      if (label.startsWith("build-chooser")) {
        layout.chooser = await ev(`(()=>{
          const d=document.querySelector('dialog[open]'), t=d.querySelector('.build-file-toolbar'), p=d.querySelector('.build-file-location');
          const hint=t.previousElementSibling, content=p.nextElementSibling;
          const box=e=>e.getBoundingClientRect();
          const gap=(a,b)=>box(b).top-box(a).bottom;
          const rows=[...d.querySelectorAll('.build-file-list>button')];
          return {gaps:[gap(hint,t),gap(t,p),gap(p,content)], toolbarWrap:getComputedStyle(t).flexWrap,
            pathFits:p.scrollWidth<=p.clientWidth+1,dialogFits:d.scrollWidth<=d.clientWidth+1,
            namesFit:rows.every(r=>r.scrollWidth<=r.clientWidth+1),
            listScrollable:content.scrollHeight>content.clientHeight+1,
            rowCount:rows.length,pathHeight:box(p).height};
        })()`);
        report.chooserMeasurements ??= [];
        report.chooserMeasurements.push({
          label,
          width,
          height,
          ...layout.chooser,
        });
        assert(
          layout.chooser.gaps.every((g) => g >= 15.5 && g <= 24),
          label + " vertical gaps " + JSON.stringify(layout.chooser.gaps),
        );
        assert(
          layout.chooser.pathFits &&
            layout.chooser.dialogFits &&
            layout.chooser.namesFit,
          label + " wrapping",
        );
        assert.equal(layout.chooser.toolbarWrap, "wrap");
        if (label === "build-chooser-long") {
          assert(layout.chooser.listScrollable);
          assert.equal(layout.chooser.rowCount, 100);
          assert(layout.chooser.pathHeight > 25);
        }
      }
      if (label.startsWith("build-sections")) {
        const target = label.includes("additional")
          ? 3
          : label.includes("execution")
            ? 0
            : label.includes("review")
              ? 1
              : 2;
        await ev(
          `(()=>{const g=document.querySelectorAll('.build-group')[${target}];const n=${JSON.stringify(label)}.includes('hosts')?[...g.querySelectorAll('h3')][1]:${JSON.stringify(label)}.includes('proxy')?g.querySelector('.build-proxy'):g.querySelector('summary');n.scrollIntoView({block:'start'});})()`,
        );
        await settle();
        layout.sections = await ev(`(()=>{
          const groups=[...document.querySelectorAll('.build-group')],env=groups[2],additional=groups[3],box=e=>e.getBoundingClientRect(),gap=(a,b)=>box(b).top-box(a).bottom;
          const h=[...env.querySelectorAll('h3')], buttons=[...env.querySelectorAll('button')],add=buttons.find(e=>e.textContent.trim()==='Добавить переменную'),host=buttons.find(e=>e.textContent.trim()==='Добавить хост');
          const envRows=[...env.querySelectorAll('.build-pair')].filter(e=>e.querySelector('[aria-label^="Имя переменной"]')),hostRows=[...env.querySelectorAll('.build-pair')].filter(e=>e.querySelector('[aria-label^="Имя хоста"]'));
          return {summaryGaps:groups.filter(g=>g.open).map(g=>({title:g.querySelector('summary').textContent,gap:gap(g.querySelector('summary'),g.querySelector('summary').nextElementSibling)})),
            environment:env.open?{titleHint:gap(h[0],h[0].nextElementSibling),hintContent:gap(h[0].nextElementSibling,envRows[0]||add),addHostsTitle:gap(add,h[1]),hostsContent:gap(h[1],hostRows[0]||host),hostsProxy:gap(host,env.querySelector('.build-proxy')),nextSection:gap(env.querySelector('.build-proxy'),additional.querySelector('summary')),
              rowGaps:[...envRows.slice(1).map((e,i)=>gap(envRows[i],e)),...hostRows.slice(1).map((e,i)=>gap(hostRows[i],e))],rows:envRows.length+hostRows.length}:null,
            additional:additional.open?gap(additional.querySelector('label.check'),additional.querySelector('.hint')):null,
            fits:[...document.querySelectorAll('.build-group[open] label,.build-pair')].every(e=>e.scrollWidth<=e.clientWidth+1)};
        })()`);
        report.sectionMeasurements ??= [];
        report.sectionMeasurements.push({
          label,
          width,
          height,
          ...layout.sections,
        });
        assert(
          layout.sections.summaryGaps.every(
            (x) => x.gap >= 19.5 && x.gap <= 20.5,
          ),
          "Summary/content spacing " + JSON.stringify(layout.sections),
        );
        if (layout.sections.environment) {
          const e = layout.sections.environment;
          assert(
            e.titleHint >= 11.5 &&
              e.hintContent >= 11.5 &&
              e.hostsContent >= 11.5 &&
              e.addHostsTitle >= 23.5 &&
              e.hostsProxy >= 23.5 &&
              e.nextSection >= 40 &&
              e.rowGaps.every((g) => g >= 11.5),
            "Environment spacing " + JSON.stringify(e),
          );
        }
        if (layout.sections.additional !== null)
          assert(
            layout.sections.additional >= 15.5,
            "Checkbox/explanation spacing",
          );
        assert(layout.sections.fits, "Field and row wrapping");
      }
      const screenshot = path.join(root, `${label}-${width}x${height}.png`);
      fs.writeFileSync(screenshot, (await wc.capturePage()).toPNG());
      report.screenshots.push({ file: screenshot, width, height, layout });
    };
    const pair = async (label) => {
      await shot(label, 1320, 900);
      await shot(label, 920, 700);
    };
    const draftState = () =>
      ev(`(()=>{
      const f=document.querySelector('.build-form');
      return {fields:[...f.querySelectorAll('input,select')].map(e=>({type:e.type,value:e.value,checked:e.checked})),switches:[...f.querySelectorAll('[role=switch]')].map(e=>e.getAttribute('aria-checked'))};
    })()`);
    const assertDraftTab = async (active) => {
      const state = await ev(
        `(()=>{const tabs=[...document.querySelectorAll('.build-draft-tab')],tab=tabs[0];return {count:tabs.length,selected:tab?.getAttribute('aria-selected'),forms:document.querySelectorAll('.build-form').length,visible:!!tab?.getClientRects().length,close:!!document.querySelector('[aria-label="Закрыть вкладку Новая сборка"]')};})()`,
      );
      assert.equal(state.count, 1);
      assert.equal(state.forms, 1);
      assert(state.visible && state.close);
      assert.equal(state.selected, String(active));
    };
    const input = async (selector, value) => {
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing input');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await settle();
    };
    const visibleText = () => ev("document.body.innerText");
    await until("!!document.querySelector('.project-home-panel input')");
    assert.deepEqual(
      await ev(
        "[...document.querySelectorAll('.tabs > button')].map(e=>e.textContent.trim())",
      ),
      ["Главная", "Топики"],
    );
    assert.deepEqual(
      await ev(
        "[...document.querySelectorAll('.section-tabs button')].map(e=>e.textContent.trim())",
      ),
      [
        "Запуск",
        "Конфигурация",
        "Рабочие процессы",
        "Конвейеры",
        "Инструменты",
        "Профили",
      ],
    );
    const headerHeight = await ev(
      "document.querySelector('.project-bar').getBoundingClientRect().height",
    );
    await pair("home-launch");
    await clickText("Конфигурация");
    await clickText("Открыть редактор");
    await until("!!document.querySelector('.yaml-code-editor')");
    await pair("home-config");
    await clickText("Запуск");
    await input(
      '.project-home-panel input[aria-describedby="executable-help"]',
      "fixture-changed",
    );
    await clickText("Запустить сборку");
    await until("!!document.querySelector('dialog[open]')");
    assert((await visibleText()).includes("Сохранить изменения?"));
    await clickText("Отмена");
    assert.equal(
      await ev("document.querySelector('.project-home-panel input').value"),
      "fixture-changed",
    );
    await clickText("Запустить сборку");
    await clickText("Не сохранять и перейти");
    const missingText =
      "План для текущего топика ещё не создан. Выберите другой файл.";
    await until(
      `document.body.innerText.includes(${JSON.stringify(missingText)})`,
    );
    assert.equal(
      await ev("document.querySelectorAll('.build-form [role=alert]').length"),
      0,
    );
    assert.equal(
      await ev(
        "document.querySelector('.build-footer .split-launch-main').disabled",
      ),
      true,
    );
    assert.equal(
      await ev(
        "[...document.querySelectorAll('button')].find(e=>e.textContent==='Посмотреть план').disabled",
      ),
      true,
    );
    assert.equal(
      await ev(
        "document.querySelector('.build-form [role=switch]').getAttribute('aria-checked')",
      ),
      "false",
    );
    assert(
      !(await visibleText()).match(/Error invoking|read-build-plan|однозначно/),
    );
    await pair("build-missing-tools-null");
    await pair("build-launch-missing");
    for (const mode of ["true", "false"]) {
      effectiveMode = mode;
      await clickText("План из истории");
      await until(
        `document.querySelector('.build-form [role=switch]').getAttribute('aria-checked')==='${mode}' && !document.body.innerText.includes('Проверяем план')`,
      );
      assert.equal(
        await ev(
          "document.querySelectorAll('.build-form [role=alert]').length",
        ),
        0,
      );
      await pair("build-missing-tools-amended-" + mode);
    }
    await clickText("Выбрать файл…");
    await until(
      "!!document.querySelector('[aria-label=\"Открыть папку docs\"]')",
    );
    await clickLabel("Открыть папку docs");
    await until(
      "!!document.querySelector('[aria-label=\"Выбрать custom-plan.md\"]')",
    );
    await clickLabel("Выбрать custom-plan.md");
    await until("document.body.innerText.includes('План доступен')");
    assert(!(await visibleText()).includes(missingText));
    await pair("build-real-alternative-after-missing");
    await pair("build-launch-valid");
    actualBuildBackend = false;
    await clickText("План из истории");
    await until("document.body.innerText.includes('План доступен')");
    assert.equal(
      await ev("document.querySelector('#build-plan').value"),
      planPath,
    );
    assert.equal(
      await ev(
        "document.querySelector('.build-form [role=switch]').getAttribute('aria-checked')",
      ),
      "false",
    );
    assert.equal(
      await ev(
        "document.querySelector('.build-clean input').closest('details')===null",
      ),
      true,
    );
    await pair("build-default");
    await clickText("Выбрать файл…");
    await until("!!document.querySelector('.build-file-list')");
    await pair("build-chooser");
    await clickLabel("Открыть папку docs");
    await until("document.body.innerText.includes('custom-plan.md')");
    await clickText("Отмена");
    assert.equal(
      await ev("document.querySelector('#build-plan').value"),
      planPath,
    );
    await clickText("Выбрать файл…");
    await clickLabel("Открыть папку docs");
    await until(
      "!!document.querySelector('[aria-label=\\\"Выбрать custom-plan.md\\\"]')",
    );
    await clickLabel("Выбрать custom-plan.md");
    await until(
      "document.querySelector('#build-plan').value==='docs/custom-plan.md'",
    );
    await clickText("Посмотреть план");
    await pair("build-plan-preview");
    await clickLabel("Закрыть карточку");
    await input("#build-plan", "../outside.md");
    await until("document.body.innerText.includes('за пределами проекта')");
    await pair("build-plan-error");
    await clickText("План из истории");
    await until("document.body.innerText.includes('План доступен')");
    await ev(
      "[...document.querySelectorAll('.build-group')].forEach(e=>e.open=true)",
    );
    await settle();
    await pair("build-sections-environment-empty-together");
    await pair("build-sections-additional-together");
    for (const [index, name] of [
      [0, "execution"],
      [1, "review"],
      [2, "environment-empty"],
      [3, "additional"],
    ]) {
      await ev(
        `[...document.querySelectorAll('.build-group')].forEach((e,i)=>e.open=i===${index})`,
      );
      await pair("build-sections-" + name + "-alone");
    }
    await ev(
      "[...document.querySelectorAll('.build-group')].forEach(e=>e.open=true)",
    );
    await clickText("Добавить переменную");
    await clickText("Добавить переменную");
    await clickText("Добавить хост");
    await clickText("Добавить хост");
    await pair("build-sections-environment-empty-rows");
    for (let i = 1; i <= 2; i++) {
      await input(
        `[aria-label="Имя переменной ${i}"]`,
        "LONG_SETTING_NAME_".repeat(4) + i,
      );
      await input(
        `[aria-label="Значение переменной ${i}"]`,
        "fixture-value-".repeat(20),
      );
      await input(
        `[aria-label="Имя хоста ${i}"]`,
        "long-service-name-".repeat(4) + i + ".example.test",
      );
      await input(
        `[aria-label="IP-адрес ${i}"]`,
        i === 1 ? "127.0.0.1" : "host-gateway",
      );
    }
    await input('[aria-label="Прокси"]', "https://proxy.example.test:8443");
    await pair("build-sections-environment-filled");
    await pair("build-sections-environment-filled-hosts");
    await pair("build-sections-environment-filled-proxy");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    const beforeNavigationLaunches = report.buildRequests.length;
    const retainedDraft = await draftState();
    for (const destination of ["Главная", "Топики"]) {
      await clickText(destination);
      await assertDraftTab(false);
      await until(
        destination === "Главная"
          ? "!!document.querySelector('.project-home-panel input')"
          : "!!document.querySelector('.topic-table')",
      );
      await pair(
        destination === "Главная" ? "draft-tab-home" : "draft-tab-topics",
      );
      await clickText("Новая сборка");
      await until(
        "!document.querySelector('.build-footer .split-launch-main').disabled",
      );
      await assertDraftTab(true);
      assert.deepEqual(await draftState(), retainedDraft);
    }
    await clickText("Запустить сборку");
    await assertDraftTab(true);
    assert.deepEqual(await draftState(), retainedDraft);
    await pair("draft-tab-returned");
    assert.equal(report.buildRequests.length, beforeNavigationLaunches);
    // Remove only disposable form fixture rows; leave all later behaviour checks unchanged.
    for (let i = 2; i >= 1; i--) {
      await clickLabel("Удалить переменную " + i);
      await clickLabel("Удалить хост " + i);
    }
    await input('[aria-label="Прокси"]', "");
    await until("!document.body.innerText.includes('Получаем параметры')");
    for (const mode of ["history", "empty", "long", "loading", "error"]) {
      chooserMode = mode;
      await clickText("Выбрать файл…");
      await until(
        "!!document.querySelector('dialog[open] .build-file-toolbar')",
      );
      if (mode === "history") {
        await until(
          "!!document.querySelector('[aria-label=\"Открыть папку .goga\"]')",
        );
        await clickLabel("Открыть папку .goga");
        await until(
          "!!document.querySelector('[aria-label=\"Открыть папку history\"]')",
        );
        await clickLabel("Открыть папку history");
        await until(
          "document.querySelector('.build-file-location').textContent==='.goga/history' && !!document.querySelector('.build-file-list')",
        );
      } else if (mode === "long") {
        await until("!!document.querySelector('.build-file-list>button')");
        await clickLabel("Открыть папку " + longSegment);
        await until(
          "document.querySelectorAll('.build-file-list>button').length===100",
        );
      } else if (mode === "empty")
        await until("document.body.innerText.includes('Нет доступных файлов')");
      else if (mode === "error")
        await until("!!document.querySelector('dialog [role=alert]')");
      else await until("document.body.innerText.includes('Загружаем файлы')");
      await pair("build-chooser-" + mode);
      if (mode === "long") await pair("build-chooser-long-end");
      await clickText("Отмена");
      assert.equal(
        await ev("document.querySelector('#build-plan').value"),
        planPath,
      );
    }
    chooserMode = "normal";
    await pair("build-options");
    await clickText("Пропустить ревью");
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\\\"База сравнения\\\"]').disabled",
      ),
      true,
    );
    await clickText("Пропустить ревью");
    await ev("document.querySelector('.build-clean input').click()");
    await settle();
    await clickLabel("Варианты запуска");
    await clickText("Запустить с обновлением образа");
    await until("!!document.querySelector('dialog[open]')");
    assert.equal(report.buildRequests.length, 0);
    await pair("build-clean-confirm");
    await clickText("Отмена");
    assert.equal(report.buildRequests.length, 0);
    await clickLabel("Варианты запуска");
    await clickText("Запустить с обновлением образа");
    await clickText("Очистить и запустить");
    await until("!!document.querySelector('.run-output-text')");
    assert.equal(report.buildRequests.length, 1);
    assert.equal(report.buildRequests[0].options.update, true);
    assert.equal(report.buildRequests[0].confirmClean, true);
    assert(!(await visibleText()).includes("Dashboard"));
    fixtureRuns[0].output.text += "Шаг 2: прогресс в реальном времени\n";
    publish();
    await until("document.body.innerText.includes('Шаг 2')");
    await pair("build-running");
    await clickText("Остановить");
    await until("document.body.innerText.includes('Сборка остановлена')");
    await pair("build-stopped");
    await assertDraftTab(false);
    const afterLaunchDraft = await draftState();
    await clickText("Новая сборка");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    assert.deepEqual(await draftState(), afterLaunchDraft);
    await pair("draft-tab-run-return");
    await ev(
      "document.querySelector('.run-tab:not(.build-draft-tab)').click()",
    );
    await until("!!document.querySelector('.run-output-text')");
    await assertDraftTab(false);

    await clickText("Повторить сборку");
    assert.equal(report.repeatRequests.length, 0);
    await clickText("Очистить и запустить");
    await until("document.body.innerText.includes('Повтор исходного плана')");
    assert.deepEqual(report.repeatRequests[0], ["build-1", true]);
    const repeat = fixtureRuns.at(-1);
    repeat.status = "failed";
    repeat.error = "Тестовая ошибка процесса";
    repeat.output.text += "Сохранённый вывод перед ошибкой\\n";
    publish();
    await until("document.body.innerText.includes('Тестовая ошибка процесса')");
    await pair("build-failed");
    await clickText("Запустить сборку");
    await until("document.body.innerText.includes('План доступен')");
    await ev("document.querySelector('.build-clean input').click()");
    await settle();
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    await clickText("Запустить");
    await until(
      "document.querySelectorAll('.run-tab:not(.build-draft-tab)').length===3",
    );
    assert.equal(report.buildRequests.at(-1).options.update, false);
    assert.equal(report.buildRequests.at(-1).options.clean, false);
    const ordinary = fixtureRuns.at(-1);
    ordinary.status = "exited";
    ordinary.output.text += "Выполнение завершено\\n";
    publish();
    await until("document.body.innerText.includes('Выполнение завершено')");
    await pair("build-exited");
    oldCLI = true;
    await clickText("Запустить сборку");
    await until(
      "document.body.innerText.includes('Выбор не будет проигнорирован')",
    );
    await pair("build-old-cli");
    assert.equal(
      await ev(
        "document.querySelector('.build-footer .split-launch-main').disabled",
      ),
      true,
    );
    await clickText("Топики");
    await until("!!document.querySelector('.topic-table tbody tr')");
    await pair("topics-preserved");
    assert.equal(
      await ev(
        "document.querySelector('.project-bar').getBoundingClientRect().height",
      ),
      headerHeight,
    );
    oldCLI = false;
    const beforeProjectNavigationLaunches = report.buildRequests.length;
    await clickText("Новая сборка");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    const firstProjectDraft = await draftState();
    await ev("document.querySelectorAll('.project-button')[1].click()");
    await until("!!document.querySelector('.project-home-panel input')");
    assert.equal(
      await ev("document.querySelectorAll('.build-draft-tab').length"),
      0,
    );
    await clickText("Запустить сборку");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    await input("#build-plan", "second-plan.md");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    const secondProjectDraft = await draftState();
    await pair("draft-tab-second-project");
    await ev("document.querySelectorAll('.project-button')[0].click()");
    await until("!!document.querySelector('.project-home-panel input')");
    await assertDraftTab(false);
    await clickText("Новая сборка");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    assert.deepEqual(await draftState(), firstProjectDraft);
    await pair("draft-tab-first-project-restored");
    await clickText("Главная");
    await until("!!document.querySelector('.project-home-panel input')");
    await clickLabel("Закрыть вкладку Новая сборка");
    assert.equal(
      await ev(
        "document.querySelectorAll('.build-draft-tab,.build-form').length",
      ),
      0,
    );
    assert(await ev("!!document.querySelector('.project-home-panel input')"));
    await pair("draft-tab-explicitly-closed");
    await clickText("Запустить сборку");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    assert.equal(
      await ev("document.querySelector('#build-plan').value"),
      planPath,
    );
    assert.equal(
      await ev("document.querySelector('.build-clean input').checked"),
      false,
    );
    await ev("document.querySelectorAll('.project-button')[1].click()");
    await until("!!document.querySelector('.project-home-panel input')");
    await clickText("Новая сборка");
    await until(
      "!document.querySelector('.build-footer .split-launch-main').disabled",
    );
    assert.deepEqual(await draftState(), secondProjectDraft);
    await clickLabel("Закрыть форму сборки");
    assert.equal(
      await ev(
        "document.querySelectorAll('.build-draft-tab,.build-form').length",
      ),
      0,
    );
    assert.equal(report.buildRequests.length, beforeProjectNavigationLaunches);
    report.draftNavigation = {
      home: true,
      topics: true,
      runs: true,
      repeatedEntry: true,
      projectIsolation: true,
      explicitClose: true,
      closePreservesOtherDraft: true,
      duplicateTabs: 0,
      launchesDuringNavigation: 0,
    };
    untouched();
    assert.deepEqual(blockedSpawns, []);
    assert.equal(report.visibleWindows, 0);
    assert(createdWindows.every((w) => !w.isVisible()));
    report.cspViolations = await ev("window.__cspViolations");
    assert.deepEqual(report.cspViolations, []);
    report.checks = [
      "Missing plan: persistent amber lock below launch only for typed missing; visible footer wide/narrow, both disabled controls associated; successful actual file read removes reason",
      "New build tab retained on Home/Topics/runs, full field snapshots unchanged, repeated entry without duplicates, two isolated projects, explicit close resets only target draft; wide/narrow packaged screenshots",

      "Chooser spacing measured between hint, toolbar, path and content: 16px; wrapped long path/names, history/empty/100-entry/loading/error states at both window sizes",
      "Home contains original six project editor sections; dirty guard cancel preserves edits and explicit discard allows navigation",
      "Real packaged build form: history default, readonly plan preview, root file browser cancellation/selection and invalid manual path error",
      "Review visual switch, disabled dependent inputs, always-visible clean checkbox, confirmation cancellation before mocked launch",
      "Image update launch and ordinary launch remain separate; saved request parameters asserted",
      "Mocked build lifecycle running/progress/stop/failed/exited, retained output, clean-confirmed repeat and no Dashboard waiting",
      "Older CLI unsupported project profile blocks launch instead of silently ignoring",
      "Topics board preserved; Home/build/Topics header height stable; wide/narrow snapshots and no horizontal overflow",
      "Production ASAR host/IPC/main/preload/renderer for missing plan with tools, amended null/true/false and actual alternative file; zero visible windows, OS subprocesses, CSP events or user data",
    ];
    report.limitations = [
      "Missing-plan/tools scenarios use production packaged host+IPC with strict command-transport fixtures (real CLI config samples); other Build/Topics/editor IPC uses deterministic fixtures; this is packaged UI verification, not real Docker or Goga build execution.",
      "Host filesystem containment, validation and process lifecycle are separately covered by temporary-repository/stub-process tests.",
      "No real network, Docker, pipeline, user project mutation or currently running app was used.",
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
