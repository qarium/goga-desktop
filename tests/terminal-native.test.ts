import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import {
  TerminalNativeAdapter,
  type NativeTerminalDriver,
} from "../src/host/terminal-native";
import type { TerminalLaunch } from "../src/host/terminal-environment";
const birth = { pid: 200, ppid: 100, uid: 501, startSec: 1000, startUsec: 2 };
const root = { ...birth, pgid: 200, sid: 200, tty: 30, status: 2 };
const launch: TerminalLaunch = {
  context: { kind: "primary", projectId: "p" },
  cwd: "/synthetic",
  shell: "/bin/zsh",
  args: ["-l", "-i"],
  env: { HOME: "/synthetic", TOKEN: "synthetic-secret" },
  verifyRoot: async () => {},
};
class Native extends EventEmitter {
  pid = 200;
  pause = vi.fn();
  resume = vi.fn();
  write = vi.fn();
  resize = vi.fn();
  onData(fn: (text: string) => void) {
    this.on("data", fn);
    return {
      dispose: () => {
        this.off("data", fn);
      },
    };
  }
  onExit(fn: (event: { exitCode: number; signal?: number }) => void) {
    this.on("exit", fn);
    return {
      dispose: () => {
        this.off("exit", fn);
      },
    };
  }
}
function fixture() {
  const native = new Native();
  let now = 0;
  const inspector = {
    birth: vi.fn((_pid: number) => ({ ...birth })),
    root: vi.fn((_pid: number) => ({ ...root }) as any),
    snapshot: vi.fn((_pid: number) => ({
      ok: true,
      stable: true,
      uncertain: 0,
      root: { ...root },
      members: [{ ...root }],
    })),
  };
  const signal = vi.fn((pid: number, sig: string) => {
    if (sig === "SIGHUP") native.emit("exit", { exitCode: 0, signal: 1 });
  });
  const driver = {
    spawn: vi.fn(
      (..._args: Parameters<NativeTerminalDriver["spawn"]>) => native,
    ),
  };
  const adapter = new TerminalNativeAdapter(driver, inspector, {
    parentPid: 100,
    uid: 501,
    platform: "darwin",
    now: () => now,
    waitSync: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      now += ms;
    },
    signal,
  });
  return { adapter, native, inspector, driver, signal, time: () => now };
}
it("spawns only the prepared executable/cwd/env with no software flow-control or command interpolation", () => {
  const f = fixture(),
    pty = f.adapter.spawn(launch);
  pty.assertReady();
  expect(f.driver.spawn).toHaveBeenCalledExactlyOnceWith(
    "/bin/zsh",
    ["-l", "-i"],
    expect.objectContaining({
      cwd: "/synthetic",
      env: launch.env,
      cols: 80,
      rows: 24,
      encoding: "utf8",
      handleFlowControl: false,
    }),
  );
  const options = f.driver.spawn.mock.calls[0][2] as any;
  expect(options.env).not.toBe(launch.env);
  expect(f.signal).not.toHaveBeenCalled();
});
it("pins birth identity before waiting for tty; normal startup transition does not replace ownership", () => {
  const f = fixture();
  f.inspector.root.mockReturnValueOnce({ ...root, tty: 4294967295 });
  const p = f.adapter.spawn(launch);
  p.assertReady();
  expect(f.inspector.birth).toHaveBeenCalledOnce();
  expect(f.inspector.root).toHaveBeenCalledTimes(2);
  expect(f.time()).toBeGreaterThan(0);
  expect(f.adapter.processes(p).prepare().anchor).toEqual(root);
});
it.each(["pid", "ppid", "uid", "startSec", "startUsec"] as const)(
  "rejects startup identity change in %s, with no signals or input",
  (field) => {
    const f = fixture();
    f.inspector.root.mockReturnValue({ ...root, [field]: root[field] + 1 });
    const p = f.adapter.spawn(launch);
    expect(() => p.assertReady()).toThrow();
    expect(() => p.write("unsafe")).toThrow();
    expect(() => f.adapter.processes(p).prepare()).toThrow();
    expect(f.signal).not.toHaveBeenCalled();
    expect(f.native.pause).toHaveBeenCalled();
  },
);
it.each(["ppid", "uid"] as const)(
  "rejects a birth record not owned by this app (%s)",
  (field) => {
    const f = fixture();
    f.inspector.birth.mockReturnValue({ ...birth, [field]: birth[field] + 1 });
    const p = f.adapter.spawn(launch);
    expect(() => p.assertReady()).toThrow();
    expect(() => f.adapter.processes(p).prepare()).toThrow();
    expect(f.inspector.root).not.toHaveBeenCalled();
    expect(f.signal).not.toHaveBeenCalled();
  },
);
it("never adopts a later identity when initial birth inspection failed", () => {
  const f = fixture();
  f.inspector.birth.mockImplementationOnce(() => {
    throw Error("secret diagnostics");
  });
  const p = f.adapter.spawn(launch),
    fault = vi.fn();
  p.onFault(fault);
  expect(fault).toHaveBeenCalledOnce();
  expect(fault.mock.calls).toEqual([[]]);
  expect(() => p.assertReady()).toThrow(/терминал/i);
  expect(() => p.assertReady()).not.toThrow("secret diagnostics");
  expect(() => f.adapter.processes(p).prepare()).toThrow();
  expect(f.inspector.birth).toHaveBeenCalledOnce();
  expect(f.signal).not.toHaveBeenCalled();
});
it("keeps a timed-out child owned and can later stop only the same pinned birth, without enabling input", async () => {
  const f = fixture();
  f.inspector.root.mockReturnValue({ ...root, tty: 4294967295 });
  const p = f.adapter.spawn(launch),
    exit = vi.fn();
  p.onExit(exit);
  expect(f.time()).toBe(500);
  expect(() => p.assertReady()).toThrow();
  f.inspector.root.mockReturnValue({ ...root });
  const control = f.adapter.processes(p);
  await control.stop(control.prepare());
  expect(f.signal.mock.calls).toEqual([[200, "SIGHUP"]]);
  expect(exit).toHaveBeenCalledOnce();
  expect(() => p.write("not-recovered")).toThrow();
});
it("retains the final anchor and refuses PID reuse at close", async () => {
  const f = fixture(),
    p = f.adapter.spawn(launch),
    c = f.adapter.processes(p),
    plan = c.prepare();
  f.inspector.snapshot.mockReturnValue({
    ok: true,
    stable: true,
    uncertain: 0,
    root: { ...root, startSec: 2000 },
    members: [{ ...root, startSec: 2000 }],
  });
  await expect(c.stop(plan)).rejects.toThrow();
  expect(f.signal).not.toHaveBeenCalled();
});
it("source events split at Unicode boundaries, pause retains the tail and resume preserves order", () => {
  const f = fixture(),
    p = f.adapter.spawn(launch),
    parts: string[] = [];
  p.onData((text) => {
    parts.push(text);
    if (parts.length === 1) p.pause();
  });
  const text = "x".repeat(65534) + "🙂yz";
  f.native.emit("data", text);
  expect(parts).toEqual(["x".repeat(65534)]);
  p.resume();
  expect(parts.join("")).toBe(text);
  expect(parts.every((x) => Buffer.byteLength(x) <= 65536)).toBe(true);
  expect(parts.join("")).not.toContain("�");
});
it("holds a synchronous subscription/startup output until the consumer is installed", () => {
  const f = fixture();
  const register = f.native.onData.bind(f.native);
  f.native.onData = (fn) => {
    const result = register(fn);
    fn("first prompt");
    return result;
  };
  const p = f.adapter.spawn(launch),
    data = vi.fn();
  p.onData(data);
  expect(data).toHaveBeenCalledExactlyOnceWith("first prompt");
});
it("emits a fault and pauses on an oversized native event or an adapter ignoring pause", () => {
  for (const oversize of [true, false]) {
    const f = fixture(),
      p = f.adapter.spawn(launch),
      fault = vi.fn(),
      data = vi.fn();
    p.onFault(fault);
    p.onData(data);
    if (oversize) f.native.emit("data", "x".repeat(65541));
    else {
      p.pause();
      f.native.emit("data", "x".repeat(65536));
      f.native.emit("data", "more");
    }
    expect(fault).toHaveBeenCalledOnce();
    expect(data).not.toHaveBeenCalled();
    expect(() => p.write("unsafe")).toThrow();
    expect(f.native.pause).toHaveBeenCalled();
  }
});
it("natural exit is delivered once after queued output, even while reads are paused", () => {
  const f = fixture(),
    p = f.adapter.spawn(launch),
    events: string[] = [];
  p.onData((text) => events.push(text));
  p.onExit(() => events.push("exit"));
  p.pause();
  f.native.emit("data", "tail");
  f.native.emit("exit", { exitCode: 0 });
  expect(events).toEqual([]);
  p.resume();
  expect(events).toEqual(["tail", "exit"]);
  f.native.emit("exit", { exitCode: 0 });
  f.native.emit("data", "late");
  expect(events).toEqual(["tail", "exit"]);
});
it("faulted sessions drain after checked HUP without accumulating unusable output and still observe exit", async () => {
  const f = fixture(),
    p = f.adapter.spawn(launch),
    exit = vi.fn();
  p.onExit(exit);
  f.native.emit("data", "x".repeat(65541));
  f.signal.mockImplementation((_pid, sig) => {
    if (sig === "SIGHUP")
      setTimeout(() => f.native.emit("exit", { exitCode: 0 }), 0);
  });
  f.native.resume.mockImplementation(() => {
    f.native.emit("data", "discarded".repeat(10000));
    f.native.emit("exit", { exitCode: 0 });
  });
  const c = f.adapter.processes(p);
  await c.stop(c.prepare());
  expect(f.native.resume).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledOnce();
});
it("does not accept another factory's PTY or expose PID/env on the session-facing wrapper", () => {
  const f = fixture(),
    g = fixture(),
    p = f.adapter.spawn(launch);
  expect(() => g.adapter.processes(p)).toThrow();
  expect("pid" in p).toBe(false);
  expect(JSON.stringify(p)).not.toContain("synthetic-secret");
});
it("blocks unsupported OS and inspector preflight failure before spawning", () => {
  const f = fixture();
  const adapter = new TerminalNativeAdapter(
    f.driver,
    {
      ...f.inspector,
      check: () => {
        throw Error("not executable");
      },
    },
    { parentPid: 100, uid: 501, platform: "darwin" },
  );
  expect(() => adapter.spawn(launch)).toThrow();
  expect(f.driver.spawn).not.toHaveBeenCalled();
});
it("forwards a natural observed exit after failed startup without waiting for another signal", () => {
  const f = fixture();
  f.inspector.root.mockImplementation(() => {
    throw Error("unavailable");
  });
  const p = f.adapter.spawn(launch),
    exit = vi.fn();
  p.onExit(exit);
  f.native.emit("exit", { exitCode: 1 });
  expect(exit).toHaveBeenCalledExactlyOnceWith({ exitCode: 1 });
  expect(f.signal).not.toHaveBeenCalled();
});
import { TerminalSessions } from "../src/host/terminal-sessions";
it("failed native startup keeps a closeable owned session and releases its lease only on actual exit", async () => {
  const f = fixture(),
    release = vi.fn();
  f.inspector.root.mockReturnValue({ ...root, tty: 4294967295 });
  const sessions = new TerminalSessions({
    acquire: async () => ({ launch, release }),
    spawn: f.adapter.spawn,
    processes: f.adapter.processes,
    removeTab: async () => {},
    prepareScreen: async () => ({
      assertReady() {},
      bind() {},
      output() {},
      exited() {},
      fail() {},
      dispose() {},
      drainAfterHangup() {},
      finishClose() {},
    }),
  });
  const tab = {
    id: "t",
    name: "console",
    projectId: "p",
    scope: { kind: "common" as const },
  };
  await expect(sessions.open(tab, "p")).rejects.toThrow();
  expect(release).not.toHaveBeenCalled();
  expect(sessions.list()[0]).toMatchObject({
    state: "running",
    screen: "lost",
  });
  f.inspector.root.mockReturnValue({ ...root });
  const preview = sessions.prepareClose({ kind: "tab", tab });
  expect((await sessions.confirmClose(preview.token, true)).status).toBe(
    "success",
  );
  expect(release).toHaveBeenCalledOnce();
  expect(sessions.list()).toEqual([]);
});
it("rejects a ready-looking identity if the startup deadline already elapsed", () => {
  const native = new Native();
  let now = 0;
  const inspector = {
    birth: () => ({ ...birth }),
    root: () => {
      now = 501;
      return { ...root };
    },
    snapshot: () => ({
      ok: true,
      stable: true,
      uncertain: 0,
      root,
      members: [root],
    }),
  };
  const adapter = new TerminalNativeAdapter(
    { spawn: () => native },
    inspector,
    { parentPid: 100, uid: 501, platform: "darwin", now: () => now },
  );
  const p = adapter.spawn(launch);
  expect(() => p.assertReady()).toThrow();
  expect(() => adapter.processes(p).prepare()).not.toThrow(); // birth/anchor remain owned for explicit close
});
it("turns native I/O errors into a secret-free fault, including late errors after observed exit", () => {
  const f = fixture(),
    p = f.adapter.spawn(launch),
    fault = vi.fn(),
    exit = vi.fn();
  p.onFault(fault);
  p.onExit(exit);
  expect(() => f.native.emit("error", Error("synthetic-secret"))).not.toThrow();
  expect(fault.mock.calls).toEqual([[]]);
  expect(() => p.write("unsafe")).toThrow();
  f.native.emit("exit", { exitCode: 1 });
  expect(exit).toHaveBeenCalledOnce();
  expect(() => f.native.emit("error", Error("late"))).not.toThrow();
  expect(fault).toHaveBeenCalledOnce();
});
it("does not spawn on unsupported platforms and sanitizes pre-spawn errors", () => {
  const f = fixture();
  const unsupported = new TerminalNativeAdapter(f.driver, f.inspector, {
    platform: "linux",
  });
  expect(() => unsupported.spawn(launch)).toThrow();
  expect(f.driver.spawn).not.toHaveBeenCalled();
  f.driver.spawn.mockImplementation(() => {
    throw Error("synthetic-secret launch options");
  });
  expect(() => f.adapter.spawn(launch)).toThrow();
  expect(() => f.adapter.spawn(launch)).not.toThrow("synthetic-secret");
});

it.each(["birth", "root"] as const)(
  "retains safe native %s diagnostics after ownership-preserving startup failure",
  (phase) => {
    const f = fixture();
    f.inspector[phase].mockImplementation(() => {
      throw Error("synthetic-secret /private/project");
    });
    const pty = f.adapter.spawn(launch);
    const expected = phase === "birth" ? "native-birth" : "native-handshake";
    expect(() => pty.assertReady()).toThrow("terminal:" + expected);
    expect(() => pty.assertReady()).not.toThrow("synthetic-secret");
    expect(f.driver.spawn).toHaveBeenCalledOnce();
    expect(f.signal).not.toHaveBeenCalled();
    const exit = vi.fn();
    pty.onExit(exit);
    f.native.emit("exit", { exitCode: 0 });
    expect(exit).toHaveBeenCalledOnce();
  },
);
