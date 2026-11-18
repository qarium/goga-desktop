import { beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import {
  NodeRunner,
  CommandExitError,
  CommandSpawnError,
  RunnerShutdownError,
  type Runner,
} from "../src/host/process";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fsControl = vi.hoisted(() => ({ deny: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    lstat: (file: unknown, ...args: unknown[]) => {
      if (fsControl.deny && String(file) === fsControl.deny)
        return Promise.reject(
          Object.assign(Error("metadata permission denied"), {
            code: "EACCES",
          }),
        );
      return (original.lstat as any)(file, ...args);
    },
  };
});
beforeEach(() => {
  fsControl.deny = "";
});
const scope = installGitFixtureScope();
async function fixture(pipeline = false) {
  const dir = await fs.mkdtemp("/private/tmp/goga-registration-");
  scope().cleanup(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"),
    folder = path.join(dir, "folder");
  await fs.mkdir(home);
  await fs.mkdir(folder);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "",
    LC_ALL: "C",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = scope.runner(new NodeRunner(15000, env));
  const commands: { executable: string; args: string[]; cwd: string }[] = [];
  const starts: { executable: string; args: string[]; cwd: string }[] = [];
  const pipelineRunner: Runner = {
    command: async (executable, args, cwd, commandEnv, stdin) => {
      commands.push({ executable, args: [...args], cwd });
      if (executable === "git")
        return runner.command(executable, args, cwd, commandEnv, stdin);
      if (args.includes("--list"))
        return { stdout: "* example\n    name: Example\n", stderr: "" };
      if (args.includes("board")) return { stdout: "[]", stderr: "" };
      if (args.includes("--info"))
        return {
          stdout: "name: Example\n---\n* work:\n    title: Work\n",
          stderr: "",
        };
      throw Error("Unexpected synthetic Goga command");
    },
    start: (executable, args, cwd) => {
      starts.push({ executable, args: [...args], cwd });
      return runner.start(
        process.execPath,
        [
          "-e",
          "require('http').createServer((q,s)=>s.end(JSON.stringify({flow_name:'fixture',stages:[]}))).listen(0,'127.0.0.1',function(){console.log('dashboard: http://127.0.0.1:'+this.address().port)})",
        ],
        cwd,
        env,
      );
    },
    kill: (child) => runner.kill(child),
  };
  const host = new HostService({
    home,
    dataDir: path.join(dir, "data"),
    runner: pipeline ? pipelineRunner : runner,
    goga: "/nonexistent/disabled-goga",
  });
  scope().cleanup(() => host.dispose());
  scope().cleanup(() => runner.dispose());
  return { folder, runner, host: scope().own(host), env, commands, starts };
}

it(
  "loads, previews and launches a no-topic pipeline in a plain folder without Git or history writes",
  scope.run(async () => {
    const f = await fixture(true);
    await fs.writeFile(path.join(f.folder, "keep.txt"), "untouched");
    const project = await f.host.addProject(f.folder);
    f.commands.splice(0);
    const catalog = await f.host.discover(project.id);
    expect(catalog).toMatchObject({
      repository: "missing",
      topics: [],
      branches: [],
      currentBranch: "",
      pipelines: [{ id: "example", name: "Example" }],
    });
    const request = {
      projectId: project.id,
      pipeline: "example",
      workflow: "none",
      profile: "",
      skips: [],
    };
    const preview = await f.host.preview(request);
    expect(preview.stages).toEqual([{ id: "work", title: "Work" }]);
    expect(await f.host.checkoutBranch(project.id)).toBe("");
    const run = await f.host.launch({
      ...request,
      previewToken: preview.token,
      topic: { mode: "none" },
      task: "",
      confirmEmptyTask: false,
      expectedBranch: "",
      confirmBranchSwitch: false,
      clean: false,
    });
    expect(run).toMatchObject({
      projectId: project.id,
      pipeline: "example",
      branch: "",
      topic: "",
      status: "starting",
    });
    expect(f.starts).toEqual([
      {
        executable: "/nonexistent/disabled-goga",
        args: ["pipeline", "example", "--no-workflow"],
        cwd: f.folder,
      },
    ]);
    await vi.waitFor(() => {
      const row = f.host.runs().find((row) => row.id === run.id);
      if (!row?.url) throw Error(JSON.stringify(row));
      expect(row.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });
    expect(f.commands.every((call) => call.executable !== "git")).toBe(true);
    expect(f.commands.some((call) => call.args[0] === "topics")).toBe(false);
    await f.host.stop(run.id);
    expect(await fs.readdir(f.folder)).toEqual(["keep.txt"]);
    expect(await fs.readFile(path.join(f.folder, "keep.txt"), "utf8")).toBe(
      "untouched",
    );
  }),
);

it(
  "rediscovers Git added after a plain-folder pipeline catalog was opened",
  scope.run(async () => {
    const f = await fixture(true),
      project = await f.host.addProject(f.folder);
    expect((await f.host.discover(project.id)).repository).toBe("missing");
    await f.runner.command(
      "git",
      ["init", "--template=", "-b", "main"],
      f.folder,
      f.env,
    );
    expect((await f.host.discover(project.id)).repository).toBe("ready");
    expect(await f.host.checkoutBranch(project.id)).toBe("main");
  }),
);

it.each(["new", "existing"] as const)(
  "refuses a %s-topic pipeline without initializing Git or writing task history",
  scope.run(async (mode) => {
    const f = await fixture(true),
      project = await f.host.addProject(f.folder);
    f.commands.splice(0);
    await expect(
      f.host.launch({
        projectId: project.id,
        pipeline: "example",
        workflow: "none",
        profile: "",
        skips: [],
        previewToken: "presentation",
        expectedBranch: "",
        confirmBranchSwitch: true,
        clean: false,
        confirmEmptyTask: false,
        task: "draft task",
        topic:
          mode === "new"
            ? { mode, name: "fresh", baseRef: "HEAD" }
            : { mode, topic: "fresh", branch: "fresh" },
      }),
    ).rejects.toThrow(/Git/i);
    expect(f.starts).toEqual([]);
    expect(f.commands.every((call) => call.executable !== "git")).toBe(true);
    expect(await fs.readdir(f.folder)).toEqual([]);
  }),
);

it.each(["malformed", "permission"] as const)(
  "does not suppress %s Git metadata errors when loading a pipeline catalog",
  scope.run(async (mode) => {
    const f = await fixture(true),
      project = await f.host.addProject(f.folder);
    if (mode === "malformed") await fs.mkdir(path.join(f.folder, ".git"));
    else fsControl.deny = path.join(f.folder, ".git");
    await expect(f.host.discover(project.id)).rejects.toThrow();
    expect(f.starts).toEqual([]);
  }),
);

it(
  "keeps unverified primary-run admission tied to its project when Git is added later",
  scope.run(async () => {
    const f = await fixture(true),
      project = await f.host.addProject(f.folder);
    const host = f.host as any;
    host.runList.push({
      id: "unverified",
      projectId: project.id,
      status: "running",
      recovery: "unverified",
    });
    const request = {
      projectId: project.id,
      pipeline: "example",
      workflow: "none",
      profile: "",
      skips: [],
      previewToken: "presentation",
      expectedBranch: "",
      confirmBranchSwitch: false,
      clean: false,
      confirmEmptyTask: false,
      task: "",
      topic: { mode: "none" as const },
    };
    try {
      await expect(f.host.launch(request)).rejects.toThrow(/не подтверждено/);
      await f.runner.command(
        "git",
        ["init", "--template=", "-b", "main"],
        f.folder,
        f.env,
      );
      await expect(
        f.host.launch({ ...request, expectedBranch: "main" }),
      ).rejects.toThrow(/не подтверждено/);
      expect(f.starts).toEqual([]);
    } finally {
      host.runList = [];
    }
  }),
);

it(
  "registers a plain local folder without Git initialization, supports files/settings and detects Git added later",
  scope.run(async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.folder, "keep.txt"), "untouched");
    const project = await f.host.addProject(f.folder);
    expect(project.path).toBe(f.folder);
    expect(await f.host.listProjects()).toEqual([project]);
    expect(await fs.readdir(f.folder)).toEqual(["keep.txt"]);
    expect(await f.host.readGitSummary(project.id)).toMatchObject({
      scope: project.id,
      repository: "missing",
      branch: null,
    });
    expect(
      (await f.host.listOverviewDirectory(project.id, "")).entries.map(
        (e) => e.name,
      ),
    ).toContain("keep.txt");
    const file = await f.host.readOverviewFile(project.id, "keep.txt");
    expect(file.text).toBe("untouched");
    expect(
      (await f.host.readProjectSettings(project.id)).value.executable,
    ).toBe("goga");
    await f.host.saveOverviewFile(
      project.id,
      "keep.txt",
      "new text",
      file.version,
    );
    await expect(
      f.host.saveOverviewFile(project.id, "keep.txt", "old text", file.version),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(f.folder, "keep.txt"), "utf8")).toBe(
      "new text",
    );
    expect(await fs.readdir(f.folder)).toEqual(["keep.txt"]);
    expect(await f.host.addProject(f.folder)).toEqual(project);
    await f.runner.command(
      "git",
      ["init", "--template=", "-b", "main"],
      f.folder,
      f.env,
    );
    const withGit = await f.host.readGitSummary(project.id);
    expect(withGit.repository).not.toBe("missing");
    expect(withGit.branch).toBe("main");
    expect(await f.host.addProject(f.folder)).toEqual(project);
    await fs.mkdir(path.join(f.folder, "nested"));
    expect(await f.host.addProject(path.join(f.folder, "nested"))).toEqual(
      project,
    );
    expect(await f.host.listProjects()).toHaveLength(1);
  }),
);
it.each(["ENOENT", "EACCES", "refused"])(
  "does not require an available Git probe (%s) to register a local folder",
  scope.run(async (code) => {
    const f = await fixture();
    vi.spyOn(f.runner, "command").mockRejectedValueOnce(
      code === "refused"
        ? new CommandExitError(
            "Git refused",
            128,
            "",
            "fatal: detected dubious ownership",
          )
        : new CommandSpawnError("Git unavailable", code),
    );
    const project = await f.host.addProject(f.folder);
    expect(project.path).toBe(f.folder);
    expect(await f.host.listProjects()).toEqual([project]);
    expect(await fs.readdir(f.folder)).toEqual([]);
  }),
);
it(
  "never retargets the selected folder to an unrelated root reported by the optional probe",
  scope.run(async () => {
    const f = await fixture(),
      other = path.join(path.dirname(f.folder), "other");
    await fs.mkdir(other);
    vi.spyOn(f.runner, "command").mockResolvedValueOnce({
      stdout: other + "\n",
      stderr: "",
    });
    expect((await f.host.addProject(f.folder)).path).toBe(f.folder);
  }),
);
it(
  "rejects files as project folders and cannot register after Host shutdown",
  scope.run(async () => {
    const f = await fixture(),
      file = path.join(f.folder, "not-a-folder");
    await fs.writeFile(file, "keep");
    await expect(f.host.addProject(file)).rejects.toThrow(/папку/);
    expect(await f.host.listProjects()).toEqual([]);
    await f.host.dispose();
    await expect(f.host.addProject(f.folder)).rejects.toThrow(/завершает/);
  }),
);
it(
  "does not downgrade malformed Git metadata to the missing-repository state",
  scope.run(async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.folder, ".git"));
    const project = await f.host.addProject(f.folder);
    await expect(f.host.readGitSummary(project.id)).rejects.toThrow();
  }),
);

