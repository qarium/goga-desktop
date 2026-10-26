import { afterEach, describe, expect, it, vi } from "vitest";
const diagnosticFault = vi.hoisted(() => ({
  statPath: "",
  journal: false,
  recovery: false,
  unlinkAck: "",
  mergeCleanup: "",
}));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: (name: any) => {
      if (name === diagnosticFault.mergeCleanup) {
        diagnosticFault.mergeCleanup = "";
        throw Object.assign(Error("fixture merge cleanup EIO"), {
          code: "EIO",
        });
      }
      return actual.unlinkSync(name);
    },
  };
});
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  const fail = () =>
    Object.assign(Error("fixture diagnostic EIO"), { code: "EIO" });
  return {
    ...actual,
    lstat: async (name: any, ...args: any[]) => {
      if (
        name === diagnosticFault.statPath ||
        (diagnosticFault.recovery &&
          /goga-(?:abort|merge)-[^/]+$/.test(String(name)))
      ) {
        diagnosticFault.statPath = "";
        diagnosticFault.recovery = false;
        throw fail();
      }
      return (actual.lstat as any)(name, ...args);
    },
    writeFile: async (name: any, ...args: any[]) => {
      if (diagnosticFault.journal && String(name).endsWith("/journal.json")) {
        diagnosticFault.journal = false;
        throw fail();
      }
      return (actual.writeFile as any)(name, ...args);
    },
    unlink: async (name: any) => {
      await actual.unlink(name);
      if (name === diagnosticFault.unlinkAck) {
        diagnosticFault.unlinkAck = "";
        diagnosticFault.statPath = name;
        throw fail();
      }
    },
  };
});
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  CommandExitError,
  GitRefTransactionError,
  NodeRunner,
} from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
import type { ScopeRef } from "../src/shared/context";
import type { GitCommitContext } from "../src/host/git-workspace-actions";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  Object.assign(diagnosticFault, {
    statPath: "",
    journal: false,
    recovery: false,
    unlinkAck: "",
    mergeCleanup: "",
  });
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(scope: ScopeRef = "project", format = "sha1") {
  const dir = await fs.mkdtemp("/private/tmp/goga-merge-operation-");
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = (args: string[], stdin?: string) =>
    runner.command("git", args, root, env, stdin);
  const write = (name: string, value: string) =>
    fs.writeFile(path.join(root, name), value);
  const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
  const head = async (ref = "HEAD") =>
    (await git(["rev-parse", ref])).stdout.trim();
  const commit = async (name: string, value: string) => {
    await write(name, value);
    await git(["add", "--", name]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", name]);
    return head();
  };
  await git(["init", "-b", "main", "--object-format=" + format]);
  await git(["config", "user.name", "Merge Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await commit("conflict", "base\n");
  await commit("unrelated", "original\n");
  await git(["checkout", "-b", "source"]);
  await commit("incoming", "incoming\n");
  const source = await commit("conflict", "source\n");
  await git(["checkout", "main"]);
  const original = await commit("conflict", "main\n");
  await expect(git(["merge", "--no-edit", source])).rejects.toThrow();
  const reader = new GitWorkspaceReader({
    root,
    scope,
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  let lockFault:
    ((name: string, phase: "before" | "after") => void) | undefined;
  let ownerKey = "owner",
    now = 1000;
  let beforeRemoveRecovery: (() => void) | undefined,
    contextAfter: (() => void) | undefined;
  let beforeCleanup: (() => void) | undefined,
    afterCleanupFile: ((name: string) => void) | undefined;
  let intercept: ((args: string[]) => Promise<void>) | undefined;
  let transactionIntercept: ((input: string) => Promise<void>) | undefined;
  let afterTransaction: ((input: string) => Promise<void>) | undefined;
  const calls: string[][] = [];
  const ctx: GitCommitContext = {
    root,
    scope,
    ownerKey,
    verify: async () => {},
    snapshot: () => reader.snapshot(),
    git: async (args, opts) => {
      calls.push(args);
      await intercept?.(args);
      const run = () => git(args, opts?.stdin);
      return opts?.indexFile ? withTrustedGitIndex(opts.indexFile, run) : run();
    },
    refTransaction: async (args, input, verify) => {
      await transactionIntercept?.(input);
      const out = await runner.gitRefTransaction(
        args,
        root,
        env,
        input,
        verify,
      );
      await afterTransaction?.(input);
      return out;
    },
  };
  const modulePath = "../src/host/git-operations";
  const module = await import(modulePath).catch(() => null);
  expect(
    module?.GitMergeOperations,
    "scoped pending merge API is missing",
  ).toBeTypeOf("function");
  const actions = new module.GitMergeOperations({
    context: async (
      requested: ScopeRef,
      fn: (ctx: GitCommitContext) => Promise<unknown>,
    ) => {
      expect(requested).toEqual(scope);
      const value = await fn({ ...ctx, ownerKey });
      contextAfter?.();
      return value;
    },
    now: () => now,
    beforeCleanup: () => beforeCleanup?.(),
    afterCleanupFile: (name: string) => afterCleanupFile?.(name),
    beforeRemoveRecovery: () => beforeRemoveRecovery?.(),
    releaseLockFault: (name: string, phase: "before" | "after") =>
      lockFault?.(name, phase),
  });
  const prepare = async (action = "continue") =>
    actions.prepare({
      scope,
      revision: (await reader.snapshot()).revision,
      action,
    });
  const resolve = async () => {
    await write("conflict", "resolved\n");
    await git(["add", "conflict"]);
  };
  return {
    dir,
    root,
    git,
    write,
    read,
    head,
    reader,
    source,
    original,
    actions,
    prepare,
    resolve,
    calls,
    ctx,
    lockFault: (fn: typeof lockFault) => {
      lockFault = fn;
    },
    finalHooks: (cleanup?: () => void, after?: () => void) => {
      beforeRemoveRecovery = cleanup;
      contextAfter = after;
    },
    cleanupHooks: (before?: () => void, after?: (name: string) => void) => {
      beforeCleanup = before;
      afterCleanupFile = after;
    },
    setOwner: (v: string) => {
      ownerKey = v;
    },
    setNow: (v: number) => {
      now = v;
    },
    intercept: (v: typeof intercept) => {
      intercept = v;
    },
    transactionIntercept: (v: typeof transactionIntercept) => {
      transactionIntercept = v;
    },
    afterTransaction: (v: typeof afterTransaction) => {
      afterTransaction = v;
    },
  };
}
const cloneScope = {
  projectId: "project",
  year: "2026",
  topic: "topic",
  branch: "main",
  contextId: "ctx-" + "c".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
describe("scoped genuine pending merge completion", () => {
  it.each(["primary", "clone"])(
    "completes %s with exact parents/tree, native identity, no hooks/editor and preserves unrelated work",
    async (kind) => {
      const f = await fixture(kind === "clone" ? cloneScope : "project");
      await f.resolve();
      await f.write("unrelated", "draft\n");
      await f.write("untracked", "new draft\n");
      await fs.writeFile(path.join(f.root, ".git/info/exclude"), "ignored\n");
      await f.write("ignored", "ignored draft\n");
      const marker = path.join(f.dir, "hook-ran");
      for (const hook of [
        "pre-commit",
        "prepare-commit-msg",
        "commit-msg",
        "post-commit",
        "post-merge",
      ])
        await fs.writeFile(
          path.join(f.root, ".git/hooks", hook),
          `#!/bin/sh\ntouch '${marker}'\n`,
          { mode: 0o755 },
        );
      await f.git(["config", "core.editor", `touch '${marker}'`]);
      const tree = (await f.git(["write-tree"])).stdout.trim();
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const p = await f.prepare();
      expect(p).toMatchObject({
        action: "continue",
        root: f.root,
        branch: "main",
        head: f.original,
        sourceOid: f.source,
        hooks: "disabled",
        author: "Merge Fixture <fixture@example.invalid>",
        signing: false,
      });
      expect(p.paths.sort()).toEqual(["conflict", "incoming"]);
      const result = await f.actions.execute(p.token);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "success",
        changed: true,
      });
      expect(
        (
          await f.git(["show", "-s", "--format=%P%n%T%n%an <%ae>", "HEAD"])
        ).stdout.trim(),
      ).toBe(
        `${f.original} ${f.source}\n${tree}\nMerge Fixture <fixture@example.invalid>`,
      );
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect(await f.read("unrelated")).toBe("draft\n");
      expect(await f.read("untracked")).toBe("new draft\n");
      expect(await f.read("ignored")).toBe("ignored draft\n");
      expect((await f.git(["show", "HEAD:unrelated"])).stdout).toBe(
        "original\n",
      );
      expect((await f.reader.snapshot()).operation).toBe("none");
      expect(await f.head("ORIG_HEAD")).toBe(f.original);
      await expect(fs.stat(marker)).rejects.toThrow();
      expect(
        f.calls.some(
          (a) =>
            a.includes("commit") ||
            a.includes("reset") ||
            a.includes("stash") ||
            a.includes("push") ||
            a.includes("add"),
        ),
      ).toBe(false);
      await expect(f.actions.execute(p.token)).rejects.toThrow();
    },
  );
  it("refuses unresolved merge before issuing any ticket", async () => {
    const f = await fixture();
    await expect(f.prepare()).rejects.toThrow(/конфликт|unmerged/i);
  });
  it.each(["new", "existing", "delete"])(
    "never includes unrelated staged %s changes",
    async (kind) => {
      const f = await fixture();
      await f.resolve();
      const name = kind === "new" ? "extra" : "unrelated";
      if (kind === "delete") await fs.unlink(path.join(f.root, name));
      else await f.write(name, "staged unrelated\n");
      await f.git(["add", "--", name]);
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const p = await f.prepare();
      const out = await f.actions.execute(p.token);
      expect(out).toMatchObject({ status: "error", changed: false });
      expect(await f.head()).toBe(f.original);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect((await f.reader.snapshot()).operation).toBe("merge");
    },
  );
  it.each(["content", "metadata", "config", "owner", "head", "expired"])(
    "rejects changed %s after preview",
    async (kind) => {
      const f = await fixture();
      await f.resolve();
      const p = await f.prepare();
      if (kind === "content") await f.write("unrelated", "later\n");
      if (kind === "metadata") await f.write(".git/MERGE_MSG", "changed\n");
      if (kind === "config") await f.git(["config", "user.name", "Changed"]);
      if (kind === "owner") f.setOwner("changed");
      if (kind === "head") {
        await f.git(["branch", "same"]);
        await f.git(["symbolic-ref", "HEAD", "refs/heads/same"]);
      }
      if (kind === "expired") f.setNow(p.expiresAt);
      const out = await f.actions.execute(p.token).catch((e: Error) => e);
      expect(
        out instanceof Error || (out.status === "error" && !out.changed),
      ).toBe(true);
      expect(await f.head("main")).toBe(f.original);
      expect(f.calls.some((a) => a.includes("commit-tree"))).toBe(false);
    },
  );
  it.each([
    "CHERRY_PICK_HEAD",
    "REBASE_HEAD",
    "REVERT_HEAD",
    "MERGE_AUTOSTASH",
    "sequencer",
    "rebase-merge",
  ])("refuses mixed %s state", async (name) => {
    const f = await fixture();
    await f.resolve();
    if (name === "sequencer" || name === "rebase-merge")
      await fs.mkdir(path.join(f.root, ".git", name));
    else await f.write(`.git/${name}`, `${f.source}\n`);
    await expect(f.prepare()).rejects.toThrow();
  });
  it.each([
    "missing-auto",
    "wrong-auto",
    "wrong-original",
    "multiple-sources",
    "symlink",
    "oversize",
  ])("refuses unsupported metadata %s", async (kind) => {
    const f = await fixture();
    await f.resolve();
    if (kind === "missing-auto")
      await fs.unlink(path.join(f.root, ".git/AUTO_MERGE"));
    if (kind === "wrong-auto")
      await f.write(".git/AUTO_MERGE", `${await f.head("HEAD^{tree}")}\n`);
    if (kind === "wrong-original")
      await f.write(".git/ORIG_HEAD", `${f.source}\n`);
    if (kind === "multiple-sources")
      await f.write(".git/MERGE_HEAD", `${f.source}\n${f.original}\n`);
    if (kind === "symlink") {
      await fs.unlink(path.join(f.root, ".git/MERGE_MSG"));
      await fs.symlink(
        path.join(f.root, "unrelated"),
        path.join(f.root, ".git/MERGE_MSG"),
      );
    }
    if (kind === "oversize") {
      const h = await fs.open(path.join(f.root, ".git/MERGE_MSG"), "w");
      await h.truncate(257 * 1024 * 1024);
      await h.close();
    }
    const out = await f
      .prepare()
      .then((p) => f.actions.execute(p.token))
      .catch((e: Error) => e);
    expect(
      out instanceof Error || (out.status === "error" && !out.changed),
    ).toBe(true);
    expect(await f.head()).toBe(f.original);
  });
  it("refuses missing prepared-ref capability before any writes", async () => {
    const f = await fixture();
    await f.resolve();
    f.ctx.refTransaction = undefined;
    const names = await fs.readdir(path.join(f.root, ".git"));
    const out = await f
      .prepare()
      .then((p) => f.actions.execute(p.token))
      .catch((e: Error) => e);
    expect(out instanceof Error || out.status === "error").toBe(true);
    expect(await fs.readdir(path.join(f.root, ".git"))).toEqual(names);
    expect(
      f.calls.some(
        (a) => a.includes("merge-tree") || a.includes("commit-tree"),
      ),
    ).toBe(false);
  });
  it("does not move either branch after a same-OID symbolic HEAD race before prepared validation", async () => {
    const f = await fixture();
    await f.resolve();
    await f.git(["branch", "other"]);
    const p = await f.prepare();
    f.transactionIntercept(async (input) => {
      if (input.includes("update HEAD"))
        await f.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({ status: "error", changed: false });
    expect(await f.head("main")).toBe(f.original);
    expect(await f.head("other")).toBe(f.original);
    expect((await f.reader.snapshot()).operation).toBe("merge");
  });
  it("retains merge metadata, journal and lock and reports uncertain when acknowledgement fails after ref mutation", async () => {
    const f = await fixture();
    await f.resolve();
    const p = await f.prepare();
    f.afterTransaction(async (input) => {
      if (input.includes("update HEAD")) throw Error("lost ACK after mutation");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
    });
    expect(out.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(out.recoveryPath).toBeTruthy();
    expect(await f.head()).not.toBe(f.original);
    expect((await f.reader.snapshot()).operation).toBe("merge");
    expect(
      await fs.readFile(path.join(out.recoveryPath, "journal.json"), "utf8"),
    ).toContain(out.commit);
  });
  it("does not clean operation metadata when HEAD changes between publish and cleanup", async () => {
    const f = await fixture();
    await f.resolve();
    await f.git(["branch", "other"]);
    const p = await f.prepare();
    f.transactionIntercept(async (input) => {
      if (input.includes("verify HEAD"))
        await f.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
    });
    expect((await f.reader.snapshot()).operation).toBe("merge");
    expect(await f.head("other")).toBe(f.original);
  });
  it("preserves signing policy on native commit-tree failure without publishing or fabricating authors", async () => {
    const f = await fixture();
    await f.resolve();
    await f.git(["config", "commit.gpgSign", "true"]);
    await f.git(["config", "gpg.program", "/nonexistent/disabled"]);
    const p = await f.prepare();
    expect(p.signing).toBe(true);
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({ status: "error", changed: false });
    expect(f.calls.find((a) => a.includes("commit-tree"))).toContain("-S");
    expect(await f.head()).toBe(f.original);
  });
  it.each(["primary", "clone"])(
    "aborts %s without losing unrelated unstaged/untracked work",
    async (kind) => {
      const f = await fixture(kind === "clone" ? cloneScope : "project");
      await f.write("unrelated", "draft\n");
      await f.write("untracked", "new\n");
      const p = await f.prepare("abort");
      const out = await f.actions.execute(p.token);
      expect(out, JSON.stringify(out)).toMatchObject({
        status: "success",
        changed: true,
      });
      expect(await f.head()).toBe(f.original);
      expect(await f.read("unrelated")).toBe("draft\n");
      expect(await f.read("untracked")).toBe("new\n");
      expect((await f.reader.snapshot()).operation).toBe("none");
    },
  );
  it("refuses abort with unrelated staged work unchanged", async () => {
    const f = await fixture(cloneScope);
    await f.write("unrelated", "staged\n");
    await f.git(["add", "unrelated"]);
    const p = await f.prepare("abort");
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(await f.read("unrelated")).toBe("staged\n");
  });
  it.each(["continue", "abort"])(
    "supports a clean pending ORT merge with zero original conflicts for %s",
    async (action) => {
      const f = await fixture();
      await f.git(["merge", "--abort"]);
      await f.git(["checkout", "-b", "clean-source"]);
      await f.write("new-clean", "clean\n");
      await f.git(["add", "new-clean"]);
      await f.git(["commit", "-m", "clean source"]);
      const source = await f.head();
      await f.git(["checkout", "main"]);
      await f.write("local-clean", "local\n");
      await f.git(["add", "local-clean"]);
      await f.git(["commit", "-m", "local"]);
      const original = await f.head();
      await f.git(["merge", "--no-edit", "--no-commit", source]);
      const p = await f.prepare(action);
      const out = await f.actions.execute(p.token);
      expect(out, JSON.stringify(out)).toMatchObject({
        status: "success",
        changed: true,
      });
      expect((await f.reader.snapshot()).operation).toBe("none");
      if (action === "continue")
        expect(
          (await f.git(["show", "-s", "--format=%P", "HEAD"])).stdout.trim(),
        ).toBe(`${original} ${source}`);
      else expect(await f.head()).toBe(original);
    },
  );
  it("refuses unsupported external branch-name conflict labels with live state intact", async () => {
    const f = await fixture();
    await f.git(["merge", "--abort"]);
    await expect(f.git(["merge", "--no-edit", "source"])).rejects.toThrow();
    await f.resolve();
    const index = await fs.readFile(path.join(f.root, ".git/index")),
      metadata = await f.read(".git/MERGE_HEAD");
    const p = await f.prepare();
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({ status: "error", changed: false });
    expect(out.message).toMatch(/воспроизвести|подтвер/i);
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await f.read(".git/MERGE_HEAD")).toBe(metadata);
    expect(await f.head()).toBe(f.original);
    expect(f.calls.some((a) => a.includes("commit-tree"))).toBe(false);
  });
  it("pins the explicit message and immutable returned preview without trusting mutated fields", async () => {
    const f = await fixture();
    await f.resolve();
    const request = {
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      action: "continue",
      message: "Confirmed merge",
    };
    const p = await f.actions.prepare(request);
    p.message = "forged";
    p.action = "abort";
    p.paths.length = 0;
    p.root = "/forged";
    request.message = "also forged";
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({ status: "success", action: "continue" });
    expect(
      (await f.git(["show", "-s", "--format=%B", "HEAD"])).stdout.trim(),
    ).toBe("Confirmed merge");
  });
  it.each(["before", "partial", "after-ack"])(
    "reports uncertain and keeps recoverable evidence for cleanup failure %s",
    async (kind) => {
      const f = await fixture();
      await f.resolve();
      const p = await f.prepare();
      if (kind === "before")
        f.cleanupHooks(() => {
          throw Error("before cleanup failed");
        });
      if (kind === "partial")
        f.cleanupHooks(undefined, (name) => {
          if (name === "MERGE_HEAD") throw Error("partial cleanup failed");
        });
      if (kind === "after-ack")
        f.afterTransaction(async (input) => {
          if (input.includes("verify HEAD")) throw Error("cleanup ACK lost");
        });
      const out = await f.actions.execute(p.token);
      expect(out).toMatchObject({
        status: "uncertain",
        changed: true,
        lockRetained: true,
      });
      expect(out.commit).toBe(await f.head());
      expect(
        await fs.readFile(path.join(out.recoveryPath, "MERGE_HEAD"), "utf8"),
      ).toBe(`${f.source}\n`);
      expect(await fs.stat(path.join(f.root, ".git/index.lock"))).toBeTruthy();
      await expect(f.actions.execute(p.token)).rejects.toThrow();
    },
  );
  it("rejects changed attributes after preview before commit creation", async () => {
    const f = await fixture();
    await f.resolve();
    const p = await f.prepare();
    await f.write(".git/info/attributes", "conflict merge=union\n");
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(await f.head()).toBe(f.original);
    expect(f.calls.some((a) => a.includes("commit-tree"))).toBe(false);
  });
  it("refuses expired confirmation even after commit object creation, without moving HEAD", async () => {
    const f = await fixture();
    await f.resolve();
    const p = await f.prepare();
    f.transactionIntercept(async (input) => {
      if (input.includes("update HEAD")) f.setNow(p.expiresAt);
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(await f.head()).toBe(f.original);
  });

  it.each(["same", "different"])(
    "pins owned HEAD and branch against cooperative %s-OID replacement during abort",
    async (kind) => {
      const f = await fixture(cloneScope);
      await f.git(["branch", "other", kind === "same" ? f.original : f.source]);
      const p = await f.prepare("abort");
      let checked = false;
      f.intercept(async (args) => {
        if (!args.includes("--abort")) return;
        checked = true;
        await expect(
          f.git(["symbolic-ref", "HEAD", "refs/heads/other"]),
        ).rejects.toThrow();
        await expect(
          f.git(["update-ref", "refs/heads/main", f.source, f.original]),
        ).rejects.toThrow();
      });
      const out = await f.actions.execute(p.token);
      expect(checked).toBe(true);
      expect(out, JSON.stringify(out)).toMatchObject({
        status: "success",
        changed: true,
        nativeWarning: false,
      });
      expect(await f.head()).toBe(f.original);
      expect((await f.reader.snapshot()).branch).toBe("main");
      expect(out.log).not.toMatch(/HEAD.lock|update_ref failed|кодом 1/);
    },
  );
  it("reports genuine native abort refusal before mutation as unchanged error", async () => {
    const f = await fixture();
    const p = await f.prepare("abort");
    f.intercept(async (args) => {
      if (args.includes("--abort"))
        throw new CommandExitError("fixture refusal", 1);
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({ status: "error", changed: false });
    expect((await f.reader.snapshot()).operation).toBe("merge");
  });
  it.each([false, true])(
    "never turns timeout into success and retains pins after possible mutation=%s",
    async (mutate) => {
      const f = await fixture();
      const p = await f.prepare("abort");
      f.intercept(async (args) => {
        if (!args.includes("--abort")) return;
        if (mutate) await f.git(args).catch(() => {});
        throw Error("fixture child timeout/stop not confirmed");
      });
      const out = await f.actions.execute(p.token);
      expect(out).toMatchObject({
        status: "uncertain",
        changed: true,
        lockRetained: true,
      });
      expect(out.recoveryPath).toBeTruthy();
      await expect(
        f.git(["symbolic-ref", "HEAD", "refs/heads/source"]),
      ).rejects.toThrow();
      expect(await fs.stat(path.join(f.root, ".git/HEAD.lock"))).toBeTruthy();
      expect(
        await fs.stat(path.join(f.root, ".git/refs/heads/main.lock")),
      ).toBeTruthy();
    },
  );

  it("does not falsely report a retained index lock when recovery cleanup fails after lock removal", async () => {
    const f = await fixture();
    await f.resolve();
    const p = await f.prepare();
    f.finalHooks(() => {
      throw Error("recovery removal fault");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: false,
    });
    expect(out.recoveryPath).toBeTruthy();
    await expect(
      fs.stat(path.join(f.root, ".git/index.lock")),
    ).rejects.toThrow();
    expect(out.commit).toBe(await f.head());
    expect((await f.reader.snapshot()).operation).toBe("none");
  });
  it("does not report unchanged error if the owner context fails after a completed mutation", async () => {
    const f = await fixture();
    await f.resolve();
    const p = await f.prepare();
    f.finalHooks(undefined, () => {
      throw Error("after-owner-validation failure");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({ status: "uncertain", changed: true });
    expect(out.message).toContain("могла изменить состояние");
    expect(out.commit).toBe(await f.head());
  });

  it("denies late cooperative git add during abort before it can replace unrelated staged state", async () => {
    const f = await fixture();
    await f.write("unrelated", "late stage draft\n");
    const p = await f.prepare("abort");
    let checked = false;
    f.intercept(async (args) => {
      if (!args.includes("--abort")) return;
      checked = true;
      await expect(f.git(["add", "unrelated"])).rejects.toThrow();
    });
    const out = await f.actions.execute(p.token);
    expect(checked).toBe(true);
    expect(out).toMatchObject({ status: "success" });
    expect(await f.read("unrelated")).toBe("late stage draft\n");
    expect((await f.git(["show", ":unrelated"])).stdout).toBe("original\n");
  });
  it("aborts a packed nested branch with resolved conflicts and preserves index permissions", async () => {
    const f = await fixture();
    await f.git(["branch", "-m", "feature/nested"]);
    await f.git(["pack-refs", "--all"]);
    await f.resolve();
    await fs.chmod(path.join(f.root, ".git/index"), 0o600);
    const p = await f.prepare("abort");
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({ status: "success" });
    expect((await f.reader.snapshot()).branch).toBe("feature/nested");
    expect((await fs.stat(path.join(f.root, ".git/index"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it.each(["ignored-recreated", "directory-private"])(
    "keeps the original abort destination protections in topic scope: %s",
    async (kind) => {
      const f = await fixture(cloneScope);
      await f.git(["merge", "--abort"]);
      if (kind === "directory-private") {
        await f.write("collision", "HEAD file\n");
        await f.git(["add", "collision"]);
        await f.git(["commit", "-m", "HEAD collision"]);
      }
      await f.git(["checkout", "source"]);
      if (kind === "ignored-recreated") await f.git(["rm", "unrelated"]);
      else {
        await fs.mkdir(path.join(f.root, "collision"));
        await f.write("collision/child", "incoming\n");
        await f.git(["add", "collision/child"]);
      }
      await f.git(["commit", "-m", "incoming collision"]);
      const source = await f.head();
      await f.git(["checkout", "main"]);
      await expect(f.git(["merge", "--no-edit", source])).rejects.toThrow();
      const keep =
        kind === "ignored-recreated" ? "unrelated" : "collision/private";
      await f.write(".git/info/exclude", `${keep}\n`);
      await f.write(keep, "KEEP USER DATA\n");
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const p = await f.prepare("abort");
      expect(await f.actions.execute(p.token)).toMatchObject({
        status: "error",
        changed: false,
      });
      expect(await f.read(keep)).toBe("KEEP USER DATA\n");
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      expect(f.calls.some((a) => a.includes("--abort"))).toBe(false);
    },
  );
  it.each(["index.lock", "HEAD.lock", "refs/heads/main.lock", "config.lock"])(
    "reports truthful uncertain after abort succeeds but cleanup of %s fails",
    async (name) => {
      const f = await fixture();
      const p = await f.prepare("abort");
      f.lockFault((lock, phase) => {
        if (lock === name && phase === "before") throw Error("release fault");
      });
      const out = await f.actions.execute(p.token);
      expect(out).toMatchObject({
        status: "uncertain",
        changed: true,
        lockRetained: true,
      });
      expect(out.retainedLocks).toContain(name);
      expect(await fs.stat(path.join(f.root, ".git", name))).toBeTruthy();
      expect((await f.reader.snapshot()).operation).toBe("none");
    },
  );
  it("does not report removed pins as retained after an abort cleanup ACK error", async () => {
    const f = await fixture();
    const p = await f.prepare("abort");
    f.lockFault((name, phase) => {
      if (name === "index.lock" && phase === "after")
        throw Error("late release error");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: false,
    });
    expect(out.retainedLocks ?? []).toEqual([]);
    for (const name of [
      "HEAD.lock",
      "index.lock",
      "refs/heads/main.lock",
      "config.lock",
    ])
      await expect(fs.stat(path.join(f.root, ".git", name))).rejects.toThrow();
    expect(out.recoveryPath).toBeTruthy();
    expect(
      JSON.parse(
        await fs.readFile(path.join(out.recoveryPath, "journal.json"), "utf8"),
      ).locks,
    ).toEqual([]);
  });
  it("keeps changed=false when abort cleanup fails before native mutation", async () => {
    const f = await fixture();
    const p = await f.prepare("abort");
    f.intercept(async (args) => {
      if (args.includes("check-ref-format"))
        throw Error("before native command");
    });
    f.lockFault((name, phase) => {
      if (name === "config.lock" && phase === "before")
        throw Error("release error");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "error",
      changed: false,
      lockRetained: true,
    });
    expect((await f.reader.snapshot()).operation).toBe("merge");
  });
  it("retains completion recovery when outer config lock release fails", async () => {
    const f = await fixture();
    await f.resolve();
    const p = await f.prepare();
    f.lockFault((name, phase) => {
      if (name === "config.lock" && phase === "before")
        throw Error("config cleanup fault");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
      retainedLocks: ["config.lock"],
    });
    expect(out.commit).toBe(await f.head());
    expect(out.recoveryPath).toBeTruthy();
    expect(
      await fs.stat(path.join(out.recoveryPath, "journal.json")),
    ).toBeTruthy();
  });

  it("keeps proven native refusal unchanged even if later pin cleanup fails", async () => {
    const f = await fixture();
    const p = await f.prepare("abort");
    f.intercept(async (args) => {
      if (args.includes("--abort"))
        throw new CommandExitError("native refusal", 1);
    });
    f.lockFault((name, phase) => {
      if (name === "index.lock" && phase === "before")
        throw Error("cleanup fault");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "error",
      changed: false,
      lockRetained: true,
    });
    expect((await f.reader.snapshot()).operation).toBe("merge");
  });
  it("does not call partial AUTO_MERGE cleanup an unchanged native refusal", async () => {
    const f = await fixture();
    const p = await f.prepare("abort");
    f.intercept(async (args) => {
      if (!args.includes("--abort")) return;
      await fs.unlink(path.join(f.root, ".git/AUTO_MERGE"));
      throw new CommandExitError("partial metadata mutation", 1);
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
    });
    expect(out.recoveryPath).toBeTruthy();
  });
  it("keeps outer cleanup diagnostics after a proven unchanged abort refusal", async () => {
    const f = await fixture();
    const p = await f.prepare("abort");
    f.intercept(async (args) => {
      if (args.includes("--abort"))
        throw new CommandExitError("native refusal", 1);
    });
    f.lockFault((name, phase) => {
      if (name === "config.lock" && phase === "before")
        throw Error("outer cleanup fault");
    });
    const out = await f.actions.execute(p.token);
    expect(out).toMatchObject({
      status: "error",
      changed: false,
      lockRetained: true,
    });
    expect(out.log).toContain("outer cleanup fault");
  });
});

it.each(["scoped", "legacy"] as const)(
  "keeps native %s abort mutation after final inventory EIO",
  async (mode) => {
    const f = await fixture();
    const { GitBranchActions } = await import("../src/host/git-branches");
    const legacy = new GitBranchActions({
      context: async (_id, fn) =>
        fn({
          ...f.ctx,
          scope: "project",
          git: (args, stdin) => f.ctx.git(args, { stdin }),
          privateGit: (args, indexFile) => f.ctx.git(args, { indexFile }),
          remoteGit: async () => {
            throw Error("no network");
          },
        }),
    });
    const p =
      mode === "scoped"
        ? await f.prepare("abort")
        : await legacy.prepare({
            projectId: "project",
            action: "abort-merge",
            revision: (await legacy.inventory("project")).revision,
          });
    const arm = (name: string, phase: string) => {
      if (name === "HEAD.lock" && phase === "after")
        diagnosticFault.statPath = path.join(f.root, ".git/index.lock");
    };
    if (mode === "scoped") f.lockFault(arm);
    else (legacy as any).releaseLockFault = arm;
    const out = await (mode === "scoped" ? f.actions : legacy).execute(p.token);
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
      retainedLocks: ["config.lock"],
      uncheckedLocks: ["index.lock"],
    });
    expect(out.recoveryPath).toBeTruthy();
    expect(out.log).toContain("EIO");
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(await fs.stat(path.join(f.root, ".git/config.lock"))).toBeTruthy();
  },
);
it.each(["continue", "abort", "legacy"] as const)(
  "preserves last known %s recovery path when catch diagnostics hit EIO",
  async (action) => {
    const f = await fixture();
    if (action === "continue") await f.resolve();
    const { GitBranchActions } = await import("../src/host/git-branches");
    const legacy = new GitBranchActions({
      context: async (_id, fn) =>
        fn({
          ...f.ctx,
          scope: "project",
          git: (args, stdin) => f.ctx.git(args, { stdin }),
          privateGit: (args, indexFile) => f.ctx.git(args, { indexFile }),
          remoteGit: async () => {
            throw Error("no network");
          },
        }),
    });
    const p =
      action === "legacy"
        ? await legacy.prepare({
            projectId: "project",
            action: "abort-merge",
            revision: (await legacy.inventory("project")).revision,
          })
        : await f.prepare(action);
    const arm = (name: string, phase: string) => {
      if (name === "config.lock" && phase === "before") {
        diagnosticFault.recovery = true;
        throw Error("outer release failure");
      }
    };
    if (action === "legacy") (legacy as any).releaseLockFault = arm;
    else f.lockFault(arm);
    const out = await (action === "legacy" ? legacy : f.actions).execute(
      p.token,
    );
    expect(out).toMatchObject({
      status: "uncertain",
      changed: true,
      recoveryUnverified: true,
      lockRetained: true,
      retainedLocks: ["config.lock"],
    });
    expect(out.recoveryPath).toBeTruthy();
    expect(out.log).toContain("EIO");
    expect((await f.reader.snapshot()).operation).toBe("none");
  },
);
it("keeps completion lock status unknown instead of absent after cleanup ACK plus EIO", async () => {
  const f = await fixture();
  await f.resolve();
  const p = await f.prepare();
  diagnosticFault.unlinkAck = path.join(f.root, ".git/index.lock");
  const out = await f.actions.execute(p.token);
  expect(out).toMatchObject({
    status: "uncertain",
    changed: true,
    lockRetained: true,
    retainedLocks: ["config.lock"],
    uncheckedLocks: ["index.lock"],
  });
  expect(out.commit).toBe(await f.head());
  expect(out.recoveryPath).toBeTruthy();
});
it("reports final abort journal EIO without losing successful native mutation or recovery", async () => {
  const f = await fixture();
  const p = await f.prepare("abort");
  f.lockFault((name, phase) => {
    if (name === "HEAD.lock" && phase === "after")
      diagnosticFault.journal = true;
  });
  const out = await f.actions.execute(p.token);
  expect(out).toMatchObject({ status: "uncertain", changed: true });
  expect(out.recoveryPath).toBeTruthy();
  expect(out.log).toContain("EIO");
  expect((await f.reader.snapshot()).operation).toBe("none");
});
it("does not claim an unchecked outer config lock is absent after diagnostic EIO", async () => {
  const f = await fixture();
  const p = await f.prepare("abort");
  f.lockFault((name, phase) => {
    if (name === "config.lock" && phase === "before") {
      diagnosticFault.statPath = path.join(f.root, ".git/config.lock");
      throw Error("outer cleanup failure");
    }
  });
  const out = await f.actions.execute(p.token);
  expect(out).toMatchObject({
    status: "uncertain",
    changed: true,
    lockRetained: false,
    retainedLocks: [],
    uncheckedLocks: ["config.lock"],
  });
  expect(out.log).toMatch(/не удалось проверить/);
  expect(out.recoveryPath).toBeTruthy();
  expect(await fs.stat(path.join(f.root, ".git/config.lock"))).toBeTruthy();
});

describe("native abort private metadata publication", () => {
  it("completes native abort without warnings and leaves live HEAD/ref/reflog unchanged", async () => {
    const f = await fixture();
    const headBytes = await fs.readFile(path.join(f.root, ".git/HEAD"));
    const reflog = await fs.readFile(path.join(f.root, ".git/logs/HEAD"));
    const ref = await fs.readFile(path.join(f.root, ".git/refs/heads/main"));
    await f.write("unrelated", "keep draft\n");
    await f.write("untracked", "keep new\n");
    const ticket = await f.prepare("abort");
    const out = await f.actions.execute(ticket.token);
    expect(out, JSON.stringify(out)).toMatchObject({
      status: "success",
      nativeWarning: false,
      lockRetained: false,
    });
    expect(out.log).not.toMatch(/HEAD.lock|update_ref failed|кодом 1/);
    expect(await fs.readFile(path.join(f.root, ".git/HEAD"))).toEqual(
      headBytes,
    );
    expect(await fs.readFile(path.join(f.root, ".git/logs/HEAD"))).toEqual(
      reflog,
    );
    expect(
      await fs.readFile(path.join(f.root, ".git/refs/heads/main")),
    ).toEqual(ref);
    expect(await f.read("conflict")).toBe("main\n");
    expect(await f.read("unrelated")).toBe("keep draft\n");
    expect(await f.read("untracked")).toBe("keep new\n");
    const command = f.calls.find((args) => args.includes("--abort"))!;
    expect(command.find((arg) => arg.startsWith("--git-dir="))).toMatch(
      /goga-abort-.*\/native$/,
    );
    for (const lock of ["HEAD.lock", "index.lock", "refs/heads/main.lock"])
      await expect(fs.stat(path.join(f.root, ".git", lock))).rejects.toThrow();
    expect(await f.head("ORIG_HEAD")).toBe(f.original);
  });
  it("does not remove somebody else's HEAD lock or attempt native abort", async () => {
    const f = await fixture();
    const ticket = await f.prepare("abort");
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    await f.write(".git/HEAD.lock", "foreign lock");
    const out = await f.actions.execute(ticket.token);
    expect(out).toMatchObject({ status: "error", changed: false });
    expect(await f.read(".git/HEAD.lock")).toBe("foreign lock");
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(f.calls.some((args) => args.includes("--abort"))).toBe(false);
  });
  it("never upgrades a nonzero exit after native restoration into success", async () => {
    const f = await fixture();
    const ticket = await f.prepare("abort");
    const index = await fs.readFile(path.join(f.root, ".git/index"));
    f.intercept(async (args) => {
      if (!args.includes("--abort")) return;
      const directory = args
        .find((arg) => arg.startsWith("--git-dir="))!
        .slice("--git-dir=".length);
      await withTrustedGitIndex(
        path.join(path.dirname(directory), "index"),
        () => f.git(args),
      );
      throw new CommandExitError(
        "fixture nonzero exit after native restore",
        1,
      );
    });
    const out = await f.actions.execute(ticket.token);
    expect(out, JSON.stringify(out)).toMatchObject({
      status: "uncertain",
      changed: true,
      lockRetained: true,
      nativeWarning: false,
    });
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    expect(await f.read(".git/MERGE_HEAD")).toBe(f.source + "\n");
    expect(
      await fs.stat(path.join(out.recoveryPath, "original-index")),
    ).toBeTruthy();
  });
  it("carries settings from gitdir-conditional includes into native abort", async () => {
    const f = await fixture();
    await f.write(
      ".git/abort-policy",
      "[core]\n  autocrlf = false\n[fixture]\n  abortpolicy = original-owner\n",
    );
    await f.git([
      "config",
      `includeIf.gitdir:${f.root}/.git.path`,
      "abort-policy",
    ]);
    const ticket = await f.prepare("abort");
    const out = await f.actions.execute(ticket.token);
    expect(out, JSON.stringify(out)).toMatchObject({
      status: "success",
      nativeWarning: false,
    });
    const command = f.calls.find((args) => args.includes("--abort"))!;
    expect(command).toContain("fixture.abortpolicy=original-owner");
    expect(command.some((arg) => arg.startsWith("includeif."))).toBe(false);
  });
});

it("aborts a SHA-256 repository using matching private object format", async () => {
  const f = await fixture("project", "sha256");
  const out = await f.actions.execute((await f.prepare("abort")).token);
  expect(out, JSON.stringify(out)).toMatchObject({
    status: "success",
    nativeWarning: false,
    lockRetained: false,
  });
  expect(await f.head()).toBe(f.original);
  expect(await f.read("conflict")).toBe("main\n");
  expect((await f.reader.snapshot()).operation).toBe("none");
});
it("retains recovery instead of publishing over concurrently changed merge metadata", async () => {
  const f = await fixture();
  const index = await fs.readFile(path.join(f.root, ".git/index"));
  const ticket = await f.prepare("abort");
  let changed = false;
  f.intercept(async (args) => {
    if (
      !changed &&
      args.includes("ls-files") &&
      args.some((arg) => /goga-abort-.*\/native$/.test(arg))
    ) {
      changed = true;
      await f.write(".git/MERGE_MSG", "external metadata change\n");
    }
  });
  const out = await f.actions.execute(ticket.token);
  expect(changed).toBe(true);
  expect(out, JSON.stringify(out)).toMatchObject({
    status: "uncertain",
    changed: true,
    lockRetained: true,
  });
  expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
  expect(await f.read(".git/MERGE_MSG")).toBe("external metadata change\n");
  expect(await f.read(".git/MERGE_HEAD")).toBe(f.source + "\n");
});

it("keeps recovery and pins when live merge metadata cleanup fails after index publication", async () => {
  const f = await fixture();
  const ticket = await f.prepare("abort");
  diagnosticFault.mergeCleanup = path.join(f.root, ".git/MERGE_HEAD");
  const out = await f.actions.execute(ticket.token);
  expect(out, JSON.stringify(out)).toMatchObject({
    status: "uncertain",
    changed: true,
    lockRetained: true,
  });
  expect(out.log).toContain("fixture merge cleanup EIO");
  expect(await f.read(".git/MERGE_HEAD")).toBe(f.source + "\n");
  expect(
    await fs.stat(path.join(out.recoveryPath, "original-index")),
  ).toBeTruthy();
  const journal = JSON.parse(
    await fs.readFile(path.join(out.recoveryPath, "journal.json"), "utf8"),
  );
  expect(journal.published).toBe(true);
  await expect(f.actions.execute(ticket.token)).rejects.toThrow();
});
