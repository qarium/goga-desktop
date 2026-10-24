import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { registerTerminalIPC } from "../src/main/terminal-ipc";
const revision = "00000000-0000-4000-8000-000000000001";
const ref = {
  sessionId: "s",
  generation: "00000000-0000-4000-8000-000000000002",
};
const tab = {
  id: "t",
  projectId: "p",
  name: "console",
  scope: { kind: "common" },
};
const session = {
  ...ref,
  tabId: "t",
  context: { kind: "primary", projectId: "p" },
  state: "running",
};
function fixture() {
  const handlers = new Map<string, Function>();
  const ipc = {
    handle: (name: string, fn: Function) => handlers.set(name, fn),
    removeHandler: (name: string) => handlers.delete(name),
  };
  const wc: any = new EventEmitter();
  wc.id = 1;
  wc.mainFrame = { parent: null, url: "file:///app.html" };
  wc.send = vi.fn();
  wc.getURL = () => wc.mainFrame.url;
  wc.isDestroyed = () => false;
  const window: any = new EventEmitter();
  window.webContents = wc;
  window.isDestroyed = () => false;
  const catalog = {
    read: vi.fn(async () => ({
      revision,
      context: session.context,
      tabs: [tab],
      selectedId: "t",
      initialized: true,
    })),
    change: vi.fn(async () => ({})),
    authorize: vi.fn(async () => structuredClone(tab)),
    freeze: vi.fn(() => vi.fn()),
  };
  let changed = () => {};
  const sessions = {
    onChanged: vi.fn((callback: () => void) => {
      changed = callback;
      return vi.fn();
    }),
    open: vi.fn(async () => structuredClone(session)),
    verifyPresentation: vi.fn(async () => {}),
    assertPresentation: vi.fn(),
    list: vi.fn(() => [structuredClone(session)]),
    prepareClose: vi.fn(() => ({
      token: crypto.randomUUID(),
      kind: "tab",
      requiresConfirmation: true,
      sessions: [{ ...session, jobCount: 1 }],
    })),
    cancelClose: vi.fn(),
    confirmClose: vi.fn(async () => ({
      status: "success",
      completed: [ref],
      remaining: [],
    })),
  };
  const surface = { show: vi.fn(), preview: vi.fn(), hide: vi.fn() };
  let time = 0;
  const dispose = registerTerminalIPC(ipc as any, {
    window,
    shellURL: "file:///app.html",
    catalog: catalog as any,
    sessions: sessions as any,
    surface,
    now: () => time,
  });
  const event = { sender: wc, senderFrame: wc.mainFrame };
  let documentId: string | undefined;
  const call = (value: unknown, e: unknown = event) =>
    Promise.resolve().then(async () => {
      documentId ??= await handlers.get("goga:terminal-connect")!(e);
      return handlers.get("goga:terminal-request")!(e, {
        documentId,
        request: value,
      });
    });
  const navigate = () =>
    wc.emit("did-start-navigation", {}, "file:///app.html", false, true);
  return {
    call,
    wc,
    window,
    event,
    catalog,
    sessions,
    surface,
    navigate,
    handlers,
    dispose,
    changed: () => changed(),
    advance: (ms: number) => {
      time += ms;
    },
  };
}
const target = { scope: "p", revision, tabId: "t" };
it("accepts only exact current shell frame/URL; popup/dashboard/subframe cannot call any action", async () => {
  const f = fixture();
  for (const event of [
    { sender: { id: 2 }, senderFrame: f.wc.mainFrame },
    { sender: f.wc, senderFrame: { ...f.wc.mainFrame } },
    { sender: f.wc, senderFrame: null },
  ])
    await expect(f.call({ kind: "read", scope: "p" }, event)).rejects.toThrow();
  f.wc.mainFrame.url = "https://evil.test";
  await expect(f.call({ kind: "read", scope: "p" })).rejects.toThrow();
  expect(f.catalog.read).not.toHaveBeenCalled();
});
it("strictly validates operations, sizes and fields; no raw cwd/env/pid/input in control API", async () => {
  const f = fixture();
  for (const request of [
    { kind: "read", scope: "p", env: {} },
    { kind: "input", ...ref, text: "unsafe" },
    {
      kind: "show",
      ...target,
      ref,
      bounds: { x: 0, y: 0, width: 0, height: 3 },
    },
    { kind: "open", ...target, cwd: "/evil" },
    { kind: "create", scope: "p", revision, area: "all" },
  ])
    await expect(f.call(request)).rejects.toThrow();
  expect(f.sessions.open).not.toHaveBeenCalled();
  expect(f.catalog.read).not.toHaveBeenCalled();
});
it("resolves actual saved tab before opening; never trusts caller tab objects", async () => {
  const f = fixture();
  await f.call({ kind: "open", ...target });
  expect(f.catalog.authorize).toHaveBeenCalledWith(
    "p",
    "t",
    revision,
    expect.any(Function),
  );
  expect(f.sessions.open).toHaveBeenCalledWith(tab, "p");
});
it("rejects stale/mismatched generation, tab and context before showing or refreshing", async () => {
  const f = fixture();
  for (const wrong of [
    { ...session, generation: crypto.randomUUID() },
    { ...session, tabId: "other" },
    { ...session, context: { kind: "primary", projectId: "q" } },
  ]) {
    f.sessions.list.mockReturnValueOnce([wrong] as any);
    await expect(
      f.call({
        kind: "show",
        ...target,
        ref,
        bounds: { x: 0, y: 0, width: 500, height: 300 },
      }),
    ).rejects.toThrow();
  }
  expect(f.surface.show).not.toHaveBeenCalled();
});
it("late resolution from an old document cannot open or display a terminal in the reloaded UI", async () => {
  const f = fixture();
  f.catalog.authorize.mockImplementationOnce(async () => {
    f.navigate();
    return tab as any;
  });
  await expect(f.call({ kind: "open", ...target })).rejects.toThrow();
  expect(f.sessions.open).not.toHaveBeenCalled();
  expect(f.surface.hide).toHaveBeenCalledOnce();
});
it("late started session is not killed on UI reload and its result is not delivered to a new document", async () => {
  const f = fixture();
  f.sessions.open.mockImplementationOnce(async () => {
    f.navigate();
    return session as any;
  });
  await expect(f.call({ kind: "open", ...target })).rejects.toThrow();
  expect(f.sessions.confirmClose).not.toHaveBeenCalled();
  expect(f.sessions.cancelClose).not.toHaveBeenCalled();
});
it("host close tickets are document-bound, single-use and re-authorized before signals", async () => {
  const f = fixture();
  const preview = await f.call({ kind: "prepare-close", ...target });
  const hostToken = f.sessions.prepareClose.mock.results[0].value.token;
  expect(preview.token).not.toBe(hostToken);
  await expect(
    f.call({ kind: "confirm", token: hostToken, confirmed: true }),
  ).rejects.toThrow();
  await f.call({ kind: "confirm", token: preview.token, confirmed: true });
  expect(f.sessions.confirmClose).toHaveBeenCalledExactlyOnceWith(
    hostToken,
    true,
  );
  expect(f.catalog.freeze).toHaveBeenCalledWith(tab);
  await expect(
    f.call({ kind: "confirm", token: preview.token, confirmed: true }),
  ).rejects.toThrow();
});
it("navigation cancels outstanding confirmation authority without stopping sessions", async () => {
  const f = fixture();
  const preview = await f.call({ kind: "prepare-close", ...target });
  f.navigate();
  await expect(
    f.call({ kind: "confirm", token: preview.token, confirmed: true }),
  ).rejects.toThrow();
  expect(f.sessions.cancelClose).toHaveBeenCalledOnce();
  expect(f.sessions.confirmClose).not.toHaveBeenCalled();
});
it("cancel and missing explicit confirmation send no stop request", async () => {
  const f = fixture();
  const first = await f.call({ kind: "prepare-close", ...target });
  await f.call({ kind: "cancel", token: first.token });
  const second = await f.call({ kind: "prepare-close", ...target });
  await expect(
    f.call({ kind: "confirm", token: second.token, confirmed: false }),
  ).rejects.toThrow();
  expect(f.sessions.confirmClose).not.toHaveBeenCalled();
});
it("changed catalog before confirm refuses to stop any process and consumes the ticket", async () => {
  const f = fixture();
  const preview = await f.call({ kind: "prepare-close", ...target });
  f.catalog.authorize.mockRejectedValueOnce(Error("stale"));
  await expect(
    f.call({ kind: "confirm", token: preview.token, confirmed: true }),
  ).rejects.toThrow();
  expect(f.sessions.confirmClose).not.toHaveBeenCalled();
  expect(f.sessions.cancelClose).toHaveBeenCalledOnce();
});
it("disposal removes handlers, invalidates tokens and hides only the surface", async () => {
  const f = fixture();
  await f.call({ kind: "prepare-close", ...target });
  f.dispose();
  f.dispose();
  expect(f.handlers.size).toBe(0);
  expect(f.surface.hide).toHaveBeenCalledOnce();
  expect(f.sessions.confirmClose).not.toHaveBeenCalled();
});

