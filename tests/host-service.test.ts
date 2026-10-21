import { it, expect, afterEach, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  symlink,
  stat,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner, type Runner } from "../src/host/process";
const dirs: string[] = [];
const services: HostService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()));
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});
async function setup(own = false) {
  const dir = await mkdtemp("/private/tmp/goga-service-");
  dirs.push(dir);
  const repo = path.join(dir, "repo"),
    home = path.join(dir, "home");
  await mkdir(repo);
  await mkdir(home);
  const node = new NodeRunner();
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
    ["commit", "--allow-empty", "-m", "initial"],
  ])
    await node.command("git", args, repo);
  await mkdir(path.join(repo, ".goga/workflows"), { recursive: true });
  await writeFile(
    path.join(repo, ".goga/workflows/build.yml"),
    "prompt: hi\nprofile: base\n",
  );
  await mkdir(path.join(repo, ".goga/profiles"));
  await writeFile(path.join(repo, ".goga/profiles/local.yml"), "{}");
  await mkdir(path.join(home, ".goga/profiles"), { recursive: true });
  await writeFile(path.join(home, ".goga/profiles/local.yml"), "{}");
  await node.command("git", ["add", "."], repo);
  await node.command("git", ["commit", "-m", "config"], repo);
  const calls: string[][] = [];
  const runner: Runner = {
    ...node,
    kill: node.kill.bind(node),
    start: (_exe, args, cwd) => {
      calls.push(args);
      return node.start(
        process.execPath,
        [
          "-e",
          `require('http').createServer((q,s)=>s.end(JSON.stringify({flow_name:'fixture',stages:[]}))).listen(0,'127.0.0.1',function(){console.log('dashboard: http://127.0.0.1:'+this.address().port)})`,
        ],
        cwd,
      );
    },
    command: async (exe, args, cwd) => {
      if (exe === "git") return node.command(exe, args, cwd);
      calls.push(args);
      if (args.includes("--list"))
        return {
          stdout: "* build\n    name: Build\n    description: Real\n",
          stderr: "",
        };
      if (args.includes("board"))
        return {
          stdout: JSON.stringify([
            {
              topic: own ? "main" : "existing",
              branch: "main",
              current: true,
              remote: false,
              todo: "old",
              statuses: ["todo"],
            },
          ]),
          stderr: "",
        };
      if (args.includes("--info"))
        return {
          stdout: `name: Build\n---\n${args.includes("plan") ? "" : "* plan:\n    title: Plan\n"}* work:\n    title: Work\n`,
          stderr: "",
        };
      throw new Error("unexpected mutation");
    },
  };
  const service = new HostService({
    home,
    dataDir: path.join(dir, "data"),
    goga: "fake",
    runner,
  });
  services.push(service);
  const project = await service.addProject(repo);
  return { service, project, repo, home, calls, node, runner };
}
it("registers canonical git root, persists projects and resolves profile precedence", async () => {
  const { service, project, repo } = await setup();
  await mkdir(path.join(repo, "nested"));
  expect((await service.addProject(path.join(repo, "nested"))).id).toBe(
    project.id,
  );
  expect(await service.listProjects()).toHaveLength(1);
  const d = await service.discover(project.id);
  expect(d.profiles).toEqual([{ name: "local", source: "project" }]);
  expect(d.workflows).toEqual(["build"]);
  expect(d.pipelines[0]?.name).toBe("Build");
});
it("previews filtered cards using same flags and refuses stale token or dirty new topic", async () => {
  const { service, project, repo, calls } = await setup();
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: ["plan"],
  };
  const p = await service.preview(req);
  expect(p.stages.map((s) => s.id)).toEqual(["work"]);
  expect(p.workflow).toBe("build");
  expect(p.profile).toBe("base");
  expect(calls.at(-1)).toContain("--skip");
  const launch = {
    ...req,
    previewToken: p.token,
    topic: { mode: "new" as const, name: "feat-x", baseRef: "HEAD" },
    task: "Task",
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: true,
    clean: false,
  };
  await expect(
    service.launch({ ...launch, clean: true, previewToken: "bogus" }),
  ).rejects.toThrow(/предпросмотр/i);
  await writeFile(path.join(repo, "dirty"), "x");
  await expect(service.launch(launch)).rejects.toThrow(/изменения|dirty/i);
  expect(calls.some((c) => c.includes("create"))).toBe(false);
});
it("definition fingerprint changes invalidate preview before any branch operation", async () => {
  const { service, project, repo, calls } = await setup();
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  await writeFile(
    path.join(repo, ".goga/workflows/build.yml"),
    "prompt: changed\n",
  );
  await expect(
    service.launch({
      ...req,
      previewToken: p.token,
      topic: { mode: "existing", branch: "main", topic: "existing" },
      task: "",
      confirmEmptyTask: false,
      taskVersion: "a".repeat(64),
      expectedBranch: "main",
      confirmBranchSwitch: true,
      clean: false,
    }),
  ).rejects.toThrow(/предпросмотр/i);
  expect(calls.some((c) => c.includes("create"))).toBe(false);
});
it("filters merged topic hosts because Goga uses current branch slug as work identity", async () => {
  const { service, project } = await setup();
  expect((await service.discover(project.id)).topics).toEqual([]);
});
it("starts independent process, holds checkout lock until stop, preserves run context", async () => {
  const { service, project, calls } = await setup(true);
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  const request = {
    ...req,
    previewToken: p.token,
    topic: { mode: "existing" as const, branch: "main", topic: "main" },
    task: "",
    confirmEmptyTask: false,
    taskVersion: (
      await service.readTopicTask({
        projectId: project.id,
        branch: "main",
        topic: "main",
      })
    ).version,
    expectedBranch: "main",
    confirmBranchSwitch: true,
    clean: false,
  };
  const run = await service.launch(request);
  expect(run.status).toBe("starting");
  await expect(service.launch(request)).rejects.toThrow(/Предпросмотр устарел/);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("readiness")), 3000);
    service.on("runs", (runs) => {
      if (runs[0].status === "starting" && runs[0].url)
        service.markDashboardOpened(runs[0].id, runs[0].url);
      if (runs[0].status === "running") {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  expect(service.runs()[0]).toMatchObject({
    branch: "main",
    topic: "main",
    status: "running",
  });
  expect(calls.at(-1)).toEqual(["pipeline", "build"]);
  await service.stop(run.id);
  expect(service.runs()[0]?.status).toBe("stopped");
  await service.dispose();
});
it("uses explicit selected source for new topic and forwards todo as one argument", async () => {
  const { service, project, repo, calls, node, runner } = await setup(true);
  const previous = runner.command.bind(runner);
  runner.command = async (exe, args, cwd) => {
    if (exe === "fake" && args[1] === "create") {
      calls.push(args);
      const base = args[args.indexOf("--base-ref") + 1]!;
      await node.command("git", ["switch", "-c", args[2]!, base], cwd);
      const directory = path.join(
        cwd,
        `.goga/history/${new Date().getFullYear()}/feat-one`,
      );
      await mkdir(directory, { recursive: true });
      // Goga's create path normalizes its actual persisted todo with a newline.
      await writeFile(
        path.join(directory, "todo.md"),
        args[args.indexOf("--todo") + 1]! + "\n",
      );
      return { stdout: "created", stderr: "" };
    }
    return previous(exe, args, cwd);
  };
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "none",
    profile: "",
    skips: ["plan"],
  };
  const p = await service.preview(req);
  const task = "literal $(touch unsafe)\nsecond line";
  const run = await service.launch({
    ...req,
    previewToken: p.token,
    topic: { mode: "new", name: "feat/One", baseRef: "HEAD" },
    task,
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: true,
    clean: false,
  });
  expect(calls.find((c) => c[1] === "create")).toEqual([
    "topics",
    "create",
    "feat/One",
    "--base-ref",
    "HEAD",
    "--switch",
    "--todo",
    task,
  ]);
  expect(run.taskSnapshot).toEqual({
    text: task + "\n",
    year: String(new Date().getFullYear()),
    topic: "feat-one",
    branch: "feat/One",
  });
  expect(run).toMatchObject({
    branch: "feat/One",
    topic: "feat-one",
    workflow: null,
    profile: null,
  });
  expect(calls.at(-1)).toEqual([
    "pipeline",
    "build",
    "--no-workflow",
    "--skip",
    "plan",
  ]);
  await service.stop(run.id);
  await service.dispose();
});
it("existing task saves exact editor text with matching version", async () => {
  const { service, project, repo } = await setup(true);
  const dir = path.join(
    repo,
    ".goga/history",
    String(new Date().getFullYear()),
    "main",
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "todo.md"), "Old task\n");
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  const launch = {
    ...req,
    previewToken: p.token,
    topic: { mode: "existing" as const, branch: "main", topic: "main" },
    task: "New task",
    confirmEmptyTask: false,
    taskVersion: (
      await service.readTopicTask({
        projectId: project.id,
        branch: "main",
        topic: "main",
      })
    ).version,
    expectedBranch: "main",
    confirmBranchSwitch: true,
    clean: false,
  };
  await expect(
    service.launch({ ...launch, taskVersion: "stale" }),
  ).rejects.toThrow(/измен|устарел/i);
  expect(await readFile(path.join(dir, "todo.md"), "utf8")).toBe("Old task\n");
  const run = await service.launch(launch);
  expect(await readFile(path.join(dir, "todo.md"), "utf8")).toBe("New task");
  await service.stop(run.id);
  await service.dispose();
});
it("invalidates preview when branch changes even at identical commit", async () => {
  const { service, project, repo, node } = await setup(true);
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  await node.command("git", ["switch", "-c", "other"], repo);
  await expect(
    service.launch({
      ...req,
      previewToken: p.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "",
      confirmEmptyTask: false,
      taskVersion: (
        await service.readTopicTask({
          projectId: project.id,
          branch: "main",
          topic: "main",
        })
      ).version,
      expectedBranch: "main",
      confirmBranchSwitch: true,
      clean: false,
    }),
  ).rejects.toThrow(/Предпросмотр/);
});
it("refuses changed final composition after creating branch and reports mutation", async () => {
  const { service, project, repo, node, runner } = await setup(true);
  const previous = runner.command.bind(runner);
  let switched = false;
  runner.command = async (exe, args, cwd) => {
    if (exe === "fake" && args[1] === "create") {
      await node.command(
        "git",
        ["switch", "-c", args[2]!, args[args.indexOf("--base-ref") + 1]!],
        cwd,
      );
      switched = true;
      return { stdout: "created", stderr: "" };
    }
    if (exe === "fake" && args.includes("--info") && switched)
      return { stdout: "* different:\n    title: Changed\n", stderr: "" };
    return previous(exe, args, cwd);
  };
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  await expect(
    service.launch({
      ...req,
      previewToken: p.token,
      topic: { mode: "new", name: "different", baseRef: "HEAD" },
      task: "Task",
      confirmEmptyTask: false,
      expectedBranch: "main",
      confirmBranchSwitch: true,
      clean: false,
    }),
  ).rejects.toThrow(/автоматического отката нет/);
  expect(service.runs()).toEqual([]);
  expect(
    (
      await node.command("git", ["branch", "--show-current"], repo)
    ).stdout.trim(),
  ).toBe("different");
});
it("refuses definitions changed while final launch composition is being resolved", async () => {
  const { service, project, repo, runner } = await setup(true);
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  const previous = runner.command.bind(runner);
  runner.command = async (exe, args, cwd) => {
    const result = await previous(exe, args, cwd);
    if (exe === "fake" && args.includes("--info"))
      await writeFile(
        path.join(repo, ".goga/workflows/build.yml"),
        "prompt: changed\nprofile: base\n",
      );
    return result;
  };
  await expect(
    service.launch({
      ...req,
      previewToken: p.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "",
      confirmEmptyTask: false,
      taskVersion: (
        await service.readTopicTask({
          projectId: project.id,
          branch: "main",
          topic: "main",
        })
      ).version,
      expectedBranch: "main",
      confirmBranchSwitch: true,
      clean: false,
    }),
  ).rejects.toThrow(/предпросмотр/i);
});
it("no workflow refuses an explicit profile rather than letting Goga silently ignore it", async () => {
  const { service, project, calls } = await setup(true);
  await expect(
    service.preview({
      projectId: project.id,
      pipeline: "build",
      workflow: "none",
      profile: "local",
      skips: [],
    }),
  ).rejects.toThrow(/без рабочего процесса/);
  expect(calls.some((c) => c.includes("--profile"))).toBe(false);
});
it("rejects occupied branch before create and never claims a mutation", async () => {
  const { service, project, calls } = await setup(true);
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  let error = "";
  try {
    await service.launch({
      ...req,
      previewToken: p.token,
      topic: { mode: "new", name: "main", baseRef: "HEAD" },
      task: "Task",
      confirmEmptyTask: false,
      expectedBranch: "main",
      confirmBranchSwitch: true,
      clean: false,
    });
  } catch (e) {
    error = (e as Error).message;
  }
  expect(error).toMatch(/занято/);
  expect(error).not.toMatch(/уже изменена/);
  expect(calls.some((c) => c[1] === "create")).toBe(false);
});
it("detects partial mutation when Goga create fails after switching", async () => {
  const { service, project, runner, node } = await setup(true);
  const prev = runner.command.bind(runner);
  runner.command = async (exe, args, cwd) => {
    if (exe === "fake" && args[1] === "create") {
      await node.command("git", ["switch", "-c", args[2]!], cwd);
      throw new Error("Creation failed");
    }
    return prev(exe, args, cwd);
  };
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await service.preview(req);
  await expect(
    service.launch({
      ...req,
      previewToken: p.token,
      topic: { mode: "new", name: "partial", baseRef: "HEAD" },
      task: "Task",
      confirmEmptyTask: false,
      expectedBranch: "main",
      confirmBranchSwitch: true,
      clean: false,
    }),
  ).rejects.toThrow(/уже изменена/);
});

