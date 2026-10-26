import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { HostService } from "../src/host/service";
import { NodeRunner } from "../src/host/process";
import { CloneManager } from "../src/host/clones";
import { worktreeContextRef } from "../src/shared/worktrees";
import * as ownedLocks from "../src/host/owned-lock";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(kind: "primary" | "managed") {
  const base = await fs.mkdtemp("/private/tmp/goga-rebase-abort-host-");
  cleanup.push(() => fs.rm(base, { recursive: true, force: true }));
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
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = (cwd: string, a: string[]) =>
    runner.command(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...a],
      cwd,
      env,
    );
  await git(source, ["init", "-b", "main"]);
  await fs.writeFile(path.join(source, "file"), "base\n");
  await git(source, ["add", "."]);
  await git(source, ["commit", "-m", "base"]);
  await git(source, ["branch", "feature"]);
  const host = new HostService({
    home,
    dataDir: path.join(base, "data"),
    runner,
    goga: "/nonexistent/disabled",
  });
  cleanup.push(() => host.dispose());
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
  await fs.writeFile(path.join(root, "file"), "upstream\n");
  await git(root, ["commit", "-am", "upstream"]);
  await git(root, ["checkout", branch]);
  await fs.writeFile(path.join(root, "file"), "topic\n");
  await git(root, ["commit", "-am", "topic"]);
  const original = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  await expect(
    git(root, ["rebase", "--merge", "upstream-fixture"]),
  ).rejects.toThrow();
  expect(
    (host as any).prepareGitRebaseOperation,
    "host operation admission is missing",
  ).toBeTypeOf("function");
  const prepare = async () =>
    host.prepareGitRebaseOperation({
      scope,
      action: "abort",
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
it.each(["primary", "managed"] as const)(
  "admits exact %s owner and permits only intended reattachment",
  async (kind) => {
    const f = await fixture(kind),
      p = await f.prepare(),
      r = await f.host.executeGitRebaseOperation(p.token);
    expect(r).toMatchObject({
      status: "success",
      changed: true,
      metadataCleared: true,
      headPublished: true,
    });
    expect((await f.git(f.root, ["symbolic-ref", "HEAD"])).stdout).toBe(
      `refs/heads/${f.branch}\n`,
    );
    expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      f.original,
    );
    if (f.record)
      expect(
        (
          await f.git(f.source, ["rev-parse", "--abbrev-ref", "HEAD"])
        ).stdout.trim(),
      ).toBe("main");
  },
);
it("preserves completed abort facts if lifecycle release throws", async () => {
  const f = await fixture("managed"),
    p = await f.prepare();
  const acquire = ownedLocks.acquireOwnedLock;
  vi.spyOn(ownedLocks, "acquireOwnedLock").mockImplementation(
    async (file, opts) => {
      const lock = await acquire(file, opts);
      return {
        release: async () => {
          await lock.release();
          if (file.includes(".repository-"))
            throw Error("fixture lifecycle cleanup");
        },
      };
    },
  );
  const r = await f.host.executeGitRebaseOperation(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    headPublished: true,
    metadataCleared: true,
  });
  expect(r.recoveryPath).toBeTruthy();
  expect(r.log).toContain("fixture lifecycle cleanup");
});
it("rejects settings drift without primary fallback", async () => {
  const f = await fixture("managed"),
    p = await f.prepare(),
    before = await fs.readFile(path.join(f.root, ".git/index"));
  const settings = await f.host.readProjectSettings(f.project.id);
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
  expect(
    (
      await f.git(f.source, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).stdout.trim(),
  ).toBe("main");
});
it("binds both ownership files so a coherent nonce swap cannot reuse a ticket", async () => {
  const f = await fixture("managed"),
    p = await f.prepare();
  const { randomUUID } = await import("node:crypto"),
    store = new CloneManager(f.home, f.runner).store;
  const ownerFile = path.join(store.root, `.owner-${f.record!.contextId}.json`),
    owner = JSON.parse(await fs.readFile(ownerFile, "utf8")),
    nonce = randomUUID();
  await fs.writeFile(ownerFile, JSON.stringify({ ...owner, nonce }));
  await fs.writeFile(
    path.join(f.root, ".git/desktop-owner.json"),
    JSON.stringify({ contextId: f.record!.contextId, nonce }),
  );
  const before = await fs.readFile(path.join(f.root, ".git/index"));
  await expect(f.host.executeGitRebaseOperation(p.token)).rejects.toThrow();
  expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(before);
});
it("redacts partial-native diagnostics without discarding publication facts", async () => {
  const f = await fixture("managed"),
    secret = "fixture-secret-do-not-leak";
  const settings = await f.host.readProjectSettings(f.project.id);
  await f.host.saveProjectSettings(
    f.project.id,
    {
      ...settings.value,
      env: [
        { key: "FIXTURE_SECRET", value: secret, secret: true, runtime: false },
      ],
    },
    settings.version,
  );
  const p = await f.prepare(),
    engine = (f.host as any).gitRebaseOperations;
  engine.options.afterNative = () => {
    throw Error(`failure ${secret}`);
  };
  const r = await f.host.executeGitRebaseOperation(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    mutationStarted: true,
  });
  expect(r.log).not.toContain(secret);
  expect(r.message).not.toContain(secret);
  expect(r.recoveryPath).toBeTruthy();
});
it("completes a reconciled conflict/branch owner without making ordinary admission ready", async () => {
  const f = await fixture("managed"),
    manager = new CloneManager(f.home, f.runner);
  await expect(
    manager.resolve(f.scope as ReturnType<typeof worktreeContextRef>),
  ).rejects.toThrow();
  const record = (await manager.store.read()).records.find(
    (r) => r.contextId === f.record!.contextId,
  )!;
  expect(record).toMatchObject({ state: "conflict", reason: "branch" });
  const scope = worktreeContextRef(record),
    before = await fs.readFile(path.join(manager.store.root, "registry.json"));
  await expect(
    manager.verifyGitOperationOwner(scope, record),
  ).rejects.toThrow();
  const preview = await f.host.prepareGitRebaseOperation({
    scope,
    action: "abort",
    revision: (await f.host.readGitWorkspace(scope)).revision,
  });
  const r = await f.host.executeGitRebaseOperation(preview.token);
  expect(r).toMatchObject({
    status: "success",
    headPublished: true,
    metadataCleared: true,
  });
  expect(
    await fs.readFile(path.join(manager.store.root, "registry.json")),
  ).toEqual(before);
  expect(
    (await manager.store.read()).records.find(
      (r) => r.contextId === record.contextId,
    ),
  ).toEqual(record);
  await expect(
    manager.verifyGitOperationOwner(scope, record),
  ).resolves.toBeUndefined();
  await expect(
    manager.verifyGitOperationOwner(scope, { ...record, reason: undefined }),
  ).rejects.toThrow();
  await expect(manager.resolveGitRead(scope)).rejects.toThrow();
  await expect(f.host.readGitWorkspace(scope)).rejects.toThrow();
  expect(
    await fs.readFile(path.join(manager.store.root, "registry.json")),
  ).toEqual(before);
});

