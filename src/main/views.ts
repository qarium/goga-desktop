import path from "node:path";
import { AFM_EMBEDDED_STYLE } from "./afm-style";
import { WebContentsView, session, dialog, type BrowserWindow } from "electron";
import {
  allowedDashboardURL,
  sameDashboardOrigin,
  viewBounds,
} from "./security";

/** A page is created once per run; hiding a tab never unloads it. Preference-only preload exposes no APIs. */
export class DashboardViews {
  private pages = new Map<
    string,
    {
      view: WebContentsView;
      url: string;
      failed: boolean;
      loaded: boolean;
      cleanup: () => void;
    }
  >();
  private allowed: Set<string> | null = null;
  private closed = new Set<string>();
  private disposed = false;
  private selected: string | null = null;
  constructor(
    private win: BrowserWindow,
    private onFocus: (id: string) => void,
    private onError: (id: string, error: string) => void,
    private onOpened: (id: string, url: string) => boolean = () => true,
  ) {
    win.on("resize", () => this.layout());
  }
  async ensure(id: string, url: string) {
    if (
      this.disposed ||
      this.closed.has(id) ||
      (this.allowed && !this.allowed.has(id))
    )
      return;
    if (!allowedDashboardURL(url))
      throw new Error("Недопустимый адрес панели конвейера");
    if (this.pages.has(id)) return;
    const isolated = session.fromPartition(`afm-${id}`);
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        preload: path.join(__dirname, "afm-preload.cjs"),
        additionalArguments: [`--goga-afm-origin=${new URL(url).origin}`],
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        devTools: false,
        spellcheck: false,
      },
    });
    // Keep backgroundThrottling enabled: disabling it makes document.hidden false in Electron,
    // which suppresses AFM's own notifications. Its 3s polling continues in a hidden view.
    const consentAbort = new AbortController();
    let notificationsAllowed = false;
    const alive = () =>
      !this.disposed &&
      !this.closed.has(id) &&
      this.pages.get(id)?.view === view &&
      !view.webContents.isDestroyed();
    isolated.setPermissionCheckHandler(
      (contents, permission, origin) =>
        (contents === null || contents.id === view.webContents.id) &&
        permission === "notifications" &&
        alive() &&
        notificationsAllowed &&
        sameDashboardOrigin(url, origin),
    );
    isolated.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        if (
          !alive() ||
          contents.id !== view.webContents.id ||
          permission !== "notifications" ||
          !sameDashboardOrigin(url, details.requestingUrl)
        ) {
          callback(false);
          return;
        }
        callback(notificationsAllowed);
      },
    );
    const denyDownload = (event: Electron.Event) => event.preventDefault();
    isolated.on("will-download", denyDownload);
    isolated.webRequest.onBeforeRequest(
      {
        urls: [
          "http://*/*",
          "https://*/*",
          "ws://*/*",
          "wss://*/*",
          "file://*/*",
          "ftp://*/*",
        ],
      },
      (details, callback) =>
        callback({ cancel: !sameDashboardOrigin(url, details.url, true) }),
    );
    const failed = (message: string) => {
      if (!alive()) return;
      const entry = this.pages.get(id);
      if (entry) entry.failed = true;
      view.setVisible(false);
      this.onError(id, message);
    };
    const wc = view.webContents;
    wc.on("dom-ready", () => {
      if (alive() && sameDashboardOrigin(url, wc.getURL())) {
        void wc.insertCSS(AFM_EMBEDDED_STYLE).catch(() => {
          if (alive())
            this.onError(
              id,
              "Не удалось применить оформление встроенной панели конвейера.",
            );
        });
      }
    });
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-navigate", (event, target) => {
      if (!sameDashboardOrigin(url, target)) event.preventDefault();
    });
    wc.on("will-redirect", (event, target) => {
      if (!sameDashboardOrigin(url, target)) event.preventDefault();
    });
    wc.on("will-frame-navigate", (event) => {
      if (!sameDashboardOrigin(url, event.url)) event.preventDefault();
    });
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.on("focus", () => {
      if (!alive()) return;
      if (this.selected !== id) {
        // Let the shell's unsaved-settings guard approve navigation first.
        // select-run IPC reveals the retained view only after that decision.
        this.onFocus(id);
      }
      if (this.win.isMinimized()) this.win.restore();
      this.win.show();
      this.win.focus();
    });
    wc.on("render-process-gone", () =>
      failed("Панель конвейера завершила работу. Процесс Goga не перезапущен."),
    );
    wc.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3)
        failed(
          "Не удалось загрузить панель конвейера. Проверьте состояние процесса.",
        );
    });
    this.pages.set(id, {
      view,
      url,
      failed: false,
      loaded: false,
      cleanup: () => {
        consentAbort.abort();
        notificationsAllowed = false;
        isolated.setPermissionCheckHandler(() => false);
        isolated.setPermissionRequestHandler((_c, _p, cb) => cb(false));
        isolated.webRequest.onBeforeRequest(null);
        isolated.removeListener("will-download", denyDownload);
        void isolated.clearStorageData().catch(() => {});
      },
    });
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.layout();
    try {
      // Electron exposes only granted/denied through its boolean check handler,
      // and notifications checks can have null WebContents. AFM disables its bell
      // on denied, so obtain explicit consent before AFM reads Notification.permission.
      const consent = await dialog.showMessageBox(this.win, {
        type: "question",
        signal: consentAbort.signal,
        title: "Уведомления конвейера",
        message: "Разрешить уведомления для этого запуска?",
        detail:
          "Включение и выключение уведомлений остаётся в панели конвейера. Системная доставка macOS зависит от подписи приложения и настроек уведомлений.",
        buttons: ["Разрешить", "Не разрешать"],
        defaultId: 1,
        cancelId: 1,
      });
      if (!alive()) return;
      notificationsAllowed = consent.response === 0;
      await wc.loadURL(url);
      if (!alive() || this.pages.get(id)?.failed) return;
      if (!sameDashboardOrigin(url, wc.getURL())) {
        failed("Не удалось открыть доверенную страницу Dashboard.");
        return;
      }
      if (!this.onOpened(id, url)) {
        this.remove(id);
        return;
      }
      if (!alive()) return;
      this.pages.get(id)!.loaded = true;
      view.setVisible(this.selected === id);
    } catch {
      failed("Не удалось открыть панель конвейера.");
    }
  }
  select(id: string | null) {
    this.selected = id && this.closed.has(id) ? null : id;
    for (const [key, { view, failed, loaded }] of this.pages)
      view.setVisible(key === id && !failed && loaded);
    this.layout();
  }
  private layout() {
    const [w, h] = this.win.getContentSize();
    for (const { view } of this.pages.values())
      view.setBounds(viewBounds(w, h));
  }
  remove(id: string) {
    this.closed.add(id); // Prevent a stale runs event from recreating this page.
    const entry = this.pages.get(id);
    this.pages.delete(id);
    if (this.selected === id) this.selected = null;
    if (!entry) return;
    entry.view.setVisible(false);
    this.win.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    entry.cleanup();
  }
  reconcile(ids: string[]) {
    const live = new Set(ids);
    this.allowed = live;
    for (const id of this.pages.keys()) if (!live.has(id)) this.remove(id);
  }
  dispose() {
    this.disposed = true;
    for (const id of this.pages.keys()) this.remove(id);
  }
}
