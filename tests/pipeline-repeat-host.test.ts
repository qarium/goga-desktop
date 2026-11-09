import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
vi.mock("../src/host/process", async (original) => ({
  ...(await original<any>()),
  watchDashboard: vi.fn(() => () => {}),
}));
import { HostService } from "../src/host/service";
import { ContextRunsStore } from "../src/host/context-runs-store";
import type { LaunchRequest } from "../src/shared/types";
const roots: string[] = [];
const services: HostService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture() {
  const root = await mkdtemp("/private/tmp/goga-repeat-host-");
  roots.push(root);
  const home = path.join(root, "home"),
    repo = path.join(root, "repo"),
    dataDir = path.join(root, "data");
  await mkdir(home);
  await mkdir(path.join(repo, ".git"), { recursive: true });
  for (const folder of ["workflows", "profiles"])
    await mkdir(path.join(repo, ".goga", folder), { recursive: true });
  await writeFile(
    path.join(repo, ".goga/workflows/quality.yml"),
    "name: quality\n",
  );
  await writeFile(path.join(repo, ".goga/profiles/fast.yml"), "env: {}\n");
  let branch = "main";
  const children: any[] = [];
  const runner = {
    command: vi.fn(async (exe: string, args: string[]) => {
      let stdout = "";
      if (exe === "git") {
        if (args.join(" ") === "rev-parse --show-toplevel") stdout = repo;
        else if (args.join(" ") === "rev-parse --git-common-dir")
          stdout = ".git";
        else if (args[0] === "rev-parse") stdout = "a".repeat(40);
        else if (args[0] === "branch") stdout = branch;
        else if (args[0] === "for-each-ref") stdout = "main";
        else if (args[0] !== "status")
          throw Error("Unexpected Git: " + args.join(" "));
      } else if (args[0] === "topics")
        stdout = JSON.stringify([
          { topic: "main", branch: "main", current: true },
        ]);
      else if (args.includes("--info"))
        stdout =
          "name: Editor\n---\n* work:\n  title: Work\n* review:\n  title: Review\n";
      else throw Error("Unexpected Goga: " + args.join(" "));
      return { stdout, stderr: "" };
    }),
    start: vi.fn(
      (
        _exe: string,
        _args: string[],
        _cwd: string,
        _env?: NodeJS.ProcessEnv,
      ) => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        });
        children.push(child);
        return child as any;
      },
    ),
    kill: vi.fn(async () => {}),
  };
  const create = () => {
    const service = new HostService({ home, dataDir, runner });
    services.push(service);
    return service;
  };
  const service = create(),
    project = await service.addProject(repo);
  const request: LaunchRequest = {
    projectId: project.id,
    pipeline: "editor",
    workflow: "file:quality",
    profile: "fast",
    profileMode: "project",
    skips: ["review"],
    expectedBranch: "main",
    confirmBranchSwitch: false,
    clean: true,
    update: true,
    topic: { mode: "none" },
    task: "",
    confirmEmptyTask: false,
  };
  return {
    root,
    home,
    repo,
    service,
    project,
    runner,
    children,
    request,
    create,
    setBranch: (value: string) => {
      branch = value;
    },
  };
}
it("captures the complete launch choices and repeats directly via the normal command", async () => {
  const f = await fixture();
  const first = await f.service.launch(f.request);
  expect(first.pipelineRepeat).toEqual({
    version: 1,
    workflow: "file:quality",
    profile: "fast",
    profileMode: "project",
    skips: ["review"],
    clean: true,
    update: true,
  });
  await f.service.dashboardFailed(first.id, "synthetic failure");
  const next = await f.service.repeatPipeline(first.id);
  expect(next.id).not.toBe(first.id);
  expect(next.pipelineRepeat).toEqual(first.pipelineRepeat);
  expect(f.runner.start.mock.calls[1].slice(0, 3)).toEqual(
    f.runner.start.mock.calls[0].slice(0, 3),
  );
  expect(f.service.runs().map((r) => r.id)).toEqual([first.id, next.id]);
  expect(f.service.runs()[0].status).toBe("failed");
});
it("repeats after reopening Desktop without preview or task tokens", async () => {
  const f = await fixture(),
    first = await f.service.launch(f.request);
  await f.service.stop(first.id);
  await f.service.dispose();
  const reopened = f.create();
  await reopened.initialize();
  const next = await reopened.repeatPipeline(first.id);
  expect(next.pipelineRepeat).toEqual(first.pipelineRepeat);
  expect(f.runner.start).toHaveBeenCalledTimes(2);
});
it("uses the current on-disk task without overwriting it or restoring its old snapshot", async () => {
  const f = await fixture();
  const task = await f.service.readTopicTask({
    projectId: f.project.id,
    branch: "main",
    topic: "main",
  });
  const file = path.join(f.repo, task.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "old task");
  const first = await f.service.launch({
    ...f.request,
    topic: { mode: "existing", branch: "main", topic: "main" },
    task: "old task",
  });
  await f.service.stop(first.id);
  await writeFile(file, "edited while looking at files");
  const next = await f.service.repeatPipeline(first.id);
  expect(next.taskSnapshot?.text).toBe("edited while looking at files");
  expect(await readFile(file, "utf8")).toBe("edited while looking at files");
  expect(
    f.runner.command.mock.calls.some(
      ([, args]) => args.includes("checkout") || args.includes("new"),
    ),
  ).toBe(false);
});
it("does not impose a TTL and rereads current environment instead of persisting secrets", async () => {
  const f = await fixture(),
    first = await f.service.launch({
      ...f.request,
      profile: "",
      profileMode: "auto",
    });
  await f.service.stop(first.id);
  const doc = await f.service.readProjectSettings(f.project.id);
  await f.service.saveProjectSettings(
    f.project.id,
    {
      ...doc.value,
      env: [
        {
          key: "TOKEN",
          value: "synthetic-secret",
          runtime: true,
          secret: true,
        },
      ],
    },
    doc.version,
  );
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400000);
  await f.service.repeatPipeline(first.id);
  expect(f.runner.start.mock.calls[1][1]).toContain("TOKEN=synthetic-secret");
  expect(
    await readFile(
      path.join(f.home, ".goga/desktop/context-runs.json"),
      "utf8",
    ),
  ).not.toContain("synthetic-secret");
});
it("coalesces concurrent repeats into one new process", async () => {
  const f = await fixture(),
    first = await f.service.launch(f.request);
  await f.service.stop(first.id);
  const [a, b] = await Promise.all([
    f.service.repeatPipeline(first.id),
    f.service.repeatPipeline(first.id),
  ]);
  expect(a.id).toBe(b.id);
  expect(f.runner.start).toHaveBeenCalledTimes(2);
});
it("never restarts a live source or runs in a different branch; releases failed attempts", async () => {
  const f = await fixture(),
    first = await f.service.launch(f.request);
  await expect(f.service.repeatPipeline(first.id)).rejects.toThrow(
    /заверш|работает/,
  );
  await f.service.stop(first.id);
  f.setBranch("elsewhere");
  await expect(f.service.repeatPipeline(first.id)).rejects.toThrow(/ветк/);
  expect(f.runner.start).toHaveBeenCalledTimes(1);
  f.setBranch("main");
  await f.service.repeatPipeline(first.id);
  expect(f.runner.start).toHaveBeenCalledTimes(2);
});
it("refuses unknown and legacy runs rather than guessing missing parameters", async () => {
  const f = await fixture();
  await expect(f.service.repeatPipeline("missing")).rejects.toThrow(/запуск/);
});

