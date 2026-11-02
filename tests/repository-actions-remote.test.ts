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

it.each([false, true])(
  "updates exact remote topic through original then clone (current original: %s)",
  fixtureScope.run(async (current) => {
    const f = await fixture();
    await f.git(["push", f.repo, "alpha:alpha"], f.owner.path);
    await f.git(["push", "origin", "alpha"]);
    if (current) await f.git(["checkout", "alpha"]);
    (f.service as unknown as { runList: Run[] }).runList = [
      {
        id: "active",
        projectId: f.project.id,
        context: f.ref,
        status: "running",
      } as Run,
    ];
    await fs.writeFile(path.join(f.owner.path, "remote-change"), "new");
    await f.git(["add", "."], f.owner.path);
    await f.git(["commit", "-m", "remote change"], f.owner.path);
    const next = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    await f.git(["reset", "--hard", "HEAD~1"], f.owner.path);
    await fs.writeFile(path.join(f.owner.path, "unrelated-dirty"), "keep");
    f.calls.length = 0;
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe("success");
    expect(await f.git(["rev-parse", "alpha"])).toBe(next);
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(next);
    expect(
      await fs.readFile(path.join(f.owner.path, "unrelated-dirty"), "utf8"),
    ).toBe("keep");
    const fetches = f.calls.filter((c) => c.args.includes("fetch"));
    expect(fetches.map((c) => c.cwd)).toEqual([f.repo, f.owner.path]);
    expect(
      fetches.every(
        (c) =>
          c.args.includes("origin") &&
          c.args.some((a) => a.startsWith("refs/heads/alpha:refs/desktop/")),
      ),
    ).toBe(true);
    expect(
      f.calls.some(
        (c) =>
          c.exe === "FAKE-GOGA" ||
          c.args.includes("push") ||
          c.args.includes("reset"),
      ),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it.each([
  "original-diverged",
  "clone-diverged",
  "overlap",
  "missing-branch",
  "wrong-head",
  "bad-origin",
  "ahead",
])(
  "remote refresh safely handles %s",
  fixtureScope.run(async (mode) => {
    const f = await fixture();
    await f.git(["push", f.repo, "alpha:alpha"], f.owner.path);
    await f.git(["push", "origin", "alpha"]);
    const initial = await f.git(["rev-parse", "alpha"]);
    if (mode === "ahead") {
      await f.git(
        [
          "update-ref",
          "refs/heads/alpha",
          await f.git(["rev-parse", "alpha^"]),
        ],
        f.remote,
      );
      f.calls.length = 0;
      const result = await f.action("update-remote");
      expect(result.status, result.log).toBe("success");
      expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(initial);
      return;
    }
    await fs.writeFile(path.join(f.owner.path, "topic"), "remote update\n");
    await f.git(["add", "."], f.owner.path);
    await f.git(["commit", "-m", "remote"], f.owner.path);
    const remoteOid = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    await f.git(["reset", "--hard", initial], f.owner.path);
    if (mode === "original-diverged" || mode === "clone-diverged") {
      const cwd = mode === "original-diverged" ? f.repo : f.owner.path;
      if (cwd === f.repo) await f.git(["checkout", "alpha"]);
      await fs.writeFile(path.join(cwd, "local"), "local");
      await f.git(["add", "."], cwd);
      await f.git(["commit", "-m", "diverged"], cwd);
    }
    if (mode === "overlap")
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty\n");
    if (mode === "missing-branch") await f.git(["push", f.remote, ":alpha"]);
    if (mode === "wrong-head")
      await f.git(["checkout", "-b", "wrong"], f.owner.path);
    if (mode === "bad-origin")
      await f.git(["remote", "set-url", "origin", f.remote], f.owner.path);
    const before = await f.git(["rev-parse", "HEAD"], f.owner.path);
    f.calls.length = 0;
    const result = await f.action("update-remote");
    if (mode === "missing-branch") {
      expect(result.status, result.log).toBe("success");
      expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(before);
      expect(
        f.calls.some((c) => c.cwd === f.repo && c.args.includes("fetch")),
      ).toBe(false);
      expect(f.calls.some((c) => c.args.includes("push"))).toBe(false);
      return;
    }
    expect(result.status, result.log).toBe("error");
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(before);
    expect(
      f.calls.some(
        (c) =>
          c.exe === "FAKE-GOGA" ||
          c.args.includes("push") ||
          c.args.includes("reset"),
      ),
    ).toBe(false);
    if (["original-diverged", "wrong-head", "bad-origin"].includes(mode))
      expect(
        f.calls.filter(
          (c) => c.cwd === f.owner.path && c.args.includes("fetch"),
        ),
      ).toHaveLength(0);
    else expect(await f.git(["rev-parse", "alpha"])).toBe(remoteOid);
  }),
  gitIntegrationBudget(15000),
);

it(
  "rejects checkout after captured HEAD before noncurrent CAS",
  fixtureScope.run(async () => {
    const f = await fixture();
    const old = await f.git(["rev-parse", "alpha"]);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    let armed = false,
      switched = false;
    f.intercept(async (_exe, args, cwd) => {
      if (armed && !switched) {
        switched = true;
        await f.git(["checkout", "alpha"]);
      }
      if (cwd === f.repo && args.includes("--symbolic-full-name")) armed = true;
    });
    const result = await f.action("update-remote");
    expect(switched).toBe(true);
    expect(result.status, result.log).toBe("error");
    expect(await f.git(["rev-parse", "alpha"])).toBe(old);
    expect(await f.git(["status", "--porcelain"])).toBe("");
    expect(
      f.calls.some(
        (c) =>
          c.args.includes("update-ref") && c.args.includes("refs/heads/alpha"),
      ),
    ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it.each([false, true])(
  "protects dirty checked-out original during remote refresh (overlap: %s)",
  fixtureScope.run(async (overlap) => {
    const f = await fixture();
    await f.git(["push", f.repo, "alpha:alpha"], f.owner.path);
    await f.git(["checkout", "alpha"]);
    const old = await f.git(["rev-parse", "alpha"]);
    await fs.writeFile(path.join(f.owner.path, "topic"), "remote\n");
    await f.git(["commit", "-am", "remote"], f.owner.path);
    await f.git(["push", f.remote, "alpha:alpha"], f.owner.path);
    const next = await f.git(["rev-parse", "HEAD"], f.owner.path);
    await f.git(["reset", "--hard", old], f.owner.path);
    const dirtyFile = overlap ? "topic" : "base";
    await fs.writeFile(path.join(f.repo, dirtyFile), "dirty\n");
    f.calls.length = 0;
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe(overlap ? "error" : "success");
    expect(await f.git(["rev-parse", "alpha"])).toBe(overlap ? old : next);
    expect(await fs.readFile(path.join(f.repo, dirtyFile), "utf8")).toBe(
      "dirty\n",
    );
    if (overlap)
      expect(
        f.calls.some((c) => c.cwd === f.owner.path && c.args.includes("fetch")),
      ).toBe(false);
  }),
  gitIntegrationBudget(15000),
);

it(
  "keeps clone commits ahead of the updated original without rollback",
  fixtureScope.run(async () => {
    const f = await fixture();
    const original = await f.git(["rev-parse", "alpha"]);
    await f.git(["push", "origin", "alpha"]);
    const clone = await f.git(["rev-parse", "HEAD"], f.owner.path);
    expect(clone).not.toBe(original);
    const result = await f.action("update-remote");
    expect(result.status, result.log).toBe("success");
    expect(await f.git(["rev-parse", "alpha"])).toBe(original);
    expect(await f.git(["rev-parse", "HEAD"], f.owner.path)).toBe(clone);
  }),
  gitIntegrationBudget(15000),
);

describe("explicit card propagation", () => {
  const request = (
    f: Awaited<ReturnType<typeof fixture>>,
    context = true,
    branch = "alpha",
    baseRef = "main",
  ) => ({
    projectId: f.project.id,
    action: "propagate" as const,
    ...(context ? { context: f.ref } : {}),
    propagation: {
      year: "2026",
      topic: branch
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
      branch,
      baseRef,
    },
  });
  const mutations = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.calls.filter(
      (c) =>
        c.exe === "FAKE-GOGA" ||
        c.args.includes("push") ||
        c.args.includes("checkout"),
    );
  it(
    "syncs captured clone then invokes exact selected base in original, preserving dirty files and config",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "release"]);
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty\n");
      (f.service as unknown as { runList: Run[] }).runList = [
        {
          id: "active",
          projectId: f.project.id,
          context: f.ref,
          status: "running",
        } as Run,
      ];
      const config = await fs.readFile(
        path.join(f.repo, ".git/config"),
        "utf8",
      );
      f.intercept(async (exe) => {
        if (exe === "FAKE-GOGA")
          expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
            "alpha",
          );
      });
      const result = await f.service.runRepositoryAction(
        request(f, true, "alpha", "release"),
      );
      expect(result.status, result.log).toBe("success");
      expect(
        mutations(f).map((c) => ({
          cwd: c.cwd,
          command: c.exe === "FAKE-GOGA" ? c.args : "push",
        })),
      ).toEqual([
        { cwd: f.owner.path, command: "push" },
        {
          cwd: f.repo,
          command: [
            "topics",
            "--year",
            "2026",
            "propagate",
            "alpha",
            "--base-ref",
            "release",
            "-y",
          ],
        },
      ]);
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(await fs.readFile(path.join(f.repo, ".git/config"), "utf8")).toBe(
        config,
      );
      expect(await fs.readFile(path.join(f.owner.path, "topic"), "utf8")).toBe(
        "dirty\n",
      );
      expect(
        f.calls.some(
          (c) => c.args.includes("--force") || c.args.includes("clone"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "temporarily switches an exact own local branch with no clone and returns without creating a clone",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "feature/Beta"]);
      const before = await f.service.listTopicContexts(f.project.id);
      f.calls.length = 0;
      f.intercept(async (exe) => {
        if (exe === "FAKE-GOGA")
          expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
            "feature/Beta",
          );
      });
      const result = await f.service.runRepositoryAction(
        request(f, false, "feature/Beta"),
      );
      expect(result.status, result.log).toBe("success");
      expect(mutations(f)).toEqual([
        {
          exe: "FAKE-GOGA",
          cwd: f.repo,
          args: [
            "topics",
            "--year",
            "2026",
            "propagate",
            "feature/Beta",
            "--base-ref",
            "main",
            "-y",
          ],
        },
      ]);
      expect(await f.service.listTopicContexts(f.project.id)).toEqual(before);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "does not switch when the original is already on the selected topic",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["switch", "-c", "feature/Beta"]);
      await fs.writeFile(
        path.join(f.repo, "base"),
        "keep existing topic edit\n",
      );
      const result = await f.service.runRepositoryAction(
        request(f, false, "feature/Beta"),
      );
      expect(result.status, result.log).toBe("success");
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
        "feature/Beta",
      );
      expect(
        f.calls.filter((c) => c.cwd === f.repo && c.args.includes("switch")),
      ).toHaveLength(0);
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
      expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
        "keep existing topic edit\n",
      );
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["year", "topic", "branch"])(
    "rejects a mismatching context %s",
    fixtureScope.run(async (key) => {
      const f = await fixture();
      const value = request(f);
      Object.assign(value.propagation, {
        [key]: key === "year" ? "2025" : "other",
      });
      await expect(f.service.runRepositoryAction(value)).rejects.toThrow();
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["ready", "missing", "ambiguous"])(
    "never falls back to primary for a registered %s owner",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      if (mode === "missing")
        await fs.rename(f.owner.path, `${f.owner.path}-removed`);
      if (mode === "ambiguous") {
        const file = path.join(f.home, ".goga/desktop/clones/registry.json");
        const registry = JSON.parse(await fs.readFile(file, "utf8"));
        registry.records.push({
          ...registry.records[0],
          contextId: `ctx-${"b".repeat(64)}`,
          path: `${f.owner.path}-other`,
        });
        await fs.writeFile(file, JSON.stringify(registry));
      }
      const result = await f.service.runRepositoryAction(request(f, false));
      expect(result.status, result.log).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each([
    "alpha",
    "missing",
    "main^",
    "--help",
    "/tmp/main",
    "refs/tags/main",
    "origin/main",
  ])(
    "rejects invalid selected destination %s",
    fixtureScope.run(async (base) => {
      const f = await fixture();
      const parsed = await f.service
        .runRepositoryAction(request(f, true, "alpha", base))
        .catch(() => ({ status: "error" }));
      expect(parsed.status).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each([
    "missing-origin",
    "tag-base",
    "symbolic-base",
    "wrong-topic",
    "missing-source",
  ])(
    "rejects invalid explicit identity or Git inputs: %s",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      await f.git(["branch", "beta"]);
      const value = request(f, false, "beta");
      if (mode === "missing-origin")
        await f.git(["remote", "remove", "origin"]);
      if (mode === "tag-base") await f.git(["tag", "main"]);
      if (mode === "symbolic-base") {
        await f.git(["symbolic-ref", "refs/heads/alias", "refs/heads/main"]);
        value.propagation.baseRef = "alias";
      }
      if (mode === "wrong-topic") value.propagation.topic = "wrong";
      if (mode === "missing-source") await f.git(["branch", "-D", "beta"]);
      const result = await f.service.runRepositoryAction(value);
      expect(result.status, result.log).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["source", "base", "owner"])(
    "rechecks %s after validation before no-clone command",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      await f.git(["branch", "beta"]);
      let checks = 0;
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.repo && args.includes("get-url") && ++checks === 1) {
          if (mode === "source" || mode === "base")
            await f
              .git([
                "update-ref",
                `refs/heads/${mode === "source" ? "beta" : "main"}`,
                await f.git(["rev-parse", "HEAD"], f.owner.path),
              ])
              .catch(async () => {
                await f.git(["fetch", f.owner.path, "alpha"]);
                await f.git([
                  "update-ref",
                  `refs/heads/${mode === "source" ? "beta" : "main"}`,
                  await f.git(["rev-parse", "HEAD"], f.owner.path),
                ]);
              });
          else {
            const file = path.join(
              f.home,
              ".goga/desktop/clones/registry.json",
            );
            const registry = JSON.parse(await fs.readFile(file, "utf8"));
            registry.records.push({
              ...registry.records[0],
              contextId: `ctx-${"c".repeat(64)}`,
              topic: "beta",
              branch: "beta",
              path: `${f.owner.path}-beta`,
            });
            await fs.writeFile(file, JSON.stringify(registry));
          }
        }
      });
      const result = await f.service.runRepositoryAction(
        request(f, false, "beta"),
      );
      expect(checks).toBeGreaterThan(0);
      expect(result.status, result.log).toBe("error");
      expect(mutations(f)).toEqual([]);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["source", "base", "owner", "origin"])(
    "stops after clone sync if %s changes before native publication",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      let synced = false,
        changed = false;
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push")) synced = true;
        else if (
          synced &&
          !changed &&
          cwd === f.repo &&
          args.includes("for-each-ref") &&
          args.includes("refs/heads/main")
        ) {
          changed = true;
          if (mode === "source")
            await f.git([
              "update-ref",
              "refs/heads/alpha",
              await f.git(["rev-parse", "main"]),
            ]);
          if (mode === "base")
            await f.git([
              "update-ref",
              "refs/heads/main",
              await f.git(["rev-parse", "alpha"]),
            ]);
          if (mode === "owner") await f.git(["checkout", "main"], f.owner.path);
          if (mode === "origin") await f.git(["remote", "remove", "origin"]);
        }
      });
      const result = await f.service.runRepositoryAction(request(f));
      expect(changed).toBe(true);
      expect(result.status, result.log).toBe("error");
      expect(result.log).toContain("Синхронизация топика завершена");
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toEqual([]);
      expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["sync", "native"])(
    "stops on %s failure with sanitized diagnostics and no fallback",
    fixtureScope.run(async (phase) => {
      const f = await fixture();
      f.intercept(async (exe, args) => {
        if (
          (phase === "sync" && args.includes("push")) ||
          (phase === "native" && exe === "FAKE-GOGA")
        )
          throw new CommandExitError(
            "fixture failure",
            1,
            "partial",
            "https://user:credential@example.invalid/?token=secret",
          );
      });
      const result = await f.service.runRepositoryAction(request(f));
      expect(result.status).toBe("error");
      expect(result.log).toContain("partial");
      expect(result.log).not.toMatch(/credential|token=secret/);
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(
        phase === "sync" ? 0 : 1,
      );
      expect(f.calls.filter((c) => c.args.includes("push"))).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
});
