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

describe("header repository actions", () => {
  it(
    "syncs dirty topic during a running pipeline by ordinary local push",
    fixtureScope.run(async () => {
      const f = await fixture();
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty\n");
      const result = await f.action("sync");
      expect(result).toMatchObject({
        status: "success",
        projectId: f.project.id,
        contextId: f.ref.contextId,
        action: "sync",
      });
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(await fs.readFile(path.join(f.owner.path, "topic"), "utf8")).toBe(
        "dirty\n",
      );
      expect(
        f.calls.some(
          (c) => c.args.includes("checkout") || c.args.includes("--force"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "publishes same branch from original after clone sync, not clone to server",
    fixtureScope.run(async () => {
      const f = await fixture();
      const result = await f.action("publish");
      expect(result.status).toBe("success");
      const pushes = f.calls.filter((c) => c.args.includes("push"));
      expect(pushes.map((c) => c.cwd)).toEqual([f.owner.path, f.repo]);
      expect(
        pushes.every((c) => c.args.at(-1)?.endsWith(":refs/heads/alpha")),
      ).toBe(true);
      expect(await f.git(["rev-parse", "refs/heads/alpha"], f.remote)).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "retains successful local sync when original origin is absent",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["remote", "remove", "origin"]);
      const result = await f.action("publish");
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/origin/i);
      expect(result.log).toMatch(/синхронизация.*завершена/i);
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "base publish sends dirty current branch without checkout or upstream fallback",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo, "base"), "dirty\n");
      expect((await f.action("publish", false)).status).toBe("success");
      const push = f.calls.find((c) => c.args.includes("push"))!;
      expect(push.cwd).toBe(f.repo);
      expect(push.args.at(-1)).toMatch(/:refs\/heads\/main$/);
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "dirty\n",
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "update-base reads effective config in clone, refreshes original and fetches before native clone update",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "new\n");
      await f.git(["commit", "-am", "advance"]);
      await f.git(["push", "origin", "main"]);
      const next = await f.git(["rev-parse", "HEAD"]);
      await f.git(["reset", "--hard", old]); // Disposable fixture setup only.
      const result = await f.action("update-base");
      expect(result.status).toBe("success");
      expect(await f.git(["rev-parse", "main"])).toBe(next);
      const config = f.calls.findIndex(
        (c) => c.exe === "FAKE-GOGA" && c.args[0] === "config",
      );
      const fetch = f.calls.findIndex(
        (c) => c.cwd === f.repo && c.args.includes("fetch"),
      );
      const cloneFetch = f.calls.findIndex(
        (c) => c.cwd === f.owner.path && c.args.includes("fetch"),
      );
      const update = f.calls.findIndex(
        (c) => c.exe === "FAKE-GOGA" && c.args[0] === "topics",
      );
      expect(config).toBeLessThan(fetch);
      expect(fetch).toBeLessThan(cloneFetch);
      expect(cloneFetch).toBeLessThan(update);
      expect(f.calls[config]).toMatchObject({
        cwd: f.owner.path,
        args: ["config", "topics"],
      });
      expect(f.calls[update].cwd).toBe(f.owner.path);
      expect(f.calls[update].args).not.toContain("--publish");
      expect(f.calls[update].args).toContain("--base-ref");
      expect(f.calls[update].args).not.toContain("--strategy");
      expect(f.calls[update].args.slice(0, 5)).toEqual([
        "topics",
        "--year",
        "2026",
        "update",
        "alpha",
      ]);
      expect(
        await f.git(["rev-parse", "refs/remotes/origin/main"], f.owner.path),
      ).toBe(next);
    }),
    gitIntegrationBudget(15000),
  );
  it.each([
    "base_ref: null",
    "base_ref: ''",
    "base_ref: 42",
    "base_ref: [main]",
    "base_ref: main\nupdate: {strategy: []}",
    "[broken",
  ])(
    "fails closed on invalid effective topics config: %s",
    fixtureScope.run(async (config) => {
      const f = await fixture();
      f.config(config);
      expect((await f.action("update-base")).status).toBe("error");
      expect(
        f.calls.some(
          (c) =>
            c.args.includes("fetch") ||
            c.args.includes("push") ||
            c.args[0] === "topics",
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "missing upstream uses the verified local base without requiring publication",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "--unset-upstream", "main"]);
      const before = await f.git(["rev-parse", "main"]);
      f.calls.length = 0;
      const result = await f.action("update-base");
      expect(result.status, result.log).toBe("success");
      expect(result.log).toMatch(/локальн/i);
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(true);
      expect(
        f.calls.some((c) => c.cwd === f.repo && c.args.includes("fetch")),
      ).toBe(false);
      expect(await f.git(["rev-parse", "main"])).toBe(before);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "stale owner rejects without Git mutations",
    fixtureScope.run(async () => {
      const f = await fixture();
      const result = await f.service.runRepositoryAction({
        projectId: f.project.id,
        context: { ...f.ref, revision: "00000000-0000-4000-8000-000000000001" },
        action: "publish",
      });
      expect(result.status).toBe("error");
      expect(
        f.calls.some(
          (c) => c.args.includes("push") || c.args.includes("fetch"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "base sync fast-forwards current branch during active base run",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      const next = await f.git(["rev-parse", "HEAD"]);
      await f.git(["reset", "--hard", old]);
      (f.service as unknown as { runList: Run[] }).runList = [
        { id: "active", projectId: f.project.id, status: "running" } as Run,
      ];
      expect((await f.action("sync", false)).status).toBe("success");
      expect(await f.git(["rev-parse", "HEAD"])).toBe(next);
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "upstream\n",
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "updates non-current base by CAS without touching current original files",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "main"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      const next = await f.git(["rev-parse", "HEAD"]);
      await f.git(["checkout", "-b", "unrelated", old]);
      await f.git(["update-ref", "refs/heads/main", old, next]);
      await fs.writeFile(path.join(f.repo, "base"), "dirty unrelated\n");
      expect((await f.action("update-base")).status).toBe("success");
      expect(await f.git(["rev-parse", "main"])).toBe(next);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
        "unrelated",
      );
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "dirty unrelated\n",
      );
      expect(
        f.calls.some(
          (c) =>
            c.cwd === f.repo &&
            c.args.includes("update-ref") &&
            c.args.includes(old),
        ),
      ).toBe(true);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "non-fast-forward base refuses without native update or destructive rollback",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      await f.git(["reset", "--hard", old]);
      await fs.writeFile(path.join(f.repo, "local-only"), "local\n");
      await f.git(["add", "."]);
      await f.git(["commit", "-m", "divergent"]);
      const head = await f.git(["rev-parse", "HEAD"]);
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(result.error).toMatch(/расхожд|разошл/i);
      expect(result.error).toMatch(/вручную/i);
      expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
      expect(
        f.calls.some(
          (c) =>
            c.args[0] === "topics" ||
            c.args.includes("reset") ||
            c.args.includes("--force"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["main^", "refs/tags/v1", "missing"])(
    "rejects unresolved or non-branch base %s without fetch",
    fixtureScope.run(async (base) => {
      const f = await fixture();
      f.config(`base_ref: ${base}`);
      expect((await f.action("update-base")).status).toBe("error");
      expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "rejects tag ambiguity and symbolic base",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["tag", "main"]);
      expect((await f.action("update-base")).status).toBe("error");
      await f.git(["tag", "-d", "main"]);
      await f.git(["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
      f.config("base_ref: alias");
      expect((await f.action("update-base")).status).toBe("error");
      expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["config", "original-fetch", "clone-fetch", "update"])(
    "stops at failing %s phase and preserves partial log",
    fixtureScope.run(async (phase) => {
      const f = await fixture();
      f.intercept(async (exe, args, cwd) => {
        if (
          (phase === "config" && exe === "FAKE-GOGA" && args[0] === "config") ||
          (phase === "original-fetch" &&
            cwd === f.repo &&
            args.includes("fetch")) ||
          (phase === "clone-fetch" &&
            cwd === f.owner.path &&
            args.includes("fetch")) ||
          (phase === "update" && exe === "FAKE-GOGA" && args[0] === "topics")
        )
          throw Error("Synthetic phase failure");
      });
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(result.log).toContain("Synthetic phase failure");
      if (phase !== "update")
        expect(
          f.calls.some((c) => c.exe === "FAKE-GOGA" && c.args[0] === "topics"),
        ).toBe(false);
      if (["clone-fetch", "update"].includes(phase))
        expect(result.log).toMatch(/Базовая ветка main обновлена/);
      if (phase === "config")
        expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "refuses moved endpoint between checks without publishing",
    fixtureScope.run(async () => {
      const f = await fixture();
      let checks = 0;
      f.intercept(async (_exe, args, cwd) => {
        if (
          cwd === f.repo &&
          args.includes("get-url") &&
          args.includes("--push") &&
          ++checks === 1
        )
          await f.git([
            "remote",
            "set-url",
            "origin",
            path.join(f.root, "other.git"),
          ]);
      });
      expect((await f.action("publish", false)).status).toBe("error");
      expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "returns sanitized native failure and output with environment secrets",
    fixtureScope.run(async () => {
      const f = await fixture();
      const settings = await f.service.readProjectSettings(f.project.id);
      await f.service.saveProjectSettings(
        f.project.id,
        {
          ...settings.value,
          env: [
            {
              key: "SYNTHETIC_SECRET",
              value: "fixture-secret-value",
              secret: true,
              runtime: true,
            },
          ],
        },
        settings.version,
      );
      f.intercept(async (exe, args) => {
        if (exe === "FAKE-GOGA" && args[0] === "topics")
          throw Error(
            "failed fixture-secret-value https://u:credential@example.invalid/x?token=tokenvalue",
          );
      });
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(JSON.stringify(result)).not.toMatch(
        /fixture-secret-value|credential|tokenvalue/,
      );
      expect(result.log).toContain("[скрыто]");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "queued action after shutdown returns error without Git mutation",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.service.dispose();
      f.calls.length = 0;
      expect((await f.action("publish")).status).toBe("error");
      expect(f.calls).toHaveLength(0);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "accepts a quoted literal null branch instead of confusing it with missing config",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "null", "main"]);
      await f.git(["branch", "--set-upstream-to=origin/main", "null"]);
      f.config('base_ref: "null"\nupdate: {strategy: custom-native-strategy}');
      expect((await f.action("update-base")).status).toBe("success");
      expect(
        f.calls.find((c) => c.exe === "FAKE-GOGA" && c.args[0] === "topics")
          ?.args,
      ).not.toContain("--strategy");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "ordinary manual sync remains available during an active topic run",
    fixtureScope.run(async () => {
      const f = await fixture();
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      expect((await f.service.syncTopicContext(f.ref)).status).toBe("synced");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "a failed first push prevents publication entirely",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw Error("fixture local push failure");
      });
      const result = await f.action("publish");
      expect(result.status).toBe("error");
      expect(
        f.calls.filter((c) => c.args.includes("push")).map((c) => c.cwd),
      ).toEqual([f.owner.path]);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "failed publication retains completed local sync",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.repo && args.includes("push"))
          throw Error("fixture server failure");
      });
      const result = await f.action("publish");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/Синхронизация топика завершена/);
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "refresh dirty conflict preserves original changes and does not update topic",
    fixtureScope.run(async () => {
      const f = await fixture();
      const old = await f.git(["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(f.repo, "base"), "upstream\n");
      await f.git(["commit", "-am", "upstream"]);
      await f.git(["push", "origin", "main"]);
      await f.git(["reset", "--hard", old]);
      await fs.writeFile(path.join(f.repo, "base"), "dirty\n");
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/overwritten by merge|local changes/i);
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "dirty\n",
      );
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "CAS refuses a concurrent non-current base change without overwriting it",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["checkout", "-b", "unrelated"]);
      const concurrent = await f.git(["rev-parse", "HEAD"], f.owner.path);
      await f.git(["fetch", f.owner.path, "alpha"]);
      f.intercept(async (_exe, args, cwd) => {
        if (
          cwd === f.repo &&
          args.includes("update-ref") &&
          args.includes("refs/heads/main")
        )
          await f.git(["update-ref", "refs/heads/main", concurrent]);
      });
      const result = await f.action("update-base");
      expect(result.status).toBe("error");
      expect(await f.git(["rev-parse", "main"])).toBe(concurrent);
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "actual Git mutation lock prevents refresh despite active-runs allowance",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo, ".git/index.lock"), "fixture lock");
      expect((await f.action("update-base")).status).toBe("error");
      expect(f.calls.some((c) => c.args[0] === "topics")).toBe(false);
      expect(
        await fs.readFile(path.join(f.repo, ".git/index.lock"), "utf8"),
      ).toBe("fixture lock");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "serializes header operations and stops remaining steps after shutdown",
    fixtureScope.run(async () => {
      const f = await fixture();
      let entered!: () => void, release!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.intercept(async (exe, args) => {
        if (exe === "FAKE-GOGA" && args[0] === "config") {
          entered();
          await barrier;
        }
      });
      const first = f.action("update-base");
      await pending;
      const second = f.action("publish");
      await f.service.dispose();
      release();
      expect((await first).status).toBe("error");
      expect((await second).status).toBe("error");
      expect(
        f.calls.some(
          (c) =>
            c.args.includes("push") ||
            c.args.includes("fetch") ||
            c.args[0] === "topics",
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "base sync preserves local commits ahead of upstream as already up-to-date",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(path.join(f.repo, "base"), "local ahead\n");
      await f.git(["commit", "-am", "ahead"]);
      const head = await f.git(["rev-parse", "HEAD"]);
      expect((await f.action("sync", false)).status).toBe("success");
      expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "manual retry remains available during active run",
    fixtureScope.run(async () => {
      const f = await fixture();
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw Error("temporary");
      });
      expect((await f.service.syncTopicContext(f.ref)).status).toBe("error");
      f.intercept(undefined);
      expect((await f.service.retryContextSync(f.ref)).status).toBe("synced");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "missing clone origin is an error, not an implicit remote configuration write",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["remote", "remove", "origin"], f.owner.path);
      expect((await f.action("publish")).status).toBe("error");
      expect(
        f.calls.some(
          (c) =>
            c.args.includes("push") ||
            (c.args.includes("add") && c.args.includes("origin")),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "quick sync preserves actual cannot-lock-ref diagnostics",
    fixtureScope.run(async () => {
      const f = await fixture();
      await fs.writeFile(
        path.join(f.repo, ".git/refs/heads/alpha.lock"),
        "fixture lock",
      );
      const result = await f.action("sync");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(
        /cannot lock ref|unable to create.*alpha.lock/is,
      );
      expect(
        await fs.readFile(
          path.join(f.repo, ".git/refs/heads/alpha.lock"),
          "utf8",
        ),
      ).toBe("fixture lock");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "quick sync diagnostics redact secrets without storing raw output in sync state or journal",
    fixtureScope.run(async () => {
      const f = await fixture();
      const settings = await f.service.readProjectSettings(f.project.id);
      await f.service.saveProjectSettings(
        f.project.id,
        {
          ...settings.value,
          env: [
            {
              key: "SYNTHETIC_SECRET",
              value: "sync-fixture-secret",
              secret: true,
              runtime: true,
            },
          ],
        },
        settings.version,
      );
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw new CommandExitError(
            "generic failed command",
            1,
            "stdout sync-fixture-secret",
            "permission denied sync-fixture-secret https://user:credential@example.invalid/repo?token=tokenvalue",
          );
      });
      const result = await f.action("sync");
      expect(result.status).toBe("error");
      expect(result.log).toContain("permission denied");
      expect(result.log).toContain("stdout [скрыто]");
      expect(JSON.stringify(result)).not.toMatch(
        /sync-fixture-secret|credential|tokenvalue/,
      );
      const state = await f.service.topicSyncStatus(f.ref);
      expect(JSON.stringify(state)).not.toMatch(
        /permission denied|stdout|sync-fixture-secret|credential|tokenvalue/,
      );
      const files = await fs.readdir(path.join(f.home, ".goga/desktop/sync"), {
        recursive: true,
      });
      for (const name of files) {
        const file = path.join(f.home, ".goga/desktop/sync", name);
        if ((await fs.stat(file)).isFile())
          expect(await fs.readFile(file, "utf8")).not.toMatch(
            /permission denied|stdout|sync-fixture-secret|credential|tokenvalue/,
          );
      }
    }),
    gitIntegrationBudget(15000),
  );
});
