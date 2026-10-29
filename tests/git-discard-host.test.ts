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
async function fixture(globalConfig?: string) {
  const base = await fs.mkdtemp("/private/tmp/goga-discard-host-");
  fixtureScope().cleanup(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo"),
    home = path.join(base, "home"),
    trash = path.join(base, "trash");
  for (const dir of [root, home, trash]) await fs.mkdir(dir);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: globalConfig
      ? path.join(home, ".gitconfig")
      : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  if (globalConfig)
    await fs.writeFile(path.join(home, ".gitconfig"), globalConfig);
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

async function failDiscardBeforeFiles(f: Awaited<ReturnType<typeof fixture>>) {
  await fs.writeFile(path.join(f.root, "file.txt"), "yesterday draft\n");
  const before = await f.host.readGitWorkspace(f.project.id);
  const preview = await f.host.prepareGitDiscard({
    scope: f.project.id,
    revision: before.revision,
    paths: ["file.txt"],
  });
  const command = f.runner.commandBytes.bind(f.runner);
  const spy = vi.spyOn(f.runner, "commandBytes").mockImplementation((request) =>
    command(
      request.verifyPrepared
        ? {
            ...request,
            verifyPrepared: async () => {
              throw Error("fixture pre-write failure");
            },
          }
        : request,
    ),
  );
  try {
    expect((await f.host.executeGitDiscard(preview.token)).status).toBe(
      "uncertain",
    );
  } finally {
    spy.mockRestore();
  }
}
it(
  "automatically assesses yesterday's unchanged settled discard and retires it without archival retention only after fresh discard confirmation",
  fixtureScope.run(async () => {
    const f = await fixture();
    await failDiscardBeforeFiles(f);
    const journalDir = path.join(f.home, ".goga/desktop/git-operations");
    const names = await fs.readdir(journalDir);
    const file = names.find((n) => n.endsWith(".json"))!;
    const raw = await fs.readFile(path.join(journalDir, file), "utf8");
    const inspect = (f.host as any).inspectGitDiscardRecovery;
    expect(inspect).toBeTypeOf("function");
    const recovery = await inspect.call(f.host, f.project.id);
    expect(recovery).toMatchObject({
      scope: f.project.id,
      state: "unchanged",
      paths: [{ path: "file.txt", state: "unchanged" }],
    });
    expect(await fs.readFile(path.join(journalDir, file), "utf8")).toBe(raw);
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "yesterday draft\n",
    );
    const fresh = await f.host.prepareGitDiscard({
      scope: f.project.id,
      revision: (await f.host.readGitWorkspace(f.project.id)).revision,
      paths: ["file.txt"],
    });
    expect((fresh as any).recoveryMessage).toMatch(/предыдущ|прошл/i);
    expect(await fs.readFile(path.join(journalDir, file), "utf8")).toBe(raw);
    expect((await f.host.executeGitDiscard(fresh.token)).status).toBe(
      "discarded",
    );
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "base\n",
    );
    expect((await inspect.call(f.host, f.project.id)).state).toBe("clear");
  }),
  gitIntegrationBudget(20000),
);
it(
  "requires separate current-state consent after a changed selected file and never restores files when acknowledging recovery",
  fixtureScope.run(async () => {
    const f = await fixture();
    await failDiscardBeforeFiles(f);
    await fs.writeFile(path.join(f.root, "file.txt"), "today draft\n");
    const inspect = (f.host as any).inspectGitDiscardRecovery;
    expect(inspect).toBeTypeOf("function");
    expect((await inspect.call(f.host, f.project.id)).state).toBe("partial");
    const snapshot = await f.host.readGitWorkspace(f.project.id);
    await expect(
      f.host.prepareGitDiscard({
        scope: f.project.id,
        revision: snapshot.revision,
        paths: ["file.txt"],
      }),
    ).rejects.toThrow(/состояни|провер|восстанов/i);
    const preview = await (f.host as any).prepareGitDiscardRecovery({
      scope: f.project.id,
      revision: snapshot.revision,
    });
    const beforeIndex = await fs.readFile(path.join(f.root, ".git/index"));
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "today draft\n",
    );
    const result = await (f.host as any).executeGitDiscardRecovery(
      preview.token,
    );
    expect(result.status).toBe("recovered");
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "today draft\n",
    );
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(
      beforeIndex,
    );
    expect(result).not.toHaveProperty("archivePath");
    expect(
      await fs.readdir(path.join(f.home, ".goga/desktop/git-operations")),
    ).toEqual([]);
    await expect(
      (f.host as any).executeGitDiscardRecovery(preview.token),
    ).rejects.toThrow();
    expect((await inspect.call(f.host, f.project.id)).state).toBe("clear");
  }),
  gitIntegrationBudget(20000),
);
it(
  "does not acknowledge a changed recovery preview and preserves the prior blocker",
  fixtureScope.run(async () => {
    const f = await fixture();
    await failDiscardBeforeFiles(f);
    const prepare = (f.host as any).prepareGitDiscardRecovery;
    expect(prepare).toBeTypeOf("function");
    const snapshot = await f.host.readGitWorkspace(f.project.id);
    const preview = await prepare.call(f.host, {
      scope: f.project.id,
      revision: snapshot.revision,
    });
    await fs.writeFile(path.join(f.root, "file.txt"), "late edit\n");
    await expect(
      (f.host as any).executeGitDiscardRecovery(preview.token),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "late edit\n",
    );
    expect(
      (await (f.host as any).inspectGitDiscardRecovery(f.project.id)).state,
    ).not.toBe("clear");
  }),
  gitIntegrationBudget(15000),
);

