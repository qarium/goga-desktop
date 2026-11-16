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

type DashboardPage = {
  view: WebContentsView;
  url: string;
  failed: boolean;
  loaded: boolean;
  loading: Promise<void>;
  external: boolean;
  refresh?: Promise<boolean>;
  cancelNavigation?: () => void;
  cleanup: () => Promise<void>;
};

const isAttached = (id: string) => id.startsWith("attached:");

/** Initial observer loads and in-place reloads share a deadline tied to this page generation. */
function navigateDocument(page: DashboardPage, url?: string): Promise<boolean> {
  const wc = page.view.webContents;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.removeListener("did-finish-load", loaded);
      wc.removeListener("did-fail-provisional-load", failed);
      wc.removeListener("destroyed", cancelled);
      page.cancelNavigation = undefined;
      resolve(ok);
    };
    const loaded = () => finish(true);
    const cancelled = () => finish(false);
    const failed = (_event: Electron.Event, _code: number, _reason: string, _url: string, main: boolean) => {
      if (main) cancelled();
    };
    const timer = setTimeout(() => {
      cancelled();
      if (!wc.isDestroyed()) wc.stop();
    }, 10000);
    page.cancelNavigation = cancelled;
    if (!url) wc.once("did-finish-load", loaded);
    wc.on("did-fail-provisional-load", failed);
    wc.once("destroyed", cancelled);
    try {
      if (url) void wc.loadURL(url).then(loaded, cancelled);
      else wc.reload();
    } catch { cancelled(); }
  });
}

