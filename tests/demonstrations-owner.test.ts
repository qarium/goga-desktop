import { afterEach, expect, it, vi } from "vitest";
import { access, rename } from "node:fs/promises";
import path from "node:path";
import { worktreeContextRef } from "../src/shared/worktrees";
import { topicRemovalFixture } from "./helpers/topic-removal-fixture";
import { gitIntegrationBudget } from "./helpers/git-integration";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

it(
  "admits a show for a real managed topic clone, never falls back to its primary folder on a stale or missing copy",
  async () => {
    const { manager, service, project, git, root } =
      await topicRemovalFixture(cleanup);
    const ready = await manager.ensure(project, {
      projectId: project.id,
      year: "2026",
      topic: "alpha",
      branch: "alpha",
    });
    expect(ready.path).not.toBe(project.path);
    expect(ready).toMatchObject({
      storageKind: "clone",
      ownership: "managed",
      state: "ready",
    });
    expect(await git(["branch", "--show-current"], ready.path)).toBe("alpha");
    const first = worktreeContextRef(ready);
    const open = vi.fn(async (_label: string) => {});
    await service.withDemonstrationOwner(first, open);
    expect(open.mock.calls).toEqual([[project.name + " · alpha"]]);

    // Use actual Git and normal reconciliation to rotate the persisted owner
    // revision; the old reference was issued and accepted, not just malformed.
    await git(["switch", "--detach", "HEAD"], ready.path);
    const detached = (await service.listTopicContexts(project.id)).find(
      (r) => r.contextId === first.contextId,
    )!;
    expect(detached.state).not.toBe("ready");
    await git(["switch", "alpha"], ready.path);
    const next = (await service.listTopicContexts(project.id)).find(
      (r) => r.contextId === first.contextId,
    )!;
    expect(next.state).toBe("ready");
    expect(next.revision).not.toBe(first.revision);
    await expect(service.withDemonstrationOwner(first, open)).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
    const current = worktreeContextRef(next);
    await service.withDemonstrationOwner(current, open);
    expect(open).toHaveBeenCalledTimes(2);

    await rename(ready.path, path.join(root, "temporarily-moved-alpha"));
    await access(project.path); // The primary checkout exists, but must not substitute for alpha.
    await expect(
      service.withDemonstrationOwner(current, open),
    ).rejects.toThrow();
    expect(open).toHaveBeenCalledTimes(2);
    await service.withDemonstrationOwner(project.id, open);
    expect(open).toHaveBeenLastCalledWith(project.name);
  },
  gitIntegrationBudget(15000),
);
