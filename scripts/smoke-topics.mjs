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
if (process.env.TOPICS_ASAR_SHA256 !== archiveHash)
  throw Error(
    "Explicit verified ASAR SHA256 required; bundle must be reviewed before execution",
  );
const root = fs.mkdtempSync("/private/tmp/goga-topics-smoke-");
const home = path.join(root, "home"),
  project = path.join(root, "project");
const fixtures = {
  "home/.goga/config.yml": "# home sentinel\n",
  "project/.goga/config.yml": "tools:\n  fixture-tool: latest\n",
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
    projects: [{ id: "fixture", name: "Topics acceptance", path: project }],
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
  const tickets = new Map();
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
  electron.ipcMain.handle = (channel, handler) =>
    originalHandle(channel, (event, ...args) => {
      report.ipcCalls.push(channel);
      const name = channel.replace(/^goga:/, "");
      if (name === "read-topic-board") return { ...board, year: args[1] };
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
      if (name === "runs") return [oldRun];
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
      "!!window.goga && !!document.querySelector('.project-settings-action')",
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
        `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Button absent: '+${JSON.stringify(text)});e.click()})()`,
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
          overflow:[...document.querySelectorAll('.app-shell,.scroll-area,.project-settings-panel,.master-detail,.editor-pane')].filter(e=>e.getClientRects().length&&e.scrollWidth>e.clientWidth+1).map(e=>e.className)};
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
      const screenshot = path.join(root, `${label}-${width}x${height}.png`);
      fs.writeFileSync(screenshot, (await wc.capturePage()).toPNG());
      report.screenshots.push({ file: screenshot, width, height, layout });
    };
    const pair = async (label) => {
      await shot(label, 1320, 900);
      await shot(label, 920, 700);
    };
    const input = async (selector, value) => {
      await ev(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing input');const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
      await settle();
    };
    const visibleText = () => ev("document.body.innerText");
    await clickText("Топики");
    await until("!!document.querySelector('.topic-table tbody tr')");
    const toggles = await ev(
      "[...document.querySelectorAll('.topic-switches [role=switch]')].map(e=>[e.textContent,e.getAttribute('aria-checked')])",
    );
    assert.deepEqual(toggles, [
      ["Описания задач", "true"],
      ["Состояния по веткам", "false"],
      ["Только удалённые ветки", "false"],
    ]);
    const headerHeight = await ev(
      "document.querySelector('.project-bar').getBoundingClientRect().height",
    );
    const refreshStyle = await ev(`(()=>{
      const button=document.querySelector('[aria-label="Обновить список"]');
      const style=getComputedStyle(button), rect=button.getBoundingClientRect();
      return {border:parseFloat(style.borderTopWidth), background:style.backgroundColor, width:rect.width, height:rect.height};
    })()`);
    assert(
      refreshStyle.border >= 1 &&
        !["transparent", "rgba(0, 0, 0, 0)"].includes(refreshStyle.background),
    );
    assert(refreshStyle.width >= 36 && refreshStyle.height >= 36);
    await pair("topics-default");
    await input('[placeholder="Часть имени топика"]', "FIX-SEARCH");
    assert.equal(
      await ev("document.querySelectorAll('.topic-table tbody tr').length"),
      1,
    );
    assert(!(await ev("!!document.querySelector('tr[aria-current=true]')")));
    await input('[placeholder="Часть имени топика"]', "");
    await clickText("Состояния по веткам");
    await pair("topics-per-host");
    assert.equal(
      await ev("document.querySelectorAll('.topic-table tbody tr').length"),
      4,
    );
    await ev("document.querySelector('.topic-placements summary').click()");
    await pair("topics-placements");
    await clickText("Топики · Все ▾");
    await input("dialog input[type=search]", "fix");
    assert.equal(
      await ev("document.querySelectorAll('.topic-table tbody tr').length"),
      4,
    );
    await pair("topics-picker");
    await clickText("Отмена");
    await clickText("Только удалённые ветки");
    assert.equal(
      await ev("document.querySelectorAll('.topic-table tbody tr').length"),
      1,
    );
    board.dirty = true;
    cardReadGate = new Promise((resolve) => {
      releaseCardRead = resolve;
    });
    await clickLabel("Открыть топик feature-export");
    await until("!!document.querySelector('dialog .topic-card-spinner')");
    assert.equal(
      await ev(
        "document.querySelectorAll('dialog .topic-card-context, dialog .topic-card-section, dialog .topic-operation-grid, dialog textarea').length",
      ),
      0,
    );
    assert.equal(
      await ev(
        "document.querySelector('[aria-label=\"Закрыть карточку\"]').disabled",
      ),
      false,
    );
    assert.equal(
      await ev(
        "getComputedStyle(document.querySelector('.topic-card-spinner')).animationName",
      ),
      "topic-card-spin",
    );
    await pair("topics-loading");
    releaseCardRead();
    cardReadGate = null;
    await until("!!document.querySelector('dialog .topic-task-preview')");
    assert(!(await ev("!!document.querySelector('dialog [role=alert]')")));
    await pair("topics-remote-card");
    assert.equal(
      await ev(
        `[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()==='Удалить топик…').disabled`,
      ),
      false,
    );
    for (const text of [
      "Обновить из базы…",
      "Опубликовать…",
      "Перенести в базу…",
    ])
      assert.equal(
        await ev(
          `[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).disabled`,
        ),
        true,
      );
    assert(
      (await visibleText()).includes(
        "Для этого действия выберите локальную ветку топика.",
      ),
    );
    assert.equal(
      await ev("document.querySelectorAll('.topic-action-reason').length"),
      4,
    );
    await pair("topics-remote-card-actions");
    await clickText("Удалить топик…");
    await until("!!document.querySelector('.topic-confirm')");
    assert.equal(report.prepareRequests.at(-1).target.branch, remote.branch);
    await clickText("Отмена");
    await clickLabel("Закрыть карточку");
    await clickText("Только удалённые ветки");
    board.dirty = true;
    cardReadFailure = "Тестовая ошибка загрузки. Данные не изменены.";
    await clickLabel("Открыть топик fix-search");
    await until("!!document.querySelector('dialog [role=alert]')");
    assert.equal(
      await ev(
        "document.querySelectorAll('dialog .topic-card-context, dialog .topic-operation-grid').length",
      ),
      0,
    );
    await pair("topics-load-error");
    cardReadFailure = "";
    await clickText("Повторить загрузку");
    await until("!!document.querySelector('dialog .topic-task-preview')");
    for (const text of [
      "Обновить из базы…",
      "Удалить топик…",
      "Опубликовать…",
      "Перенести в базу…",
    ])
      assert.equal(
        await ev(
          `[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).disabled`,
        ),
        false,
      );
    assert.equal(
      await ev(
        `[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()==='Переключиться на топик…').disabled`,
      ),
      true,
    );
    await pair("topics-other-card-actions");
    await clickLabel("Закрыть карточку");
    await clickLabel("Открыть топик feature-catalog");
    await until("!!document.querySelector('dialog textarea')");
    await pair("topics-card");
    await pair("topics-card-actions");
    for (const text of ["Обновить из базы…", "Удалить топик…"])
      assert.equal(
        await ev(
          `[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).disabled`,
        ),
        true,
      );
    for (const text of ["Опубликовать…", "Перенести в базу…"])
      assert.equal(
        await ev(
          `[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).disabled`,
        ),
        false,
      );
    await clickText("Опубликовать…");
    await until("!!document.querySelector('.topic-confirm')");
    assert.equal(report.prepareRequests.at(-1).action, "publish");
    await clickText("Отмена");
    await input(
      "dialog textarea",
      "Длинная задача без потери текста. ".repeat(250),
    );
    await pair("topics-card-long-draft");

    await input("dialog textarea", "Несохранённый черновик карточки 🐈");
    for (const text of ["Опубликовать…", "Перенести в базу…"])
      assert.equal(
        await ev(
          `[...document.querySelectorAll('dialog button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).disabled`,
        ),
        true,
      );
    await ev(
      "document.querySelector('dialog textarea').focus();document.querySelector('dialog').scrollTop=0",
    );
    await pair("topics-card-draft");
    taskVersion = "changed-externally";

    await clickLabel("Закрыть карточку");
    await clickLabel("Открыть топик feature-catalog");
    await until("!!document.querySelector('dialog textarea')");
    assert.equal(
      await ev("document.querySelector('dialog textarea').value"),
      "Несохранённый черновик карточки 🐈",
    );
    assert((await visibleText()).includes("Сохранённая задача изменилась"));
    await pair("topics-card-conflict");
    board.dirty = false;
    await clickText("Подготовить запуск");
    await until("!!document.querySelector('.launch-panel textarea')");
    await until(
      "document.querySelector('.launch-panel textarea').value==='Несохранённый черновик карточки 🐈'",
    );
    await pair("topics-prepared-launch");
    await ev("document.querySelector('.launch-topic-link').click()");
    await until("!!document.querySelector('dialog textarea')");
    await input("dialog textarea", "Изменено в карточке подготовки");
    await clickLabel("Закрыть карточку");
    assert.equal(
      await ev("document.querySelector('.launch-panel textarea').value"),
      "Изменено в карточке подготовки",
    );
    await clickText("Топики");
    await until("!!document.querySelector('.topic-table tbody tr')");
    await clickText("Создать топик");
    await until("!!document.querySelector('dialog form')");
    await pair("topics-create-defaults");
    await pair("topics-create-actions");
    for (const [published, switched] of [
      [true, false],
      [false, false],
      [false, true],
      [true, true],
    ]) {
      const now = await ev(
        "[...document.querySelectorAll('dialog [role=switch]')].map(e=>e.getAttribute('aria-checked')==='true')",
      );
      if (now[0] !== published) await clickText("Опубликовать");
      if (now[1] !== switched) await clickText("Переключиться на новый топик");
      await input(
        'dialog input[placeholder="feature/my-topic"]',
        "feature/fixture",
      );
      await input("dialog textarea", "Задача «Юникод»\nВторая строка 🐈");
      await clickText("Продолжить");
      await until("!!document.querySelector('.topic-confirm')");
      assert.equal(report.prepareRequests.at(-1).publish, published);
      assert.equal(report.prepareRequests.at(-1).switch, switched);
      assert.equal(
        report.prepareRequests.at(-1).task,
        "Задача «Юникод»\nВторая строка 🐈",
      );
      if (published && switched) {
        await pair("topics-create-confirm");
        await clickText("Подтвердить");
        await until(
          "document.body.innerText.includes('Тестовый частичный результат')",
        );
        await pair("topics-partial");
      } else await clickText("Отмена");
    }
    await clickLabel("Закрыть карточку");
    board.dirty = true;
    await clickLabel("Обновить список");
    await until(
      "document.body.innerText.includes('Удаление других топиков доступно после подтверждения.')",
    );
    await clickLabel("Выбрать топик fix-search в fix/search");
    await clickText("Удалить выбранные…");
    await until("!!document.querySelector('.topic-confirm')");
    await pair("topics-delete-preview");
    await clickText("Отмена");
    await clickLabel("Закрыть карточку");
    await ev("document.querySelector('[role=tab]').click()");
    await clickLabel("Топик запуска fix-search");
    await until(
      "document.body.innerText.includes('Снимок задачи на момент запуска.')",
    );
    assert.equal(
      await ev("document.querySelectorAll('dialog textarea').length"),
      0,
    );
    await pair("topics-run-snapshot");
    assert.equal(
      await ev(
        "document.querySelector('.project-bar').getBoundingClientRect().height",
      ),
      headerHeight,
    );
    assert.equal(report.executeCalls.length, 1);
    untouched();
    assert.deepEqual(blockedSpawns, []);
    assert.equal(report.visibleWindows, 0);
    assert(createdWindows.every((w) => !w.isVisible()));
    report.cspViolations = await ev("window.__cspViolations");
    assert.deepEqual(report.cspViolations, []);
    report.checks = [
      "Compact amber reason blocks with decorative locks, visible text and accessible button associations; no clipped blocks at both widths; existing action availability unchanged",
      "Refresh button has visible background/border and 36px hit area; delayed popup loading hides all partial controls; read failure shows error/retry",
      "Approved switch defaults/order; live case-insensitive name filter; per-host and remote projection",
      "Independent picker search; full placements; actual-current row filtered, no resurrection",
      "Memory draft survives card close; prepare opens form only; shared preparation task editing",
      "Four independent creation modes; Unicode/newlines; confirmation cancellation; mocked partial result retained",
      "Dirty current tree: other local update/delete and remote delete enabled; remote local-branch prerequisites explained; current update/delete still blocked",
      "Concrete origin/local bulk-delete preview with dirty working copy, no execution",
      "Immutable read-only historical run snapshot",
      "Wide/narrow screenshots, no layout overflow, unchanged project-header height",
      "Production packaged main/preload/renderer security retained; no visible window, subprocess, user data or real writes",
    ];
    report.limitations = [
      "Topics, catalog and operation IPC responses are isolated fixtures. Actual host/CLI behavior is separately covered by automated temporary-repository tests.",
      "No real network origin, user pipeline, Docker or live running app was used.",
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
