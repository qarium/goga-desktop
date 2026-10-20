import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { HostService } from "../src/host/service";
import { worktreeContextRef } from "../src/shared/worktrees";
it("rejects effective child roots which differ from management admission without disabling normal HOME inputs", async () => {
  const root = await mkdtemp(
      "/private/tmp/goga-context-ab-research-20261019-impl-effective-env-",
    ),
    home = path.join(root, "home"),
    repo = path.join(root, "primary"),
    outside = path.join(root, "outside");
  for (const d of [home, repo, outside]) await mkdir(d);
  const runner = new NodeRunner(5000, { HOME: home });
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.invalid"],
  ])
    await runner.command("git", args, repo);
  await writeFile(path.join(repo, "plan.md"), "# plan\n");
  await runner.command("git", ["add", "."], repo);
  await runner.command("git", ["commit", "-m", "synthetic fixture"], repo);
  await runner.command("git", ["branch", "feature"], repo);
  const service = new HostService({
    home,
    dataDir: path.join(root, "data"),
    runner,
  });
  const project = await service.addProject(repo),
    clone = await new CloneManager(home, runner).ensure(project, {
      projectId: project.id,
      year: "2026",
      topic: "feature",
      branch: "feature",
    });
  await writeFile(
    path.join(home, ".gitconfig"),
    "[user]\n name = Normal fixture\n",
  );
  // Simulate a final transport/environment mapping different from the management-only admission.
  const original = runner.command.bind(runner);
  runner.command = async (exe, args, cwd, env, stdin) => {
    const result = await original(exe, args, cwd, env, stdin);
    if (
      exe === "git" &&
      args.includes("--git-path") &&
      env?.GIT_CONFIG_GLOBAL !== "/dev/null"
    )
      return {
        ...result,
        stdout: result.stdout.replace(clone.path + "\n", outside + "\n"),
      };
    return result;
  };
  await expect(
    service.readBuildPlan(worktreeContextRef(clone), "plan.md"),
  ).rejects.toThrow(/контекст|Git|папк/);
  await service.dispose();
});
