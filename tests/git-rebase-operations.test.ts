import { afterEach, describe, expect, it, vi } from "vitest";
const ioFault = vi.hoisted(() => ({
  configLockSync: false,
  recoveryStat: false,
  descriptors: new Map<number, string>(),
}));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (ioFault.recoveryStat && /\/goga-abort-[^/]+$/.test(String(args[0])))
        throw Object.assign(Error("fixture recovery stat EIO"), {
          code: "EIO",
        });
      return actual.lstatSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      ioFault.descriptors.set(fd, String(args[0]));
      return fd;
    },
    closeSync: (fd: number) => {
      ioFault.descriptors.delete(fd);
      return actual.closeSync(fd);
    },
    fsyncSync: (fd: number) => {
      if (
        ioFault.configLockSync &&
        ioFault.descriptors.get(fd)?.endsWith("/.git/config.lock")
      ) {
        ioFault.configLockSync = false;
        throw Object.assign(Error("fixture lock fsync EIO"), { code: "EIO" });
      }
      return actual.fsyncSync(fd);
    },
  };
});
import * as fs from "node:fs/promises";
import {
  writeFileSync,
  readdirSync,
  appendFileSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { NodeRunner, CommandExitError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { withTrustedGitIndex } from "../src/host/git-index-scope";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  ioFault.configLockSync = false;
  ioFault.recoveryStat = false;
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(
  backend = "merge",
  later?: string,
  conflictName = "conflict",
  second = false,
  upstreamOnly = false,
  futureEntries?: Record<string, string>,
) {
  const base = await fs.mkdtemp("/private/tmp/goga-rebase-abort-");
  cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo"),
    home = path.join(base, "home");
  await fs.mkdir(root);
  await fs.mkdir(home);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = new NodeRunner(10000, env);
  cleanups.push(() => runner.dispose());
  const git = (args: string[], stdin?: string) =>
    runner.command(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "protocol.allow=never",
        ...args,
      ],
      root,
      env,
      stdin,
    );
  const write = async (n: string, v: string) => {
    await fs.mkdir(path.dirname(path.join(root, n)), { recursive: true });
    await fs.writeFile(path.join(root, n), v);
  };
  const read = (n: string) => fs.readFile(path.join(root, n), "utf8");
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await write(conflictName, "base\n");
  await write("other", "unchanged\n");
  await write(".gitignore", "ignored\n");
  if (second) await write("second-conflict", "base\n");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["branch", "feature"]);
  await write(conflictName, "upstream\n");
  if (second) await write("second-conflict", "upstream\n");
  if (upstreamOnly) {
    await write("upstream-dir/only", "upstream\n");
    await git(["add", "upstream-dir/only"]);
  }
  await git(["commit", "-am", "upstream"]);
  await git(["checkout", "feature"]);
  await write(conflictName, "topic\n");
  if (second) await write("second-conflict", "topic\n");
  await git(["commit", "-am", "topic"]);
  const future =
    futureEntries ??
    (later
      ? {
          [later]:
            later === ".gitattributes"
              ? "* filter=fixture-danger\n"
              : "original later content\n",
        }
      : {});
  if (Object.keys(future).length) {
    for (const [name, content] of Object.entries(future)) {
      await write(name, content);
      await git(["add", "-f", "--", name]);
    }
    await git(["commit", "-m", "later original path"]);
  }
  const original = (await git(["rev-parse", "HEAD"])).stdout.trim();
  await expect(git(["rebase", `--${backend}`, "main"])).rejects.toThrow();
  const reader = new GitWorkspaceReader({
    root,
    scope: "project",
    verify: async () => {},
    git: async (a) => (await git(a)).stdout,
  });
  let ownerKey = "owner",
    now = 1000;
  let afterNative: (() => void) | undefined,
    beforeNative: (() => void) | undefined;
  let afterPublish: ((step: string) => void) | undefined;
  let nativeOverride:
    | ((
        args: string[],
        run: () => Promise<{ stdout: string; stderr: string }>,
      ) => Promise<{ stdout: string; stderr: string }>)
    | undefined;
  const calls: string[][] = [];
  const context = async (_scope: unknown, fn: (c: any) => Promise<unknown>) =>
    fn({
      root,
      scope: "project",
      ownerKey,
      verify: async () => {},
      verifyOwner: async () => {},
      snapshot: () => reader.snapshot(),
      git: (a: string[], o?: { stdin?: string; indexFile?: string }) => {
        calls.push(a);
        const run = () => git(a, o?.stdin);
        return o?.indexFile ? withTrustedGitIndex(o.indexFile, run) : run();
      },
      isolatedGit: (a: string[]) => {
        calls.push(a);
        const run = () => git(a);
        return a.includes("--abort") && nativeOverride
          ? nativeOverride(a, run)
          : run();
      },
    });
  const modulePath = "../src/host/git-rebase-operations";
  const mod = await import(modulePath).catch(() => null);
  expect(
    mod?.GitRebaseOperations,
    "safe rebase abort engine is missing",
  ).toBeTypeOf("function");
  const engine = new mod.GitRebaseOperations({
    context,
    now: () => now,
    beforeNative: () => beforeNative?.(),
    afterNative: () => afterNative?.(),
    afterPublish: (step: string) => afterPublish?.(step),
  });
  const prepare = async (action = "abort") =>
    engine.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      action,
    });
  return {
    base,
    root,
    git,
    write,
    read,
    original,
    engine,
    prepare,
    calls,
    setOwner: (v: string) => {
      ownerKey = v;
    },
    expire: () => {
      now += 300001;
    },
    beforeNative: (fn: typeof beforeNative) => {
      beforeNative = fn;
    },
    afterNative: (fn: typeof afterNative) => {
      afterNative = fn;
    },
    afterPublish: (fn: typeof afterPublish) => {
      afterPublish = fn;
    },
    nativeOverride: (fn: typeof nativeOverride) => {
      nativeOverride = fn;
    },
  };
}
async function tree(root: string) {
  const rows: unknown[] = [];
  async function visit(file: string) {
    const s = await fs.lstat(file, { bigint: true });
    rows.push([
      file,
      String(s.ino),
      String(s.mode),
      String(s.mtimeNs),
      String(s.ctimeNs),
      s.isFile()
        ? createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex")
        : "dir",
    ]);
    if (s.isDirectory())
      for (const n of (await fs.readdir(file)).sort())
        await visit(path.join(file, n));
  }
  await visit(root);
  return JSON.stringify(rows);
}

