import { gitIntegrationBudget } from "./helpers/git-integration";
import { afterEach, expect, it } from "vitest";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { topicRemovalFixture } from "./helpers/topic-removal-fixture";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
it(
  "uses the real Host and Goga before preparing copy cleanup, never before command success",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      row = await f.manager.ensure(f.project, {
        projectId: f.project.id,
        year: "2026",
        topic: "alpha",
        branch: "alpha",
      });
    const p = await f.service.prepareTopicRemoval((await f.request()) as any);
    expect(f.order).toEqual([]);
    const r = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: p.token,
    });
    expect(r.topics.status).toBe("success");
    expect(r.cleanup).toHaveLength(1);
    expect(f.order).toEqual(["goga"]);
    const plan = r.cleanup[0].plan;
    expect(plan.purpose).toBe("clone-after-topic");
    expect(plan.aheadCount).toBeUndefined(); // Explicit whole-copy consent does not count commits.
    expect(plan.requiresAheadConfirmation).toBe(false);
    const removed = await f.service.deleteContext({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(removed.cloneRemoved).toBe(true);
    const resumed = await f.service.prepareTopicCloneCleanup({
      owner: r.cleanup[0].owner,
    });
    expect(resumed.token).toBe(plan.token);
    expect(resumed.stage).toBe("clone-trashed");
    await f.service.finishContextDeletion({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(f.order).toEqual(["goga", "trash"]);
    expect(f.calls).toHaveLength(1);
    await expect(access(row.path)).rejects.toThrow();
  },
  gitIntegrationBudget(15000),
);
it(
  "does not clean a copy on uncertain failure of the native operation",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      row = await f.manager.ensure(f.project, {
        projectId: f.project.id,
        year: "2026",
        topic: "alpha",
        branch: "alpha",
      });
    const p = await f.service.prepareTopicRemoval((await f.request()) as any);
    f.fail();
    const r = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: p.token,
    });
    expect(r.topics.status).toBe("partial");
    expect(r.cleanup).toEqual([]);
    expect(f.order).toEqual(["goga"]);
    await expect(access(row.path)).resolves.toBeUndefined();
  },
  gitIntegrationBudget(15000),
);
it(
  "clear preserves changed copy while completing native deletion and does not hide it",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      row = await f.manager.ensure(f.project, {
        projectId: f.project.id,
        year: "2026",
        topic: "alpha",
        branch: "alpha",
      });
    f.onMutation(() => writeFile(path.join(row.path, "valuable.txt"), "keep"));
    const p = await f.service.prepareTopicRemoval(
        (await f.request("clear")) as any,
      ),
      r = await f.service.executeTopicRemoval({
        projectId: f.project.id,
        token: p.token,
      });
    expect(r.topics.status).toBe("success");
    expect(r.cleanup).toEqual([]);
    expect(r.copies[0].status).toBe("kept");
    await expect(access(row.path)).resolves.toBeUndefined();
    expect(
      (await f.service.readTopicTable(f.project.id, "2026")).entries.some(
        (x) => x.topic === "alpha",
      ),
    ).toBe(true);
  },
  gitIntegrationBudget(15000),
);
it(
  "refuses stale registry ownership before invoking the native command",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    });
    const p = await f.service.prepareTopicRemoval((await f.request()) as any);
    await f.git(["branch", "beta"]);
    await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "beta",
      branch: "beta",
    });
    await expect(
      f.service.executeTopicRemoval({
        projectId: f.project.id,
        token: p.token,
      }),
    ).rejects.toThrow(/измен|устар|каталог/i);
    expect(f.calls).toEqual([]);
    expect(f.order).toEqual([]);
  },
  gitIntegrationBudget(15000),
);
it(
  "retains a copy if the origin cannot confirm deletion",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    const row = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    });
    await f.git([
      "remote",
      "add",
      "origin",
      path.join(f.root, "unavailable-origin.git"),
    ]);
    const p = await f.service.prepareTopicRemoval(
      (await f.request("clear")) as any,
    );
    const r = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: p.token,
    });
    expect(r.topics.status).toBe("success");
    expect(r.cleanup).toEqual([]);
    expect(r.copies[0].status).toBe("kept");
    expect(f.order).toEqual(["goga"]);
    await expect(access(row.path)).resolves.toBeUndefined();
  },
  gitIntegrationBudget(15000),
);
it(
  "retains a copy if its branch still exists on origin after CLI success",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      origin = path.join(f.root, "origin.git");
    await f.git(["init", "--bare", origin]);
    await f.git(["remote", "add", "origin", origin]);
    await f.git(["push", "origin", "main", "alpha"]);
    const row = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    });
    const p = await f.service.prepareTopicRemoval(
      (await f.request("clear")) as any,
    );
    const r = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: p.token,
    });
    expect(r.topics.status).toBe("success");
    expect(r.cleanup).toEqual([]);
    expect(f.order).toEqual(["goga"]);
    await expect(access(row.path)).resolves.toBeUndefined();
  },
  gitIntegrationBudget(15000),
);
it(
  "refreshes a prepared cleanup after a new commit instead of replaying stale consent",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    const row = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    });
    const p = await f.service.prepareTopicRemoval((await f.request()) as any);
    const r = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: p.token,
    });
    await f.git(["commit", "--allow-empty", "-m", "new-copy-commit"], row.path);
    const fresh = await f.service.prepareTopicCloneCleanup({
      owner: r.cleanup[0].owner,
    });
    expect(fresh.token).not.toBe(r.cleanup[0].plan.token);
    expect(fresh.requiresAheadConfirmation).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(f.order).toEqual(["goga"]);
  },
  gitIntegrationBudget(15000),
);

