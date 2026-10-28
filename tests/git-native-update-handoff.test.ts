import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createOperationFixture } from "./helpers/git-operation-fixtures";
import type { ScopeRef } from "../src/shared/context";
import { gitUpdateHandoffRequestSchema } from "../src/shared/git-update-handoff";
import {
  NodeRunner,
  CommandExitError,
  RunnerShutdownError,
  ByteCommandError,
} from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { createNativeGitCapability } from "../src/host/git-native-context";
import {
  NativeGitUpdateHandoff,
  type NativeGitUpdateContext,
} from "../src/host/git-native-update-handoff";
import { NativeGitSequence } from "../src/host/git-native-sequence";
import { NativeGitMergeOperations } from "../src/host/git-native-merge";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});
async function setup(strategy: string, commits = 1, conflictAt = [1]) {
  const f = await createOperationFixture("merge-rebase", {
    commits,
    conflictAt,
  });
  cleanup.push(f.dispose);
  await f.git(["rebase", "--abort"]);
  await fs.rm(path.join(f.root, "untracked"));
  const runner = new NodeRunner(10000, {
    ...f.env,
    GIT_ATTR_NOSYSTEM: undefined,
  });
  cleanup.push(() => runner.dispose());
  const git = (args: string[], stdin?: string) =>
    runner.command(
      "git",
      args,
      f.root,
      { ...f.env, GIT_ATTR_NOSYSTEM: undefined },
      stdin,
    );
  const reader = new GitWorkspaceReader({
    root: f.root,
    scope: "p",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  let now = Date.now(),
    owner = "fixture";
  let topics = `base_ref: main\nupdate:\n  strategy: ${strategy}\n`;
  const calls: string[][] = [];
  const planInspections: string[][] = [];
  let afterPublicRead: ((args: readonly string[]) => Promise<void>) | undefined;
  let beforeWrite: (() => Promise<void>) | undefined;
  let afterWrite: (() => Promise<void>) | undefined;
  const c: NativeGitUpdateContext = {
    root: f.root,
    scope: "p" as ScopeRef,
    ownerKey: "fixture",
    verify: async () => {},
    snapshot: async () => ({ ...(await reader.snapshot()), scope: c.scope }),
    git: (a: string[], o?: { stdin?: string }) => git(a, o?.stdin),
    topicsConfig: async () => topics,
    native: createNativeGitCapability({
      root: f.root,
      runner: {
        commandBytes: async (request) => {
          if (
            request.cwd === f.root &&
            (request.args.includes("merge") ||
              (request.args.includes("rebase") &&
                !request.args.includes("--edit-todo")))
          ) {
            calls.push([...request.args]);
            await beforeWrite?.();
          }
          if (request.args.includes("--edit-todo")) {
            const directory = path.join(f.home, "journal");
            const [name] = (await fs.readdir(directory)).filter((n) =>
              n.endsWith(".json"),
            );
            expect(
              JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))
                .state,
            ).toBe("running");
            planInspections.push([...request.args]);
          }
          const result = await runner.commandBytes(request);
          if (request.cwd === f.root) await afterPublicRead?.(request.args);
          if (
            request.cwd === f.root &&
            (request.args.includes("merge") ||
              (request.args.includes("rebase") &&
                !request.args.includes("--edit-todo")))
          ) {
            const fault = afterWrite;
            afterWrite = undefined;
            await fault?.();
          }
          return result;
        },
      },
      env: f.env,
      journal: new NativeGitJournal({
        directory: path.join(f.home, "journal"),
      }),
      owner: async () => ({
        scope: c.scope,
        registryRevision: owner,
        projectPath: f.root,
      }),
    }),
  };
  let afterContext: (() => void) | undefined;
  const handoff = new NativeGitUpdateHandoff({
    context: async (_s, fn) => {
      const result = await fn(c);
      afterContext?.();
      return result;
    },
    now: () => now,
  });
  const context = { ...c, git };
  const engine = strategy.endsWith("rebase")
    ? new NativeGitSequence({ context: async (_s, fn) => fn(context) })
    : new NativeGitMergeOperations({
        context: async (_s, fn) => fn(context),
      });
  const input = {
    targetBranch: "topic",
    sourceRef: "refs/heads/main",
    baseRef: "main",
  };
  return {
    ...f,
    afterContext: (fn: () => void) => {
      afterContext = fn;
    },
    c,
    reader,
    handoff,
    input,
    engine,
    runner,
    calls,
    planInspections,
    observeRead: (fn: (args: readonly string[]) => Promise<void>) => {
      afterPublicRead = fn;
    },
    afterNative: (fn: () => Promise<void>) => {
      afterWrite = fn;
    },
    fault: (fn: () => Promise<void>) => {
      beforeWrite = fn;
    },
    advance: () => {
      now += 300001;
    },
    owner: () => {
      owner = "changed";
    },
    config: (value: string) => {
      topics = value;
    },
  };
}
for (const strategy of ["merge", "rebase"] as const)
  for (const action of ["continue", "abort"] as const)
    it(`native handoff ${strategy} → ${action} preserves original recovery`, async () => {
      const f = await setup(strategy);
      const attempt = await f.handoff.captureAttempt(f.c, f.input);
      expect((await f.reader.snapshot()).operation).toBe("none");
      const candidate = await f.handoff.afterFailure(
        f.c,
        attempt,
        new CommandExitError("opaque", 1),
      );
      expect(candidate).toMatchObject({ algorithm: strategy, conflicts: [] });
      const p = await f.handoff.prepare({
        scope: "p",
        candidateId: candidate!.candidateId,
        revision: (await f.reader.snapshot()).revision,
      });
      expect(await f.handoff.execute(p.token)).toMatchObject({
        status: "conflict",
        native: {
          outcome: "conflicts",
          processSettled: true,
          recovery: "retained",
        },
      });
      if (action === "continue") {
        await f.write("file-1", "resolved\n");
        await f.git(["add", "file-1"]);
      }
      const request = {
        scope: "p",
        action,
        revision: (await f.reader.snapshot()).revision,
      };
      const next = await (f.engine instanceof NativeGitSequence
        ? f.engine.prepare({ ...request, operation: "rebase" })
        : f.engine.prepare(request));
      const result = await f.engine.execute(next.token);
      expect(strategy === "rebase" ? result : result).toMatchObject(
        strategy === "rebase"
          ? { outcome: "completed" }
          : { status: "success" },
      );
      await expect(f.handoff.execute(p.token)).rejects.toThrow();
    });