describe("native linear rebase abort transaction", () => {
  it("previews without repository effects and aborts pristine merge baseline to exact owner branch", async () => {
    const f = await fixture();
    await f.write("untracked", "mine\n");
    await f.write("ignored", "ignored mine\n");
    const before = await tree(f.root),
      p = await f.prepare();
    expect(await tree(f.root)).toBe(before);
    expect(p).toMatchObject({
      operation: "rebase",
      action: "abort",
      backend: "merge",
      branch: "feature",
      hooks: "disabled",
    });
    const result = await f.engine.execute(p.token);
    expect(result).toMatchObject({
      status: "success",
      changed: true,
      mutationStarted: true,
      worktreeRestored: true,
      indexPublished: true,
      headPublished: true,
      metadataCleared: true,
      lockRetained: false,
    });
    expect((await f.git(["symbolic-ref", "HEAD"])).stdout).toBe(
      "refs/heads/feature\n",
    );
    expect((await f.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(f.original);
    expect(await f.read("conflict")).toBe("topic\n");
    expect(await f.read("untracked")).toBe("mine\n");
    expect(await f.read("ignored")).toBe("ignored mine\n");
    await expect(
      fs.stat(path.join(f.root, ".git/rebase-merge")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await fs.readFile(path.join(result.recoveryPath, "journal.json"), "utf8"),
    ).toContain('"metadataCleared": true');
    await expect(f.engine.execute(p.token)).rejects.toThrow();
  });
  it("runs native against private metadata even while real HEAD and owner-ref pins are held", async () => {
    const f = await fixture();
    let nativeSeen = false;
    f.nativeOverride(async (args, run) => {
      nativeSeen = true;
      const gd = args.find((a) => a.startsWith("--git-dir="))!.slice(10);
      expect(gd).not.toBe(path.join(f.root, ".git"));
      for (const n of [
        "HEAD.lock",
        "refs/heads/feature.lock",
        "index.lock",
        "config.lock",
      ])
        expect((await fs.stat(path.join(f.root, ".git", n))).isFile()).toBe(
          true,
        );
      const head = await f.read(".git/HEAD"),
        rebase = await tree(path.join(f.root, ".git/rebase-merge")),
        index = await fs.readFile(path.join(f.root, ".git/index"));
      const out = await run();
      expect(await f.read(".git/HEAD")).toBe(head);
      expect(await tree(path.join(f.root, ".git/rebase-merge"))).toBe(rebase);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
      return out;
    });
    const p = await f.prepare();
    expect((await f.engine.execute(p.token)).status).toBe("success");
    expect(nativeSeen).toBe(true);
  });
  it.each(["other"])(
    "refuses edited %s before any repository write",
    async (name) => {
      const f = await fixture();
      await f.write(name, "user work\n");
      const before = await tree(f.root);
      await expect(f.prepare()).rejects.toThrow(/измен|baseline|исходн|правк/i);
      expect(await tree(f.root)).toBe(before);
    },
  );
  it("refuses unrelated staged work rather than discarding user edits", async () => {
    const f = await fixture();
    await f.write("other", "staged\n");
    await f.git(["add", "other"]);
    const before = await tree(f.root);
    await expect(f.prepare()).rejects.toThrow();
    expect(await tree(f.root)).toBe(before);
  });
  it.each(["continue"])(
    "refuses unsafe %s requests without writes",
    async (mode) => {
      const f = await fixture(mode === "apply" ? "apply" : "merge"),
        before = await tree(f.root);
      await expect(
        f.prepare(mode === "continue" ? "continue" : "abort"),
      ).rejects.toThrow(/поддерж|только/i);
      expect(await tree(f.root)).toBe(before);
    },
  );
  it.each(["owner", "expiry", "auto-inode", "head-attached", "owner-symbolic"])(
    "consumes stale %s confirmation before writes",
    async (mode) => {
      const f = await fixture(),
        p = await f.prepare();
      if (mode === "owner") f.setOwner("new-owner");
      if (mode === "expiry") f.expire();
      if (mode === "auto-inode") {
        const bytes = await fs.readFile(path.join(f.root, ".git/AUTO_MERGE"));
        await fs.rename(
          path.join(f.root, ".git/AUTO_MERGE"),
          path.join(f.base, "old-auto"),
        );
        await fs.writeFile(path.join(f.root, ".git/AUTO_MERGE"), bytes);
      }
      if (mode === "head-attached") {
        const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim();
        await f.git(["update-ref", "refs/heads/impostor", head]);
        await f.git(["symbolic-ref", "HEAD", "refs/heads/impostor"]);
      }
      if (mode === "owner-symbolic") {
        await f.git(["update-ref", "refs/heads/impostor", f.original]);
        await f.git([
          "symbolic-ref",
          "refs/heads/feature",
          "refs/heads/impostor",
        ]);
      }
      const before = await tree(f.root);
      await expect(f.engine.execute(p.token)).rejects.toThrow();
      expect(await tree(f.root)).toBe(before);
      await expect(f.engine.execute(p.token)).rejects.toThrow();
    },
  );
  it("never treats native exit zero without private/WT postconditions as success", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.nativeOverride(async () => ({ stdout: "", stderr: "" }));
    const r = await f.engine.execute(p.token);
    expect(r.status).toBe("uncertain");
    expect(r.mutationStarted).toBe(true);
    expect(r.headPublished).toBe(false);
    expect(r.metadataCleared).toBe(false);
    expect(r.recoveryPath).toBeTruthy();
  });
  it("can prove a native nonzero outcome without relying on stderr text", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.nativeOverride(async (_a, run) => {
      await run();
      throw new CommandExitError("fixture nonzero", 7);
    });
    expect((await f.engine.execute(p.token)).status).toBe("success");
  });
  it("preserves truthful facts and recovery on lost native reply", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.nativeOverride(async (_a, run) => {
      await run();
      throw Error("lost reply");
    });
    const r = await f.engine.execute(p.token);
    expect(r).toMatchObject({
      status: "uncertain",
      changed: true,
      mutationStarted: true,
      headPublished: false,
      metadataCleared: false,
    });
    expect(r.recoveryPath).toBeTruthy();
    expect(await f.read("conflict")).toBe("topic\n");
  });
  it.each(["index", "head", "metadata"])(
    "keeps actual publication facts after %s failure without rollback",
    async (step) => {
      const f = await fixture(),
        p = await f.prepare();
      f.afterPublish((s) => {
        if (s === step) throw Error("fixture publication failure");
      });
      const r = await f.engine.execute(p.token);
      expect(r.status).toBe("uncertain");
      expect(r.changed).toBe(true);
      expect(r.indexPublished).toBe(true);
      expect(r.headPublished).toBe(step !== "index");
      expect(r.metadataCleared).toBe(step === "metadata");
      expect(r.recoveryPath).toBeTruthy();
    },
  );
  it("never deletes a newly inserted operation file during cleanup", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.afterPublish((s) => {
      if (s === "head")
        writeFileSync(
          path.join(f.root, ".git/rebase-merge/new-foreign"),
          "new data",
        );
    });
    const r = await f.engine.execute(p.token);
    expect(r.status).toBe("uncertain");
    expect(await f.read(".git/rebase-merge/new-foreign")).toBe("new data");
    expect(r.metadataCleared).toBe(false);
  });
});

