import { installGitFixtureScope } from "./helpers/git-test-scope";
import { gitIntegrationBudget } from "./helpers/git-integration";
import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
const fixtureScope = installGitFixtureScope();
async function fixture() {
  const base = await fs.mkdtemp("/private/tmp/goga-discard-host-");
  fixtureScope().cleanup(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo"),
    home = path.join(base, "home"),
    trash = path.join(base, "trash");
  for (const dir of [root, home, trash]) await fs.mkdir(dir);
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
  const runner = fixtureScope.runner(new NodeRunner(undefined, env));
  fixtureScope().cleanup(() => runner.dispose());
  const git = async (args: string[], cwd = root) =>
    (
      await runner.command(
        "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        cwd,
        env,
      )
    ).stdout;
  await git(["init", "-b", "main"]);
  await fs.writeFile(path.join(root, "file.txt"), "base\n");
  await fs.writeFile(path.join(root, "other.txt"), "other\n");
  await git(["add", "."]);
  await git(["-c", "commit.gpgSign=false", "commit", "-m", "initial"]);
  await git(["branch", "feature"]);
  const trashed: string[] = [];
  const rawHost = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/disabled-fixture-goga",
    trashItem: async (file) => {
      const dest = path.join(trash, String(trashed.length));
      await fs.rename(file, dest);
      trashed.push(dest);
    },
  });
  fixtureScope().cleanup(() => rawHost.dispose());
  const host = fixtureScope().own(rawHost);
  const project = await host.addProject(root);
  return { base, root, home, host, runner, project, git, trashed };
}
it(
  "discards selected staged and working files in primary and trashes selected additions only",
  fixtureScope.run(async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "file.txt"), "staged\n");
    await fs.writeFile(path.join(f.root, "other.txt"), "keep staged\n");
    await f.git(["add", "."]);
    await fs.writeFile(path.join(f.root, "file.txt"), "working\n");
    await fs.writeFile(path.join(f.root, "new.txt"), "keep in trash\n");
    const before = await f.host.readGitWorkspace(f.project.id),
      head = await f.git(["rev-parse", "HEAD"]);
    const preview = await f.host.prepareGitDiscard({
      scope: f.project.id,
      revision: before.revision,
      paths: ["file.txt", "new.txt"],
    });
    expect(preview.root).toBe(f.root);
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "working\n",
    );
    const result = await f.host.executeGitDiscard(preview.token);
    expect(result.status).toBe("discarded");
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "base\n",
    );
    expect(await f.git(["show", ":file.txt"])).toBe("base\n");
    expect(await f.git(["show", ":other.txt"])).toBe("keep staged\n");
    expect(await fs.readFile(f.trashed[0], "utf8")).toBe("keep in trash\n");
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    await expect(f.host.executeGitDiscard(preview.token)).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "binds discard to exactly the managed clone and rejects changed contents before mutation",
  fixtureScope.run(async () => {
    const f = await fixture();
    const clone = await new CloneManager(f.home, f.runner).ensure(f.project, {
        projectId: f.project.id,
        year: "2026",
        topic: "feature",
        branch: "feature",
      }),
      scope = worktreeContextRef(clone);
    await fs.writeFile(path.join(f.root, "file.txt"), "primary untouched\n");
    await fs.writeFile(path.join(clone.path, "file.txt"), "clone dirty\n");
    let snapshot = await f.host.readGitWorkspace(scope);
    let preview = await f.host.prepareGitDiscard({
      scope,
      revision: snapshot.revision,
      paths: ["file.txt"],
    });
    await fs.writeFile(path.join(clone.path, "file.txt"), "new edits\n");
    await expect(f.host.executeGitDiscard(preview.token)).rejects.toThrow();
    expect(await fs.readFile(path.join(clone.path, "file.txt"), "utf8")).toBe(
      "new edits\n",
    );
    snapshot = await f.host.readGitWorkspace(scope);
    preview = await f.host.prepareGitDiscard({
      scope,
      revision: snapshot.revision,
      paths: ["file.txt"],
    });
    expect((await f.host.executeGitDiscard(preview.token)).status).toBe(
      "discarded",
    );
    expect(await fs.readFile(path.join(clone.path, "file.txt"), "utf8")).toBe(
      "base\n",
    );
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "primary untouched\n",
    );
    await expect(
      f.host.prepareGitDiscard({
        scope: { ...scope, branch: "main" },
        revision: snapshot.revision,
        paths: ["file.txt"],
      }),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "does not fall back to primary after clone disappears between preview and execution",
  fixtureScope.run(async () => {
    const f = await fixture();
    const clone = await new CloneManager(f.home, f.runner).ensure(f.project, {
        projectId: f.project.id,
        year: "2026",
        topic: "feature",
        branch: "feature",
      }),
      scope = worktreeContextRef(clone);
    await fs.writeFile(path.join(clone.path, "file.txt"), "clone dirty\n");
    await fs.writeFile(path.join(f.root, "file.txt"), "primary dirty\n");
    const snapshot = await f.host.readGitWorkspace(scope),
      p = await f.host.prepareGitDiscard({
        scope,
        revision: snapshot.revision,
        paths: ["file.txt"],
      });
    await fs.rm(clone.path, { recursive: true, force: true });
    await expect(f.host.executeGitDiscard(p.token)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "primary dirty\n",
    );
  }),
  gitIntegrationBudget(15000),
);
