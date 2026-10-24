import { expect, it, vi, type Mock } from "vitest";
import { EventEmitter } from "node:events";
import {
  TerminalSessions,
  type TerminalPty,
} from "../src/host/terminal-sessions";
import {
  TerminalProcessController,
  type TerminalProcessIdentity,
} from "../src/host/terminal-processes";
import type { ScopeRef } from "../src/shared/context";
import type { TerminalContext, TerminalTab } from "../src/shared/terminal";
import { TerminalCloseCoordinator } from "../src/host/terminal-close";
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
  id: "common",
  projectId: "p",
  name: "console",
  scope: { kind: "common" },
};
function context(scope: ScopeRef): TerminalContext {
  if (typeof scope === "string") return { kind: "primary", projectId: scope };
  const { revision: _, ...owner } = scope;
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
  exited = false;
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
  exit() {
    this.exited = true;
    this.emit("exit", { exitCode: 0 });
  }
}
function fixture() {
  const ptys: Pty[] = [],
    controls: {
      controller: TerminalProcessController;
      signal: Mock<(pid: number, signal: string) => void>;
      members: TerminalProcessIdentity[];
      shell: TerminalProcessIdentity;
      sleep: Mock<(ms: number) => Promise<void>>;
    }[] = [];
  const acquire = vi.fn(async (scope: ScopeRef) => ({
    release: vi.fn(),
    launch: {
      context: context(scope),
      cwd: "/synthetic",
      shell: "/bin/zsh",
      args: [],
      env: {},
      verifyRoot: async () => {},
    },
  }));
  const spawn = vi.fn(() => {
    const p = new Pty();
    ptys.push(p);
    return p;
  });
  const processes = (pty: TerminalPty) => {
    const pid = 100 + controls.length * 10;
    const shell: TerminalProcessIdentity = {
      pid,
      ppid: 1,
      pgid: pid,
      sid: pid,
      uid: 501,
      tty: pid,
      status: 2,
      startSec: 1000,
      startUsec: 1,
    };
    const members = [
      shell,
      { ...shell, pid: pid + 1, ppid: pid, pgid: pid + 1 },
    ];
    let now = 0;
    const signal = vi.fn((id: number, sig: string) => {
      if (sig === "SIGHUP") (pty as Pty).exit();
      else {
        const index = members.findIndex((p) => p.pid === id);
        if (index >= 0) members.splice(index, 1);
      }
    });
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const controller = new TerminalProcessController(shell, {
      read: () => ({
        ok: true,
        stable: true,
        uncertain: 0,
        root: shell,
        members,
      }),
      signal,
      exited: () => (pty as Pty).exited,
      sleep,
      now: () => now,
    });
    controls.push({ controller, signal, members, shell, sleep });
    return controller;
  };
  const removeTab = vi.fn(async (_tab: TerminalTab) => {});
  const manager = new TerminalSessions({
    acquire,
    spawn,
    processes,
    removeTab,
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
  });
  return { manager, acquire, spawn, ptys, controls, removeTab };
}
it("closing a common tab includes its primary/A/B sessions, not another tab", async () => {
  const f = fixture();
  const owned = await Promise.all([
    f.manager.open(common, "p"),
    f.manager.open(common, a),
    f.manager.open(common, b),
  ]);
  const other = await f.manager.open({ ...common, id: "other" }, a);
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  expect(preview.requiresConfirmation).toBe(true);
  expect(preview.sessions.map((s) => s.sessionId).sort()).toEqual(
    owned.map((s) => s.sessionId).sort(),
  );
  expect(preview.sessions.every((s) => s.jobCount === 1)).toBe(true);
  expect(JSON.stringify(preview)).not.toMatch(/"pid"|"env"|"cwd"|"anchor"/);
  const result = await f.manager.confirmClose(preview.token, true);
  expect(result.status).toBe("success");
  expect(result.completed).toHaveLength(3);
  expect(result.remaining).toEqual([]);
  expect(f.ptys.slice(0, 3).every((p) => p.exited)).toBe(true);
  expect(f.ptys[3].exited).toBe(false);
  f.manager.write(other, "alive");
});
it("closing a context-bound tab does not stop a common session in that topic", async () => {
  const f = fixture();
  const bound: TerminalTab = {
    ...common,
    id: "bound",
    scope: { kind: "context", context: context(a) },
  };
  await f.manager.open(bound, a);
  await f.manager.open(common, a);
  const preview = f.manager.prepareClose({ kind: "tab", tab: bound });
  expect(preview.sessions).toHaveLength(1);
  expect((await f.manager.confirmClose(preview.token, true)).status).toBe(
    "success",
  );
  expect(f.ptys[1].exited).toBe(false);
});
it("cancel and refusal do not stop anything, and tokens are one-use", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  const one = f.manager.prepareClose({ kind: "tab", tab: common });
  f.manager.cancelClose(one.token);
  await expect(f.manager.confirmClose(one.token, true)).rejects.toThrow(
    /подтвержден/i,
  );
  const two = f.manager.prepareClose({ kind: "exit" });
  await expect(f.manager.confirmClose(two.token, false)).rejects.toThrow(
    /подтвержден/i,
  );
  expect(f.controls[0].signal).not.toHaveBeenCalled();
  await expect(f.manager.confirmClose(two.token, true)).rejects.toThrow();
  const three = f.manager.prepareClose({ kind: "exit" });
  await f.manager.confirmClose(three.token, true);
  await expect(f.manager.confirmClose(three.token, true)).rejects.toThrow();
});
it("rechecks every session before the first signal; new jobs in the last session invalidate all", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  await f.manager.open(common, b);
  const preview = f.manager.prepareClose({ kind: "exit" });
  const last = f.controls[1];
  last.members.push({ ...last.shell, pid: 119, pgid: 119 });
  const result = await f.manager.confirmClose(preview.token, true);
  expect(result.status).toBe("failed");
  expect(result.completed).toEqual([]);
  for (const c of f.controls) expect(c.signal).not.toHaveBeenCalled();
  await f.manager.open(common, a);
});
it("new common-tab context session invalidates an earlier close preview", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  await f.manager.open(common, b);
  expect((await f.manager.confirmClose(preview.token, true)).status).toBe(
    "failed",
  );
  for (const c of f.controls) expect(c.signal).not.toHaveBeenCalled();
});
it("refresh selects exactly one generation and rejects replay after restart", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a),
    other = await f.manager.open(common, b);
  const preview = f.manager.prepareClose({
    kind: "refresh",
    ref: first,
    scope: a,
  });
  expect(preview.sessions).toHaveLength(1);
  const result = await f.manager.confirmClose(preview.token, true);
  expect(result.status).toBe("success");
  expect(result.session?.generation).not.toBe(first.generation);
  expect(result.session?.sessionId).toBe(first.sessionId);
  expect(await f.manager.open(common, b)).toEqual(other);
  expect(() =>
    f.manager.prepareClose({ kind: "refresh", ref: first, scope: a }),
  ).toThrow();
  expect(() => f.manager.write(first, "late")).toThrow();
});
it("freezes target opens and input during termination, without freezing unrelated tabs", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  const c = f.controls[0];
  let unblock!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => {
      unblock = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const original = c.signal.getMockImplementation()!;
  c.signal.mockImplementation((pid, sig) => {
    if (sig === "SIGHUP") original(pid, sig);
  });
  c.sleep.mockImplementationOnce(async () => {
    entered();
    await gate;
    c.members.splice(1);
  });
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  const closing = f.manager.confirmClose(preview.token, true);
  await started;
  expect(() => f.manager.write(first, "no")).toThrow();
  await expect(f.manager.open(common, b)).rejects.toThrow(/заверш|останов/i);
  await f.manager.open({ ...common, id: "other" }, b);
  unblock();
  expect((await closing).status).toBe("success");
});
it("timeout reports partial results, keeps tabs and releases locks without reviving completed sessions", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a),
    second = await f.manager.open(common, b);
  f.controls[1].signal.mockImplementation(() => {});
  const preview = f.manager.prepareClose({ kind: "exit" });
  const result = await f.manager.confirmClose(preview.token, true);
  expect(result.status).toBe("partial");
  expect(result.completed).toContainEqual({
    sessionId: first.sessionId,
    generation: first.generation,
  });
  expect(result.remaining).toContainEqual({
    sessionId: second.sessionId,
    generation: second.generation,
  });
  expect(result.message).toMatch(/5 секунд/);
  expect((await f.manager.open(common, a)).state).toBe("exited");
  expect((await f.manager.open(common, b)).state).toBe("running");
  expect(f.spawn).toHaveBeenCalledTimes(2);
});
it("idle close needs no confirmation and successful exit prevents new opens", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  f.controls[0].members.splice(1);
  const preview = f.manager.prepareClose({ kind: "exit" });
  expect(preview.requiresConfirmation).toBe(false);
  expect((await f.manager.confirmClose(preview.token, false)).status).toBe(
    "success",
  );
  await expect(f.manager.open(common, b)).rejects.toThrow(/заверш/i);
});
it("expired or forged token has no effects", async () => {
  let now = 0;
  const host = {
    report: vi.fn(() => []),
    targets: vi.fn(() => []),
    freeze: vi.fn(() => () => {}),
    stop: vi.fn(),
    complete: vi.fn(async () => undefined),
  };
  const coordinator = new TerminalCloseCoordinator(host, () => now);
  const preview = coordinator.prepare({ kind: "exit" });
  now = 60001;
  await expect(coordinator.confirm(preview.token, true)).rejects.toThrow();
  await expect(coordinator.confirm("forged", true)).rejects.toThrow();
  expect(host.freeze).not.toHaveBeenCalled();
  expect(host.stop).not.toHaveBeenCalled();
  expect(host.complete).not.toHaveBeenCalled();
});
it("reports the new live generation when replacement transport fails after the old session exited", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  const bad = new Pty();
  bad.onData = () => {
    throw Error("transport");
  };
  f.spawn.mockImplementationOnce(() => {
    f.ptys.push(bad);
    return bad;
  });
  const preview = f.manager.prepareClose({
    kind: "refresh",
    ref: first,
    scope: a,
  });
  const result = await f.manager.confirmClose(preview.token, true);
  expect(result.status).toBe("partial");
  expect(result.completed).toContainEqual({
    sessionId: first.sessionId,
    generation: first.generation,
  });
  expect(result.remaining).toHaveLength(1);
  expect(result.remaining[0].sessionId).toBe(first.sessionId);
  expect(result.remaining[0].generation).not.toBe(first.generation);
  expect(bad.exited).toBe(false);
  bad.exit();
});
it("failed persistence keeps completed sessions rather than restarting the still-visible tab", async () => {
  const f = fixture();
  f.removeTab.mockRejectedValueOnce(Error("fixture persistence failure"));
  const first = await f.manager.open(common, a);
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  await f.manager.confirmClose(preview.token, true);
  expect(await f.manager.open(common, a)).toMatchObject({
    sessionId: first.sessionId,
    state: "exited",
  });
  expect(f.spawn).toHaveBeenCalledTimes(1);
});
it("an idle preview cannot silently terminate a job started before confirmation", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  const c = f.controls[0];
  const job = c.members.pop()!;
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  expect(preview.requiresConfirmation).toBe(false);
  c.members.push(job);
  expect((await f.manager.confirmClose(preview.token, false)).status).toBe(
    "failed",
  );
  expect(c.signal).not.toHaveBeenCalled();
});
it("preview mutation cannot replace the host's frozen process plan", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  const preview = f.manager.prepareClose({ kind: "exit" });
  preview.requiresConfirmation = false;
  preview.sessions.length = 0;
  await expect(f.manager.confirmClose(preview.token, false)).rejects.toThrow();
  expect(f.controls[0].signal).not.toHaveBeenCalled();
});
it("tab metadata removal happens only after every target has exited", async () => {
  const f = fixture();
  const first = await f.manager.open(common, a);
  expect(f.removeTab).not.toHaveBeenCalled();
  f.removeTab.mockImplementationOnce(async () => {
    expect(f.ptys.every((p) => p.exited)).toBe(true);
  });
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  await f.manager.confirmClose(preview.token, true);
  expect(f.removeTab).toHaveBeenCalledExactlyOnceWith(common);
  const reopened = await f.manager.open(common, a);
  expect(reopened.sessionId).not.toBe(first.sessionId);
});
it("holds the tab freeze through durable metadata removal, not just process exit", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  let release!: () => void;
  const saving = new Promise<void>((r) => {
    release = r;
  });
  f.removeTab.mockImplementationOnce(() => saving);
  const preview = f.manager.prepareClose({ kind: "tab", tab: common });
  const closing = f.manager.confirmClose(preview.token, true);
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.removeTab).toHaveBeenCalledExactlyOnceWith(common);
    await expect(f.manager.open(common, b)).rejects.toThrow(/заверш/i);
  } finally {
    release();
  }
  expect((await closing).status).toBe("success");
});

