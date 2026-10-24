import { EventEmitter } from "node:events";
import { expect, it, vi, beforeEach } from "vitest";
const fake = vi.hoisted(() => ({
  views: [] as any[],
  ipc: null as any,
  confirm: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  fake.ipc = new EventEmitter();
  return {
    ipcMain: fake.ipc,
    dialog: { showMessageBox: fake.confirm },
    shell: { openExternal: fake.openExternal },
    WebContentsView: class {
      webContents: any;
      options: any;
      setVisible = vi.fn();
      setBounds = vi.fn();
      setBackgroundColor = vi.fn();
      constructor(options: any) {
        this.options = options;
        const wc = new EventEmitter() as any;
        this.webContents = wc;
        wc.mainFrame = { url: "file:///terminal.html" };
        wc.getURL = () => wc.mainFrame.url;
        wc.isDestroyed = () => false;
        wc.send = vi.fn();
        wc.close = vi.fn();
        wc.focus = vi.fn();
        wc.session = new EventEmitter();
        wc.session.setPermissionRequestHandler = vi.fn();
        wc.session.setPermissionCheckHandler = vi.fn();
        wc.setWindowOpenHandler = vi.fn();
        wc.loadURL = vi.fn(async () => {});
        fake.views.push(this);
      }
    },
  };
});
import { TerminalViews } from "../src/main/terminal-views";
const ref = {
  sessionId: "s",
  generation: "00000000-0000-4000-8000-000000000001",
};
function fixture(canFocus?: () => boolean) {
  const win = new EventEmitter() as any;
  win.webContents = new EventEmitter();
  win.isDestroyed = () => false;
  win.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
  win.getContentSize = () => [900, 600];
  const state = vi.fn();
  const manager = new TerminalViews(win, {
    url: "file:///terminal.html",
    preload: "/synthetic/preload.cjs",
    state,
    canFocus,
  });
  const view = fake.views.at(-1),
    wc = view.webContents;
  const event = { sender: wc, senderFrame: wc.mainFrame };
  const ready = () => fake.ipc.emit("terminal-screen:ready", event);
  const source = {
    pause: vi.fn(),
    resume: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
  };
  return { manager, win, view, wc, event, ready, source, state };
}
beforeEach(() => {
  fake.views = [];
  fake.confirm.mockReset().mockResolvedValue({ response: 0 });
  fake.openExternal.mockReset().mockResolvedValue(undefined);
  fake.ipc.removeAllListeners();
});
it("creates an isolated sandboxed view; main UI reload only hides, not destroys it", () => {
  const f = fixture();
  expect(f.view.options.webPreferences).toMatchObject({
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling: false,
    focusOnNavigation: false,
    preload: "/synthetic/preload.cjs",
  });
  expect(f.view.options.webPreferences.partition).toMatch(/^terminal-/);
  expect(f.view.options.webPreferences.partition).not.toMatch(/^persist:/);
  expect(f.win.contentView.addChildView).toHaveBeenCalledExactlyOnceWith(
    f.view,
    0,
  );
  f.ready();
  f.manager.attach(ref, f.source);
  f.win.webContents.emit(
    "did-start-navigation",
    {},
    "file:///shell.html",
    false,
    true,
  );
  expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
  expect(f.wc.close).not.toHaveBeenCalled();
  expect(f.source.pause).not.toHaveBeenCalled();
});
it("refuses attachment before dedicated renderer ready", () => {
  const f = fixture();
  expect(() => f.manager.attach(ref, f.source)).toThrow();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  expect(f.wc.send).toHaveBeenCalledWith("terminal-screen:command", {
    kind: "grant",
    grant,
  });
});
it("only exact sender, main frame, URL and capability can type, resize or acknowledge", () => {
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  f.manager.output(ref, "data");
  const data = { ...grant, text: "hello" };
  for (const event of [
    { sender: {}, senderFrame: f.wc.mainFrame },
    { sender: f.wc, senderFrame: { url: "file:///terminal.html" } },
  ])
    fake.ipc.emit("terminal-screen:input", event, data);
  f.wc.mainFrame.url = "file:///evil.html";
  fake.ipc.emit("terminal-screen:input", f.event, data);
  f.wc.mainFrame.url = "file:///terminal.html";
  fake.ipc.emit("terminal-screen:input", f.event, {
    ...data,
    capability: crypto.randomUUID(),
  });
  fake.ipc.emit("terminal-screen:input", f.event, {
    ...data,
    projectId: "extra",
  });
  expect(f.source.input).not.toHaveBeenCalled();
  fake.ipc.emit("terminal-screen:input", f.event, data);
  expect(f.source.input).toHaveBeenCalledExactlyOnceWith("hello");
  fake.ipc.emit("terminal-screen:resize", f.event, {
    ...grant,
    cols: 120,
    rows: 40,
  });
  expect(f.source.resize).toHaveBeenCalledExactlyOnceWith(120, 40);
});
it("renderer crash/navigation revokes credentials, pauses PTYs and does not recreate view", () => {
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  f.wc.emit("render-process-gone", {}, { reason: "crashed" });
  fake.ipc.emit("terminal-screen:input", f.event, { ...grant, text: "unsafe" });
  f.ready();
  expect(f.source.input).not.toHaveBeenCalled();
  expect(f.source.pause).toHaveBeenCalledOnce();
  expect(f.state).toHaveBeenCalledWith(ref, "renderer-lost");
  expect(fake.views).toHaveLength(1);
  expect(() => f.manager.attach(ref, f.source)).toThrow();
  f.manager.output(ref, "bounded after loss");
  expect(
    f.wc.send.mock.calls.filter((x: any[]) => x[0] === "terminal-screen:frame"),
  ).toHaveLength(0);
});
it("unexpected second document is lost even if it loads the same URL", () => {
  const f = fixture();
  f.ready();
  f.manager.attach(ref, f.source);
  f.wc.emit("did-start-navigation", {}, "file:///terminal.html", false, true);
  expect(f.source.pause).toHaveBeenCalledOnce();
  expect(f.state).toHaveBeenCalledWith(ref, "renderer-lost");
});
it("duplicate ready cannot reissue grants or replace streams", () => {
  const f = fixture();
  f.ready();
  f.manager.attach(ref, f.source);
  f.ready();
  expect(
    f.wc.send.mock.calls.filter((x: any[]) => x[1]?.kind === "grant"),
  ).toHaveLength(1);
});
it("exit is read-only but final writes can still be acknowledged", () => {
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  f.manager.output(ref, "last");
  f.manager.exited(ref);
  fake.ipc.emit("terminal-screen:input", f.event, { ...grant, text: "unsafe" });
  fake.ipc.emit("terminal-screen:resize", f.event, {
    ...grant,
    cols: 80,
    rows: 24,
  });
  fake.ipc.emit("terminal-screen:ack", f.event, { ...grant, sequence: 1 });
  expect(f.source.input).not.toHaveBeenCalled();
  expect(f.source.resize).not.toHaveBeenCalled();
  expect(f.manager.status(ref).pendingBytes).toBe(0);
});
it("stale generation cannot write or select another context; invalid selection hides previous surface", () => {
  const f = fixture();
  f.ready();
  f.manager.attach(ref, f.source);
  expect(
    f.manager.output({ ...ref, generation: crypto.randomUUID() }, "bad"),
  ).toBe(false);
  f.manager.show(ref, { x: 10, y: 20, width: 500, height: 400 });
  expect(f.view.setVisible).toHaveBeenLastCalledWith(true);
  expect(() =>
    f.manager.show(
      { ...ref, generation: crypto.randomUUID() },
      { x: 0, y: 0, width: 10, height: 10 },
    ),
  ).toThrow();
  expect(f.view.setVisible).toHaveBeenLastCalledWith(false);
});
it("retirement prevents reattachment of old stream and disposes IPC on parent close", () => {
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  f.manager.remove(ref);
  expect(() => f.manager.attach(ref, f.source)).toThrow();
  f.manager.attach({ ...ref, generation: crypto.randomUUID() }, f.source);
  fake.ipc.emit("terminal-screen:input", f.event, { ...grant, text: "old" });
  expect(f.source.input).not.toHaveBeenCalled();
  f.win.emit("closed");
  expect(f.wc.close).toHaveBeenCalledOnce();
  expect(fake.ipc.listenerCount("terminal-screen:input")).toBe(0);
});
it("navigation and popups are blocked, no full application bridge is inherited", () => {
  const f = fixture(),
    event = { preventDefault: vi.fn() };
  f.wc.emit("will-navigate", event);
  expect(event.preventDefault).toHaveBeenCalled();
  const handler = f.wc.setWindowOpenHandler.mock.calls[0][0];
  expect(handler({ url: "https://example.test" })).toEqual({ action: "deny" });
});

it("denies downloads and permission requests in the dedicated partition", () => {
  const f = fixture(),
    event = { preventDefault: vi.fn() },
    callback = vi.fn();
  f.wc.session.emit("will-download", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  f.wc.session.setPermissionRequestHandler.mock.calls[0][0](
    f.wc,
    "clipboard-read",
    callback,
  );
  expect(callback).toHaveBeenCalledWith(false);
  expect(f.wc.session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
});

it("waits for authenticated renderer readiness, not load completion or another sender", async () => {
  const f = fixture(),
    done = vi.fn();
  const pending = f.manager.whenReady().then(done);
  await Promise.resolve();
  fake.ipc.emit("terminal-screen:ready", {
    sender: {},
    senderFrame: f.wc.mainFrame,
  });
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  f.ready();
  await pending;
  expect(done).toHaveBeenCalledOnce();
  await expect(f.manager.whenReady()).resolves.toBeUndefined();
  expect(f.manager.isLost).toBe(false);
  f.manager.dispose();
});
it("rejects all readiness waiters on crash or disposal without waiting for a timeout", async () => {
  for (const action of ["crash", "dispose"]) {
    const f = fixture();
    const result = Promise.allSettled([
      f.manager.whenReady(),
      f.manager.whenReady(),
    ]);
    if (action === "crash") f.wc.emit("render-process-gone");
    else f.manager.dispose();
    expect((await result).map((r) => r.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(f.manager.isLost).toBe(true);
    await expect(f.manager.whenReady()).rejects.toThrow(/экран/i);
    f.manager.dispose();
  }
});
it("bounds readiness to ten seconds and retires a renderer that never becomes ready", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const result = Promise.allSettled([f.manager.whenReady()]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result)[0].status).toBe("rejected");
    f.ready();
    expect(f.manager.isLost).toBe(true);
    expect(() => f.manager.attach(ref, f.source)).toThrow();
    f.manager.dispose();
  } finally {
    vi.useRealTimers();
  }
});
it("accepts late host exit/retirement cleanup after parent-window disposal", () => {
  const f = fixture();
  f.ready();
  f.manager.attach(ref, f.source);
  f.manager.dispose();
  expect(() => f.manager.exited(ref)).not.toThrow();
  expect(() => f.manager.remove(ref)).not.toThrow();
});

it("refused input during close does not revoke the screen; actual I/O failure still does", async () => {
  const { TerminalAdmissionClosedError } =
    await import("../src/host/terminal-errors");
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  f.source.input.mockImplementationOnce(() => {
    throw new TerminalAdmissionClosedError();
  });
  fake.ipc.emit("terminal-screen:input", f.event, {
    ...grant,
    text: "blocked",
  });
  expect(f.state).not.toHaveBeenCalled();
  expect(f.source.pause).not.toHaveBeenCalled();
  fake.ipc.emit("terminal-screen:input", f.event, {
    ...grant,
    text: "after-cancel",
  });
  expect(f.source.input).toHaveBeenLastCalledWith("after-cancel");
  f.source.input.mockImplementationOnce(() => {
    throw Error("native failure");
  });
  fake.ipc.emit("terminal-screen:input", f.event, { ...grant, text: "fail" });
  expect(f.state).toHaveBeenCalledWith(ref, "renderer-lost");
});

it("opens only a confirmed http(s) link from the selected authorized terminal", async () => {
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  f.manager.show(ref, { x: 0, y: 0, width: 300, height: 200 });
  const value = { ...grant, url: "https://example.test/path?q=1" };
  fake.ipc.emit("terminal-screen:link", f.event, value);
  await vi.waitFor(() => expect(fake.confirm).toHaveBeenCalledTimes(1));
  expect(fake.openExternal).not.toHaveBeenCalled();
  expect(fake.confirm.mock.calls[0][1]).toMatchObject({
    defaultId: 0,
    cancelId: 0,
    detail: value.url,
  });
  fake.confirm.mockResolvedValue({ response: 1 });
  fake.ipc.emit("terminal-screen:link", f.event, value);
  await vi.waitFor(() =>
    expect(fake.openExternal).toHaveBeenCalledExactlyOnceWith(value.url),
  );
});
it("rejects untrusted senders, hidden/stale sessions, extra fields and unsafe link schemes before showing a prompt", () => {
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  fake.ipc.emit("terminal-screen:link", f.event, {
    ...grant,
    url: "https://example.test",
  });
  f.manager.show(ref, { x: 0, y: 0, width: 300, height: 200 });
  for (const url of [
    "file:///tmp/a",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://user:pass@example.test",
    "https://example.test/\n",
    "https://example.test/\u202e",
    "https://example.test/" + "a".repeat(4096),
  ])
    fake.ipc.emit("terminal-screen:link", f.event, { ...grant, url });
  fake.ipc.emit(
    "terminal-screen:link",
    { ...f.event, sender: {} },
    { ...grant, url: "https://example.test" },
  );
  fake.ipc.emit("terminal-screen:link", f.event, {
    ...grant,
    capability: crypto.randomUUID(),
    url: "https://example.test",
  });
  fake.ipc.emit("terminal-screen:link", f.event, {
    ...grant,
    url: "https://example.test",
    extra: true,
  });
  expect(fake.confirm).not.toHaveBeenCalled();
  expect(fake.openExternal).not.toHaveBeenCalled();
});
it.each(["hide", "exit", "loss", "dispose"])(
  "revokes a pending link confirmation on %s and coalesces repeated requests",
  async (operation) => {
    const f = fixture();
    f.ready();
    const grant = f.manager.attach(ref, f.source);
    f.manager.show(ref, { x: 0, y: 0, width: 300, height: 200 });
    let decide!: (answer: { response: number }) => void;
    fake.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    );
    for (let i = 0; i < 2; i++)
      fake.ipc.emit("terminal-screen:link", f.event, {
        ...grant,
        url: "https://example.test",
      });
    expect(fake.confirm).toHaveBeenCalledTimes(1);
    if (operation === "hide") f.manager.hide();
    if (operation === "exit") f.manager.exited(ref);
    if (operation === "loss") f.manager.fail(ref);
    if (operation === "dispose") f.manager.dispose();
    decide({ response: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.openExternal).not.toHaveBeenCalled();
  },
);

it("inserts a new terminal above the shell but below an existing topic overlay", () => {
  const f = fixture();
  f.manager.dispose();
  const shell = { webContents: f.win.webContents },
    overlay = { webContents: {} };
  f.win.contentView.children = [shell, overlay];
  const manager = new TerminalViews(f.win, {
    url: "file:///terminal.html",
    preload: "/synthetic/preload.cjs",
    state: vi.fn(),
  });
  expect(f.win.contentView.addChildView).toHaveBeenLastCalledWith(
    fake.views.at(-1),
    1,
  );
  manager.dispose();
});
it("does not steal native or renderer focus from an open overlay", () => {
  const f = fixture(() => false);
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  f.manager.show(ref, { x: 0, y: 0, width: 300, height: 200 });
  expect(f.wc.focus).not.toHaveBeenCalled();
  expect(f.wc.send).toHaveBeenCalledWith("terminal-screen:command", {
    kind: "select",
    grant,
    focus: false,
  });
});
it("geometry-only updates neither hide/reselect nor refocus the current screen", () => {
  const f = fixture();
  f.ready();
  f.manager.attach(ref, f.source);
  f.manager.show(ref, { x: 0, y: 0, width: 300, height: 200 });
  f.wc.send.mockClear();
  f.wc.focus.mockClear();
  f.view.setVisible.mockClear();
  f.manager.show(ref, { x: 0, y: 0, width: 400, height: 250 });
  expect(f.wc.send).not.toHaveBeenCalled();
  expect(f.wc.focus).not.toHaveBeenCalled();
  expect(f.view.setVisible).not.toHaveBeenCalledWith(false);
  expect(f.view.setBounds).toHaveBeenLastCalledWith({
    x: 0,
    y: 0,
    width: 400,
    height: 250,
  });
});

it("shows an existing screen read-only until authorization enables input and resize", () => {
  const f = fixture();
  f.ready();
  const grant = f.manager.attach(ref, f.source);
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  f.manager.show(ref, bounds, false);
  expect(f.view.setVisible).toHaveBeenLastCalledWith(true);
  fake.ipc.emit("terminal-screen:input", f.event, {
    ...grant,
    text: "blocked",
  });
  fake.ipc.emit("terminal-screen:resize", f.event, {
    ...grant,
    cols: 120,
    rows: 40,
  });
  expect(f.source.input).not.toHaveBeenCalled();
  expect(f.source.resize).not.toHaveBeenCalled();
  f.manager.show(ref, bounds);
  fake.ipc.emit("terminal-screen:input", f.event, {
    ...grant,
    text: "allowed",
  });
  expect(f.source.input).toHaveBeenCalledExactlyOnceWith("allowed");
  f.manager.dispose();
});
