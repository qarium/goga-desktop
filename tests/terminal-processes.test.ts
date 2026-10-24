import { expect, it, vi } from "vitest";
import {
  TerminalProcessController,
  type TerminalProcessIdentity,
  type TerminalProcessSnapshot,
  TerminalStopError,
} from "../src/host/terminal-processes";
const shell: TerminalProcessIdentity = {
  pid: 100,
  ppid: 1,
  pgid: 100,
  sid: 100,
  uid: 501,
  tty: 30,
  status: 2,
  startSec: 1000,
  startUsec: 1,
};
const job = (pid = 101): TerminalProcessIdentity => ({
  ...shell,
  pid,
  ppid: 100,
  pgid: 101,
  startUsec: pid,
});
function fixture(jobs = [job()]) {
  let snapshot: TerminalProcessSnapshot = {
    ok: true,
    stable: true,
    uncertain: 0,
    root: { ...shell },
    members: [{ ...shell }, ...jobs],
  };
  let now = 0,
    exited = false;
  const read = vi.fn(() => structuredClone(snapshot));
  const signal = vi.fn((pid: number, sig: string) => {
    if (sig === "SIGTERM")
      snapshot.members = snapshot.members.filter((p) => p.pid !== pid);
    else exited = true;
  });
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  return {
    controller: new TerminalProcessController(shell, {
      read,
      signal,
      sleep,
      now: () => now,
      exited: () => exited,
    }),
    read,
    signal,
    sleep,
    snapshot: () => snapshot,
    set: (s: TerminalProcessSnapshot) => {
      snapshot = s;
    },
    time: () => now,
    exited: () => {
      exited = true;
    },
  };
}
it("signals each confirmed job with TERM, then shell with HUP; never TERM shell or KILL", async () => {
  const f = fixture([job(), job(102)]);
  const plan = f.controller.prepare();
  expect(plan.jobs).toHaveLength(2);
  expect(f.signal).not.toHaveBeenCalled();
  await f.controller.stop(plan);
  expect(f.signal.mock.calls).toEqual([
    [101, "SIGTERM"],
    [102, "SIGTERM"],
    [100, "SIGHUP"],
  ]);
});
it("idle shell needs only HUP and observed PTY exit", async () => {
  const f = fixture([]);
  const plan = f.controller.prepare();
  expect(plan.jobs).toEqual([]);
  await f.controller.stop(plan);
  expect(f.signal.mock.calls).toEqual([[100, "SIGHUP"]]);
});
it.each([
  "root-reused",
  "job-reused",
  "mixed-session",
  "mixed-tty",
  "mixed-uid",
  "missing-anchor",
  "unstable",
  "uncertain",
  "stopped",
  "new-job",
  "malformed",
  "read-error",
])("rejects %s before any signal", async (kind) => {
  const f = fixture();
  const plan = f.controller.prepare();
  const s = f.snapshot();
  switch (kind) {
    case "root-reused":
      s.root.startUsec++;
      break;
    case "job-reused":
      s.members[1].startSec++;
      break;
    case "mixed-session":
      s.members[1].sid++;
      break;
    case "mixed-tty":
      s.members[1].tty++;
      break;
    case "mixed-uid":
      s.members[1].uid++;
      break;
    case "missing-anchor":
      s.members.shift();
      break;
    case "unstable":
      s.stable = false;
      break;
    case "uncertain":
      s.uncertain = 1;
      break;
    case "stopped":
      s.members[1].status = 4;
      break;
    case "new-job":
      s.members.push(job(103));
      break;
    case "malformed":
      s.members[1].pid = -1;
      break;
    case "read-error":
      f.read.mockImplementation(() => {
        throw Error("synthetic-secret");
      });
      break;
  }
  await expect(f.controller.stop(plan)).rejects.toBeInstanceOf(
    TerminalStopError,
  );
  expect(f.signal).not.toHaveBeenCalled();
});
it("allows reparented descendants and disappeared jobs but does not expand approved membership", async () => {
  const f = fixture([job(), job(102)]);
  const plan = f.controller.prepare();
  f.snapshot().members = [shell, { ...job(102), ppid: 1 }];
  await f.controller.stop(plan);
  expect(f.signal.mock.calls).toEqual([
    [102, "SIGTERM"],
    [100, "SIGHUP"],
  ]);
});
it("does not include zombies or deliberately detached processes outside the tty inventory", async () => {
  const f = fixture([{ ...job(), status: 5 }]);
  const plan = f.controller.prepare();
  expect(plan.jobs).toHaveLength(0);
  await f.controller.stop(plan);
  expect(f.signal.mock.calls).toEqual([[100, "SIGHUP"]]);
});
it("stops after five seconds when jobs ignore TERM, without HUP or KILL", async () => {
  const f = fixture();
  f.signal.mockImplementation(() => {});
  const plan = f.controller.prepare();
  let error: unknown;
  try {
    await f.controller.stop(plan);
  } catch (e) {
    error = e;
  }
  expect(error).toMatchObject({
    code: "timeout",
    actions: [{ pid: 101, signal: "SIGTERM" }],
  });
  expect(f.time()).toBe(5000);
  expect(f.signal.mock.calls).toEqual([[101, "SIGTERM"]]);
});
it("requires shell exit after HUP within the same finite deadline", async () => {
  const f = fixture([]);
  f.signal.mockImplementation(() => {});
  await expect(f.controller.stop(f.controller.prepare())).rejects.toMatchObject(
    { code: "timeout" },
  );
  expect(f.time()).toBe(5000);
  expect(f.signal.mock.calls).toEqual([[100, "SIGHUP"]]);
});
it("waits for inventory uncertainty to settle only after TERM, sending no extra signals while uncertain", async () => {
  const f = fixture();
  const plan = f.controller.prepare();
  f.signal.mockImplementation((pid, signal) => {
    if (signal === "SIGTERM") {
      f.snapshot().members = [shell];
      f.snapshot().uncertain = 1;
    } else f.exited();
  });
  const sleep = f.sleep.getMockImplementation()!;
  f.sleep.mockImplementation(async (ms) => {
    expect(f.signal.mock.calls).toEqual([[101, "SIGTERM"]]);
    await sleep(ms);
    f.snapshot().uncertain = 0;
  });
  await f.controller.stop(plan);
  expect(f.sleep).toHaveBeenCalled();
  expect(f.signal.mock.calls).toEqual([
    [101, "SIGTERM"],
    [100, "SIGHUP"],
  ]);
});
it("new child after first signal produces a partial error and no further signals", async () => {
  const f = fixture([job(), job(102)]);
  const plan = f.controller.prepare();
  f.signal.mockImplementation(() => {
    f.snapshot().members = [shell, job(102), job(103)];
  });
  await expect(f.controller.stop(plan)).rejects.toMatchObject({
    code: "stale",
    actions: [{ pid: 101, signal: "SIGTERM" }],
  });
  expect(f.signal.mock.calls).toEqual([[101, "SIGTERM"]]);
});
it("read or signal failure does not expose OS diagnostic text", async () => {
  const f = fixture();
  const plan = f.controller.prepare();
  f.signal.mockImplementation(() => {
    throw Error("synthetic-secret");
  });
  await expect(f.controller.stop(plan)).rejects.toMatchObject({
    code: "signal",
  });
  await expect(f.controller.stop(plan)).rejects.not.toThrow("synthetic-secret");
});
it("rejects a foreign plan and malformed/duplicate OS identities", async () => {
  const f = fixture();
  const plan = f.controller.prepare();
  plan.anchor.pid = 999;
  await expect(f.controller.stop(plan)).rejects.toMatchObject({
    code: "stale",
  });
  expect(f.signal).not.toHaveBeenCalled();
  f.snapshot().members.push(job());
  expect(() => f.controller.prepare()).toThrow(TerminalStopError);
});
it("rejects stopped shell and unknown OS status rather than guessing liveness", async () => {
  for (const status of [4, 6]) {
    const f = fixture();
    const plan = f.controller.prepare();
    f.snapshot().root.status = status;
    await expect(f.controller.stop(plan)).rejects.toBeInstanceOf(
      TerminalStopError,
    );
    expect(f.signal).not.toHaveBeenCalled();
  }
});
it("persistent uncertain inventory after TERM reaches the deadline without HUP", async () => {
  const f = fixture();
  const plan = f.controller.prepare();
  f.signal.mockImplementation(() => {
    f.snapshot().members = [shell];
    f.snapshot().uncertain = 1;
  });
  await expect(f.controller.stop(plan)).rejects.toMatchObject({
    code: "timeout",
  });
  expect(f.time()).toBe(5000);
  expect(f.signal.mock.calls).toEqual([[101, "SIGTERM"]]);
});
it("copies the spawn anchor so later caller mutation cannot authorize another process", async () => {
  const f = fixture();
  const plan = f.controller.prepare();
  plan.anchor.startSec++;
  expect(() => f.controller.validate(plan)).toThrow();
  expect(f.signal).not.toHaveBeenCalled();
});
it("opens the exit-drain gate only after checked HUP, then still requires observed exit", async () => {
  const f = fixture(),
    gate = vi.fn(() => {
      expect(f.signal.mock.calls).toEqual([
        [101, "SIGTERM"],
        [100, "SIGHUP"],
      ]);
      f.exited();
    });
  f.signal.mockImplementation((pid, signal) => {
    if (signal === "SIGTERM") f.snapshot().members = [shell];
  });
  await f.controller.stop(f.controller.prepare(), gate);
  expect(gate).toHaveBeenCalledOnce();
});
it("never drains when jobs fail to stop or the hangup signal fails", async () => {
  for (const failure of ["job", "signal"]) {
    const f = fixture(failure === "job" ? [job()] : []),
      gate = vi.fn();
    f.signal.mockImplementation(() => {
      if (failure === "signal") throw Error();
    });
    await expect(
      f.controller.stop(f.controller.prepare(), gate),
    ).rejects.toBeInstanceOf(TerminalStopError);
    expect(gate).not.toHaveBeenCalled();
  }
});
