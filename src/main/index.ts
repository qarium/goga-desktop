import { DesktopLanguagePreference } from "./interface-language";
import { getLocale, setLocale, t } from "../shared/i18n";
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
import { prepareRendererAssets } from "./renderer-assets";
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
let rendererAssets: Awaited<ReturnType<typeof prepareRendererAssets>> | undefined;
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app
    .whenReady()
    .then(async () => {
      const languagePreference = new DesktopLanguagePreference(app.getPath("userData"));
      setLocale(languagePreference.read());
      nativeTheme.themeSource = "dark";
      const icon = installApplicationIcon(app, __dirname);
      // Keep the shell's entire lazy-import graph stable for this window's
      // lifetime. Local rebuilds may replace dist without replacing this app.
      rendererAssets = await prepareRendererAssets(
        path.join(__dirname, "../dist"),
        app.isPackaged,
      );
      const { html } = rendererAssets;
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
          additionalArguments: ["--goga-interface-language=" + getLocale()],
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          devTools: !app.isPackaged,
        },
      });
      win.once("closed", () => {
        void rendererAssets?.dispose().catch(() => {});
      });
      const refreshMenu = () => Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Goga Desktop",
            submenu: [
              { role: "about", label: t("native.menuAbout") },
              { type: "separator" },
              { role: "hide", label: t("native.menuHide") },
              { role: "hideOthers", label: t("native.menuHideOthers") },
              { role: "unhide", label: t("native.menuUnhide") },
              { type: "separator" },
              { role: "quit", label: t("native.menuQuit") },
            ],
          },
          {
            label: t("native.editMenu"),
            submenu: [
              { role: "undo", label: t("native.menuUndo") },
              { role: "redo", label: t("native.menuRedo") },
              { type: "separator" },
              { role: "cut", label: t("native.menuCut") },
              { role: "copy", label: t("native.menuCopy") },
              { role: "paste", label: t("native.menuPaste") },
              { role: "selectAll", label: t("native.menuSelectAll") },
            ],
          },
          { label: t("native.windowMenu"), submenu: [{ role: "minimize", label: t("native.menuMinimize") }, { role: "front", label: t("native.menuFront") }] },
        ]),
      );
      refreshMenu();
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
      const shellURL = pathToFileURL(html).href;
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
      const withNotificationErrors=(snapshot:NotificationSnapshot):NotificationSnapshot=>({...snapshot,...(!snapshot.error&&(deliveryError||monitorErrors.size)?{error:deliveryError||t("native.notificationsUnavailable")}:{})});
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
          message: t("native.unsavedOverview"),
          detail:
            paths.join("\n") +
            t("native.unsavedOverviewDetail"),
          buttons: [t("native.returnToApp"), t("native.quitWithoutSaving")],
          defaultId: 0,
          cancelId: 0,
        });
        return result.response === 1;
      });
      const topicPopup = new TopicPopup(win, shellURL);
      registerIPC(ipcMain, {
        interfaceLanguage: {
          get: getLocale,
          set: (tag) => {
            const language = languagePreference.write(tag);
            if (language !== getLocale()) {
              setLocale(language);
              refreshMenu();
              send("interface-language-changed", language);
              terminal.setLanguage(language);
            }
            return language;
          },
        },
        topicPopup,
        overviewCloseState: (paths, busy) => overviewExit.update(paths, busy),
        service,
        settings,
        window: win,
        shellURL,
        choose: async () => {
          const result = await dialog.showOpenDialog(win, {
            title: t("native.chooseProject"),
            properties: ["openDirectory"],
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        chooseProjectLocation: async () => {
          const result = await dialog.showOpenDialog(win, {
            title: t("native.chooseProjectLocation"), properties: ["openDirectory"],
          });
          return result.canceled ? null : (result.filePaths[0] ?? null);
        },
        confirmClose: (run) => confirmCloseRun(win, run),
        panels,
        refreshDashboard:async id=>{
          const run=service.runCatalog().find(r=>r.id===id);
          if(!run?.url||run.status!=="running"||run.kind==="build"||run.recovery==="unverified")
            throw Error(t("native.runDashboardUnavailable"));
          const {url,dashboardRunId:pin}=run;
          const verify=async()=>{
            if(pin&&await readDashboardIdentity(url)!==pin)return false;
            const current=service.runCatalog().find(r=>r.id===id);
            return current?.status==="running"&&current.url===url&&current.recovery!=="unverified"&&(!pin||current.dashboardRunId===pin);
          };
          if(!await views.refresh(id,verify))throw Error(t("native.refreshPanelFailed"));
        },
        restoreDashboard: async (id) => {
          const url=await service.prepareDashboardReconnect(id);
          if(!(await views.restore(id,url)))throw Error(t("native.restorePanelFailed"));
        },
        select: (id) => views.select(id),
        viewport: (bounds) => views.setViewport(bounds),
        stop: async (id) => {
          const result = await dialog.showMessageBox(win, {
            type: "warning",
            message: t("native.stopRunQuestion"),
            detail:
              t("native.stopRunDetail"),
            buttons: [t("native.cancel"), t("native.stop")],
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
              const error = t("native.invalidDashboardURL");
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
          { kind: "project-creation", prepare: () => service.prepareProjectCreationShutdown() },
          { kind: "runs", prepare: () => service.prepareShutdown() },
          { kind: "terminals", prepare: () => terminal.sessions.prepareShutdown() },
          { kind: "demonstrations", prepare: () => demonstrations.prepare() },
        ],
        confirm: async (items) => {
          const answer = await dialog.showMessageBox(win, {
            type: "warning",
            message: t("native.quitQuestion"),
            detail:
              items.map((item) => item.label).join("\n") +
              t("native.quitDetail"),
            buttons: [t("native.stay"), t("native.keepRunsAndQuit"), t("native.stopAndQuit")],
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
          await rendererAssets?.dispose().catch(() => {});
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
            message: t("native.quitFailed"),
            detail:
              (result.message ?? t("native.staysOpen")) +
              (result.inventoryComplete === false
                ? t("native.quitNotConfirmed")
                : t("native.processCounts", { completed: result.completed.length, remaining: result.remaining.length }) + (result.retained?.length ? t("native.processRetained", { count: result.retained.length }) : "")),
            buttons: [t("native.close")],
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
    .catch(async (error) => {
      await rendererAssets?.dispose().catch(() => {});
      return handleDesktopStartupFailure(error, {
        confirmRecovery: async () => {
          const answer = await dialog.showMessageBox({
            type: "warning",
            title: "Goga Desktop",
            message: t("native.recoverLockTitle"),
            detail: t("native.recoverLockDetail"),
            buttons: [t("native.close"), t("native.verifyRecover")],
            defaultId: 0,
            cancelId: 0,
          });
          return answer.response === 1;
        },
        showError: (message) => dialog.showErrorBox("Goga Desktop", message),
        relaunch: () => app.relaunch(),
        exit: (code) => app.exit(code),
      });
    });
}
