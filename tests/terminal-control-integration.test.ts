import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { TerminalStore } from "../src/host/terminal-store";
import { TerminalCatalog } from "../src/host/terminal-catalog";
import {
  TerminalSessions,
  type TerminalPty,
} from "../src/host/terminal-sessions";
import { registerTerminalIPC } from "../src/main/terminal-ipc";
import { createTerminalControlAPI } from "../src/main/terminal-control-preload";
import type { ScopeRef } from "../src/shared/context";
import type { TerminalContext } from "../src/shared/terminal";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const a = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
};
const b = { ...a, topic: "b", branch: "b", contextId: `ctx-${"b".repeat(64)}` };
function context(scope: ScopeRef): TerminalContext {
  if (typeof scope === "string") return { kind: "primary", projectId: scope };
  const { revision, ...owner } = scope;
  return { kind: "topic", ...owner };
}
class Pty extends EventEmitter implements TerminalPty {
  write = vi.fn();
  resize = vi.fn();
  assertReady = vi.fn();
  onFault(fn: () => void) {
    this.on("fault", fn);
    return {
      dispose: () => {
        this.off("fault", fn);
      },
    };
  }
  pause = vi.fn();
  resume = vi.fn();
  onData(listener: (text: string) => void) {
    this.on("data", listener);
    return {
      dispose: () => {
        this.off("data", listener);
      },
    };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.on("exit", listener);
    return {
      dispose: () => {
        this.off("exit", listener);
      },
    };
  }
}
async function fixture() {
  const home = await mkdtemp("/private/tmp/goga-terminal-control-");
  roots.push(home);
  const store = new TerminalStore(home),
    catalog = new TerminalCatalog(store, async (scope) => context(scope));
  const ptys: Pty[] = [],
    stopped: Pty[] = [],
    released = vi.fn();
  const sessions = new TerminalSessions({
    acquire: async (scope) => ({
      release: released,
      launch: {
        context: context(scope),
        cwd: home,
        shell: "/bin/zsh",
        args: ["-l", "-i"],
        env: { SYNTHETIC_SECRET: "not-for-ui" },
        verifyRoot: async () => {},
      },
    }),
    spawn: () => {
      const pty = new Pty();
      ptys.push(pty);
      return pty;
    },
    prepareScreen: async () => ({
      assertReady() {},
      bind() {},
      output() {},
      exited() {},
      drainAfterHangup() {},
      finishClose() {},
      fail() {},
      dispose() {},
    }),
    processes: (pty) => ({
      prepare: () => ({ anchor: {} as any, jobs: [{} as any] }),
      validate: () => {},
      stop: async () => {
        stopped.push(pty as Pty);
        (pty as Pty).emit("exit", { exitCode: 0 });
      },
    }),
    removeTab: (tab) => catalog.removeTerminatedTab(tab),
  });
  const wc: any = new EventEmitter();
  wc.id = 1;
  wc.mainFrame = { url: "file:///shell.html", parent: null };
  wc.getURL = () => wc.mainFrame.url;
  wc.isDestroyed = () => false;
  const handlers = new Map<string, Function>(),
    notifications = new EventEmitter();
  wc.send = (name: string, value: unknown) => notifications.emit(name, value);
  const window: any = new EventEmitter();
  window.webContents = wc;
  window.isDestroyed = () => false;
  const dispose = registerTerminalIPC(
    {
      handle: (name: string, fn: Function) => handlers.set(name, fn),
      removeHandler: (name: string) => handlers.delete(name),
    } as any,
    {
      window,
      shellURL: "file:///shell.html",
      catalog,
      sessions,
      surface: { show: vi.fn(), hide: vi.fn() },
    },
  );
  const api = createTerminalControlAPI(
    async (name, value) =>
      value === undefined
        ? handlers.get(name)!({ sender: wc, senderFrame: wc.mainFrame })
        : handlers.get(name)!({ sender: wc, senderFrame: wc.mainFrame }, value),
    (name, cb) => {
      notifications.on(name, cb);
      return () => {
        notifications.off(name, cb);
      };
    },
  );
  let state = await api.request({ kind: "read", scope: "p" });
  const initial = await api.request({
    kind: "initialize",
    scope: "p",
    revision: state.revision,
  });
  return {
    home,
    store,
    catalog,
    sessions,
    ptys,
    stopped,
    released,
    api,
    initial,
    dispose,
  };
}
it("closes a common tab across A/B but preserves another bound tab and restores only metadata", async () => {
  const f = await fixture(),
    common = f.initial.tabs[0].id;
  const next = await f.api.request({
    kind: "create",
    scope: a,
    area: "context",
    revision: f.initial.revision,
  });
  const target = { revision: next.revision, tabId: common };
  await f.api.request({ kind: "open", scope: a, ...target });
  await f.api.request({ kind: "open", scope: b, ...target });
  await f.api.request({
    kind: "open",
    scope: a,
    revision: next.revision,
    tabId: next.selectedId!,
  });
  const preview = await f.api.request({
    kind: "prepare-close",
    scope: "p",
    ...target,
  });
  expect(preview.sessions).toHaveLength(2);
  expect(preview.requiresConfirmation).toBe(true);
  const result = await f.api.request({
    kind: "confirm",
    token: preview.token,
    confirmed: true,
  });
  expect(result.status).toBe("success");
  expect(f.stopped).toHaveLength(2);
  expect(f.released).toHaveBeenCalledTimes(2);
  expect(f.sessions.list()).toHaveLength(1);
  const restored = await new TerminalStore(f.home).load();
  expect(restored.projects.p.tabs.map((t) => t.id)).toEqual([next.selectedId]);
  expect(JSON.stringify(restored)).not.toMatch(
    /not-for-ui|sessionId|generation|exitCode/,
  );
  f.dispose();
});
it("refresh affects one context of a common tab and invalidates the previous generation", async () => {
  const f = await fixture(),
    target = { revision: f.initial.revision, tabId: f.initial.tabs[0].id };
  const first = await f.api.request({ kind: "open", scope: a, ...target });
  const second = await f.api.request({ kind: "open", scope: b, ...target });
  const preview = await f.api.request({
    kind: "prepare-refresh",
    scope: a,
    ...target,
    ref: { sessionId: first.sessionId, generation: first.generation },
  });
  const result = await f.api.request({
    kind: "confirm",
    token: preview.token,
    confirmed: true,
  });
  expect(result.status).toBe("success");
  expect(f.stopped).toHaveLength(1);
  expect(result.session?.sessionId).toBe(first.sessionId);
  expect(result.session?.generation).not.toBe(first.generation);
  expect(
    f.sessions.list().find((s) => s.sessionId === second.sessionId),
  ).toEqual(second);
  expect(() => f.sessions.write(first, "old")).toThrow();
  f.dispose();
});
it("persistence failure after stopping retains completed tab/screens and does not relaunch commands", async () => {
  const f = await fixture(),
    target = { revision: f.initial.revision, tabId: f.initial.tabs[0].id };
  await f.api.request({ kind: "open", scope: "p", ...target });
  const preview = await f.api.request({
    kind: "prepare-close",
    scope: "p",
    ...target,
  });
  const save = vi
    .spyOn(f.store, "save")
    .mockRejectedValueOnce(Error("synthetic unavailable storage"));
  const result = await f.api.request({
    kind: "confirm",
    token: preview.token,
    confirmed: true,
  });
  expect(result.status).toBe("partial");
  expect(result.completed).toHaveLength(1);
  expect((await f.catalog.read("p")).tabs).toHaveLength(1);
  expect(f.sessions.list()[0].state).toBe("exited");
  await f.api.request({ kind: "open", scope: "p", ...target });
  expect(f.ptys).toHaveLength(1);
  save.mockRestore();
  f.dispose();
});
