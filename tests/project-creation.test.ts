import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { ProjectCreationCoordinator } from "../src/host/project-creation";
import {
  ByteCommandError,
  NodeRunner,
  type ByteCommand,
  type Runner,
} from "../src/host/process";
import { readSignal } from "../src/host/read-scope";
import type {
  ProjectCreationRequest,
  ProjectCreationProgress,
} from "../src/shared/project-creation";
const cleanup: Array<() => Promise<unknown>> = [];
const control = vi.hoisted(() => ({ failCleanup: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (file: any, options: any) => {
      if (control.failCleanup && String(file).includes("/.goga-create-")) {
        control.failCleanup = false;
        throw Object.assign(Error("denied"), { code: "EACCES" });
      }
      return actual.rm(file, options);
    },
  };
});
afterEach(async () => {
  control.failCleanup = false;
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
it("returns the registered project even when staging cleanup needs user attention", async () => {
  const f = await fixture();
  control.failCleanup = true;
  const result = await f.coordinator.create(f.request);
  expect(result).toMatchObject({
    status: "success",
    project: { path: path.join(f.parent, "new") },
    warning: expect.stringContaining(".goga-create-"),
  });
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(await fs.readdir(path.join(f.parent, "new"))).toEqual([]);
});
const ok = {
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
  exitCode: 0,
  signal: null,
  processSettled: true as const,
};
async function fixture(command?: (c: ByteCommand) => Promise<typeof ok>) {
  const parent = await fs.mkdtemp("/private/tmp/goga-create-test-");
  cleanup.push(() => fs.rm(parent, { recursive: true, force: true }));
  const progress: ProjectCreationProgress[] = [];
  const register = vi.fn(async (folder: string) => ({
    id: "created",
    path: folder,
    name: path.basename(folder),
  }));
  const commandBytes = vi.fn(
    command ??
      (async (c: ByteCommand) => {
        const root = c.args.includes("clone")
          ? c.args[c.args.length - 1]
          : c.cwd;
        await fs.mkdir(path.join(root, ".git"), { recursive: true });
        return ok;
      }),
  );
  const runner = {
    commandBytes,
    dispose: vi.fn(async () => {}),
  } as unknown as Runner;
  const coordinator = new ProjectCreationCoordinator({
    runner,
    home: parent,
    register,
    progress: (p) => progress.push(p),
  });
  cleanup.push(() => coordinator.dispose());
  const request: ProjectCreationRequest = {
    id: "one",
    mode: "empty",
    parent,
    name: "new",
    git: false,
  };
  return {
    parent,
    progress,
    register,
    commandBytes,
    runner,
    coordinator,
    request,
  };
}
it("creates only a new empty folder and registers its exact path, without Git", async () => {
  const f = await fixture();
  expect(await f.coordinator.create(f.request)).toEqual({
    status: "success",
    project: { id: "created", path: path.join(f.parent, "new"), name: "new" },
  });
  expect(await fs.readdir(path.join(f.parent, "new"))).toEqual([]);
  expect(f.commandBytes).not.toHaveBeenCalled();
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(f.progress.map((p) => p.stage)).toEqual([
    "checking",
    "creating",
    "registering",
  ]);
  expect(await fs.readdir(f.parent)).toEqual(["new"]);
});
it.each(["directory", "file", "symlink"] as const)(
  "never touches an existing %s destination",
  async (kind) => {
    const f = await fixture();
    const dest = path.join(f.parent, "new");
    if (kind === "directory") {
      await fs.mkdir(dest);
      await fs.writeFile(path.join(dest, "keep"), "keep");
    } else if (kind === "file") await fs.writeFile(dest, "keep");
    else await fs.symlink("/nonexistent/test", dest);
    const result = await f.coordinator.create({ ...f.request, git: true });
    expect(result.status).toBe("error");
    expect(result).toMatchObject({ field: "name" });
    expect(f.register).not.toHaveBeenCalled();
    expect(f.commandBytes).not.toHaveBeenCalled();
    expect((await fs.lstat(dest)).isSymbolicLink()).toBe(kind === "symlink");
  },
);
it("clones with fixed arguments into a private staging directory, then publishes", async () => {
  const f = await fixture();
  const request: ProjectCreationRequest = {
    id: "clone",
    mode: "clone",
    name: "new",
    parent: f.parent,
    repository: "git@example.com:team/repo.git",
  };
  expect((await f.coordinator.create(request)).status).toBe("success");
  const command = f.commandBytes.mock.calls[0][0];
  expect(command.executable).toBe("git");
  expect(command.args).toContain("--no-recurse-submodules");
  expect(command.args).toContain("--template=");
  expect(command.args).toContain("core.hooksPath=/dev/null");
  expect(command.env?.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
  expect(command.env?.GIT_TERMINAL_PROMPT).toBe("0");
  expect(command.env?.GIT_TRACE2_EVENT).toBe("0");
  expect(command.args.slice(-2)).toEqual([
    request.repository,
    expect.stringMatching(/\.goga-create-.*\/project$/),
  ]);
  expect(await fs.readdir(path.join(f.parent, "new"))).toEqual([".git"]);
  expect(await fs.readdir(f.parent)).toEqual(["new"]);
});
it("deduplicates the same attempt but rejects a concurrent different request", async () => {
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const f = await fixture(async (c) => {
    await wait;
    await fs.mkdir(path.join(c.cwd, ".git"));
    return ok;
  });
  const request = { ...f.request, git: true };
  const first = f.coordinator.create(request);
  const repeated = f.coordinator.create(request);
  expect((await f.coordinator.create({ ...request, id: "other" })).status).toBe(
    "error",
  );
  release();
  expect(await first).toEqual(await repeated);
  expect(f.commandBytes).toHaveBeenCalledTimes(1);
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(await f.coordinator.create(request)).toEqual(await first);
});
it("cancels the matching attempt, waits for settlement, cleans only its staging and permits retry", async () => {
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const f = await fixture(async () => {
    const signal = readSignal()!;
    started();
    await new Promise((r) =>
      signal.addEventListener("abort", r, { once: true }),
    );
    throw new ByteCommandError(
      "aborted",
      true,
      Buffer.alloc(0),
      Buffer.alloc(0),
    );
  });
  const pending = f.coordinator.create({ ...f.request, git: true });
  await ready;
  expect(f.coordinator.cancel("wrong")).toBe(false);
  expect(f.coordinator.cancel("one")).toBe(true);
  expect(await pending).toEqual({ status: "cancelled" });
  expect(f.register).not.toHaveBeenCalled();
  expect(await fs.readdir(f.parent)).toEqual([]);
  expect(
    (await f.coordinator.create({ ...f.request, id: "retry" })).status,
  ).toBe("success");
});
it("preserves uncertain process output and blocks retries rather than deleting live files", async () => {
  const f = await fixture(async () => {
    throw new ByteCommandError(
      "process-unsettled",
      false,
      Buffer.alloc(0),
      Buffer.alloc(0),
    );
  });
  const result = await f.coordinator.create({ ...f.request, git: true });
  expect(result.status).toBe("error");
  if (result.status !== "error") throw Error("expected error");
  expect(result.retainedPath).toContain(".goga-create-");
  expect(await fs.stat(result.retainedPath!)).toBeTruthy();
  expect(
    (await f.coordinator.create({ ...f.request, id: "retry" })).status,
  ).toBe("error");
  expect(f.register).not.toHaveBeenCalled();
});
it("leaves a completed folder if registration fails and never claims success", async () => {
  const f = await fixture();
  f.register.mockRejectedValueOnce(Error("private internal failure"));
  const result = await f.coordinator.create(f.request);
  expect(result).toMatchObject({
    status: "error",
    retainedPath: path.join(f.parent, "new"),
  });
  expect(JSON.stringify(result)).not.toContain("private internal");
  expect(await fs.readdir(path.join(f.parent, "new"))).toEqual([]);
});
it("does not cancel once registration has begun", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  f.register.mockImplementationOnce(async (folder) => {
    entered();
    await new Promise<void>((r) => (release = r));
    return { id: "created", path: folder, name: "new" };
  });
  const pending = f.coordinator.create(f.request);
  await ready;
  expect(f.coordinator.cancel("one")).toBe(false);
  release();
  expect((await pending).status).toBe("success");
});
it("refuses a destination that appears during preparation without replacing it", async () => {
  let parent = "";
  const f = await fixture(async (c) => {
    await fs.mkdir(path.join(c.cwd, ".git"));
    await fs.mkdir(path.join(parent, "new"));
    await fs.writeFile(path.join(parent, "new", "keep"), "keep");
    return ok;
  });
  parent = f.parent;
  expect((await f.coordinator.create({ ...f.request, git: true })).status).toBe(
    "error",
  );
  expect(await fs.readFile(path.join(parent, "new", "keep"), "utf8")).toBe(
    "keep",
  );
  expect(f.register).not.toHaveBeenCalled();
});
it("counts only actual creation during exit and cancels it for either exit mode", async () => {
  for (const mode of ["keep", "stop"] as const) {
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const f = await fixture(async () => {
      const signal = readSignal()!;
      started();
      await new Promise((r) =>
        signal.addEventListener("abort", r, { once: true }),
      );
      throw new ByteCommandError(
        "aborted",
        true,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    });
    const idle = await f.coordinator.prepareShutdown();
    expect(idle.requiresConfirmation).toBe(false);
    expect(idle.items).toEqual([]);
    await idle.release();
    const pending = f.coordinator.create({ ...f.request, git: true });
    await ready;
    const exit = await f.coordinator.prepareShutdown();
    expect(exit.requiresConfirmation).toBe(true);
    expect(exit.items).toHaveLength(1);
    expect(
      (await f.coordinator.create({ ...f.request, id: "new" })).status,
    ).toBe("error");
    await exit[mode]!();
    expect((await pending).status).toBe("cancelled");
    expect(await exit.remaining()).toEqual([]);
    await exit.release();
  }
});
it("initializes a real isolated Git repository without a commit or template files", async () => {
  const f = await fixture();
  const runner = new NodeRunner(15000, {
    HOME: f.parent,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  });
  cleanup.push(() => runner.dispose());
  const coordinator = new ProjectCreationCoordinator({
    runner,
    home: f.parent,
    register: f.register,
    progress: () => {},
  });
  cleanup.push(() => coordinator.dispose());
  expect((await coordinator.create({ ...f.request, git: true })).status).toBe(
    "success",
  );
  const dest = path.join(f.parent, "new");
  expect(await fs.readdir(dest)).toEqual([".git"]);
  expect(await fs.readFile(path.join(dest, ".git", "HEAD"), "utf8")).toBe(
    "ref: refs/heads/main\n",
  );
  expect(await fs.readdir(path.join(dest, ".git", "refs", "heads"))).toEqual(
    [],
  );
});
it("clones a real synthetic repository through a local SSH stand-in with its default branch and files", async () => {
  const f = await fixture();
  const env: NodeJS.ProcessEnv = {
    HOME: f.parent,
    XDG_CONFIG_HOME: f.parent,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
    GIT_TRACE2_PERF: "0",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const source = path.join(f.parent, "source"),
    ssh = path.join(f.parent, "ssh.cjs");
  await fs.mkdir(source);
  const runner = new NodeRunner(15000, env);
  cleanup.push(() => runner.dispose());
  const git = async (args: string[]) => {
    const result = await runner.commandBytes({
      executable: "git",
      cwd: source,
      args: [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };
  await git(["init", "--template=", "-b", "custom-default"]);
  await fs.writeFile(path.join(source, "hello.txt"), "synthetic content\n");
  await git(["add", "--", "hello.txt"]);
  await git([
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=synthetic@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  // No SSH binary or network is used: Git's configured transport program serves
  // only this fixture with upload-pack, regardless of the supplied fake host.
  await fs.writeFile(
    ssh,
    `const {spawn}=require('node:child_process');const c=spawn('git',['upload-pack',${JSON.stringify(source)}],{stdio:'inherit'});c.on('exit',code=>process.exit(code??1));`,
  );
  const transport = new NodeRunner(15000, {
    ...env,
    GIT_SSH_VARIANT: "ssh",
    GIT_SSH_COMMAND: `${JSON.stringify(process.execPath)} ${JSON.stringify(ssh)}`,
  });
  cleanup.push(() => transport.dispose());
  const coordinator = new ProjectCreationCoordinator({
    runner: transport,
    home: f.parent,
    register: f.register,
    progress: () => {},
  });
  cleanup.push(() => coordinator.dispose());
  const result = await coordinator.create({
    id: "actual-clone",
    mode: "clone",
    parent: f.parent,
    name: "copy",
    repository: "git@synthetic.invalid:repository.git",
  });
  expect(result).toMatchObject({
    status: "success",
    project: { path: path.join(f.parent, "copy") },
  });
  expect(
    await fs.readFile(path.join(f.parent, "copy", "hello.txt"), "utf8"),
  ).toBe("synthetic content\n");
  expect(
    await fs.readFile(path.join(f.parent, "copy", ".git", "HEAD"), "utf8"),
  ).toBe("ref: refs/heads/custom-default\n");
});
it("cancels a real synthetic child before removing its staging files", async () => {
  const f = await fixture(),
    runner = new NodeRunner(15000, { HOME: f.parent });
  cleanup.push(() => runner.dispose());
  const marker = path.join(f.parent, "child-started");
  const adapter = {
    commandBytes: (command: ByteCommand) =>
      runner.commandBytes({
        ...command,
        executable: process.execPath,
        args: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
        ],
      }),
    dispose: () => runner.dispose(),
  } as Runner;
  const coordinator = new ProjectCreationCoordinator({
    runner: adapter,
    home: f.parent,
    register: f.register,
    progress: () => {},
  });
  cleanup.push(() => coordinator.dispose());
  const pending = coordinator.create({ ...f.request, git: true });
  await vi.waitFor(async () =>
    expect(await fs.readFile(marker, "utf8")).toMatch(/^\d+$/),
  );
  const pid = Number(await fs.readFile(marker, "utf8"));
  const cancelled = coordinator.cancelAndWait("one");
  expect(await cancelled).toEqual({ status: "cancelled" });
  expect(await pending).toEqual({ status: "cancelled" });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(f.register).not.toHaveBeenCalled();
  expect(
    (await fs.readdir(f.parent)).filter((name) =>
      name.startsWith(".goga-create-"),
    ),
  ).toEqual([]);
  expect(await coordinator.cancelAndWait("unknown")).toEqual({
    status: "cancelled",
  });
});