it.each(["environment", "global config"])(
  "does not let Git %s tracing write into the selected plain folder",
  scope.run(async (source) => {
    const f = await fixture(),
      target = path.join(f.folder, "trace.json");
    if (source === "environment") f.env.GIT_TRACE2_EVENT = target;
    else {
      const config = path.join(path.dirname(f.folder), "global.gitconfig");
      await fs.writeFile(config, `[trace2]\n eventTarget = ${target}\n`);
      f.env.GIT_CONFIG_GLOBAL = config;
    }
    const project = await f.host.addProject(f.folder);
    expect(project.path).toBe(f.folder);
    expect(await fs.readdir(f.folder)).toEqual([]);
  }),
);
it(
  "does not turn an explicitly cancelled Git probe into a successful project registration",
  scope.run(async () => {
    const f = await fixture();
    vi.spyOn(f.runner, "command").mockRejectedValueOnce(
      new RunnerShutdownError("interrupted"),
    );
    await expect(f.host.addProject(f.folder)).rejects.toBeInstanceOf(
      RunnerShutdownError,
    );
    expect(await f.host.listProjects()).toEqual([]);
  }),
);
it(
  "keeps a metadata permission failure distinct from missing Git",
  scope.run(async () => {
    const f = await fixture(),
      project = await f.host.addProject(f.folder);
    fsControl.deny = path.join(f.folder, ".git");
    await expect(f.host.readGitSummary(project.id)).rejects.toThrow(
      "metadata permission denied",
    );
  }),
);

