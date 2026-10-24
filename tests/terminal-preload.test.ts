import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  api: undefined as any,
  ipc: undefined as any,
  exposed: "",
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  state.ipc = new EventEmitter() as any;
  state.ipc.send = vi.fn();
  return {
    contextBridge: {
      exposeInMainWorld: (key: string, api: any) => {
        state.exposed = key;
        state.api = api;
      },
    },
    ipcRenderer: state.ipc,
  };
});
it("exposes only narrow terminal capabilities and removable subscriptions without Electron event", async () => {
  await import("../src/main/terminal-preload");
  expect(state.exposed).toBe("terminalScreen");
  expect(Object.keys(state.api).sort()).toEqual(
    [
      "ack",
      "fault",
      "input",
      "link",
      "onCommand",
      "onFrame",
      "ready",
      "resize",
    ].sort(),
  );
  const listener = vi.fn(),
    off = state.api.onFrame(listener);
  state.ipc.emit(
    "terminal-screen:frame",
    { secretElectronEvent: true },
    { sequence: 1 },
  );
  expect(listener).toHaveBeenCalledExactlyOnceWith({ sequence: 1 });
  off();
  off();
  state.ipc.emit("terminal-screen:frame", {}, {});
  expect(listener).toHaveBeenCalledOnce();
  state.api.ready();
  expect(state.ipc.send).toHaveBeenLastCalledWith("terminal-screen:ready");
  state.api.input({ text: "x" });
  expect(state.ipc.send).toHaveBeenLastCalledWith("terminal-screen:input", {
    text: "x",
  });
});
