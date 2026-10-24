import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ created: [] as any[] }));
vi.mock("electron", () => ({
  WebContentsView: class {
    visible = true;
    bounds = {};
    webContents: any;
    setBackgroundColor = vi.fn();
    constructor(public options: any) {
      this.webContents = options.webContents;
      fake.created.push(this);
    }
    setVisible(value: boolean) {
      this.visible = value;
    }
    setBounds(value: any) {
      this.bounds = value;
    }
  },
}));
import { TopicPopup } from "../src/main/topic-popup";
const ID = "11111111-1111-4111-8111-111111111111";
const NEXT = "22222222-2222-4222-8222-222222222222";
const shellURL = "file:///app/index.html";
function contents(id: number) {
  return Object.assign(new EventEmitter(), {
    id,
    url: shellURL,
    getURL() {
      return this.url;
    },
    isDestroyed: vi.fn(() => false),
    close: vi.fn(),
    focus: vi.fn(),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
}
function fixture() {
  const shell = contents(1);
  const dashboard = { visible: true };
  const children: any[] = [dashboard];
  const win = Object.assign(new EventEmitter(), {
    webContents: shell,
    isDestroyed: () => false,
    getContentSize: () => [800, 600],
    contentView: {
      addChildView: vi.fn((v) => children.push(v)),
      removeChildView: vi.fn((v) => children.splice(children.indexOf(v), 1)),
    },
  });
  const host = new TopicPopup(win as any, shellURL);
  expect(shell.setWindowOpenHandler).toHaveBeenCalledOnce();
  const handler = shell.setWindowOpenHandler.mock.calls[0][0];
  const request = (overrides = {}) =>
    handler({
      url: "about:blank",
      frameName: `goga-topic-picker:${ID}`,
      disposition: "new-window",
      ...overrides,
    });
  function open(id = ID, geometry = {}) {
    const response = request({ frameName: `goga-topic-picker:${id}` });
    expect(response.action).toBe("allow");
    const wc = contents(10);
    const options = {
      ...geometry,
      webContents: wc,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    };
    expect(response.createWindow(options)).toBe(wc);
    return { wc, options, view: fake.created.at(-1), response };
  }
  return { host, shell, win, children, dashboard, request, open };
}
beforeEach(() => {
  fake.created.length = 0;
});
describe("native topic popup", () => {
  it("adopts Electron's same-origin contents hidden above the still-visible dashboard", () => {
    const f = fixture();
    const { view, options, response } = f.open();
    expect(view.options).toBe(options);
    expect(view.visible).toBe(false);
    expect(view.setBackgroundColor).toHaveBeenCalledWith("#00000000");
    expect(f.children).toEqual([f.dashboard, view]);
    expect(f.dashboard.visible).toBe(true);
    expect(response.overrideBrowserWindowOptions.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
    expect(f.request({ frameName: `goga-topic-picker:${NEXT}` })).toEqual({
      action: "deny",
    });
  });
  it.each([
    { url: "https://evil.test" },
    { url: "about:blank#x" },
    { frameName: "goga-topic-picker:not-uuid" },
    { frameName: `other:${ID}` },
    { frameName: "goga-topic-picker:11111111-1111-1111-8111-111111111111" },
    { disposition: "foreground-tab" },
    { disposition: "background-tab" },
  ])("denies other window request %j", (request) => {
    expect(fixture().request(request)).toEqual({ action: "deny" });
  });
  it("denies opening from a shell that has navigated", () => {
    const f = fixture();
    f.shell.url = "https://evil.test";
    expect(f.request()).toEqual({ action: "deny" });
  });
  it("sizes hidden viewport for portal measurement using clamped features or safe defaults", () => {
    const f = fixture();
    let popup = f.open();
    expect(popup.view.bounds).toEqual({ x: 0, y: 0, width: 436, height: 400 });
    f.host.close(ID);
    popup = f.open(NEXT, { x: 700, y: 500, width: 436, height: 400 });
    expect(popup.view.bounds).toEqual({
      x: 700,
      y: 500,
      width: 100,
      height: 100,
    });
    expect(popup.view.visible).toBe(false);
  });
  it("clamps valid bounds, reveals and focuses only once; stale ids cannot control current popup", () => {
    const f = fixture();
    const { view, wc } = f.open();
    f.host.setBounds(NEXT, { x: 0, y: 0, width: 50, height: 50 });
    expect(view.visible).toBe(false);
    f.host.setBounds(ID, { x: 790, y: 590, width: 300, height: 400 });
    expect(view.bounds).toEqual({ x: 790, y: 590, width: 10, height: 10 });
    expect(view.visible).toBe(true);
    expect(wc.focus).toHaveBeenCalledTimes(1);
    f.host.setBounds(ID, { x: 900, y: 900, width: 300, height: 400 });
    expect(view.bounds).toEqual({ x: 799, y: 599, width: 1, height: 1 });
    expect(wc.focus).toHaveBeenCalledTimes(1);
    f.host.close(NEXT);
    expect(wc.close).not.toHaveBeenCalled();
    f.host.close(ID);
    f.open(NEXT);
    f.host.close(ID);
    expect(fake.created.at(-1).webContents.close).not.toHaveBeenCalled();
  });
  it("cleans up exactly once and notifies shell with the UUID", () => {
    const f = fixture();
    const { wc, view } = f.open();
    wc.close.mockImplementation(() => wc.emit("destroyed"));
    wc.emit("close");
    f.host.close(ID);
    f.host.dispose();
    expect(wc.close).toHaveBeenCalledTimes(1);
    expect(f.win.contentView.removeChildView).toHaveBeenCalledExactlyOnceWith(
      view,
    );
    expect(f.shell.send).toHaveBeenCalledExactlyOnceWith(
      "goga:topic-popup-closed",
      ID,
    );
    expect(f.request()).toEqual({ action: "deny" });
  });
  it("ignores native blur while hidden, then closes on blur after the first show", () => {
    const f = fixture();
    const { wc, view } = f.open();
    wc.emit("blur");
    expect(wc.close).not.toHaveBeenCalled();
    expect(f.children).toContain(view);
    expect(f.shell.send).not.toHaveBeenCalled();
    f.host.setBounds(ID, { x: 10, y: 20, width: 400, height: 300 });
    expect(view.visible).toBe(true);
    expect(wc.focus).toHaveBeenCalledOnce();
    wc.emit("blur");
    expect(wc.close).toHaveBeenCalledOnce();
    expect(f.children).toEqual([f.dashboard]);
    expect(f.shell.send).toHaveBeenCalledExactlyOnceWith(
      "goga:topic-popup-closed",
      ID,
    );
  });
  it.each(["render-process-gone", "destroyed"])(
    "cleans popup on %s",
    (event) => {
      const f = fixture();
      const { wc } = f.open();
      wc.emit(event);
      expect(f.children).toEqual([f.dashboard]);
      expect(f.shell.send).toHaveBeenCalledExactlyOnceWith(
        "goga:topic-popup-closed",
        ID,
      );
    },
  );
  it.each(["resize", "blur", "close"])("closes on parent %s", (event) => {
    const f = fixture();
    const { wc } = f.open();
    f.win.emit(event);
    expect(wc.close).toHaveBeenCalledTimes(1);
  });
  it("closes only on shell main-frame navigation, including reload", () => {
    const f = fixture();
    const { wc } = f.open();
    f.shell.emit("did-start-navigation", {}, shellURL, false, false);
    expect(wc.close).not.toHaveBeenCalled();
    f.shell.emit("did-start-navigation", {}, shellURL, false, true);
    expect(wc.close).toHaveBeenCalledOnce();
  });
  it("blocks navigation, redirects, webviews and nested windows", () => {
    const f = fixture();
    const { wc } = f.open();
    for (const event of [
      "will-navigate",
      "will-redirect",
      "will-frame-navigate",
      "will-attach-webview",
    ]) {
      const e = { preventDefault: vi.fn() };
      wc.emit(event, e, "https://evil.test");
      expect(e.preventDefault).toHaveBeenCalledOnce();
    }
    expect(
      wc.setWindowOpenHandler.mock.calls[0][0]({ url: "about:blank" }),
    ).toEqual({ action: "deny" });
  });
  it("dispose removes parent listeners and permanently denies new windows", () => {
    const f = fixture();
    f.host.dispose();
    f.host.dispose();
    expect(f.win.listenerCount("resize")).toBe(0);
    expect(f.shell.listenerCount("did-start-navigation")).toBe(0);
    expect(f.request()).toEqual({ action: "deny" });
  });
});

it("reports a pending or shown popup as a focus owner until it is closed", () => {
  const f = fixture();
  expect(f.host.isOpen).toBe(false);
  f.open();
  expect(f.host.isOpen).toBe(true);
  f.host.setBounds(ID, { x: 10, y: 20, width: 400, height: 300 });
  expect(f.host.isOpen).toBe(true);
  f.host.close(ID);
  expect(f.host.isOpen).toBe(false);
  f.host.dispose();
  expect(f.host.isOpen).toBe(false);
});
