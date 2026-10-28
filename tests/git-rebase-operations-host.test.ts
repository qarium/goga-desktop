import {
  startNativeHostOperation,
  afterNativeHostCommand,
} from "./helpers/native-host-operation";
import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
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
async function fixture(
  kind: "primary" | "managed",
  options: { secret?: string; reconciled?: boolean } = {},
) {
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
  let record =
    kind === "managed"
      ? await new CloneManager(home, runner).ensure(project, {
          projectId: project.id,
          year: "2026",
          topic: "feature",
          branch: "feature",
        })
      : null;
  // Install pre-existing owner/settings BEFORE the durable native receipt.
  // Changing either after start would correctly revoke continuation authority.
  if (options.secret) {
    const settings = await host.readProjectSettings(project.id);
    await host.saveProjectSettings(
      project.id,
      {
        ...settings.value,
        env: [
          {
            key: "FIXTURE_SECRET",
            value: options.secret,
            secret: true,
            runtime: false,
          },
        ],
      },
      settings.version,
    );
  }
  if (options.reconciled && record) {
    record = await new CloneManager(home, runner).store.update(
      {
        ...record,
        revision: randomUUID(),
        state: "conflict",
        reason: "branch",
      },
      record.revision,
    );
  }
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
  await startNativeHostOperation(host, scope, {
    operation: "rebase",
    backend: "merge",
    source: (await git(root, ["rev-parse", "upstream-fixture"])).stdout.trim(),
  });
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
      native: {
        outcome: "completed",
        processSettled: true,
        verifiedUnrelatedData: true,
        recovery: "removed",
      },
      changed: true,
    });
    expect((await f.git(f.root, ["symbolic-ref", "HEAD"])).stdout).toBe(
      `refs/heads/${f.branch}\n`,
    );
    expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
      f.original,
    );
    expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
    await expect(f.host.executeGitRebaseOperation(p.token)).rejects.toThrow();
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
  });
  expect(r.native).toMatchObject({
    outcome: "uncertain",
    processSettled: true,
    afterHead: f.original,
    verifiedUnrelatedData: true,
    recovery: "retained",
  });
  // Completion is not durable until the OUTERMOST context has released.
  // Preserve both actual Git facts and the recovery fence after that failure.
  expect(r.recoveryPath).toBe(r.native?.recoveryPath);
  expect(r.recoveryPath).toBeTruthy();
  expect((await fs.stat(r.recoveryPath!)).isFile()).toBe(true);
  expect((await fs.stat(r.recoveryPath! + ".pending")).isFile()).toBe(true);
  const journalDir = path.join(f.home, ".goga/desktop/git-operations");
  const records = await Promise.all(
    (await fs.readdir(journalDir))
      .filter((name) => name.endsWith(".json"))
      .map(async (name) =>
        JSON.parse(await fs.readFile(path.join(journalDir, name), "utf8")),
      ),
  );
  expect(records).toHaveLength(1);
  expect(records[0].recovery).not.toBeNull();
  expect(
    (await f.git(f.root, ["symbolic-ref", "--short", "HEAD"])).stdout.trim(),
  ).toBe(f.branch);
  expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("none");
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
it("redacts partial-native diagnostics without discarding settled process facts", async () => {
  const secret = "fixture-secret-do-not-leak",
    f = await fixture("managed", { secret }),
    p = await f.prepare();
  const fault = afterNativeHostCommand(f.runner, "abort", async (result) => {
    // Replace legacy afterNative: preserve real process facts, inject a late
    // foreign marker and diagnostic before the final capture/verification.
    result.stderr = Buffer.concat([
      result.stderr,
      Buffer.from(`fixture diagnostic ${secret}\n`),
    ]);
    await fs.writeFile(path.join(f.root, ".git/BISECT_START"), "feature\n");
  });
  const r = await f.host.executeGitRebaseOperation(p.token);
  expect(fault.calls).toBe(1);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    native: {
      outcome: "uncertain",
      exitCode: 0,
      processSettled: true,
      recovery: "retained",
    },
  });
  expect(r.log).toContain("fixture diagnostic");
  expect(r.log).not.toContain(secret);
  expect(r.message).not.toContain(secret);
  expect(r.recoveryPath).toBeTruthy();
  const recovery = JSON.parse(await fs.readFile(r.recoveryPath!, "utf8"));
  expect(recovery.recovery.head).toBe(f.original);
  expect(recovery.state).toBe("uncertain");
  expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
    f.original,
  );
});
it("completes a reconciled conflict/branch owner without making ordinary admission ready", async () => {
  const f = await fixture("managed", { reconciled: true }),
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
    native: {
      outcome: "completed",
      processSettled: true,
      verifiedUnrelatedData: true,
      recovery: "removed",
    },
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
  expect(
    await f.host.executeGitRebaseOperation((await f.prepare()).token),
  ).toMatchObject({
    status: "success",
    native: { outcome: "completed", processSettled: true },
  });
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
  const fault = afterNativeHostCommand(f.runner, "abort", async () => {
    // Git already removed its metadata; no manual publication callback exists.
    await expect(
      fs.stat(path.join(f.root, ".git/rebase-merge")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(f.root, ".git/BISECT_START"), "feature\n");
  });
  const r = await f.host.executeGitRebaseOperation(p.token);
  expect(fault.calls).toBe(1);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    native: {
      outcome: "uncertain",
      exitCode: 0,
      processSettled: true,
      recovery: "retained",
    },
  });
  expect(
    (await f.git(f.root, ["symbolic-ref", "--short", "HEAD"])).stdout.trim(),
  ).toBe(f.branch);
  expect((await f.git(f.root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
    f.original,
  );
  expect(
    JSON.parse(await fs.readFile(r.recoveryPath!, "utf8")).recovery.head,
  ).toBe(f.original);
  await expect(f.host.executeGitRebaseOperation(p.token)).rejects.toThrow();
  expect(
    await fs.readFile(path.join(f.root, ".git/BISECT_START"), "utf8"),
  ).toBe("feature\n");
});
