import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
const cli = process.env.GOGA_TOPICS_TEST_CLI;
const clean: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});
it.skipIf(!cli)(
  "installed CLI: four schemas, Unicode stdin creation, local origin publish, switch, full task and exact deletion",
  async () => {
    const dir = await mkdtemp("/private/tmp/goga-topics-real-");
    clean.push(() => rm(dir, { recursive: true, force: true }));
    const repo = path.join(dir, "repo"),
      home = path.join(dir, "home"),
      origin = path.join(dir, "origin.git");
    await mkdir(repo);
    await mkdir(home);
    const runner = new NodeRunner(120000, {
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    clean.push(() => runner.dispose());
    const git = async (...args: string[]) =>
      (await runner.command("git", args, repo)).stdout;
    await git("init", "-b", "main");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await git("commit", "--allow-empty", "-m", "initial");
    await git("init", "--bare", origin);
    await git("remote", "add", "origin", origin);
    await git("push", "-u", "origin", "main");
    const service = new HostService({
      home,
      dataDir: path.join(dir, "data"),
      goga: cli,
      runner,
    });
    clean.push(() => service.dispose());
    const project = await service.addProject(repo);
    const year = "2025",
      task = "Полная многострочная задача 🙂\n\n- строка один\n- строка два\n";
    let board = await service.readTopicBoard(project.id, year);
    expect(board.records).toEqual([]);
    let plan = await service.prepareTopicOperation({
      projectId: project.id,
      year,
      expectedRevision: board.revision,
      action: "create",
      branch: "feature/unicode",
      baseRef: "main",
      task,
      publish: true,
      switch: false,
    });
    expect((await service.executeTopicOperation(plan.token)).status).toBe(
      "success",
    );
    expect((await git("branch", "--show-current")).trim()).toBe("main");
    board = await service.readTopicBoard(project.id, year);
    expect(board.entries).toHaveLength(1);
    expect(
      board.records.filter((r) => r.topic === "feature-unicode"),
    ).toHaveLength(1);
    expect(board.remoteEntries).toHaveLength(1);
    const target = {
      topic: "feature-unicode",
      branch: "feature/unicode",
      remote: false,
    };
    const d = await service.readTopicDetails(project.id, year, target);
    expect(d.text).toBe(task);
    expect(d.editable).toBe(false);
    plan = await service.prepareTopicOperation({
      projectId: project.id,
      year,
      expectedRevision: board.revision,
      action: "switch",
      target,
    });
    expect((await service.executeTopicOperation(plan.token)).status).toBe(
      "success",
    );
    board = await service.readTopicBoard(project.id, year);
    expect(board.currentTopic).toEqual(target);
    expect(
      (await service.readTopicDetails(project.id, year, target)).editable,
    ).toBe(true);
    await git("switch", "main");
    board = await service.readTopicBoard(project.id, year);
    plan = await service.prepareTopicOperation({
      projectId: project.id,
      year,
      expectedRevision: board.revision,
      action: "delete",
      topics: ["feature-unicode"],
    });
    expect(plan.details.join(" ")).toContain("origin/feature/unicode");
    expect((await service.executeTopicOperation(plan.token)).status).toBe(
      "success",
    );
    expect(await git("branch", "--list", "feature/unicode")).toBe("");
    expect(await git("ls-remote", "origin", "refs/heads/feature/unicode")).toBe(
      "",
    );
  },
  60000,
);

// Every CLI mutation below targets a fresh fixture and its bare filesystem
// origin. No pipelines, Docker, user checkout, or network transport are used.
async function operationFixture() {
  const dir = await mkdtemp("/private/tmp/goga-topics-operations-");
  clean.push(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo"),
    home = path.join(dir, "home"),
    origin = path.join(dir, "origin.git");
  await mkdir(repo);
  await mkdir(home);
  const runner = new NodeRunner(120000, {
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const cliDiagnostics: string[] = [];
  const startProcess = runner.start.bind(runner);
  runner.start = (...args: Parameters<typeof startProcess>) => {
    const child = startProcess(...args);
    if (args[0] === cli)
      child.stderr.on("data", (chunk) => cliDiagnostics.push(String(chunk)));
    return child;
  };
  clean.push(() => runner.dispose());
  const git = async (...args: string[]) =>
    (await runner.command("git", args, repo)).stdout;
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.test");
  await git("commit", "--allow-empty", "-m", "initial");
  await git("init", "--bare", origin);
  await git("remote", "add", "origin", origin);
  await git("push", "-u", "origin", "main");
  const service = new HostService({
    home,
    dataDir: path.join(dir, "data"),
    goga: cli,
    runner,
  });
  clean.push(() => service.dispose());
  const project = await service.addProject(repo),
    year = "2025";
  const board = () => service.readTopicBoard(project.id, year);
  const prepare = async (
    operation: Omit<
      import("../src/shared/topics").TopicOperationRequest,
      "projectId" | "year" | "expectedRevision"
    >,
  ) =>
    service.prepareTopicOperation({
      projectId: project.id,
      year,
      expectedRevision: (await board()).revision,
      ...operation,
    });
  const execute = async (operation: Parameters<typeof prepare>[0]) => {
    const plan = await prepare(operation);
    const result = await service.executeTopicOperation(plan.token);
    expect(
      result,
      `${operation.action}: ${result.message}\nCLI stderr: ${cliDiagnostics.join("")}`,
    ).toMatchObject({
      status: "success",
    });
    return plan;
  };
  const originTip = (branch: string) =>
    git("--git-dir", origin, "rev-parse", `refs/heads/${branch}`);
  return {
    repo,
    origin,
    service,
    project,
    year,
    git,
    board,
    prepare,
    execute,
    originTip,
  };
}

it.skipIf(!cli).each([
  { publish: false, switch: false, branch: "feature/local-stay" },
  { publish: false, switch: true, branch: "feature/local-switch" },
  { publish: true, switch: true, branch: "feature/published-switch" },
])(
  "installed CLI create publish=$publish switch=$switch: actual task, branch, origin and dirty rules",
  async ({ publish, switch: switchTo, branch }) => {
    const f = await operationFixture(),
      topic = branch.replaceAll("/", "-"),
      relative = `.goga/history/${f.year}/${topic}/todo.md`;
    const task = "Создание отдельного топика 🙂\n\nСтрока 2\n";
    const base = (await f.git("rev-parse", "main")).trim();
    await f.execute({
      action: "create",
      branch,
      baseRef: "main",
      task,
      publish,
      switch: switchTo,
    });
    expect((await f.git("branch", "--show-current")).trim()).toBe(
      switchTo ? branch : "main",
    );
    const tip = (await f.git("rev-parse", `refs/heads/${branch}`)).trim();
    const target = { topic, branch, remote: false };
    const details = await f.service.readTopicDetails(
      f.project.id,
      f.year,
      target,
    );
    expect(details.text).toBe(task);
    expect(details.editable).toBe(switchTo);
    const isUncommittedSwitch = switchTo && !publish;
    expect((await f.git("status", "--porcelain")).length > 0).toBe(
      isUncommittedSwitch,
    );
    if (isUncommittedSwitch) {
      expect(tip).toBe(base);
      expect(
        await f.git("ls-tree", "-r", "--name-only", branch, "--", relative),
      ).toBe("");
      expect(await readFile(path.join(f.repo, relative), "utf8")).toBe(task);
      await expect(
        f.prepare({
          action: "create",
          branch: "blocked/dirty",
          baseRef: "main",
          task,
          publish: true,
          switch: true,
        }),
      ).rejects.toThrow(/dirty|изменения/i);
      expect(await f.git("branch", "--list", "blocked/dirty")).toBe("");
      expect(
        await f.git(
          "--git-dir",
          f.origin,
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/blocked/dirty",
        ),
      ).toBe("");
    } else {
      expect(tip).not.toBe(base);
      expect(await f.git("show", `${branch}:${relative}`)).toBe(task);
    }
    if (publish) expect((await f.originTip(branch)).trim()).toBe(tip);
    else
      expect(
        await f.git(
          "--git-dir",
          f.origin,
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/${branch}`,
        ),
      ).toBe("");
  },
  60000,
);

it.skipIf(!cli)(
  "installed CLI: empty task allowed only for local switch creation; other modes require task",
  async () => {
    const f = await operationFixture();
    for (const [publish, switchTo] of [
      [false, false],
      [true, false],
      [true, true],
    ]) {
      await expect(
        f.prepare({
          action: "create",
          branch: "feature/no-task",
          baseRef: "main",
          task: "",
          publish,
          switch: switchTo,
        }),
      ).rejects.toThrow(/задач/i);
      expect(await f.git("branch", "--list", "feature/no-task")).toBe("");
    }
    await f.execute({
      action: "create",
      branch: "feature/no-task",
      baseRef: "main",
      task: "",
      publish: false,
      switch: true,
    });
    expect((await f.git("branch", "--show-current")).trim()).toBe(
      "feature/no-task",
    );
    expect((await f.git("rev-parse", "HEAD")).trim()).toBe(
      (await f.git("rev-parse", "main")).trim(),
    );
    await expect(
      readFile(
        path.join(f.repo, `.goga/history/${f.year}/feature-no-task/todo.md`),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await f.git(
        "--git-dir",
        f.origin,
        "for-each-ref",
        "--format=%(refname)",
        "refs/heads/feature/no-task",
      ),
    ).toBe("");
  },
  60000,
);

it.skipIf(!cli)(
  "installed CLI: update base into topic, publish topic, propagate topic into base with origin push",
  async () => {
    const f = await operationFixture(),
      branch = "feature/exchange",
      topic = "feature-exchange";
    const target = { topic, branch, remote: false },
      relative = `.goga/history/${f.year}/${topic}/todo.md`;
    const task = "Реальная задача обмена 🙂\n\nСохранить весь текст.\n";
    await f.execute({
      action: "create",
      branch,
      baseRef: "main",
      task,
      publish: false,
      switch: false,
    });
    const topicBefore = (await f.git("rev-parse", branch)).trim();
    expect(
      await f.git(
        "--git-dir",
        f.origin,
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${branch}`,
      ),
    ).toBe("");
    await writeFile(path.join(f.repo, "base-change.txt"), "base-only change\n");
    await f.git("add", "base-change.txt");
    await f.git("commit", "-m", "advance base fixture");
    await f.git("push", "origin", "main");
    const baseBefore = (await f.git("rev-parse", "main")).trim();
    // Reject the CLI's checked-out-base prerequisite before confirmation.
    await expect(
      f.prepare({ action: "update", target, baseRef: "main", publish: false }),
    ).rejects.toThrow(/Базовая ветка.*текущая/i);
    await expect(
      f.prepare({ action: "propagate", target, baseRef: "origin/main" }),
    ).rejects.toThrow(/Базовая ветка.*текущая/i);
    expect((await f.git("rev-parse", branch)).trim()).toBe(topicBefore);
    expect((await f.git("rev-parse", "main")).trim()).toBe(baseBefore);
    expect(await f.git("status", "--porcelain")).toBe("");
    await f.execute({ action: "switch", target });
    await f.execute({
      action: "update",
      target,
      baseRef: "main",
      publish: false,
    });
    const topicAfter = (await f.git("rev-parse", branch)).trim();
    expect(topicAfter).not.toBe(topicBefore);
    await f.git("merge-base", "--is-ancestor", baseBefore, topicAfter);
    await f.git("merge-base", "--is-ancestor", topicBefore, topicAfter);
    expect(await f.git("show", `${branch}:base-change.txt`)).toBe(
      "base-only change\n",
    );
    expect(await f.git("show", `${branch}:${relative}`)).toBe(task);
    expect((await f.git("branch", "--show-current")).trim()).toBe(branch);
    expect((await f.originTip("main")).trim()).toBe(baseBefore);
    expect(
      await f.git(
        "--git-dir",
        f.origin,
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/${branch}`,
      ),
    ).toBe("");
    await f.execute({ action: "publish", target });
    expect((await f.originTip(branch)).trim()).toBe(topicAfter);
    expect(
      await f.git(
        "--git-dir",
        f.origin,
        "show",
        `refs/heads/${branch}:${relative}`,
      ),
    ).toBe(task);
    await f.execute({ action: "switch", target });
    const propagation = await f.execute({
      action: "propagate",
      target,
      baseRef: "main",
    });
    expect(propagation.details.join(" ")).toContain("origin");
    const mainAfter = (await f.git("rev-parse", "main")).trim();
    expect(mainAfter).not.toBe(baseBefore);
    await f.git("merge-base", "--is-ancestor", topicAfter, mainAfter);
    expect((await f.originTip("main")).trim()).toBe(mainAfter);
    expect(
      await f.git("--git-dir", f.origin, "show", `refs/heads/main:${relative}`),
    ).toBe(task);
    expect((await f.git("rev-parse", branch)).trim()).toBe(topicAfter);
    expect((await f.git("branch", "--show-current")).trim()).toBe(branch);
    expect(await f.git("status", "--porcelain")).toBe("");
    expect(
      (await f.service.readTopicDetails(f.project.id, f.year, target)).text,
    ).toBe(task);
  },
  60000,
);

it.skipIf(!cli)(
  "installed CLI: operations on another topic preserve dirty HEAD, index and working files",
  async () => {
    const f = await operationFixture();
    await writeFile(path.join(f.repo, "tracked.txt"), "committed\n");
    await f.git("add", "tracked.txt");
    await f.git("commit", "-m", "tracked baseline");
    await f.git("push", "origin", "main");
    const branch = "feature/other",
      target = { topic: "feature-other", branch, remote: false };
    await f.execute({
      action: "create",
      branch,
      baseRef: "main",
      task: "Other topic task",
      publish: false,
      switch: false,
    });
    await writeFile(path.join(f.repo, "base-only.txt"), "base advance\n");
    await f.git("add", "base-only.txt");
    await f.git("commit", "-m", "advance base");
    await f.git("push", "origin", "main");
    await f.git("switch", "-c", "working");
    await writeFile(path.join(f.repo, "tracked.txt"), "staged change\n");
    await f.git("add", "tracked.txt");
    await writeFile(path.join(f.repo, "tracked.txt"), "unstaged change\n");
    await writeFile(path.join(f.repo, "untracked.txt"), "untracked work\n");
    const snapshot = async () => ({
      branch: await f.git("branch", "--show-current"),
      head: await f.git("rev-parse", "HEAD"),
      index: await f.git("ls-files", "--stage"),
      status: await f.git("status", "--porcelain"),
      tracked: await readFile(path.join(f.repo, "tracked.txt"), "utf8"),
      untracked: await readFile(path.join(f.repo, "untracked.txt"), "utf8"),
    });
    const before = await snapshot(),
      oldTip = await f.git("rev-parse", branch);
    expect((await f.board()).dirty).toBe(true);
    await f.execute({
      action: "update",
      target,
      baseRef: "main",
      publish: false,
    });
    expect(await f.git("rev-parse", branch)).not.toBe(oldTip);
    expect(await f.git("show", `${branch}:base-only.txt`)).toBe(
      "base advance\n",
    );
    expect(await snapshot()).toEqual(before);
    await f.execute({ action: "publish", target });
    expect(await f.originTip(branch)).toBe(await f.git("rev-parse", branch));
    expect(await snapshot()).toEqual(before);
    await f.execute({ action: "propagate", target, baseRef: "main" });
    expect(await snapshot()).toEqual(before);
    // Only this isolated fixture drops its local ref, leaving an origin-only topic.
    await f.git("branch", "-D", branch);
    const remoteTarget = {
      ...target,
      branch: `origin/${branch}`,
      remote: true,
    };
    for (const action of ["update", "publish", "propagate"] as const)
      await expect(
        f.prepare({ action, target: remoteTarget, baseRef: "main" }),
      ).rejects.toThrow(/локальн/i);
    const plan = await f.execute({ action: "delete", target: remoteTarget });
    expect(plan.details.join(" ")).toContain(`origin/${branch}`);
    expect(await f.git("ls-remote", "origin", `refs/heads/${branch}`)).toBe("");
    expect(await snapshot()).toEqual(before);
  },
  120000,
);
