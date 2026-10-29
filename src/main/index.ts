import { createWindowTerminal } from "./terminal-bootstrap";
import { ShutdownCoordinator } from "./shutdown-coordinator";
import { installShutdownHandlers } from "./shutdown-handlers";
import { confirmCloseRun } from "./confirm-close";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HostService } from "../host/service";
import { SettingsStore } from "../host/settings";
import { TopicPopup } from "./topic-popup";
import { DashboardViews } from "./views";
import { registerIPC } from "./ipc";
import { loadShell } from "./load-shell";
import { installApplicationIcon } from "./app-icon";

// Finder does not inherit a shell's PATH. No login shell/eval is executed.
process.env.PATH = [
  path.join(os.homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  process.env.PATH ?? "/usr/bin:/bin",
].join(path.delimiter);
app.setName("Goga Desktop");
// An explicit disposable path is useful for isolated acceptance tests, never changes Goga home.
if (process.env.GOGA_DESKTOP_DATA_DIR) {
  mkdirSync(process.env.GOGA_DESKTOP_DATA_DIR, { recursive: true });
  app.setPath("userData", process.env.GOGA_DESKTOP_DATA_DIR);
}
let exiting = false;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      nativeTheme.themeSource = "dark";
      const icon = installApplicationIcon(app, __dirname);
      const win = new BrowserWindow({
        width: 1320,
        height: 900,
        minWidth: 920,
        minHeight: 700,
        title: "Goga Desktop",
        icon,
        titleBarStyle: "hiddenInset",
        backgroundColor: "#0a0e1a",
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          devTools: !app.isPackaged,
        },
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Goga Desktop",
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          {
            label: "Правка",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          { label: "Окно", submenu: [{ role: "minimize" }, { role: "front" }] },
        ]),
      );
      const settings = new SettingsStore(os.homedir());
      const service = new HostService({
        dataDir: app.getPath("userData"),
        settings,
        trashItem: (absolutePath) =>
          shell.trashItem(path.resolve(absolutePath)),
      });
      await service.initialize();
      const send = (channel: string, value: unknown) => {
        if (!win.isDestroyed()) win.webContents.send(`goga:${channel}`, value);
      };
      const views = new DashboardViews(
        win,
        (id) => send("focus-run", id),
        (id, error) => {
          send("view-error", { id, error });
          void service.dashboardFailed(id, error).catch(() => {});
        },
        (id, url) => service.markDashboardOpened(id, url),
      );
      const html = path.join(__dirname, "../dist/index.html"),
        shellURL = pathToFileURL(html).href;
      const topicPopup = new TopicPopup(win, shellURL);
      registerIPC(ipcMain, {
        topicPopup,
        service,
        settings,
        window: win,
        shellURL,
        choose: async () => {
          const result = await dialog.showOpenDialog(win, {
            title: "Выберите проект Goga",
            properties: ["openDirectory"],
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        confirmClose: (run) => confirmCloseRun(win, run),
        select: (id) => views.select(id),
        stop: async (id) => {
          const result = await dialog.showMessageBox(win, {
            type: "warning",
            message: "Остановить этот запуск?",
            detail:
              "Goga получит сигнал завершения. Уже сделанные изменения в проекте останутся.",
            buttons: ["Отмена", "Остановить"],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response === 1) await service.stop(id);
        },
      });
      service.on("runs", (runs) => {
        views.reconcile(runs.map((run: { id: string }) => run.id));
        send("runs", runs);
        for (const run of runs) {
          if (
            !run.dashboardOpened &&
            (run.error || !["starting", "running"].includes(run.status))
          )
            views.remove(run.id);
          else if (run.url)
            void views.ensure(run.id, run.url).catch(() => {
              const error = "Недопустимый адрес панели конвейера";
              send("view-error", { id: run.id, error });
              void service.dashboardFailed(run.id, error).catch(() => {});
            });
        }
      });
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      win.webContents.session.setPermissionRequestHandler((_c, _p, cb) =>
        cb(false),
      );
      win.webContents.session.setPermissionCheckHandler(() => false);
      const terminal = createWindowTerminal({
        window: win,
        shellURL,
        home: os.homedir(),
        appRoot: app.getAppPath(),
        resources: process.resourcesPath,
        packaged: app.isPackaged,
        host: service,
        canFocus: () => !topicPopup.isOpen,
      });
      const shutdown = new ShutdownCoordinator({
        participants: [
          { prepare: () => service.prepareShutdown() },
          { prepare: () => terminal.sessions.prepareShutdown() },
        ],
        confirm: async (items) => {
          const answer = await dialog.showMessageBox(win, {
            type: "warning",
            message: "Завершить запуски и терминалы и закрыть Goga Desktop?",
            detail:
              items.map((item) => item.label).join("\n") +
              "\n\nИзменения файлов сохранятся. Вкладки терминала восстановятся при следующем запуске, но процессы не будут перезапущены.",
            buttons: ["Остаться", "Завершить и выйти"],
            defaultId: 0,
            cancelId: 0,
          });
          return answer.response === 1;
        },
        finalize: async () => {
          await service.finalizeShutdown();
          terminal.sessions.finalizeShutdown();
          terminal.disposeAfterExit();
          topicPopup.dispose();
          views.dispose();
          exiting = true;
          app.quit();
        },
      });
      installShutdownHandlers({
        app,
        window: win,
        shutdown,
        isExiting: () => exiting,
        report: async (result) => {
          await dialog.showMessageBox(win, {
            type: "error",
            message: "Не удалось завершить выход",
            detail:
              (result.message ?? "Приложение остаётся открытым.") +
              (result.inventoryComplete === false
                ? "\nНе удалось проверить полный список процессов. Отсутствие процессов не подтверждено."
                : `\nЗавершено: ${result.completed.length}. Осталось: ${result.remaining.length}.`),
            buttons: ["Закрыть"],
          });
        },
      });
      await loadShell(win, html);
      app.on("second-instance", () => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      app.on("activate", () => {
        win.show();
        win.focus();
      });
    })
    .catch((error) => {
      dialog.showErrorBox(
        "Goga Desktop",
        "Не удалось запустить приложение: " +
          (error instanceof Error ? error.message : "неизвестная ошибка"),
      );
      app.exit(1);
    });
}