it("plain error and already-started external Goga rebase never grant manual start", async () => {
  const f = await setup("rebase");
  expect(
    await f.handoff.afterFailure(
      f.c,
      await f.handoff.captureAttempt(f.c, f.input),
      new Error("conflict"),
    ),
  ).toBeNull();
  const attempt = await f.handoff.captureAttempt(f.c, f.input);
  await expect(f.git(["rebase", "main"])).rejects.toThrow();
  expect(
    await f.handoff.afterFailure(
      f.c,
      attempt,
      new CommandExitError("conflict", 1),
    ),
  ).toBeNull();
});
it("source/config drift revokes a separately confirmed handoff", async () => {
  const f = await setup("rebase");
  const c = await f.handoff.afterFailure(
    f.c,
    await f.handoff.captureAttempt(f.c, f.input),
    new CommandExitError("opaque", 1),
  );
  const p = await f.handoff.prepare({
    scope: "p",
    candidateId: c!.candidateId,
    revision: (await f.reader.snapshot()).revision,
  });
  await f.git(["config", "merge.conflictStyle", "diff3"]);
  await expect(f.handoff.execute(p.token)).rejects.toThrow();
  expect((await f.reader.snapshot()).operation).toBe("none");
});
it.each(["merge", "rebase"] as const)(
  "%s handoff may complete cleanly; a refusal is not a prediction of conflict",
  async (strategy) => {
    const f = await setup(strategy);
    await f.write("file-1", "base\n");
    await f.write("separate", "topic-only\n");
    await f.git(["add", "file-1", "separate"]);
    await f.git(["commit", "--amend", "--no-edit"]);
    const c = await f.handoff.afterFailure(
      f.c,
      await f.handoff.captureAttempt(f.c, f.input),
      new CommandExitError("ordinary opaque refusal", 1),
    );
    expect(c).not.toBeNull();
    const p = await f.handoff.prepare({
      scope: "p",
      candidateId: c!.candidateId,
      revision: (await f.reader.snapshot()).revision,
    });
    expect(await f.handoff.execute(p.token)).toMatchObject({
      status: "success",
      native: {
        outcome: "completed",
        verifiedUnrelatedData: true,
        recovery: "removed",
      },
    });
    expect((await f.reader.snapshot()).operation).toBe("none");
  },
);
it("a failed Goga invocation that changes ignored bytes cannot offer an unchanged handoff", async () => {
  const f = await setup("rebase");
  const attempt = await f.handoff.captureAttempt(f.c, f.input);
  await f.write("ignored", "changed during Goga\n");
  expect(
    await f.handoff.afterFailure(
      f.c,
      attempt,
      new CommandExitError("opaque", 1),
    ),
  ).toBeNull();
  expect(await f.read("ignored")).toBe("changed during Goga\n");
});
it("manual rebase binds the configured apply backend rather than silently choosing merge", async () => {
  const f = await setup("rebase");
  await f.git(["config", "rebase.backend", "apply"]);
  const c = await f.handoff.afterFailure(
    f.c,
    await f.handoff.captureAttempt(f.c, f.input),
    new CommandExitError("opaque", 1),
  );
  expect(c).toMatchObject({ backend: "apply" });
  const p = await f.handoff.prepare({
    scope: "p",
    candidateId: c!.candidateId,
    revision: (await f.reader.snapshot()).revision,
  });
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "conflict",
  });
  expect(
    (await fs.stat(path.join(f.root, ".git/rebase-apply"))).isDirectory(),
  ).toBe(true);
});