it(
  "unregisters a missing folder without requiring Git or deleting settings",
  scope.run(async () => {
    const f = await fixture();
    const p = await f.host.addProject(f.folder);
    await fs.rmdir(f.folder);
    expect(await f.host.removeProject({ id: p.id, path: p.path })).toEqual([]);
    expect(await f.host.listProjects()).toEqual([]);
  }),
);
it.each(["starting", "running", "unverified", "child"])(
  "keeps project registration while %s owns it, without stopping anything",
  scope.run(async (state: string) => {
    const f = await fixture();
    const p = await f.host.addProject(f.folder);
    const host = f.host as any;
    {
      host.runList.push({
        id: "run",
        projectId: p.id,
        status: state === "unverified" || state === "child" ? "failed" : state,
        ...(state === "unverified" ? { recovery: "unverified" } : {}),
      });
      if (state === "child") host.children.set("run", { child: {} });
    }
    try {
      await expect(
        f.host.removeProject({ id: p.id, path: p.path }),
      ).rejects.toThrow(/запуск|терминал/i);
      expect(await f.host.listProjects()).toEqual([p]);
    } finally {
      host.runList = [];
      host.children.clear();
      host.terminalLeases.clear();
    }
  }),
);
it(
  "does not let a different project's active run block removal",
  scope.run(async () => {
    const f = await fixture();
    const p = await f.host.addProject(f.folder);
    (f.host as any).runList.push({
      id: "other-run",
      projectId: "other",
      status: "running",
    });
    try {
      expect(await f.host.removeProject({ id: p.id, path: p.path })).toEqual(
        [],
      );
    } finally {
      (f.host as any).runList = [];
    }
  }),
);