it(
  "prepares a deletion without reading display boards or inspecting unrelated clones",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    await f.git(["branch", "beta"]);
    const other = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "beta",
      branch: "beta",
    });
    const request = await f.request();
    f.reads.length = 0;
    const p = await f.service.prepareTopicRemoval(request as any);
    expect(f.reads.filter((c) => c.args.includes("board"))).toHaveLength(0);
    expect(f.reads.filter((c) => c.cwd === other.path)).toHaveLength(0);
    expect(
      f.reads.filter(
        (c) => c.args.includes("--binary") && c.args.includes("HEAD"),
      ).length,
    ).toBeLessThanOrEqual(2);
    expect(p.blocked).toBeUndefined();
    expect(f.calls).toEqual([]);
  },
  gitIntegrationBudget(15000),
);

it(
  "issues its own preview revision when the caller only supplies selected slugs",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    const p = await f.service.prepareTopicRemoval({
      projectId: f.project.id,
      year: "2026",
      action: "delete",
      topics: ["alpha"],
    } as any);
    expect(p.token).toBeTruthy();
    expect(f.reads.filter((c) => c.args.includes("--binary"))).toHaveLength(0);
    await f.git(["commit", "--allow-empty", "-m", "moved"]);
    await expect(
      f.service.executeTopicRemoval({
        projectId: f.project.id,
        token: p.token,
      }),
    ).rejects.toThrow(/измен|устар/);
    expect(f.calls).toEqual([]);
  },
  gitIntegrationBudget(15000),
);

it.each([true, false])(
  "includes a primary disk-only topic with a managed copy; CLI removed directory=%s",
  async (removed) => {
    const f = await topicRemovalFixture(cleanups);
    await f.git(["branch", "beta"]);
    const owner = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "beta",
      branch: "beta",
    });
    await f.git(["branch", "-D", "beta"]);
    const dir = path.join(f.repo, ".goga/history/2026/beta");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "todo.md"), "only on disk");
    f.mockNativeMutation(async (args) => {
      expect(args).toEqual([
        "topics",
        "--year",
        "2026",
        "delete",
        "beta",
        "--yes",
      ]);
      if (removed) await rm(dir, { recursive: true });
    });
    const p = await f.service.prepareTopicRemoval({
      ...(await f.request()),
      topics: ["beta"],
    } as any);
    const result = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: p.token,
    });
    expect(f.calls).toHaveLength(1);
    expect(result.topics.status).toBe(removed ? "success" : "partial");
    expect(result.cleanup).toHaveLength(removed ? 1 : 0);
    if (!removed)
      expect(result.copies).toEqual([
        expect.objectContaining({ topic: "beta", status: "kept" }),
      ]);
    await expect(access(owner.path)).resolves.toBeUndefined();
  },
  gitIntegrationBudget(15000),
);

