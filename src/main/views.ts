import {
  dashboardViewportSchema,
  type DashboardViewport,
} from "../shared/dashboard-viewport";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AFM_EMBEDDED_STYLE } from "./afm-style";
import { WebContentsView, session, ipcMain, type BrowserWindow, type IpcMainEvent } from "electron";
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
  private viewport: DashboardViewport | null = null;
  private stageCancels=new Map<string,()=>void>();
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
    // Stage observation and notifications live in Desktop main; this embedded
    // page stays unprivileged and never sends duplicate browser notifications.
    const alive = () =>
      !this.disposed &&
      !this.closed.has(id) &&
      this.pages.get(id)?.view === view &&
      !view.webContents.isDestroyed();
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
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
        isolated.setPermissionCheckHandler(() => false);
        isolated.setPermissionRequestHandler((_c, _p, cb) => cb(false));
        isolated.webRequest.onBeforeRequest(null);
        isolated.removeListener("will-download", denyDownload);
        void isolated.clearStorageData().catch(() => {});
      },
    });
    // BrowserWindow's own shell is a native child too. Dashboards must stay
    // above that opaque surface, but below any already-mounted topic overlay.
    const shellIndex =
      this.win.contentView.children?.findIndex(
        (child) =>
          "webContents" in child && child.webContents === this.win.webContents,
      ) ?? -1;
    this.win.contentView.addChildView(view, shellIndex + 1);
    view.setVisible(false);
    this.layout();
    try {
      // System consent is a single Desktop preference, never a load prerequisite.
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
    if(this.selected!==id)this.cancelStageNavigation();
    this.selected = id && this.closed.has(id) ? null : id;
    for (const [key, { view, failed, loaded }] of this.pages)
      view.setVisible(key === id && !failed && loaded);
    this.layout();
  }
  isSelected(id:string){const entry=this.pages.get(id);return !this.disposed&&this.selected===id&&!!entry?.loaded&&!entry.failed;}
  cancelStageNavigation(){for(const cancel of [...this.stageCancels.values()])cancel();}
  focusStage(id:string,stageId:string):Promise<boolean>{
    this.cancelStageNavigation();
    const entry=this.pages.get(id);
    if(!entry||!this.isSelected(id)||entry.view.webContents.isDestroyed())return Promise.resolve(false);
    const wc=entry.view.webContents,requestId=randomUUID();
    return new Promise(resolve=>{
      let finished=false;
      const finish=(value:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);ipcMain.removeListener("goga:afm-stage-selected",ack);this.stageCancels.delete(id);resolve(value);};
      const cancel=()=>{try{wc.send("goga:afm-cancel-stage",requestId);}catch{}finish(false);};
      const ack=(event:IpcMainEvent,value:unknown)=>{
        if(event.sender.id!==wc.id||event.senderFrame!==wc.mainFrame||!sameDashboardOrigin(entry.url,event.senderFrame?.url??"")||!value||typeof value!=="object")return;
        const result=value as {requestId?:unknown;stageId?:unknown;selected?:unknown};
        if(result.requestId!==requestId||result.stageId!==stageId)return;
        finish(result.selected===true&&this.isSelected(id)&&sameDashboardOrigin(entry.url,wc.getURL()));
      };
      const timer=setTimeout(()=>finish(false),3000);
      this.stageCancels.set(id,cancel);
      ipcMain.on("goga:afm-stage-selected",ack);
      try{wc.send("goga:afm-select-stage",{requestId,stageId});}catch{finish(false);}
    });
  }
  setViewport(bounds: DashboardViewport) {
    this.viewport = dashboardViewportSchema.parse(bounds);
    this.layout();
  }
  private layout() {
    const [w, h] = this.win.getContentSize();
    const bounds = this.viewport ?? viewBounds(w, h);
    const x = Math.min(bounds.x, w),
      y = Math.min(bounds.y, h);
    for (const { view } of this.pages.values())
      view.setBounds({
        x,
        y,
        width: Math.min(bounds.width, Math.max(0, w - x)),
        height: Math.min(bounds.height, Math.max(0, h - y)),
      });
  }
  remove(id: string) {
    this.stageCancels.get(id)?.();
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