async function disk(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(relative: string) {
    for (const entry of await fs.readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isSymbolicLink())
        result[name] = `link:${await fs.readlink(path.join(root, name))}`;
      else
        result[name] = (await fs.readFile(path.join(root, name))).toString(
          "base64",
        );
    }
  }
  await visit("");
  return result;
}
async function offer(f: Awaited<ReturnType<typeof setup>>) {
  const candidate = await f.handoff.afterFailure(
    f.c,
    await f.handoff.captureAttempt(f.c, f.input),
    new CommandExitError("opaque", 1),
  );
  expect(candidate).not.toBeNull();
  return candidate!;
}
async function preview(f: Awaited<ReturnType<typeof setup>>) {
  const candidate = await offer(f);
  return f.handoff.prepare({
    scope: f.c.scope,
    candidateId: candidate.candidateId,
    revision: (await f.c.snapshot()).revision,
  });
}

it("native candidate requests cannot smuggle source, root, strategy or commands", () => {
  const request = {
    scope: "p",
    revision: "a".repeat(64),
    candidateId: "b".repeat(64),
  };
  expect(gitUpdateHandoffRequestSchema.parse(request)).toEqual(request);
  for (const extra of [
    { root: "/tmp" },
    { source: "HEAD" },
    { strategy: "merge" },
    { command: "pull" },
  ])
    expect(
      gitUpdateHandoffRequestSchema.safeParse({ ...request, ...extra }).success,
    ).toBe(false);
});
it.each(["merge", "rebase", "ff-else-merge", "ff-else-rebase"])(
  "%s handoff capture and prepare are byte-read-only; confirmation starts exact source once",
  async (strategy) => {
    const f = await setup(strategy),
      before = await disk(f.root);
    const p = await preview(f);
    expect(p.candidate).toMatchObject({
      sourceOid: f.onto,
      targetHead: f.original,
      strategy,
      algorithm: strategy.endsWith("rebase") ? "rebase" : "merge",
      conflicts: [],
    });
    expect(await disk(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(await f.handoff.execute(p.token)).toMatchObject({
      status: "conflict",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toContain(f.onto);
    const after = await disk(f.root);
    await expect(f.handoff.execute(p.token)).rejects.toThrow();
    expect(await disk(f.root)).toEqual(after);
    expect(f.calls).toHaveLength(1);
  },
);
it.each([
  ["unstructured", new Error("conflict")],
  ["interrupted", new RunnerShutdownError("interrupted")],
  ["unconfirmed-exit", new CommandExitError("conflict", null)],
  ["fatal-exit-128", new CommandExitError("conflict", 128)],
] as const)(
  "native handoff rejects non-ordinary refusal %s",
  async (_label, failure) => {
    const f = await setup("merge"),
      before = await disk(f.root);
    const attempt = await f.handoff.captureAttempt(f.c, f.input);
    expect(await f.handoff.afterFailure(f.c, attempt, failure)).toBeNull();
    expect(
      await f.handoff.afterFailure(
        f.c,
        attempt,
        new CommandExitError("opaque", 1),
      ),
    ).toBeNull();
    expect(await disk(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
  },
);
const mutations = [
  "owner",
  "scope",
  "head",
  "source",
  "strategy",
  "worktree",
  "index",
  "operation",
  "expired",
] as const;
async function mutate(
  f: Awaited<ReturnType<typeof setup>>,
  mutation: (typeof mutations)[number],
) {
  if (mutation === "owner") f.owner();
  if (mutation === "scope") f.c.scope = "other-project";
  if (mutation === "head")
    await f.git(["commit", "--allow-empty", "-m", "external"]);
  if (mutation === "source")
    await f.git(["update-ref", "refs/heads/main", f.original]);
  if (mutation === "strategy")
    f.config("base_ref: main\nupdate:\n  strategy: rebase\n");
  if (mutation === "worktree" || mutation === "index") {
    await f.write("untouched", "external edit\n");
    if (mutation === "index") await f.git(["add", "untouched"]);
  }
  if (mutation === "operation")
    await fs.writeFile(path.join(f.root, ".git/MERGE_HEAD"), f.onto + "\n");
  if (mutation === "expired") f.advance();
}
it.each(mutations)(
  "native refusal after %s drift cannot reuse the captured attempt",
  async (mutation) => {
    const f = await setup("merge"),
      attempt = await f.handoff.captureAttempt(f.c, f.input);
    await mutate(f, mutation);
    const before = await disk(f.root);
    expect(
      await f.handoff.afterFailure(
        f.c,
        attempt,
        new CommandExitError("opaque", 1),
      ),
    ).toBeNull();
    expect(await disk(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
  },
);
it.each(["owner", "source", "strategy", "expired"] as const)(
  "native candidate validation rejects %s drift",
  async (mutation) => {
    const f = await setup("merge"),
      candidate = await offer(f);
    await mutate(f, mutation);
    const before = await disk(f.root);
    await expect(
      f.handoff.prepare({
        scope: "p",
        candidateId: candidate.candidateId,
        revision: (await f.c.snapshot()).revision,
      }),
    ).rejects.toThrow();
    expect(await disk(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
  },
);
it.each(mutations)(
  "native manual start rejects %s drift and consumes its token",
  async (mutation) => {
    const f = await setup("merge"),
      p = await preview(f);
    await mutate(f, mutation);
    const before = await disk(f.root);
    await expect(f.handoff.execute(p.token)).rejects.toThrow();
    if (mutation === "worktree") await f.git(["restore", "untouched"]);
    await expect(f.handoff.execute(p.token)).rejects.toThrow();
    if (mutation !== "worktree") expect(await disk(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
  },
);
it("native attempt is single-use, rejects forged handles, and two previews cannot replay one candidate", async () => {
  const f = await setup("merge"),
    attempt = await f.handoff.captureAttempt(f.c, f.input);
  const candidate = await f.handoff.afterFailure(
    f.c,
    attempt,
    new CommandExitError("opaque", 1),
  );
  expect(candidate).not.toBeNull();
  expect(
    await f.handoff.afterFailure(
      f.c,
      attempt,
      new CommandExitError("opaque", 1),
    ),
  ).toBeNull();
  expect(
    await f.handoff.afterFailure(f.c, {}, new CommandExitError("opaque", 1)),
  ).toBeNull();
  const request = {
    scope: "p",
    candidateId: candidate!.candidateId,
    revision: (await f.c.snapshot()).revision,
  };
  const a = await f.handoff.prepare(request),
    b = await f.handoff.prepare(request);
  expect(await f.handoff.execute(a.token)).toMatchObject({
    status: "conflict",
  });
  const before = await disk(f.root);
  await expect(f.handoff.execute(b.token)).rejects.toThrow();
  expect(await disk(f.root)).toEqual(before);
  expect(f.calls).toHaveLength(1);
});
it("native handoff rejects non-current target, dirty worktree and bisect without checkout", async () => {
  const f = await setup("merge");
  await f.git(["checkout", "main"]);
  let before = await disk(f.root);
  await expect(f.handoff.captureAttempt(f.c, f.input)).rejects.toThrow();
  expect(await disk(f.root)).toEqual(before);
  await f.git(["checkout", "topic"]);
  await f.write("untouched", "dirty\n");
  await expect(f.handoff.captureAttempt(f.c, f.input)).rejects.toThrow();
  await f.git(["restore", "untouched"]);
  await fs.writeFile(path.join(f.root, ".git/BISECT_START"), "topic\n");
  before = await disk(f.root);
  await expect(f.handoff.captureAttempt(f.c, f.input)).rejects.toThrow();
  expect(await disk(f.root)).toEqual(before);
  expect(f.calls).toEqual([]);
});
it("native handoff defaults to merge and rejects unknown or malformed effective configuration", async () => {
  const f = await setup("merge");
  f.config("base_ref: main\n");
  expect((await offer(f)).algorithm).toBe("merge");
  for (const config of [
    "base_ref: main\nbase_ref: other\n",
    "[",
    "base_ref: main\nupdate:\n  strategy: custom\n",
  ]) {
    f.config(config);
    await expect(f.handoff.captureAttempt(f.c, f.input)).rejects.toThrow();
  }
  expect(f.calls).toEqual([]);
});
it("native handoff requires a direct ref rather than a revision expression or symbolic ref", async () => {
  const f = await setup("merge");
  for (const sourceRef of [
    "HEAD",
    "main",
    "refs/heads/main~1",
    "--upload-pack=other",
  ])
    await expect(
      f.handoff.captureAttempt(f.c, { ...f.input, sourceRef }),
    ).rejects.toThrow();
  await f.git(["symbolic-ref", "refs/desktop/alias", "refs/heads/main"]);
  await expect(
    f.handoff.captureAttempt(f.c, {
      ...f.input,
      sourceRef: "refs/desktop/alias",
    }),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("native full topic identity and detached display copies do not grant another owner authority", async () => {
  const f = await setup("merge");
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "topic",
    branch: "topic",
    contextId: `ctx-${"a".repeat(64)}`,
    revision: "12345678-1234-4234-8234-123456789abc",
  };
  f.c.scope = scope;
  const candidate = await offer(f);
  candidate.conflicts.push("forged");
  if (typeof candidate.scope !== "string") candidate.scope.year = "2025";
  const p = await f.handoff.prepare({
    scope,
    candidateId: candidate.candidateId,
    revision: (await f.c.snapshot()).revision,
  });
  expect(p.candidate.scope).toEqual(scope);
  expect(p.candidate.conflicts).toEqual([]);
  f.c.scope = { ...scope, year: "2025" };
  await expect(f.handoff.execute(p.token)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("native candidate eviction never makes an evicted id valid again", async () => {
  const f = await setup("merge"),
    first = await offer(f);
  for (let i = 0; i < 8; i++) await offer(f);
  await expect(
    f.handoff.prepare({
      scope: "p",
      candidateId: first.candidateId,
      revision: (await f.c.snapshot()).revision,
    }),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("native Goga refusal accepts a byte-identical atomic index rewrite but rejects changed staged data", async () => {
  const f = await setup("merge"),
    attempt = await f.handoff.captureAttempt(f.c, f.input);
  const index = path.join(f.root, ".git/index");
  await fs.copyFile(index, `${index}.fixture`);
  await fs.rename(`${index}.fixture`, index);
  const candidate = await f.handoff.afterFailure(
    f.c,
    attempt,
    new CommandExitError("opaque", 1),
  );
  expect(candidate).not.toBeNull();
  const p = await f.handoff.prepare({
    scope: "p",
    candidateId: candidate!.candidateId,
    revision: (await f.c.snapshot()).revision,
  });
  await f.write("untouched", "staged change\n");
  await f.git(["add", "untouched"]);
  const before = await disk(f.root);
  await expect(f.handoff.execute(p.token)).rejects.toThrow();
  expect(await disk(f.root)).toEqual(before);
  expect(f.calls).toEqual([]);
});
it.each(["owner", "file", "expiry"] as const)(
  "native offer rechecks %s after the last asynchronous eligibility probe",
  async (race) => {
    const f = await setup("merge"),
      attempt = await f.handoff.captureAttempt(f.c, f.input);
    const git = f.c.git;
    let changed = false;
    f.c.git = async (args, options) => {
      const result = await git(args, options);
      if (!changed && args.includes("merge-base")) {
        changed = true;
        if (race === "owner") f.owner();
        if (race === "file") await f.write("untouched", "late edit\n");
        if (race === "expiry") f.advance();
      }
      return result;
    };
    expect(
      await f.handoff.afterFailure(
        f.c,
        attempt,
        new CommandExitError("opaque", 1),
      ),
    ).toBeNull();
    expect(changed).toBe(true);
    expect(f.calls).toEqual([]);
  },
);
it("native rebase START suppresses executable hooks without rewriting them", async () => {
  const f = await setup("rebase"),
    hook = path.join(f.root, ".git/hooks/pre-rebase"),
    marker = path.join(f.home, "hook-ran");
  const content = `#!/bin/sh\nprintf bad > '${marker}'\nexit 1\n`;
  await fs.writeFile(hook, content, { mode: 0o755 });
  expect(await f.handoff.execute((await preview(f)).token)).toMatchObject({
    status: "conflict",
  });
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(hook, "utf8")).toBe(content);
});

it("native handoff does not offer a needless operation when source and target coincide", async () => {
  const f = await setup("merge");
  await f.git(["update-ref", "refs/heads/main", f.original]);
  const before = await disk(f.root);
  expect(
    await f.handoff.afterFailure(
      f.c,
      await f.handoff.captureAttempt(f.c, f.input),
      new CommandExitError("opaque", 1),
    ),
  ).toBeNull();
  expect(await disk(f.root)).toEqual(before);
  expect(f.calls).toEqual([]);
});
it("native rebase encounters an earlier conflicting pick even when a later topic revert makes tip merge clean", async () => {
  const f = await setup("rebase");
  await f.write("file-1", "base\n");
  await f.git(["commit", "-am", "undo topic change"]);
  const p = await preview(f);
  expect(p.candidate.conflicts).toEqual([]);
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "conflict",
    conflicts: ["file-1"],
  });
  expect(f.calls).toHaveLength(1);
  await f.write("file-1", "change 1\n");
  await f.git(["add", "file-1"]);
  if (!(f.engine instanceof NativeGitSequence))
    throw Error("expected native rebase engine");
  const next = await f.engine.prepare({
    scope: "p",
    operation: "rebase",
    action: "continue",
    revision: (await f.reader.snapshot()).revision,
  });
  expect(await f.engine.execute(next.token)).toMatchObject({
    outcome: "completed",
  });
  expect(await f.read("file-1")).toBe("base\n");
});
it("native rebase skips an already-upstream patch without inventing a conflict", async () => {
  const f = await setup("rebase");
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
  const p = await preview(f);
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "success",
    conflicts: [],
  });
  expect(await f.git(["rev-parse", "HEAD"])).toBe(
    await f.git(["rev-parse", "main"]),
  );
  expect(f.calls).toHaveLength(1);
});
it("native Goga rebase does not overwrite ignored bytes occupying an earlier clean replay destination", async () => {
  const f = await setup("rebase", 3, [3]);
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
  const p = await preview(f),
    before = await disk(f.root);
  await expect(f.handoff.execute(p.token)).rejects.toThrow();
  expect(await disk(f.root)).toEqual(before);
  expect(await f.read("incoming.txt")).toBe("local ignored payload\n");
  expect(f.calls).toEqual([]);
});
it.each(["merge", "rebase"])(
  "native Goga %s unsettled failure is uncertain and never retried",
  async (strategy) => {
    const f = await setup(strategy),
      p = await preview(f);
    f.fault(async () => {
      throw new ByteCommandError(
        "process-unsettled",
        false,
        Buffer.alloc(0),
        Buffer.alloc(0),
      );
    });
    expect(await f.handoff.execute(p.token)).toMatchObject({
      status: "uncertain",
      changed: true,
      conflicts: [],
      native: {
        outcome: "uncertain",
        recovery: "retained",
        processSettled: false,
      },
    });
    await expect(f.handoff.execute(p.token)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  },
);
it("native handoff rechecks ownership after the final effective configuration read", async () => {
  const f = await setup("merge"),
    read = f.c.topicsConfig;
  let invalid = false;
  f.c.verify = async () => {
    if (invalid) throw Error("owner changed");
  };
  f.c.topicsConfig = async () => {
    const value = await read();
    invalid = true;
    return value;
  };
  await expect(f.handoff.captureAttempt(f.c, f.input)).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("native handoff refuses physical edits during the final effective configuration read", async () => {
  const f = await setup("merge"),
    read = f.c.topicsConfig;
  f.c.topicsConfig = async () => {
    const value = await read();
    await f.write("untouched", "changed-late\n");
    return value;
  };
  await expect(f.handoff.captureAttempt(f.c, f.input)).rejects.toThrow();
  expect(await f.read("untouched")).toBe("changed-late\n");
  expect(f.calls).toEqual([]);
});

it("native Goga START never seals an injected exec as trusted continuation provenance", async () => {
  const f = await setup("rebase", 2, [1]),
    p = await preview(f);
  const marker = path.join(f.home, "injected-exec-ran");
  f.afterNative(async () => {
    await fs.appendFile(
      path.join(f.root, ".git/rebase-merge/git-rebase-todo"),
      `exec printf compromised > '${marker}'\n`,
    );
  });
  const started = await f.handoff.execute(p.token);
  await f.resolve();
  if (!(f.engine instanceof NativeGitSequence))
    throw Error("expected native rebase engine");
  let continuation: string | undefined;
  try {
    const next = await f.engine.prepare({
      scope: "p",
      operation: "rebase",
      action: "continue",
      revision: (await f.reader.snapshot()).revision,
    });
    continuation = (await f.engine.execute(next.token)).outcome;
  } catch {
    /* A denied provenance check must not run the injected exec. */
  }
  const markerExists = await fs.stat(marker).then(
    () => true,
    () => false,
  );
  expect({ start: started.status, continuation, markerExists }).toEqual({
    start: "uncertain",
    continuation: undefined,
    markerExists: false,
  });
});
it("native Goga START preserves concurrent conflict bytes without certifying a verified conflict", async () => {
  const f = await setup("rebase"),
    p = await preview(f);
  f.afterNative(() => f.write("file-1", "external unsaved edit\n"));
  const result = await f.handoff.execute(p.token);
  expect(await f.read("file-1")).toBe("external unsaved edit\n");
  expect(result).toMatchObject({
    status: "uncertain",
    changed: true,
    native: { recovery: "retained" },
  });
});
it.each(["merge", "rebase"])(
  "native Goga %s does not certify unrelated index tampering after Git stops",
  async (strategy) => {
    const f = await setup(strategy),
      p = await preview(f);
    f.afterNative(async () => {
      await f.write("untouched", "external staged change\n");
      await f.git(["add", "untouched"]);
    });
    const result = await f.handoff.execute(p.token);
    expect(await f.read("untouched")).toBe("external staged change\n");
    expect(result).toMatchObject({
      status: "uncertain",
      changed: true,
      native: { recovery: "retained" },
    });
    expect(f.calls).toHaveLength(1);
  },
);
it("native Goga START preserves concurrent non-conflicting tracked edits without certifying them", async () => {
  const f = await setup("rebase", 3, [3]),
    p = await preview(f);
  f.afterNative(() => f.write("file-1", "external unsaved edit\n"));
  const result = await f.handoff.execute(p.token);
  expect(await f.read("file-1")).toBe("external unsaved edit\n");
  expect(result).toMatchObject({
    status: "uncertain",
    changed: true,
    native: { recovery: "retained" },
  });
});
it("native Goga attributes use actual Git behavior without a fabricated conflict prediction", async () => {
  const f = await setup("merge");
  await fs.writeFile(
    path.join(f.root, ".git/info/attributes"),
    "file-1 merge=union\n",
  );
  const p = await preview(f);
  expect(p.candidate.conflicts).toEqual([]);
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "success",
    conflicts: [],
  });
  expect(await f.read("file-1")).toContain("change 1");
  expect(await f.read("file-1")).toContain("upstream 1");
});
it("native Goga refuses executable merge policy without running or rewriting its files", async () => {
  const f = await setup("merge"),
    marker = path.join(f.home, "merge-driver-ran");
  await f.git(["config", "merge.custom.driver", `printf bad > '${marker}'`]);
  await fs.writeFile(
    path.join(f.root, ".git/info/attributes"),
    "file-1 merge=custom\n",
  );
  const before = await disk(f.root);
  await expect(
    (async () => f.handoff.execute((await preview(f)).token))(),
  ).rejects.toThrow();
  await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await disk(f.root)).toEqual(before);
  expect(f.calls).toEqual([]);
});
it("native Goga confirmation expiring during final state validation cannot start Git", async () => {
  const f = await setup("merge"),
    p = await preview(f);
  const read = f.c.topicsConfig;
  let reads = 0;
  f.c.topicsConfig = async () => {
    const value = await read();
    if (++reads === 2) f.advance();
    return value;
  };
  const before = await disk(f.root);
  await expect(f.handoff.execute(p.token)).rejects.toThrow();
  expect(reads).toBe(2);
  expect(f.calls).toEqual([]);
  expect(await disk(f.root)).toEqual(before);
});

it("native result witness refuses worktree drift after the final public diff", async () => {
  const f = await setup("rebase"),
    p = await preview(f);
  let injected = false;
  f.observeRead(async (args) => {
    if (
      !injected &&
      args.includes("diff") &&
      args.includes("--name-only") &&
      args.includes("--no-textconv")
    ) {
      injected = true;
      await f.write("file-1", "late external edit\n");
    }
  });
  const result = await f.handoff.execute(p.token);
  expect(injected).toBe(true);
  expect(await f.read("file-1")).toBe("late external edit\n");
  expect(result).toMatchObject({
    status: "uncertain",
    native: { recovery: "retained" },
  });
  expect(f.calls).toHaveLength(1);
  expect(f.planInspections).toHaveLength(2);
});
it("native public plan inspection refuses a todo changed after its second read", async () => {
  const f = await setup("rebase"),
    p = await preview(f);
  let inspections = 0;
  f.observeRead(async (args) => {
    if (args.includes("--edit-todo") && ++inspections === 2)
      await fs.appendFile(
        path.join(f.root, ".git/rebase-merge/git-rebase-todo"),
        "exec false\n",
      );
  });
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "uncertain",
    native: { recovery: "retained" },
  });
  expect(f.calls).toHaveLength(1);
  expect(f.planInspections).toHaveLength(2);
});
it("native merge requires its result witness rather than treating absence as proof", async () => {
  const f = await setup("merge"),
    p = await preview(f);
  f.afterNative(() => fs.unlink(path.join(f.root, ".git/AUTO_MERGE")));
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "uncertain",
    native: { recovery: "retained" },
  });
  expect(f.calls).toHaveLength(1);
});

it.each([
  ["merge", "--assume-unchanged"],
  ["merge", "--skip-worktree"],
  ["rebase", "--assume-unchanged"],
  ["rebase", "--skip-worktree"],
])(
  "native %s witness rejects post-stop %s hiding changed bytes",
  async (strategy, flag) => {
    const f = await setup(strategy),
      p = await preview(f);
    f.afterNative(async () => {
      await f.git(["update-index", flag, "untouched"]);
      await f.write("untouched", "hidden external edit\n");
    });
    expect(await f.handoff.execute(p.token)).toMatchObject({
      status: "uncertain",
      native: { recovery: "retained" },
    });
    expect(await f.read("untouched")).toBe("hidden external edit\n");
    expect(f.calls).toHaveLength(1);
  },
);

it("native witness rejects an unrelated path forged as unmerged after Git stops", async () => {
  const f = await setup("rebase"),
    p = await preview(f);
  const oid = (await f.git(["rev-parse", "HEAD:untouched"])).trim();
  f.afterNative(async () => {
    await f.c.git(["update-index", "--index-info"], {
      stdin:
        `0 ${"0".repeat(40)}\tuntouched\n` +
        [1, 2, 3]
          .map((stage) => `100644 ${oid} ${stage}\tuntouched\n`)
          .join(""),
    });
  });
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "uncertain",
    native: { recovery: "retained" },
  });
  expect(f.calls).toHaveLength(1);
});

it.each(["merge", "rebase"])(
  "%s: native witness rejects substituted stages on an existing conflict path",
  async (strategy) => {
    const f = await setup(strategy),
      p = await preview(f);
    const oid = (await f.git(["rev-parse", "HEAD:untouched"])).trim();
    f.afterNative(async () => {
      const rows = (await f.git(["ls-files", "--unmerged", "-z"]))
        .split("\0")
        .filter(Boolean);
      expect(rows.length).toBeGreaterThan(0);
      const match = /^(\d{6}) [a-f0-9]+ ([123])\t(.+)$/s.exec(rows[0])!;
      await f.c.git(["update-index", "--index-info"], {
        stdin: `${match[1]} ${oid} ${match[2]}\t${match[3]}\n`,
      });
    });
    expect(await f.handoff.execute(p.token)).toMatchObject({
      status: "uncertain",
      native: { recovery: "retained" },
    });
    expect(f.calls).toHaveLength(1);
  },
);

it.each(["merge", "rebase"])(
  "%s: native witness rejects a conflict silently staged before its first seal",
  async (strategy) => {
    const f = await setup(strategy, 2, [1, 2]),
      p = await preview(f);
    f.afterNative(async () => {
      const conflicts = (await f.c.snapshot()).files.filter(
        (f) => f.kind === "conflict",
      );
      expect(conflicts.length).toBeGreaterThan(0);
      await f.c.git(["add", "--", conflicts[0].path]);
    });
    expect(await f.handoff.execute(p.token)).toMatchObject({
      status: "uncertain",
      native: { recovery: "retained" },
    });
    expect(f.calls).toHaveLength(1);
  },
);

it("conflict membership witness refuses index drift during its native probe", async () => {
  const f = await setup("rebase"),
    p = await preview(f);
  let injected = false;
  f.observeRead(async (args) => {
    if (
      !injected &&
      f.calls.length === 1 &&
      args.includes("--show-object-format")
    ) {
      injected = true;
      const oid = (await f.git(["rev-parse", "HEAD:untouched"])).trim();
      await f.c.git(["update-index", "--index-info"], {
        stdin: `100755 ${oid} 0\tuntouched\n`,
      });
    }
  });
  expect(await f.handoff.execute(p.token)).toMatchObject({
    status: "uncertain",
    native: { recovery: "retained" },
  });
  expect(injected).toBe(true);
  expect(f.calls).toHaveLength(1);
});

it("N8 clean handoff preserves recovery until its outer context has released", async () => {
  const f = await setup("merge");
  await f.git([
    "restore",
    "--source=main",
    "--staged",
    "--worktree",
    "--",
    "file-1",
  ]);
  await f.git(["commit", "-m", "same content as source"]);
  const attempt = await f.handoff.captureAttempt(f.c, f.input);
  const candidate = await f.handoff.afterFailure(
    f.c,
    attempt,
    new CommandExitError("opaque", 1),
  );
  const p = await f.handoff.prepare({
    scope: "p",
    candidateId: candidate!.candidateId,
    revision: (await f.reader.snapshot()).revision,
  });
  f.afterContext(() => {
    throw Error("outer-owner-release");
  });
  await expect(f.handoff.execute(p.token)).rejects.toThrow();
  const dir = path.join(f.home, "journal");
  const name = (await fs.readdir(dir)).find((n) => n.endsWith(".json"))!;
  const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
  expect(record.recovery).not.toBeNull();
  await expect(
    f.c.native!.journal.assertAdmission(f.root, record.recovery.owner),
  ).rejects.toThrow();
});
