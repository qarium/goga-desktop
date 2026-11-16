import {Demonstrations} from "../host/demonstrations/runtime";
import {createWindowDemonstrations} from "./demo-window";
import { OverviewExitGuard } from "./overview-close";
import { createWindowTerminal } from "./terminal-bootstrap";
import { ShutdownCoordinator } from "./shutdown-coordinator";
import { installShutdownHandlers } from "./shutdown-handlers";
import { confirmCloseRun } from "./confirm-close";
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  shell,
} from "electron";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createFileClipboard } from "./file-clipboard";
import { HostService } from "../host/service";
import { SettingsStore } from "../host/settings";
import { TopicPopup } from "./topic-popup";
import { readDashboardIdentity } from "../shared/dashboard-connection";
import { WindowDashboards } from "./dashboard-window";
import { DashboardViews } from "./views";
import { registerIPC } from "./ipc";
import { loadShell } from "./load-shell";
import { handleDesktopStartupFailure } from "./desktop-state-startup";
import { installApplicationIcon } from "./app-icon";
import { NotificationCenter } from "../host/notifications/store";
import { NotificationMonitor } from "./notification-monitor";
import { NotificationDelivery } from "./notification-delivery";
import { NotificationNavigation, installNotificationViewLifecycle, notificationWindowForeground, registerNotificationIPC } from "./notification-ipc";
import type { NotificationSnapshot } from "../shared/notifications";

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
      const demos = new Demonstrations({settingsFile:path.join(app.getPath("userData"),"demonstrations.json")});
      const service = new HostService({
        demonstrationActive:(projectId,contextId)=>contextId?
          demos.shows().some(s=>typeof s.scope!=="string" && s.scope.projectId===projectId && s.scope.contextId===contextId):demos.hasProject(projectId),
        dataDir: app.getPath("userData"),
        settings,
        fileClipboard: createFileClipboard(clipboard, data => new ClipboardItem(data)),
        showItemInFolder: (absolutePath) =>
          shell.showItemInFolder(absolutePath),
        trashItem: (absolutePath) =>
          shell.trashItem(path.resolve(absolutePath)),
      });
      await service.initialize();
      const send = (channel: string, value: unknown) => {
        if (!win.isDestroyed()) win.webContents.send(`goga:${channel}`, value);
      };
      const notifications = new NotificationCenter(app.getPath("userData"));
      // Broken notification storage must never prevent the app/pipeline UI loading.
      await notifications.initialize().catch(()=>{});
      let panels:WindowDashboards;
      const views = new DashboardViews(
        win,
        (id) => send("focus-run", id),
        (id, error) => {
          send("view-error", { id, error });
          if(!id.startsWith("attached:"))void service.dashboardFailed(id, error).catch(() => {});
        },
        (id, url) => id.startsWith("attached:")?panels.opened(id,url):service.dashboardLoaded(id, url),
        id=>send("dashboard-refresh",id),
      );
      panels=new WindowDashboards(service,views,rows=>send("attached-dashboards",rows));
      const html = path.join(__dirname, "../dist/index.html"),
        shellURL = pathToFileURL(html).href;
      const notificationNavigation = new NotificationNavigation({
        center: notifications,
        runs: () => service.runCatalog(),
        isSelected: (id) => views.isSelected(id),
        focusStage: (id, stage) => views.focusStage(id, stage),
        cancelStage: () => views.cancelStageNavigation(),
        isForeground: () => notificationWindowForeground(win),
      });
      const disposeNotificationViewing = installNotificationViewLifecycle(
        win,
        notificationNavigation,
      );
      let deliveryError="";
      const monitorErrors=new Map<string,string>();
      const withNotificationErrors=(snapshot:NotificationSnapshot):NotificationSnapshot=>({...snapshot,...(!snapshot.error&&(deliveryError||monitorErrors.size)?{error:deliveryError||"Обновление уведомлений временно недоступно. История сохранена."}:{})});
      const delivery=new NotificationDelivery({
        create: options=>{
          if(!Notification.isSupported())throw Error("Unsupported notifications");
          return new Notification(options);
        },
        badge: count=>app.dock?.setBadge(count),
        find:id=>notifications.find(id),
        isViewing:id=>win.isFocused()&&notificationNavigation.isViewing(id),
        open:id=>{
          if(win.isDestroyed())return;
          if(win.isMinimized())win.restore();
          win.show();win.focus();send("open-notification",id);
        },
        onError: error=>{if(deliveryError!==error){deliveryError=error;send("notifications",withNotificationErrors(notifications.snapshot()));}},
      });
      delivery.update(notifications.snapshot());
      if(process.platform==="darwin"&&notifications.snapshot().systemEnabled)
        void Notification.getHistory().then(history=>delivery.restore(history)).catch(()=>{});
      const unsubscribeNotifications=notifications.onChanged((snapshot,added)=>{
        delivery.update(snapshot,added);
        send("notifications",withNotificationErrors(snapshot));
      });
      const monitor=new NotificationMonitor({
        add:input=>notifications.add(input,()=>notificationNavigation.isViewingRecord(input)),
        onError:(id,error)=>{
          const previous=monitorErrors.get(id);
          if(error)monitorErrors.set(id,error);else monitorErrors.delete(id);
          if((previous??null)!==error)send("notifications",withNotificationErrors(notifications.snapshot()));
        },
      });
      monitor.reconcile(service.runCatalog());
      registerNotificationIPC(ipcMain,{center:notifications,navigation:notificationNavigation,window:win,shellURL,getSnapshot:(limit,before)=>withNotificationErrors(notifications.snapshot(limit,before))});
      const overviewExit = new OverviewExitGuard(async (paths) => {
        const result = await dialog.showMessageBox(win, {
          type: "warning",
          message: "В обзоре есть несохранённые файлы",
          detail:
            paths.join("\n") +
            "\n\nВернитесь в приложение, чтобы сохранить файлы. При выходе без сохранения черновики будут потеряны.",
          buttons: ["Вернуться", "Выйти без сохранения"],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      });
      const topicPopup = new TopicPopup(win, shellURL);
      registerIPC(ipcMain, {
        topicPopup,
        overviewCloseState: (paths, busy) => overviewExit.update(paths, busy),
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
        chooseProjectLocation: async () => {
          const result = await dialog.showOpenDialog(win, {
            title: "Выберите расположение нового проекта", properties: ["openDirectory"],
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        confirmClose: (run) => confirmCloseRun(win, run),
        panels,
        refreshDashboard:async id=>{
          const run=service.runCatalog().find(r=>r.id===id);
          if(!run?.url||run.status!=="running"||run.kind==="build"||run.recovery==="unverified")
            throw Error("Панель запуска недоступна.");
          const {url,dashboardRunId:pin}=run;
          const verify=async()=>{
            if(pin&&await readDashboardIdentity(url)!==pin)return false;
            const current=service.runCatalog().find(r=>r.id===id);
            return current?.status==="running"&&current.url===url&&current.recovery!=="unverified"&&(!pin||current.dashboardRunId===pin);
          };
          if(!await views.refresh(id,verify))throw Error("Не удалось обновить страницу панели. Конвейер не перезапускался.");
        },
        restoreDashboard: async (id) => {
          const url=await service.prepareDashboardReconnect(id);
          if(!(await views.restore(id,url)))throw Error("Не удалось восстановить панель. Процесс не перезапускался.");
        },
        select: (id) => views.select(id),
        viewport: (bounds) => views.setViewport(bounds),
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
      const presentRuns = (runs: ReturnType<HostService["runs"]>) => {
        monitor.reconcile(runs);
        panels.reconcile(runs);
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
      };
      // Only a revision crosses the shell boundary on stdout. No native view,
      // notification monitor or catalog update is needed for journal-only data.
      service.on("run-output", (id: string, sequence: number) => send("run-output", { id, sequence }));
      service.on("runs", presentRuns);
      service.on("project-creation", (value) => send("project-creation", value));
      presentRuns(service.runCatalog());
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
      const demonstrations = createWindowDemonstrations(ipcMain,{window:win,shellURL,runtime:demos,service,openExternal:url=>shell.openExternal(url)});
      const shutdown = new ShutdownCoordinator({
        participants: [
          { prepare: () => service.prepareProjectCreationShutdown() },
          { prepare: () => service.prepareShutdown() },
          { prepare: () => terminal.sessions.prepareShutdown() },
          demonstrations,
        ],
        confirm: async (items) => {
          const answer = await dialog.showMessageBox(win, {
            type: "warning",
            message: "Закрыть Goga Desktop?",
            detail:
              items.map((item) => item.label).join("\n") +
              "\n\nМожно оставить новые управляемые конвейеры работать и подключиться к ним при следующем открытии. Создание проектов будет отменено (готовые папки сохраняются). Открытые демонстрации и подключения агентов в обоих случаях будут закрыты. Терминалы будут завершены; их вкладки сохранятся, но процессы не перезапускаются. Если безопасное сохранение запуска невозможно, приложение останется открытым.",
            buttons: ["Остаться", "Оставить запуски работать и выйти", "Завершить и выйти"],
            defaultId: 0,
            cancelId: 0,
          });
          return answer.response === 1 ? "keep" : answer.response === 2;
        },
        finalize: async () => {
          overviewExit.validate();
          await service.finalizeShutdown();
          await demonstrations.close();
          terminal.sessions.finalizeShutdown();
          terminal.disposeAfterExit();
          topicPopup.dispose();
          panels.dispose();
          views.dispose();
          monitor.dispose();
          unsubscribeNotifications();
          disposeNotificationViewing();
          delivery.dispose();
          exiting = true;
          app.quit();
        },
      });
      installShutdownHandlers({
        app,
        window: win,
        shutdown,
        isExiting: () => exiting,
        beforeClose: () => overviewExit.beforeClose(),
        report: async (result) => {
          await dialog.showMessageBox(win, {
            type: "error",
            message: "Не удалось завершить выход",
            detail:
              (result.message ?? "Приложение остаётся открытым.") +
              (result.inventoryComplete === false
                ? "\nНе удалось проверить полный список процессов. Отсутствие процессов не подтверждено."
                : `\nЗавершено: ${result.completed.length}. Осталось: ${result.remaining.length}.` + (result.retained?.length ? `\nОставлены работать: ${result.retained.length}.` : "")),
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
    .catch((error) => handleDesktopStartupFailure(error, {
      confirmRecovery: async () => {
        const answer = await dialog.showMessageBox({
          type: "warning",
          title: "Goga Desktop",
          message: "Нужно восстановить блокировку настроек Desktop",
          detail: "Предыдущая версия оставила блокировку без данных владельца. Закройте другие экземпляры Goga Desktop. После подтверждения приложение проверит, что файл не используется, сохранит его резервную копию и перезапустится. Настройки, проекты и данные запусков не сбрасываются.",
          buttons: ["Закрыть", "Проверить и восстановить"],
          defaultId: 0,
          cancelId: 0,
        });
        return answer.response === 1;
      },
      showError: (message) => dialog.showErrorBox("Goga Desktop", message),
      relaunch: () => app.relaunch(),
      exit: (code) => app.exit(code),
    }));
}
