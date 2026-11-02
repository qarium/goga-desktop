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

describe("native topic propagation", () => {
  it(
    "syncs then temporarily switches the original to topic and returns to the advanced base",
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
      await fs.writeFile(path.join(f.owner.path, "topic"), "dirty clone\n");
      const topicOid = await f.git(["rev-parse", "HEAD"], f.owner.path);
      f.intercept(async (exe, args, cwd) => {
        if (exe === "FAKE-GOGA") {
          expect(cwd).toBe(f.repo);
          expect(await f.git(["rev-parse", "refs/heads/alpha"])).toBe(topicOid);
          expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
            "alpha",
          );
          // Simulate the CLI advancing the base without checking it out.
          await f.git(["update-ref", "refs/heads/main", topicOid]);
        }
      });
      const result = await f.action("propagate");
      expect(result).toMatchObject({
        status: "success",
        action: "propagate",
        contextId: f.ref.contextId,
      });
      expect(result.log.indexOf("Переключение исходного проекта")).toBeLessThan(
        result.log.indexOf("Применение топика к базе:"),
      );
      const native = f.calls.filter((c) => c.exe === "FAKE-GOGA");
      expect(native).toEqual([
        {
          exe: "FAKE-GOGA",
          cwd: f.repo,
          args: ["topics", "--year", "2026", "propagate", "alpha", "-y"],
        },
      ]);
      const pushes = f.calls.filter((c) => c.args.includes("push"));
      expect(pushes.map((c) => c.cwd)).toEqual([f.owner.path]);
      expect(f.calls.indexOf(pushes[0])).toBeLessThan(
        f.calls.indexOf(native[0]),
      );
      expect(
        f.calls.some((c) =>
          c.args.some((arg) =>
            [
              "fetch",
              "merge",
              "checkout",
              "reset",
              "--force",
              "--publish",
            ].includes(arg),
          ),
        ),
      ).toBe(false);
      expect(await fs.readFile(path.join(f.owner.path, "topic"), "utf8")).toBe(
        "dirty clone\n",
      );
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
      expect(await f.git(["rev-parse", "HEAD"])).toBe(topicOid);
      expect(await fs.readFile(path.join(f.repo, "topic"), "utf8")).toBe(
        "topic\n",
      );
      const switches = f.calls.filter(
        (c) => c.cwd === f.repo && c.args.includes("switch"),
      );
      expect(switches.map((c) => c.args.at(-1))).toEqual(["alpha", "main"]);
      expect(f.calls.indexOf(pushes[0])).toBeLessThan(
        f.calls.indexOf(switches[0]),
      );
      expect(f.calls.indexOf(switches[0])).toBeLessThan(
        f.calls.indexOf(native[0]),
      );
      expect(f.calls.indexOf(native[0])).toBeLessThan(
        f.calls.indexOf(switches[1]),
      );
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["dirty", "running"])(
    "does not propagate when the original cannot safely switch: %s",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      if (mode === "dirty")
        await fs.writeFile(path.join(f.repo, "base"), "keep original edit\n");
      else
        (f.service as unknown as { runList: Run[] }).runList = [
          {
            id: "primary-active",
            projectId: f.project.id,
            status: "running",
          } as Run,
        ];
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("error");
      expect(result.log).toMatch(/Синхронизация топика завершена/);
      expect(f.calls.some((c) => c.exe === "FAKE-GOGA")).toBe(false);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      if (mode === "dirty")
        expect(await fs.readFile(path.join(f.repo, "base"), "utf8")).toBe(
          "keep original edit\n",
        );
      expect(
        f.calls.some((c) =>
          c.args.some((a) => ["reset", "stash", "--force"].includes(a)),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["success", "failure"])(
    "reports failed return without losing files or the CLI result: %s",
    fixtureScope.run(async (mode) => {
      const f = await fixture();
      f.intercept(async (exe) => {
        if (exe !== "FAKE-GOGA") return;
        await fs.writeFile(
          path.join(f.repo, "keep-during-command"),
          "do not discard\n",
        );
        if (mode === "failure")
          throw new CommandExitError(
            "fixture CLI failed",
            1,
            "CLI partial output",
            "CLI diagnostic",
          );
      });
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("error");
      expect(result.log).toMatch(/возврат|вернуть|возвращ/i);
      expect(result.log).toContain("main");
      expect(result.error).toMatch(/Не удалось вернуться.*main/);
      expect(result.log).toContain(
        mode === "failure" ? "CLI diagnostic" : "updated",
      );
      if (mode === "failure")
        expect(result.log).toContain("fixture CLI failed");
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("alpha");
      expect(
        await fs.readFile(path.join(f.repo, "keep-during-command"), "utf8"),
      ).toBe("do not discard\n");
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
      expect(
        f.calls.some((c) =>
          c.args.some((a) => ["reset", "stash", "--force"].includes(a)),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "does not overwrite an external branch selection during propagate",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["branch", "external"]);
      f.intercept(async (exe) => {
        if (exe === "FAKE-GOGA") await f.git(["switch", "external"]);
      });
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("error");
      expect(result.log).toMatch(/возврат|вернуть|возвращ/i);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("external");
      expect(
        f.calls
          .filter((c) => c.cwd === f.repo && c.args.includes("switch"))
          .map((c) => c.args.at(-1)),
      ).toEqual(["alpha"]);
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "reports a deleted original branch without recreating it",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (exe) => {
        if (exe === "FAKE-GOGA") await f.git(["branch", "-D", "main"]);
      });
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("error");
      expect(result.log).toMatch(/возврат|вернуть|возвращ/i);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("alpha");
      expect(await f.git(["for-each-ref", "refs/heads/main"])).toBe("");
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["lost-exit", "owner-changed-after-switch"])(
    "keeps uncertain native recovery and never invokes CLI or a return switch: %s",
    fixtureScope.run(async (fault) => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (cwd !== f.repo || !args.includes("switch")) return;
        await f.git(["switch", "alpha"]);
        if (fault === "lost-exit")
          throw new ByteCommandError(
            "timeout",
            true,
            Buffer.alloc(0),
            Buffer.from("synthetic lost exit"),
          );
        const store = new DesktopStateStore(f.home, path.join(f.root, "data"));
        const doc = await store.read(f.project.id);
        await store.save(
          f.project.id,
          { ...doc.value, executable: "CHANGED-GOGA" },
          doc.version,
        );
      });
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("error");
      expect(result.log).toMatch(/провер|восстановлен/i);
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("alpha");
      expect(
        f.calls.filter((c) => c.cwd === f.repo && c.args.includes("switch")),
      ).toHaveLength(1);
      expect(f.calls.some((c) => c.exe === "FAKE-GOGA")).toBe(false);
      const journal = path.join(f.home, ".goga/desktop/git-operations");
      const records = await fs.readdir(journal);
      const retained = await Promise.all(
        records
          .filter((name) => name.endsWith(".json"))
          .map(async (name) =>
            JSON.parse(await fs.readFile(path.join(journal, name), "utf8")),
          ),
      );
      expect(
        retained.some(
          (record) => record.state === "uncertain" && record.recovery,
        ),
      ).toBe(true);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "returns using the original project even when settings change during a failed CLI",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (exe) => {
        if (exe !== "FAKE-GOGA") return;
        const store = new DesktopStateStore(f.home, path.join(f.root, "data"));
        const doc = await store.read(f.project.id);
        await store.save(
          f.project.id,
          { ...doc.value, executable: "CHANGED-GOGA" },
          doc.version,
        );
        throw new CommandExitError(
          "synthetic command failed",
          1,
          "partial command result",
          "command diagnostic",
        );
      });
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("error");
      expect(result.log).toContain("command diagnostic");
      expect(result.log).toContain("Исходная ветка main восстановлена");
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "returns to the actual starting branch rather than the configured base",
    fixtureScope.run(async () => {
      const f = await fixture();
      await f.git(["switch", "-c", "workspace"]);
      const journal = path.join(f.home, ".goga/desktop/git-operations");
      const readRecord = async () => {
        const names = (await fs.readdir(journal)).filter((name) =>
          name.endsWith(".json"),
        );
        expect(names).toHaveLength(1); // The native journal has one slot per repository.
        return JSON.parse(
          await fs.readFile(path.join(journal, names[0]), "utf8"),
        );
      };
      let outwardId = "";
      f.intercept(async (exe) => {
        if (exe !== "FAKE-GOGA") return;
        expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("alpha");
        const outward = await readRecord();
        expect(outward).toMatchObject({ state: "completed", recovery: null });
        outwardId = outward.id;
      });
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("success");
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
        "workspace",
      );
      expect(
        f.calls
          .filter((c) => c.cwd === f.repo && c.args.includes("switch"))
          .map((c) => c.args.at(-1)),
      ).toEqual(["alpha", "workspace"]);
      const returned = await readRecord();
      expect(outwardId).not.toBe("");
      expect(returned).toMatchObject({ state: "completed", recovery: null });
      expect(returned.id).not.toBe(outwardId);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "does not claim restoration after a lost return-switch result",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (
          cwd !== f.repo ||
          !args.includes("switch") ||
          args.at(-1) !== "main"
        )
          return;
        await f.git(["switch", "main"]);
        throw new ByteCommandError(
          "timeout",
          true,
          Buffer.alloc(0),
          Buffer.alloc(0),
        );
      });
      const result = await f.action("propagate");
      expect(result.status, result.log).toBe("error");
      expect(result.error).toMatch(/Не удалось вернуться.*main/);
      expect(result.log).toContain("updated");
      expect(result.log).not.toContain("Исходная ветка main восстановлена");
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
      expect(
        f.calls.filter((c) => c.cwd === f.repo && c.args.includes("switch")),
      ).toHaveLength(2);
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
      const journal = path.join(f.home, ".goga/desktop/git-operations");
      const records = await Promise.all(
        (await fs.readdir(journal))
          .filter((name) => name.endsWith(".json"))
          .map(async (name) =>
            JSON.parse(await fs.readFile(path.join(journal, name), "utf8")),
          ),
      );
      expect(
        records.some(
          (record) => record.state === "uncertain" && record.recovery,
        ),
      ).toBe(true);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "rejects primary-only propagation without any command",
    fixtureScope.run(async () => {
      const f = await fixture();
      await expect(f.action("propagate", false)).rejects.toThrow(
        /топик|контекст/i,
      );
      expect(f.calls).toHaveLength(0);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "stops after failed local sync, preserving diagnostics without invoking Goga",
    fixtureScope.run(async () => {
      const f = await fixture();
      f.intercept(async (_exe, args, cwd) => {
        if (cwd === f.owner.path && args.includes("push"))
          throw new CommandExitError(
            "local sync failed",
            1,
            "local output",
            "local diagnostic",
          );
      });
      const result = await f.action("propagate");
      expect(result.status).toBe("error");
      expect(result.log).toContain("local diagnostic");
      expect(f.calls.some((c) => c.exe === "FAKE-GOGA")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "retains synced branch and bounded sanitized partial log on native failure, without fallback",
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
              value: "propagate-fixture-secret",
              secret: true,
              runtime: true,
            },
          ],
        },
        settings.version,
      );
      f.intercept(async (exe) => {
        if (exe === "FAKE-GOGA") {
          expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe(
            "alpha",
          );
          throw new CommandExitError(
            "native failed propagate-fixture-secret",
            1,
            "native partial output",
            "https://user:credential@example.invalid/path?token=tokenvalue",
          );
        }
      });
      const result = await f.action("propagate");
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/Синхронизация топика завершена/);
      expect(result.log).toContain("native partial output");
      expect(await f.git(["symbolic-ref", "--short", "HEAD"])).toBe("main");
      expect(
        f.calls
          .filter((c) => c.cwd === f.repo && c.args.includes("switch"))
          .map((c) => c.args.at(-1)),
      ).toEqual(["alpha", "main"]);
      expect(result.log.length).toBeLessThanOrEqual(65536);
      expect(JSON.stringify(result)).not.toMatch(
        /propagate-fixture-secret|credential|tokenvalue/,
      );
      expect(await f.git(["rev-parse", "alpha"])).toBe(
        await f.git(["rev-parse", "HEAD"], f.owner.path),
      );
      expect(f.calls.filter((c) => c.exe === "FAKE-GOGA")).toHaveLength(1);
      expect(
        f.calls.filter((c) => c.args.includes("push")).map((c) => c.cwd),
      ).toEqual([f.owner.path]);
      expect(
        f.calls.some(
          (c) => c.args.includes("merge") || c.args.includes("checkout"),
        ),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it(
    "rejects stale captured owner before any mutation or native invocation",
    fixtureScope.run(async () => {
      const f = await fixture();
      const result = await f.service.runRepositoryAction({
        projectId: f.project.id,
        context: { ...f.ref, revision: "00000000-0000-4000-8000-000000000001" },
        action: "propagate",
      });
      expect(result.status).toBe("error");
      expect(
        f.calls.some((c) => c.exe === "FAKE-GOGA" || c.args.includes("push")),
      ).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
  it.each(["branch", "settings", "owner"])(
    "rejects changed %s after sync before native invocation",
    fixtureScope.run(async (change) => {
      const f = await fixture();
      let changed = false;
      f.intercept(async (_exe, args, cwd) => {
        if (
          !changed &&
          cwd === f.repo &&
          args.includes("for-each-ref") &&
          args.includes("--format=%(refname)%00%(objectname)%00%(symref)") &&
          args.includes("refs/heads/alpha")
        ) {
          changed = true;
          if (change === "branch")
            await f.git([
              "update-ref",
              "refs/heads/alpha",
              await f.git(["rev-parse", "main"]),
            ]);
          if (change === "settings") {
            const state = new DesktopStateStore(
              f.home,
              path.join(f.root, "data"),
            );
            const settings = await state.read(f.project.id);
            await state.save(
              f.project.id,
              { ...settings.value, executable: "CHANGED-GOGA" },
              settings.version,
            );
          }
          if (change === "owner")
            await f.git(["checkout", "main"], f.owner.path);
        }
      });
      const result = await f.action("propagate");
      expect(changed).toBe(true);
      expect(result.status).toBe("error");
      expect(result.log).toMatch(/Синхронизация топика завершена/);
      expect(f.calls.some((c) => c.exe === "FAKE-GOGA")).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );
});