describe("rebase abort adversarial boundaries", () => {
  it.each(["ref", "config"])(
    "refuses late %s mutation after HEAD publication",
    async (target) => {
      const f = await fixture(),
        p = await f.prepare();
      f.afterPublish((step) => {
        if (step === "head")
          writeFileSync(
            path.join(
              f.root,
              ".git",
              target === "ref" ? "refs/heads/feature" : "config",
            ),
            target === "ref"
              ? `${f.original}\n`
              : "[core]\nrepositoryformatversion = 0\n[fixture]\nvalue = external\n",
          );
      });
      const r = await f.engine.execute(p.token);
      expect(r.status).toBe("uncertain");
      expect(r.metadataCleared).toBe(false);
    },
  );
  it.each(["untracked", "ignored"])(
    "rejects %s collision with a later ORIGINAL path",
    async (name) => {
      const f = await fixture("merge", name);
      await f.write(name, "unrelated local data\n");
      const before = await tree(f.root);
      await expect(f.prepare()).rejects.toThrow();
      expect(await tree(f.root)).toBe(before);
    },
  );
  it("refuses attributes present only in ORIGINAL before native checkout", async () => {
    const f = await fixture("merge", ".gitattributes"),
      before = await tree(f.root);
    await expect(f.prepare()).rejects.toThrow(/attributes|поддерж/i);
    expect(await tree(f.root)).toBe(before);
  });
  it.each(["author-script", "update-refs", "git-rebase-todo"])(
    "refuses untrusted %s before writes or helpers",
    async (name) => {
      const f = await fixture();
      await f.write(
        `.git/rebase-merge/${name}`,
        name === "author-script"
          ? "GIT_AUTHOR_NAME=$(touch marker)\n"
          : name === "update-refs"
            ? "refs/heads/other\n"
            : "exec touch marker\n",
      );
      const before = await tree(f.root);
      await expect(f.prepare()).rejects.toThrow();
      expect(await tree(f.root)).toBe(before);
    },
  );
  it("refuses repository filters without running them", async () => {
    const f = await fixture();
    await f.git(["config", "filter.fixture.smudge", "touch marker"]);
    const before = await tree(f.root);
    await expect(f.prepare()).rejects.toThrow();
    expect(await tree(f.root)).toBe(before);
  });
});

