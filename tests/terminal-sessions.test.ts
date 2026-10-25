import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  TerminalSessions,
  type TerminalPty,
  type TerminalLease,
} from "../src/host/terminal-sessions";
import type { TerminalTab, TerminalContext } from "../src/shared/terminal";
import type { ScopeRef } from "../src/shared/context";
const primary: TerminalContext = { kind: "primary", projectId: "p" };
const a = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
};
const b = { ...a, topic: "b", branch: "b", contextId: `ctx-${"b".repeat(64)}` };
const common: TerminalTab = {
  id: "t",
  projectId: "p",
  name: "console",
  scope: { kind: "common" },
};
function context(scope: ScopeRef): TerminalContext {
  if (typeof scope === "string") return { kind: "primary", projectId: scope };
  const { revision: _, ...identity } = scope;
  return { kind: "topic", ...identity };
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
  onData(listener: (data: string) => void) {
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
  exit() {
    this.emit("exit", { exitCode: 0 });
  }
}
function fixture() {
  const leases: TerminalLease[] = [],
    ptys: Pty[] = [];
  const acquire = vi.fn(async (scope: ScopeRef): Promise<TerminalLease> => {
    const lease: TerminalLease = {
      release: vi.fn(),
      launch: {
        context: context(scope),
        cwd: "/synthetic",
        shell: "/bin/zsh",
        args: ["-l", "-i"],
        env: { SECRET: "synthetic-secret", ENV_VERSION: String(leases.length) },
        verifyRoot: vi.fn(async () => {}),
        activity: { idle: vi.fn(() => true), input: vi.fn() },
      },
    };
    leases.push(lease);
    return lease;
  });
  const spawn = vi.fn((_launch: TerminalLease["launch"]) => {
    const pty = new Pty();
    ptys.push(pty);
    return pty;
  });
  const stop = vi.fn(async (pty: TerminalPty) => {
    (pty as Pty).exit();
  });
  const output = vi.fn();
  const screens: any[] = [];
  const prepareScreen = vi.fn(async (ref: any, lost: () => void) => {
    const screen = {
      assertReady: vi.fn(),
      bind: vi.fn(),
      output: vi.fn((text: string) => output(ref, text)),
      exited: vi.fn(),
      drainAfterHangup: vi.fn(),
      finishClose: vi.fn(),
      dispose: vi.fn(),
      fail: vi.fn(),
      lost,
    };
    screens.push(screen);
    return screen;
  });
  const processes = (pty: TerminalPty) => ({
    prepare: () => ({ anchor: {} as any, jobs: [] }),
    validate: () => {},
    stop: async () => stop(pty),
  });
  return {
    manager: new TerminalSessions({
      acquire,
      spawn,
      processes,
      prepareScreen,
      removeTab: async () => {},
    }),
    acquire,
    spawn,
    stop,
    output,
    screens,
    prepareScreen,
    leases,
    ptys,
  };
}
async function refresh(
  manager: TerminalSessions,
  ref: Parameters<TerminalSessions["write"]>[0],
  scope: ScopeRef,
) {
  const preview = manager.prepareClose({ kind: "refresh", ref, scope });
  const result = await manager.confirmClose(preview.token, true);
  if (result.status !== "success") throw Error(result.message);
  return result.session!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
it("lazily deduplicates concurrent common-tab opens and separates topic/primary sessions", async () => {
  const f = fixture();
  expect(f.spawn).not.toHaveBeenCalled();
  const [first, same] = await Promise.all([
    f.manager.open(common, a),
    f.manager.open(common, a),
  ]);
  expect(first).toEqual(same);
  expect(first.state).toBe("running");
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const second = await f.manager.open(common, b),
    base = await f.manager.open(common, "p");
  expect(
    new Set([first.sessionId, second.sessionId, base.sessionId]).size,
  ).toBe(3);
  expect(f.spawn).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(first)).not.toMatch(/synthetic-secret|env|shell|cwd/);
});
it("returning to a topic preserves the PTY and ignores revision changes", async () => {
  const f = fixture();
  const original = await f.manager.open(common, a);
  await f.manager.open(common, b);
  expect(
    await f.manager.open(common, {
      ...a,
      revision: "00000000-0000-4000-8000-000000000002",
    }),
  ).toEqual(original);
  expect(f.acquire).toHaveBeenCalledTimes(2);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.ptys[0].write).not.toHaveBeenCalled();
});
it("rejects invisible or foreign tabs before acquiring a root", async () => {
  const f = fixture();
  const bound: TerminalTab = {
    ...common,
    scope: { kind: "context", context: context(a) },
  };
  for (const scope of [b, "p", "other"])
    await expect(f.manager.open(bound, scope)).rejects.toThrow(/вкладк/);
  await expect(f.manager.open(common, "other")).rejects.toThrow(/вкладк/);
  expect(f.acquire).not.toHaveBeenCalled();
  expect((await f.manager.open(bound, a)).context).toEqual(context(a));
});
it("keeps completed session and releases its lease without respawning on open", async () => {
  const f = fixture();
  const original = await f.manager.open(common, a);
  f.ptys[0].exit();
  const completed = await f.manager.open(common, a);
  expect(completed).toMatchObject({
    sessionId: original.sessionId,
    state: "exited",
    exitCode: 0,
  });
  expect(f.leases[0].release).toHaveBeenCalledTimes(1);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(() => f.manager.write(completed, "x")).toThrow();
});
it("releases a failed spawn lease, hides native error details and permits retry", async () => {
  const f = fixture();
  f.spawn.mockImplementationOnce(() => {
    throw Error("synthetic-secret");
  });
  await expect(f.manager.open(common, a)).rejects.toThrow(
    "Не удалось запустить терминал",
  );
  expect(f.leases[0].release).toHaveBeenCalledTimes(1);
  expect((await f.manager.open(common, a)).state).toBe("running");
});
it("cancels pending acquisition without spawning or prematurely dropping protection", async () => {
  const f = fixture();
  const gate = deferred<TerminalLease>();
  const lease = await f.acquire(a);
  f.acquire.mockReturnValueOnce(gate.promise);
  const opening = f.manager.open(common, a);
  const outcome = expect(opening).rejects.toThrow(/отмен/);
  f.manager.cancelOpen(common, a);
  expect(lease.release).not.toHaveBeenCalled();
  gate.resolve(lease);
  await outcome;
  expect(lease.release).toHaveBeenCalledTimes(1);
  expect(f.spawn).not.toHaveBeenCalled();
  await f.manager.open(common, a);
  expect(f.spawn).toHaveBeenCalledTimes(1);
});
it("revalidates pinned root before spawning and on return without redirecting input", async () => {
  const f = fixture();
  const lease = await f.acquire(a);
  vi.mocked(lease.launch.verifyRoot).mockRejectedValue(Error("replaced"));
  f.acquire.mockResolvedValueOnce(lease);
  await expect(f.manager.open(common, a)).rejects.toThrow();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(lease.release).toHaveBeenCalledOnce();
  const first = await f.manager.open(common, a);
  vi.mocked(f.leases[1].launch.verifyRoot).mockRejectedValue(Error("removed"));
  await expect(f.manager.open(common, a)).rejects.toThrow();
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.leases[1].release).not.toHaveBeenCalled();
  expect(() => f.manager.write(first, "test")).toThrow();
});
it("refreshes only selected session with fresh generation/environment and rejects late input", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a),
    other = await f.manager.open(common, b);
  const next = await refresh(f.manager, first, a);
  expect(next.sessionId).toBe(first.sessionId);
  expect(next.generation).not.toBe(first.generation);
  expect(f.stop).toHaveBeenCalledExactlyOnceWith(f.ptys[0]);
  expect(f.acquire).toHaveBeenCalledTimes(3);
  expect(f.spawn.mock.calls[0]?.[0]?.env.ENV_VERSION).toBe("0");
  expect(f.spawn.mock.calls[2]?.[0]?.env.ENV_VERSION).toBe("2");
  expect(await f.manager.open(common, b)).toEqual(other);
  expect(() => f.manager.write(first, "late")).toThrow();
  expect(() => f.manager.resize(first, 80, 24)).toThrow();
  f.ptys[0].emit("data", "late");
  f.ptys[0].exit();
  expect(f.output).not.toHaveBeenCalled();
  f.manager.write(next, "new");
  f.manager.resize(next, 111, 37);
  expect(f.ptys[2].write).toHaveBeenCalledExactlyOnceWith("new");
  expect(f.ptys[2].resize).toHaveBeenCalledExactlyOnceWith(111, 37);
});
it("failed stop does not refresh or drop the live lease", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  f.stop.mockRejectedValueOnce(Error("synthetic-secret"));
  await expect(refresh(f.manager, first, a)).rejects.toThrow(
    /останов|операци|принадлежност/i,
  );
  expect(f.acquire).toHaveBeenCalledTimes(1);
  expect(f.leases[0].release).not.toHaveBeenCalled();
  expect((await f.manager.open(common, a)).state).toBe("running");
});
it("requires confirmed exit even if a stop adapter reports success", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  f.stop.mockResolvedValueOnce(undefined);
  await expect(refresh(f.manager, first, a)).rejects.toThrow(
    /останов|операци|принадлежност/i,
  );
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.leases[0].release).not.toHaveBeenCalled();
});
it("rejects duplicate refresh and input during stop", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  const gate = deferred<void>();
  f.stop.mockImplementationOnce(async () => {
    await gate.promise;
    f.ptys[0].exit();
  });
  const refreshing = refresh(f.manager, first, a);
  await expect(refresh(f.manager, first, a)).rejects.toThrow();
  expect(() => f.manager.write(first, "x")).toThrow();
  gate.resolve();
  await refreshing;
});
it("routes background output by exact session generation, not the selected context", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a),
    other = await f.manager.open(common, b);
  f.ptys[0].emit("data", "A");
  f.ptys[1].emit("data", "B");
  expect(f.output.mock.calls).toEqual([
    [{ sessionId: first.sessionId, generation: first.generation }, "A"],
    [{ sessionId: other.sessionId, generation: other.generation }, "B"],
  ]);
});
it("does not release a live PTY when transport subscription fails", async () => {
  const f = fixture();
  const bad = new Pty();
  bad.onData = () => {
    throw Error("transport failure");
  };
  f.spawn.mockReturnValueOnce(bad);
  await expect(f.manager.open(common, a)).rejects.toThrow();
  expect(f.leases[0].release).not.toHaveBeenCalled();
  await expect(f.manager.open(common, a)).rejects.toThrow(/транспорт/);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  bad.exit();
  expect(f.leases[0].release).toHaveBeenCalledTimes(1);
});
it("failed replacement spawn retains the old completed screen reference", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  f.spawn.mockImplementationOnce(() => {
    throw Error("failure");
  });
  await expect(refresh(f.manager, first, a)).rejects.toThrow();
  expect(await f.manager.open(common, a)).toMatchObject({
    sessionId: first.sessionId,
    generation: first.generation,
    state: "exited",
  });
  expect(f.leases[1].release).toHaveBeenCalledTimes(1);
});
it("validates input byte limits and resize bounds before reaching PTY", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  expect(() => f.manager.write(first, "😀".repeat(17000))).toThrow();
  for (const [cols, rows] of [
    [0, 24],
    [80, 0],
    [1001, 30],
    [80.5, 24],
  ])
    expect(() => f.manager.resize(first, cols, rows)).toThrow();
  expect(f.ptys[0].write).not.toHaveBeenCalled();
  expect(f.ptys[0].resize).not.toHaveBeenCalled();
});
it("rejects a foreign lease before spawn", async () => {
  const f = fixture();
  const foreign = await f.acquire(b);
  f.acquire.mockResolvedValueOnce(foreign);
  await expect(f.manager.open(common, a)).rejects.toThrow();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(foreign.release).toHaveBeenCalledOnce();
});
it("refresh accepts a fresh revision only for the same stable context", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  await expect(refresh(f.manager, first, b)).rejects.toThrow(/контекст/);
  expect(f.stop).not.toHaveBeenCalled();
  const fresh = { ...a, revision: "00000000-0000-4000-8000-000000000009" };
  await refresh(f.manager, first, fresh);
  expect(f.acquire).toHaveBeenLastCalledWith(fresh);
});
it("cancels while root verification is pending, keeping the lease until it settles", async () => {
  const f = fixture();
  const lease = await f.acquire(a);
  const gate = deferred<void>();
  const entered = deferred<void>();
  vi.mocked(lease.launch.verifyRoot).mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
  });
  f.acquire.mockResolvedValueOnce(lease);
  const opening = f.manager.open(common, a);
  const outcome = expect(opening).rejects.toThrow(/отмен/);
  await entered.promise;
  f.manager.cancelOpen(common, a);
  expect(lease.release).not.toHaveBeenCalled();
  gate.resolve();
  await outcome;
  expect(f.spawn).not.toHaveBeenCalled();
  expect(lease.release).toHaveBeenCalledTimes(1);
});
it("returns detached view snapshots rather than mutable session authority", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  first.state = "exited";
  first.context.projectId = "foreign";
  const actual = await f.manager.open(common, a);
  expect(actual.state).toBe("running");
  expect(actual.context.projectId).toBe("p");
});
it("an in-flight root check cannot reopen a session after confirmed application exit", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  const gate = deferred<void>();
  vi.mocked(f.leases[0].launch.verifyRoot).mockImplementationOnce(
    () => gate.promise,
  );
  const returning = f.manager.open(common, a);
  const rejected = expect(returning).rejects.toThrow(/заверш/i);
  const preview = f.manager.prepareClose({ kind: "exit" });
  expect((await f.manager.confirmClose(preview.token, true)).status).toBe(
    "success",
  );
  gate.resolve();
  await rejected;
});