it("completion verifier refuses every active operation marker on an attached owner", async () => {
  const f = await fixture("managed"),
    manager = new CloneManager(f.home, f.runner);
  const admission = await manager.resolveGitRead(
    f.scope as ReturnType<typeof worktreeContextRef>,
  );
  await f.git(f.root, ["rebase", "--abort"]);
  await expect(
    manager.verifyGitOperationOwner(
      f.scope as ReturnType<typeof worktreeContextRef>,
      admission.record,
    ),
  ).resolves.toBeUndefined();
  const before = await fs.readFile(
    path.join(manager.store.root, "registry.json"),
  );
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "AUTO_MERGE",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "BISECT_START",
  ]) {
    const marker = path.join(f.root, ".git", name);
    await fs.writeFile(marker, `${f.original}\n`);
    try {
      await expect(
        manager.verifyGitOperationOwner(
          f.scope as ReturnType<typeof worktreeContextRef>,
          admission.record,
        ),
      ).rejects.toThrow();
    } finally {
      await fs.unlink(marker);
    }
  }
  expect(
    await fs.readFile(path.join(manager.store.root, "registry.json")),
  ).toEqual(before);
});
it("refuses late BISECT_START after managed operation metadata cleanup", async () => {
  const f = await fixture("managed"),
    p = await f.prepare();
  (f.host as any).gitRebaseOperations.options.afterPublish = (step: string) => {
    if (step === "metadata")
      writeFileSync(path.join(f.root, ".git/BISECT_START"), "feature\n");
  };
  const r = await f.host.executeGitRebaseOperation(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    headPublished: true,
    metadataCleared: true,
  });
  expect(
    await fs.readFile(path.join(f.root, ".git/BISECT_START"), "utf8"),
  ).toBe("feature\n");
});