it.each([undefined, "build" as const])(
  "refuses persisted incomplete and build records without guessing %s",
  async (kind) => {
    const f = await fixture();
    await new ContextRunsStore(f.home).save([
      {
        id: "old",
        projectId: f.project.id,
        pipeline: "editor",
        topic: "",
        branch: "main",
        status: "failed",
        workflow: null,
        profile: null,
        startedAt: "2026-11-08T00:00:00.000Z",
        ...(kind ? { kind } : {}),
      },
    ]);
    await f.service.initialize();
    await expect(f.service.repeatPipeline("old")).rejects.toThrow(
      /параметр|отсутств/,
    );
    expect(f.runner.start).not.toHaveBeenCalled();
  },
);
it("retries a failed current composition without expiring or consuming the original choices", async () => {
  const f = await fixture(),
    first = await f.service.launch(f.request);
  await f.service.stop(first.id);
  const command = f.runner.command.getMockImplementation()!;
  f.runner.command.mockImplementation(async (exe, args) => {
    if (exe !== "git") throw Error("synthetic CLI error");
    return command(exe, args);
  });
  await expect(f.service.repeatPipeline(first.id)).rejects.toThrow(
    /pipeline editor.*не выполнена/,
  );
  f.runner.command.mockImplementation(command);
  const next = await f.service.repeatPipeline(first.id);
  expect(next.pipelineRepeat).toEqual(first.pipelineRepeat);
  expect(f.runner.start).toHaveBeenCalledTimes(2);
});
it("keeps private launch choices immutable when a renderer mutates its returned copy", async () => {
  const f = await fixture(),
    first = await f.service.launch(f.request);
  await f.service.stop(first.id);
  first.pipelineRepeat!.skips.push("work");
  const next = await f.service.repeatPipeline(first.id);
  expect(next.pipelineRepeat?.skips).toEqual(["review"]);
});
it("retains a primary topic's recorded year after a calendar rollover", async () => {
  const f = await fixture();
  const task = await f.service.readTopicTask({projectId:f.project.id,branch:"main",topic:"main"});
  const file = path.join(f.repo,task.path);
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,"recorded year task");
  const first=await f.service.launch({...f.request,topic:{mode:"existing",branch:"main",topic:"main"},task:""});await f.service.stop(first.id);
  const nextYear=Number(first.taskSnapshot!.year)+1;
  const other=path.join(f.repo,`.goga/history/${nextYear}/main/todo.md`);await mkdir(path.dirname(other),{recursive:true});await writeFile(other,"different owner year");
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date(`${nextYear}-01-01T12:00:00Z`));
  try {
    const repeated=await f.service.repeatPipeline(first.id);
    expect(repeated.taskSnapshot?.year).toBe(first.taskSnapshot!.year);
    expect(repeated.taskSnapshot?.text).toBe("recorded year task");
    expect(await readFile(other,"utf8")).toBe("different owner year");
  } finally {vi.useRealTimers();}
});
