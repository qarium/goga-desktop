import { expect, it, vi } from "vitest";
const electron = vi.hoisted(() => ({
  invoke: vi.fn(async () => ({ fixture: true })),
  on: vi.fn(),
  removeListener: vi.fn(),
  expose: vi.fn(),
}));
vi.mock("electron", () => ({
  ipcRenderer: electron,
  contextBridge: { exposeInMainWorld: electron.expose },
}));
it("exposes separate preview and token-only sequencer abort without invoking anything on load", async () => {
  await import("../src/main/preload");
  expect(electron.invoke).not.toHaveBeenCalled();
  const api = electron.expose.mock.calls[0][1];
  const request = {
    scope: "project",
    action: "abort",
    operation: "revert",
    revision: "a".repeat(64),
  };
  await api.prepareGitSequencerOperation(request);
  expect(electron.invoke).toHaveBeenLastCalledWith(
    "goga:prepare-git-sequencer-operation",
    request,
  );
  const token = "1".repeat(64);
  await api.executeGitSequencerOperation(token);
  expect(electron.invoke).toHaveBeenLastCalledWith(
    "goga:execute-git-sequencer-operation",
    token,
  );
});
