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
it("exposes separate preview and token-only rebase abort without invoking anything on load", async () => {
  await import("../src/main/preload");
  expect(electron.invoke).not.toHaveBeenCalled();
  const api = electron.expose.mock.calls[0][1];
  const request = {
    scope: "project",
    action: "abort",
    revision: "a".repeat(64),
  };
  await api.prepareGitRebaseOperation(request);
  expect(electron.invoke).toHaveBeenLastCalledWith(
    "goga:prepare-git-rebase-operation",
    request,
  );
  const token = "1".repeat(64);
  await api.executeGitRebaseOperation(token);
  expect(electron.invoke).toHaveBeenLastCalledWith(
    "goga:execute-git-rebase-operation",
    token,
  );
});
