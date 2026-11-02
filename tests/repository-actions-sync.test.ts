import { gitIntegrationBudget } from "./helpers/git-integration";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const fixtureScope = installGitFixtureScope();
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { ByteCommandError, CommandExitError } from "../src/host/process";
import { DesktopStateStore } from "../src/host/desktop-state";
import type { Run } from "../src/shared/types";

import { repositoryActionsFixture } from "./helpers/repository-actions-fixture";
const fixture = () => repositoryActionsFixture(fixtureScope);

it(
  "manual sync merges the same local topic branch into clone before exporting, without touching primary checkout",
  fixtureScope.run(async () => {
    const f = await fixture();
    const cloneBefore = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["checkout", "alpha"]);
    await fs.writeFile(path.join(f.repo, "primary-topic"), "incoming\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "primary topic"]);
    const incoming = await f.git(["rev-parse", "HEAD"]);
    await f.git(["checkout", "main"]);
    const main = await f.git(["rev-parse", "HEAD"]);
    const otherRefs = await f.git(
      [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/remotes",
        "refs/desktop/topic-sync",
      ],
      f.owner.path,
    );
    let beforePushRefs = "not observed";
    f.intercept(async (_exe, args, cwd) => {
      if (cwd === f.owner.path && args.includes("push"))
        beforePushRefs = await f.git(
          [
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/remotes",
            "refs/desktop/topic-sync",
          ],
          f.owner.path,
        );
    });
    f.calls.length = 0;
    const result = await f.action("sync");
    expect(result.status, result.log).toBe("success");
    // The receive phase must not write tracking/scratch refs. The subsequent
    // ordinary push may legitimately advance its own origin/alpha tracking ref.
    expect(beforePushRefs).toBe(otherRefs);
    const head = await f.git(["rev-parse", "HEAD"], f.owner.path);
    expect(await f.git(["rev-parse", "alpha"])).toBe(head);
    expect(await f.git(["rev-parse", "HEAD"])).toBe(main);
    expect(await f.git(["merge-base", head, incoming], f.owner.path)).toBe(
      incoming,
    );
    expect(await f.git(["merge-base", head, cloneBefore], f.owner.path)).toBe(
      cloneBefore,
    );
    expect(
      await fs.readFile(path.join(f.owner.path, "primary-topic"), "utf8"),
    ).toBe("incoming\n");
    expect(await f.git(["status", "--porcelain"])).toBe("");
    const merge = f.calls.findIndex(
      (c) => c.cwd === f.owner.path && c.args.includes("merge"),
    );
    const push = f.calls.findIndex((c) => c.args.includes("push"));
    expect(merge).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(merge);
    expect(
      f.calls.some((c) =>
        c.args.some((a) => a === "--force" || a.startsWith("+")),
      ),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

for (const action of ["abort", "continue"] as const)
  it(
    `incoming sync conflict stops export and supports Desktop ${action}`,
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.owner.path, "base"), "clone-conflict\n");
      await f.git(["commit", "-am", "clone conflict"], f.owner.path);
      const cloneBefore = await f.git(["rev-parse", "HEAD"], f.owner.path);
      await f.git(["checkout", "alpha"]);
      await fs.writeFile(path.join(f.repo, "base"), "primary-conflict\n");
      await f.git(["commit", "-am", "primary conflict"]);
      const incoming = await f.git(["rev-parse", "HEAD"]);
      await f.git(["checkout", "main"]);
      f.calls.length = 0;
      const result = await f.action("sync");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/конфликт/i);
      expect(
        await f.git(
          ["for-each-ref", "--format=%(refname)", "refs/desktop/topic-sync"],
          f.owner.path,
        ),
      ).toBe("");
      expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
      expect(await f.git(["rev-parse", "alpha"])).toBe(incoming);
      const snapshot = await f.service.readGitWorkspace(f.ref);
      expect(snapshot.operation).toBe("merge");
      if (action === "continue") {
        await fs.writeFile(path.join(f.owner.path, "base"), "resolved both\n");
        await f.git(["add", "base"], f.owner.path);
      }
      const current = await f.service.readGitWorkspace(f.ref);
      const followup = await f.service.prepareGitMergeOperation({
        scope: f.ref,
        revision: current.revision,
        action,
      });
      expect(
        (await f.service.executeGitMergeOperation(followup.token)).status,
      ).toBe("success");
      if (action === "abort")
        expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(
          cloneBefore,
        );
      else {
        const merged = await f.git(["rev-parse", "HEAD"], f.owner.path);
        expect((await f.action("sync")).status).toBe("success");
        expect(await f.git(["rev-parse", "alpha"])).toBe(merged);
        expect(await fs.readFile(path.join(f.owner.path, "base"), "utf8")).toBe(
          "resolved both\n",
        );
      }
    }),
    // Continue performs both the merge resolution and a second full sync. Measured
    // 38 s alone / >45 s in the three-worker run; keep a finite per-case budget.
    gitIntegrationBudget(action === "continue" ? 20000 : 15000),
  );

