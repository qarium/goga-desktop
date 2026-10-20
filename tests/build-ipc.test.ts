import { expect, it, vi } from "vitest";
import { registerIPC } from "../src/main/ipc";
it("all build IPC endpoints require trusted shell and reject hostile strict requests", async () => {
  const handlers = new Map<string, Function>();
  const service = {
    buildContext: vi.fn(),
    listBuildFiles: vi.fn(),
    readBuildPlan: vi.fn(),
    launchBuild: vi.fn(),
    repeatBuild: vi.fn(),
  };
  registerIPC(
    { handle: (k: string, v: Function) => handlers.set(k, v) } as any,
    {
      service,
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  for (const channel of [
    "build-context",
    "list-build-files",
    "read-build-plan",
    "launch-build",
    "repeat-build",
  ]) {
    expect(handlers.has("goga:" + channel)).toBe(true);
    for (const hostile of [
      { ...event, sender: { id: 2 } },
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
      { ...event, senderFrame: { url: "http://localhost:1234", parent: null } },
    ])
      expect(() => handlers.get("goga:" + channel)!(hostile)).toThrow(/IPC/);
  }
  const request = {
    projectId: "p",
    expectedBranch: "main",
    contextRevision: "a".repeat(64),
    planPath: "plan.md",
    planVersion: "b".repeat(64),
    options: {},
    confirmClean: false,
  };
  await handlers.get("goga:launch-build")!(event, request);
  expect(service.launchBuild).toHaveBeenCalledWith(request);
  for (const bad of [
    { ...request, dryRun: true },
    { ...request, options: { dryRun: true } },
    {
      ...request,
      options: { env: [{ key: "A", value: "secret", unexpected: true }] },
    },
    { ...request, confirmClean: "yes" },
    { ...request, planVersion: "oops" },
  ])
    expect(() => handlers.get("goga:launch-build")!(event, bad)).toThrow();
  expect(() =>
    handlers.get("goga:repeat-build")!(event, "r", "true"),
  ).toThrow();
  await handlers.get("goga:build-context")!(event, "p", {
    workflow: "build",
    profile: "",
  });
  expect(service.buildContext).toHaveBeenCalledWith("p", {
    workflow: "build",
    profile: "",
  });
  expect(() =>
    handlers.get("goga:build-context")!(event, "p", { env: [], unknown: true }),
  ).toThrow();
  for (const channel of ["list-build-files", "read-build-plan"])
    expect(() =>
      handlers.get("goga:" + channel)!(event, "p", "bad\0path"),
    ).toThrow();
  const error = (() => {
    try {
      handlers.get("goga:launch-build")!(event, {
        ...request,
        options: { proxy: "SECRET-not-url" },
      });
    } catch (e) {
      return String(e);
    }
  })();
  expect(error).not.toContain("SECRET");
});
