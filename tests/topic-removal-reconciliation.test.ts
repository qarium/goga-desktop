import { gitIntegrationBudget } from "./helpers/git-integration";
import { afterEach, expect, it } from "vitest";
import { access, writeFile } from "node:fs/promises";
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
    expect(plan.aheadCount).toBe(0);
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
  "preserves changed copy while completing native deletion and does not hide it",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      row = await f.manager.ensure(f.project, {
        projectId: f.project.id,
        year: "2026",
        topic: "alpha",
        branch: "alpha",
      });
    f.onMutation(() => writeFile(path.join(row.path, "valuable.txt"), "keep"));
    const p = await f.service.prepareTopicRemoval((await f.request()) as any),
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