it(
  "update-base uses local base when its branch is absent on remote",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git(["update-ref", "-d", "refs/heads/main"], f.remote);
    f.calls.length = 0;
    const result = await f.action("update-base");
    expect(result.status, result.log).toBe("success");
    expect(result.log).toMatch(/локальн/i);
    expect(f.calls.some((c) => c.args.includes("ls-remote"))).toBe(true);
    expect(f.calls.some((c) => c.args[0] === "topics")).toBe(true);
    expect(
      f.calls.some((c) => c.cwd === f.repo && c.args.includes("fetch")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it(
  "update-base never treats remote authentication/transport failure as an absent branch",
  fixtureScope.run(async () => {
    const f = await fixture();
    f.intercept(async (exe, args) => {
      if (args.includes("ls-remote"))
        throw new CommandExitError(
          "Transport failed",
          128,
          "",
          "fixture auth failure",
        );
    });
    const before = await f.git(["rev-parse", "main"]);
    const result = await f.action("update-base");
    expect(result.status).toBe("error");
    expect(
      f.calls.some(
        (c) =>
          c.args[0] === "topics" ||
          (c.cwd === f.owner.path && c.args.includes("fetch")),
      ),
    ).toBe(false);
    expect(await f.git(["rev-parse", "main"])).toBe(before);
  }),
  gitIntegrationBudget(15000),
);

it(
  "update-remote can update clone from the original local topic before that branch is published",
  fixtureScope.run(async () => {
    const f = await fixture();
    // Original has no alpha on remote; first export creates/advances the local branch.
    expect((await f.action("publish")).status).toBe("success");
    await f.git(["update-ref", "-d", "refs/heads/alpha"], f.remote);
    await f.git(["checkout", "alpha"]);
    await fs.writeFile(path.join(f.repo, "from-primary"), "local only\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "local topic advance"]);
    const next = await f.git(["rev-parse", "HEAD"]);
    await f.git(["checkout", "main"]);
    f.calls.length = 0;
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe("success");
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(next);
    expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it.each(["dirty", "active"])(
  "incoming sync refuses a %s clone without exporting or overwriting edits",
  fixtureScope.run(async (mode) => {
    const f = await fixture();
    await f.git(["checkout", "alpha"]);
    await fs.writeFile(path.join(f.repo, "incoming"), "incoming\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "incoming"]);
    const primary = await f.git(["rev-parse", "HEAD"]);
    await f.git(["checkout", "main"]);
    const clone = await f.git(["rev-parse", "HEAD"], f.owner.path);
    if (mode === "dirty")
      await fs.writeFile(path.join(f.owner.path, "topic"), "unsaved\n");
    else
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
    f.calls.length = 0;
    const result = await f.action("sync");
    expect(result.status).toBe("error");
    expect(await f.git(["rev-parse", "alpha"])).toBe(primary);
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(clone);
    expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
    if (mode === "dirty")
      expect(await fs.readFile(path.join(f.owner.path, "topic"), "utf8")).toBe(
        "unsaved\n",
      );
  }),
  gitIntegrationBudget(15000),
);

it(
  "manual sync refuses a source branch changed during fetch",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git(["checkout", "alpha"]);
    await fs.writeFile(path.join(f.repo, "incoming"), "incoming\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "incoming"]);
    await f.git(["checkout", "main"]);
    const main = await f.git(["rev-parse", "main"]);
    const clone = await f.git(["rev-parse", "HEAD"], f.owner.path);
    let changed = false;
    f.intercept(async (_exe, args, cwd) => {
      if (!changed && cwd === f.owner.path && args.includes("fetch")) {
        changed = true;
        await f.git(["update-ref", "refs/heads/alpha", main]);
      }
    });
    f.calls.length = 0;
    expect((await f.action("sync")).status).toBe("error");
    expect(changed).toBe(true);
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(clone);
    expect(await f.git(["rev-parse", "alpha"])).toBe(main);
    expect(
      f.calls.some((c) => c.args.includes("push") || c.args.includes("merge")),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it(
  "topic refresh works without any server remote and never publishes",
  fixtureScope.run(async () => {
    const f = await fixture();
    const clone = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["remote", "remove", "origin"]);
    f.calls.length = 0;
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe("success");
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(clone);
    expect(
      f.calls.some(
        (c) =>
          c.args.includes("push") ||
          c.args.includes("ls-remote") ||
          (c.cwd === f.repo && c.args.includes("fetch")),
      ),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it.each(["absent", "behind"])(
  "manual sync handles an %s original branch without losing commits",
  fixtureScope.run(async (mode) => {
    const f = await fixture();
    let expected = await f.git(["rev-parse", "HEAD"], f.owner.path);
    if (mode === "absent") await f.git(["branch", "-D", "alpha"]);
    else {
      expect((await f.action("sync")).status).toBe("success");
      await f.git(["checkout", "alpha"]);
      await fs.writeFile(path.join(f.repo, "incoming-only"), "incoming\n");
      await f.git(["add", "."]);
      await f.git(["commit", "-m", "advance"]);
      expected = await f.git(["rev-parse", "HEAD"]);
      await f.git(["checkout", "main"]);
    }
    const result = await f.action("sync");
    expect(result.status, result.log).toBe("success");
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(expected);
    expect(await f.git(["rev-parse", "alpha"])).toBe(expected);
    expect(await f.git(["status", "--porcelain"], f.owner.path)).toBe("");
  }),
  gitIntegrationBudget(15000),
);

it(
  "incoming sync retains its native fence if clone lifecycle release fails after a completed merge",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git(["checkout", "alpha"]);
    await fs.writeFile(path.join(f.repo, "incoming"), "incoming\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "incoming"]);
    const original = await f.git(["rev-parse", "HEAD"]);
    await f.git(["checkout", "main"]);
    let executed = false,
      faulted = false;
    f.intercept(async (_exe, args) => {
      if (args.includes("merge")) executed = true;
    });
    const { CloneStore } = await import("../src/host/clone-store");
    const real = CloneStore.prototype.withRepositoryLock;
    vi.spyOn(CloneStore.prototype, "withRepositoryLock").mockImplementation(
      async function (
        this: InstanceType<typeof CloneStore>,
        key,
        action,
        options,
      ) {
        const result = await real.call(this, key, action, options);
        if (executed && !faulted) {
          faulted = true;
          throw Error("fixture post-merge lifecycle release failure");
        }
        return result;
      },
    );
    f.calls.length = 0;
    expect((await f.action("sync")).status).toBe("error");
    expect(faulted).toBe(true);
    expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
    expect(await f.git(["rev-parse", "alpha"])).toBe(original);
    const directory = path.join(f.home, ".goga/desktop/git-operations");
    const records = (await fs.readdir(directory)).filter((n) =>
      n.endsWith(".json"),
    );
    expect(records).toHaveLength(1);
    const receipt = JSON.parse(
      await fs.readFile(path.join(directory, records[0]), "utf8"),
    );
    expect(receipt.recovery).not.toBeNull();
    expect(receipt.result.recovery).toBe("retained");
  }),
  gitIntegrationBudget(15000),
);
