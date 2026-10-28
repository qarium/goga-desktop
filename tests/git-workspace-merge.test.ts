import { createNativeGitCapability } from "../src/host/git-native-context";
import { NativeGitJournal } from "../src/host/git-native-journal";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { CommandExitError, NodeRunner } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import {
  GitBranchActions,
  type GitBranchContext,
} from "../src/host/git-branches";
vi.setConfig({ testTimeout: 30000 });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const dir = await fs.mkdtemp("/private/tmp/goga-merge-");
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
  const runner = new NodeRunner(15000, env);
  cleanup.push(() => runner.dispose());
  const git = (args: string[], stdin?: string) =>
    runner.command(
      "git",
      ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
      root,
      env,
      stdin,
    );
  const write = (name: string, content: string) =>
    fs.writeFile(path.join(root, name), content);
  const read = (name: string) => fs.readFile(path.join(root, name), "utf8");
  const head = async () => (await git(["rev-parse", "HEAD"])).stdout.trim();
  const commit = async (name: string, content: string) => {
    await write(name, content);
    await git(["add", "--", name]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", name]);
    return head();
  };
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await commit("base", "base\n");
  await commit("unrelated", "original\n");
  const base = await head();
  await git(["checkout", "-b", "source"]);
  const source = await commit("incoming", "source\n");
  await git(["checkout", "main"]);
  const reader = new GitWorkspaceReader({
    root,
    scope: "project",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  let ownerKey = "owner",
    now = 1000,
    intercept: ((args: string[]) => Promise<void>) | undefined;
  const calls: string[][] = [];
  const ctx: GitBranchContext = {
    native: createNativeGitCapability({
      root,
      env,
      journal: new NativeGitJournal({
        directory: path.join(dir, "journal"),
        now: () => now,
      }),
      owner: async () => ({
        scope: "project",
        registryRevision: ownerKey,
        projectPath: root,
      }),
      runner: {
        commandBytes: async (command) => {
          const args = [...command.args];
          calls.push(args);
          await intercept?.(args);
          return runner.commandBytes(command);
        },
      },
    }),

    root,
    scope: "project",
    ownerKey,
    verify: async () => {},
    snapshot: () => reader.snapshot(),
    git: async (args, stdin) => {
      calls.push(args);
      await intercept?.(args);
      return git(args, stdin);
    },
    privateGit: async (args, indexFile) => {
      calls.push(args);
      await intercept?.(args);
      return withTrustedGitIndex(indexFile, () => git(args));
    },
    remoteGit: async () => {
      throw Error("Network forbidden");
    },
  };
  const createActions = () =>
    new GitBranchActions({
      context: async (_id, fn) => fn({ ...ctx, ownerKey }),
      now: () => now,
    });
  const actions = createActions();
  const prepare = async (
    action = "merge",
    ref = "refs/heads/source",
    a = actions,
  ) =>
    a.prepare({
      projectId: "project",
      revision: (await a.inventory("project")).revision,
      action,
      ...(action === "merge" ? { ref } : {}),
    } as any);
  const conflict = async () => {
    await git(["checkout", "source"]);
    await commit("base", "source change\n");
    await git(["checkout", "main"]);
    await commit("base", "main change\n");
  };
  return {
    dir,
    root,
    home,
    git,
    write,
    read,
    head,
    commit,
    base,
    source,
    actions,
    createActions,
    prepare,
    conflict,
    calls,
    reader,
    setOwner: (v: string) => {
      ownerKey = v;
    },
    setNow: (v: number) => {
      now = v;
    },
    intercept: (fn: typeof intercept) => {
      intercept = fn;
    },
  };
}
describe("primary explicit merge", () => {
  it("fast-forwards the current branch to an exact remote-tracking commit offline without checkout", async () => {
    const f = await fixture();
    await f.git(["update-ref", "refs/remotes/origin/source", f.source]);
    const p = await f.prepare("merge", "refs/remotes/origin/source");
    expect(p).toMatchObject({
      action: "merge",
      fromRef: "refs/heads/main",
      fromOid: f.base,
      sourceRef: "refs/remotes/origin/source",
      sourceOid: f.source,
      toRef: "refs/heads/main",
      toOid: f.base,
      autoCommit: true,
      mergeMode: "ff-or-commit",
      switchesBranch: false,
      createsBranch: false,
      hooks: "disabled",
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
      changed: true,
    });
    expect(await f.head()).toBe(f.source);
    expect((await f.reader.snapshot()).branch).toBe("main");
    expect(
      f.calls.some(
        (args) =>
          args.includes("checkout") ||
          args.includes("switch") ||
          args.includes("fetch"),
      ),
    ).toBe(false);
  });
  it("automatically commits a clean non-fast-forward merge with the repository author and disabled hooks", async () => {
    const f = await fixture();
    const previous = await f.commit("local", "local\n");
    const marker = path.join(f.dir, "hook-ran");
    for (const hook of [
      "pre-merge-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-merge",
    ])
      await fs.writeFile(
        path.join(f.root, ".git/hooks", hook),
        `#!/bin/sh\ntouch '${marker}'\n`,
        { mode: 0o755 },
      );
    await f.git([
      "config",
      "branch.main.mergeOptions",
      "--squash --no-commit --autostash --strategy=evil",
    ]);
    await f.git(["config", "merge.ff", "only"]);
    await f.git(["config", "merge.autoStash", "true"]);
    const p = await f.prepare();
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "success",
    });
    expect(
      (
        await f.git(["show", "-s", "--format=%P%n%an <%ae>", "HEAD"])
      ).stdout.trim(),
    ).toBe(`${previous} ${f.source}\nFixture <fixture@example.invalid>`);
    expect((await f.reader.snapshot()).operation).toBe("none");
    await expect(fs.stat(marker)).rejects.toThrow();
    expect(
      f.calls.find((args) => args.includes("merge") && args.includes(f.source)),
    ).not.toContain("--no-gpg-sign");
  });
  it("preserves unrelated unstaged and untracked edits without including them in the merge commit", async () => {
    const f = await fixture();
    await f.commit("local", "local\n");
    await f.write("unrelated", "my draft\n");
    await f.write("untracked", "new draft\n");
    expect(await f.actions.execute((await f.prepare()).token)).toMatchObject({
      status: "success",
    });
    expect(await f.read("unrelated")).toBe("my draft\n");
    expect(await f.read("untracked")).toBe("new draft\n");
    expect((await f.git(["show", "HEAD:unrelated"])).stdout).toBe("original\n");
  });
  it.each(["overlap", "untracked", "ignored", "staged"])(
    "reports native %s overwrite/index refusal without conflicts, data loss or rollback",
    async (kind) => {
      const f = await fixture();
      await f.commit("local", "local\n");
      let file = "incoming";
      if (kind === "overlap") {
        await f.git(["checkout", "source"]);
        await f.commit("base", "upstream\n");
        await f.git(["checkout", "main"]);
        file = "base";
      }
      if (kind === "ignored")
        await fs.writeFile(
          path.join(f.root, ".git/info/exclude"),
          "incoming\n",
        );
      if (kind === "staged") file = "unrelated";
      await f.write(file, "keep my data\n");
      if (kind === "staged") await f.git(["add", "--", file]);
      const before = await f.head();
      if (kind === "staged") {
        await expect(f.prepare()).rejects.toThrow(/staged/);
        expect(f.calls.some((args) => args.includes("merge"))).toBe(false);
      } else {
        const result = await f.actions.execute((await f.prepare()).token);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "error",
          changed: false,
        });
      }
      expect(await f.head()).toBe(before);
      expect(await f.read(file)).toBe("keep my data\n");
      expect((await f.reader.snapshot()).operation).toBe("none");
      expect(f.calls.some((args) => args.includes("reset"))).toBe(false);
    },
  );
  it("preserves unrelated ignored files while protecting ORT directory-rename destinations", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, "old"));
    await f.commit("old/existing", "same\n");
    await f.git(["checkout", "source"]);
    await f.git(["merge", "--no-edit", "main"]);
    await f.git(["config", "merge.directoryRenames", "true"]);
    await f.commit("old/new", "incoming renamed\n");
    await f.git(["checkout", "main"]);
    await f.git(["mv", "old", "renamed"]);
    await f.git(["commit", "-m", "rename directory"]);
    await fs.writeFile(
      path.join(f.root, ".git/info/exclude"),
      "renamed/new\nignored-unrelated\n",
    );
    await f.write("renamed/new", "keep ignored data\n");
    await f.write("ignored-unrelated", "keep unrelated\n");
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(await f.read("renamed/new")).toBe("keep ignored data\n");
    await fs.rm(path.join(f.root, "renamed/new"));
    expect(await f.actions.execute((await f.prepare()).token)).toMatchObject({
      status: "success",
    });
    expect(await f.read("ignored-unrelated")).toBe("keep unrelated\n");
  });
  it.each(["directory", "symlink"])(
    "protects ignored %s destination collisions without following symlinks",
    async (kind) => {
      const f = await fixture();
      await f.commit("local", "local\n");
      await fs.writeFile(path.join(f.root, ".git/info/exclude"), "incoming\n");
      const outside = path.join(f.dir, "outside");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "keep"), "outside data");
      if (kind === "symlink")
        await fs.symlink(outside, path.join(f.root, "incoming"));
      else {
        await fs.mkdir(path.join(f.root, "incoming"));
        await f.write("incoming/keep", "inside data");
      }
      const result = await f.actions.execute((await f.prepare()).token);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "error",
        changed: false,
      });
      expect(await fs.readFile(path.join(outside, "keep"), "utf8")).toBe(
        "outside data",
      );
      if (kind === "directory")
        expect(await f.read("incoming/keep")).toBe("inside data");
      else
        expect(await fs.readlink(path.join(f.root, "incoming"))).toBe(outside);
    },
  );
  it("protects ignored paths synthesized for a file/directory conflict on the current side", async () => {
    const f = await fixture();
    await f.commit("collision", "current file\n");
    await f.git(["checkout", "source"]);
    await fs.mkdir(path.join(f.root, "collision"));
    await f.commit("collision/child", "incoming child\n");
    await f.git(["checkout", "main"]);
    await fs.writeFile(
      path.join(f.root, ".git/info/exclude"),
      "collision~HEAD\n",
    );
    await f.write("collision~HEAD", "keep synthetic-path data\n");
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(await f.read("collision~HEAD")).toBe("keep synthetic-path data\n");
  });
  it("revalidates changed content after merge-tree without starting a native merge", async () => {
    const f = await fixture();
    const p = await f.prepare();
    f.intercept(async (args) => {
      if (args.includes("merge-tree"))
        await f.write("unrelated", "late edit\n");
    });
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({ status: "uncertain", changed: false });
    expect(result.recoveryPath).toBeTruthy();
    await expect(f.prepare()).rejects.toThrow(/Журнал/);
    expect(await f.head()).toBe(f.base);
    expect(await f.read("unrelated")).toBe("late edit\n");
    expect(f.calls.some((args) => args.includes("merge"))).toBe(false);
  });
  it("fails closed on invalid preflight output without reporting real conflicts", async () => {
    const f = await fixture();
    const p = await f.prepare();
    f.intercept(async (args) => {
      if (args.includes("merge-tree"))
        throw new CommandExitError("bad preflight", 1, "malformed\0");
    });
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(f.calls.some((args) => args.includes("merge"))).toBe(false);
  });
  it.each(["info", "configured-global", "default-global", "ignored-worktree"])(
    "rejects tickets after effective %s attributes change",
    async (kind) => {
      const f = await fixture();
      await f.conflict();
      let filename = path.join(f.root, ".git/info/attributes");
      if (kind === "configured-global") {
        filename = path.join(f.home, "explicit-attributes");
        await f.git(["config", "core.attributesFile", filename]);
      }
      if (kind === "default-global") {
        await fs.mkdir(path.join(f.home, "git"));
        filename = path.join(f.home, "git/attributes");
      }
      if (kind === "ignored-worktree") {
        await fs.writeFile(
          path.join(f.root, ".git/info/exclude"),
          ".gitattributes\n",
        );
        filename = path.join(f.root, ".gitattributes");
      }
      const before = await f.head();
      const p = await f.prepare();
      await fs.writeFile(filename, "base merge=union\n");
      const result = await f.actions.execute(p.token);
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "error",
        changed: false,
      });
      expect(await f.head()).toBe(before);
      expect(await f.read("base")).toBe("main change\n");
      expect(f.calls.some((args) => args.includes("merge"))).toBe(false);
    },
  );
  it("rechecks late ignored destinations after final capture before native merge", async () => {
    const f = await fixture();
    await f.commit("local", "local\n");
    await fs.writeFile(path.join(f.root, ".git/info/exclude"), "incoming\n");
    const before = await f.head();
    const p = await f.prepare();
    let preflight = false,
      injected = false;
    f.intercept(async (args) => {
      if (args.includes("merge-tree")) preflight = true;
      else if (
        preflight &&
        !injected &&
        args.includes("config") &&
        args.includes("--list")
      ) {
        injected = true;
        await f.write("incoming", "late ignored draft\n");
      }
    });
    const result = await f.actions.execute(p.token);
    expect(injected).toBe(true);
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "error",
      changed: false,
    });
    expect(await f.head()).toBe(before);
    expect(await f.read("incoming")).toBe("late ignored draft\n");
    expect(f.calls.some((args) => args.includes("merge"))).toBe(false);
  });
  it.each(["modified", "deleted", "unrelated-refusal", "symlink"])(
    "rejects tracked file-to-directory replacement before native %s merge cleanup",
    async (kind) => {
      const f = await fixture();
      if (kind === "symlink") {
        await fs.rm(path.join(f.root, "base"));
        await fs.symlink("unrelated", path.join(f.root, "base"));
        await f.git(["add", "base"]);
        await f.git(["commit", "-m", "base symlink"]);
        await f.git(["checkout", "source"]);
        await f.git(["merge", "--no-edit", "main"]);
        await f.git(["checkout", "main"]);
      }
      await f.commit("local", "divergent\n");
      await f.git(["checkout", "source"]);
      if (kind === "deleted") {
        await f.git(["rm", "base"]);
        await f.git(["commit", "-m", "delete base"]);
      } else if (kind !== "unrelated-refusal") {
        if (kind === "symlink") await fs.rm(path.join(f.root, "base"));
        await f.commit("base", "source changed\n");
      }
      await f.git(["checkout", "main"]);
      await fs.rm(path.join(f.root, "base"));
      await fs.mkdir(path.join(f.root, "base"));
      await f.write("base/data", "USER DATA\n");
      await fs.writeFile(path.join(f.root, ".git/info/exclude"), "base/\n");
      if (kind === "unrelated-refusal")
        await f.write("incoming", "other collision\n");
      const before = await f.head();
      await expect(f.prepare()).rejects.toThrow();
      expect(await f.head()).toBe(before);
      expect(await f.read("base/data")).toBe("USER DATA\n");
      expect(f.calls.some((args) => args.includes("merge"))).toBe(false);
    },
  );
  it("returns only authentic conflicts and keeps native merge state available after restart", async () => {
    const f = await fixture();
    await f.conflict();
    const previous = await f.head();
    const p = await f.prepare();
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "conflict",
      changed: true,
      conflictCount: 1,
    });
    expect(await f.read(".git/MERGE_HEAD")).toBe(`${p.sourceOid}\n`);
    expect(await f.head()).toBe(previous);
    expect((await f.git(["ls-files", "--unmerged"])).stdout).toContain("base");
    const reopened = f.createActions();
    expect((await reopened.inventory("project")).operation).toBe("merge");
    await expect(
      f.prepare("merge", "refs/heads/source", reopened),
    ).rejects.toThrow(/операци|конфликт/i);
  });
  it("keeps signing failures as uncertain pending merges rather than conflict or unsigned success", async () => {
    const f = await fixture();
    await f.commit("local", "local\n");
    await f.git(["config", "commit.gpgSign", "true"]);
    await f.git(["config", "gpg.program", "/usr/bin/false"]);
    const before = await f.head();
    expect(await f.actions.execute((await f.prepare()).token)).toMatchObject({
      status: "uncertain",
      changed: true,
    });
    expect(await f.head()).toBe(before);
    expect((await f.reader.snapshot()).operation).toBe("merge");
    expect((await f.git(["ls-files", "--unmerged"])).stdout).toBe("");
  });
  it.each(["filter.bad.clean", "filter.bad.process", "merge.bad.driver"])(
    "rejects external %s before execution",
    async (key) => {
      const f = await fixture();
      const marker = path.join(f.dir, "external-ran");
      await f.git(["config", key, `touch '${marker}'`]);
      await f.write(".gitattributes", "* filter=bad merge=bad\n");
      await expect(f.prepare()).rejects.toThrow(/фильтр|driver|драйвер/i);
      await expect(fs.stat(marker)).rejects.toThrow();
    },
  );
  it("allows reading a source checked out in another worktree but refuses a target owned twice", async () => {
    const f = await fixture();
    const sourceWorktree = path.join(f.dir, "source-wt");
    await f.git(["worktree", "add", sourceWorktree, "source"]);
    expect(await f.actions.execute((await f.prepare()).token)).toMatchObject({
      status: "success",
    });
    expect(
      await fs.readFile(path.join(sourceWorktree, "incoming"), "utf8"),
    ).toBe("source\n");
    await f.git([
      "worktree",
      "add",
      "--force",
      path.join(f.dir, "main-wt"),
      "main",
    ]);
    await expect(f.prepare()).rejects.toThrow(/рабоч|worktree|копи/i);
  });
  it.each(["source", "head", "content", "index", "config", "owner", "expiry"])(
    "consumes and rejects tickets after %s changes",
    async (kind) => {
      const f = await fixture();
      await f.write("unrelated", "draft\n");
      const p = await f.prepare();
      if (kind === "source")
        await f.git(["update-ref", "refs/heads/source", f.base]);
      if (kind === "head")
        await f.git(["update-ref", "refs/heads/main", f.source]);
      if (kind === "content") await f.write("unrelated", "other\n");
      if (kind === "index") await f.git(["add", "unrelated"]);
      if (kind === "config") await f.git(["config", "merge.ff", "false"]);
      if (kind === "owner") f.setOwner("new owner");
      if (kind === "expiry") {
        f.setNow(p.expiresAt);
        await expect(f.actions.execute(p.token)).rejects.toThrow();
      } else
        expect(await f.actions.execute(p.token)).toMatchObject({
          status: "error",
          changed: false,
        });
      await expect(f.actions.execute(p.token)).rejects.toThrow();
    },
  );
});
describe("confirmed native merge abort", () => {
  it.each(["config.lock"])(
    "reports native abort config cleanup failure after mutation: %s",
    async (name) => {
      const f = await fixture();
      await f.conflict();
      await f.actions.execute((await f.prepare()).token);
      const p = await f.prepare("abort-merge");
      (f.actions as any).nativeMerges.releaseLockFault = (
        lock: string,
        phase: string,
      ) => {
        if (lock === name && phase === "before") throw Error("release fault");
      };
      const out = await f.actions.execute(p.token);
      expect(out).toMatchObject({
        status: "uncertain",
        changed: true,
        lockRetained: true,
      });
      expect(out.retainedLocks).toContain(name);
      expect(out.recoveryPath).toBeTruthy();
      expect((await f.reader.snapshot()).operation).toBe("none");
    },
  );
  it.each(["same", "different"])(
    "native abort detects %s-OID external HEAD replacement and retains recovery without fake HEAD locks",
    async (kind) => {
      const f = await fixture();
      await f.conflict();
      await f.actions.execute((await f.prepare()).token);
      const head = await f.head();
      await f.git(["branch", "other", kind === "same" ? head : "source"]);
      const p = await f.prepare("abort-merge");
      f.intercept(async (args) => {
        if (!args.includes("--abort")) return;
        await expect(
          fs.stat(path.join(f.root, ".git/HEAD.lock")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await f.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
      });
      const out = await f.actions.execute(p.token);
      expect(out, JSON.stringify(out)).toMatchObject({
        status: "uncertain",
        changed: true,
      });
      expect(out.recoveryPath).toBeTruthy();
      expect(
        (await f.git(["rev-parse", "refs/heads/main"])).stdout.trim(),
      ).toBe(head);
      expect((await f.reader.snapshot()).branch).toBe("other");
      await expect(f.actions.execute(p.token)).rejects.toThrow();
      await expect(f.prepare()).rejects.toThrow(/Журнал/);
      expect(f.calls.some((args) => args.includes("reset"))).toBe(false);
    },
  );
  it("aborts a reopened authentic merge and preserves unrelated edits", async () => {
    const f = await fixture();
    await f.conflict();
    await f.write("unrelated", "keep draft\n");
    await f.actions.execute((await f.prepare()).token);
    const reopened = f.createActions();
    const p = await f.prepare("abort-merge", "", reopened);
    expect(p).toMatchObject({
      mergeMode: "abort",
      autoCommit: false,
      sourceRef: null,
      toRef: "refs/heads/main",
    });
    expect(await reopened.execute(p.token)).toMatchObject({
      status: "success",
      changed: true,
    });
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(await f.read("base")).toBe("main change\n");
    expect(await f.read("unrelated")).toBe("keep draft\n");
    expect(f.calls.find((args) => args.includes("--abort"))).toContain("merge");
    expect(f.calls.some((args) => args.includes("reset"))).toBe(false);
  });
  it.each(["file", "directory", "symlink"])(
    "refuses abort that would overwrite a recreated ignored %s",
    async (kind) => {
      const f = await fixture();
      await f.conflict();
      await f.git(["checkout", "source"]);
      await f.git(["rm", "unrelated"]);
      await f.git(["commit", "-m", "delete unrelated"]);
      await f.git(["checkout", "main"]);
      await f.actions.execute((await f.prepare()).token);
      await fs.writeFile(path.join(f.root, ".git/info/exclude"), "unrelated\n");
      const outside = path.join(f.dir, "outside");
      await fs.writeFile(outside, "OUTSIDE DATA\n");
      if (kind === "file") await f.write("unrelated", "NEW USER DATA\n");
      else if (kind === "directory") {
        await fs.mkdir(path.join(f.root, "unrelated"));
        await f.write("unrelated/data", "NEW USER DATA\n");
      } else await fs.symlink(outside, path.join(f.root, "unrelated"));
      await expect(f.prepare("abort-merge")).rejects.toThrow();
      expect((await f.reader.snapshot()).operation).toBe("merge");
      expect(f.calls.some((args) => args.includes("--abort"))).toBe(false);
      if (kind === "file")
        expect(await f.read("unrelated")).toBe("NEW USER DATA\n");
      else if (kind === "directory")
        expect(await f.read("unrelated/data")).toBe("NEW USER DATA\n");
      else
        expect(await fs.readlink(path.join(f.root, "unrelated"))).toBe(outside);
      expect(await fs.readFile(outside, "utf8")).toBe("OUTSIDE DATA\n");
    },
  );
  it.each(["modified", "new", "deleted", "renamed"])(
    "refuses abort with unrelated %s staged edits without losing index or content",
    async (kind) => {
      const f = await fixture();
      await f.conflict();
      await f.actions.execute((await f.prepare()).token);
      if (kind === "modified") {
        await f.write("unrelated", "STAGED USER DATA\n");
        await f.git(["add", "unrelated"]);
      }
      if (kind === "new") {
        await f.write("new-file", "STAGED USER DATA\n");
        await f.git(["add", "new-file"]);
      }
      if (kind === "deleted") await f.git(["rm", "unrelated"]);
      if (kind === "renamed")
        await f.git(["mv", "unrelated", "renamed-user-file"]);
      const index = (await f.git(["ls-files", "--stage", "-z"])).stdout;
      await expect(f.prepare("abort-merge")).rejects.toThrow();
      expect((await f.git(["ls-files", "--stage", "-z"])).stdout).toBe(index);
      expect((await f.reader.snapshot()).operation).toBe("merge");
      expect(f.calls.some((args) => args.includes("--abort"))).toBe(false);
      if (kind === "modified")
        expect(await f.read("unrelated")).toBe("STAGED USER DATA\n");
      if (kind === "new")
        expect(await f.read("new-file")).toBe("STAGED USER DATA\n");
    },
  );
  it("allows explicitly discarding a staged resolution of an original conflict", async () => {
    const f = await fixture();
    await f.conflict();
    await f.actions.execute((await f.prepare()).token);
    await f.write("base", "manual conflict resolution\n");
    await f.git(["add", "base"]);
    expect(
      await f.actions.execute((await f.prepare("abort-merge")).token),
    ).toMatchObject({ status: "success" });
    expect(await f.read("base")).toBe("main change\n");
  });
  it.each(["missing", "mismatched-policy"])(
    "refuses abort without trustworthy original merge evidence: %s",
    async (kind) => {
      const f = await fixture();
      await f.conflict();
      await f.actions.execute((await f.prepare()).token);
      if (kind === "missing") await fs.rm(path.join(f.root, ".git/AUTO_MERGE"));
      else await f.write(".git/info/attributes", "base merge=union\n");
      await expect(f.prepare("abort-merge")).rejects.toThrow();
      expect((await f.reader.snapshot()).operation).toBe("merge");
      expect(f.calls.some((args) => args.includes("--abort"))).toBe(false);
    },
  );
  it("supports native abort after a clean signing failure with intact original merge evidence", async () => {
    const f = await fixture();
    await f.commit("local", "local\n");
    await f.git(["config", "commit.gpgSign", "true"]);
    await f.git(["config", "gpg.program", "/usr/bin/false"]);
    expect(await f.actions.execute((await f.prepare()).token)).toMatchObject({
      status: "uncertain",
    });
    expect(
      await f.actions.execute((await f.prepare("abort-merge")).token),
    ).toMatchObject({ status: "success" });
    expect((await f.reader.snapshot()).operation).toBe("none");
  });
  it.each([
    "none",
    "ignored",
    "untracked",
    "symlink",
    "nested-repo",
    "changed-tracked",
  ])(
    "aborts only proven generated D/F directories without losing %s additions",
    async (kind) => {
      const f = await fixture();
      await f.commit("collision", "HEAD file\n");
      await f.git(["checkout", "source"]);
      await fs.mkdir(path.join(f.root, "collision"));
      await f.commit("collision/child", "source child\n");
      await f.git(["checkout", "main"]);
      expect(await f.actions.execute((await f.prepare()).token)).toMatchObject({
        status: "conflict",
      });
      if (kind === "ignored")
        await fs.writeFile(
          path.join(f.root, ".git/info/exclude"),
          "collision/private\n",
        );
      if (kind === "ignored" || kind === "untracked")
        await f.write("collision/private", "KEEP PRIVATE\n");
      if (kind === "symlink")
        await fs.symlink(f.home, path.join(f.root, "collision/private"));
      if (kind === "nested-repo")
        await fs.mkdir(path.join(f.root, "collision/.git"));
      if (kind === "changed-tracked")
        await f.write("collision/child", "KEEP CHILD EDIT\n");
      if (kind === "none") {
        const result = await f.actions.execute(
          (await f.prepare("abort-merge")).token,
        );
        expect(result).toMatchObject({ status: "success", changed: true });
      } else await expect(f.prepare("abort-merge")).rejects.toThrow();
      if (kind === "none")
        expect(await f.read("collision")).toBe("HEAD file\n");
      else {
        expect((await f.reader.snapshot()).operation).toBe("merge");
        expect(f.calls.some((args) => args.includes("--abort"))).toBe(false);
        if (kind === "ignored" || kind === "untracked")
          expect(await f.read("collision/private")).toBe("KEEP PRIVATE\n");
        if (kind === "symlink")
          expect(
            await fs.readlink(path.join(f.root, "collision/private")),
          ).toBe(f.home);
        if (kind === "nested-repo")
          expect(
            (await fs.stat(path.join(f.root, "collision/.git"))).isDirectory(),
          ).toBe(true);
        if (kind === "changed-tracked")
          expect(await f.read("collision/child")).toBe("KEEP CHILD EDIT\n");
      }
    },
  );
  it("reports abort refusal, preserves the merge and allows a new explicit recovery preview", async () => {
    const f = await fixture();
    await f.conflict();
    await f.actions.execute((await f.prepare()).token);
    await f.write("incoming", "post-conflict edit\n");
    await expect(f.prepare("abort-merge")).rejects.toThrow();
    expect(f.calls.some((args) => args.includes("--abort"))).toBe(false);
    expect((await f.reader.snapshot()).operation).toBe("merge");
    expect(await f.read("incoming")).toBe("post-conflict edit\n");
    await f.write("incoming", "source\n");
    await f.git(["add", "--", "incoming"]);
    const recovery = await f.actions.execute(
      (await f.prepare("abort-merge")).token,
    );
    expect(recovery, JSON.stringify(recovery)).toMatchObject({
      status: "success",
    });
  });
  it.each(["none", "autostash", "cherry-pick", "rebase", "orig-head"])(
    "rejects unsafe or inapplicable abort: %s",
    async (kind) => {
      const f = await fixture();
      if (kind !== "none") {
        await f.conflict();
        await f.actions.execute((await f.prepare()).token);
      }
      if (kind === "autostash")
        await f.write(".git/MERGE_AUTOSTASH", `${f.base}\n`);
      if (kind === "cherry-pick")
        await f.write(".git/CHERRY_PICK_HEAD", `${f.base}\n`);
      if (kind === "rebase")
        await fs.mkdir(path.join(f.root, ".git/rebase-merge"));
      if (kind === "orig-head") await f.write(".git/ORIG_HEAD", `${f.base}\n`);
      await expect(f.prepare("abort-merge")).rejects.toThrow();
    },
  );
  it("binds the abort ticket to native merge metadata and consumes a stale confirmation", async () => {
    const f = await fixture();
    await f.conflict();
    await f.actions.execute((await f.prepare()).token);
    const p = await f.prepare("abort-merge");
    await f.write(".git/MERGE_MSG", "externally changed\n");
    await expect(f.actions.execute(p.token)).rejects.toThrow();
    expect(f.calls.some((args) => args.includes("--abort"))).toBe(false);
    expect((await f.reader.snapshot()).operation).toBe("merge");
    await expect(f.actions.execute(p.token)).rejects.toThrow();
  });
});
