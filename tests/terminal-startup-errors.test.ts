import { expect, it, vi } from "vitest";
import {
  TerminalSessions,
  type TerminalSessionDependencies,
} from "../src/host/terminal-sessions";
import { TerminalNativeAdapter } from "../src/host/terminal-native";
import type { TerminalLaunch } from "../src/host/terminal-environment";
const launch: TerminalLaunch = {
  context: { kind: "primary", projectId: "p" },
  cwd: "/synthetic-secret",
  shell: "/bin/zsh",
  args: ["-l", "-i"],
  env: { TOKEN: "synthetic-secret" },
  verifyRoot: async () => {},
};
const tab = {
  id: "c",
  projectId: "p",
  name: "console",
  scope: { kind: "common" as const },
};
function setup() {
  const release = vi.fn(),
    exitListeners: Function[] = [];
  const pty = {
    assertReady: vi.fn(),
    onFault: () => ({ dispose() {} }),
    pause: vi.fn(),
    resume: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn(() => ({ dispose() {} })),
    onExit: (fn: Function) => {
      exitListeners.push(fn);
      return { dispose() {} };
    },
  };
  const screen = {
    assertReady: vi.fn(),
    bind: vi.fn(),
    output: vi.fn(),
    exited: vi.fn(),
    drainAfterHangup: vi.fn(),
    finishClose: vi.fn(),
    fail: vi.fn(),
    dispose: vi.fn(),
  };
  const d: TerminalSessionDependencies = {
    acquire: async () => ({ launch: { ...launch }, release }),
    spawn: vi.fn(() => pty),
    processes: () => ({
      prepare: () => ({ anchor: {} as any, jobs: [] }),
      validate() {},
      stop: async () => exitListeners.forEach((fn) => fn({ exitCode: 0 })),
    }),
    prepareScreen: async () => screen,
    removeTab: async () => {},
  };
  return { d, pty, screen, release };
}
const fail = () => {
  throw Error("synthetic-secret /private/project native stderr");
};
it.each([
  "context",
  "root",
  "screen",
  "revalidate",
  "screen-ready",
  "spawn",
  "processes",
  "native-ready",
  "screen-bind",
  "output-subscribe",
] as const)(
  "reports safe startup stage %s without exposing the original exception",
  async (phase) => {
    const f = setup();
    if (phase === "context") f.d.acquire = async () => fail();
    if (phase === "root" || phase === "revalidate") {
      let n = 0;
      f.d.acquire = async () => ({
        release: f.release,
        launch: {
          ...launch,
          verifyRoot: async () => {
            if (++n === (phase === "root" ? 1 : 2)) fail();
          },
        },
      });
    }
    if (phase === "screen") f.d.prepareScreen = async () => fail();
    if (phase === "screen-ready") f.screen.assertReady.mockImplementation(fail);
    if (phase === "spawn") f.d.spawn = fail;
    if (phase === "processes") f.d.processes = fail;
    if (phase === "native-ready") f.pty.assertReady.mockImplementation(fail);
    if (phase === "screen-bind") f.screen.bind.mockImplementation(fail);
    if (phase === "output-subscribe") f.pty.onData.mockImplementation(fail);
    const sessions = new TerminalSessions(f.d);
    const error = await sessions.open(tab, "p").catch((e) => e);
    expect(error.message).toContain("terminal:" + phase);
    expect(error.message).not.toMatch(
      /synthetic-secret|private\/project|stderr/,
    );
    expect(error.cause).toBeUndefined();
    const spawned = [
      "processes",
      "native-ready",
      "screen-bind",
      "output-subscribe",
    ].includes(phase);
    expect(error.retained).toBe(spawned);
    expect(sessions.list()).toHaveLength(spawned ? 1 : 0);
    if (spawned) {
      expect(f.release).not.toHaveBeenCalled();
      expect(f.pty.pause).toHaveBeenCalled();
    }
  },
);
it("preserves the native preflight/spawn stage through session errors without spawning on preflight failure", async () => {
  for (const preflight of [true, false]) {
    const f = setup(),
      spawn = vi.fn(fail);
    const adapter = new TerminalNativeAdapter(
      { spawn },
      {
        check: () => {
          if (preflight) fail();
        },
        birth: fail,
        root: fail,
        snapshot: fail,
      },
      { platform: "darwin" },
    );
    f.d.spawn = adapter.spawn;
    const error = await new TerminalSessions(f.d)
      .open(tab, "p")
      .catch((e) => e);
    expect(error.message).toContain(
      preflight ? "terminal:native-preflight" : "terminal:native-spawn",
    );
    expect(error.retained).toBe(false);
    expect(error.message).not.toContain("synthetic-secret");
    expect(spawn).toHaveBeenCalledTimes(preflight ? 0 : 1);
  }
});

it("waits for native readiness before any shell, then revalidates the root", async () => {
  const f = setup();
  let ready!: () => void;
  const prepareNative = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  (f.d as any).prepareNative = prepareNative;
  const verifyRoot = vi.fn(async () => {});
  f.d.acquire = async () => ({
    launch: { ...launch, verifyRoot },
    release: f.release,
  });
  const sessions = new TerminalSessions(f.d);
  const first = sessions.open(tab, "p"),
    duplicate = sessions.open(tab, "p");
  await vi.waitFor(() => expect(prepareNative).toHaveBeenCalledTimes(1));
  expect(f.d.spawn).not.toHaveBeenCalled();
  expect(sessions.list()[0].state).toBe("starting");
  ready();
  const [a, b] = await Promise.all([first, duplicate]);
  expect(a).toEqual(b);
  expect(a.state).toBe("running");
  expect(verifyRoot).toHaveBeenCalledTimes(2);
  expect(f.d.spawn).toHaveBeenCalledTimes(1);
});
it.each(["failure", "cancel", "root-changed"])(
  "readiness %s clears starting state without spawning or leaking the lease",
  async (mode) => {
    const f = setup();
    let ready!: () => void, fail!: (e: Error) => void;
    const prepareNative = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          ready = resolve;
          fail = reject;
        }),
    );
    (f.d as any).prepareNative = prepareNative;
    let valid = true;
    f.d.acquire = async () => ({
      launch: {
        ...launch,
        verifyRoot: async () => {
          if (!valid) throw Error("changed");
        },
      },
      release: f.release,
    });
    const sessions = new TerminalSessions(f.d);
    const opening = sessions.open(tab, "p").catch((e) => e);
    await vi.waitFor(() => expect(prepareNative).toHaveBeenCalledTimes(1));
    if (mode === "cancel") sessions.cancelOpen(tab, "p");
    if (mode === "root-changed") valid = false;
    if (mode === "failure") fail(Error("synthetic-secret"));
    else ready();
    const error = await opening;
    expect(error.retained).toBe(false);
    expect(error.message).not.toContain("synthetic-secret");
    if (mode === "failure") expect(error.message).toContain("native-preflight");
    expect(f.d.spawn).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(sessions.list()).toHaveLength(0);
  },
);
