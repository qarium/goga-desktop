import { describe, expect, it, vi } from "vitest";
import { registerDemoIPC, copyDemoPageURL } from "../src/main/demo-ipc";
import { demoCommandSchema, demoScopeKey } from "../src/shared/demonstrations";
import { Demonstrations } from "../src/host/demonstrations/runtime";
const ref = {
  projectId: "p",
  year: "2026",
  topic: "x",
  branch: "x",
  contextId: "ctx-" + "0".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
it("validates show-bound tab commands without accepting raw CDP/upstream parameters", () => {
  for (const cmd of [
    { action: "open", scope: "p", engine: "system" },
    { action: "engine", engine: "embedded" },
    { action: "tab-create", showId: "show-a" },
    { action: "tab-select", showId: "show-a", tabId: "tab-a" },
    { action: "tab-close", showId: "show-a", tabId: "tab-a" },
  ])
    expect(demoCommandSchema.safeParse(cmd).success).toBe(true);
  for (const cmd of [
    { action: "open", scope: "p", engine: "foo" },
    {
      action: "open",
      scope: "p",
      engine: "system",
      chromePath: "/tmp/untrusted",
    },
    { action: "engine", engine: "system", upstream: "http://192.168.1.1" },
    { action: "tab-create" },
    { action: "tab-create", showId: "show-a", url: "file:///secret" },
    { action: "tab-select", showId: "show-a", targetId: "browser-target" },
    { action: "tab-close", showId: "show-a", tabId: "../../../secret" },
    {
      action: "tab-close",
      showId: "show-a",
      tabId: "tab-a",
      upstream: "http://localhost:9222",
    },
  ])
    expect(demoCommandSchema.safeParse(cmd).success).toBe(false);
});
it("ignores only refresh failures from a show concurrently stopped, not failures from a live browser", async () => {
  const rt = new Demonstrations({
    settingsFile: "/nonexistent/goga-demo-test-port.json",
  });
  const entry = {
    id: "a",
    scope: "project-a",
    published: true,
    closing: false,
    label: "A",
    browser: {
      refreshTabs: vi.fn(),
      navigation: { url: null },
      tabSnapshot: () => ({ tabs: [], activeTabId: null }),
    },
  };
  // No browser or server is started: inject only the asynchronous ownership
  // boundary whose real Chrome counterpart can fail while stop drains a pipe.
  (rt as any).activeShows.set(entry.id, entry);
  let fail!: (e: Error) => void;
  entry.browser.refreshTabs.mockImplementation(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  const closingRead = rt.showState(entry.id);
  entry.closing = true;
  fail(Error("Pipe closed"));
  await expect(closingRead).resolves.toBeNull();
  entry.closing = false;
  const liveRead = rt.showState(entry.id);
  fail(Error("Real refresh failure"));
  await expect(liveRead).rejects.toThrow("Real refresh failure");
  const globalRead = rt.state();
  entry.closing = true;
  fail(Error("Pipe closed"));
  await expect(globalRead).resolves.toMatchObject({
    shows: [{ showId: "a", tabs: [], activeTabId: null }],
  });
});
it("never aliases two projects, primary/topic, or replaced checkouts", () => {
  expect(
    new Set([
      demoScopeKey("p"),
      demoScopeKey(ref),
      demoScopeKey({ ...ref, projectId: "q" }),
      demoScopeKey({ ...ref, revision: ref.revision.replace(/1$/, "2") }),
    ]).size,
  ).toBe(4);
  for (const cmd of [
    { action: "open", scope: { ...ref, path: "/tmp" } },
    { action: "navigate", url: "https://example.com" },
    { action: "port", port: 80 },
    { action: "cdp", method: "Browser.close" },
  ])
    expect(demoCommandSchema.safeParse(cmd).success).toBe(false);
});
it("admits only the trusted shell and a live project owner; malformed commands and stale open are not dispatched", async () => {
  const handlers = new Map<string, Function>(),
    handle = vi.fn((c, f) => handlers.set(c, f)),
    removeHandler = vi.fn((c) => handlers.delete(c));
  const url = "file:///trusted/shell",
    mainFrame = { url },
    window = { webContents: { id: 7, mainFrame }, isDestroyed: () => false };
  const sender = { sender: window.webContents, senderFrame: mainFrame };
  const state = vi.fn(async () => ({
      port: 45123,
      shows: [],
      access: { owner: null, phase: "off", connectionId: null },
    })),
    execute = vi.fn(),
    frame = vi.fn(),
    nextFrame = vi.fn(async () => null),
    openBrowser = vi.fn(),
    copyURL = vi.fn(async () => {}),
    copySelection = vi.fn(async () => true),
    cancelSelectionCopy = vi.fn(async () => {});
  const lease = vi.fn(async (scope: any, open: any) => {
    if (typeof scope !== "string") throw Error("Старая копия");
    await open("Мой проект");
  });
  const unregister = registerDemoIPC(
    { handle, removeHandler } as any,
    {
      window,
      shellURL: url,
      runtime: { state, execute, frame, nextFrame },
      openBrowser,
      copyURL,
      copySelection,
      cancelSelectionCopy,
      withOwner: lease,
    } as any,
  );
  const call = (op: string, s: any, ...args: any[]) =>
    Promise.resolve().then(() => handlers.get("goga:demo-" + op)!(s, ...args));
  for (const wrong of [
    { ...sender, sender: { id: 9 } },
    { ...sender, senderFrame: { url } },
    { ...sender, senderFrame: null },
  ])
    await expect(call("state", wrong)).rejects.toThrow();
  expect(state).not.toHaveBeenCalled();
  await expect(
    call("execute", sender, { action: "open", scope: ref }),
  ).rejects.toThrow("Старая копия");
  await expect(
    call("execute", sender, { action: "port", port: 80 }),
  ).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
  await call("execute", sender, { action: "open", scope: "p" });
  expect(execute).toHaveBeenCalledWith(
    { action: "open", scope: "p" },
    "Мой проект",
  );
  await expect(call("frame", sender, "../../../x")).rejects.toThrow();
  expect(frame).not.toHaveBeenCalled();
  await expect(
    call("browser", sender, "https://example.com"),
  ).rejects.toThrow();
  expect(openBrowser).not.toHaveBeenCalled();
  await expect(
    call("execute", sender, {
      action: "input",
      showId: "show-a",
      input: { action: "text", text: "not unbound" },
    }),
  ).rejects.toThrow();
  const request = { showId: "show-a", tabId: "tab-a", after: null };
  for (const bad of [
    { ...request, after: 1 },
    { ...request, cursor: "extra" },
    { ...request, tabId: "../x" },
  ])
    await expect(call("next-frame", sender, bad)).rejects.toThrow();
  await expect(
    call("next-frame", { ...sender, senderFrame: null }, request),
  ).rejects.toThrow();
  expect(nextFrame).not.toHaveBeenCalled();
  await expect(call("next-frame", sender, request)).resolves.toBeNull();
  expect(nextFrame).toHaveBeenCalledWith("show-a", "tab-a", null);
  const copyRequest = { showId: "show-a", tabId: "tab-a" };
  for (const bad of [
    { ...copyRequest, url: "https://injected.example/" },
    { ...copyRequest, tabId: "../bad" },
    { showId: "show-a" },
  ])
    await expect(call("copy-url", sender, bad)).rejects.toThrow();
  await expect(
    call("copy-url", { ...sender, senderFrame: null }, copyRequest),
  ).rejects.toThrow();
  expect(copyURL).not.toHaveBeenCalled();
  await call("copy-url", sender, copyRequest);
  expect(copyURL).toHaveBeenCalledWith("show-a", "tab-a");
  const selectionRequest = { ...copyRequest, requestId: "copy-request" };
  await expect(call("copy-selection", sender, copyRequest)).rejects.toThrow();
  await expect(
    call("copy-selection", sender, {
      ...selectionRequest,
      text: "injected text",
    }),
  ).rejects.toThrow();
  await expect(
    call("copy-selection", { ...sender, senderFrame: null }, selectionRequest),
  ).rejects.toThrow();
  expect(copySelection).not.toHaveBeenCalled();
  expect(await call("copy-selection", sender, selectionRequest)).toBe(true);
  expect(copySelection).toHaveBeenCalledWith("show-a", "tab-a", "copy-request");
  await expect(
    call("cancel-selection-copy", sender, "../bad"),
  ).rejects.toThrow();
  await call("cancel-selection-copy", sender, "copy-request");
  expect(cancelSelectionCopy).toHaveBeenCalledWith("copy-request");
  unregister();
  expect(handlers.size).toBe(0);
});

import { createDemoSelectionClipboard } from "../src/main/demo-selection-clipboard";
import { DemoLifetime } from "../src/main/demo-lifetime";
it("exit snapshots successful pending opens, leaves shows on cancel, and blocks admission until released", async () => {
  let settle!: () => void;
  const shows: { showId: string; label: string }[] = [];
  const finish = vi.fn(async (id: string) => {
    shows.splice(
      shows.findIndex((x) => x.showId === id),
      1,
    );
  });
  const lifecycle = new DemoLifetime(() => shows, finish);
  const opening = lifecycle.admit(async () => {
    await new Promise<void>((r) => {
      settle = r;
    });
    shows.push({ showId: "a", label: "А" });
  });
  const preparing = lifecycle.prepare();
  await expect(lifecycle.admit(async () => {})).rejects.toThrow();
  settle();
  await opening;
  const p = await preparing;
  expect(p.items[0]?.label).toContain("А");
  expect(p.requiresConfirmation).toBe(true);
  p.release();
  expect(shows).toHaveLength(1);
  await lifecycle.admit(async () => {});
  const next = await lifecycle.prepare();
  await next.stop();
  expect(next.remaining()).toEqual([]);
  next.release();
  expect(finish).toHaveBeenCalledWith("a");
  const empty = await lifecycle.prepare();
  expect(empty.requiresConfirmation).toBe(false);
  empty.release();
});

it("copies only the currently active host URL and rejects retired, foreign and non-web tabs without writing", async () => {
  const show: any = {
    showId: "show-a",
    activeTabId: "tab-a",
    url: "https://host.example/path?q=1#anchor",
    tabs: [{ tabId: "tab-a" }],
  };
  const write = vi.fn(async () => {});
  await copyDemoPageURL([show], "show-a", "tab-a", write);
  expect(write).toHaveBeenCalledWith(show.url);
  write.mockClear();
  for (const [shows, id, tab] of [
    [[], "show-a", "tab-a"],
    [[show], "show-a", "other-tab"],
    [[show], "show-b", "tab-a"],
    [[{ ...show, activeTabId: null }], "show-a", "tab-a"],
    [[{ ...show, url: null }], "show-a", "tab-a"],
    [[{ ...show, url: "file:///private/file" }], "show-a", "tab-a"],
    [
      [{ ...show, url: "https://user:secret@host.example/" }],
      "show-a",
      "tab-a",
    ],
  ] as any[])
    await expect(copyDemoPageURL(shows, id, tab, write)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

it("surfaces a readable clipboard failure without exposing system error details", async () => {
  const show: any = {
    showId: "a",
    activeTabId: "t",
    url: "https://page.example/",
    tabs: [{ tabId: "t" }],
  };
  await expect(
    copyDemoPageURL([show], "a", "t", async () => {
      throw Error("native clipboard details");
    }),
  ).rejects.toThrow(
    "Не удалось скопировать адрес страницы. Повторите попытку.",
  );
});

describe("selection clipboard ownership", () => {
  function fixture() {
    let show: any = {
      showId: "a",
      activeTabId: "tab",
      tabs: [{ tabId: "tab" }],
    };
    const writer = vi.fn(async (_text: string) => {});
    const read = vi.fn(async () => "selected text");
    const clipboard = createDemoSelectionClipboard(
      { shows: () => (show ? [show] : []), selection: read },
      writer,
    );
    return {
      clipboard,
      writer,
      read,
      replace: (s: any) => {
        show = s;
      },
    };
  }
  it("writes selection only, preserving empty clipboard and rejecting unknown pages and oversized text", async () => {
    const { clipboard, writer, read } = fixture();
    await expect(clipboard.copy("a", "tab", "copy1")).resolves.toBe(true);
    expect(writer).toHaveBeenCalledWith("selected text");
    writer.mockClear();
    read.mockResolvedValueOnce("");
    await expect(clipboard.copy("a", "tab", "copy2")).resolves.toBe(false);
    expect(writer).not.toHaveBeenCalled();
    await expect(clipboard.copy("a", "foreign", "copy3")).rejects.toThrow();
    read.mockResolvedValueOnce("x".repeat(1024 * 1024 + 1));
    await expect(clipboard.copy("a", "tab", "copy4")).rejects.toThrow();
    expect(writer).not.toHaveBeenCalled();
  });
  it.each(["cancel", "replace", "close"])(
    "never writes a late result after %s",
    async (mode) => {
      const { clipboard, writer, read, replace } = fixture();
      let resolve!: (text: string) => void;
      read.mockImplementationOnce(
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }),
      );
      const copying = clipboard.copy("a", "tab", "pending");
      if (mode === "cancel") clipboard.cancel("pending");
      else if (mode === "close") clipboard.close();
      else
        replace({ showId: "a", activeTabId: "new", tabs: [{ tabId: "new" }] });
      resolve("old-page text");
      if (mode === "replace") await expect(copying).rejects.toThrow();
      else await expect(copying).resolves.toBe(false);
      expect(writer).not.toHaveBeenCalled();
    },
  );
  it("rejects replay, remembers early cancellation and reports clipboard write failure readably", async () => {
    const { clipboard, writer } = fixture();
    clipboard.cancel("before-start");
    expect(await clipboard.copy("a", "tab", "before-start")).toBe(false);
    expect(writer).not.toHaveBeenCalled();
    await clipboard.copy("a", "tab", "once");
    writer.mockClear();
    await expect(clipboard.copy("a", "tab", "once")).rejects.toThrow();
    writer.mockRejectedValueOnce(Error("native/private details"));
    await expect(clipboard.copy("a", "tab", "failed")).rejects.toThrow(
      "Не удалось скопировать выделенный текст",
    );
  });
});

it("bounds a stalled selection read and cannot write its eventual result", async () => {
  vi.useFakeTimers();
  const writer = vi.fn(async () => {});
  let finish!: (value: string) => void;
  const clipboard = createDemoSelectionClipboard(
    {
      shows: () =>
        [{ showId: "a", activeTabId: "t", tabs: [{ tabId: "t" }] }] as any,
      selection: () =>
        new Promise<string>((r) => {
          finish = r;
        }),
    },
    writer,
  );
  try {
    const copy = clipboard.copy("a", "t", "timeout");
    const rejected = expect(copy).rejects.toThrow(
      "Не удалось прочитать выделенный текст",
    );
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    finish("late selection");
    await Promise.resolve();
    expect(writer).not.toHaveBeenCalled();
  } finally {
    clipboard.close();
    vi.useRealTimers();
  }
});
