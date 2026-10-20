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
import { DashboardViews } from "./views";
import { registerIPC } from "./ipc";
import { loadShell } from "./load-shell";

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
      const win = new BrowserWindow({
        width: 1320,
        height: 900,
        minWidth: 920,
        minHeight: 700,
        title: "Goga Desktop",
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
      registerIPC(ipcMain, {
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
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      win.webContents.session.setPermissionRequestHandler((_c, _p, cb) =>
        cb(false),
      );
      win.webContents.session.setPermissionCheckHandler(() => false);
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
      let closing = false;
      async function close() {
        if (exiting || closing) return;
        closing = true;
        try {
          const active = service
            .runs()
            .filter((r) => r.status === "starting" || r.status === "running");
          if (active.length) {
            const answer = await dialog.showMessageBox(win, {
              type: "warning",
              message: `Остановить запуски (${active.length}) и закрыть Goga Desktop?`,
              detail:
                "Изменения проектов сохранятся; desktop не запускает процессы в фоне после выхода.",
              buttons: ["Остаться", "Остановить и выйти"],
              defaultId: 0,
              cancelId: 0,
            });
            if (answer.response !== 1) return;
            await Promise.all(active.map((r) => service.stop(r.id)));
          }
          await service.dispose();
          exiting = true;
          views.dispose();
          app.quit();
        } finally {
          closing = false;
        }
      }
      win.on("close", (event) => {
        if (!exiting) {
          event.preventDefault();
          void close();
        }
      });
      app.on("before-quit", (event) => {
        if (!exiting) {
          event.preventDefault();
          void close();
        }
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
