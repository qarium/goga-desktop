import { it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { registerIPC } from "../src/main/ipc";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
it("registers a newly created folder exactly and opens empty schema without Goga", async () => {
  const home = await fs.mkdtemp("/private/tmp/goga-new-project-host-");
  cleanups.push(() => fs.rm(home, { recursive: true, force: true }));
  const runner: any = {
    command: vi.fn(async () => {
      throw Error("Git unavailable");
    }),
    dispose: vi.fn(async () => {}),
  };
  const host = new HostService({
    home,
    dataDir: path.join(home, "data"),
    runner,
  });
  cleanups.push(() => host.dispose());
  expect(typeof (host as any).createProject).toBe("function");
  const progress = vi.fn();
  host.on("project-creation", progress);
  const result = await (host as any).createProject({
    id: "one",
    mode: "empty",
    parent: home,
    name: "new",
    git: false,
  });
  expect(result.status).toBe("success");
  expect(result.project.path).toBe(path.join(home, "new"));
  expect(await host.listProjects()).toEqual([result.project]);
  expect(progress).toHaveBeenCalled();
  runner.command.mockClear();
  expect(await host.readOverviewSchema(result.project.id)).toEqual([]);
  expect(runner.command.mock.calls.some((c: any) => c[0] === "goga")).toBe(
    false,
  );
  await fs.writeFile(path.join(home, "new", "file.txt"), "content");
  await expect(host.readOverviewSchema(result.project.id)).rejects.toThrow();
  expect(runner.command.mock.calls.some((c: any) => c[0] === "goga")).toBe(
    true,
  );
});
it("limits creation IPC to trusted shell, strict request and exact attempt cancellation", async () => {
  const handlers = new Map<string, Function>();
  const service = { createProject: vi.fn(), cancelProjectCreation: vi.fn() };
  const chooseProjectLocation = vi.fn(async () => "/synthetic/projects");
  registerIPC(
    { handle: (name: string, fn: Function) => handlers.set(name, fn) } as any,
    {
      service,
      settings: {},
      window: { webContents: { id: 1 } },
      shellURL: "file:///app/index.html",
      chooseProjectLocation,
    } as any,
  );
  const event = {
    sender: { id: 1 },
    senderFrame: { url: "file:///app/index.html", parent: null },
  };
  const request = {
    id: "create-1",
    mode: "empty",
    parent: "/synthetic/projects",
    name: "new",
    git: true,
  };
  for (const name of [
    "create-project",
    "cancel-project-creation",
    "choose-project-location",
  ])
    expect(handlers.has(`goga:${name}`)).toBe(true);
  const create = handlers.get("goga:create-project")!,
    cancel = handlers.get("goga:cancel-project-creation")!;
  expect(() =>
    create(
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } },
      request,
    ),
  ).toThrow("IPC");
  expect(() => create(event, { ...request, force: true })).toThrow();
  expect(service.createProject).not.toHaveBeenCalled();
  await create(event, request);
  expect(service.createProject).toHaveBeenCalledWith(request);
  expect(() => cancel(event, { id: "create-1" })).toThrow();
  await cancel(event, "create-1");
  expect(service.cancelProjectCreation).toHaveBeenCalledWith("create-1");
  expect(await handlers.get("goga:choose-project-location")!(event)).toBe(
    "/synthetic/projects",
  );
});