it("rejects a queued old-document payload even if the frame object is reused after reload", async () => {
  const f = fixture();
  const old = await f.handlers.get("goga:terminal-connect")!(f.event);
  f.navigate();
  const current = await f.handlers.get("goga:terminal-connect")!(f.event);
  expect(current).not.toBe(old);
  await expect(
    Promise.resolve().then(() =>
      f.handlers.get("goga:terminal-request")!(f.event, {
        documentId: old,
        request: { kind: "read", scope: "p" },
      }),
    ),
  ).rejects.toThrow();
  expect(f.catalog.read).not.toHaveBeenCalled();
});

it("sends only document-bound invalidation notices and revokes delivery during reload", async () => {
  const f = fixture();
  await f.call({ kind: "read", scope: "p" });
  f.changed();
  expect(f.wc.send).toHaveBeenCalledWith("goga:terminal-changed", {
    documentId: expect.any(String),
  });
  const value = f.wc.send.mock.calls.at(-1)[1];
  expect(Object.keys(value)).toEqual(["documentId"]);
  f.navigate();
  f.wc.send.mockClear();
  f.changed();
  expect(f.wc.send).not.toHaveBeenCalled();
});

it("expires confirmations before signals and releases the host ticket", async () => {
  const f = fixture();
  const preview = await f.call({ kind: "prepare-close", ...target });
  f.advance(60000);
  await expect(
    f.call({ kind: "confirm", token: preview.token, confirmed: true }),
  ).rejects.toThrow();
  expect(f.sessions.confirmClose).not.toHaveBeenCalled();
  expect(f.sessions.cancelClose).toHaveBeenCalledOnce();
});
it("a late authorized show cannot resurrect the surface after hide", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  f.catalog.authorize.mockImplementation(async () => {
    await gate;
    return structuredClone(tab);
  });
  const pending = f.call({
    kind: "show",
    scope: "p",
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  });
  await vi.waitFor(() => expect(f.catalog.authorize).toHaveBeenCalled());
  await f.call({ kind: "hide" });
  release();
  await pending;
  expect(f.surface.show).not.toHaveBeenCalled();
});
it("destroyed window is rejected before accessing its destroyed webContents getter", async () => {
  const f = fixture();
  f.window.isDestroyed = () => true;
  Object.defineProperty(f.window, "webContents", {
    get() {
      throw Error("destroyed native details");
    },
  });
  await expect(f.call({ kind: "hide" })).rejects.toThrow(
    "Терминал: запрос запрещён или устарел.",
  );
});

