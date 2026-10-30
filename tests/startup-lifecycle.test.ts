import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
const observers = vi.hoisted(() => new Map<any, any>());
vi.mock("../src/host/process", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  watchDashboard: vi.fn((child, callbacks) => {
    observers.set(child, callbacks);
    return vi.fn();
  }),
}));
import { HostService } from "../src/host/service";
import { watchDashboard } from "../src/host/process";
const resources: { service: HostService; root: string; runner: any }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const r of resources.splice(0)) {
    r.runner.kill.mockImplementation(async () => {});
    await r.service.dispose();
    await rm(r.root, { recursive: true, force: true });
  }
  observers.clear();
});
async function fixture(minutes?: number, shellPath?: () => Promise<string>) {
  const root = await mkdtemp("/private/tmp/goga-startup-lifecycle-"),
    home = path.join(root, "home"),
    repo = path.join(root, "project");
  await mkdir(home);
  await mkdir(path.join(repo, ".git"), { recursive: true });
  const children: any[] = [];
  const runner = {
    command: vi.fn(async (exe: string, args: string[]) => {
      let stdout: string;
      if (exe === "git") {
        if (args.join(" ") === "rev-parse --show-toplevel") stdout = repo;
        else if (args.join(" ") === "rev-parse --git-common-dir")
          stdout = ".git";
        else if (args[0] === "rev-parse") stdout = "a".repeat(40);
        else if (args[0] === "branch") stdout = "main";
        else if (args[0] === "for-each-ref") stdout = "main";
        else if (args[0] === "status") stdout = "";
        else throw Error("Unexpected Git " + JSON.stringify(args));
      } else if (args[0] === "topics")
        stdout = JSON.stringify([
          { branch: "main", topic: "main", current: true },
        ]);
      else if (args.includes("--list")) stdout = "* build\n  name: Build\n";
      else if (args.includes("--info"))
        stdout = "name: Build\n---\n* work:\n  title: Work\n";
      else throw Error("Unexpected Goga command");
      return { stdout, stderr: "" };
    }),
    start: vi.fn(() => {
      const c = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      children.push(c);
      return c as any;
    }),
    kill: vi.fn(async () => {}),
  };
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    shellPath,
    runner,
  });
  resources.push({ service, root, runner });
  const project = await service.addProject(repo);
  if (minutes !== undefined) {
    const doc = await service.readProjectSettings(project.id);
    await service.saveProjectSettings(
      project.id,
      { ...doc.value, startupTimeoutMinutes: minutes },
      doc.version,
    );
  }
  const launch = async (update = false) => {
    const p = {
      projectId: project.id,
      pipeline: "build",
      workflow: "auto",
      profile: "",
      skips: [],
    };
    const preview = await service.preview(p);
    const task = await service.readTopicTask({
      projectId: project.id,
      branch: "main",
      topic: "main",
    });
    return service.launch({
      ...p,
      topic: { mode: "existing", branch: "main", topic: "main" },
      expectedBranch: "main",
      confirmBranchSwitch: false,
      task: "",
      taskVersion: task.version,
      confirmEmptyTask: false,
      clean: false,
      update,
      previewToken: preview.token,
    });
  };
  return { service, project, runner, children, launch };
}
it("uses default ten minutes from spawn; HTTP-ready does not restart or cancel budget", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const run = await f.launch(true),
    child = f.children[0];
  expect(run).toMatchObject({
    status: "starting",
    startupTimeoutMs: 600000,
    update: true,
    dashboardOpened: false,
  });
  expect(vi.mocked(watchDashboard).mock.calls.at(-1)![1].timeoutMs).toBeNull();
  await vi.advanceTimersByTimeAsync(590000);
  observers.get(child).onReady("http://localhost:4567");
  expect(f.service.runs()[0]).toMatchObject({
    status: "starting",
    url: "http://localhost:4567",
    dashboardOpened: false,
  });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.runner.kill).toHaveBeenCalledTimes(1);
  expect(f.service.runs()[0]).toMatchObject({
    status: "failed",
    dashboardOpened: false,
  });
  expect(f.service.runs()[0].error).toMatch(/время запуска|Время запуска/);
  expect(f.service.runs()[0].url).toBeUndefined();
});
it("only successful matching browser open clears deadline; output continues afterwards", async () => {
  const f = await fixture(1);
  vi.useFakeTimers();
  const run = await f.launch();
  const child = f.children[0];
  child.stdout.write("before ready\n");
  await vi.advanceTimersByTimeAsync(100);
  expect(f.service.runs()[0].output?.text).toContain("before ready");
  expect(f.service.markDashboardOpened(run.id, "http://localhost:4567")).toBe(
    false,
  );
  observers.get(child).onReady("http://localhost:4567");
  expect(f.service.markDashboardOpened(run.id, "http://localhost:9999")).toBe(
    false,
  );
  await vi.advanceTimersByTimeAsync(59800);
  expect(f.service.markDashboardOpened(run.id, "http://localhost:4567")).toBe(
    true,
  );
  child.stderr.write("after browser open\n");
  await vi.advanceTimersByTimeAsync(70000);
  expect(f.runner.kill).not.toHaveBeenCalled();
  expect(f.service.runs()[0]).toMatchObject({
    status: "running",
    dashboardOpened: true,
  });
  expect(f.service.runs()[0].output?.text).toContain("after browser open");
});
it("browser acknowledgement at expired deadline is rejected even before timer callback", async () => {
  const f = await fixture(1);
  vi.useFakeTimers();
  const run = await f.launch();
  observers.get(f.children[0]).onReady("http://localhost:4567");
  const clock = vi
    .spyOn(performance, "now")
    .mockReturnValue(performance.now() + 60000);
  expect(f.service.markDashboardOpened(run.id, "http://localhost:4567")).toBe(
    false,
  );
  clock.mockRestore();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.runner.kill).toHaveBeenCalledTimes(1);
  expect(f.service.runs()[0].status).toBe("failed");
});
it("settings apply only to next run; stop removes old deadline", async () => {
  const f = await fixture(1);
  vi.useFakeTimers();
  const a = await f.launch();
  const doc = await f.service.readProjectSettings(f.project.id);
  await f.service.saveProjectSettings(
    f.project.id,
    { ...doc.value, startupTimeoutMinutes: 2 },
    doc.version,
  );
  expect(f.service.runs()[0].startupTimeoutMs).toBe(60000);
  await f.service.stop(a.id);
  const b = await f.launch();
  expect(b.startupTimeoutMs).toBe(120000);
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.service.runs()[1].status).toBe("starting");
  expect(f.runner.kill).toHaveBeenCalledTimes(1);
});
it("startup browser failure stops owned process and preserves output; late callbacks cannot resurrect", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const run = await f.launch(),
    child = f.children[0];
  child.stderr.write("useful failure output\n");
  observers.get(child).onReady("http://localhost:4567");
  await f.service.dashboardFailed(run.id, "Не удалось открыть Dashboard");
  expect(f.service.runs()[0]).toMatchObject({
    status: "failed",
    error: "Не удалось открыть Dashboard",
  });
  expect(f.service.runs()[0].output?.text).toContain("useful failure output");
  observers.get(child).onReady("http://localhost:4567");
  expect(f.service.markDashboardOpened(run.id, "http://localhost:4567")).toBe(
    false,
  );
  expect(f.service.runs()[0].url).toBeUndefined();
});
it("after opened dashboard a page error is not a pipeline timeout or stop", async () => {
  const f = await fixture(1);
  vi.useFakeTimers();
  const run = await f.launch();
  observers.get(f.children[0]).onReady("http://localhost:4567");
  f.service.markDashboardOpened(run.id, "http://localhost:4567");
  await f.service.dashboardFailed(run.id, "Страница недоступна");
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.runner.kill).not.toHaveBeenCalled();
  expect(f.service.runs()[0].status).toBe("running");
});
it("timeout kill failure stays explicit and retains ownership until successful retry", async () => {
  const f = await fixture(1);
  vi.useFakeTimers();
  const run = await f.launch();
  f.runner.kill.mockRejectedValueOnce(Error("cannot kill"));
  await vi.advanceTimersByTimeAsync(60000);
  expect(f.service.runs()[0].error).toMatch(/остановить|остановк/);
  expect(f.service.runs()[0].status).toBe("starting");
  expect(f.service.runs()[0].url).toBeUndefined();
  const sibling = await f.launch();
  expect(sibling.status).toBe("starting");
  expect(f.service.runs().find((r) => r.id === run.id)?.status).toBe(
    "starting",
  );
  await f.service.stop(run.id);
  expect(f.service.runs()[0].status).toBe("stopped");
  expect(f.service.runs().find((r) => r.id === sibling.id)?.status).toBe(
    "starting",
  );
  expect(f.runner.kill).toHaveBeenCalledTimes(2);
  expect(f.runner.kill).toHaveBeenNthCalledWith(1, f.children[0]);
  expect(f.runner.kill).toHaveBeenNthCalledWith(2, f.children[0]);
  await f.service.stop(sibling.id);
  expect(f.service.runs().find((r) => r.id === sibling.id)?.status).toBe(
    "stopped",
  );
});
it("output is isolated across runs, masked before events and retained on exit/error", async () => {
  const f = await fixture();
  const doc = await f.service.readProjectSettings(f.project.id);
  await f.service.saveProjectSettings(
    f.project.id,
    {
      ...doc.value,
      env: [
        { key: "TOKEN", value: "private-token", secret: true, runtime: false },
      ],
    },
    doc.version,
  );
  vi.useFakeTimers();
  const seen: string[] = [];
  f.service.on("runs", (r) => seen.push(JSON.stringify(r)));
  const a = await f.launch();
  f.children[0].stdout.write("private-");
  await vi.advanceTimersByTimeAsync(200);
  f.children[0].stdout.write("token first\n");
  await vi.advanceTimersByTimeAsync(100);
  await f.service.stop(a.id);
  const b = await f.launch();
  f.children[1].stderr.write("second\n");
  await vi.advanceTimersByTimeAsync(100);
  expect(seen.join("")).not.toContain("private-token");
  expect(f.service.runs()[0].output?.text).toContain("first");
  expect(f.service.runs()[1].output?.text).not.toContain("first");
  observers.get(f.children[1]).onFailure(Error("process failed"));
  await vi.advanceTimersByTimeAsync(0);
  expect(f.service.runs()[1].status).toBe("failed");
  expect(f.service.runs()[1].output?.text).toContain("second");
});
it("process exiting after HTTP ready but before browser loaded is a startup failure", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  await f.launch();
  const observer = observers.get(f.children[0]);
  observer.onReady("http://localhost:4567");
  observer.onFinish(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(f.service.runs()[0].status).toBe("failed");
  expect(f.service.runs()[0].error).toMatch(/открыт|открытия/);
});