it("shutdown lease freezes opens/input/other close tickets, cancellation restores without signals", async () => {
  const f = fixture();
  const session = await f.manager.open(common, a);
  const older = f.manager.prepareClose({ kind: "tab", tab: common });
  const lease = await f.manager.prepareShutdown();
  expect(lease.requiresConfirmation).toBe(true);
  await expect(f.manager.open(common, b)).rejects.toThrow();
  expect(() => f.manager.write(session, "echo unsafe\n")).toThrow();
  expect(() => f.manager.prepareClose({ kind: "tab", tab: common })).toThrow();
  await expect(f.manager.confirmClose(older.token, true)).rejects.toThrow();
  expect(f.controls[0].signal).not.toHaveBeenCalled();
  lease.release();
  lease.release();
  f.manager.write(session, "echo safe\n");
  expect(f.ptys[0].write).toHaveBeenCalledWith("echo safe\n");
  expect((await f.manager.open(common, b)).state).toBe("running");
});
it("shutdown validates all native identities before any external participant stops", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  const lease = await f.manager.prepareShutdown();
  f.controls[0].members.push({ ...f.controls[0].shell, pid: 109, ppid: 100 });
  expect(() => lease.validate()).toThrow();
  expect(f.controls[0].signal).not.toHaveBeenCalled();
  lease.release();
});
it("successful shutdown stop retains completed screens and permits explicit refresh after later failure", async () => {
  const f = fixture();
  const session = await f.manager.open(common, a);
  const lease = await f.manager.prepareShutdown();
  lease.validate();
  await lease.stop();
  expect(lease.remaining()).toEqual([]);
  lease.release();
  expect((await f.manager.open(common, a)).state).toBe("exited");
  const refresh = f.manager.prepareClose({
    kind: "refresh",
    ref: session,
    scope: a,
  });
  expect((await f.manager.confirmClose(refresh.token, true)).status).toBe(
    "success",
  );
  expect(f.ptys).toHaveLength(2);
});
it("final shutdown seals the manager only after observed exits and while the admission gate is held", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  expect(() => f.manager.finalizeShutdown()).toThrow();
  const lease = await f.manager.prepareShutdown();
  expect(() => f.manager.finalizeShutdown()).toThrow();
  await lease.stop();
  f.manager.finalizeShutdown();
  lease.release();
  await expect(f.manager.open(common, b)).rejects.toThrow();
});
it("failed shutdown preparation releases its gate and does not signal an unverified process", async () => {
  const f = fixture();
  await f.manager.open(common, a);
  const prepare = vi
    .spyOn(f.controls[0].controller, "prepare")
    .mockImplementation(() => {
      throw Error("unknown");
    });
  await expect(f.manager.prepareShutdown()).rejects.toThrow();
  prepare.mockRestore();
  const lease = await f.manager.prepareShutdown();
  expect(f.controls[0].signal).not.toHaveBeenCalled();
  lease.release();
});

