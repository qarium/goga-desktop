import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createOperationFixture,
  type OperationFixture,
} from "./helpers/git-operation-fixtures";
import {
  NodeRunner,
  CommandExitError,
  RunnerShutdownError,
} from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { GitUpdateHandoffCandidates } from "../src/host/git-update-handoff";
import { gitUpdateHandoffRequestSchema } from "../src/shared/git-update-handoff";
import type { ScopeRef } from "../src/shared/context";
const fixtures: OperationFixture[] = [],
  runners: NodeRunner[] = [];
afterEach(async () => {
  for (const r of runners.splice(0)) await r.dispose();
  for (const f of fixtures.splice(0)) await f.dispose();
});
async function setup(strategy = "merge", count = 3, conflictAt = [3]) {
  const f = await createOperationFixture("merge-rebase", {
    commits: count,
    conflictAt,
  });
  fixtures.push(f);
  await f.git(["rebase", "--abort"]);
  await fs.rm(path.join(f.root, "untracked"));
  const env = { ...f.env, GIT_ATTR_NOSYSTEM: undefined };
  const runner = new NodeRunner(10000, env);
  runners.push(runner);
  let scope: ScopeRef = "project",
    owner = "owner",
    config = `base_ref: main\nupdate:\n  strategy: ${strategy}\n`,
    now = 1000;
  const commands: string[][] = [];
  const git = async (a: string[]) => {
    commands.push(a);
    return runner.command("git", a, f.root, env);
  };
  const reader = () =>
    new GitWorkspaceReader({
      root: f.root,
      scope,
      verify: async () => {},
      git: async (a) => (await git(a)).stdout,
    });
  const c = {
    root: f.root,
    get scope() {
      return scope;
    },
    get ownerKey() {
      return owner;
    },
    git,
    isolatedGit: git,
    verify: async () => {},
    verifyOwner: async () => {},
    snapshot: () => reader().snapshot(),
    topicsConfig: async () => config,
  };
  const candidates = new GitUpdateHandoffCandidates({
    now: () => now,
    context: async (_scope, fn) => fn(c),
  });
  const input = {
    sourceRef: "refs/heads/main",
    targetBranch: "topic",
    baseRef: "main",
  };
  const failure = new CommandExitError(
    "opaque CLI failure",
    1,
    "",
    "no trusted diagnostic",
  );
  const capture = () => candidates.capture(c, input);
  const offer = async () =>
    candidates.afterFailure(c, await capture(), failure);
  const validate = async (candidateId: string) =>
    candidates.validate({
      candidateId,
      scope,
      revision: (await c.snapshot()).revision,
    });
  return {
    ...f,
    c,
    input,
    candidates,
    failure,
    capture,
    offer,
    validate,
    commands,
    setConfig: (v: string) => {
      config = v;
    },
    setOwner: (v: string) => {
      owner = v;
    },
    setScope: (v: ScopeRef) => {
      scope = v;
    },
    advance: () => {
      now += 300001;
    },
  };
}
async function disk(root: string): Promise<unknown> {
  return Promise.all(
    (await fs.readdir(root)).sort().map(async (name) => {
      const p = path.join(root, name),
        s = await fs.lstat(p);
      return [
        name,
        s.isDirectory()
          ? await disk(p)
          : (await fs.readFile(p)).toString("base64"),
      ];
    }),
  );
}
it("strict candidate request cannot smuggle source, root, strategy or commands", () => {
  const r = {
    scope: "project",
    revision: "a".repeat(64),
    candidateId: "b".repeat(64),
  };
  expect(gitUpdateHandoffRequestSchema.parse(r)).toEqual(r);
  for (const extra of [
    { root: "/tmp" },
    { source: "HEAD" },
    { strategy: "merge" },
    { command: "pull" },
  ])
    expect(
      gitUpdateHandoffRequestSchema.safeParse({ ...r, ...extra }).success,
    ).toBe(false);
});
for (const strategy of ["merge", "rebase", "ff-else-merge", "ff-else-rebase"]) {
  it(`${strategy}: independently proves conflict without touching live objects/index/refs/worktree`, async () => {
    const f = await setup(strategy),
      before = await disk(f.root);
    const candidate = await f.offer();
    expect(candidate).toMatchObject({
      scope: "project",
      targetBranch: "topic",
      targetHead: f.original,
      sourceOid: f.onto,
      strategy,
      algorithm: strategy.endsWith("rebase") ? "rebase" : "merge",
      conflicts: ["file-3"],
    });
    expect(candidate!.candidateId).toMatch(/^[a-f0-9]{64}$/);
    const validated = await f.validate(candidate!.candidateId);
    expect(validated.candidate).toEqual(candidate);
    expect(await disk(f.root)).toEqual(before);
    expect(f.commands.some((a) => a.includes("merge-tree"))).toBe(true);
    expect(
      f.commands.some((a) =>
        [
          "fetch",
          "push",
          "checkout",
          "switch",
          "reset",
          "merge",
          "rebase",
        ].some((cmd) => a.includes(cmd)),
      ),
    ).toBe(false);
  });
}
it("rebase checks replay, not just tip merge; a later topic revert still conflicts at the earlier pick", async () => {
  const f = await setup("rebase", 1, [1]);
  await f.write("file-1", "base\n");
  await f.git(["commit", "-am", "undo topic change"]);
  const candidate = await f.offer();
  expect(candidate?.algorithm).toBe("rebase");
  expect(candidate?.conflicts).toEqual(["file-1"]);
  // Tip merge is clean: topic tip has restored the common content.
  f.setConfig("base_ref: main\nupdate:\n  strategy: merge\n");
  expect(await f.offer()).toBeNull();
});
it("no candidate when arbitrary CLI failure has no independently proven conflict", async () => {
  const f = await setup();
  await f.git(["update-ref", "refs/heads/main", f.original]);
  expect(await f.offer()).toBeNull();
});
for (const failure of [
  new Error("conflict"),
  new RunnerShutdownError("interrupted"),
  new CommandExitError("conflict", null),
  new CommandExitError("conflict", 128),
]) {
  it(`unstructured/interrupted/fatal outcome is not a conflict candidate: ${failure.name}/${failure.message}`, async () => {
    const f = await setup(),
      attempt = await f.capture();
    expect(await f.candidates.afterFailure(f.c, attempt, failure)).toBeNull();
  });
}
for (const mutation of [
  "owner",
  "scope",
  "head",
  "source",
  "strategy",
  "worktree",
  "index",
  "operation",
  "expired",
]) {
  it(`refusal after ${mutation} changed cannot reuse the old attempt`, async () => {
    const f = await setup(),
      attempt = await f.capture();
    if (mutation === "owner") f.setOwner("other");
    if (mutation === "scope") f.setScope("other-project");
    if (mutation === "head")
      await f.git(["commit", "--allow-empty", "-m", "external"]);
    if (mutation === "source")
      await f.git(["update-ref", "refs/heads/main", f.original]);
    if (mutation === "strategy")
      f.setConfig("base_ref: main\nupdate:\n  strategy: rebase\n");
    if (mutation === "worktree") await f.write("untouched", "external\n");
    if (mutation === "index") {
      await f.write("untouched", "external\n");
      await f.git(["add", "untouched"]);
    }
    if (mutation === "operation")
      await fs.writeFile(path.join(f.root, ".git/MERGE_HEAD"), f.onto + "\n");
    if (mutation === "expired") f.advance();
    expect(await f.candidates.afterFailure(f.c, attempt, f.failure)).toBeNull();
  });
}
it("one pre-call attempt can only produce one candidate", async () => {
  const f = await setup(),
    attempt = await f.capture();
  expect(
    await f.candidates.afterFailure(f.c, attempt, f.failure),
  ).not.toBeNull();
  expect(await f.candidates.afterFailure(f.c, attempt, f.failure)).toBeNull();
  expect(await f.candidates.afterFailure(f.c, {}, f.failure)).toBeNull();
});
for (const mutation of ["owner", "source", "strategy", "expired"]) {
  it(`candidate validation rejects ${mutation} changes`, async () => {
    const f = await setup(),
      candidate = await f.offer();
    if (mutation === "owner") f.setOwner("other");
    if (mutation === "source")
      await f.git(["update-ref", "refs/heads/main", f.original]);
    if (mutation === "strategy")
      f.setConfig("base_ref: main\nupdate:\n  strategy: rebase\n");
    if (mutation === "expired") f.advance();
    await expect(f.validate(candidate!.candidateId)).rejects.toThrow();
  });
}
it("refuses checkout-free target without silently switching primary to it", async () => {
  const f = await setup();
  await f.git(["checkout", "main"]);
  const before = await disk(f.root);
  await expect(f.capture()).rejects.toThrow(/ветк|контекст/);
  expect(await disk(f.root)).toEqual(before);
});
it("does not capture an already started operation or a dirty worktree", async () => {
  const f = await setup();
  await f.write("untouched", "dirty\n");
  await expect(f.capture()).rejects.toThrow();
});
it("rejects unknown effective strategy instead of falling back to merge", async () => {
  const f = await setup("custom");
  await expect(f.capture()).rejects.toThrow(/стратег/);
});
it("default strategy is merge; malformed/duplicate YAML is refused", async () => {
  const f = await setup();
  f.setConfig("base_ref: main\n");
  expect((await f.offer())?.algorithm).toBe("merge");
  f.setConfig("base_ref: main\nbase_ref: other\n");
  await expect(f.capture()).rejects.toThrow();
});
it("source must be an explicit direct ref, not a revision expression or symbolic ref", async () => {
  const f = await setup();
  for (const sourceRef of [
    "HEAD",
    "main",
    "refs/heads/main~1",
    "--upload-pack=other",
  ])
    await expect(
      f.candidates.capture(f.c, { ...f.input, sourceRef }),
    ).rejects.toThrow();
  await f.git(["symbolic-ref", "refs/desktop/alias", "refs/heads/main"]);
  await expect(
    f.candidates.capture(f.c, { ...f.input, sourceRef: "refs/desktop/alias" }),
  ).rejects.toThrow();
});
it("rechecks ownership after the last asynchronous effective-config read", async () => {
  const f = await setup();
  const original = f.c.topicsConfig;
  let reads = 0;
  f.c.topicsConfig = async () => {
    const result = await original();
    if (++reads === 2) f.setOwner("changed-during-last-config-read");
    return result;
  };
  await expect(f.capture()).rejects.toThrow();
});
it("does not accept a physical file change during the last effective-config read", async () => {
  const f = await setup();
  const original = f.c.topicsConfig;
  let reads = 0;
  f.c.topicsConfig = async () => {
    const result = await original();
    if (++reads === 2) await f.write("untouched", "changed-late\n");
    return result;
  };
  await expect(f.capture()).rejects.toThrow();
});
it("does not invent a rebase conflict for a patch native Git will skip as already upstream", async () => {
  const f = await setup("rebase", 1, [1]);
  const base = (await f.git(["rev-parse", `${f.original}^`])).trim();
  await f.git(["update-ref", "refs/heads/main", base]);
  await f.git(["checkout", "main"]);
  await f.write("untouched", "upstream prefix\n");
  await f.git(["commit", "-am", "upstream prefix"]);
  await f.git(["cherry-pick", f.original]);
  await f.write("file-1", "later upstream change\n");
  await f.git(["commit", "-am", "later upstream"]);
  await f.git(["checkout", "topic"]);
  expect(await f.git(["cherry", "main", "topic"])).toMatch(/^-/);
  expect(await f.offer()).toBeNull();
  await f.git(["rebase", "--merge", "main"]);
  expect(await f.conflicts()).toEqual([]);
  expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(
    (await f.git(["rev-parse", "main"])).trim(),
  );
});
it("accepts Goga's atomic rewrite of byte-identical index only across the CLI refusal boundary", async () => {
  const f = await setup(),
    attempt = await f.capture();
  const index = path.join(f.root, ".git/index"),
    replacement = index + ".fixture";
  await fs.copyFile(index, replacement);
  await fs.rename(replacement, index);
  const candidate = await f.candidates.afterFailure(f.c, attempt, f.failure);
  expect(candidate).not.toBeNull();
  await f.validate(candidate!.candidateId);
  await fs.copyFile(index, replacement);
  await fs.rename(replacement, index);
  await expect(f.validate(candidate!.candidateId)).rejects.toThrow();
});
it("pins full topic identity and returns only detached display copies", async () => {
  const f = await setup();
  const scope = {
    projectId: "project",
    year: "2026",
    topic: "topic",
    branch: "topic",
    contextId: `ctx-${"a".repeat(64)}`,
    revision: "12345678-1234-4234-8234-123456789abc",
  };
  f.setScope(scope);
  const candidate = await f.offer();
  expect(candidate?.scope).toEqual(scope);
  candidate!.conflicts.push("forged");
  expect(
    (await f.validate(candidate!.candidateId)).candidate.conflicts,
  ).toEqual(["file-3"]);
  f.setScope({ ...scope, year: "2025" });
  await expect(f.validate(candidate!.candidateId)).rejects.toThrow();
});
for (const race of ["file", "expiry"]) {
  it(`checks ${race} again after the private conflict proof`, async () => {
    const f = await setup();
    const original = f.c.isolatedGit;
    let changed = false;
    f.c.isolatedGit = async (args) => {
      const result = await original(args).catch(async (error) => {
        if (args.includes("merge-tree") && !changed) {
          changed = true;
          if (race === "file") await f.write("untouched", "late proof edit\n");
          else f.advance();
        }
        throw error;
      });
      return result;
    };
    expect(await f.offer()).toBeNull();
    expect(changed).toBe(true);
  });
}
it("does not accept attributes or executable merge policy as a conflict proof", async () => {
  const f = await setup();
  await fs.writeFile(
    path.join(f.root, ".git/info/attributes"),
    "file-3 merge=union\n",
  );
  expect(await f.offer()).toBeNull();
  await fs.rm(path.join(f.root, ".git/info/attributes"));
  await f.git(["config", "merge.custom.driver", "false"]);
  await expect(f.capture()).rejects.toThrow();
});
it("supports topic-only artifact additions when independently proving an existing text conflict", async () => {
  const f = await setup("rebase");
  await fs.mkdir(path.join(f.root, ".goga/history/2026/topic"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(f.root, ".goga/history/2026/topic/todo.md"),
    "# Task\n",
  );
  await f.git(["add", ".goga"]);
  await f.git(["commit", "--amend", "--no-edit"]);
  expect((await f.offer())?.conflicts).toEqual(["file-3"]);
});
it("caps stored candidates without making evicted ids valid again", async () => {
  const f = await setup();
  const first = await f.offer();
  for (let i = 0; i < 8; i++) expect(await f.offer()).not.toBeNull();
  await expect(f.validate(first!.candidateId)).rejects.toThrow();
});

for (const strategy of ["merge", "rebase", "ff-else-merge", "ff-else-rebase"]) {
  it(`${strategy}: prepare is read-only; confirmation starts the exact native conflict once`, async () => {
    const f = await setup(strategy);
    const candidate = (await f.offer())!;
    const before = await disk(f.root);
    const preview = await f.candidates.prepare({
      candidateId: candidate.candidateId,
      scope: f.c.scope,
      revision: (await f.c.snapshot()).revision,
    });
    expect(preview).toMatchObject({
      candidate,
      hooks: "disabled",
      publishes: false,
    });
    expect(await disk(f.root)).toEqual(before);
    const result = await f.candidates.execute(preview.token);
    expect(result, result.log).toMatchObject({
      scope: f.c.scope,
      status: "conflict",
      changed: true,
      algorithm: candidate.algorithm,
      conflicts: ["file-3"],
    });
    expect(await f.conflicts()).toEqual(["file-3"]);
    if (candidate.algorithm === "merge") {
      expect(await f.git(["rev-parse", "MERGE_HEAD"])).toBe(`${f.onto}\n`);
      expect(await f.git(["rev-parse", "HEAD"])).toBe(`${f.original}\n`);
    } else {
      expect(
        await fs.readFile(path.join(f.root, ".git/rebase-merge/onto"), "utf8"),
      ).toBe(`${f.onto}\n`);
      expect(
        await fs.readFile(
          path.join(f.root, ".git/rebase-merge/orig-head"),
          "utf8",
        ),
      ).toBe(`${f.original}\n`);
    }
    const after = await disk(f.root);
    await expect(f.candidates.execute(preview.token)).rejects.toThrow();
    expect(await disk(f.root)).toEqual(after);
    expect(
      f.commands.some((a) => a.includes("push") || a.includes("fetch")),
    ).toBe(false);
  });
}
it("manual update confirmation cannot survive a worktree edit or be reused after rejection", async () => {
  const f = await setup();
  const candidate = (await f.offer())!;
  const preview = await f.candidates.prepare({
    candidateId: candidate.candidateId,
    scope: f.c.scope,
    revision: (await f.c.snapshot()).revision,
  });
  await f.write("file-1", "unsaved user change\n");
  const before = await disk(f.root);
  await expect(f.candidates.execute(preview.token)).rejects.toThrow();
  expect(await disk(f.root)).toEqual(before);
  await f.git(["restore", "file-1"]);
  await expect(f.candidates.execute(preview.token)).rejects.toThrow();
});
it("bisect is not eligible for a manual update", async () => {
  const f = await setup();
  await fs.writeFile(path.join(f.root, ".git/BISECT_START"), "topic\n");
  await expect(f.capture()).rejects.toThrow();
});

for (const change of [
  "expiry",
  "owner",
  "source",
  "config",
  "index",
] as const) {
  it(`manual start rejects ${change} after confirmation without mutation`, async () => {
    const f = await setup();
    const candidate = (await f.offer())!;
    const preview = await f.candidates.prepare({
      candidateId: candidate.candidateId,
      scope: f.c.scope,
      revision: (await f.c.snapshot()).revision,
    });
    if (change === "expiry") f.advance();
    if (change === "owner") f.setOwner("other");
    if (change === "source")
      await f.git(["update-ref", "refs/heads/main", f.original]);
    if (change === "config")
      f.setConfig("base_ref: main\nupdate:\n  strategy: rebase\n");
    if (change === "index") {
      const file = path.join(f.root, ".git/index");
      await fs.writeFile(`${file}.new`, await fs.readFile(file));
      await fs.rename(`${file}.new`, file);
    }
    const before = await disk(f.root);
    await expect(f.candidates.execute(preview.token)).rejects.toThrow();
    expect(await disk(f.root)).toEqual(before);
  });
}
for (const algorithm of ["merge", "rebase"]) {
  it(`${algorithm}: ambiguous native failure is not a conflict and never retries`, async () => {
    const f = await setup(algorithm);
    const candidate = (await f.offer())!;
    const preview = await f.candidates.prepare({
      candidateId: candidate.candidateId,
      scope: f.c.scope,
      revision: (await f.c.snapshot()).revision,
    });
    const git = f.c.isolatedGit;
    let attempts = 0;
    f.c.isolatedGit = async (args) => {
      if (args.includes(algorithm) && !args.includes("-h")) {
        attempts++;
        throw new RunnerShutdownError("interrupted");
      }
      return git(args);
    };
    const result = await f.candidates.execute(preview.token);
    expect(result).toMatchObject({
      status: "uncertain",
      changed: true,
      conflicts: [],
    });
    expect(attempts).toBe(1);
    expect((await f.c.snapshot()).operation).toBe("none");
  });
  it(`${algorithm}: tampering with index stages after native stop is not reported as a verified conflict`, async () => {
    const f = await setup(algorithm);
    const candidate = (await f.offer())!;
    const preview = await f.candidates.prepare({
      candidateId: candidate.candidateId,
      scope: f.c.scope,
      revision: (await f.c.snapshot()).revision,
    });
    const git = f.c.isolatedGit;
    f.c.isolatedGit = async (args) => {
      try {
        return await git(args);
      } catch (e) {
        if (args.includes(algorithm) && !args.includes("-h")) {
          await f.write("file-1", "external staged change\n");
          await f.git(["add", "file-1"]);
        }
        throw e;
      }
    };
    const result = await f.candidates.execute(preview.token);
    expect(result).toMatchObject({ status: "uncertain", changed: true });
    expect(await f.read("file-1")).toBe("external staged change\n");
  });
}
it("multiple previews of one candidate cannot start multiple operations", async () => {
  const f = await setup();
  const candidate = (await f.offer())!;
  const request = {
    candidateId: candidate.candidateId,
    scope: f.c.scope,
    revision: (await f.c.snapshot()).revision,
  };
  const a = await f.candidates.prepare(request),
    b = await f.candidates.prepare(request);
  await f.candidates.execute(a.token);
  const before = await disk(f.root);
  await expect(f.candidates.execute(b.token)).rejects.toThrow();
  expect(await disk(f.root)).toEqual(before);
});

it("source lock replaced during native start is retained and result is uncertain", async () => {
  const f = await setup();
  const candidate = (await f.offer())!;
  const preview = await f.candidates.prepare({
    candidateId: candidate.candidateId,
    scope: f.c.scope,
    revision: (await f.c.snapshot()).revision,
  });
  const git = f.c.isolatedGit;
  const lock = path.join(f.root, ".git/refs/heads/main.lock");
  f.c.isolatedGit = async (args) => {
    try {
      return await git(args);
    } catch (e) {
      if (args.includes("merge") && !args.includes("-h")) {
        await fs.unlink(lock);
        await fs.writeFile(lock, "external lock");
      }
      throw e;
    }
  };
  expect(await f.candidates.execute(preview.token)).toMatchObject({
    status: "uncertain",
    changed: true,
  });
  expect(await fs.readFile(lock, "utf8")).toBe("external lock");
});
it("ignored destination in an earlier clean replay pick blocks start", async () => {
  const f = await setup("rebase");
  // A new base-side path conflicts with a local ignored file before the later
  // text conflict. Preparing remains read-only; native rebase must not touch it.
  await f.git(["switch", "main"]);
  await f.write("incoming.txt", "base payload\n");
  await f.git(["add", "incoming.txt"]);
  await f.git(["commit", "-m", "base addition"]);
  await f.git(["switch", "topic"]);
  await fs.appendFile(
    path.join(f.root, ".git/info/exclude"),
    "\nincoming.txt\n",
  );
  await f.write("incoming.txt", "local ignored payload\n");
  const candidate = (await f.offer())!;
  expect(candidate).not.toBeNull();
  const preview = await f.candidates.prepare({
    candidateId: candidate.candidateId,
    scope: f.c.scope,
    revision: (await f.c.snapshot()).revision,
  });
  const before = await disk(f.root);
  await expect(f.candidates.execute(preview.token)).rejects.toThrow("вне Git");
  expect(await disk(f.root)).toEqual(before);
});

for (const tamper of ["tracked-worktree", "conflict-worktree", "todo"]) {
  it(`rebase start does not bless concurrent ${tamper} changes`, async () => {
    const f = await setup("rebase", 4, [3]);
    const candidate = (await f.offer())!;
    const preview = await f.candidates.prepare({
      candidateId: candidate.candidateId,
      scope: f.c.scope,
      revision: (await f.c.snapshot()).revision,
    });
    const git = f.c.isolatedGit;
    f.c.isolatedGit = async (args) => {
      try {
        return await git(args);
      } catch (e) {
        if (args.includes("rebase") && !args.includes("-h")) {
          if (tamper === "todo") {
            const file = path.join(f.root, ".git/rebase-merge/git-rebase-todo");
            await fs.writeFile(
              file,
              (await fs.readFile(file, "utf8")).replace(/^pick /m, "edit "),
            );
          } else
            await f.write(
              tamper === "tracked-worktree" ? "file-1" : "file-3",
              "external unsaved edit\n",
            );
        }
        throw e;
      }
    };
    const result = await f.candidates.execute(preview.token);
    expect(result).toMatchObject({ status: "uncertain", changed: true });
    if (tamper !== "todo")
      expect(
        await f.read(tamper === "tracked-worktree" ? "file-1" : "file-3"),
      ).toBe("external unsaved edit\n");
  });
}

it("rebase start suppresses executable hooks without changing their files", async () => {
  const f = await setup("rebase");
  const hook = path.join(f.root, ".git/hooks/pre-rebase"),
    marker = path.join(f.home, "hook-ran");
  const content = `#!/bin/sh\nprintf bad > '${marker}'\nexit 1\n`;
  await fs.writeFile(hook, content, { mode: 0o755 });
  const candidate = (await f.offer())!;
  const preview = await f.candidates.prepare({
    candidateId: candidate.candidateId,
    scope: f.c.scope,
    revision: (await f.c.snapshot()).revision,
  });
  expect(await f.candidates.execute(preview.token)).toMatchObject({
    status: "conflict",
  });
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(hook, "utf8")).toBe(content);
});
