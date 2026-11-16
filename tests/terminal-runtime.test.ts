import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createTerminalRuntime } from "../src/main/terminal-runtime";
import type { ScopeRef } from "../src/shared/context";
import type { TerminalContext } from "../src/shared/terminal";
import type {
  TerminalTransportView,
  TerminalTransportSource,
} from "../src/host/terminal-transport";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
const topic = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const owner = (scope: ScopeRef): TerminalContext => {
  if (typeof scope === "string") return { kind: "primary", projectId: scope };
  const { revision, ...o } = scope;
  return { kind: "topic", ...o };
};
class Native extends EventEmitter {
  constructor(readonly pid: number) {
    super();
  }
  pause = vi.fn();
  resume = vi.fn();
  write = vi.fn();
  resize = vi.fn();
  onData(fn: (s: string) => void) {
    this.on("data", fn);
    return {
      dispose: () => {
        this.off("data", fn);
      },
    };
  }
  onExit(fn: (e: { exitCode: number }) => void) {
    this.on("exit", fn);
    return {
      dispose: () => {
        this.off("exit", fn);
      },
    };
  }
}
async function setup() {
  const home = await mkdtemp("/private/tmp/goga-terminal-runtime-");
  dirs.push(home);
  const natives: Native[] = [],
    sources: TerminalTransportSource[] = [];
  const release = vi.fn();
  const host = {
    setTerminalDeletionController: vi.fn(),
    resolveTerminalOwner: vi.fn(async (scope: ScopeRef) => owner(scope)),
    acquireTerminalContext: vi.fn(async (scope: ScopeRef) => ({
      release,
      launch: {
        context: owner(scope),
        cwd: home,
        shell: "/bin/zsh",
        args: ["-l", "-i"],
        env: { SECRET: "synthetic-secret" },
        verifyRoot: async () => {},
      },
    })),
  };
  const identity = (pid: number) => ({
    pid,
    ppid: 100,
    pgid: pid,
    sid: pid,
    uid: 501,
    tty: pid,
    startSec: 1000,
    startUsec: pid,
    status: 2,
  });
  const inspector = {
    check: vi.fn(),
    birth: (pid: number) => {
      const { pgid, sid, tty, status, ...b } = identity(pid);
      return b;
    },
    root: identity,
    snapshot: (pid: number) => ({
      ok: true,
      stable: true,
      uncertain: 0,
      root: identity(pid),
      members: [identity(pid)],
    }),
  };
  const driver = {
    spawn: vi.fn(() => {
      const n = new Native(200 + natives.length);
      natives.push(n);
      return n;
    }),
  };
  const signal = vi.fn((pid: number) => {
    natives.find((n) => n.pid === pid)!.emit("exit", { exitCode: 0 });
  });
  const view: TerminalTransportView = {
    isLost: false,
    whenReady: async () => {},
    attach: (ref, source) => {
      sources.push(source);
      return { ...ref, capability: crypto.randomUUID() };
    },
    output: vi.fn(() => true),
    status: () => ({ pendingBytes: 0, paused: false, state: "live" }),
    fail: vi.fn(),
    exited: vi.fn(),
    remove: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
  const createView = vi.fn(() => view);
  const options = {
    home,
    host,
    driver,
    inspector,
    system: { platform: "darwin", parentPid: 100, uid: 501, signal },
    createView,
  };
  return {
    runtime: createTerminalRuntime(options),
    options,
    host,
    driver,
    inspector,
    createView,
    natives,
    sources,
    release,
    signal,
    view,
  };
}
async function initialized(f: Awaited<ReturnType<typeof setup>>) {
  const before = await f.runtime.catalog.read("p");
  return f.runtime.catalog.change({
    kind: "initialize",
    scope: "p",
    revision: before.revision,
  });
}
it("composes lazily: construction and persisted catalog operations never launch a shell or inspect processes", async () => {
  const f = await setup();
  expect(f.host.setTerminalDeletionController).toHaveBeenCalledWith(
    f.runtime.sessions,
  );
  expect(f.host.resolveTerminalOwner).not.toHaveBeenCalled();
  const state = await initialized(f);
  expect(state.tabs.map((t) => t.name)).toEqual(["console"]);
  expect(f.driver.spawn).not.toHaveBeenCalled();
  expect(f.inspector.check).not.toHaveBeenCalled();
  expect(f.createView).not.toHaveBeenCalled();
  const restored = createTerminalRuntime(f.options),
    again = await restored.catalog.read("p");
  expect(again.tabs).toEqual(state.tabs);
  expect(restored.sessions.list()).toEqual([]);
  expect(f.driver.spawn).not.toHaveBeenCalled();
});
it("binds common sessions to exact host context, routes output/input, and reuses without changing cwd", async () => {
  const f = await setup(),
    state = await initialized(f),
    tab = state.tabs[0];
  const p = await f.runtime.sessions.open(tab, "p"),
    a = await f.runtime.sessions.open(tab, topic);
  expect(a.generation).not.toBe(p.generation);
  expect(f.natives).toHaveLength(2);
  expect(f.host.acquireTerminalContext.mock.calls.map((c) => c[0])).toEqual([
    "p",
    topic,
  ]);
  f.sources[0].input("cd child\r");
  expect(f.natives[0].write).toHaveBeenCalledWith("cd child\r");
  f.natives[1].emit("data", "topic output");
  expect(f.view.output).toHaveBeenCalledWith(
    expect.objectContaining({ generation: a.generation }),
    "topic output",
  );
  expect((await f.runtime.sessions.open(tab, "p")).generation).toBe(
    p.generation,
  );
  expect(f.natives).toHaveLength(2);
  expect(f.signal).not.toHaveBeenCalled();
  const preview = f.runtime.sessions.prepareClose({ kind: "exit" });
  expect(
    (await f.runtime.sessions.confirmClose(preview.token, true)).status,
  ).toBe("success");
});
it("common close durably removes the tab only after all its native exits; bound metadata survives", async () => {
  const f = await setup();
  let state = await initialized(f);
  const common = state.tabs[0];
  state = await f.runtime.catalog.change({
    kind: "create",
    scope: topic,
    revision: state.revision,
    area: "context",
  });
  const bound = state.tabs.find((t) => t.id !== common.id)!;
  await f.runtime.sessions.open(common, "p");
  await f.runtime.sessions.open(common, topic);
  const a = await f.runtime.sessions.open(bound, topic);
  const before = f.runtime.sessions.prepareClose({ kind: "tab", tab: common });
  expect((await f.runtime.catalog.read(topic)).tabs).toHaveLength(2);
  expect(
    (await f.runtime.sessions.confirmClose(before.token, true)).status,
  ).toBe("success");
  expect(f.signal).toHaveBeenCalledTimes(2);
  expect(f.release).toHaveBeenCalledTimes(2);
  expect((await f.runtime.catalog.read("p")).tabs).toEqual([]);
  expect((await f.runtime.catalog.read(topic)).tabs.map((t) => t.id)).toEqual([
    bound.id,
  ]);
  expect(f.runtime.sessions.list().map((s) => s.generation)).toEqual([
    a.generation,
  ]);
  const exit = f.runtime.sessions.prepareClose({ kind: "exit" });
  await f.runtime.sessions.confirmClose(exit.token, true);
  expect(
    (await createTerminalRuntime(f.options).catalog.read(topic)).tabs.map(
      (t) => t.id,
    ),
  ).toEqual([bound.id]);
});
it("rejects a changed owner before native startup and keeps persisted metadata", async () => {
  const f = await setup(),
    state = await initialized(f);
  f.host.acquireTerminalContext.mockRejectedValueOnce(
    Error("synthetic-secret"),
  );
  await expect(f.runtime.sessions.open(state.tabs[0], "p")).rejects.toThrow(
    "terminal:context",
  );
  expect(f.driver.spawn).not.toHaveBeenCalled();
  expect((await f.runtime.catalog.read("p")).tabs).toEqual(state.tabs);
});
it("uses asynchronous inspector preparation when restoring a persisted terminal tab", async () => {
  const f = await setup();
  const state = await initialized(f);
  let ready!: () => void;
  const prepare = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  (f.inspector as any).prepare = prepare;
  const opening = f.runtime.sessions.open(state.tabs[0], "p");
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
  expect(f.driver.spawn).not.toHaveBeenCalled();
  ready();
  expect((await opening).state).toBe("running");
  expect(f.driver.spawn).toHaveBeenCalledTimes(1);
  const close = f.runtime.sessions.prepareClose({ kind: "exit" });
  expect(
    (await f.runtime.sessions.confirmClose(close.token, true)).status,
  ).toBe("success");
});

it("keeps preset env snapshots across edits, deletion, refresh and Desktop restart, without reissuing commands", async () => {
  const f = await setup();
  // Inject only in this synthetic test; no system keychain, native process or socket.
  const cryptoProvider = {
    seal: (s: string) => Buffer.from(s).toString("base64"),
    open: (s: string) => Buffer.from(s, "base64").toString(),
  };
  const seen: string[] = [];
  const options = {
    ...f.options,
    presetCrypto: cryptoProvider,
    preparePreset: async (
      launch: import("../src/host/terminal-environment").TerminalLaunch,
      cmd: string,
    ) => {
      seen.push(cmd);
      return {
        launch,
        result: Promise.resolve("delivered" as const),
        arm: () => {},
        dispose: () => {},
      };
    },
  };
  const runtime = createTerminalRuntime(options),
    store = runtime.presetStore!;
  const create = async (
    port: string,
    item?: Awaited<ReturnType<typeof store.read>>,
  ) => {
    const saved = await store.save(
      {
        name: "Dev",
        command: "echo synthetic",
        env: [{ key: "PORT", value: port }],
      },
      item?.id,
      item?.revision,
    );
    const s = await runtime.catalog.change({
      kind: "create-from-preset",
      scope: topic,
      revision: (await runtime.catalog.read(topic)).revision,
      presetId: saved.id,
      presetRevision: saved.revision,
      actionId: crypto.randomUUID(),
    });
    return { saved, tab: s.tabs.find((t) => t.id === s.selectedId)! };
  };
  const a = await create("4100"),
    b = await create("4200", a.saved);
  await store.remove(b.saved.id, b.saved.revision);
  expect(seen).toEqual(["echo synthetic", "echo synthetic"]);
  const first = await runtime.sessions.open(a.tab, topic);
  const ticket = runtime.sessions.prepareClose({
    kind: "refresh",
    scope: topic,
    ref: first,
  });
  expect((await runtime.sessions.confirmClose(ticket.token, true)).status).toBe(
    "success",
  );
  const driver2 = createTerminalRuntime(options);
  const restored = (await driver2.catalog.read(topic)).tabs.find(
    (t) => t.id === a.tab.id,
  )!;
  await driver2.sessions.open(restored, topic);
  expect(seen).toHaveLength(2);
  expect(
    f.host.acquireTerminalContext.mock.calls.map((c) => (c as unknown[])[1]),
  ).toEqual(
    ["4100", "4200", "4100", "4100"].map((value) => ({
      presetEnv: [{ key: "PORT", value }],
    })),
  );
  expect((await driver2.catalog.read("p")).tabs).toEqual([]);
});
