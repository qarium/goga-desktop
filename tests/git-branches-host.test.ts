import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
  stat,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { childEnvironment } from "../src/host/process-environment";
import { isOfflineGitRead } from "../src/host/read-scope";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
async function fixture() {
  const base = await mkdtemp("/private/tmp/goga-git-workspace-host-");
  cleanup.push(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    root = path.join(base, "repo");
  await mkdir(home);
  await mkdir(root);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = async (args: string[]) =>
    (
      await runner.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        root,
        env,
      )
    ).stdout;
  await git(["init", "-b", "main"]);
  await writeFile(path.join(root, "file.txt"), "base\n");
  await git(["add", "."]);
  await git(["-c", "commit.gpgSign=false", "commit", "-m", "fixture"]);
  await git(["branch", "feature"]);
  const host = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent-fixture-goga",
  });
  cleanup.push(() => host.dispose());
  const project = await host.addProject(root);
  return { base, home, root, runner, host, project, git };
}
it("inventories branches offline and switches only through a fresh primary ticket", async () => {
  const f = await fixture();
  const spy = vi.spyOn(f.runner, "command");
  const inventory = await (f.host as any).readGitBranches(f.project.id);
  expect(inventory.local.map((b: any) => b.name).sort()).toEqual([
    "feature",
    "main",
  ]);
  expect(spy.mock.calls.every((c) => c[0] === "git")).toBe(true);
  const preview = await (f.host as any).prepareGitBranch({
    projectId: f.project.id,
    revision: inventory.revision,
    action: "switch-local",
    ref: "refs/heads/feature",
  });
  const result = await (f.host as any).executeGitBranch(preview.token);
  expect(result.status).toBe("success");
  expect((await f.git(["branch", "--show-current"])).trim()).toBe("feature");
  await expect(
    (f.host as any).executeGitBranch(preview.token),
  ).rejects.toThrow();
  for (const scope of [
    { projectId: f.project.id },
    { kind: "primary", projectId: f.project.id },
  ])
    await expect((f.host as any).readGitBranches(scope)).rejects.toThrow();
});
it("explicit fetch uses online transport only for fetch and leaves worktree unchanged", async () => {
  const f = await fixture();
  const remote = path.join(f.base, "remote.git");
  await f.runner.command(
    "git",
    ["clone", "--no-hardlinks", "--bare", f.root, remote],
    f.base,
  );
  await f.git(["remote", "add", "origin", remote]);
  const calls: { args: readonly string[]; offline: boolean }[] = [];
  const original = f.runner.command.bind(f.runner);
  vi.spyOn(f.runner, "command").mockImplementation(
    (file, args, cwd, env, stdin) => {
      if (file === "git") calls.push({ args, offline: isOfflineGitRead() });
      return original(file, args, cwd, env, stdin);
    },
  );
  const bytes = f.runner.commandBytes.bind(f.runner);
  vi.spyOn(f.runner, "commandBytes").mockImplementation((command) => {
    const env = childEnvironment({}, {}, command.env);
    expect(path.isAbsolute(command.executable)).toBe(true);
    expect(command.cwd).toBe(f.root);
    calls.push({ args: command.args, offline: env.GIT_ALLOW_PROTOCOL === "" });
    if (command.args.includes("fetch"))
      expect(env.GIT_ALLOW_PROTOCOL).toBe("https:ssh:file");
    else expect(env.GIT_ALLOW_PROTOCOL).toBe("");
    return bytes(command);
  });
  const inventory = await (f.host as any).readGitBranches(f.project.id);
  expect(calls.every((c) => c.offline)).toBe(true);
  const preview = await (f.host as any).prepareGitBranch({
    projectId: f.project.id,
    revision: inventory.revision,
    action: "fetch",
  });
  const result = await (f.host as any).executeGitBranch(preview.token);
  expect(result.status).toBe("success");
  expect(
    calls.filter((c) => !c.offline).every((c) => c.args.includes("fetch")),
  ).toBe(true);
  expect(calls.some((c) => !c.offline && c.args.includes("fetch"))).toBe(true);
  expect((await f.git(["branch", "--show-current"])).trim()).toBe("main");
  expect(await readFile(path.join(f.root, "file.txt"), "utf8")).toBe("base\n");
});

