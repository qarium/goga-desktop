import { gitIntegrationBudget } from "./helpers/git-integration";
import { afterEach, expect, it } from "vitest";
import { access } from "node:fs/promises";
import { topicRemovalFixture } from "./helpers/topic-removal-fixture";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
it(
  "allows clear with owned clones, uses existing CLI, and preserves clones until completion",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      row = await f.manager.ensure(f.project, {
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
    expect(f.calls).toEqual([
      ["topics", "--year", "2026", "clear", "--base-ref", "main", "--yes"],
    ]);
    expect(r.topics.status).toBe("success");
    expect(r.cleanup).toHaveLength(1);
    await expect(access(row.path)).resolves.toBeUndefined();
  },
  gitIntegrationBudget(15000),
);
it(
  "rejects changed base or stale confirmation without invoking clear",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      p = await f.service.prepareTopicRemoval(
        (await f.request("clear")) as any,
      );
    await f.git(["commit", "--allow-empty", "-m", "changed"]);
    await expect(
      f.service.executeTopicRemoval({
        projectId: f.project.id,
        token: p.token,
      }),
    ).rejects.toThrow(/измен|устар|каталог/i);
    expect(f.calls).toEqual([]);
  },
  gitIntegrationBudget(15000),
);
it(
  "validates the clear request and does not accept filters as mutation authority",
  async () => {
    const f = await topicRemovalFixture(cleanups),
      r = await f.request("clear");
    await expect(
      f.service.prepareTopicRemoval({ ...r, baseRef: "-bad" } as any),
    ).rejects.toThrow();
    await expect(
      f.service.prepareTopicRemoval({ ...r, statuses: ["done"] } as any),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
  gitIntegrationBudget(15000),
);
