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
