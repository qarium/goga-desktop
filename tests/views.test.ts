import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
const fake = vi.hoisted(() => ({
  created: [] as any[],
  sessions: [] as any[],
}));
vi.mock("electron", () => ({
  WebContentsView: class extends EventEmitter {
    visible = false;
    bounds = {};
    webContents: any;
    constructor(public options: any) {
      super();
      this.webContents = Object.assign(new EventEmitter(), {
        id: fake.created.length + 10,
        loadURL: vi.fn(async (url: string) => {
          this.webContents.url = url;
        }),
        url: "",
        getURL: () => this.webContents.url,
        insertCSS: vi.fn(async () => "style-key"),
        setWindowOpenHandler: vi.fn(),
        close: vi.fn(),
        isDestroyed: () => false,
        focus: vi.fn(),
      });
      fake.created.push(this);
    }
    setVisible(v: boolean) {
      this.visible = v;
    }
    setBounds(v: any) {
      this.bounds = v;
    }
  },
  session: {
    fromPartition: vi.fn(() => {
      const s = Object.assign(new EventEmitter(), {
        setPermissionCheckHandler: vi.fn(),
        clearStorageData: vi.fn(async () => {}),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      });
      fake.sessions.push(s);
      return s;
    }),
  },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
}));
import { dialog } from "electron";
import { DashboardViews } from "../src/main/views";
describe("independent AFM views", () => {
  beforeEach(() => {
    fake.created.length = 0;
    fake.sessions.length = 0;
  });
  function fixture() {
    const win = Object.assign(new EventEmitter(), {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      getContentSize: () => [1280, 900],
      show: vi.fn(),
      focus: vi.fn(),
      isMinimized: () => false,
      restore: vi.fn(),
    });
    const focus = vi.fn(),
      error = vi.fn(),
      opened = vi.fn(() => true);
    return {
      views: new DashboardViews(win as any, focus, error, opened),
      win,
      focus,
      error,
      opened,
    };
  }
  it("inserts new dashboards below any existing native overlay", async () => {
    const { views, win } = fixture();
    const overlay = { kind: "topic-popup" };
    const children: any[] = [overlay];
    win.contentView.addChildView.mockImplementation((view: any, index?: number) => {
      children.splice(index ?? children.length, 0, view);
    });
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    expect(children.at(-1)).toBe(overlay);
    expect(children).toEqual([fake.created[1], fake.created[0], overlay]);
  });
  it("inserts a dashboard above the native shell but below existing dashboards and overlay", async () => {
    const { views, win } = fixture();
    const shellContents = { id: 1 };
    const shellView = { webContents: shellContents };
    const oldDashboard = { kind: "retained-dashboard" };
    const overlay = { kind: "topic-popup" };
    const children: any[] = [shellView, oldDashboard, overlay];
    Object.assign(win, { webContents: shellContents });
    Object.assign(win.contentView, { children });
    win.contentView.addChildView.mockImplementation((view: any, index?: number) => {
      children.splice(index ?? children.length, 0, view);
    });
    await views.ensure("a", "http://localhost:4101");
    expect(children).toEqual([shellView, fake.created[0], oldDashboard, overlay]);
  });
  it("loads once per run and switching preserves independent page state", async () => {
    const { views } = fixture();
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    views.select("a");
    views.select("b");
    views.select("a");
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(2);
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(fake.created[0].visible).toBe(true);
    expect(fake.created[1].visible).toBe(false);
    views.select(null);
    expect(fake.created.every((v) => !v.visible)).toBe(true);
  });
  it("never gives AFM privileged preload/Node access and refuses untrusted URL", async () => {
    const { views } = fixture();
    await expect(views.ensure("bad", "https://evil.test")).rejects.toThrow();
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created[0].options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(fake.created[0].options.webPreferences.preload).toMatch(
      /afm-preload\.cjs$/,
    );
    expect(fake.created[0].options.webPreferences.additionalArguments).toEqual([
      "--goga-afm-origin=http://localhost:4101",
    ]);
    const popup =
      fake.created[0].webContents.setWindowOpenHandler.mock.calls[0][0];
    expect(popup({ url: "https://evil.test" })).toEqual({ action: "deny" });
  });
  it("hides failed native views so shell diagnostics stay visible", async () => {
    const { views, error } = fixture();
    await views.ensure("a", "http://localhost:4101");
    views.select("a");
    fake.created[0].webContents.emit("render-process-gone");
    expect(error).toHaveBeenCalled();
    expect(fake.created[0].visible).toBe(false);
    views.select("a");
    expect(fake.created[0].visible).toBe(false);
  });
  it("asks before initial load and permits notification checks with null WebContents only for the approved AFM origin", async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 0,
      checkboxChecked: false,
    });
    const { views } = fixture();
    await views.ensure("a", "http://localhost:4101");
    const check = fake.sessions[0].setPermissionCheckHandler.mock.calls[0][0];
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "Уведомления конвейера",
        detail:
          "Включение и выключение уведомлений остаётся в панели конвейера. Системная доставка macOS зависит от подписи приложения и настроек уведомлений.",
      }),
    );
    expect(check(null, "notifications", "http://localhost:4101")).toBe(true);
    expect(check(null, "notifications", "http://localhost:4102")).toBe(false);
    expect(check(null, "camera", "http://localhost:4101")).toBe(false);
    expect(check({ id: 999 }, "notifications", "http://localhost:4101")).toBe(
      false,
    );
  });
  it("denies before consent, after decline, and after close including requests", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    const { views } = fixture();
    const loading = views.ensure("a", "http://localhost:4101");
    const check = fake.sessions[0].setPermissionCheckHandler.mock.calls[0][0];
    const request =
      fake.sessions[0].setPermissionRequestHandler.mock.calls[0][0];
    expect(check(null, "notifications", "http://localhost:4101")).toBe(false);
    expect(fake.created[0].webContents.loadURL).not.toHaveBeenCalled();
    const options = (
      vi.mocked(dialog.showMessageBox).mock.calls.at(-1) as unknown as [
        unknown,
        unknown,
      ]
    )[1];
    expect(options).toMatchObject({ defaultId: 1, cancelId: 1 });
    resolve({ response: 1 });
    await loading;
    expect(check(null, "notifications", "http://localhost:4101")).toBe(false);
    const callback = vi.fn();
    request({ id: fake.created[0].webContents.id }, "notifications", callback, {
      requestingUrl: "http://localhost:4101",
    });
    expect(callback).toHaveBeenLastCalledWith(false);
    views.remove("a");
    expect(check(null, "notifications", "http://localhost:4101")).toBe(false);
    request({ id: fake.created[0].webContents.id }, "notifications", callback, {
      requestingUrl: "http://localhost:4101",
    });
    expect(callback).toHaveBeenLastCalledWith(false);
  });
  it("reapplies narrow AFM branding and theme selectors on each trusted document", async () => {
    const { views } = fixture();
    await views.ensure("a", "http://localhost:4101");
    const wc = fake.created[0].webContents;
    wc.emit("dom-ready");
    wc.emit("dom-ready");
    expect(wc.insertCSS).toHaveBeenCalledTimes(2);
    const css = wc.insertCSS.mock.calls[0][0];
    expect(css).toContain("#header.global-header > .gh-left > .gh-mark");
    expect(css).toContain("#header.global-header > .gh-left > .gh-wordmark");
    expect(css).toContain("border-left: 0 !important");
    expect(css).toContain(
      '.gh-right.header-actions > .gh-theme-seg[role="group"][aria-label="Theme mode"]',
    );
    expect(css).not.toContain(".gh-right {");
    wc.url = "http://evil.test";
    wc.emit("dom-ready");
    expect(wc.insertCSS).toHaveBeenCalledTimes(2);
  });
  it("routes page focus back to the correct run and closes views explicitly", async () => {
    const { views, focus } = fixture();
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    views.select("b");
    fake.created[0].webContents.emit("focus");
    expect(focus).toHaveBeenCalledWith("a");
    // Renderer must approve navigation before a native view can cover dirty settings.
    expect(fake.created[0].visible).toBe(false);
    expect(fake.created[1].visible).toBe(true);
    views.select("a");
    expect(fake.created[0].visible).toBe(true);
    views.select(null);
    fake.created[0].webContents.emit("focus");
    expect(fake.created[0].visible).toBe(false);
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    views.dispose();
    expect(
      fake.created.every((v) => v.webContents.close.mock.calls.length === 1),
    ).toBe(true);
  });
  it("removes only the chosen view and ignores delayed focus/error/ensure", async () => {
    const { views, focus, error, win } = fixture();
    await views.ensure("a", "http://localhost:4101");
    await views.ensure("b", "http://localhost:4102");
    views.select("b");
    views.remove("a");
    views.remove("a");
    expect(fake.created[0].webContents.close).toHaveBeenCalledTimes(1);
    expect(fake.created[1].webContents.close).not.toHaveBeenCalled();
    expect(fake.created[1].visible).toBe(true);
    fake.created[0].webContents.emit("focus");
    fake.created[0].webContents.emit("render-process-gone");
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(2);
    expect(focus).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
  it("cannot load or resurrect after close while permission/load is pending", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    const { views, error } = fixture();
    const loading = views.ensure("a", "http://localhost:4101");
    views.remove("a");
    resolve({ response: 0 });
    await loading;
    expect(fake.created[0].webContents.loadURL).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    views.dispose();
    await views.ensure("c", "http://localhost:4103");
    expect(fake.created).toHaveLength(1);
  });

  it("rejects stale ensure for a run removed before any page existed", async () => {
    const { views } = fixture();
    views.reconcile(["a"]);
    views.reconcile([]);
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created).toHaveLength(0);
  });
  it("ignores a rejected pending load and late document callbacks after removal", async () => {
    const { views, error, focus } = fixture();
    const loading = views.ensure("a", "http://localhost:4101");
    let reject!: (e: Error) => void;
    fake.created[0].webContents.loadURL.mockImplementationOnce(
      () => new Promise((_r: any, j: any) => (reject = j)),
    );
    await Promise.resolve();
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalled();
    views.remove("a");
    reject(Error("load aborted"));
    await loading;
    fake.created[0].webContents.emit("dom-ready");
    fake.created[0].webContents.emit("focus");
    expect(error).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(fake.sessions[0].clearStorageData).toHaveBeenCalledTimes(1);
  });
  it("acknowledges successful browser load only, keeps loading view hidden and reuses it for journal toggle", async () => {
    const { views, opened } = fixture();
    views.select("a");
    const loading = views.ensure("a", "http://localhost:4101");
    let resolve!: () => void;
    fake.created[0].webContents.loadURL.mockImplementationOnce(
      () => new Promise<void>((r) => (resolve = r)),
    );
    await Promise.resolve();
    expect(opened).not.toHaveBeenCalled();
    expect(fake.created[0].visible).toBe(false);
    fake.created[0].webContents.url = "http://localhost:4101";
    resolve();
    await loading;
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      "a",
      "http://localhost:4101",
    );
    views.select(null);
    views.select("a");
    views.select(null);
    views.select("a");
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].webContents.loadURL).toHaveBeenCalledTimes(1);
    expect(fake.created[0].visible).toBe(true);
  });
  it("aborts pending permission on deadline removal and never acknowledges late load", async () => {
    let resolve!: (v: any) => void;
    vi.mocked(dialog.showMessageBox).mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    const { views, opened } = fixture();
    const loading = views.ensure("a", "http://localhost:4101");
    const options: any = (
      vi.mocked(dialog.showMessageBox).mock.calls.at(-1) as unknown as [
        unknown,
        any,
      ]
    )[1];
    expect(options.signal.aborted).toBe(false);
    views.remove("a");
    expect(options.signal.aborted).toBe(true);
    resolve({ response: 0 });
    await loading;
    expect(opened).not.toHaveBeenCalled();
  });
  it("does not reveal a page whose browser acknowledgement is rejected or whose load failed", async () => {
    const { views, opened, error } = fixture();
    opened.mockReturnValue(false);
    views.select("a");
    await views.ensure("a", "http://localhost:4101");
    expect(fake.created[0].visible).toBe(false);
    expect(fake.created[0].webContents.close).toHaveBeenCalledOnce();
    const loading = views.ensure("b", "http://localhost:4102");
    fake.created[1].webContents.loadURL.mockRejectedValueOnce(
      Error("navigation failed"),
    );
    await loading;
    expect(error).toHaveBeenCalledWith("b", expect.any(String));
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
