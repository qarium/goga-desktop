import { WebContentsView, type BrowserWindow } from "electron";
import {
  TOPIC_POPUP_FRAME_PREFIX,
  topicPopupBoundsSchema,
  topicPopupIdSchema,
  type TopicPopupBounds,
} from "../shared/topic-popup";

/** The shell owns the portal; this view supplies only its native stacking surface.
 * about:blank inherits its opener's security context. IPC still trusts ONLY the
 * shell webContents/main frame, never this child (including inherited preload).
 */
export class TopicPopup {
  private current: {
    id: string;
    view: WebContentsView;
    shown: boolean;
    detach: () => void;
  } | null = null;
  private disposed = false;
  private closeCurrent = () => {
    if (this.current) this.close(this.current.id);
  };
  private onNavigation = (
    _event: Electron.Event,
    _url: string,
    _inPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) this.closeCurrent();
  };
  private onParentClosed = () => this.dispose();

  constructor(
    private win: BrowserWindow,
    private shellURL: string,
  ) {
    win.on("resize", this.closeCurrent);
    win.on("blur", this.closeCurrent);
    win.on("close", this.closeCurrent);
    win.on("closed", this.onParentClosed);
    win.webContents.on("did-start-navigation", this.onNavigation);
    win.webContents.setWindowOpenHandler(({ url, frameName, disposition }) => {
      const id = frameName.startsWith(TOPIC_POPUP_FRAME_PREFIX)
        ? frameName.slice(TOPIC_POPUP_FRAME_PREFIX.length)
        : "";
      if (
        this.disposed ||
        this.current ||
        win.isDestroyed() ||
        win.webContents.getURL() !== shellURL ||
        url !== "about:blank" ||
        disposition !== "new-window" ||
        !topicPopupIdSchema.safeParse(id).success
      )
        return { action: "deny" };
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
          },
        },
        createWindow: (options) => {
          // Preserve options.webContents: allocating another WebContents breaks
          // the same-origin DOM/opener relationship needed by the React portal.
          const view = new WebContentsView(options);
          const wc = view.webContents;
          // Electron emits close for an adopted window.open WebContents, though
          // its generated WebContents overloads omit that lifecycle event.
          const events: NodeJS.EventEmitter = wc;
          view.setVisible(false);
          view.setBackgroundColor("#00000000");
          const requested = topicPopupBoundsSchema.safeParse({
            x: options.x,
            y: options.y,
            width: options.width,
            height: options.height,
          });
          view.setBounds(
            this.clamp(
              requested.success
                ? requested.data
                : {
                    x: 0,
                    y: 0,
                    width: 436,
                    height: 400,
                  },
            ),
          );
          const prevent = (event: Electron.Event) => event.preventDefault();
          const close = () => this.close(id);
          // Adopting an initially hidden window.open view may emit blur before
          // the shell has measured/mounted its portal. That is not dismissal.
          const blur = () => {
            if (this.current?.id === id && this.current.shown) this.close(id);
          };
          const destroyed = () => this.cleanup(id, true);
          const blocked = [
            "will-navigate",
            "will-redirect",
            "will-frame-navigate",
            "will-attach-webview",
          ] as const;
          wc.setWindowOpenHandler(() => ({ action: "deny" }));
          for (const name of blocked) events.on(name, prevent);
          events.on("close", close);
          wc.on("blur", blur);
          wc.on("render-process-gone", close);
          wc.on("destroyed", destroyed);
          this.current = {
            id,
            view,
            shown: false,
            detach: () => {
              for (const name of blocked) events.removeListener(name, prevent);
              events.removeListener("close", close);
              wc.removeListener("blur", blur);
              wc.removeListener("render-process-gone", close);
              wc.removeListener("destroyed", destroyed);
            },
          };
          // Native child order, not CSS z-index, puts the menu over Dashboard.
          win.contentView.addChildView(view);
          return wc;
        },
      };
    });
  }

  private clamp(bounds: TopicPopupBounds): TopicPopupBounds {
    const [width, height] = this.win.getContentSize();
    const x = Math.min(bounds.x, Math.max(0, width - 1));
    const y = Math.min(bounds.y, Math.max(0, height - 1));
    return {
      x,
      y,
      width: Math.min(bounds.width, Math.max(1, width - x)),
      height: Math.min(bounds.height, Math.max(1, height - y)),
    };
  }

  setBounds(id: string, rawBounds: TopicPopupBounds) {
    const entry = this.current;
    if (!entry || entry.id !== id || this.disposed) return;
    const bounds = topicPopupBoundsSchema.parse(rawBounds);
    entry.view.setBounds(this.clamp(bounds));
    if (!entry.shown) {
      entry.shown = true;
      entry.view.setVisible(true);
      entry.view.webContents.focus();
    }
  }

  close(id: string) {
    this.cleanup(id, false);
  }

  private cleanup(id: string, destroyed: boolean) {
    const entry = this.current;
    if (!entry || entry.id !== id) return;
    this.current = null; // Reentrant close/destroyed can never close a newer menu.
    entry.detach();
    entry.view.setVisible(false);
    this.win.contentView.removeChildView(entry.view);
    if (!destroyed && !entry.view.webContents.isDestroyed())
      entry.view.webContents.close();
    if (!this.win.isDestroyed() && !this.win.webContents.isDestroyed())
      this.win.webContents.send("goga:topic-popup-closed", id);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.closeCurrent();
    this.win.removeListener("resize", this.closeCurrent);
    this.win.removeListener("blur", this.closeCurrent);
    this.win.removeListener("close", this.closeCurrent);
    this.win.removeListener("closed", this.onParentClosed);
    this.win.webContents.removeListener(
      "did-start-navigation",
      this.onNavigation,
    );
  }
}