it("previews only a previously authorized exact screen in the same shell document", async () => {
  const f = fixture();
  const show = {
    kind: "show",
    scope: "p",
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  const preview = { ...show, kind: "preview" };
  f.surface.preview = vi.fn();
  await f.call(preview);
  expect(f.surface.preview).not.toHaveBeenCalled();
  await f.call(show);
  f.catalog.authorize.mockImplementation(() => new Promise(() => {}));
  await f.call({ kind: "hide" });
  await f.call(preview);
  expect(f.surface.preview).toHaveBeenCalledExactlyOnceWith(ref, show.bounds);
  await f.call({ ...preview, scope: "other" });
  expect(f.surface.preview).toHaveBeenCalledTimes(1);
});

it("revokes read-only screen grants on shell reload and cannot use them for another generation", async () => {
  const f = fixture();
  const request = {
    kind: "show",
    scope: "p",
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  await f.call(request);
  await f.call({
    ...request,
    kind: "preview",
    ref: { ...ref, generation: "00000000-0000-4000-8000-000000000003" },
  });
  expect(f.surface.preview).not.toHaveBeenCalled();
  f.wc.emit("did-start-navigation", {}, "file:///app.html", false, true);
  await expect(f.call({ ...request, kind: "preview" })).rejects.toThrow();
  expect(f.surface.preview).not.toHaveBeenCalled();
});

it("revokes the read-only view on failed reauthorization without enabling input", async () => {
  const f = fixture();
  const show = {
    kind: "show",
    scope: "p",
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  await f.call(show);
  await f.call({ ...show, kind: "preview" });
  f.catalog.authorize.mockRejectedValueOnce(Error("owner removed"));
  f.surface.hide.mockClear();
  f.surface.show.mockClear();
  await expect(f.call(show)).rejects.toThrow("owner removed");
  expect(f.surface.show).not.toHaveBeenCalled();
  expect(f.surface.hide).toHaveBeenCalled();
  f.surface.preview.mockClear();
  await f.call({ ...show, kind: "preview" });
  expect(f.surface.preview).not.toHaveBeenCalled();
});

it.each([false, true])(
  "late failed authorization revokes only older preview proofs (newer=%s)",
  async (newer) => {
    const f = fixture();
    const show = {
      kind: "show",
      ...target,
      ref,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    };
    await f.call(show);
    let reject!: (error: Error) => void;
    const gate = new Promise<typeof tab>((_, fail) => {
      reject = fail;
    });
    f.catalog.authorize.mockImplementationOnce(() => gate);
    const failed = f.call(show).catch((e) => e);
    await vi.waitFor(() =>
      expect(f.catalog.authorize).toHaveBeenCalledTimes(2),
    );
    await f.call({ kind: "hide" });
    if (newer) await f.call(show);
    reject(Error("stale owner"));
    await failed;
    f.surface.hide.mockClear();
    await f.call({ ...show, kind: "preview" });
    expect(f.surface.preview).toHaveBeenCalledTimes(newer ? 1 : 0);
  },
);

it("checks the existing pinned session before enabling input and revokes failed preview proof", async () => {
  const f = fixture(),
    request = {
      kind: "show",
      ...target,
      ref,
      bounds: { x: 0, y: 0, width: 400, height: 300 },
    };
  await f.call(request);
  expect(f.sessions.verifyPresentation).toHaveBeenCalledWith(tab, "p", ref);
  expect(f.sessions.open).not.toHaveBeenCalled();
  f.sessions.verifyPresentation.mockRejectedValue(Error("root replaced"));
  f.surface.show.mockClear();
  await expect(f.call(request)).rejects.toThrow("root replaced");
  expect(f.surface.show).not.toHaveBeenCalled();
  expect(f.surface.hide).toHaveBeenCalled();
  f.surface.preview.mockClear();
  await f.call({ ...request, kind: "preview" });
  expect(f.surface.preview).not.toHaveBeenCalled();
});

it("activates an already presented screen without catalog or root I/O", async () => {
  const f = fixture();
  const target = {
    scope: "p",
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  await f.call({ kind: "show", ...target });
  f.catalog.authorize.mockClear();
  f.sessions.verifyPresentation.mockClear();
  await f.call({ kind: "activate", ...target });
  expect(f.catalog.authorize).not.toHaveBeenCalled();
  expect(f.sessions.verifyPresentation).not.toHaveBeenCalled();
  expect(f.surface.preview).not.toHaveBeenCalled();
  expect(f.surface.show).toHaveBeenCalledTimes(2);
});

it("requires initial presentation, preserves the lease across hide, and revokes it on reload", async () => {
  const f = fixture();
  const target = {
    scope: "p",
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  await expect(f.call({ kind: "activate", ...target })).resolves.toBe(false);
  await f.call({ kind: "show", ...target });
  await f.call({ kind: "hide" });
  await expect(f.call({ kind: "activate", ...target })).resolves.toBe(true);
  f.navigate();
  await expect(f.call({ kind: "activate", ...target })).rejects.toThrow();
});

it("activation rejects a revoked lease instead of restoring input", async () => {
  const f = fixture();
  const target = {
    scope: "p",
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  await f.call({ kind: "show", ...target });
  f.surface.show.mockClear();
  f.sessions.assertPresentation.mockImplementation(() => {
    throw Error("revoked");
  });
  await expect(f.call({ kind: "activate", ...target })).rejects.toThrow(
    "revoked",
  );
  expect(f.surface.show).not.toHaveBeenCalled();
});

it("selection invalidates other retained workspaces with the originating scope", async () => {
  const f = fixture();
  await f.call({ kind: "select", ...target });
  expect(f.wc.send).toHaveBeenCalledWith(
    "goga:terminal-changed",
    expect.objectContaining({ selectionScope: "p" }),
  );
});

it("switches granted sessions across projects while catalog/root I/O is blocked", async () => {
  const f = fixture();
  const second = {
    ...session,
    tabId: "u",
    sessionId: "s2",
    context: { kind: "primary", projectId: "q" },
  };
  f.sessions.list.mockImplementation(() => [
    structuredClone(session),
    structuredClone(second),
  ]);
  const bounds = { x: 0, y: 0, width: 400, height: 300 };
  const a = { ...target, ref, bounds };
  const b = {
    scope: "q",
    revision,
    tabId: "u",
    ref: { sessionId: "s2", generation: ref.generation },
    bounds,
  };
  await f.call({ kind: "show", ...a });
  await f.call({ kind: "hide" });
  await f.call({ kind: "show", ...b });
  f.catalog.authorize.mockClear();
  f.catalog.authorize.mockImplementation(() => new Promise(() => {}));
  f.sessions.verifyPresentation.mockClear();
  f.sessions.verifyPresentation.mockImplementation(() => new Promise(() => {}));
  await f.call({ kind: "hide" });
  await expect(f.call({ kind: "activate", ...a })).resolves.toBe(true);
  await expect(f.call({ kind: "activate", ...b })).resolves.toBe(true);
  expect(f.catalog.authorize).not.toHaveBeenCalled();
  expect(f.sessions.verifyPresentation).not.toHaveBeenCalled();
  expect(f.surface.show).toHaveBeenLastCalledWith(b.ref, bounds);
  await expect(f.call({ kind: "activate", ...a, scope: "q" })).resolves.toBe(
    false,
  );
});

it("topic presentation identity ignores metadata revision but not clone identity", async () => {
  const f = fixture();
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "a",
    branch: "a",
    contextId: `ctx-${"a".repeat(64)}`,
    revision,
  };
  const { revision: _, ...identity } = scope;
  f.sessions.list.mockImplementation(
    () => [{ ...session, context: { kind: "topic", ...identity } }] as any,
  );
  const shown = {
    scope,
    revision,
    tabId: "t",
    ref,
    bounds: { x: 0, y: 0, width: 400, height: 300 },
  };
  await f.call({ kind: "show", ...shown });
  await f.call({ kind: "hide" });
  await expect(
    f.call({
      kind: "activate",
      ...shown,
      scope: { ...scope, revision: crypto.randomUUID() },
    }),
  ).resolves.toBe(true);
  await expect(
    f.call({
      kind: "activate",
      ...shown,
      scope: { ...scope, contextId: `ctx-${"b".repeat(64)}` },
    }),
  ).resolves.toBe(false);
});
