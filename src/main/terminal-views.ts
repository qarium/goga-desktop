import { TerminalAdmissionClosedError } from "../host/terminal-errors";
import {
  WebContentsView,
  dialog,
  shell,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
} from "electron";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { TerminalFlow } from "../host/terminal-flow";
import {
  terminalSessionRefSchema,
  type TerminalSessionRef,
} from "../shared/terminal";
import {
  terminalGrantSchema,
  terminalScreenInputSchema,
  terminalScreenLinkSchema,
  terminalScreenResizeSchema,
  type TerminalGrant,
} from "../shared/terminal-screen";
export interface TerminalViewSource {
  pause(): void;
  resume(): void;
  input(text: string): void;
  resize(cols: number, rows: number): void;
}
interface Entry {
  ref: TerminalSessionRef;
  flow: TerminalFlow;
  source: TerminalViewSource;
  exited: boolean;
  interactive?: boolean;
}
const boundsSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1).max(32768),
    height: z.number().int().min(1).max(32768),
  })
  .strict();
/** Native surface lifetime is independent from the main UI document.
 * No gogaAPI, shared partition, automatic reconnect or old-stream replay.
 * Host lifecycle code must stop/confirm sessions before remove/dispose.
 */
export class TerminalViews {
  private view: WebContentsView;
  private entries = new Map<string, Entry>();
  private retired = new Set<string>();
  private ready = false;
  private selected?: Entry;
  private presentation = 0;
  private linkPending = false;
  private waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private readyTimer?: ReturnType<typeof setTimeout>;
  get isLost(): boolean {
    return this.lost || this.disposed;
  }
  whenReady(): Promise<void> {
    if (this.isLost)
      return Promise.reject(Error("Экран терминала недоступен."));
    if (this.ready) return Promise.resolve();
    if (!this.readyTimer) this.readyTimer = setTimeout(this.lose, 10_000);
    return new Promise((resolve, reject) =>
      this.waiters.add({ resolve, reject }),
    );
  }
  private settleReady(): void {
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    for (const waiter of this.waiters) {
      if (this.isLost) waiter.reject(Error("Экран терминала недоступен."));
      else waiter.resolve();
    }
    this.waiters.clear();
  }
  private lost = false;
  private disposed = false;
  private listeners: [string, (event: IpcMainEvent, value: unknown) => void][] =
    [];
  constructor(
    private win: BrowserWindow,
    private options: {
      url: string;
      preload: string;
      state(ref: TerminalSessionRef, state: "renderer-lost"): void;
      canFocus?: () => boolean;
    },
  ) {
    if (
      new URL(options.url).protocol !== "file:" ||
      !isAbsolute(options.preload)
    )
      throw Error("Недопустимый источник экрана терминала.");
    this.view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        focusOnNavigation: false,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        partition: `terminal-${randomUUID()}`,
        preload: options.preload,
      },
    });
    const wc = this.view.webContents;
    this.view.setVisible(false);
    this.view.setBackgroundColor("#090e1a");
    // Same native layer as dashboards: above the opaque shell, below overlays,
    // including a popup that was already open when this renderer was created.
    const shellIndex =
      win.contentView.children?.findIndex(
        (child) =>
          "webContents" in child && child.webContents === win.webContents,
      ) ?? -1;
    win.contentView.addChildView(this.view, shellIndex + 1);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    wc.session.setPermissionCheckHandler(() => false);
    wc.session.on("will-download", this.preventDownload);
    wc.on("will-navigate", (event) => event.preventDefault());
    wc.on("will-frame-navigate", (event) => event.preventDefault());
    wc.on("will-redirect", (event) => event.preventDefault());
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.on("did-start-navigation", (_e, _url, _inPlace, mainFrame) => {
      if (mainFrame && this.ready) this.lose();
    });
    wc.on("render-process-gone", this.lose);
    wc.on("destroyed", this.lose);
    win.webContents.on("did-start-navigation", this.shellNavigation);
    win.on("closed", this.dispose);
    this.listen("ready", () => {
      this.ready = true;
      this.settleReady();
    });
    this.listen("input", (_event, raw) => {
      const parsed = terminalScreenInputSchema.safeParse(raw);
      if (!parsed.success) return;
      const entry = this.authorized(parsed.data);
      if (entry && !entry.exited && entry.interactive !== false) {
        try {
          entry.source.input(parsed.data.text);
        } catch (error) {
          if (!(error instanceof TerminalAdmissionClosedError))
            entry.flow.rendererLost();
        }
      }
    });
    this.listen("resize", (_event, raw) => {
      const parsed = terminalScreenResizeSchema.safeParse(raw);
      if (!parsed.success) return;
      const entry = this.authorized(parsed.data);
      if (entry && !entry.exited && entry.interactive !== false) {
        try {
          entry.source.resize(parsed.data.cols, parsed.data.rows);
        } catch {
          entry.flow.rendererLost();
        }
      }
    });
    this.listen("link", (_event, raw) => {
      void this.openLink(raw);
    });
    this.listen("ack", (_event, raw) => {
      // The flow validates the full strict schema, sequence and capability.
      const ref = this.readRef(raw);
      if (ref) this.entries.get(ref.sessionId)?.flow.ack(raw);
    });
    this.listen("fault", (_event, raw) => {
      const parsed = terminalGrantSchema.safeParse(raw);
      if (parsed.success) this.authorized(parsed.data)?.flow.rendererLost();
    });
    void wc.loadURL(options.url).catch(this.lose);
  }
  private async openLink(raw: unknown): Promise<void> {
    const parsed = terminalScreenLinkSchema.safeParse(raw);
    if (!parsed.success || this.linkPending || this.win.isDestroyed()) return;
    const entry = this.authorized(parsed.data),
      presentation = this.presentation;
    if (
      !entry ||
      entry !== this.selected ||
      entry.exited ||
      entry.interactive === false
    )
      return;
    this.linkPending = true;
    try {
      const { response } = await dialog.showMessageBox(this.win, {
        type: "question",
        message: "Открыть ссылку в браузере?",
        detail: parsed.data.url,
        buttons: ["Отмена", "Открыть"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (
        response !== 1 ||
        this.isLost ||
        this.win.isDestroyed() ||
        presentation !== this.presentation ||
        entry !== this.selected ||
        entry.exited ||
        this.authorized(parsed.data)?.interactive === false ||
        this.authorized(parsed.data) !== entry
      )
        return;
      try {
        await shell.openExternal(parsed.data.url);
      } catch {
        if (!this.win.isDestroyed())
          await dialog.showMessageBox(this.win, {
            type: "error",
            message: "Не удалось открыть ссылку в браузере.",
            buttons: ["Закрыть"],
            noLink: true,
          });
      }
    } catch {
      /* Window may have closed; never open without confirmation. */
    } finally {
      this.linkPending = false;
    }
  }
  private listen(
    name: string,
    handler: (event: IpcMainEvent, value: unknown) => void,
  ) {
    const channel = `terminal-screen:${name}`;
    const listener = (event: IpcMainEvent, value: unknown) => {
      if (this.valid(event)) handler(event, value);
    };
    this.listeners.push([channel, listener]);
    ipcMain.on(channel, listener);
  }
  private valid(event: IpcMainEvent): boolean {
    const wc = this.view.webContents;
    return (
      !this.disposed &&
      !this.lost &&
      !wc.isDestroyed() &&
      event.sender === wc &&
      event.senderFrame === wc.mainFrame &&
      event.senderFrame?.url === this.options.url &&
      wc.getURL() === this.options.url
    );
  }
  private readRef(raw: unknown): TerminalSessionRef | undefined {
    if (!raw || typeof raw !== "object") return;
    const value = raw as Record<string, unknown>;
    const parsed = terminalSessionRefSchema.safeParse({
      sessionId: value.sessionId,
      generation: value.generation,
    });
    return parsed.success ? parsed.data : undefined;
  }
  private authorized(grant: TerminalGrant): Entry | undefined {
    const entry = this.entries.get(grant.sessionId);
    return entry?.flow.accepts({
      sessionId: grant.sessionId,
      generation: grant.generation,
      capability: grant.capability,
    })
      ? entry
      : undefined;
  }
  private key(ref: TerminalSessionRef) {
    return JSON.stringify([ref.sessionId, ref.generation]);
  }
  private entry(ref: TerminalSessionRef): Entry {
    const entry = this.entries.get(ref.sessionId);
    if (!entry || entry.ref.generation !== ref.generation)
      throw Error("Сессия терминала отсутствует или устарела.");
    return entry;
  }
  attach(
    rawRef: TerminalSessionRef,
    source: TerminalViewSource,
  ): TerminalGrant {
    const ref = terminalSessionRefSchema.parse(rawRef);
    if (
      !this.ready ||
      this.lost ||
      this.disposed ||
      this.retired.has(this.key(ref))
    )
      throw Error("Экран терминала недоступен; требуется новая сессия.");
    if (this.entries.has(ref.sessionId))
      throw Error("Экран сессии уже существует.");
    const flow = new TerminalFlow(ref, {
      send: (frame) =>
        this.view.webContents.send("terminal-screen:frame", frame),
      pause: () => source.pause(),
      resume: () => source.resume(),
      lost: () => {
        if (!this.lost && !this.disposed)
          this.command({ kind: "lost", grant: flow.grant });
        this.options.state({ ...ref }, "renderer-lost");
      },
    });
    this.entries.set(ref.sessionId, { ref, source, flow, exited: false });
    try {
      this.command({ kind: "grant", grant: flow.grant });
    } catch {
      flow.rendererLost();
    }
    return flow.grant;
  }
  output(ref: TerminalSessionRef, text: string): boolean {
    const entry = this.entries.get(ref.sessionId);
    if (!entry || entry.ref.generation !== ref.generation || this.disposed)
      return false;
    return entry.flow.offer(text);
  }
  fail(ref: TerminalSessionRef): void {
    this.entry(ref).flow.rendererLost();
  }
  status(ref: TerminalSessionRef) {
    return this.entry(ref).flow.snapshot();
  }
  exited(ref: TerminalSessionRef): void {
    if (this.disposed) return;
    const entry = this.entry(ref);
    entry.exited = true;
    if (!this.lost) this.command({ kind: "exited", grant: entry.flow.grant });
  }
  show(
    ref: TerminalSessionRef,
    rawBounds: { x: number; y: number; width: number; height: number },
    interactive = true,
  ): void {
    let entry: Entry, bounds: ReturnType<typeof boundsSchema.parse>;
    try {
      entry = this.entry(ref);
      bounds = boundsSchema.parse(rawBounds);
      if (this.lost || this.disposed) throw Error("Экран терминала утрачен.");
    } catch (error) {
      this.hide();
      throw error;
    }
    const changed = this.selected !== entry;
    const inputChanged = (entry.interactive !== false) !== interactive;
    entry.interactive = interactive;
    // Switching live screens is one select command, never a blank hide/select pair.
    const [width, height] = this.win.getContentSize();
    const x = Math.min(bounds.x, Math.max(0, width - 1)),
      y = Math.min(bounds.y, Math.max(0, height - 1));
    this.view.setBounds({
      x,
      y,
      width: Math.min(bounds.width, Math.max(1, width - x)),
      height: Math.min(bounds.height, Math.max(1, height - y)),
    });
    this.selected = entry;
    this.view.setVisible(true);
    if (changed || inputChanged) {
      const focus = interactive && (this.options.canFocus?.() ?? true);
      this.command({
        kind: "select",
        grant: entry.flow.grant,
        focus,
        ...(!interactive || inputChanged ? { interactive } : {}),
      });
      if (focus) this.view.webContents.focus();
    }
  }
  hide(): void {
    this.selected = undefined;
    this.presentation++;
    if (this.disposed) return;
    this.view.setVisible(false);
    if (this.ready && !this.lost) this.command({ kind: "select", grant: null });
  }
  remove(ref: TerminalSessionRef): void {
    if (this.disposed) return;
    const entry = this.entry(ref);
    this.entries.delete(ref.sessionId);
    this.retired.add(this.key(ref));
    entry.flow.dispose();
    if (this.ready && !this.lost)
      this.command({ kind: "remove", grant: entry.flow.grant });
  }
  private command(value: unknown) {
    try {
      this.view.webContents.send("terminal-screen:command", value);
    } catch {
      this.lose();
    }
  }
  private shellNavigation = (
    _event: unknown,
    _url: string,
    _inPlace: boolean,
    mainFrame: boolean,
  ) => {
    if (mainFrame) this.hide();
  };
  private preventDownload = (event: Electron.Event) => event.preventDefault();
  private lose = () => {
    if (this.lost || this.disposed) return;
    this.lost = true;
    this.settleReady();
    for (const entry of this.entries.values()) entry.flow.rendererLost();
  };
  dispose = () => {
    if (this.disposed) return;
    this.lose();
    this.disposed = true;
    this.win.webContents.removeListener(
      "did-start-navigation",
      this.shellNavigation,
    );
    this.win.removeListener("closed", this.dispose);
    for (const [channel, listener] of this.listeners.splice(0))
      ipcMain.removeListener(channel, listener);
    for (const entry of this.entries.values()) entry.flow.dispose();
    this.entries.clear();
    this.view.webContents.session.removeListener(
      "will-download",
      this.preventDownload,
    );
    if (!this.win.isDestroyed())
      this.win.contentView.removeChildView(this.view);
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
  };
}