it("merges only in the primary owner offline while preserving unrelated edits", async () => {
  const f = await fixture();
  await f.git(["switch", "feature"]);
  await writeFile(path.join(f.root, "incoming.txt"), "incoming\n");
  await f.git(["add", "incoming.txt"]);
  await f.git(["-c", "commit.gpgSign=false", "commit", "-m", "source"]);
  const sourceOid = (await f.git(["rev-parse", "HEAD"])).trim();
  await f.git(["switch", "main"]);
  await writeFile(path.join(f.root, "file.txt"), "local edit\n");
  const calls: { file: string; cwd: string; offline: boolean }[] = [];
  const original = f.runner.command.bind(f.runner);
  vi.spyOn(f.runner, "command").mockImplementation(
    (file, args, cwd, env, stdin) => {
      calls.push({ file, cwd, offline: isOfflineGitRead() });
      return original(file, args, cwd, env, stdin);
    },
  );
  const bytes = f.runner.commandBytes.bind(f.runner);
  vi.spyOn(f.runner, "commandBytes").mockImplementation((command) => {
    expect(path.isAbsolute(command.executable)).toBe(true);
    calls.push({
      file: "git",
      cwd: command.cwd,
      offline: childEnvironment({}, {}, command.env).GIT_ALLOW_PROTOCOL === "",
    });
    return bytes(command);
  });
  const inventory = await f.host.readGitBranches(f.project.id);
  const preview = await f.host.prepareGitBranch({
    projectId: f.project.id,
    revision: inventory.revision,
    action: "merge",
    ref: "refs/heads/feature",
  });
  expect(preview.sourceOid).toBe(sourceOid);
  expect(preview.toRef).toBe("refs/heads/main");
  const result = await f.host.executeGitBranch(preview.token);
  expect(result.status).toBe("success");
  expect(
    calls.every((c) => c.file === "git" && c.cwd === f.root && c.offline),
  ).toBe(true);
  expect(await readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
    "local edit\n",
  );
  expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(sourceOid);
  expect((await f.git(["branch", "--show-current"])).trim()).toBe("main");
});

it("keeps native conflicts and permits only a fresh explicit primary abort ticket", async () => {
  const f = await fixture();
  await f.git(["switch", "feature"]);
  await writeFile(path.join(f.root, "file.txt"), "source\n");
  await f.git(["add", "file.txt"]);
  await f.git(["-c", "commit.gpgSign=false", "commit", "-m", "source"]);
  await f.git(["switch", "main"]);
  await writeFile(path.join(f.root, "file.txt"), "target\n");
  await f.git(["add", "file.txt"]);
  await f.git(["-c", "commit.gpgSign=false", "commit", "-m", "target"]);
  const before = (await f.git(["rev-parse", "HEAD"])).trim();
  const inventory = await f.host.readGitBranches(f.project.id);
  const preview = await f.host.prepareGitBranch({
    projectId: f.project.id,
    revision: inventory.revision,
    action: "merge",
    ref: "refs/heads/feature",
  });
  const merged = await f.host.executeGitBranch(preview.token);
  expect(merged.status).toBe("conflict");
  const current = await f.host.readGitBranches(f.project.id);
  expect(current.operation).toBe("merge");
  const abort = await f.host.prepareGitBranch({
    projectId: f.project.id,
    revision: current.revision,
    action: "abort-merge",
  });
  expect(
    await readFile(path.join(f.root, ".git", "MERGE_HEAD"), "utf8"),
  ).toMatch(/^[a-f0-9]+\n$/);
  expect((await f.host.executeGitBranch(abort.token)).status).toBe("success");
  expect((await f.host.readGitBranches(f.project.id)).operation).toBe("none");
  expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(before);
  expect(await readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
    "target\n",
  );
  await expect(f.host.executeGitBranch(abort.token)).rejects.toThrow();
});

it.each(["pull", "switch-remote"] as const)(
  "journals native %s through the primary host owner",
  async (action) => {
    const f = await fixture();
    const remote = path.join(f.base, "native-remote.git");
    await f.runner.command("git", ["init", "--bare", remote], f.base);
    await f.git(["remote", "add", "origin", remote]);
    await f.git(["push", "-u", "origin", "main"]);
    await f.git(["switch", "-c", "incoming"]);
    await writeFile(path.join(f.root, "incoming.txt"), "incoming\n");
    await f.git(["add", "."]);
    await f.git(["-c", "commit.gpgSign=false", "commit", "-m", "incoming"]);
    const target = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git(["push", "origin", "incoming:main", "incoming:new"]);
    await f.git(["switch", "main"]);
    const inventory = await f.host.readGitBranches(f.project.id);
    const preview = await f.host.prepareGitBranch({
      projectId: f.project.id,
      revision: inventory.revision,
      ...(action === "pull"
        ? { action }
        : { action, ref: "refs/remotes/origin/new" }),
    });
    expect(await f.host.executeGitBranch(preview.token)).toMatchObject({
      status: "success",
    });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(target);
    expect((await f.git(["symbolic-ref", "HEAD"])).trim()).toBe(
      action === "pull" ? "refs/heads/main" : "refs/heads/new",
    );
    const directory = path.join(f.home, ".goga/desktop/git-operations");
    const names = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    expect(names).toHaveLength(1);
    expect(
      JSON.parse(await readFile(path.join(directory, names[0]), "utf8")),
    ).toMatchObject({
      state: "completed",
      recovery: null,
      operation: action === "pull" ? "pull" : "switch",
    });
    await expect(f.host.executeGitBranch(preview.token)).rejects.toThrow();
  },
);