it.each(["starting", "running"] as const)(
  "dispose keeps intentional %s shutdown stopped without error",
  async (status) => {
    const { service, project, runner, node } = await setup(true);
    runner.dispose = node.dispose.bind(node);
    if (status === "starting")
      runner.start = (_exe, _args, cwd) =>
        node.start(process.execPath, ["-e", "setInterval(()=>{},1000)"], cwd);
    const req = {
      projectId: project.id,
      pipeline: "build",
      workflow: "auto",
      profile: "",
      skips: [],
    };
    const preview = await service.preview(req);
    await service.launch({
      ...req,
      previewToken: preview.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "",
      confirmEmptyTask: false,
      taskVersion: (
        await service.readTopicTask({
          projectId: project.id,
          branch: "main",
          topic: "main",
        })
      ).version,
      expectedBranch: "main",
      confirmBranchSwitch: true,
      clean: false,
    });
    if (status === "running") {
      for (let i = 0; i < 60 && service.runs()[0]?.status !== "running"; i++) {
        const candidate = service.runs()[0];
        if (candidate?.url)
          service.markDashboardOpened(candidate.id, candidate.url);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(service.runs()[0]?.status).toBe(status);
    await service.dispose();
    expect(service.runs()[0]?.status).toBe("stopped");
    expect(service.runs()[0]?.error).toBeUndefined();
  },
);

it("does not report stopped or release the run when termination fails", async () => {
  const { service, project, runner, node } = await setup(true);
  runner.dispose = node.dispose.bind(node);
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(req);
  const run = await service.launch({
    ...req,
    previewToken: preview.token,
    topic: { mode: "existing", branch: "main", topic: "main" },
    task: "",
    confirmEmptyTask: false,
    taskVersion: (
      await service.readTopicTask({
        projectId: project.id,
        branch: "main",
        topic: "main",
      })
    ).version,
    expectedBranch: "main",
    confirmBranchSwitch: true,
    clean: false,
  });
  const kill = runner.kill;
  runner.kill = async () => {
    throw new Error("termination failed");
  };
  await expect(service.dispose()).rejects.toThrow("termination failed");
  expect(service.runs()[0]?.status).not.toBe("stopped");
  runner.kill = kill;
  await service.stop(run.id);
});

it.each([false, true])(
  "forwards clean=%s only to the final run while preserving composition and topic",
  async (clean) => {
    const { service, project, calls } = await setup(true);
    const req = {
      projectId: project.id,
      pipeline: "build",
      workflow: "file:build",
      profile: "local",
      skips: ["plan"],
    };
    const preview = await service.preview(req);
    const run = await service.launch({
      ...req,
      clean,
      previewToken: preview.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "",
      confirmEmptyTask: false,
      taskVersion: (
        await service.readTopicTask({
          projectId: project.id,
          branch: "main",
          topic: "main",
        })
      ).version,
      expectedBranch: "main",
      confirmBranchSwitch: true,
    });
    expect(calls.at(-1)).toEqual([
      "pipeline",
      "build",
      "--workflow",
      "build",
      "--profile",
      "local",
      "--skip",
      "plan",
      ...(clean ? ["--clean"] : []),
    ]);
    expect(calls.slice(0, -1).every((args) => !args.includes("--clean"))).toBe(
      true,
    );
    expect(run).toMatchObject({
      topic: "main",
      branch: "main",
      pipeline: "build",
      workflow: "build",
      profile: "local",
    });
    await service.stop(run.id);
  },
);
it("rejects invalid clean without running commands or consuming preview", async () => {
  const { service, project, calls } = await setup(true);
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(req);
  const version = (
    await service.readTopicTask({
      projectId: project.id,
      branch: "main",
      topic: "main",
    })
  ).version;
  const count = calls.length;
  for (const clean of [undefined, null, "true", 1, {}, []]) {
    await expect(
      service.launch({
        ...req,
        clean,
        previewToken: preview.token,
        topic: { mode: "existing", branch: "main", topic: "main" },
        task: "",
        confirmEmptyTask: false,
        taskVersion: version,
        expectedBranch: "main",
        confirmBranchSwitch: true,
      } as any),
    ).rejects.toThrow(/clean|очист|состояни/i);
  }
  expect(calls).toHaveLength(count);
  expect(service.runs()).toHaveLength(0);
});

async function closeFixture() {
  const f = await setup(true);
  const req = {
    projectId: f.project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const p = await f.service.preview(req);
  const run = await f.service.launch({
    ...req,
    clean: false,
    previewToken: p.token,
    topic: { mode: "existing", branch: "main", topic: "main" },
    task: "",
    confirmEmptyTask: false,
    taskVersion: (
      await f.service.readTopicTask({
        projectId: f.project.id,
        branch: "main",
        topic: "main",
      })
    ).version,
    expectedBranch: "main",
    confirmBranchSwitch: true,
  });
  return { ...f, run };
}
it.each(["stopped", "exited", "failed"])(
  "closes terminal %s without confirmation or runtime deletion",
  async (status) => {
    const { service, run, repo } = await closeFixture();
    await service.stop(run.id);
    (service as any).runList[0].status = status;
    const marker = path.join(repo, "keep-history");
    await writeFile(marker, "keep");
    let asked = 0;
    expect(
      await service.closeRun(run.id, async () => {
        asked++;
        return true;
      }),
    ).toBe(true);
    expect(asked).toBe(0);
    expect(service.runs()).toEqual([]);
    expect(await readFile(marker, "utf8")).toBe("keep");
  },
);
it.each(["starting", "running", "failed"])(
  "uses authoritative child ownership for %s cancel/confirm",
  async (status) => {
    const { service, run } = await closeFixture();
    (service as any).runList[0].status = status;
    let asked = 0;
    expect(
      await service.closeRun(run.id, async () => {
        asked++;
        return false;
      }),
    ).toBe(false);
    expect(service.runs()).toHaveLength(1);
    expect((service as any).children.has(run.id)).toBe(true);
    expect(
      await service.closeRun(run.id, async () => {
        asked++;
        return true;
      }),
    ).toBe(true);
    expect(asked).toBe(2);
    expect(service.runs()).toEqual([]);
    expect((service as any).children.has(run.id)).toBe(false);
  },
);
it("coalesces duplicate closes, tolerates completion during confirmation and leaves other runs alone", async () => {
  const { service, run } = await closeFixture();
  const other = { ...service.runs()[0], id: "other", status: "exited" };
  (service as any).runList.push(other);
  let resolve!: (v: boolean) => void;
  let asked = 0;
  const confirm = () => {
    asked++;
    return new Promise<boolean>((r) => (resolve = r));
  };
  const a = service.closeRun(run.id, confirm),
    b = service.closeRun(run.id, confirm);
  await Promise.resolve();
  expect(asked).toBe(1);
  await service.stop(run.id);
  resolve(true);
  expect(await a).toBe(true);
  expect(await b).toBe(true);
  expect(service.runs().map((r) => r.id)).toEqual(["other"]);
});
it("preserves tab and checkout lock on close-stop failure and allows retry", async () => {
  const { service, run, runner } = await closeFixture();
  const kill = runner.kill;
  runner.kill = async () => {
    throw new Error("Cannot stop selected process");
  };
  await expect(service.closeRun(run.id, async () => true)).rejects.toThrow(
    "Cannot stop",
  );
  expect(service.runs()[0]?.error).toContain("Cannot stop");
  expect((service as any).activeKeys.size).toBe(1);
  runner.kill = kill;
  await service.closeRun(run.id, async () => true);
  expect(service.runs()).toEqual([]);
});
it("rejects unknown close ids without asking or changing other runs", async () => {
  const { service, run } = await closeFixture();
  let asked = false;
  await expect(
    service.closeRun("unknown", async () => {
      asked = true;
      return true;
    }),
  ).rejects.toThrow(/Неизвестный/);
  expect(asked).toBe(false);
  expect(service.runs()[0]?.id).toBe(run.id);
});

it("cancel after natural exit retains the terminal tab and does not kill again", async () => {
  const { service, run, node } = await closeFixture();
  let resolve!: (v: boolean) => void;
  const closing = service.closeRun(
    run.id,
    () => new Promise((r) => (resolve = r)),
  );
  await Promise.resolve();
  const child = (service as any).children.get(run.id).child;
  await node.kill(child);
  for (let i = 0; i < 60 && (service as any).children.has(run.id); i++)
    await new Promise((r) => setTimeout(r, 25));
  expect((service as any).children.has(run.id)).toBe(false);
  resolve(false);
  expect(await closing).toBe(false);
  expect(service.runs()[0]?.status).toBe("failed");
});
it("coalesces concurrent explicit stop and confirmed close", async () => {
  const { service, run, runner } = await closeFixture();
  const kill = runner.kill;
  let kills = 0;
  runner.kill = async (child) => {
    kills++;
    await kill(child);
  };
  await Promise.all([
    service.stop(run.id),
    service.closeRun(run.id, async () => true),
  ]);
  expect(kills).toBe(1);
  expect(service.runs()).toEqual([]);
});

it("requires explicit branch-switch consent for another target but not the current branch", async () => {
  const { service, project, node, repo, calls } = await setup(true);
  const params = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  await node.command("git", ["switch", "-c", "other"], repo);
  const preview = await service.preview(params);
  const request = {
    ...params,
    previewToken: preview.token,
    topic: { mode: "existing" as const, branch: "main", topic: "main" },
    task: "",
    confirmEmptyTask: false,
    taskVersion: (
      await service.readTopicTask({
        projectId: project.id,
        branch: "main",
        topic: "main",
      })
    ).version,
    clean: false,
    expectedBranch: "other",
    confirmBranchSwitch: false,
  };
  await expect(service.launch(request)).rejects.toThrow(
    /Подтвердите переключение/,
  );
  expect(
    (
      await node.command("git", ["branch", "--show-current"], repo)
    ).stdout.trim(),
  ).toBe("other");
  expect(service.runs()).toEqual([]);
  const run = await service.launch({ ...request, confirmBranchSwitch: true });
  await service.stop(run.id);
  const currentPreview = await service.preview(params);
  const currentRun = await service.launch({
    ...request,
    previewToken: currentPreview.token,
    expectedBranch: "main",
    confirmBranchSwitch: false,
  });
  expect(currentRun.branch).toBe("main");
  await service.stop(currentRun.id);
});
it("blocks stale displayed branch even with a fresh pipeline preview without changing checkout or task", async () => {
  const { service, project, node, repo, calls } = await setup(true);
  await node.command("git", ["switch", "-c", "other"], repo);
  const params = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(params);
  await expect(
    service.launch({
      ...params,
      previewToken: preview.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "Do not write",
      confirmEmptyTask: true,
      taskVersion: (
        await service.readTopicTask({
          projectId: project.id,
          branch: "main",
          topic: "main",
        })
      ).version,
      clean: true,
      expectedBranch: "main",
      confirmBranchSwitch: true,
    }),
  ).rejects.toThrow(/Текущая ветка изменилась/);
  expect(
    (
      await node.command("git", ["branch", "--show-current"], repo)
    ).stdout.trim(),
  ).toBe("other");
  expect(service.runs()).toEqual([]);
  expect(calls.some((args) => args.includes("--clean"))).toBe(false);
});
it.each(["HEAD", "main"])(
  "new topic from %s always requires switch consent",
  async (baseRef) => {
    const { service, project, calls } = await setup(true);
    const params = {
      projectId: project.id,
      pipeline: "build",
      workflow: "auto",
      profile: "",
      skips: [],
    };
    const preview = await service.preview(params);
    await expect(
      service.launch({
        ...params,
        previewToken: preview.token,
        topic: { mode: "new", name: "new-topic", baseRef },
        task: "",
        confirmEmptyTask: false,
        clean: false,
        expectedBranch: "main",
        confirmBranchSwitch: false,
      }),
    ).rejects.toThrow(/Подтвердите переключение/);
    expect(calls.some((args) => args[1] === "create")).toBe(false);
  },
);
it("reads actual checkout branch without trusting topic.current", async () => {
  const { service, project, node, repo } = await setup(true);
  expect(await service.checkoutBranch(project.id)).toBe("main");
  await node.command("git", ["switch", "-c", "changed"], repo);
  expect(await service.checkoutBranch(project.id)).toBe("changed");
});

it("rechecks the branch immediately before creating a new topic after slow validation", async () => {
  const { service, project, node, repo, runner, calls } = await setup(true);
  const params = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(params);
  const previous = runner.command.bind(runner);
  let changed = false;
  runner.command = async (exe, args, cwd) => {
    const result = await previous(exe, args, cwd);
    if (exe === "git" && args[0] === "ls-tree" && !changed) {
      changed = true;
      await node.command("git", ["switch", "-c", "external"], repo);
    }
    return result;
  };
  await expect(
    service.launch({
      ...params,
      previewToken: preview.token,
      topic: { mode: "new", name: "new-topic", baseRef: "HEAD" },
      task: "",
      confirmEmptyTask: false,
      clean: false,
      expectedBranch: "main",
      confirmBranchSwitch: true,
    }),
  ).rejects.toThrow(/Текущая ветка изменилась/);
  expect(calls.some((args) => args[1] === "create")).toBe(false);
  expect(
    (
      await node.command("git", ["branch", "--show-current"], repo)
    ).stdout.trim(),
  ).toBe("external");
  expect(service.runs()).toEqual([]);
});

it("reads current actual task, distinguishes missing/empty, validates selection and never switches", async () => {
  const { service, project, repo, node } = await setup(true);
  const selection = { projectId: project.id, branch: "main", topic: "main" };
  const absent = await service.readTopicTask(selection);
  expect(absent).toMatchObject({
    text: "",
    exists: false,
    path: `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  });
  const file = path.join(repo, absent.path);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
  const empty = await service.readTopicTask(selection);
  expect(empty.exists).toBe(true);
  expect(empty.version).not.toBe(absent.version);
  const text = "Полная задача\n\n" + "detail\n".repeat(1000);
  await writeFile(file, text);
  const before = await stat(file);
  expect((await service.readTopicTask(selection)).text).toBe(text);
  expect(await readFile(file, "utf8")).toBe(text);
  const after = await stat(file);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  for (const forged of [
    { ...selection, projectId: "unknown" },
    { ...selection, topic: "../main" },
    { ...selection, branch: "other" },
  ])
    await expect(service.readTopicTask(forged)).rejects.toThrow();
  expect(
    (
      await node.command("git", ["branch", "--show-current"], repo)
    ).stdout.trim(),
  ).toBe("main");
});
it("reads noncurrent committed task without using current ignored text or changing checkout", async () => {
  const { service, project, repo, node } = await setup(true);
  const file = path.join(
    repo,
    `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "committed exact");
  await node.command("git", ["add", "."], repo);
  await node.command("git", ["commit", "-m", "task"], repo);
  await node.command("git", ["switch", "-c", "other"], repo);
  await writeFile(file, "different current text");
  const before = await stat(file);
  expect(
    (
      await service.readTopicTask({
        projectId: project.id,
        branch: "main",
        topic: "main",
      })
    ).text,
  ).toBe("committed exact");
  expect(await readFile(file, "utf8")).toBe("different current text");
  const after = await stat(file);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBe(before.mtimeMs);
  expect(
    (
      await node.command("git", ["branch", "--show-current"], repo)
    ).stdout.trim(),
  ).toBe("other");
});
it("rejects filesystem symlinks, directories, invalid utf8 and oversized tasks rather than showing empty", async () => {
  const { service, project, repo } = await setup(true);
  const selection = { projectId: project.id, branch: "main", topic: "main" };
  const file = path.join(
    repo,
    `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await symlink(path.join(repo, ".goga/workflows/build.yml"), file);
  await expect(service.readTopicTask(selection)).rejects.toThrow(/ссыл/i);
  await rm(file);
  await mkdir(file);
  await expect(service.readTopicTask(selection)).rejects.toThrow();
  await rm(file, { recursive: true });
  await writeFile(file, Buffer.from([255]));
  await expect(service.readTopicTask(selection)).rejects.toThrow();
  await writeFile(file, "x".repeat(100001));
  await expect(service.readTopicTask(selection)).rejects.toThrow();
});
it("unchanged task does not write and blank replacement requires specific confirmation", async () => {
  const { service, project, repo } = await setup(true);
  const selection = { projectId: project.id, branch: "main", topic: "main" };
  const file = path.join(
    repo,
    `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "keep exact");
  const params = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const before = await stat(file);
  const doc = await service.readTopicTask(selection);
  const request = {
    ...params,
    previewToken: (await service.preview(params)).token,
    topic: { mode: "existing" as const, branch: "main", topic: "main" },
    task: doc.text,
    taskVersion: doc.version,
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: false,
    clean: false,
  };
  const run = await service.launch(request);
  expect(run.taskSnapshot).toEqual({
    text: request.task,
    year: String(new Date().getFullYear()),
    topic: "main",
    branch: "main",
  });
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
  await writeFile(file, "changed after launch");
  expect(run.taskSnapshot?.text).toBe(request.task);
  await writeFile(file, request.task);
  await service.stop(run.id);
  expect((await stat(file)).ino).toBe(before.ino);
  // Snapshot remains independent of later working-copy writes.
  request.previewToken = (await service.preview(params)).token;
  await expect(service.launch({ ...request, task: "" })).rejects.toThrow(
    /пуст/i,
  );
  expect(await readFile(file, "utf8")).toBe("keep exact");
  const cleared = await service.launch({
    ...request,
    task: "",
    confirmEmptyTask: true,
  });
  await service.stop(cleared.id);
  expect(await readFile(file, "utf8")).toBe("");
});
it("rejects changes during final composition before saving editor text", async () => {
  const { service, project, repo, runner } = await setup(true);
  const file = path.join(
    repo,
    `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original");
  const params = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(params);
  const doc = await service.readTopicTask({
    projectId: project.id,
    branch: "main",
    topic: "main",
  });
  const previous = runner.command.bind(runner);
  runner.command = async (exe, args, cwd) => {
    const result = await previous(exe, args, cwd);
    if (exe === "fake" && args.includes("--info"))
      await writeFile(file, "external");
    return result;
  };
  await expect(
    service.launch({
      ...params,
      previewToken: preview.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "edited",
      taskVersion: doc.version,
      confirmEmptyTask: false,
      expectedBranch: "main",
      confirmBranchSwitch: false,
      clean: false,
    }),
  ).rejects.toThrow(/измен|устарел/i);
  expect(await readFile(file, "utf8")).toBe("external");
  expect(service.runs()).toEqual([]);
});

async function switchTaskFixture() {
  const f = await setup(true);
  const file = path.join(
    f.repo,
    `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "original");
  await f.node.command("git", ["add", "."], f.repo);
  await f.node.command("git", ["commit", "-m", "task"], f.repo);
  await f.node.command("git", ["switch", "-c", "other"], f.repo);
  const params = {
    projectId: f.project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const doc = await f.service.readTopicTask({
    projectId: f.project.id,
    branch: "main",
    topic: "main",
  });
  const request = {
    ...params,
    previewToken: (await f.service.preview(params)).token,
    topic: { mode: "existing" as const, branch: "main", topic: "main" },
    task: "edited",
    taskVersion: doc.version,
    confirmEmptyTask: false,
    expectedBranch: "other",
    confirmBranchSwitch: true,
    clean: false,
  };
  return { ...f, file, params, doc, request };
}
it("rejects stale task before any checkout mutation", async () => {
  const { service, project, repo, node, runner, request } =
    await switchTaskFixture();
  const previous = runner.command.bind(runner);
  const switches: string[][] = [];
  runner.command = async (exe, args, cwd) => {
    if (exe === "git" && args[0] === "switch") switches.push(args);
    return previous(exe, args, cwd);
  };
  await expect(
    service.launch({ ...request, taskVersion: "a".repeat(64) }),
  ).rejects.toThrow(/измен|устарел/i);
  expect(switches).toEqual([]);
  expect(await service.checkoutBranch(project.id)).toBe("other");
  expect(service.runs()).toEqual([]);
});
it("rejects task changed during checkout without overwriting external text", async () => {
  const { service, project, file, runner, request } = await switchTaskFixture();
  const previous = runner.command.bind(runner);
  runner.command = async (exe, args, cwd) => {
    const result = await previous(exe, args, cwd);
    if (exe === "git" && args[0] === "switch")
      await writeFile(file, "external checkout");
    return result;
  };
  await expect(service.launch(request)).rejects.toThrow(
    /измен.*автоматического отката нет/i,
  );
  expect(await readFile(file, "utf8")).toBe("external checkout");
  expect(await service.checkoutBranch(project.id)).toBe("main");
  expect(service.runs()).toEqual([]);
});
it("does not overwrite ignored collisions when checking out the target task", async () => {
  const { service, project, repo, node, file, params, request } =
    await switchTaskFixture();
  await node.command("git", ["rm", file], repo);
  await writeFile(path.join(repo, ".gitignore"), ".goga/history/\n");
  await node.command("git", ["add", "."], repo);
  await node.command("git", ["commit", "-m", "ignore history"], repo);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "ignored local secret task");
  request.previewToken = (await service.preview(params)).token;
  await expect(service.launch(request)).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("ignored local secret task");
  expect(await service.checkoutBranch(project.id)).toBe("other");
  expect(service.runs()).toEqual([]);
});
it("rejects committed symlinks, invalid utf8 and tree leaf instead of treating them as missing", async () => {
  const { service, project, repo, node } = await setup(true);
  const file = path.join(
    repo,
    `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  );
  await mkdir(path.dirname(file), { recursive: true });
  const select = { projectId: project.id, branch: "main", topic: "main" };
  for (const kind of ["link", "utf8", "directory", "ancestor"]) {
    await rm(path.join(repo, ".goga/history"), {
      recursive: true,
      force: true,
    });
    await mkdir(path.dirname(file), { recursive: true });
    if (kind === "link") await symlink("/tmp/secret", file);
    if (kind === "utf8") await writeFile(file, Buffer.from([255]));
    if (kind === "directory") {
      await mkdir(file);
      await writeFile(path.join(file, "child"), "x");
    }
    if (kind === "ancestor") {
      await rm(path.dirname(file), { recursive: true });
      await symlink("/tmp/secret", path.dirname(file));
    }
    await node.command("git", ["add", "-A"], repo);
    await node.command("git", ["commit", "-m", kind], repo);
    await node.command("git", ["switch", "-C", "other"], repo);
    await expect(service.readTopicTask(select)).rejects.toThrow();
    await node.command("git", ["switch", "main"], repo);
  }
});
it("rechecks target revision after slow validation before checkout", async () => {
  const { service, project, repo, node, runner, params, request } =
    await switchTaskFixture();
  await writeFile(path.join(repo, "other-only"), "x");
  await node.command("git", ["add", "."], repo);
  await node.command("git", ["commit", "-m", "other commit"], repo);
  const other = (
    await node.command("git", ["rev-parse", "HEAD"], repo)
  ).stdout.trim();
  request.previewToken = (await service.preview(params)).token;
  const previous = runner.command.bind(runner);
  let moved = false;
  runner.command = async (exe, args, cwd) => {
    const result = await previous(exe, args, cwd);
    if (exe === "git" && args[0] === "status" && !moved) {
      moved = true;
      await node.command("git", ["update-ref", "refs/heads/main", other], repo);
    }
    return result;
  };
  await expect(service.launch(request)).rejects.toThrow(/измен|устарел/i);
  expect(await service.checkoutBranch(project.id)).toBe("other");
  expect(service.runs()).toEqual([]);
});
it("checks actual branch again after writing and refuses to start in an externally switched checkout", async () => {
  const { service, repo, node, runner, file, request } =
    await switchTaskFixture();
  const previous = runner.command.bind(runner);
  let changed = false;
  runner.command = async (exe, args, cwd) => {
    if (
      exe === "git" &&
      args[0] === "branch" &&
      (await readFile(file, "utf8")) === "edited" &&
      !changed
    ) {
      changed = true;
      await node.command("git", ["switch", "other"], repo);
    }
    return previous(exe, args, cwd);
  };
  await expect(service.launch(request)).rejects.toThrow(/ветка.*изменилась/i);
  expect(changed).toBe(true);
  expect(service.runs()).toEqual([]);
});

it("invalidates editor snapshot at local year rollover", async () => {
  const { service, project, request } = await switchTaskFixture();
  const year = new Date().getFullYear();
  const spy = vi.spyOn(Date.prototype, "getFullYear").mockReturnValue(year + 1);
  try {
    await expect(service.launch(request)).rejects.toThrow(/измен|устарел/i);
    expect(await service.checkoutBranch(project.id)).toBe("other");
    expect(service.runs()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});
it("refuses registered project path replaced by symlink", async () => {
  const { service, project, repo } = await setup(true);
  await rename(repo, repo + "-moved");
  await symlink(repo + "-moved", repo);
  await expect(
    service.readTopicTask({
      projectId: project.id,
      branch: "main",
      topic: "main",
    }),
  ).rejects.toThrow(/ссыл/i);
});
it("noncurrent missing task is distinct from empty committed file", async () => {
  const { service, project, repo, node } = await setup(true);
  const file = path.join(
    repo,
    `.goga/history/${new Date().getFullYear()}/main/todo.md`,
  );
  await node.command("git", ["switch", "-c", "other"], repo);
  const missing = await service.readTopicTask({
    projectId: project.id,
    branch: "main",
    topic: "main",
  });
  expect(missing.exists).toBe(false);
  await node.command("git", ["switch", "main"], repo);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
  await node.command("git", ["add", "."], repo);
  await node.command("git", ["commit", "-m", "empty task"], repo);
  await node.command("git", ["switch", "other"], repo);
  const empty = await service.readTopicTask({
    projectId: project.id,
    branch: "main",
    topic: "main",
  });
  expect(empty.exists).toBe(true);
  expect(empty.text).toBe("");
  expect(empty.version).not.toBe(missing.version);
});
it("keeps existing task untouched when final composition fails", async () => {
  const { service, runner, file, request } = await switchTaskFixture();
  const previous = runner.command.bind(runner);
  runner.command = async (exe, args, cwd) =>
    exe === "fake" && args.includes("--info")
      ? { stdout: "* changed:\n    title: Different\n", stderr: "" }
      : previous(exe, args, cwd);
  await expect(service.launch(request)).rejects.toThrow(/предпросмотр/i);
  expect(await readFile(file, "utf8")).toBe("original");
  expect(service.runs()).toEqual([]);
});
it("rejects replaced project root before executing any launch command", async () => {
  const { service, repo, runner, request } = await switchTaskFixture();
  await rename(repo, repo + "-moved");
  await symlink(repo + "-moved", repo);
  runner.command = async () => {
    throw new Error("unexpected command after project replacement");
  };
  await expect(service.launch(request)).rejects.toThrow(/ссыл/i);
});
it.each(["text", "missing", "commit"] as const)(
  "rejects %s changed during the first branch check after saving before process start",
  async (kind) => {
    const { service, repo, node, runner, file, request } =
      await switchTaskFixture();
    const previous = runner.command.bind(runner);
    let changed = false;
    let starts = 0;
    const start = runner.start.bind(runner);
    runner.start = (...args) => {
      starts++;
      return start(...args);
    };
    const other = (
      await node.command("git", ["rev-parse", "HEAD^"], repo)
    ).stdout.trim();
    runner.command = async (exe, args, cwd) => {
      const result = await previous(exe, args, cwd);
      if (
        exe === "git" &&
        args[0] === "branch" &&
        !changed &&
        (await readFile(file, "utf8")) === "edited"
      ) {
        changed = true;
        if (kind === "text") await writeFile(file, "external after save");
        if (kind === "missing") await rm(file);
        if (kind === "commit")
          await node.command(
            "git",
            ["update-ref", "refs/heads/main", other],
            repo,
          );
      }
      return result;
    };
    await expect(service.launch(request)).rejects.toThrow(/измен|устарел/i);
    expect(changed).toBe(true);
    expect(starts).toBe(0);
    expect(service.runs()).toEqual([]);
    if (kind === "text")
      expect(await readFile(file, "utf8")).toBe("external after save");
  },
);
it("uses project binary/env for all Goga metadata and sends only runtime rows to pipeline argv", async () => {
  const { service, project, runner, calls } = await setup(true);
  const oldCommand = runner.command,
    oldStart = runner.start;
  const seen: { exe: string; args: string[]; env: any }[] = [];
  runner.command = async (exe, args, cwd, env) => {
    if (exe !== "git") seen.push({ exe, args, env });
    return oldCommand(exe, args, cwd, env);
  };
  runner.start = (exe, args, cwd, env) => {
    seen.push({ exe, args, env });
    return oldStart(exe, args, cwd, env);
  };
  const before = await service.readProjectSettings(project.id);
  await service.saveProjectSettings(
    project.id,
    {
      executable: "/tmp/fake binary with spaces",
      profile: "local",
      env: [
        { key: "DEMO_HOST", value: "host only", secret: false, runtime: false },
        { key: "DEMO_RUNTIME", value: "a=b c", secret: true, runtime: true },
        { key: "DEMO_EMPTY", value: "", secret: false, runtime: true },
        {
          key: "HTTP_PROXY",
          value: "http://127.0.0.1:9",
          secret: false,
          runtime: true,
        },
        {
          key: "HTTPS_PROXY",
          value: "http://127.0.0.1:10",
          secret: true,
          runtime: true,
        },
        {
          key: "NO_PROXY",
          value: "localhost,127.0.0.1",
          secret: false,
          runtime: true,
        },
      ],
    },
    before.version,
  );
  const discovery = await service.discover(project.id);
  expect(discovery.projectSettings?.profile).toBe("local");
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(req);
  expect(preview.profile).toBe("local");
  const task = await service.readTopicTask({
    projectId: project.id,
    branch: "main",
    topic: "main",
  });
  await service.launch({
    ...req,
    previewToken: preview.token,
    expectedBranch: "main",
    confirmBranchSwitch: false,
    clean: false,
    confirmEmptyTask: false,
    topic: { mode: "existing", branch: "main", topic: "main" },
    task: task.text,
    taskVersion: task.version,
  });
  for (const call of seen) {
    expect(call.exe).toBe("/tmp/fake binary with spaces");
    expect(call.env.DEMO_HOST).toBe("host only");
    expect(call.env.DEMO_RUNTIME).toBe("a=b c");
    expect(call.env.HTTP_PROXY).toBe("http://127.0.0.1:9");
    expect(call.env.HTTPS_PROXY).toBe("http://127.0.0.1:10");
    expect(call.env.NO_PROXY).toBe("localhost,127.0.0.1");
  }
  const run = seen.at(-1)!;
  expect(run.args).toContain("--profile");
  expect(run.args).toContain("local");
  expect(run.args.slice(-10)).toEqual([
    "-e",
    "DEMO_RUNTIME=a=b c",
    "-e",
    "DEMO_EMPTY=",
    "-e",
    "HTTP_PROXY=http://127.0.0.1:9",
    "-e",
    "HTTPS_PROXY=http://127.0.0.1:10",
    "-e",
    "NO_PROXY=localhost,127.0.0.1",
  ]);
  expect(run.args.join("|")).not.toContain("DEMO_HOST");
  for (const c of seen.slice(0, -1)) expect(c.args).not.toContain("-e");
  const runningSnapshot = service.runs();
  const stored = await service.readProjectSettings(project.id);
  await service.saveProjectSettings(
    project.id,
    { ...stored.value, executable: "future-goga", profile: "", env: [] },
    stored.version,
  );
  expect(service.runs()[0]?.profile).toBe(runningSnapshot[0]?.profile);
  expect(service.runs()[0]?.id).toBe(runningSnapshot[0]?.id);
  expect(run.exe).toBe("/tmp/fake binary with spaces");
  expect(run.env.DEMO_RUNTIME).toBe("a=b c");
  expect(process.env.DEMO_HOST).toBeUndefined();
  expect(calls.some((c) => c.includes("board"))).toBe(true);
});
it("project settings revision invalidates old preview; explicit automatic bypasses project default", async () => {
  const { service, project, runner } = await setup(true);
  const req = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(req);
  const settings = await service.readProjectSettings(project.id);
  await service.saveProjectSettings(
    project.id,
    { ...settings.value, profile: "local" },
    settings.version,
  );
  await expect(
    service.launch({
      ...req,
      previewToken: preview.token,
      expectedBranch: "main",
      confirmBranchSwitch: false,
      clean: false,
      confirmEmptyTask: false,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "",
      taskVersion: "a".repeat(64),
    }),
  ).rejects.toThrow(/устарел/);
  expect((await service.preview({ ...req, profileMode: "auto" })).profile).toBe(
    "base",
  );
  expect((await service.preview(req)).profile).toBe("local");
  const updated = await service.readProjectSettings(project.id);
  await expect(
    service.saveProjectSettings(
      project.id,
      { ...updated.value, profile: "deleted" },
      updated.version,
    ),
  ).rejects.toThrow(/профил/i);
});
it("isolates settings across two projects and keeps saved profile missing errors explicit", async () => {
  const a = await setup(true),
    b = await setup(true);
  const second = await a.service.addProject(b.repo);
  const doc = await a.service.readProjectSettings(a.project.id);
  await a.service.saveProjectSettings(
    a.project.id,
    {
      ...doc.value,
      executable: "versioned-goga",
      profile: "local",
      env: [
        {
          key: "CANARY",
          value: "canary-not-a-secret",
          secret: true,
          runtime: false,
        },
      ],
    },
    doc.version,
  );
  expect(
    (await a.service.readProjectSettings(second.id)).value.executable,
  ).toBe("goga");
  const seen: any[] = [];
  const old = a.runner.command;
  a.runner.command = async (exe, args, cwd, env) => {
    if (exe !== "git") seen.push({ exe, env, cwd });
    return old(exe, args, cwd, env);
  };
  await Promise.all([
    a.service.discover(a.project.id),
    a.service.discover(second.id),
  ]);
  expect(
    seen
      .filter((x) => x.cwd === a.repo)
      .every(
        (x) =>
          x.exe === "versioned-goga" && x.env.CANARY === "canary-not-a-secret",
      ),
  ).toBe(true);
  expect(
    seen
      .filter((x) => x.cwd === b.repo)
      .every((x) => x.exe === "fake" && !x.env.CANARY),
  ).toBe(true);
  await rm(path.join(a.repo, ".goga/profiles/local.yml"));
  await rm(path.join(a.home, ".goga/profiles/local.yml"));
  await expect(
    a.service.preview({
      projectId: a.project.id,
      pipeline: "build",
      workflow: "auto",
      profile: "",
      skips: [],
    }),
  ).rejects.toThrow(/профиль отсутствует/);
});
it("refuses a selected profile when Goga would ignore it without a workflow", async () => {
  const { service, project } = await setup();
  await expect(
    service.preview({
      projectId: project.id,
      pipeline: "build",
      workflow: "none",
      profile: "local",
      skips: [],
    }),
  ).rejects.toThrow(/без рабочего процесса/);
});
it("rejects metadata finishing with changed settings and strips configured values from failures", async () => {
  const { service, project, runner } = await setup();
  const first = await service.readProjectSettings(project.id);
  const doc = await service.saveProjectSettings(
    project.id,
    {
      ...first.value,
      env: [
        {
          key: "CANARY",
          value: "private-canary-123",
          secret: true,
          runtime: false,
        },
      ],
    },
    first.version,
  );
  const old = runner.command;
  let changed = false;
  runner.command = async (exe, args, cwd, env) => {
    if (exe !== "git" && !changed) {
      changed = true;
      await service.saveProjectSettings(
        project.id,
        { ...doc.value, executable: "another" },
        doc.version,
      );
    }
    return old(exe, args, cwd, env);
  };
  await expect(service.discover(project.id)).rejects.toThrow(
    /изменились|устарел/,
  );
  runner.command = async (exe, args, cwd, env) => {
    if (exe !== "git") throw Error("oops private-canary-123");
    return old(exe, args, cwd, env);
  };
  await expect(service.discover(project.id)).rejects.not.toThrow(
    "private-canary-123",
  );
});
it("executes distinct real fake executables with space paths and exact per-project child env", async () => {
  const a = await setup(true),
    b = await setup(true);
  const second = await a.service.addProject(b.repo);
  const directory = path.dirname(a.repo);
  const script = path.join(directory, "fake goga executable");
  await writeFile(
    script,
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.cwd()+'/fixture-argv.jsonl',JSON.stringify({args,env:process.env.ONLY_CANARY})+'\\n');if(args.includes('--list'))console.log('* build\\n    name: Build');else if(args.includes('board'))console.log('[]');else console.log('* check:\\n    title: Check');\n`,
    { mode: 0o700 },
  );
  const script2 = path.join(directory, "other executable");
  await writeFile(script2, await readFile(script), { mode: 0o700 });
  // Real spawned commands, using only temporary repos and fake sentinel values.
  const node = a.node;
  const old = a.runner.command;
  a.runner.command = (exe, args, cwd, env) =>
    exe === "git"
      ? old(exe, args, cwd, env)
      : node.command(exe, args, cwd, env);
  for (const [p, exe, value] of [
    [a.project, script, "one=space value"],
    [second, script2, "two"],
  ] as const) {
    const doc = await a.service.readProjectSettings(p.id);
    await a.service.saveProjectSettings(
      p.id,
      {
        ...doc.value,
        executable: exe,
        env: [{ key: "ONLY_CANARY", value, secret: true, runtime: false }],
      },
      doc.version,
    );
    await a.service.discover(p.id);
    await a.service.preview({
      projectId: p.id,
      pipeline: "build",
      workflow: "none",
      profile: "",
      skips: [],
    });
  }
  for (const [repo, value] of [
    [a.repo, "one=space value"],
    [b.repo, "two"],
  ]) {
    const entries = (
      await readFile(path.join(repo, "fixture-argv.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(entries).toHaveLength(3);
    expect(entries.every((x) => x.env === value)).toBe(true);
    expect(entries.some((x) => x.args.includes("board"))).toBe(true);
    expect(entries.every((x) => !x.args.includes("-e"))).toBe(true);
  }
  expect(process.env.ONLY_CANARY).toBeUndefined();
});

it.each(["x".repeat(50000), "я".repeat(12000), "a\ud800b"])(
  "rejects external unsafe environment before any command or launch side effect %#",
  async (value) => {
    const { service, project, repo, home, runner, node } = await setup();
    const req = {
      projectId: project.id,
      pipeline: "build",
      workflow: "auto",
      profile: "",
      skips: [],
    };
    const preview = await service.preview(req);
    const { createHash } = await import("node:crypto");
    const file = path.join(
      home,
      ".goga/desktop/settings",
      createHash("sha256").update(project.id).digest("hex") + ".json",
    );
    const disk = JSON.parse(await readFile(file, "utf8"));
    disk.value.env = [{ key: "AUDIT_BIG", value, secret: true, runtime: true }];
    const externalRaw = JSON.stringify(disk);
    await writeFile(file, externalRaw);
    const before = (await node.command("git", ["status", "--porcelain"], repo))
      .stdout;
    const command = vi.spyOn(runner, "command"),
      start = vi.spyOn(runner, "start");
    await expect(
      service.launch({
        ...req,
        previewToken: preview.token,
        topic: { mode: "new", name: "must-not-exist", baseRef: "HEAD" },
        task: "Must not write",
        confirmEmptyTask: false,
        expectedBranch: "main",
        confirmBranchSwitch: true,
        clean: false,
      }),
    ).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(service.runs()).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(externalRaw);
    expect(
      (await node.command("git", ["status", "--porcelain"], repo)).stdout,
    ).toBe(before);
    expect(
      (
        await node.command("git", ["branch", "--show-current"], repo)
      ).stdout.trim(),
    ).toBe("main");
  },
);

it.each(["x".repeat(50000), "a\ud800b", "a\nb"])(
  "rejects unsafe environment through real IPC and host without save or command %#",
  async (value) => {
    const { registerIPC } = await import("../src/main/ipc");
    const { service, project, runner } = await setup();
    const before = await service.readProjectSettings(project.id);
    const handlers = new Map<string, Function>();
    registerIPC(
      { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
      {
        service,
        window: { webContents: { id: 1 } },
        shellURL: "file:///app/index.html",
      } as any,
    );
    const command = vi.spyOn(runner, "command"),
      start = vi.spyOn(runner, "start");
    await expect(
      Promise.resolve().then(() =>
        handlers.get("goga:save-project-settings")!(
          {
            sender: { id: 1 },
            senderFrame: { url: "file:///app/index.html", parent: null },
          },
          project.id,
          {
            ...before.value,
            env: [{ key: "AUDIT_BIG", value, secret: true, runtime: true }],
          },
          before.version,
        ),
      ),
    ).rejects.toThrow();
    expect(await service.readProjectSettings(project.id)).toEqual(before);
    expect(command).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  },
);

it.each([
  { update: undefined, clean: false },
  { update: false, clean: false },
  { update: true, clean: false },
  { update: undefined, clean: true },
  { update: false, clean: true },
  { update: true, clean: true },
])(
  "forwards update=$update and clean=$clean only to the final run",
  async ({ update, clean }) => {
    const { service, project, calls } = await setup(true);
    const params = {
      projectId: project.id,
      pipeline: "build",
      workflow: "file:build",
      profile: "local",
      skips: ["plan"],
    };
    await service.discover(project.id);
    // Even a direct caller's extra launch flag must not reach preview/info argv.
    const preview = await service.preview({ ...params, update: true } as any);
    const run = await service.launch({
      ...params,
      ...(update === undefined ? {} : { update }),
      clean,
      previewToken: preview.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "",
      confirmEmptyTask: false,
      taskVersion: (
        await service.readTopicTask({
          projectId: project.id,
          branch: "main",
          topic: "main",
        })
      ).version,
      expectedBranch: "main",
      confirmBranchSwitch: false,
    });
    expect(calls.at(-1)).toEqual([
      "pipeline",
      "build",
      "--workflow",
      "build",
      "--profile",
      "local",
      "--skip",
      "plan",
      ...(clean ? ["--clean"] : []),
      ...(update ? ["--update"] : []),
    ]);
    expect(
      calls
        .slice(0, -1)
        .every(
          (args) => !args.includes("--update") && !args.includes("--clean"),
        ),
    ).toBe(true);
    expect(run).toMatchObject({
      topic: "main",
      branch: "main",
      workflow: "build",
      profile: "local",
    });
    await service.stop(run.id);
    // The choice belongs to one launch, not the next request or saved preview.
    const next = await service.preview(params);
    const nextRun = await service.launch({
      ...params,
      clean: false,
      previewToken: next.token,
      topic: { mode: "existing", branch: "main", topic: "main" },
      task: "",
      confirmEmptyTask: false,
      taskVersion: (
        await service.readTopicTask({
          projectId: project.id,
          branch: "main",
          topic: "main",
        })
      ).version,
      expectedBranch: "main",
      confirmBranchSwitch: false,
    });
    expect(calls.at(-1)).not.toContain("--update");
    expect(calls.at(-1)).not.toContain("--clean");
    await service.stop(nextRun.id);
  },
);

it("rejects invalid update before commands or task writes without consuming preview", async () => {
  const { service, project, runner } = await setup(true);
  const params = {
    projectId: project.id,
    pipeline: "build",
    workflow: "auto",
    profile: "",
    skips: [],
  };
  const preview = await service.preview(params);
  const selection = { projectId: project.id, branch: "main", topic: "main" };
  const task = await service.readTopicTask(selection);
  const request = {
    ...params,
    clean: false,
    previewToken: preview.token,
    topic: { mode: "existing" as const, branch: "main", topic: "main" },
    task: "Must not be written",
    taskVersion: task.version,
    confirmEmptyTask: false,
    expectedBranch: "main",
    confirmBranchSwitch: false,
  };
  const command = vi.spyOn(runner, "command");
  const start = vi.spyOn(runner, "start");
  for (const update of [null, "true", "false", 0, 1, {}, []]) {
    await expect(service.launch({ ...request, update } as any)).rejects.toThrow(
      /update|обновлен/i,
    );
  }
  expect(command).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(service.runs()).toEqual([]);
  expect(await service.readTopicTask(selection)).toEqual(task);
  const run = await service.launch({ ...request, task: task.text });
  expect(start).toHaveBeenCalledOnce();
  await service.stop(run.id);
});

it.each(["existing", "new"] as const)(
  "update does not bypass switch confirmation for %s topic",
  async (mode) => {
    const { service, project, runner, node, repo } = await setup(true);
    await node.command("git", ["switch", "-c", "other"], repo);
    const params = {
      projectId: project.id,
      pipeline: "build",
      workflow: "auto",
      profile: "",
      skips: [],
    };
    const preview = await service.preview(params);
    const start = vi.spyOn(runner, "start");
    await expect(
      service.launch({
        ...params,
        clean: false,
        update: true,
        previewToken: preview.token,
        topic:
          mode === "existing"
            ? { mode, branch: "main", topic: "main" }
            : { mode, name: "new-topic", baseRef: "main" },
        task: "",
        ...(mode === "existing"
          ? {
              taskVersion: (
                await service.readTopicTask({
                  projectId: project.id,
                  branch: "main",
                  topic: "main",
                })
              ).version,
            }
          : {}),
        confirmEmptyTask: false,
        expectedBranch: "other",
        confirmBranchSwitch: false,
      }),
    ).rejects.toThrow(/Подтвердите переключение/);
    expect(start).not.toHaveBeenCalled();
    expect(service.runs()).toEqual([]);
    expect(
      (
        await node.command("git", ["branch", "--show-current"], repo)
      ).stdout.trim(),
    ).toBe("other");
    expect(
      (
        await node.command("git", ["branch", "--list", "new-topic"], repo)
      ).stdout.trim(),
    ).toBe("");
  },
);