it(
  "holds registration until a terminal lease is released",
  scope.run(async () => {
    const f = await fixture();
    const p = await f.host.addProject(f.folder);
    // Exercise public host lease admission without starting a shell or PTY.
    vi.spyOn(f.host, "prepareTerminalLaunch").mockResolvedValue({
      dispose: vi.fn(),
    } as any);
    const lease = await f.host.acquireTerminalContext(p.id);
    try {
      await expect(
        f.host.removeProject({ id: p.id, path: p.path }),
      ).rejects.toThrow(/терминал/i);
    } finally {
      lease.release();
    }
    expect(await f.host.removeProject({ id: p.id, path: p.path })).toEqual([]);
  }),
);

it(
  "cannot reattribute a live topic lease using a failed request with the same contextId",
  scope.run(async () => {
    const f = await fixture();
    const p = await f.host.addProject(f.folder);
    const secondFolder = path.join(path.dirname(f.folder), "second");
    await fs.mkdir(secondFolder);
    const q = await f.host.addProject(secondFolder);
    vi.spyOn(f.host, "prepareTerminalLaunch")
      .mockResolvedValueOnce({ dispose: vi.fn() } as any)
      .mockRejectedValueOnce(Error("Wrong clone owner"));
    const ref = {
      projectId: p.id,
      year: "2026",
      topic: "topic",
      branch: "topic",
      contextId: "ctx-" + "a".repeat(64),
      revision: "11111111-1111-4111-8111-111111111111",
    };
    const lease = await f.host.acquireTerminalContext(ref);
    try {
      await expect(
        f.host.acquireTerminalContext({ ...ref, projectId: q.id }),
      ).rejects.toThrow("Wrong clone owner");
      await expect(
        f.host.removeProject({ id: p.id, path: p.path }),
      ).rejects.toThrow(/терминал/i);
      expect(await f.host.removeProject({ id: q.id, path: q.path })).toEqual([
        p,
      ]);
    } finally {
      lease.release();
    }
    expect(await f.host.removeProject({ id: p.id, path: p.path })).toEqual([]);
  }),
);

it(
  "serializes unregistering behind pending terminal admission",
  scope.run(async () => {
    const f = await fixture();
    const p = await f.host.addProject(f.folder);
    let resolve!: (value: any) => void;
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    vi.spyOn(f.host, "prepareTerminalLaunch").mockImplementationOnce(() => {
      started();
      return new Promise((r) => {
        resolve = r;
      });
    });
    const acquire = f.host.acquireTerminalContext(p.id);
    await entered;
    const removal = f.host.removeProject({ id: p.id, path: p.path });
    const rejected = expect(removal).rejects.toThrow(/терминал/i);
    resolve({ dispose: vi.fn() });
    const lease = await acquire;
    try {
      await rejected;
      expect(await f.host.listProjects()).toEqual([p]);
    } finally {
      lease.release();
    }
    expect(await f.host.removeProject({ id: p.id, path: p.path })).toEqual([]);
  }),
);

it(
  "a demonstration is admitted only for the registered owner; pending open excludes removal, not ordinary reads or another project",
  scope.run(async () => {
    const f = await fixture(),
      a = await f.host.addProject(f.folder);
    const bpath = path.join(path.dirname(f.folder), "other");
    await fs.mkdir(bpath);
    const b = await f.host.addProject(bpath);
    let admitted!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (admitted = r));
    const opening = f.host.withDemonstrationOwner(a.id, async (label) => {
      expect(label).toBe(a.name);
      admitted();
      await new Promise<void>((r) => (release = r));
    });
    await started;
    try {
      await expect(
        f.host.removeProject({ id: a.id, path: a.path }),
      ).rejects.toThrow(/демонстрац/);
      await expect(
        f.host.listOverviewDirectory(a.id, ""),
      ).resolves.toBeDefined();
      await f.host.removeProject({ id: b.id, path: b.path });
      const unexpected = vi.fn();
      await expect(
        f.host.withDemonstrationOwner(b.id, unexpected),
      ).rejects.toThrow();
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      release();
      await opening;
    }
    await expect(
      f.host.removeProject({ id: a.id, path: a.path }),
    ).resolves.toEqual([]);
  }),
);