it("rejects private native metadata tampering before starting the child", async () => {
  const f = await fixture(),
    p = await f.prepare();
  f.beforeNative(() => {
    const name = readdirSync(path.join(f.root, ".git")).find((n: string) =>
      n.startsWith("goga-abort-"),
    );
    appendFileSync(
      path.join(f.root, ".git", name!, "config"),
      "[fixture]\nchanged = true\n",
    );
  });
  const r = await f.engine.execute(p.token);
  expect(r.status).toBe("error");
  expect(r.mutationStarted).toBe(false);
});
it("refuses an untracked empty directory at an ORIGINAL file destination", async () => {
  const f = await fixture("merge", "later-file");
  await fs.mkdir(path.join(f.root, "later-file"));
  const before = await tree(f.root);
  await expect(f.prepare()).rejects.toThrow();
  expect(await tree(f.root)).toBe(before);
});

it.each(["__proto__", "constructor", "toString"])(
  "treats %s as a literal native filename, never an object prototype",
  async (name) => {
    const f = await fixture("merge", undefined, name),
      p = await f.prepare(),
      r = await f.engine.execute(p.token);
    expect(r.status).toBe("success");
    expect(await f.read(name)).toBe("topic\n");
  },
);
it("refuses a nontrivial baseline path maliciously removed from AUTO_MERGE/index/WT", async () => {
  const f = await fixture("merge", undefined, "conflict", true);
  const { randomUUID } = await import("node:crypto"),
    folder = path.join(f.root, ".git", `goga-commit-${randomUUID()}`),
    idx = path.join(folder, "index");
  await fs.mkdir(folder);
  await withTrustedGitIndex(idx, () => f.git(["read-tree", "AUTO_MERGE"]));
  await withTrustedGitIndex(idx, () =>
    f.git(["update-index", "--force-remove", "--", "conflict"]),
  );
  const treeOid = (
    await withTrustedGitIndex(idx, () => f.git(["write-tree"]))
  ).stdout.trim();
  await f.write(".git/AUTO_MERGE", `${treeOid}\n`);
  await f.git(["update-index", "--force-remove", "--", "conflict"]);
  await fs.unlink(path.join(f.root, "conflict"));
  const before = await tree(f.root);
  await expect(f.prepare()).rejects.toThrow();
  expect(await tree(f.root)).toBe(before);
});
it("refuses a native abort which would remove a pinned existing directory", async () => {
  const f = await fixture("merge", undefined, "conflict", false, true),
    before = await tree(f.root);
  await expect(f.prepare()).rejects.toThrow();
  expect(await tree(f.root)).toBe(before);
});
it("supports a new ORIGINAL directory hierarchy without overwriting unrelated data", async () => {
  const f = await fixture("merge", "new/deep/file"),
    p = await f.prepare(),
    r = await f.engine.execute(p.token);
  expect(r.status).toBe("success");
  expect(await f.read("new/deep/file")).toBe("original later content\n");
});
it("orders numeric literal paths like the Git index, not JavaScript object keys", async () => {
  const f = await fixture("merge", "10", "2"),
    p = await f.prepare(),
    r = await f.engine.execute(p.token);
  expect(r.status).toBe("success");
  expect(await f.read("2")).toBe("topic\n");
  expect(await f.read("10")).toBe("original later content\n");
});
it("rejects case-alias attributes in ORIGINAL before checkout", async () => {
  const f = await fixture("merge", ".GITATTRIBUTES"),
    before = await tree(f.root);
  await expect(f.prepare()).rejects.toThrow();
  expect(await tree(f.root)).toBe(before);
});
it.each(["-leading-option", ":(glob)*.txt", "line\nbreak"])(
  "preserves unusual filename %j literally",
  async (name) => {
    const f = await fixture("merge", undefined, name),
      p = await f.prepare(),
      r = await f.engine.execute(p.token);
    expect(r.status).toBe("success");
    expect(await f.read(name)).toBe("topic\n");
  },
);