it("identifies the failed discovery command and exit code without printing command output", async () => {
  const { CommandExitError } = await import("../src/host/process");
  const f = await fixture();
  const original = f.runner.command.getMockImplementation()!;
  f.runner.command.mockImplementation(
    async (exe: string, args: string[], ...rest: unknown[]) => {
      if (args[0] === "pipeline")
        throw new CommandExitError(
          "generic",
          2,
          "secret-stdout",
          "secret-stderr",
        );
      return original(exe, args);
    },
  );
  await expect(f.service.discover(f.project.id)).rejects.toThrow(
    /goga pipeline --list --info.*кодом 2/,
  );
  await expect(f.service.discover(f.project.id)).rejects.not.toThrow(
    /secret-stdout|secret-stderr/,
  );
});

it("uses the same prepared shell PATH for discovery, preview and pipeline launch, with project override", async () => {
  const read = vi.fn(async () => "/fixture/cli:/usr/bin");
  const f = await fixture(undefined, read);
  await f.service.discover(f.project.id);
  await f.launch();
  const gogaCalls = f.runner.command.mock.calls.filter(
    ([exe]: any[]) => exe !== "git",
  );
  expect(gogaCalls.length).toBeGreaterThan(1);
  expect(
    gogaCalls.every(
      ([, , , env]: any[]) => env.PATH === "/fixture/cli:/usr/bin",
    ),
  ).toBe(true);
  expect((f.runner.start.mock.calls as any[][]).at(-1)?.[3]?.PATH).toBe(
    "/fixture/cli:/usr/bin",
  );
  const doc = await f.service.readProjectSettings(f.project.id);
  await f.service.saveProjectSettings(
    f.project.id,
    {
      ...doc.value,
      env: [
        { key: "PATH", value: "/explicit/bin", runtime: false, secret: false },
      ],
    },
    doc.version,
  );
  read.mockClear();
  await f.service.discover(f.project.id);
  expect(
    (f.runner.command.mock.calls as any[][])
      .filter(([exe]) => exe !== "git")
      .at(-1)?.[3]?.PATH,
  ).toBe("/explicit/bin");
  expect(read).not.toHaveBeenCalled();
});