it(
  "recovers a legacy unchanged discard after a new Host starts without guessing its selection",
  fixtureScope.run(async () => {
    const f = await fixture();
    await failDiscardBeforeFiles(f);
    const folder = path.join(f.home, ".goga/desktop/git-operations");
    const name = (await fs.readdir(folder)).find((n) =>
      /^[a-f0-9]{64}\.json$/.test(n),
    )!;
    const file = path.join(folder, name),
      record = JSON.parse(await fs.readFile(file, "utf8"));
    delete record.intentDetails;
    await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
    const restarted = fixtureScope().own(
      new HostService({
        home: f.home,
        dataDir: path.join(f.base, "data"),
        runner: f.runner,
        goga: "/disabled-fixture-goga",
      }),
    );
    fixtureScope().cleanup(() => restarted.dispose());
    expect(
      (await restarted.inspectGitDiscardRecovery(f.project.id)).state,
    ).toBe("unchanged");
    const snapshot = await restarted.readGitWorkspace(f.project.id);
    const preview = await restarted.prepareGitDiscard({
      scope: f.project.id,
      revision: snapshot.revision,
      paths: ["file.txt"],
    });
    expect((await restarted.executeGitDiscard(preview.token)).status).toBe(
      "discarded",
    );
  }),
  gitIntegrationBudget(20000),
);
it(
  "preserve-current recovery keeps later unrelated edits and a later HEAD without an archive",
  fixtureScope.run(async () => {
    const f = await fixture();
    await failDiscardBeforeFiles(f);
    await fs.writeFile(path.join(f.root, "other.txt"), "later committed\n");
    await f.git(["add", "other.txt"]);
    await f.git(["commit", "-m", "later independent commit"]);
    await fs.writeFile(path.join(f.root, "new.txt"), "later unrelated draft\n");
    const head = await f.git(["rev-parse", "HEAD"]),
      index = await fs.readFile(path.join(f.root, ".git/index"));
    const snapshot = await f.host.readGitWorkspace(f.project.id);
    const preview = await f.host.prepareGitDiscardRecovery({
      scope: f.project.id,
      revision: snapshot.revision,
    });
    const result = await f.host.executeGitDiscardRecovery(preview.token);
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "yesterday draft\n",
    );
    expect(await fs.readFile(path.join(f.root, "new.txt"), "utf8")).toBe(
      "later unrelated draft\n",
    );
    expect(result).not.toHaveProperty("archivePath");
    expect(
      await fs.readdir(path.join(f.home, ".goga/desktop/git-operations")),
    ).toEqual([]);
  }),
  gitIntegrationBudget(20000),
);
it(
  "classifies files already restored to the old HEAD instead of inviting another automatic discard",
  fixtureScope.run(async () => {
    const f = await fixture();
    await failDiscardBeforeFiles(f);
    await fs.writeFile(path.join(f.root, "file.txt"), "base\n");
    const recovery = await f.host.inspectGitDiscardRecovery(f.project.id);
    expect(recovery).toMatchObject({
      state: "partial",
      paths: [{ path: "file.txt", state: "restored" }],
    });
    expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
      "base\n",
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "refuses a recovery acknowledgement while shutdown has frozen new writes",
  fixtureScope.run(async () => {
    const f = await fixture();
    await failDiscardBeforeFiles(f);
    await fs.writeFile(path.join(f.root, "file.txt"), "today draft\n");
    const preview = await f.host.prepareGitDiscardRecovery({
      scope: f.project.id,
      revision: (await f.host.readGitWorkspace(f.project.id)).revision,
    });
    const shutdown = await f.host.prepareShutdown();
    try {
      await expect(
        f.host.executeGitDiscardRecovery(preview.token),
      ).rejects.toThrow(/выход/);
      expect(await fs.readFile(path.join(f.root, "file.txt"), "utf8")).toBe(
        "today draft\n",
      );
    } finally {
      await shutdown.release();
    }
  }),
  gitIntegrationBudget(20000),
);

it(
  "discards a nested Goga config on a release branch with real global config through Host API",
  fixtureScope.run(async () => {
    const f = await fixture(
      "[diff]\n algorithm = histogram\n[color]\n ui = auto\n",
    );
    await fs.mkdir(path.join(f.root, ".goga"));
    await fs.writeFile(path.join(f.root, ".goga/config.yml"), "base: true\n");
    await f.git(["add", ".goga/config.yml"]);
    await f.git(["commit", "-m", "nested config"]);
    await f.git(["branch", "-m", "release/2.1.0"]);
    await fs.writeFile(path.join(f.root, ".goga/config.yml"), "base: false\n");
    const snapshot = await f.host.readGitWorkspace(f.project.id);
    const preview = await f.host.prepareGitDiscard({
      scope: f.project.id,
      revision: snapshot.revision,
      paths: [".goga/config.yml"],
    });
    const result = await f.host.executeGitDiscard(preview.token);
    expect(result.status).toBe("discarded");
    expect(
      await fs.readFile(path.join(f.root, ".goga/config.yml"), "utf8"),
    ).toBe("base: true\n");
    expect((await f.host.inspectGitDiscardRecovery(f.project.id)).state).toBe(
      "clear",
    );
  }),
  gitIntegrationBudget(20000),
);
