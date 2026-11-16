import { installGitFixtureScope } from "./helpers/git-test-scope";
import { gitIntegrationBudget } from "./helpers/git-integration";
const fixtureScope = installGitFixtureScope();
import {
  startNativeHostOperation,
  afterNativeHostCommand,
} from "./helpers/native-host-operation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import {createContinuationFixture,registerContinuationRoundtrips} from "./helpers/rebase-continuation-fixture";
const fixture=createContinuationFixture(fixtureScope);
registerContinuationRoundtrips(fixtureScope,["primary"]);
it.each(["primary", "managed"] as const)(
  "%s aborts a long rebase after saved resolution and returns to its original branch",
  fixtureScope.run(async (kind) => {
    const f = await fixture(kind, true);
    const p = await f.host.prepareGitRebaseOperation({
      scope: f.scope,
      action: "abort",
      revision: (await f.host.readGitWorkspace(f.scope)).revision,
    });
    const r = await f.host.executeGitRebaseOperation(p.token);
    expect(r, r.log).toMatchObject({
      status: "success",
      native: {
        outcome: "completed",
        processSettled: true,
        verifiedUnrelatedData: true,
        recovery: "removed",
      },
      lockRetained: false,
    });
    expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      f.original,
    );
    expect(await fs.readFile(path.join(f.root, "file"), "utf8")).toBe(
      "topic\n",
    );
    expect(await fs.readFile(path.join(f.root, "second"), "utf8")).toBe(
      "second topic\n",
    );
    expect((await f.host.readGitWorkspace(f.scope)).branch).toBe(f.branch);
  }),
  gitIntegrationBudget(30000),
);
it(
  "managed continuation refuses settings drift before execute without primary fallback",
  fixtureScope.run(async () => {
    const f = await fixture("managed"),
      p = await f.prepare(),
      before = await fs.readFile(path.join(f.root, ".git/index")),
      settings = await f.host.readProjectSettings(f.project.id);
    await f.host.saveProjectSettings(
      f.project.id,
      {
        ...settings.value,
        env: [
          ...settings.value.env,
          { key: "FIXTURE", value: "changed", secret: false, runtime: false },
        ],
      },
      settings.version,
    );
    await expect(f.host.executeGitRebaseOperation(p.token)).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(before);
  }),
  gitIntegrationBudget(30000),
);

it.each(["primary", "managed"] as const)(
  "reports %s post-native settings mismatch as uncertain without adopting a new owner",
  fixtureScope.run(async (kind) => {
    const f = await fixture(kind),
      p = await f.prepare(),
      settingsDir = path.join(f.home, ".goga/desktop/settings"),
      file = path.join(settingsDir, (await fs.readdir(settingsDir))[0]);
    const fault = afterNativeHostCommand(f.runner, "continue", async () => {
      // Native Git reached its next stop; change owner settings before final
      // capture, not at a now-removed manual metadata publication seam.
      await fs.writeFile(file, (await fs.readFile(file, "utf8")) + "\n");
    });
    const r = await f.host.executeGitRebaseOperation(p.token);
    expect(fault.calls).toBe(1);
    expect(r, r.log).toMatchObject({
      status: "uncertain",
      native: {
        outcome: "uncertain",
        exitCode: 1,
        processSettled: true,
        recovery: "retained",
      },
      lockRetained: false,
    });
    expect((await f.git(f.root, ["show", "HEAD:file"])).stdout).toBe(
      "resolved first\n",
    );
    expect(
      (
        await f.git(f.root, ["diff", "--name-only", "--diff-filter=U"])
      ).stdout.trim(),
    ).toBe("second");
    expect(
      JSON.parse(await fs.readFile(r.recoveryPath!, "utf8")).recovery.head,
    ).toBe(f.original);
    await expect(f.host.executeGitRebaseOperation(p.token)).rejects.toThrow();
    await expect(f.prepare()).rejects.toThrow();
  }),
  gitIntegrationBudget(30000),
);