it("returns detached safe runtime inventory without PTY, env or cwd", async () => {
  const f = fixture();
  const opened = await f.manager.open(common, "p");
  const listed = f.manager.list();
  expect(listed).toEqual([opened]);
  listed[0].context.projectId = "tampered";
  expect(f.manager.list()[0].context.projectId).toBe("p");
  expect(JSON.stringify(f.manager.list())).not.toContain("synthetic-secret");
  expect(Object.keys(f.manager.list()[0]).sort()).toEqual(
    ["sessionId", "generation", "tabId", "context", "state"].sort(),
  );
});

it("notifies runtime changes without output/secrets and supports unsubscribe", async () => {
  const f = fixture(),
    changed = vi.fn();
  const unsubscribe = f.manager.onChanged(changed);
  await f.manager.open(common, "p");
  expect(changed).toHaveBeenCalled();
  expect(changed.mock.calls.every((args) => args.length === 0)).toBe(true);
  changed.mockClear();
  f.ptys[0].exit();
  expect(changed).toHaveBeenCalled();
  unsubscribe();
  changed.mockClear();
  await f.manager.open(common, a);
  expect(changed).not.toHaveBeenCalled();
});

it("waits for screen preparation before spawn and revalidates the root afterwards", async () => {
  const f = fixture(),
    gate = deferred<void>(),
    entered = deferred<void>();
  const implementation = f.prepareScreen.getMockImplementation()!;
  f.prepareScreen.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await gate.promise;
    return implementation(...args);
  });
  const opening = f.manager.open(common, a);
  await entered.promise;
  expect(f.spawn).not.toHaveBeenCalled();
  vi.mocked(f.leases[0].launch.verifyRoot).mockRejectedValueOnce(
    Error("replaced during screen load"),
  );
  gate.resolve();
  await expect(opening).rejects.toThrow();
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.screens[0].dispose).toHaveBeenCalledOnce();
  expect(f.leases[0].release).toHaveBeenCalledOnce();
});
it("cancellation while waiting for the screen never spawns a shell", async () => {
  const f = fixture(),
    gate = deferred<void>(),
    entered = deferred<void>();
  const implementation = f.prepareScreen.getMockImplementation()!;
  f.prepareScreen.mockImplementationOnce(async (...args) => {
    entered.resolve();
    await gate.promise;
    return implementation(...args);
  });
  const opening = f.manager.open(common, a);
  await entered.promise;
  f.manager.cancelOpen(common, a);
  gate.resolve();
  await expect(opening).rejects.toThrow(/отмен/);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.screens[0].dispose).toHaveBeenCalledOnce();
});
it("screen loss blocks input but retains ownership until observed exit and explicit refresh", async () => {
  const f = fixture();
  const ref = await f.manager.open(common, a);
  f.screens[0].lost();
  expect(f.manager.list()[0]).toMatchObject({
    state: "running",
    screen: "lost",
  });
  expect(() => f.manager.write(ref, "unsafe")).toThrow();
  expect(f.leases[0].release).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
  await expect(f.manager.open(common, a)).rejects.toThrow(/транспорт/);
  const next = await refresh(f.manager, ref, a);
  expect(next.generation).not.toBe(ref.generation);
  expect(f.screens[0].exited).toHaveBeenCalledOnce();
  expect(f.screens[0].dispose).toHaveBeenCalledOnce();
  f.screens[0].lost();
  expect(f.manager.list()[0].screen).toBeUndefined();
  f.manager.write(next, "safe");
});
it("output errors become a visible transport failure, not an uncaught event or automatic restart", async () => {
  const f = fixture();
  const ref = await f.manager.open(common, a);
  f.screens[0].output.mockImplementation(() => {
    throw Error("synthetic-secret");
  });
  expect(() => f.ptys[0].emit("data", "first")).not.toThrow();
  expect(f.manager.list()[0]).toMatchObject({
    screen: "lost",
    state: "running",
  });
  expect(() => f.manager.write(ref, "unsafe")).toThrow();
  expect(f.ptys[0].pause).toHaveBeenCalled();
  expect(f.leases[0].release).not.toHaveBeenCalled();
  expect(JSON.stringify(f.manager.list())).not.toContain("synthetic-secret");
});
it("binds before first output, retains completed screen and disposes it only after saved tab removal", async () => {
  const f = fixture();
  const ref = await f.manager.open(common, a);
  expect(f.screens[0].bind).toHaveBeenCalledOnce();
  const source = f.screens[0].bind.mock.calls[0][0];
  source.input("input");
  source.resize(90, 30);
  source.pause();
  source.resume();
  expect(f.ptys[0].write).toHaveBeenCalledWith("input");
  expect(f.ptys[0].pause).toHaveBeenCalledOnce();
  f.ptys[0].emit("data", "final");
  f.ptys[0].exit();
  expect(f.screens[0].exited).toHaveBeenCalledOnce();
  expect(f.screens[0].dispose).not.toHaveBeenCalled();
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  expect((await f.manager.confirmClose(preview.token, true)).status).toBe(
    "success",
  );
  expect(f.screens[0].dispose).toHaveBeenCalledOnce();
  expect(() => source.input("late")).toThrow();
});

