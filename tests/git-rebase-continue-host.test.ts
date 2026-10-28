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
async function fixture(kind: "primary" | "managed", long = false) {
  const base = await fs.mkdtemp("/private/tmp/goga-rebase-continue-host-");
  fixtureScope().cleanup(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    source = path.join(base, "source");
  await fs.mkdir(home);
  await fs.mkdir(source);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_NO_LAZY_FETCH: "1",
  };
  const runner = fixtureScope.runner(new NodeRunner(undefined, env));
  fixtureScope().cleanup(() => runner.dispose());
  const git = (cwd: string, a: string[]) =>
    runner.command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "commit.gpgsign=false",
        ...a,
      ],
      cwd,
      env,
    );
  await git(source, ["init", "-b", "main"]);
  for (const n of [
    "file",
    "second",
    ...(long ? ["clean-before", "clean-after"] : []),
  ])
    await fs.writeFile(path.join(source, n), "base\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "base"]);
  await git(source, ["branch", "feature"]);
  const host = fixtureScope().own(
    new HostService({
      home,
      dataDir: path.join(base, "data"),
      runner,
      goga: "/nonexistent/disabled",
    }),
  );
  fixtureScope().cleanup(() => host.dispose());
  const project = await host.addProject(source);
  const record =
    kind === "managed"
      ? await new CloneManager(home, runner).ensure(project, {
          projectId: project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : null;
  const root = record?.path ?? source,
    branch = record?.branch ?? "main",
    scope = record ? worktreeContextRef(record) : project.id;
  await git(root, ["checkout", "-b", "upstream-fixture"]);
  for (const n of ["file", "second"])
    await fs.writeFile(path.join(root, n), "upstream\n");
  await git(root, ["commit", "-am", "upstream"]);
  await git(root, ["checkout", branch]);
  await fs.writeFile(path.join(root, "file"), "topic\n");
  await git(root, ["commit", "-am", "topic"]);
  if (long) {
    await fs.writeFile(path.join(root, "clean-before"), "clean before\n");
    await git(root, ["commit", "-am", "clean before"]);
  }
  await fs.writeFile(path.join(root, "second"), "second topic\n");
  await git(root, ["commit", "-am", "second topic"]);
  if (long) {
    await fs.writeFile(path.join(root, "clean-after"), "clean after\n");
    await git(root, ["commit", "-am", "clean after"]);
  }
  const original = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await startNativeHostOperation(host, scope, {
    operation: "rebase",
    backend: "merge",
    source: (await git(root, ["rev-parse", "upstream-fixture"])).stdout.trim(),
  });
  await fs.writeFile(path.join(root, "file"), "resolved first\n");
  await git(root, ["add", "file"]);
  expect(
    (host as any).prepareGitRebaseOperation,
    "host operation admission is missing",
  ).toBeTypeOf("function");
  const prepare = async () =>
    host.prepareGitRebaseOperation({
      scope,
      action: "continue",
      revision: (await host.readGitWorkspace(scope)).revision,
    });
  return {
    base,
    home,
    source,
    root,
    record,
    scope,
    host,
    project,
    runner,
    git,
    prepare,
    original,
    branch,
  };
}

describe.each(["primary", "managed"] as const)(
  "native %s continuation roundtrip",
  (kind) => {
    let f: Awaited<ReturnType<typeof fixture>>,
      manager: CloneManager,
      registry: string,
      beforeRegistry: Buffer | null,
      sourceHead: string;
    beforeEach(
      fixtureScope.run(async () => {
        f = await fixture(kind);
        manager = new CloneManager(f.home, f.runner);
        registry = path.join(manager.store.root, "registry.json");
        beforeRegistry = f.record ? await fs.readFile(registry) : null;
        sourceHead = (await f.git(f.source, ["rev-parse", "HEAD"])).stdout;
      }),
      gitIntegrationBudget(30000),
    );

    async function phase0() {
      const r = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(r, r.log).toMatchObject({
        status: "conflict",
        native: {
          outcome: "conflicts",
          processSettled: true,
          verifiedUnrelatedData: true,
          recovery: "retained",
        },
      });
      expect(
        (
          await f.git(f.root, ["rev-parse", `refs/heads/${f.branch}`])
        ).stdout.trim(),
      ).toBe(f.original);
      if (f.record) {
        expect(await fs.readFile(registry)).toEqual(beforeRegistry);
        expect(await (manager as any).validate(f.record)).toMatchObject({
          state: "conflict",
          reason: "branch",
        });
        expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
          sourceHead,
        );
      }
    }
    async function phase1() {
      const snapshot = await f.host.readGitWorkspace(f.scope);
      expect(snapshot.operation).toBe("rebase");
      expect(snapshot.branch).toBe(null);
      const req = {
          scope: f.scope,
          revision: snapshot.revision,
          path: "second",
        },
        doc = await f.host.readGitConflict(req);
      expect(doc.incoming.text).toBe("second topic\n");
      const p = await f.host.prepareGitConflictSave({
        ...req,
        fingerprint: doc.fingerprint,
        resolution: { kind: "text", text: "resolved second\n" },
      });
      const r = await f.host.executeGitConflictSave(p.token);
      expect(r, r.log).toMatchObject({ status: "saved" });
      if (f.record) expect(await fs.readFile(registry)).toEqual(beforeRegistry);
    }
    async function phase2() {
      const r = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(r, r.log).toMatchObject({
        status: "success",
        native: {
          outcome: "completed",
          processSettled: true,
          verifiedUnrelatedData: true,
          recovery: "removed",
        },
      });
      expect((await f.git(f.root, ["symbolic-ref", "HEAD"])).stdout).toBe(
        `refs/heads/${f.branch}\n`,
      );
      if (f.record) {
        expect(await fs.readFile(registry)).toEqual(beforeRegistry);
        expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
          sourceHead,
        );
      }
    }
    it(
      "publishes the next stopped conflict on the exact original owner",
      fixtureScope.run(async () => {
        await phase0();
      }),
      gitIntegrationBudget(30000),
    );
    it(
      "reads the same stopped owner and saves a single-file resolution",
      fixtureScope.run(async () => {
        await phase0();
        await phase1();
      }),
      gitIntegrationBudget(60000),
    );
    it(
      "finishes with a second native continuation without repairing registry or source",
      fixtureScope.run(async () => {
        await phase0();
        await phase1();
        await phase2();
      }),
      gitIntegrationBudget(90000),
    );
  },
);
describe.each(["primary", "managed"] as const)(
  "%s four-pick continuation",
  (kind) => {
    let f: Awaited<ReturnType<typeof fixture>>, sourceHead: string;
    beforeEach(
      fixtureScope.run(async () => {
        f = await fixture(kind, true);
        sourceHead = (await f.git(f.source, ["rev-parse", "HEAD"])).stdout;
      }),
      gitIntegrationBudget(30000),
    );

    async function phase0() {
      const first = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(first, first.log).toMatchObject({
        status: "conflict",
        native: {
          outcome: "conflicts",
          processSettled: true,
          verifiedUnrelatedData: true,
          recovery: "retained",
        },
        lockRetained: false,
      });
      expect(
        (
          await f.git(f.root, ["rev-parse", `refs/heads/${f.branch}`])
        ).stdout.trim(),
      ).toBe(f.original);
      expect((await f.git(f.root, ["show", "HEAD:clean-before"])).stdout).toBe(
        "clean before\n",
      );
    }
    async function phase1() {
      const snapshot = await f.host.readGitWorkspace(f.scope);
      const req = {
        scope: f.scope,
        revision: snapshot.revision,
        path: "second",
      };
      const doc = await f.host.readGitConflict(req);
      const save = await f.host.prepareGitConflictSave({
        ...req,
        fingerprint: doc.fingerprint,
        resolution: { kind: "text", text: "resolved second\n" },
      });
      expect(await f.host.executeGitConflictSave(save.token)).toMatchObject({
        status: "saved",
      });
    }
    async function phase2() {
      const last = await f.host.executeGitRebaseOperation(
        (await f.prepare()).token,
      );
      expect(last, last.log).toMatchObject({
        status: "success",
        native: {
          outcome: "completed",
          processSettled: true,
          verifiedUnrelatedData: true,
          recovery: "removed",
        },
        lockRetained: false,
      });
      expect((await f.host.readGitWorkspace(f.scope)).branch).toBe(f.branch);
      expect((await f.git(f.root, ["show", "HEAD:clean-after"])).stdout).toBe(
        "clean after\n",
      );
      if (kind === "managed")
        expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
          sourceHead,
        );
    }
    it(
      "publishes the entire clean prefix before the next conflict",
      fixtureScope.run(async () => {
        await phase0();
      }),
      gitIntegrationBudget(30000),
    );
    it(
      "reads and saves the next conflict for the same owner",
      fixtureScope.run(async () => {
        await phase0();
        await phase1();
      }),
      gitIntegrationBudget(60000),
    );
    it(
      "finishes all remaining picks without modifying the source project",
      fixtureScope.run(async () => {
        await phase0();
        await phase1();
        await phase2();
      }),
      gitIntegrationBudget(90000),
    );
  },
);
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
