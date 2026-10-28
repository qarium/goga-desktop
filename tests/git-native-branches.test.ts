import { expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  NodeRunner,
  ByteCommandError,
  type ByteCommandResult,
} from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import {
  GitBranchActions,
  type GitBranchContext,
} from "../src/host/git-branches";
import { NativeGitMergeOperations } from "../src/host/git-native-merge";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { createNativeGitCapability } from "../src/host/git-native-context";
import type { GitBranchRequest } from "../src/shared/git-branches";
import { installGitFixtureScope } from "./helpers/git-test-scope";
import { gitIntegrationBudget } from "./helpers/git-integration";
const fixtureScope = installGitFixtureScope();
async function fixture(format = "sha1") {
  const base = await fs.mkdtemp("/private/tmp/goga-native-branch-");
  fixtureScope().cleanup(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo"),
    home = path.join(base, "home"),
    directory = path.join(base, "journal");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const rawRunner = new NodeRunner(10000, env);
  fixtureScope().cancelOnTimeout(() => rawRunner.dispose());
  const runner = fixtureScope().own(rawRunner);
  fixtureScope().cleanup(() => runner.dispose());
  const git = (args: string[], stdin?: string) =>
    runner.command(
      "git",
      ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
      root,
      env,
      stdin,
    );
  await git(["init", "-b", "main", `--object-format=${format}`]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(root, "a"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  const reader = new GitWorkspaceReader({
    root,
    scope: "p",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  let owner = "1",
    mutations = 0,
    fault: (() => Promise<void>) | undefined;
  let afterNative:
    | ((
        args: readonly string[],
        result: ByteCommandResult,
      ) => Promise<ByteCommandResult>)
    | undefined;
  const commands: string[][] = [];
  const journal = new NativeGitJournal({ directory });
  const ctx: GitBranchContext = {
    scope: "p",
    root,
    ownerKey: owner,
    verify: async () => {},
    snapshot: () => reader.snapshot(),
    git,
    remoteGit: git,
    native: createNativeGitCapability({
      root,
      journal,
      env,
      owner: async () => ({
        scope: "p",
        registryRevision: owner,
        projectPath: root,
      }),
      runner: {
        commandBytes: async (command) => {
          commands.push([...command.args]);
          if (
            command.args.some((v) =>
              ["branch", "switch", "merge", "fetch"].includes(v),
            )
          ) {
            mutations++;
            const [recordName] = (await fs.readdir(directory)).filter((v) =>
              v.endsWith(".json"),
            );
            const record = JSON.parse(
              await fs.readFile(path.join(directory, recordName), "utf8"),
            );
            expect(record.state).toBe("running");
            expect(record.recovery).not.toBeNull();
            await fault?.();
          }
          const result = await runner.commandBytes(command);
          return afterNative ? afterNative(command.args, result) : result;
        },
      },
    }),
  };
  let afterContext: (() => void) | undefined;
  const actions = new GitBranchActions({
    context: async (_id, fn) => {
      const result = await fn({ ...ctx, ownerKey: owner });
      afterContext?.();
      return result;
    },
  });
  const prepare = async (request: Record<string, unknown>) =>
    actions.prepare({
      ...request,
      projectId: "p",
      revision: (await actions.inventory("p")).revision,
    } as GitBranchRequest);
  const record = async () => {
    const [file] = (await fs.readdir(directory)).filter((v) =>
      v.endsWith(".json"),
    );
    return JSON.parse(await fs.readFile(path.join(directory, file), "utf8"));
  };
  return {
    root,
    git,
    afterContext: (fn: () => void) => {
      afterContext = fn;
    },
    prepare,
    actions,
    record,
    directory,
    ctx,
    reader,
    commands,
    afterNative: (fn: typeof afterNative) => {
      afterNative = fn;
    },
    mutations: () => mutations,
    owner: (v: string) => {
      owner = v;
    },
    fault: (f: () => Promise<void>) => {
      fault = f;
    },
  };
}
it(
  "native create journals before writing and preserves unrelated staged and working bytes",
  fixtureScope.run(async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "a"), "staged\n");
    await f.git(["add", "a"]);
    await fs.writeFile(path.join(f.root, "a"), "working\n");
    const index = (await f.git(["ls-files", "--stage", "-z"])).stdout;
    const preview = await f.prepare({
      action: "create",
      name: "new",
      switch: false,
    });
    await expect(fs.stat(f.directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "success",
    });
    expect(f.mutations()).toBe(1);
    expect((await f.git(["ls-files", "--stage", "-z"])).stdout).toBe(index);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("working\n");
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
  }),
  gitIntegrationBudget(15000),
);
it(
  "native switch uses Git's own HEAD/index locks and verifies selected branch",
  fixtureScope.run(async () => {
    const f = await fixture();
    await f.git(["branch", "other"]);
    const preview = await f.prepare({
      action: "switch-local",
      ref: "refs/heads/other",
    });
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "success",
    });
    expect((await f.git(["symbolic-ref", "HEAD"])).stdout.trim()).toBe(
      "refs/heads/other",
    );
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
    await expect(
      fs.stat(path.join(f.root, ".git/HEAD.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }),
  gitIntegrationBudget(15000),
);
it(
  "native branch confirmation refuses changed owner before any mutation",
  fixtureScope.run(async () => {
    const f = await fixture();
    const preview = await f.prepare({
      action: "create",
      name: "new",
      switch: false,
    });
    f.owner("2");
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(f.mutations()).toBe(0);
  }),
  gitIntegrationBudget(15000),
);
it(
  "unsettled native branch process retains recovery and blocks another attempt",
  fixtureScope.run(async () => {
    const f = await fixture();
    const preview = await f.prepare({
      action: "create",
      name: "new",
      switch: false,
    });
    f.fault(async () => {
      throw new ByteCommandError(
        "process-unsettled",
        false,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    });
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "uncertain",
      changed: true,
      recoveryPath: expect.any(String),
    });
    expect(await f.record()).toMatchObject({
      state: "uncertain",
      recovery: expect.any(Object),
    });
    await expect(
      f.prepare({ action: "create", name: "another", switch: false }),
    ).rejects.toThrow();
    expect(f.mutations()).toBe(1);
  }),
  gitIntegrationBudget(15000),
);
it(
  "foreign HEAD lock is neither ignored nor removed",
  fixtureScope.run(async () => {
    const f = await fixture();
    const preview = await f.prepare({
      action: "create",
      name: "new",
      switch: false,
    });
    await fs.writeFile(path.join(f.root, ".git/HEAD.lock"), "foreign");
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(await fs.readFile(path.join(f.root, ".git/HEAD.lock"), "utf8")).toBe(
      "foreign",
    );
    expect(f.mutations()).toBe(0);
  }),
  gitIntegrationBudget(15000),
);

async function mergeFixture(
  conflict = true,
  attributes = false,
  format = "sha1",
) {
  const f = await fixture(format);
  await fs.writeFile(path.join(f.root, "untouched"), "base\n");
  await f.git(["add", "."]);
  await f.git(["commit", "-m", "untouched"]);
  await f.git(["switch", "-c", "source"]);
  await fs.writeFile(
    path.join(f.root, conflict ? "a" : "incoming"),
    "source\n",
  );
  await f.git(["add", "."]);
  if (attributes) {
    await fs.writeFile(path.join(f.root, ".gitattributes"), "*.txt text\n");
    await f.git(["add", ".gitattributes"]);
  }
  await f.git(["commit", "-m", "source"]);
  await f.git(["switch", "main"]);
  if (conflict) {
    await fs.writeFile(path.join(f.root, "a"), "current\n");
    await f.git(["add", "."]);
    await f.git(["commit", "-m", "current"]);
  }
  await fs.writeFile(path.join(f.root, "untouched"), "local draft\n");
  const operations = new NativeGitMergeOperations({
    context: async (_scope, action) => action(f.ctx),
  });
  const start = async () =>
    f.actions.execute(
      (await f.prepare({ action: "merge", ref: "refs/heads/source" })).token,
    );
  const followup = async (action: "continue" | "abort") =>
    operations.prepare({
      scope: "p",
      revision: (await f.reader.snapshot()).revision,
      action,
    });
  return { ...f, start, followup, operations };
}
it(
  "native fast-forward is journalled and preserves unrelated dirty files",
  fixtureScope.run(async () => {
    const f = await mergeFixture(false);
    expect(await f.start()).toMatchObject({ status: "success" });
    expect(await fs.readFile(path.join(f.root, "untouched"), "utf8")).toBe(
      "local draft\n",
    );
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
  }),
  gitIntegrationBudget(15000),
);
it(
  "native merge conflict continues with Git's own message cleanup, without publishing manual metadata",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    expect(await f.start()).toMatchObject({ status: "conflict" });
    expect(await f.record()).toMatchObject({
      state: "conflicts",
      recovery: expect.any(Object),
      checkpoint: expect.any(Object),
    });
    await fs.writeFile(path.join(f.root, "a"), "resolved\n");
    await f.git(["add", "a"]);
    const preview = await f.followup("continue");
    expect(await f.operations.execute(preview.token)).toMatchObject({
      status: "success",
      native: {
        outcome: "completed",
        exitCode: 0,
        processSettled: true,
        verifiedUnrelatedData: true,
        recovery: "removed",
        beforeHead: preview.head,
      },
      retainedLocks: [],
      uncheckedLocks: [],
    });
    expect((await f.git(["log", "-1", "--format=%B"])).stdout).not.toContain(
      "# Conflicts:",
    );
    expect(
      (await f.git(["rev-list", "--parents", "-n", "1", "HEAD"])).stdout
        .trim()
        .split(" "),
    ).toHaveLength(3);
    expect(await fs.readFile(path.join(f.root, "untouched"), "utf8")).toBe(
      "local draft\n",
    );
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
    expect(
      (await fs.readdir(path.join(f.root, ".git"))).filter((v) =>
        v.startsWith("goga-"),
      ),
    ).toEqual([]);
  }),
  gitIntegrationBudget(15000),
);
it.each([false, true])(
  "native abort (resolved=%s) preserves unrelated data and leaves no artificial HEAD lock",
  fixtureScope.run(async (resolved) => {
    const f = await mergeFixture();
    const head = (await f.git(["rev-parse", "HEAD"])).stdout;
    expect(await f.start()).toMatchObject({ status: "conflict" });
    if (resolved) {
      await fs.writeFile(path.join(f.root, "a"), "resolved\n");
      await f.git(["add", "a"]);
    }
    const preview = await f.followup("abort");
    expect(await f.operations.execute(preview.token)).toMatchObject({
      status: "success",
      lockRetained: false,
      native: {
        outcome: "completed",
        exitCode: 0,
        processSettled: true,
        verifiedUnrelatedData: true,
        recovery: "removed",
        beforeHead: head.trim(),
        afterHead: head.trim(),
      },
      retainedLocks: [],
      uncheckedLocks: [],
    });
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("current\n");
    expect(await fs.readFile(path.join(f.root, "untouched"), "utf8")).toBe(
      "local draft\n",
    );
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
    await expect(
      fs.stat(path.join(f.root, ".git/HEAD.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }),
  gitIntegrationBudget(15000),
);
it(
  "late unrelated staged changes cannot be committed or lost by abort",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    await f.start();
    await fs.writeFile(path.join(f.root, "a"), "resolved\n");
    await f.git(["add", "a", "untouched"]);
    const index = (await f.git(["ls-files", "--stage", "-z"])).stdout;
    await expect(f.followup("continue")).rejects.toThrow(
      /staged|подготовлен|посторонн/i,
    );
    await expect(f.followup("abort")).rejects.toThrow(
      /staged|подготовлен|посторонн/i,
    );
    expect((await f.git(["ls-files", "--stage", "-z"])).stdout).toBe(index);
  }),
  gitIntegrationBudget(15000),
);
it(
  "an external merge cannot obtain Desktop provenance through a preview",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    await expect(f.git(["merge", "--no-edit", "source"])).rejects.toThrow();
    await expect(f.followup("abort")).rejects.toThrow(
      /происхождени|внешн|терминал/i,
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "a settled signing refusal stays unsuccessful but its sealed merge can be explicitly aborted",
  fixtureScope.run(async () => {
    const f = await mergeFixture(false);
    await fs.writeFile(path.join(f.root, "local"), "local\n");
    await f.git(["add", "local"]);
    await f.git(["commit", "-m", "diverge"]);
    await f.git(["config", "commit.gpgsign", "true"]);
    await f.git(["config", "gpg.program", "/usr/bin/false"]);
    expect(await f.start()).toMatchObject({ status: "uncertain" });
    expect(await f.record()).toMatchObject({
      state: "stopped",
      result: { processSettled: true },
    });
    await expect(f.followup("continue")).rejects.toThrow();
    expect(
      await f.operations.execute((await f.followup("abort")).token),
    ).toMatchObject({ status: "success" });
    expect(await fs.readFile(path.join(f.root, "untouched"), "utf8")).toBe(
      "local draft\n",
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "create-only snapshots do not execute a configured clean filter during status observation",
  fixtureScope.run(async () => {
    const f = await fixture();
    const marker = path.join(f.root, "filter-ran"),
      script = path.join(path.dirname(f.root), "filter.sh");
    await fs.writeFile(
      script,
      '#!/bin/sh\nprintf ran > "' + marker + '"\ncat\n',
      { mode: 0o700 },
    );
    await f.git(["config", "filter.fixture.clean", script]);
    await fs.writeFile(
      path.join(f.root, ".gitattributes"),
      "a filter=fixture\n",
    );
    await fs.writeFile(path.join(f.root, "a"), "edit\n");
    const preview = await f.prepare({
      action: "create",
      name: "metadata-only",
      switch: false,
    });
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "success",
    });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    // Positive control in this synthetic repo: a live status is capable of invoking
    // this filter; the operation's observation must stay with the admitted reader.
    await f.git(["status", "--porcelain=v2"]);
    expect(await fs.readFile(marker, "utf8")).toBe("ran");
  }),
  gitIntegrationBudget(15000),
);

it(
  "a completed clean journal does not block a fresh settings-owner revision",
  fixtureScope.run(async () => {
    const f = await fixture();
    expect(
      await f.actions.execute(
        (await f.prepare({ action: "create", name: "first", switch: false }))
          .token,
      ),
    ).toMatchObject({ status: "success" });
    f.owner("new settings revision");
    expect(
      await f.actions.execute(
        (await f.prepare({ action: "create", name: "second", switch: false }))
          .token,
      ),
    ).toMatchObject({ status: "success" });
  }),
  gitIntegrationBudget(15000),
);

it(
  "does not adopt a merge after HEAD switches to another existing branch at the same OID",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    await f.git(["branch", "same-oid"]);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    await f.git(["symbolic-ref", "HEAD", "refs/heads/same-oid"]);
    await expect(f.followup("abort")).rejects.toThrow();
    expect((await f.git(["symbolic-ref", "HEAD"])).stdout.trim()).toBe(
      "refs/heads/same-oid",
    );
  }),
  gitIntegrationBudget(15000),
);

it(
  "journals explicit fetch before starting it and preserves dirty files, index and HEAD",
  fixtureScope.run(async () => {
    const f = await fixture();
    const remote = path.join(path.dirname(f.root), "remote.git");
    await f.git(["init", "--bare", remote]);
    await f.git(["remote", "add", "origin", remote]);
    await f.git(["push", "origin", "main"]);
    await fs.writeFile(path.join(f.root, "a"), "staged\n");
    await f.git(["add", "a"]);
    await fs.writeFile(path.join(f.root, "a"), "working\n");
    const index = (await f.git(["ls-files", "--stage", "-z"])).stdout;
    const head = (await f.git(["rev-parse", "HEAD"])).stdout;
    const preview = await f.prepare({ action: "fetch" });
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "success",
    });
    expect(await f.record()).toMatchObject({
      operation: "fetch",
      state: "completed",
      recovery: null,
    });
    expect(f.mutations()).toBe(1);
    expect((await f.git(["ls-files", "--stage", "-z"])).stdout).toBe(index);
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("working\n");
  }),
  gitIntegrationBudget(15000),
);

it(
  "retains recovery and blocks another fetch after an unsettled native transport",
  fixtureScope.run(async () => {
    const f = await fixture();
    const remote = path.join(path.dirname(f.root), "remote.git");
    await f.git(["init", "--bare", remote]);
    await f.git(["remote", "add", "origin", remote]);
    const preview = await f.prepare({ action: "fetch" });
    f.fault(async () => {
      throw new ByteCommandError(
        "timeout",
        false,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    });
    expect(await f.actions.execute(preview.token)).toMatchObject({
      status: "uncertain",
    });
    expect(await f.record()).toMatchObject({
      state: "uncertain",
      result: { processSettled: false },
    });
    await expect(f.prepare({ action: "fetch" })).rejects.toThrow(/Журнал/);
    expect(f.mutations()).toBe(1);
  }),
  gitIntegrationBudget(15000),
);

async function remoteFixture() {
  const f = await fixture();
  const remote = path.join(path.dirname(f.root), "remote.git");
  await f.git(["init", "--bare", remote]);
  await f.git(["remote", "add", "origin", remote]);
  await f.git(["push", "-u", "origin", "main"]);
  await f.git(["switch", "-c", "incoming"]);
  await fs.writeFile(path.join(f.root, "remote-file"), "incoming\n");
  await f.git(["add", "."]);
  await f.git(["commit", "-m", "incoming"]);
  const incoming = (await f.git(["rev-parse", "HEAD"])).stdout.trim();
  await f.git(["push", "origin", "incoming:main", "incoming:feature"]);
  await f.git(["switch", "main"]);
  return { ...f, incoming };
}
it(
  "native pull journals fetch and fast-forward and preserves dirty staged bytes",
  fixtureScope.run(async () => {
    const f = await remoteFixture();
    await fs.writeFile(path.join(f.root, "a"), "staged\n");
    await f.git(["add", "a"]);
    await fs.writeFile(path.join(f.root, "a"), "working\n");
    const staged = (await f.git(["ls-files", "--stage", "a"])).stdout;
    const p = await f.prepare({ action: "pull" });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(f.mutations()).toBe(2);
    expect(await f.record()).toMatchObject({
      operation: "pull",
      state: "completed",
      recovery: null,
    });
    expect((await f.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(f.incoming);
    expect((await f.git(["ls-files", "--stage", "a"])).stdout).toBe(staged);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("working\n");
  }),
  gitIntegrationBudget(15000),
);
it(
  "native remote switch records exact tracking config and never fetches",
  fixtureScope.run(async () => {
    const f = await remoteFixture();
    const p = await f.prepare({
      action: "switch-remote",
      ref: "refs/remotes/origin/feature",
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(f.mutations()).toBe(3);
    expect(await f.record()).toMatchObject({
      operation: "switch",
      state: "completed",
      recovery: null,
    });
    expect((await f.git(["symbolic-ref", "HEAD"])).stdout.trim()).toBe(
      "refs/heads/feature",
    );
    expect((await f.git(["rev-parse", "@{upstream}"])).stdout.trim()).toBe(
      f.incoming,
    );
    expect(
      (await f.git(["config", "branch.feature.remote"])).stdout.trim(),
    ).toBe("origin");
    expect(
      (await f.git(["config", "branch.feature.merge"])).stdout.trim(),
    ).toBe("refs/heads/feature");
  }),
  gitIntegrationBudget(15000),
);
it(
  "a lost native pull transport blocks replay with original dirty recovery",
  fixtureScope.run(async () => {
    const f = await remoteFixture();
    await fs.writeFile(path.join(f.root, "a"), "working\n");
    const p = await f.prepare({ action: "pull" });
    f.fault(async () => {
      throw new ByteCommandError(
        "timeout",
        false,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "uncertain",
    });
    expect(await f.record()).toMatchObject({
      state: "uncertain",
      recovery: {
        files: [
          { path: "a", data: Buffer.from("working\n").toString("base64") },
        ],
      },
    });
    await expect(f.prepare({ action: "pull" })).rejects.toThrow(/Журнал/);
    expect(f.mutations()).toBe(1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "native remote switch refuses unexpected config additions before touching the worktree",
  fixtureScope.run(async () => {
    const f = await remoteFixture();
    const p = await f.prepare({
      action: "switch-remote",
      ref: "refs/remotes/origin/feature",
    });
    f.fault(async () => {
      if (f.mutations() === 2)
        await f.git([
          "config",
          "branch.feature.description",
          "external addition",
        ]);
    });
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({ status: "uncertain" });
    expect(result.recoveryPath).toBeTruthy();
    expect((await f.git(["symbolic-ref", "HEAD"])).stdout.trim()).toBe(
      "refs/heads/main",
    );
    await expect(
      fs.stat(path.join(f.root, "remote-file")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.mutations()).toBe(2);
    expect(await f.record()).toMatchObject({ state: "uncertain" });
    await expect(
      f.prepare({ action: "create", name: "forbidden-retry", switch: false }),
    ).rejects.toThrow(/Журнал/);
  }),
  gitIntegrationBudget(15000),
);
it(
  "native remote switch preserves a foreign config lock after partial branch creation",
  fixtureScope.run(async () => {
    const f = await remoteFixture();
    const p = await f.prepare({
      action: "switch-remote",
      ref: "refs/remotes/origin/feature",
    });
    f.fault(async () => {
      if (f.mutations() === 2)
        await fs.writeFile(path.join(f.root, ".git/config.lock"), "FOREIGN");
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "uncertain",
    });
    expect((await f.git(["symbolic-ref", "HEAD"])).stdout.trim()).toBe(
      "refs/heads/main",
    );
    expect(
      await fs.readFile(path.join(f.root, ".git/config.lock"), "utf8"),
    ).toBe("FOREIGN");
    expect(await f.record()).toMatchObject({
      state: "uncertain",
      result: { processSettled: true },
    });
    expect(f.mutations()).toBe(2);
  }),
  gitIntegrationBudget(15000),
);

// A tracked attributes update is repository data, not a change to the external
// policy. Dirty attributes and external sources remain part of admission.
it(
  "accepts .gitattributes introduced by native fast-forward",
  fixtureScope.run(async () => {
    const f = await mergeFixture(false, true);
    expect(await f.start()).toMatchObject({ status: "success" });
    expect(await fs.readFile(path.join(f.root, ".gitattributes"), "utf8")).toBe(
      "*.txt text\n",
    );
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
  }),
  gitIntegrationBudget(15000),
);
it.each(["continue", "abort"] as const)(
  "accepts native .gitattributes transition through merge %s",
  fixtureScope.run(async (action) => {
    const f = await mergeFixture(true, true);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    if (action === "continue") {
      await fs.writeFile(path.join(f.root, "a"), "resolved\n");
      await f.git(["add", "a"]);
    }
    const p = await f.followup(action);
    expect(await f.operations.execute(p.token)).toMatchObject({
      status: "success",
    });
    if (action === "continue")
      expect(
        await fs.readFile(path.join(f.root, ".gitattributes"), "utf8"),
      ).toBe("*.txt text\n");
    else
      await expect(
        fs.stat(path.join(f.root, ".gitattributes")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
  }),
  gitIntegrationBudget(15000),
);
it.each([".gitattributes", ".git/info/attributes", "nested/.gitattributes"])(
  "rejects external attributes drift after merge: %s",
  fixtureScope.run(async (name) => {
    const f = await mergeFixture(true, true);
    // Ensure a nested attributes dependency belongs to the observed path set.
    await fs.mkdir(path.join(f.root, "nested"));
    await fs.writeFile(path.join(f.root, "nested/file"), "baseline\n");
    await f.git(["add", "nested/file"]);
    await f.git(["commit", "-m", "nested"]);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    await fs.writeFile(path.join(f.root, name), "* -text\n");
    const head = (await f.git(["rev-parse", "HEAD"])).stdout;
    await expect(f.followup("abort")).rejects.toThrow();
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await fs.readFile(path.join(f.root, name), "utf8")).toBe(
      "* -text\n",
    );
    expect(await f.record()).toMatchObject({
      state: "conflicts",
      recovery: expect.any(Object),
    });
  }),
  gitIntegrationBudget(15000),
);
it.each(["continue", "abort"] as const)(
  "handles an original .gitattributes conflict with native %s",
  fixtureScope.run(async (action) => {
    const f = await mergeFixture(true, true);
    await fs.writeFile(path.join(f.root, ".gitattributes"), "*.txt -text\n");
    await f.git(["add", ".gitattributes"]);
    await f.git(["commit", "-m", "local attributes"]);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    if (action === "continue") {
      await fs.writeFile(path.join(f.root, "a"), "resolved\n");
      await fs.writeFile(path.join(f.root, ".gitattributes"), "*.txt text\n");
      await f.git(["add", "a", ".gitattributes"]);
    }
    const p = await f.followup(action);
    expect(await f.operations.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(await fs.readFile(path.join(f.root, ".gitattributes"), "utf8")).toBe(
      action === "continue" ? "*.txt text\n" : "*.txt -text\n",
    );
  }),
  gitIntegrationBudget(15000),
);
it(
  "accepts .gitattributes in a clean native merge commit",
  fixtureScope.run(async () => {
    const f = await mergeFixture(false, true);
    await fs.writeFile(path.join(f.root, "local"), "local\n");
    await f.git(["add", "local"]);
    await f.git(["commit", "-m", "local"]);
    expect(await f.start()).toMatchObject({ status: "success" });
    expect(
      (await f.git(["rev-list", "--parents", "-n", "1", "HEAD"])).stdout
        .trim()
        .split(" "),
    ).toHaveLength(3);
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
  }),
  gitIntegrationBudget(15000),
);
it(
  "external attributes changed during native merge retain recovery and block replay",
  fixtureScope.run(async () => {
    const f = await mergeFixture(false, true);
    f.fault(async () => {
      await fs.writeFile(
        path.join(f.root, ".git/info/attributes"),
        "* -text\n",
      );
    });
    expect(await f.start()).toMatchObject({
      status: "uncertain",
      recoveryPath: expect.any(String),
    });
    expect(await f.record()).toMatchObject({
      state: "uncertain",
      recovery: expect.any(Object),
    });
    await expect(
      f.prepare({ action: "merge", ref: "refs/heads/source" }),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "rejects a deleted or newly staged non-conflicting .gitattributes before follow-up",
  fixtureScope.run(async () => {
    const f = await mergeFixture(true, true);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    await fs.rm(path.join(f.root, ".gitattributes"));
    await expect(f.followup("abort")).rejects.toThrow();
    await fs.writeFile(path.join(f.root, ".gitattributes"), "* -text\n");
    await f.git(["add", ".gitattributes"]);
    await expect(f.followup("abort")).rejects.toThrow(/staged/);
  }),
  gitIntegrationBudget(15000),
);
it(
  "configured external attributes cannot be normalized as tracked repository data",
  fixtureScope.run(async () => {
    const f = await mergeFixture(false, true);
    await f.git([
      "config",
      "core.attributesFile",
      path.join(f.root, ".gitattributes"),
    ]);
    // The same path is explicitly a GLOBAL policy source in this case.
    expect(await f.start()).toMatchObject({
      status: "uncertain",
      recoveryPath: expect.any(String),
    });
  }),
  gitIntegrationBudget(15000),
);
it.each(["modify", "delete"] as const)(
  "accepts native %s of an existing nested .gitattributes",
  fixtureScope.run(async (mode) => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, "nested"));
    await fs.writeFile(
      path.join(f.root, "nested/.gitattributes"),
      "*.txt text\n",
    );
    await fs.writeFile(path.join(f.root, "nested/file.txt"), "data\n");
    await f.git(["add", "nested"]);
    await f.git(["commit", "-m", "initial attributes"]);
    await f.git(["switch", "-c", "source"]);
    if (mode === "modify")
      await fs.writeFile(
        path.join(f.root, "nested/.gitattributes"),
        "*.txt -text\n",
      );
    else await fs.rm(path.join(f.root, "nested/.gitattributes"));
    await f.git(["add", "nested/.gitattributes"]);
    await f.git(["commit", "-m", "change attributes"]);
    const target = (await f.git(["rev-parse", "HEAD"])).stdout;
    await f.git(["switch", "main"]);
    const p = await f.prepare({
      action: "merge",
      ref: "refs/heads/source",
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(target);
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
  }),
  gitIntegrationBudget(15000),
);
it(
  "rejects configured global attributes drift between merge and follow-up",
  fixtureScope.run(async () => {
    const f = await mergeFixture(true, true);
    const global = path.join(f.root, ".git/fixture-global-attributes");
    await fs.writeFile(global, "*.txt text\n");
    await f.git(["config", "core.attributesFile", global]);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    await fs.writeFile(global, "* -text\n");
    await expect(f.followup("abort")).rejects.toThrow();
    expect(await fs.readFile(global, "utf8")).toBe("* -text\n");
    expect(await f.record()).toMatchObject({
      state: "conflicts",
      recovery: expect.any(Object),
    });
  }),
  gitIntegrationBudget(15000),
);
it(
  "does not exempt an ignored attributes file removed from the index while resolving a conflict",
  fixtureScope.run(async () => {
    const f = await mergeFixture(true, true);
    await fs.writeFile(path.join(f.root, ".gitattributes"), "*.txt -text\n");
    await f.git(["add", ".gitattributes"]);
    await f.git(["commit", "-m", "local attributes"]);
    await fs.writeFile(
      path.join(f.root, ".git/info/exclude"),
      ".gitattributes\n",
    );
    expect(await f.start()).toMatchObject({ status: "conflict" });
    await fs.writeFile(path.join(f.root, "a"), "resolved\n");
    await f.git(["add", "a"]);
    await f.git(["rm", "--cached", "-f", ".gitattributes"]);
    await fs.writeFile(path.join(f.root, ".gitattributes"), "* -text\n");
    await expect(f.followup("continue")).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, ".gitattributes"), "utf8")).toBe(
      "* -text\n",
    );
  }),
  gitIntegrationBudget(15000),
);

it.each(["continue", "abort"] as const)(
  "a leftover REBASE_HEAD neither blocks a new journalled merge nor its %s",
  fixtureScope.run(async (action) => {
    const f = await mergeFixture();
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim();
    await f.git(["update-ref", "REBASE_HEAD", head]);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    if (action === "continue") {
      await fs.writeFile(path.join(f.root, "a"), "resolved\n");
      await f.git(["add", "a"]);
    }
    expect(
      await f.operations.execute((await f.followup(action)).token),
    ).toMatchObject({ status: "success" });
    expect((await f.git(["rev-parse", "REBASE_HEAD"])).stdout.trim()).toBe(
      head,
    );
    expect(await f.record()).toMatchObject({
      state: "completed",
      recovery: null,
    });
  }),
  gitIntegrationBudget(15000),
);

it(
  "native conflict file save preserves merge receipt and Desktop completion",
  fixtureScope.run(async () => {
    const { NativeGitConflictActions } =
      await import("../src/host/git-native-conflict-save");
    const { GitConflictReader } = await import("../src/host/git-conflicts");
    const f = await fixture();
    await f.git(["checkout", "-b", "incoming"]);
    await fs.writeFile(path.join(f.root, "a"), "incoming\n");
    await f.git(["commit", "-am", "incoming"]);
    await f.git(["checkout", "main"]);
    await fs.writeFile(path.join(f.root, "a"), "main\n");
    await f.git(["commit", "-am", "main"]);
    expect(
      await f.actions.execute(
        (await f.prepare({ action: "merge", ref: "refs/heads/incoming" }))
          .token,
      ),
    ).toMatchObject({ status: "conflict" });
    const parent = await f.record();
    const context = {
      ...f.ctx,
      isolatedGit: f.git,
      git: (args: string[], options?: { stdin?: string }) =>
        f.git(args, options?.stdin),
    };
    const bound = async <T>(
      _scope: unknown,
      fn: (c: typeof context) => Promise<T>,
    ) => fn(context);
    const reader = new GitConflictReader({ context: bound });
    const save = new NativeGitConflictActions({ context: bound });
    const doc = await reader.read({
      scope: "p",
      path: "a",
      revision: (await f.reader.snapshot()).revision,
    });
    const result = await save.execute(
      (
        await save.prepare({
          scope: "p",
          path: "a",
          revision: doc.revision,
          fingerprint: doc.fingerprint,
          resolution: { kind: "text", text: "resolved\n" },
        })
      ).token,
    );
    expect(result, result.log).toMatchObject({ status: "saved" });
    expect(await f.record()).toEqual(parent);
    const operations = new NativeGitMergeOperations({
      context: async (_scope, fn) => fn(f.ctx),
    });
    const p = await operations.prepare({
      scope: "p",
      action: "continue",
      revision: (await f.reader.snapshot()).revision,
    });
    expect(await operations.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "resolved\n",
    );
  }),
  gitIntegrationBudget(30000),
);

it(
  "native abort preserves a packed nested branch and restrictive index permissions",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    await f.git(["branch", "-m", "feature/nested"]);
    await f.git(["pack-refs", "--all"]);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    await fs.writeFile(path.join(f.root, "a"), "resolved\n");
    await f.git(["add", "a"]);
    await fs.chmod(path.join(f.root, ".git/index"), 0o600);
    const metadata = [
      "HEAD",
      "ORIG_HEAD",
      "logs/HEAD",
      "logs/refs/heads/feature/nested",
      "packed-refs",
    ];
    const permissions = await Promise.all(
      metadata.map(
        async (name) =>
          (await fs.stat(path.join(f.root, ".git", name))).mode & 0o777,
      ),
    );
    expect(
      await f.operations.execute((await f.followup("abort")).token),
    ).toMatchObject({ status: "success" });
    expect((await f.reader.snapshot()).branch).toBe("feature/nested");
    for (const [i, name] of metadata.entries()) {
      const mode =
        (await fs.stat(path.join(f.root, ".git", name))).mode & 0o777;
      expect(
        mode & ~permissions[i],
        `must not broaden permissions: ${name}`,
      ).toBe(0);
    }
    expect((await fs.stat(path.join(f.root, ".git/index"))).mode & 0o777).toBe(
      0o600,
    );
    expect(await fs.readFile(path.join(f.root, "untouched"), "utf8")).toBe(
      "local draft\n",
    );
  }),
  gitIntegrationBudget(15000),
);
it(
  "native abort completes a Desktop-owned SHA-256 merge and restores original data",
  fixtureScope.run(async () => {
    const f = await mergeFixture(true, false, "sha256");
    const head = (await f.reader.snapshot()).head;
    expect(head).toHaveLength(64);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    expect(
      await f.operations.execute((await f.followup("abort")).token),
    ).toMatchObject({
      status: "success",
      native: { afterHead: head, recovery: "removed" },
    });
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("current\n");
  }),
  gitIntegrationBudget(15000),
);
it(
  "native abort preserves effective gitdir-conditional configuration",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    await fs.writeFile(
      path.join(f.root, ".git/abort-policy"),
      "[core]\n autocrlf = false\n[fixture]\n abortpolicy = original-owner\n",
    );
    await f.git([
      "config",
      `includeIf.gitdir:${f.root}/.git.path`,
      "abort-policy",
    ]);
    expect(await f.start()).toMatchObject({ status: "conflict" });
    expect(
      await f.operations.execute((await f.followup("abort")).token),
    ).toMatchObject({ status: "success" });
    const command = f.commands.find((args) => args.includes("--abort"))!;
    expect(command).toContain("fixture.abortpolicy=original-owner");
    expect(command.some((arg) => arg.startsWith("includeif."))).toBe(false);
  }),
  gitIntegrationBudget(15000),
);
it(
  "native merge continuation pins an explicit message against request and preview mutation",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    expect(await f.start()).toMatchObject({ status: "conflict" });
    await fs.writeFile(path.join(f.root, "a"), "resolved\n");
    await f.git(["add", "a"]);
    const request = {
      scope: "p",
      action: "continue" as const,
      revision: (await f.reader.snapshot()).revision,
      message: "Confirmed merge",
    };
    const p = await f.operations.prepare(request);
    request.message = "request forgery";
    p.message = "preview forgery";
    p.action = "abort";
    p.paths.length = 0;
    p.root = "/forged";
    expect(await f.operations.execute(p.token)).toMatchObject({
      status: "success",
      action: "continue",
    });
    expect(
      (await f.git(["show", "-s", "--format=%B", "HEAD"])).stdout.trim(),
    ).toBe("Confirmed merge");
    expect(await fs.readFile(path.join(f.root, "untouched"), "utf8")).toBe(
      "local draft\n",
    );
  }),
  gitIntegrationBudget(15000),
);
it(
  "native merge continuation refuses unresolved conflicts before issuing a ticket",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    expect(await f.start()).toMatchObject({ status: "conflict" });
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    const mutations = f.mutations();
    await expect(f.followup("continue")).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(f.mutations()).toBe(mutations);
  }),
  gitIntegrationBudget(15000),
);
it(
  "native abort never upgrades a nonzero exit after actual restoration into success",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    expect(await f.start()).toMatchObject({ status: "conflict" });
    const p = await f.followup("abort");
    f.afterNative(async (args, result) =>
      args.includes("--abort")
        ? {
            ...result,
            exitCode: 1,
            stderr: Buffer.from("post-restore refusal"),
          }
        : result,
    );
    const result = await f.operations.execute(p.token);
    expect(result).toMatchObject({
      status: "uncertain",
      changed: true,
      native: {
        outcome: "uncertain",
        exitCode: 1,
        processSettled: true,
        recovery: "retained",
      },
    });
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("current\n");
    expect(await fs.readFile(path.join(f.root, "untouched"), "utf8")).toBe(
      "local draft\n",
    );
    expect(await f.record()).toMatchObject({
      state: "uncertain",
      recovery: expect.any(Object),
    });
    await expect(
      f.prepare({ action: "create", name: "another", switch: false }),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(30000),
);
it(
  "native merge requires the native capability without a legacy fallback",
  fixtureScope.run(async () => {
    const f = await mergeFixture();
    expect(await f.start()).toMatchObject({ status: "conflict" });
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    const head = (await f.reader.snapshot()).head;
    f.ctx.native = undefined;
    await expect(f.followup("abort")).rejects.toThrow();
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect((await f.reader.snapshot()).head).toBe(head);
  }),
  gitIntegrationBudget(15000),
);

it(
  "N8 branch outer cleanup preserves recovery and never exposes raw command diagnostics",
  fixtureScope.run(async () => {
    const f = await fixture();
    const p = await f.prepare({
      action: "create",
      name: "new-branch",
      switch: false,
    });
    f.afterNative(async (args, output) =>
      args.includes("branch")
        ? { ...output, stdout: Buffer.from("private-settings-value") }
        : output,
    );
    f.ctx.sanitizeDiagnostics = (text) =>
      text.replaceAll("private-settings-value", "[redacted]");
    f.afterContext(() => {
      throw Error("outer context failed");
    });
    const result = await f.actions.execute(p.token);
    expect(result.status).toBe("uncertain");
    expect(JSON.stringify(result)).not.toContain("private-settings-value");
    const record = await f.record();
    expect(record.recovery).not.toBeNull();
    await expect(
      f.ctx.native!.journal.assertAdmission(f.root, record.recovery.owner),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it(
  "N8 branch journal cleanup failure cannot be reported as success",
  fixtureScope.run(async () => {
    const f = await fixture();
    const p = await f.prepare({
      action: "create",
      name: "new-branch",
      switch: false,
    });
    const journal = f.ctx.native!.journal as any;
    const write = journal.write.bind(journal);
    vi.spyOn(journal, "write").mockImplementation(async (...args: any[]) => {
      if (args[1].recovery === null) throw Error("fixture-cleanup-failure");
      return write(...args);
    });
    const result = await f.actions.execute(p.token);
    expect(result.status).toBe("uncertain");
    const record = await f.record();
    expect(record.recovery).not.toBeNull();
    await expect(
      f.ctx.native!.journal.assertAdmission(f.root, record.recovery.owner),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
it.each(["abort", "continue"] as const)(
  "N8 merge %s retains recovery beyond outer owner release",
  fixtureScope.run(async (action) => {
    const f = await mergeFixture();
    await f.start();
    if (action === "continue") {
      await fs.writeFile(path.join(f.root, "a"), "resolved\n");
      await f.git(["add", "a"]);
    }
    let fail = false;
    const engine = new NativeGitMergeOperations({
      context: async (_scope, fn) => {
        const result = await fn(f.ctx);
        if (fail) throw Error("outer-owner-release");
        return result;
      },
    });
    const p = await engine.prepare({
      scope: "p",
      action,
      revision: (await f.reader.snapshot()).revision,
    });
    fail = true;
    await expect(engine.execute(p.token)).rejects.toThrow();
    const record = await f.record();
    expect(record.recovery).not.toBeNull();
    await expect(
      f.ctx.native!.journal.assertAdmission(f.root, record.recovery.owner),
    ).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
