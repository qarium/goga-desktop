import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HostService } from "../src/host/service";
import { CloneStore } from "../src/host/clone-store";
import * as ownedLocks from "../src/host/owned-lock";
import { NodeRunner, type Runner } from "../src/host/process";
import { readCommittedTask } from "../src/host/topic-task";
import { worktreeContextRef } from "../src/shared/worktrees";

import { FixtureScope, gitIntegrationBudget } from "./helpers/git-integration";
vi.setConfig({ testTimeout: gitIntegrationBudget(30000) });
let scope: FixtureScope;
beforeEach(() => {
  if (scope && !scope.settled)
    throw Error("Previous fixture work has not settled");
  scope = new FixtureScope();
});
afterEach(async () => {
  try {
    await scope.close(gitIntegrationBudget(10000));
  } finally {
    if (scope.settled) vi.unstubAllEnvs();
    if (scope.settled) vi.restoreAllMocks();
  }
}, gitIntegrationBudget(30000));
const gitEnv = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function fixture() {
  const owner = scope;
  return owner.track(createFixture(owner));
}
async function createFixture(scope: FixtureScope) {
  const root = await mkdtemp(
      "/private/tmp/goga-context-ab-research-20261020-completion-cwd-",
    ),
    primary = path.join(root, "primary"),
    home = path.join(root, "home"),
    node = new NodeRunner(15000, gitEnv);
  scope.cleanup(() => rm(root, { recursive: true, force: true }));
  scope.cleanup(() => node.dispose());
  scope.cancelOnTimeout(() => node.dispose());
  const native = scope.own(node);
  await mkdir(primary);
  await mkdir(home);
  const git = async (cwd: string, ...args: string[]) => {
    if (cwd !== root && !cwd.startsWith(root + path.sep))
      throw Error("Not a fixture path");
    return (await native.command("git", args, cwd)).stdout;
  };
  await git(primary, "init", "-b", "main");
  await git(primary, "config", "user.name", "Synthetic Fixture");
  await git(primary, "config", "user.email", "fixture@example.invalid");
  await mkdir(path.join(primary, ".goga/history/2026/first"), {
    recursive: true,
  });
  await mkdir(path.join(primary, ".goga/history/2026/second"), {
    recursive: true,
  });
  for (const name of ["first", "second"])
    await writeFile(
      path.join(primary, `.goga/history/2026/${name}/todo.md`),
      "Идентичная задача\n",
    );
  await writeFile(
    path.join(primary, ".goga/config.yml"),
    "topics:\n  base_ref: main\n",
  );
  await writeFile(path.join(primary, "plan.md"), "# Synthetic plan\n");
  await git(primary, "add", ".");
  await git(primary, "commit", "-m", "synthetic fixture");
  await git(primary, "branch", "first");
  await git(primary, "branch", "second");
  const calls: { args: string[]; cwd: string }[] = [];
  const runner: Runner = {
    command: async (exe, args, cwd, env, stdin) => {
      if (!cwd.startsWith(root + path.sep)) throw Error("Not a fixture path");
      if (exe === "git") return native.command(exe, args, cwd, env, stdin);
      if (exe !== "fixture-goga") throw Error("Unexpected executable");
      calls.push({ args, cwd });
      const branch = (await git(cwd, "branch", "--show-current")).trim();
      if (args.includes("board")) {
        const rows = (
          cwd === primary ? ["main", "first", "second"] : [branch]
        ).map((name) => ({
          topic: name,
          branch: name,
          current: name === branch,
          remote: false,
          statuses: [`${branch}-status`],
          todo: `${branch}-task`,
          divergence: null,
        }));
        return {
          stdout: JSON.stringify(
            args.includes("--remote")
              ? []
              : rows.map((row) =>
                  args.includes("--per-host")
                    ? row
                    : { ...row, hosts: [row.branch] },
                ),
          ),
          stderr: "",
        };
      }
      if (args.includes("--list"))
        return {
          stdout: `* build\n    name: ${branch} build\n* suggestion-${branch}\n    name: ${branch} suggestion\n`,
          stderr: "",
        };
      if (args.includes("--info"))
        return { stdout: "* work:\n    title: Synthetic work\n", stderr: "" };
      throw Error("Unexpected synthetic command " + args.join(" "));
    },
    start: vi.fn(() => {
      throw Error("No payload is allowed in CWD contract tests");
    }),
    kill: vi.fn(),
  };
  const rawService = new HostService({
    home,
    dataDir: path.join(root, "data"),
    goga: "fixture-goga",
    runner,
  });
  scope.cleanup(() => rawService.dispose());
  const service = scope.own(rawService);
  const project = await service.addProject(primary);
  const a = await service.ensureTopicContext({
    projectId: project.id,
    year: "2026",
    topic: "first",
    branch: "first",
  });
  const b = await service.ensureTopicContext({
    projectId: project.id,
    year: "2026",
    topic: "second",
    branch: "second",
  });
  return {
    root,
    primary,
    home,
    native,
    git,
    runner,
    service,
    project,
    a,
    b,
    calls,
  };
}

