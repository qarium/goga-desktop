import { startNativeHostOperation } from "./helpers/native-host-operation";
import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import { installGitFixtureScope } from "./helpers/git-test-scope";
import { gitIntegrationBudget } from "./helpers/git-integration";
const fixtureScope = installGitFixtureScope();
async function fixture(kind: "primary" | "managed", long = false) {
  const base = await fs.mkdtemp("/private/tmp/goga-rebase-apply-host-");
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
  // Keep the production finite deadline: a prepared ref transaction includes
  // all nested owner/snapshot checks, not just one short Git process.
  const rawRunner = new NodeRunner(undefined, env);
  fixtureScope().cancelOnTimeout(() => rawRunner.dispose());
  const runner = fixtureScope().own(rawRunner);
  fixtureScope().cleanup(() => runner.dispose());
  const git = (cwd: string, a: string[]) =>
    runner.command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
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
  const rawHost = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent/disabled",
  });
  fixtureScope().cleanup(() => rawHost.dispose());
  const host = fixtureScope().own(rawHost);
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
    backend: "apply",
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

async function advanceSecond(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.host.executeGitRebaseOperation(
    (await f.prepare()).token,
  );
  expect(result, result.log).toMatchObject({
    status: "conflict",
    native: {
      outcome: "conflicts",
      processSettled: true,
      verifiedUnrelatedData: true,
    },
  });
}

describe.each(["primary", "managed"] as const)(
  "%s native apply host lifecycle",
  (kind) => {
    it(
      "continues the saved first solution without changing apply backend",
      fixtureScope.run(async () => {
        const f = await fixture(kind);
        const p = await f.prepare();
        expect(p.backend).toBe("apply");
        const r = await f.host.executeGitRebaseOperation(p.token);
        expect(r, r.log).toMatchObject({
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
        expect(
          await fs.readFile(
            path.join(f.root, ".git/rebase-apply/next"),
            "utf8",
          ),
        ).toBe("2\n");
        expect((await f.host.readGitWorkspace(f.scope)).operation).toBe(
          "rebase",
        );
      }),
      gitIntegrationBudget(45000),
    );
    it(
      "reads the next apply conflict and saves through the normal resolver",
      fixtureScope.run(async () => {
        const f = await fixture(kind);
        await advanceSecond(f);
        const snapshot = await f.host.readGitWorkspace(f.scope);
        const req = {
          scope: f.scope,
          revision: snapshot.revision,
          path: "second",
        };
        const doc = await f.host.readGitConflict(req);
        expect(doc.incoming.text).toBe("second topic\n");
        const p = await f.host.prepareGitConflictSave({
          ...req,
          fingerprint: doc.fingerprint,
          resolution: { kind: "text", text: "resolved second\n" },
        });
        const r = await f.host.executeGitConflictSave(p.token);
        expect(r, r.log).toMatchObject({ status: "saved" });
      }),
      gitIntegrationBudget(60000),
    );
    it(
      "finishes and readmits the exact original owner without repairing registry/source",
      fixtureScope.run(async () => {
        const f = await fixture(kind);
        const sourceHead = (await f.git(f.source, ["rev-parse", "HEAD"]))
          .stdout;
        const registryPath = path.join(
          new CloneManager(f.home, f.runner).store.root,
          "registry.json",
        );
        const registry = f.record ? await fs.readFile(registryPath) : undefined;
        await advanceSecond(f);
        const resolutionSnapshot = await f.host.readGitWorkspace(f.scope);
        const req = {
          scope: f.scope,
          revision: resolutionSnapshot.revision,
          path: "second",
        };
        const doc = await f.host.readGitConflict(req);
        const saved = await f.host.executeGitConflictSave(
          (
            await f.host.prepareGitConflictSave({
              ...req,
              fingerprint: doc.fingerprint,
              resolution: { kind: "text", text: "resolved second\n" },
            })
          ).token,
        );
        expect(saved, saved.log).toMatchObject({ status: "saved" });
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
          lockRetained: false,
        });
        const snapshot = await f.host.readGitWorkspace(f.scope);
        expect(snapshot).toMatchObject({
          operation: "none",
          branch: f.branch,
        });
        if (f.record) {
          expect(await fs.readFile(registryPath)).toEqual(registry);
          expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
            sourceHead,
          );
        }
      }),
      gitIntegrationBudget(90000),
    );
  },
);
it.each(["primary", "managed"] as const)(
  "%s apply abort restores owner after a saved resolution",
  fixtureScope.run(async (kind) => {
    const f = await fixture(kind),
      beforeSource = (await f.git(f.source, ["rev-parse", "HEAD"])).stdout;
    const p = await f.host.prepareGitRebaseOperation({
      scope: f.scope,
      revision: (await f.host.readGitWorkspace(f.scope)).revision,
      action: "abort",
    });
    expect(p.backend).toBe("apply");
    expect(p.paths).toContain("file"); // Native preview exposes protected paths, not legacy publication deltas.
    expect(
      (await f.git(f.root, ["diff", "--cached", "--name-only"])).stdout.trim(),
    ).toBe("file");
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
    expect((await f.host.readGitWorkspace(f.scope)).branch).toBe(f.branch);
    expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      f.original,
    );
    expect(await fs.readFile(path.join(f.root, "file"), "utf8")).toBe(
      "topic\n",
    );
    expect(await fs.readFile(path.join(f.root, "second"), "utf8")).toBe(
      "second topic\n",
    );
    if (f.record)
      expect((await f.git(f.source, ["rev-parse", "HEAD"])).stdout).toBe(
        beforeSource,
      );
  }),
  gitIntegrationBudget(60000),
);
it(
  "does not admit a foreign detached clone owner",
  fixtureScope.run(async () => {
    const f = await fixture("managed");
    const before = await fs.readFile(path.join(f.root, ".git/index"));
    await expect(
      f.host.prepareGitRebaseOperation({
        scope: { ...(f.scope as object), branch: "another-owner" } as any,
        revision: (await f.host.readGitWorkspace(f.scope)).revision,
        action: "abort",
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(before);
  }),
  gitIntegrationBudget(45000),
);