it("native source faults revoke input and expose safe state without releasing a live lease", async () => {
  const f = fixture(),
    ref = await f.manager.open(common, a);
  f.ptys[0].emit("fault");
  expect(f.manager.list()[0]).toMatchObject({
    screen: "lost",
    state: "running",
  });
  expect(() => f.manager.write(ref, "unsafe")).toThrow();
  expect(f.leases[0].release).not.toHaveBeenCalled();
});

it("defers only the latest resize during shutdown and applies it after cancellation without replaying input", async () => {
  const f = fixture(),
    ref = await f.manager.open(common, a);
  const lease = await f.manager.prepareShutdown();
  expect(() => f.manager.resize(ref, 100, 30)).not.toThrow();
  expect(() => f.manager.resize(ref, 120, 40)).not.toThrow();
  expect(() => f.manager.write(ref, "must-not-replay")).toThrow();
  expect(f.ptys[0].resize).not.toHaveBeenCalled();
  lease.release();
  expect(f.ptys[0].resize).toHaveBeenCalledExactlyOnceWith(120, 40);
  expect(f.ptys[0].write).not.toHaveBeenCalled();
  f.manager.write(ref, "after-cancel");
  expect(f.ptys[0].write).toHaveBeenCalledExactlyOnceWith("after-cancel");
  expect(f.manager.list()[0].screen).toBeUndefined();
});