it("cleans a known-owned lock even when its initial fsync fails", async () => {
  const f = await fixture(),
    p = await f.prepare();
  ioFault.configLockSync = true;
  const r = await f.engine.execute(p.token);
  expect(r).toMatchObject({
    status: "error",
    mutationStarted: false,
    lockRetained: false,
  });
  await expect(
    fs.stat(path.join(f.root, ".git/config.lock")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  expect(await f.read("conflict")).toContain("<<<<<<< HEAD");
});

it.each(["before", "after"] as const)(
  "keeps truthful lock facts when release fails %s unlink",
  async (phase) => {
    const f = await fixture(),
      p = await f.prepare();
    f.engine.options.releaseLockFault = (name: string, point: string) => {
      if (name === "config.lock" && point === phase)
        throw Error("fixture cleanup failure");
    };
    const r = await f.engine.execute(p.token);
    expect(r).toMatchObject({
      status: "uncertain",
      changed: true,
      headPublished: true,
      metadataCleared: true,
      lockRetained: phase === "before",
    });
    expect(r.retainedLocks).toEqual(phase === "before" ? ["config.lock"] : []);
    expect(
      JSON.parse(
        await fs.readFile(path.join(r.recoveryPath, "journal.json"), "utf8"),
      ),
    ).toMatchObject({
      status: "uncertain",
      headPublished: true,
      metadataCleared: true,
    });
  },
);
it("ignores hostile default global attributes during the native abort", async () => {
  const f = await fixture();
  const attributes = path.join(f.base, "home/git/attributes");
  await fs.mkdir(path.dirname(attributes), { recursive: true });
  await fs.writeFile(attributes, "* text eol=crlf\n");
  const p = await f.prepare(),
    r = await f.engine.execute(p.token);
  expect(r.status).toBe("success");
  expect(await f.read("conflict")).toBe("topic\n");
  expect(await fs.readFile(attributes, "utf8")).toBe("* text eol=crlf\n");
});

it("refuses late BISECT_START after primary operation metadata cleanup", async () => {
  const f = await fixture(),
    p = await f.prepare();
  f.afterPublish((step) => {
    if (step === "metadata")
      writeFileSync(path.join(f.root, ".git/BISECT_START"), "feature\n");
  });
  const r = await f.engine.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    headPublished: true,
    metadataCleared: true,
  });
  expect(await f.read(".git/BISECT_START")).toBe("feature\n");
});
it("reports a moved recovery directory as missing, not a retained backup", async () => {
  const f = await fixture(),
    p = await f.prepare();
  let previous = "";
  f.afterNative(() => {
    previous = path.join(
      f.root,
      ".git",
      readdirSync(path.join(f.root, ".git")).find((n) =>
        n.startsWith("goga-abort-"),
      )!,
    );
    renameSync(previous, path.join(f.base, "moved-recovery"));
  });
  const r = await f.engine.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    mutationStarted: true,
    recoveryStatus: "missing",
    lastKnownRecoveryPath: previous,
  });
  expect(r.recoveryPath).toBeUndefined();
  expect(r.message).not.toContain("сохранены исходные данные");
  await expect(fs.stat(previous)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    (await fs.stat(path.join(f.base, "moved-recovery"))).isDirectory(),
  ).toBe(true);
});
it("keeps partial facts when final recovery observation itself fails", async () => {
  const f = await fixture(),
    p = await f.prepare();
  f.afterNative(() => {
    ioFault.recoveryStat = true;
  });
  const r = await f.engine.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    mutationStarted: true,
    recoveryStatus: "unverified",
  });
  expect(r.recoveryPath).toBeUndefined();
  expect(r.lastKnownRecoveryPath).toContain("goga-abort-");
});
it("does not verify recovery through a replaced backup ancestor symlink", async () => {
  const f = await fixture(),
    p = await f.prepare();
  let replaced = "";
  f.afterNative(() => {
    const recovery = path.join(
      f.root,
      ".git",
      readdirSync(path.join(f.root, ".git")).find((n) =>
        n.startsWith("goga-abort-"),
      )!,
    );
    replaced = path.join(recovery, "backup");
    const moved = path.join(f.base, "outside-backup");
    renameSync(replaced, moved);
    symlinkSync(moved, replaced);
  });
  const r = await f.engine.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    changed: true,
    recoveryStatus: "unverified",
  });
  expect(r.recoveryPath).toBeUndefined();
  expect((await fs.lstat(replaced)).isSymbolicLink()).toBe(true);
});