it(
  "a single explicit deletion includes the entire selected dirty copy, not other copies",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    const row = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    });
    await f.git(["commit", "--allow-empty", "-m", "unpublished"], row.path);
    await writeFile(path.join(row.path, ".gitignore"), "ignored.tmp");
    await writeFile(path.join(row.path, "ignored.tmp"), "ignored but valuable");
    await writeFile(path.join(row.path, "local.txt"), "untracked");
    await writeFile(path.join(row.path, ".goga/config.yml"), "changed");
    f.reads.length = 0;
    const p = await f.service.prepareTopicRemoval({
      projectId: f.project.id,
      year: "2026",
      action: "delete",
      topics: ["alpha"],
    });
    expect(p.blocked).toBeUndefined();
    expect(
      f.reads.filter(
        (c) =>
          c.cwd === row.path &&
          ["status", "rev-list", "reflog"].includes(c.args[0]!),
      ),
    ).toEqual([]);
    expect(f.order).toEqual([]);
    const r = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: p.token,
    });
    expect(r.cleanup).toHaveLength(1);
    expect(r.cleanup[0].plan.requiresAheadConfirmation).not.toBe(true);
    expect(f.order).toEqual(["goga"]);
    const trash = await f.service.deleteContext({
      projectId: f.project.id,
      token: r.cleanup[0].plan.token,
    });
    expect(trash.cloneRemoved).toBe(true);
    await expect(
      access(path.join(f.root, "trash", "ignored.tmp")),
    ).resolves.toBeUndefined();
    await expect(access(f.repo)).resolves.toBeUndefined();
    expect(f.order).toEqual(["goga", "trash"]);
  },
  gitIntegrationBudget(15000),
);

it(
  "can remove an explicitly selected clone-only topic while origin is offline",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    await f.git(["branch", "local-only"]);
    const row = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "local-only",
      branch: "local-only",
    });
    await f.git(["branch", "-D", "local-only"]);
    await f.git([
      "remote",
      "add",
      "origin",
      path.join(f.root, "unavailable.git"),
    ]);
    await writeFile(path.join(row.path, "changed.txt"), "changed");
    f.reads.length = 0;
    const plan = await f.service.prepareTopicRemoval({
      projectId: f.project.id,
      year: "2026",
      action: "delete",
      topics: ["local-only"],
    });
    expect(plan.blocked).toBeUndefined();
    const r = await f.service.executeTopicRemoval({
      projectId: f.project.id,
      token: plan.token,
    });
    expect(r.cleanup).toHaveLength(1);
    const result = await f.service.deleteContext({
      projectId: f.project.id,
      token: r.cleanup[0].plan.token,
    });
    expect(result.cloneRemoved).toBe(true);
    expect(f.reads.some((c) => c.args.includes("ls-remote"))).toBe(false);
    expect(f.calls).toEqual([]);
  },
  gitIntegrationBudget(15000),
);

it(
  "rejects selected deletion before Goga if a copy acquired a terminal after preview",
  async () => {
    const f = await topicRemovalFixture(cleanups);
    const row = await f.manager.ensure(f.project, {
      projectId: f.project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    });
    const p = await f.service.prepareTopicRemoval({
      action: "delete",
      projectId: f.project.id,
      year: "2026",
      topics: ["alpha"],
    });
    expect(p.blocked).toBeUndefined();
    const lease = await f.service.acquireTerminalContext({
      projectId: row.projectId,
      contextId: row.contextId,
      revision: row.revision,
      year: row.year,
      topic: row.topic,
      branch: row.branch,
    });
    try {
      const result = await f.service.executeTopicRemoval({
        projectId: f.project.id,
        token: p.token,
      });
      expect(f.order).toEqual([]);
      expect(result.topics.status).toBe("failed");
      expect(result.topics.message).toMatch(/alpha.*активн/i);
      expect(result.cleanup).toEqual([]);
      expect(
        await f.git(["rev-parse", "--verify", "refs/heads/alpha"]),
      ).toBeTruthy();
      await expect(access(row.path)).resolves.toBeUndefined();
    } finally {
      lease.release();
    }
  },
  gitIntegrationBudget(15000),
);