it("discards a pending resize when the PTY exits during shutdown", async () => {
  const f = fixture(),
    ref = await f.manager.open(common, a);
  const lease = await f.manager.prepareShutdown();
  expect(() => f.manager.resize(ref, 120, 40)).not.toThrow();
  f.ptys[0].exit();
  lease.release();
  expect(f.ptys[0].resize).not.toHaveBeenCalled();
});

it("holds resize through a stop in progress and flushes after a failed stop", async () => {
  const f = fixture(),
    ref = await f.manager.open(common, a),
    pending = deferred<void>();
  f.stop.mockImplementationOnce(async () => {
    await pending.promise;
    throw Error("refused");
  });
  const lease = await f.manager.prepareShutdown();
  const stopping = lease.stop();
  await vi.waitFor(() => expect(f.manager.list()[0].state).toBe("stopping"));
  expect(() => f.manager.resize(ref, 123, 45)).not.toThrow();
  pending.resolve();
  await expect(stopping).rejects.toThrow();
  expect(f.ptys[0].resize).not.toHaveBeenCalled();
  lease.release();
  expect(f.ptys[0].resize).toHaveBeenCalledExactlyOnceWith(123, 45);
});

it("returns to the same live sessions and screens across two projects without respawning", async () => {
  const f = fixture();
  const first = await f.manager.open(common, "p");
  const other = { ...common, id: "other-tab", projectId: "q" };
  const second = await f.manager.open(other, "q");
  f.ptys[0].emit("data", "background output");
  const returned = await f.manager.open(common, "p");
  expect(returned.sessionId).toBe(first.sessionId);
  expect(returned.generation).toBe(first.generation);
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  expect(f.prepareScreen).toHaveBeenCalledTimes(2);
  expect(f.screens[0].output).toHaveBeenCalledWith("background output");
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.screens[0].dispose).not.toHaveBeenCalled();
});
it("presentation verifies an existing pinned root and generation without creating sessions", async () => {
  const f = fixture();
  await expect(
    f.manager.verifyPresentation(common, a, {
      sessionId: "missing",
      generation: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
  expect(f.spawn).not.toHaveBeenCalled();
  const first = await f.manager.open(common, a);
  const calls = vi.mocked(f.leases[0].launch.verifyRoot).mock.calls.length;
  await f.manager.verifyPresentation(common, a, first);
  expect(f.leases[0].launch.verifyRoot).toHaveBeenCalledTimes(calls + 1);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  await expect(
    f.manager.verifyPresentation(common, a, {
      ...first,
      generation: crypto.randomUUID(),
    }),
  ).rejects.toThrow();
  vi.mocked(f.leases[0].launch.verifyRoot).mockRejectedValue(Error("replaced"));
  await expect(f.manager.verifyPresentation(common, a, first)).rejects.toThrow(
    /Рабочая папка/,
  );
  expect(() => f.manager.write(first, "input")).toThrow();
  expect(f.spawn).toHaveBeenCalledTimes(1);
});

it("switching a live screen validates its existing lease without filesystem work", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  vi.mocked(f.leases[0].launch.verifyRoot).mockClear();
  f.manager.assertPresentation(first);
  f.manager.write(first, "echo ready\r");
  expect(f.leases[0].launch.verifyRoot).not.toHaveBeenCalled();
  expect(f.ptys[0].write).toHaveBeenCalledWith("echo ready\r");
  expect(() =>
    f.manager.assertPresentation({ ...first, generation: "unknown" }),
  ).toThrow();
  f.ptys[0].emit("fault");
  expect(() => f.manager.assertPresentation(first)).toThrow();
});

it("gates and closes only idle sessions of the deleted context, preserving common tabs elsewhere", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  const other = await f.manager.open(common, b);
  const base = await f.manager.open(common, "p");
  expect(f.manager.inspectIdleContext(a)).toBe(1);
  const gate = f.manager.prepareContextDeletion(a);
  expect(f.stop).not.toHaveBeenCalled();
  await expect(f.manager.open(common, a)).rejects.toThrow();
  expect(() => f.manager.write(first, "echo nope\r")).toThrow();
  await gate.stopIdle();
  expect(f.leases[0].release).toHaveBeenCalledOnce();
  expect(
    f.manager.list().find((v) => v.sessionId === first.sessionId)?.state,
  ).toBe("exited");
  expect(
    f.manager
      .list()
      .filter((v) => v.state === "running")
      .map((v) => v.sessionId),
  ).toEqual([other.sessionId, base.sessionId]);
  expect(f.stop).toHaveBeenCalledTimes(1);
  expect(await f.manager.open(common, b)).toEqual(other);
  gate.release();
});

it("blocks deletion for jobs or uncertain ownership, without stopping a shell", async () => {
  const f = fixture();
  const view = await f.manager.open(common, a);
  const entry = [...(f.manager as any).entries.values()][0];
  entry.control.prepare = () => ({ anchor: {}, jobs: [{}] });
  expect(() => f.manager.inspectIdleContext(a)).toThrow(/команд/);
  expect(() => f.manager.prepareContextDeletion(a)).toThrow(/команд/);
  expect(f.stop).not.toHaveBeenCalled();
  entry.control.prepare = () => {
    throw Error("unknown owner");
  };
  expect(() => f.manager.inspectIdleContext(a)).toThrow();
  expect(f.manager.list()[0].sessionId).toBe(view.sessionId);
});

it("revalidates idle plans for every session before closing the first shell", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  await f.manager.open({ ...common, id: "second" }, a);
  const gate = f.manager.prepareContextDeletion(a);
  const entries = [...(f.manager as any).entries.values()];
  entries[1].control.validate = () => {
    throw Error("new job");
  };
  await expect(gate.stopIdle()).rejects.toThrow("new job");
  expect(f.stop).not.toHaveBeenCalled();
  gate.release();
  expect(f.manager.inspectIdleContext(a)).toBe(2);
});

it("never treats an executing root command or unknown shell prompt as idle", async () => {
  const f = fixture();
  const view = await f.manager.open(common, a);
  f.leases[0].launch.activity!.idle = () => false;
  expect(() => f.manager.inspectIdleContext(a)).toThrow(/ожидан/);
  expect(f.stop).not.toHaveBeenCalled();
  delete f.leases[0].launch.activity;
  expect(() => f.manager.prepareContextDeletion(a)).toThrow(/ожидан/);
  expect(f.manager.list()[0].sessionId).toBe(view.sessionId);
});
it("invalidates prompt readiness before forwarding input and rechecks it before stopping", async () => {
  const f = fixture();
  const view = await f.manager.open(common, a);
  f.manager.write(view, "exec sleep 30\r");
  expect(f.leases[0].launch.activity!.input).toHaveBeenCalledWith(
    "exec sleep 30\r",
  );
  const gate = f.manager.prepareContextDeletion(a);
  f.leases[0].launch.activity!.idle = () => false;
  await expect(gate.stopIdle()).rejects.toThrow(/ожидан/);
  expect(f.stop).not.toHaveBeenCalled();
  gate.release();
});