describe("projected ORIGINAL physical targets and raw budgets", () => {
  it.each([
    ["ignored/NewFile", "ignored/newfile"],
    ["ignored/NewDir/file", "ignored/newdir/file"],
    ["ignored/Café", "ignored/Cafe\u0301"],
    ["ignored/Café/file", "ignored/Cafe\u0301/file"],
  ])(
    "refuses an actual ignored physical alias %s / %s before writes",
    async (target, alias) => {
      const f = await fixture("merge", target);
      await f.write(alias, "user alias bytes\n");
      const physical = await fs.stat(path.join(f.root, target)).then(
          () => true,
          () => false,
        ),
        before = await tree(f.root);
      if (physical || /[^\x00-\x7f]/.test(target)) {
        await expect(f.prepare()).rejects.toThrow();
        expect(await tree(f.root)).toBe(before);
        expect(f.calls.some((a) => a.includes("--abort"))).toBe(false);
      } else {
        const p = await f.prepare();
        expect((await f.engine.execute(p.token)).status).toBe("success");
      }
      expect(await f.read(alias)).toBe("user alias bytes\n");
    },
  );
  it.each(["size", "aggregate", "depth", "count"])(
    "refuses projected ORIGINAL %s budget overflow before writes",
    async (kind) => {
      const future: Record<string, string> =
        kind === "size"
          ? { large: "x".repeat(1024 * 1024 + 1) }
          : kind === "aggregate"
            ? Object.fromEntries(
                Array.from({ length: 33 }, (_, i) => [
                  `large-${i}`,
                  "x".repeat(1024 * 1024),
                ]),
              )
            : kind === "depth"
              ? {
                  [Array.from({ length: 25 }, (_, i) => `d${i}`).join("/") +
                  "/file"]: "future\n",
                }
              : { future: "future\n" };
      const f = await fixture(
        "merge",
        undefined,
        "conflict",
        false,
        false,
        future,
      );
      if (kind === "count")
        for (let batch = 0; batch < 100; batch++)
          await Promise.all(
            Array.from({ length: Math.min(100, 9997 - batch * 100) }, (_, i) =>
              fs.mkdir(path.join(f.root, `empty-${batch * 100 + i}`)),
            ),
          );
      const before = await tree(f.root);
      await expect(f.prepare()).rejects.toThrow();
      expect(await tree(f.root)).toBe(before);
      expect(f.calls.some((a) => a.includes("--abort"))).toBe(false);
    },
  );
  it("refuses a new non-ASCII ORIGINAL component conservatively before writes", async () => {
    const f = await fixture("merge", "новый-файл"),
      before = await tree(f.root);
    await expect(f.prepare()).rejects.toThrow();
    expect(await tree(f.root)).toBe(before);
  });
  it("still accepts an exact existing Unicode ORIGINAL path", async () => {
    const f = await fixture("merge", undefined, "файл"),
      p = await f.prepare();
    expect((await f.engine.execute(p.token)).status).toBe("success");
    expect(await f.read("файл")).toBe("topic\n");
  });
  it.each(["files", "parents", "file-parent", "canonical"])(
    "refuses ambiguous future-only %s without probing the filesystem",
    async (kind) => {
      const f = await fixture(),
        blob = (
          await f.git(["hash-object", "-w", "--stdin"], "future\n")
        ).stdout.trim();
      const subtree = (
        await f.git(["mktree", "-z"], `100644 blob ${blob}\tfile\0`)
      ).stdout.trim();
      const rows = (await f.git(["ls-tree", "-z", f.original])).stdout;
      const added =
        (kind === "files"
          ? [`100644 blob ${blob}\tFuture`, `100644 blob ${blob}\tfuture`]
          : kind === "parents"
            ? [
                `040000 tree ${subtree}\tFuture`,
                `040000 tree ${subtree}\tfuture`,
              ]
            : kind === "canonical"
              ? [
                  `100644 blob ${blob}\tFuturé`,
                  `100644 blob ${blob}\tFuture\u0301`,
                ]
              : [
                  `100644 blob ${blob}\tFuture`,
                  `040000 tree ${subtree}\tfuture`,
                ]
        ).join("\0") + "\0";
      const targetTree = (
        await f.git(["mktree", "-z"], rows + added)
      ).stdout.trim();
      const original = (
        await f.git(
          ["commit-tree", targetTree, "-p", f.original],
          "future ambiguous paths\n",
        )
      ).stdout.trim();
      // Test-only coherent future commit, never checked out. The stopped native
      // pick and AUTO baseline remain intact; only its future queue is extended.
      await f.git(["update-ref", "refs/heads/feature", original, f.original]);
      await f.write(".git/ORIG_HEAD", `${original}\n`);
      await f.write(".git/rebase-merge/orig-head", `${original}\n`);
      await fs.appendFile(
        path.join(f.root, ".git/rebase-merge/git-rebase-todo"),
        `pick ${original} future ambiguous paths\n`,
      );
      await fs.appendFile(
        path.join(f.root, ".git/rebase-merge/git-rebase-todo.backup"),
        `pick ${original} future ambiguous paths\n`,
      );
      await f.write(".git/rebase-merge/end", "2\n");
      const before = await tree(f.root);
      await expect(f.prepare()).rejects.toThrow();
      expect(await tree(f.root)).toBe(before);
    },
  );
});

it("includes preserved untracked bytes in the projected aggregate budget", async () => {
  const future = Object.fromEntries(
    Array.from({ length: 31 }, (_, i) => [
      `future-${i}`,
      "x".repeat(1024 * 1024),
    ]),
  );
  const f = await fixture("merge", undefined, "conflict", false, false, future);
  await f.write("untracked-one", "y".repeat(1024 * 1024));
  await f.write("untracked-two", "z".repeat(1024 * 1024));
  const before = await tree(f.root);
  await expect(f.prepare()).rejects.toThrow(/32 МиБ/);
  expect(await tree(f.root)).toBe(before);
  expect(f.calls.some((a) => a.includes("--abort"))).toBe(false);
});
it("accepts ORIGINAL bounds at one MiB and twenty-four directory ancestors", async () => {
  const name =
    Array.from({ length: 24 }, (_, i) => `d${i}`).join("/") + "/file";
  const f = await fixture("merge", undefined, "conflict", false, false, {
      [name]: "x".repeat(1024 * 1024),
    }),
    p = await f.prepare();
  const r = await f.engine.execute(p.token);
  expect(r.status).toBe("success");
  expect((await fs.stat(path.join(f.root, name))).size).toBe(1024 * 1024);
});