it("app-wide partial shutdown keeps the real terminal manager usable after a pipeline failure", async () => {
  const { ShutdownCoordinator } =
    await import("../src/main/shutdown-coordinator");
  const f = fixture();
  const session = await f.manager.open(common, a);
  let live = ["run:synthetic"];
  const finalize = vi.fn(async () => f.manager.finalizeShutdown());
  const stopRun = vi.fn(async (): Promise<void> => {
    throw Error("timeout");
  });
  const close = new ShutdownCoordinator({
    participants: [
      {
        prepare: async () => ({
          items: [{ id: "run:synthetic", label: "Build" }],
          requiresConfirmation: true,
          validate() {},
          stop: stopRun,
          remaining: () => live,
          release() {},
        }),
      },
      { prepare: () => f.manager.prepareShutdown() },
    ],
    confirm: async () => true,
    finalize,
  });
  expect((await close.close()).status).toBe("failed");
  expect(finalize).not.toHaveBeenCalled();
  expect(f.controls[0].signal).not.toHaveBeenCalled();
  f.manager.write(session, "echo still-open\n");
  stopRun.mockImplementation(async () => {
    live = [];
  });
  expect((await close.close()).status).toBe("success");
  expect(f.controls[0].signal.mock.calls.map((call) => call[1])).toEqual([
    "SIGTERM",
    "SIGHUP",
  ]);
  await expect(f.manager.open(common, b)).rejects.toThrow();
});