it("packages a side-effect-free acceptance entry for the exact production HostService and IPC modules", async () => {
  const entry = await readFile(
    new URL("../src/main/acceptance-host.ts", import.meta.url),
    "utf8",
  ).catch(() => "");
  expect(entry).toContain('export { HostService } from "../host/service"');
  expect(entry).toContain('export { registerIPC } from "./ipc"');
  expect(entry).not.toMatch(/from ["']\.\/index["']/);
  expect(
    await readFile(
      new URL("../scripts/build-main.mjs", import.meta.url),
      "utf8",
    ),
  ).toContain('"src/main/acceptance-host.ts"');
});

it("reads committed task bytes in the owner even when every ambient and explicit Git redirect targets another repository", async () => {
  const f = await fixture(),
    relative = ".goga/history/2026/first/todo.md";
  await writeFile(
    path.join(f.a.path, relative),
    "Только владелец: unique binary UTF-8 🧪\n",
  );
  await f.git(f.a.path, "add", relative);
  await f.git(
    f.a.path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "owner-only task blob",
  );
  const ownerBlob = (
    await f.git(f.a.path, "rev-parse", `HEAD:${relative}`)
  ).trim();
  await writeFile(path.join(f.b.path, relative), "FOREIGN BYTES\n");
  await f.git(f.b.path, "add", relative);
  await f.git(
    f.b.path,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "foreign task",
  );
  const pollution = {
    GIT_DIR: path.join(f.b.path, ".git"),
    GIT_WORK_TREE: f.b.path,
    GIT_COMMON_DIR: path.join(f.b.path, ".git"),
    GIT_INDEX_FILE: path.join(f.b.path, ".git/index"),
    GIT_OBJECT_DIRECTORY: path.join(f.b.path, ".git/objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(f.b.path, ".git/objects"),
  };
  // Negative control: the foreign store genuinely cannot serve the owner blob.
  await expect(
    promisify(execFile)("/usr/bin/git", ["cat-file", "blob", ownerBlob], {
      cwd: f.a.path,
      env: { ...gitEnv, HOME: f.home, PATH: "/usr/bin:/bin", ...pollution },
    }),
  ).rejects.toThrow();
  for (const [key, value] of Object.entries(pollution)) vi.stubEnv(key, value);
  const commit = (await f.git(f.a.path, "rev-parse", "HEAD")).trim();
  expect(
    await readCommittedTask(
      f.a.path,
      commit,
      relative,
      (args) => f.git(f.a.path, ...args),
      pollution,
    ),
  ).toEqual({
    text: "Только владелец: unique binary UTF-8 🧪\n",
    exists: true,
  });
  expect(process.env.GIT_DIR).toBe(pollution.GIT_DIR);
});

it("rejects clone A's preview token for clone B despite identical task bytes, stages and options", async () => {
  const f = await fixture(),
    a = worktreeContextRef(f.a),
    b = worktreeContextRef(f.b);
  const request = {
    projectId: f.project.id,
    pipeline: "build",
    workflow: "none",
    profile: "",
    skips: [],
  };
  const preview = await f.service.preview({ ...request, context: a });
  const task = await f.service.readTopicTask({
    projectId: f.project.id,
    context: b,
    branch: "second",
    topic: "second",
  });
  expect(task.text).toBe("Идентичная задача\n");
  await expect(
    f.service.launch({
      ...request,
      context: b,
      expectedBranch: "second",
      clean: false,
      confirmBranchSwitch: false,
      previewToken: preview.token,
      task: task.text,
      taskVersion: task.version,
      confirmEmptyTask: false,
      topic: { mode: "existing", branch: "second", topic: "second" },
    }),
  ).rejects.toThrow(/Предпросмотр устарел/);
  expect(f.runner.start).not.toHaveBeenCalled();
});

it("keeps discovery, workflow suggestions and document reads distinct for primary, A and B", async () => {
  const f = await fixture();
  const scopes = [
    f.project.id,
    worktreeContextRef(f.a),
    worktreeContextRef(f.b),
  ];
  const roots = [f.primary, f.a.path, f.b.path],
    names = ["main", "first", "second"];
  for (const [index, root] of roots.entries()) {
    await mkdir(path.join(root, ".goga/workflows"), { recursive: true });
    await writeFile(
      path.join(root, `.goga/workflows/local-${names[index]}.yml`),
      `name: ${names[index]}\n`,
    );
  }
  for (const [index, scope] of scopes.entries()) {
    const discovery = await f.service.discover(scope);
    expect(discovery.currentBranch).toBe(names[index]);
    expect(discovery.pipelines.map((x) => x.name)).toEqual([
      `${names[index]} build`,
      `${names[index]} suggestion`,
    ]);
    expect(discovery.workflows).toEqual([`local-${names[index]}`]);
    expect(
      (await f.service.listWorkflowSuggestions(scope)).map((x) => x.id),
    ).toEqual(["build", `suggestion-${names[index]}`]);
    expect(
      (
        await f.service.readProjectDocument(scope, {
          kind: "workflow",
          name: `local-${names[index]}`,
        })
      ).text,
    ).toBe(`name: ${names[index]}\n`);
  }
  for (const call of f.calls) expect(roots).toContain(call.cwd);
});

it("aggregates the global topic board from each real owner instead of substituting primary rows", async () => {
  const f = await fixture();
  const board = await f.service.readTopicBoard(f.project.id, "2026");
  for (const branch of ["main", "first", "second"]) {
    expect(board.entries.find((row) => row.branch === branch)).toMatchObject({
      topic: branch,
      statuses: [`${branch}-status`],
      todo: `${branch}-task`,
      hosts: [branch],
    });
    expect(board.records.find((row) => row.branch === branch)?.todo).toBe(
      `${branch}-task`,
    );
  }
  for (const root of [f.primary, f.a.path, f.b.path])
    expect(
      f.calls.some((call) => call.cwd === root && call.args.includes("board")),
    ).toBe(true);
});

it("serializes registry reads across store instances before a sibling can inspect a partially published lock", async () => {
  const owner = scope;
  const root = await mkdtemp(
      "/private/tmp/goga-context-ab-research-20261020-completion-registry-",
    ),
    home = path.join(root, "home");
  owner.cleanup(() => rm(root, { recursive: true, force: true }));
  await mkdir(home);
  const firstStore = new CloneStore(home),
    secondStore = new CloneStore(home);
  await firstStore.read();
  await secondStore.assertRoot();
  const lockPath = path.join(firstStore.root, ".registry.lock"),
    trace: unknown[] = [];
  let publish!: () => void, created!: () => void, secondEntered!: () => void;
  const publishing = new Promise<void>((resolve) => (publish = resolve)),
    transientCreated = new Promise<void>((resolve) => (created = resolve)),
    secondAtRoot = new Promise<void>((resolve) => (secondEntered = resolve));
  const acquire = ownedLocks.acquireOwnedLock;
  let attempts = 0,
    secondSettled = false;
  vi.spyOn(ownedLocks, "acquireOwnedLock").mockImplementation(
    async (file, options) => {
      if (file !== lockPath) return acquire(file, options);
      trace.push({ event: "disk-acquire", file, attempt: ++attempts });
      if (attempts === 1) {
        // Exact physical transient: O_EXCL has reserved the lock, owner JSON is
        // not published yet. The independent disk-lock policy must still reject it.
        const handle = await open(file, "wx", 0o600);
        created();
        await publishing;
        await handle.close();
        await unlink(file);
      }
      return acquire(file, options);
    },
  );
  const assertSecondRoot = secondStore.assertRoot.bind(secondStore);
  vi.spyOn(secondStore, "assertRoot").mockImplementation(async () => {
    await assertSecondRoot();
    secondEntered();
  });
  owner.releaseOnCleanup(() => publish());
  const first = owner.track(firstStore.read());
  await transientCreated;
  const second = owner.track(
    secondStore.read().then(
      (value) => {
        secondSettled = true;
        return value;
      },
      (error) => {
        secondSettled = true;
        trace.push({ event: "second-error", message: String(error) });
        throw error;
      },
    ),
  );
  // Attach the observer immediately; the red run legitimately fails closed.
  void second.catch(() => {});
  try {
    await secondAtRoot;
    await new Promise<void>((resolve) => setImmediate(resolve));
    trace.push({
      event: "while-first-publication-paused",
      attempts,
      secondSettled,
    });
    expect(attempts, lockPath).toBe(1);
    expect(secondSettled).toBe(false);
  } finally {
    publish();
    await Promise.allSettled([first, second]);
    await writeFile(
      path.join(root, "registry-lock-timeline.json"),
      JSON.stringify({ lockPath, trace }, null, 2),
    );
  }
  expect(await second).toEqual(await first);
  expect(attempts).toBe(2);
});