/** Healthy pages are retained per run; explicit restoration replaces only failed pages. */
export class DashboardViews {
  private pages = new Map<string, DashboardPage>();
  private restoring = new Map<string, Promise<boolean>>();
  private cleanups = new Map<string, Promise<void>>();
  private allowed: Set<string> | null = null;
  private closed = new Set<string>();
  private disposed = false;
  private selected: string | null = null;
  private selectionRevision = 0;
  private viewport: DashboardViewport | null = null;
  private stageCancels=new Map<string,()=>void>();
  constructor(
    private win: BrowserWindow,
    private onFocus: (id: string) => void,
    private onError: (id: string, error: string) => void,
    private onOpened: (id: string, url: string) => boolean | Promise<boolean> =
      (id) => !isAttached(id),
    private onRefreshShortcut?: (id: string) => void,
  ) {
    win.on("resize", () => this.layout());
  }
  async ensure(id: string, url: string) {
    if (
      this.disposed ||
      this.closed.has(id) ||
      (isAttached(id) && !this.allowed?.has(id)) ||
      (this.allowed && !this.allowed.has(id))
    )
      return;
    if (!allowedDashboardURL(url))
      throw new Error("Недопустимый адрес панели конвейера");
    const restoring = this.restoring.get(id);
    if (restoring) {
      await restoring;
      return;
    }
    // A failed partition cleanup must not be bypassed by a later runs event.
    if (this.cleanups.has(id)) return;
    await this.createPage(id, url);
  }
  restore(id: string, url: string): Promise<boolean> {
    if (!this.canRestore(id)) return Promise.resolve(false);
    if (!allowedDashboardURL(url))
      return Promise.reject(new Error("Недопустимый адрес панели конвейера"));
    const pending = this.restoring.get(id);
    if (pending) return pending;
    // Install the flight before any cleanup can yield or another ensure can run.
    const restoring = Promise.resolve().then(() => this.restorePage(id, url));
    this.restoring.set(id, restoring);
    const finished = () => {
      if (this.restoring.get(id) === restoring) this.restoring.delete(id);
    };
    void restoring.then(finished, finished);
    return restoring;
  }
  private canRestore(id: string) {
    return (
      !this.disposed && !this.closed.has(id) && this.allowed?.has(id) === true
    );
  }
  private async restorePage(id: string, url: string): Promise<boolean> {
    if (!this.canRestore(id)) return false;
    const previous = this.pages.get(id);
    if (
      previous && !previous.failed && !previous.view.webContents.isDestroyed()
    ) {
      await previous.loading;
      if (previous.refresh) await previous.refresh;
      if (!this.canRestore(id) || this.pages.get(id) !== previous) return false;
      if (
        previous.loaded && !previous.failed &&
        !previous.view.webContents.isDestroyed()
      ) return true;
    }
    try {
      // This is not a user close: retain selection and never add a closed tombstone.
      // Partition handlers and storage belong to the old generation until cleanup settles.
      await this.detach(id);
      if (!this.canRestore(id)) return false;
      await this.createPage(id, url);
      const current = this.pages.get(id);
      return (
        this.canRestore(id) && !!current?.loaded && !current.failed &&
        !current.view.webContents.isDestroyed()
      );
    } catch {
      return false;
    }
  }
  private createPage(id: string, url: string): Promise<void> {
    if (this.pages.has(id)) return this.pages.get(id)!.loading;
    const external = isAttached(id);
    // A detached observer has no shared partition, preload or stage-control channel.
    const isolated = session.fromPartition(external ? `observer-${randomUUID()}` : `afm-${id}`);
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        ...(external ? { disableDialogs: true, navigateOnDragDrop: false } : {
          preload: path.join(__dirname, "afm-preload.cjs"),
          additionalArguments: [`--goga-afm-origin=${new URL(url).origin}`],
        }),
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
    if (external) {
      isolated.setDevicePermissionHandler(() => false);
      view.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      isolated.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...details.responseHeaders };
        // These document/worker boundaries also cover speculative connections
        // and WebRTC, which do not all surface as ordinary HTTP webRequests.
        for (const name of Object.keys(headers)) {
          if (name.toLowerCase() === "connection-allowlist") delete headers[name];
        }
        headers["Connection-Allowlist"] = ["(response-origin)"];
        const csp = Object.keys(headers).find(k=>k.toLowerCase()==="content-security-policy") ?? "Content-Security-Policy";
        headers[csp] = [...headers[csp] ?? [], "worker-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'"];
        callback({ responseHeaders: headers });
      });
    }
    const denyDownload = (event: Electron.Event) => event.preventDefault();
    isolated.on("will-download", denyDownload);
    isolated.webRequest.onBeforeRequest(
      {
        urls: external ? ["<all_urls>"] : [
          "http://*/*",
          "https://*/*",
          "ws://*/*",
          "wss://*/*",
          "file://*/*",
          "ftp://*/*",
        ],
      },
      (details, callback) => {
        const read = details.method === "GET" || details.method === "HEAD";
        callback({ cancel: !sameDashboardOrigin(url, details.url, !external) ||
          (external && (!read || !alive() || this.pages.get(id)?.failed === true)) });
      },
    );
    const failed = (message: string) => {
      if (!alive()) return;
      this.failPage(id, entry, message);
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
    wc.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.alt) return;
      const f5 = input.key === "F5";
      const modR = input.key.toLowerCase() === "r" && (!!input.meta !== !!input.control);
      if (!f5 && !modR) return;
      event.preventDefault();
      if (!input.isAutoRepeat && alive() && this.isSelected(id))
        this.onRefreshShortcut?.(id);
    });
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
    wc.on("did-fail-load", (_event, code, _description, target, isMainFrame) => {
      // A policy-blocked navigation never replaced the current trusted document.
      if (isMainFrame && code !== -3 && alive() &&
          !(code === -20 && entry.loaded && !sameDashboardOrigin(url, target) && sameDashboardOrigin(url, wc.getURL())))
        failed(
          "Не удалось загрузить панель конвейера. Проверьте состояние процесса.",
        );
    });
    const entry: DashboardPage = {
      view,
      url,
      external,
      failed: false,
      loaded: false,
      loading: Promise.resolve(),
      cleanup: async () => {
        isolated.setPermissionCheckHandler(() => false);
        isolated.setPermissionRequestHandler((_c, _p, cb) => cb(false));
        // Observer partitions are never reused. Deny previous documents' last
        // requests even while Chromium asynchronously clears their storage.
        if (external)
          isolated.webRequest.onBeforeRequest((_details, cb) => cb({cancel: true}));
        else {
          isolated.webRequest.onBeforeRequest(null);
          isolated.removeListener("will-download", denyDownload);
        }
        await isolated.clearStorageData();
      },
    };
    this.pages.set(id, entry);
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
    entry.loading = (async () => {
      try {
        // System consent is a single Desktop preference, never a load prerequisite.
        if (external) {
          if (!(await navigateDocument(entry, url))) {
            failed("Не удалось открыть подключённую панель конвейера.");
            return;
          }
        } else await wc.loadURL(url);
        if (!alive() || entry.failed) return;
        if (!sameDashboardOrigin(url, wc.getURL())) {
          failed("Не удалось открыть доверенную страницу Dashboard.");
          return;
        }
        const opened = await this.onOpened(id, url);
        // The acknowledgement can outlive a failed/replaced/closed page. In
        // particular, its false result must never remove a newer generation.
        if (!alive() || entry.failed) return;
        if (!opened) {
          // An acknowledgement refusal rejects this attempt, not the live run.
          // Only an authoritative remove/reconcile may leave a closed tombstone.
          await this.detach(id);
          return;
        }
        if (!sameDashboardOrigin(url, wc.getURL())) {
          failed("Адрес панели изменился во время подключения.");
          return;
        }
        entry.loaded = true;
        view.setVisible(this.selected === id);
      } catch {
        failed("Не удалось открыть панель конвейера.");
      }
    })();
    return entry.loading;
  }

  select(id: string | null) {
    if(this.selected!==id) {
      this.selectionRevision++;
      this.cancelStageNavigation();
    }
    this.selected = id && this.closed.has(id) ? null : id;
    for (const [key, page] of this.pages)
      page.view.setVisible(this.isSelected(key));
    this.layout();
  }
  isSelected(id: string) {
    const entry = this.pages.get(id);
    return !this.disposed && this.selected === id && !!entry?.loaded && !entry.failed &&
      !entry.view.webContents.isDestroyed() && !entry.refresh;
  }
  isTarget(id: string) {
    return !this.disposed && !this.closed.has(id) && this.selected === id;
  }
  needsRestore(id: string) {
    const entry = this.pages.get(id);
    return !entry || entry.failed || entry.view.webContents.isDestroyed();
  }
  private failPage(id: string, page: DashboardPage, message: string) {
    if (this.pages.get(id) !== page || this.disposed || page.failed) return;
    page.failed = true;
    page.cancelNavigation?.();
    page.view.setVisible(false);
    this.onError(id, message);
  }
  refresh(id: string, validate?: () => Promise<boolean>): Promise<boolean> {
    const page = this.pages.get(id);
    if (!page || !page.loaded || page.failed || this.disposed || this.selected !== id ||
        page.view.webContents.isDestroyed()) return Promise.resolve(false);
    if (page.refresh) return page.refresh;
    const revision = this.selectionRevision, wc = page.view.webContents;
    const current = () => this.pages.get(id) === page && !this.disposed &&
      !page.failed && !wc.isDestroyed();
    const selected = () => this.selectionRevision === revision && this.selected === id;
    const trusted = () => sameDashboardOrigin(page.url, wc.getURL());
    const reload = async () => {
      if (!current() || !selected()) return false;
      try {
        if (!trusted() || (page.external && !validate) || (validate && !(await validate())))
          throw Error();
        if (!current() || !selected() || wc.isLoadingMainFrame()) return false;
        if (!trusted()) throw Error();
        this.stageCancels.get(id)?.();
        if (!(await navigateDocument(page))) throw Error();
        if (!current()) return false;
        if (validate) {
          if (!trusted() || !(await validate())) throw Error();
          if (!current()) return false;
        }
        if (!trusted()) throw Error();
        return current() && selected();
      } catch {
        if (current()) this.failPage(id, page, "Не удалось подтвердить и обновить страницу панели. Процесс не перезапускался.");
        return false;
      }
    };
    page.view.setVisible(false);
    // Install before validation, navigation or a repeated keyboard/IPC request.
    const flight = Promise.resolve().then(reload).finally(() => {
      if (page.refresh !== flight) return;
      page.refresh = undefined;
      if (current()) page.view.setVisible(this.selected === id);
    });
    page.refresh = flight;
    return flight;
  }
  cancelStageNavigation(){for(const cancel of [...this.stageCancels.values()])cancel();}
  focusStage(id:string,stageId:string):Promise<boolean>{
    this.cancelStageNavigation();
    const entry=this.pages.get(id);
    if(!entry||entry.external||!this.isSelected(id)||entry.view.webContents.isDestroyed())return Promise.resolve(false);
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
  private detach(id: string): Promise<void> {
    const entry = this.pages.get(id);
    this.pages.delete(id); // Invalidate old load, focus, error and acknowledgement callbacks first.
    this.stageCancels.get(id)?.();
    if (!entry) return this.cleanups.get(id) ?? Promise.resolve();
    entry.cancelNavigation?.();
    entry.view.setVisible(false);
    this.win.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    const cleanup = entry.cleanup();
    this.cleanups.set(id, cleanup);
    // Keep a rejected cleanup as a fail-closed barrier for the same partition.
    void cleanup.then(
      () => {
        if (this.cleanups.get(id) === cleanup) this.cleanups.delete(id);
      },
      () => {},
    );
    return cleanup;
  }
  remove(id: string) {
    this.closed.add(id); // Prevent a stale runs event from recreating this page.
    if (this.selected === id) this.selected = null;
    void this.detach(id).catch(() => {});
  }
  reconcile(ids: string[]) {
    const live = new Set(ids);
    this.allowed = live;
    for (const id of new Set([...this.pages.keys(), ...this.restoring.keys()]))
      if (!live.has(id)) this.remove(id);
  }
  dispose() {
    this.disposed = true;
    for (const id of this.pages.keys()) this.remove(id);
  }
}
