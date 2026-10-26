import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { NodeRunner, GitRefTransactionError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import {
  GitWorkspaceActions,
  type GitCommitContext,
} from "../src/host/git-workspace-actions";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
import { gitCommitRequestSchema } from "../src/shared/git-commit";

vi.setConfig({ testTimeout: 20000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(unborn = false, objectFormat?: "sha256") {
  const dir = await fs.mkdtemp("/private/tmp/goga-git-commit-");
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
  const write = (name: string, text: string) =>
    fs.writeFile(path.join(root, name), text);
  await git([
    "init",
    "-b",
    "main",
    ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
  ]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  if (!unborn) {
    await write("selected", "base\n");
    await write("other", "base\n");
    await git(["add", "."]);
    await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "base"]);
  }
  let ownerKey = "owner-v1",
    now = 1_000;
  const verify = vi.fn(async () => {});
  const reader = new GitWorkspaceReader({
    root,
    scope: "project",
    verify,
    git: async (args) => (await git(args)).stdout,
  });
  const calls: string[][] = [];
  let intercept:
    | ((
        args: string[],
        options?: { stdin?: string; indexFile?: string },
      ) => Promise<void>)
    | undefined;
  const context: GitCommitContext = {
    scope: "project",
    root,
    ownerKey,
    snapshot: () => reader.snapshot(),
    verify,
    refTransaction: async (args, input, verifyPrepared) => {
      calls.push(args);
      await intercept?.(args, { stdin: input });
      return runner.gitRefTransaction(args, root, env, input, verifyPrepared);
    },
    git: async (args, options) => {
      calls.push(args);
      await intercept?.(args, options);
      return options?.indexFile
        ? withTrustedGitIndex(options.indexFile, () => git(args, options.stdin))
        : git(args, options?.stdin);
    },
  };
  const actions = new GitWorkspaceActions({
    context: async (_scope, action) => action({ ...context, ownerKey }),
    now: () => now,
  });
  const prepare = async (
    paths = ["selected"],
    message = "Selected whole files",
  ) =>
    actions.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      paths,
      message,
    });
  const index = () => fs.readFile(path.join(root, ".git/index"));
  const head = async () => (await git(["rev-parse", "HEAD"])).stdout.trim();
  return {
    dir,
    env,
    root,
    home,
    git,
    write,
    reader,
    actions,
    prepare,
    index,
    head,
    calls,
    verify,
    context,
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

describe("whole-file Git commit transaction", () => {
  it("commits current whole selected file and preserves unrelated staged and worktree versions", async () => {
    const f = await fixture();
    await f.write("selected", "staged\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "whole current\n");
    await f.write("other", "other staged\n");
    await f.git(["add", "other"]);
    await f.write("other", "other working\n");
    const before = await f.index();
    const p = await f.prepare();
    expect(p).toMatchObject({
      paths: ["selected"],
      wholeFiles: true,
      hooks: "disabled",
      author: "Fixture <fixture@example.invalid>",
      signing: false,
    });
    expect(await f.index()).toEqual(before);
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({ status: "committed", indexPublished: true });
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe(
      "whole current\n",
    );
    expect((await f.git(["show", "HEAD:other"])).stdout).toBe("base\n");
    expect((await f.git(["show", ":other"])).stdout).toBe("other staged\n");
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other working\n",
    );
    expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe(
      "other\n",
    );
    expect(f.calls.flat()).not.toEqual(
      expect.arrayContaining(["push", "reset", "stash", "--amend"]),
    );
  });
  it("handles literal Unicode, spaces, colon, wildcard, newline, untracked, deletion and rename paths", async () => {
    const f = await fixture();
    await f.git(["mv", "selected", "renamed\nЮникод"]);
    await fs.unlink(path.join(f.root, "other"));
    const names = ["space name", ":(glob)*", "star*file", "строка\nfile"];
    for (const name of names) await f.write(name, `body:${name}\n`);
    const p = await f.prepare(["renamed\nЮникод", "other", ...names]);
    expect(p.paths).toEqual(
      expect.arrayContaining([
        "selected",
        "renamed\nЮникод",
        "other",
        ...names,
      ]),
    );
    expect(p.deletedCount).toBe(2);
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "committed",
      indexPublished: true,
    });
    expect(
      (await f.git(["ls-tree", "-r", "--name-only", "-z", "HEAD"])).stdout
        .split("\0")
        .filter(Boolean)
        .sort(),
    ).toEqual(["renamed\nЮникод", ...names].sort());
  });
  it("creates unborn HEAD without including unrelated staged additions", async () => {
    const f = await fixture(true);
    await f.write("selected", "first\n");
    await f.write("other", "unrelated\n");
    await f.git(["add", "other"]);
    const p = await f.prepare();
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "committed",
      indexPublished: true,
    });
    expect((await f.git(["ls-tree", "--name-only", "HEAD"])).stdout).toBe(
      "selected\n",
    );
    expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe(
      "other\n",
    );
  });
  it("preserves unrelated skip-worktree and assume-unchanged flags", async () => {
    const f = await fixture();
    await f.git(["update-index", "--assume-unchanged", "other"]);
    await f.git(["update-index", "--skip-worktree", "other"]);
    const before = (await f.git(["ls-files", "-v", "other"])).stdout;
    await f.write("selected", "changed\n");
    const p = await f.prepare();
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    expect((await f.git(["ls-files", "-v", "other"])).stdout).toBe(before);
  });
  it("rejects empty, duplicate, unsafe paths, unknown keys and blank/oversized messages", () => {
    const valid = {
      scope: "project",
      revision: "a".repeat(64),
      paths: ["a"],
      message: "ok",
    };
    expect(gitCommitRequestSchema.safeParse(valid).success).toBe(true);
    for (const patch of [
      { paths: [] },
      { paths: ["a", "a"] },
      { paths: ["../outside"] },
      { paths: [".git/config"] },
      { message: " \n " },
      { message: "a".repeat(16385) },
      { message: "bad\0message" },
      { root: "/tmp" },
    ])
      expect(
        gitCommitRequestSchema.safeParse({ ...valid, ...patch }).success,
      ).toBe(false);
  });
  it.each(["content", "index", "head", "config", "owner"])(
    "rejects stale %s before writes and consumes token",
    async (kind) => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const p = await f.prepare();
      if (kind === "content") await f.write("selected", "changed again\n");
      if (kind === "index") {
        await f.write("other", "staged\n");
        await f.git(["add", "other"]);
      }
      if (kind === "head")
        await f.git([
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "--allow-empty",
          "-m",
          "new head",
        ]);
      if (kind === "config") await f.git(["config", "user.name", "Different"]);
      if (kind === "owner") f.setOwner("other-owner");
      const index = await f.index(),
        head = await f.head();
      await expect(f.actions.execute(p.token)).rejects.toThrow(
        /устар|владел|контекст/i,
      );
      expect(await f.index()).toEqual(index);
      expect(await f.head()).toBe(head);
      await expect(f.actions.execute(p.token)).rejects.toThrow(
        /подтверж|токен/i,
      );
    },
  );
  it("expires tickets and denies replay", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare();
    f.setNow(p.expiresAt + 1);
    await expect(f.actions.execute(p.token)).rejects.toThrow(
      /ист|подтверж|токен/i,
    );
    f.setNow(1000);
    const p2 = await f.prepare();
    await f.actions.execute(p2.token);
    await expect(f.actions.execute(p2.token)).rejects.toThrow(
      /подтверж|токен/i,
    );
  });
  it("fails closed on missing configured identity", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    await f.git(["config", "--unset", "user.name"]);
    await f.git(["config", "--unset", "user.email"]);
    await expect(f.prepare()).rejects.toThrow();
  });
  it("does not execute configured hooks or add their unrelated files", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    await f.write("payload", "unselected\n");
    const hooks = path.join(f.dir, "hooks");
    await fs.mkdir(hooks);
    await fs.writeFile(
      path.join(hooks, "pre-commit"),
      "#!/bin/sh\nprintf ran > hook-ran\ngit add payload\n",
      { mode: 0o700 },
    );
    await f.git(["config", "core.hooksPath", hooks]);
    const p = await f.prepare();
    expect(p.hooks).toBe("disabled");
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    await expect(fs.stat(path.join(f.root, "hook-ran"))).rejects.toThrow();
    expect(
      (await f.git(["ls-tree", "--name-only", "HEAD"])).stdout,
    ).not.toContain("payload");
  });
  it("refuses external clean filters without running them", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    await f.write(".gitattributes", "selected filter=hostile\n");
    await f.git(["config", "filter.hostile.clean", "touch filter-ran; cat"]);
    await expect(f.prepare()).rejects.toThrow(/filter|фильтр/i);
    await expect(fs.stat(path.join(f.root, "filter-ran"))).rejects.toThrow();
  });
  it.each(["prepare", "stage"])(
    "never executes a newly installed clean filter during %s",
    async (phase) => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const preview = phase === "stage" ? await f.prepare() : null;
      const before = await f.index(),
        head = await f.head();
      const sentinel = path.join(f.dir, "late-filter-ran");
      let injected = false;
      f.intercept(async (args) => {
        const atBoundary =
          phase === "prepare"
            ? args.includes("hash-object") && args.includes("--path=selected")
            : args.includes("add");
        if (injected || !atBoundary) return;
        injected = true;
        await f.git([
          "config",
          "filter.late.clean",
          `printf observed > '${sentinel}'; cat`,
        ]);
        await f.write(".gitattributes", "selected filter=late\n");
      });
      await expect(
        preview ? f.actions.execute(preview.token) : f.prepare(),
      ).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await fs.readFile(sentinel, "utf8").catch(() => null)).toBe(null);
      expect(await f.index()).toEqual(before);
      expect(await f.head()).toBe(head);
      expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
        "changed\n",
      );
    },
  );
  it.each(["true", "2"])(
    "retains configured signing %s and preserves real index on signing failure",
    async (signing) => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      await f.git(["config", "commit.gpgSign", signing]);
      await f.git([
        "config",
        "gpg.program",
        "/nonexistent/goga-signing-fixture",
      ]);
      const p = await f.prepare();
      expect(p.signing).toBe(true);
      const before = await f.index(),
        head = await f.head();
      expect(await f.actions.execute(p.token)).toMatchObject({
        status: "not-committed",
        indexPublished: false,
      });
      expect(await f.index()).toEqual(before);
      expect(await f.head()).toBe(head);
      await expect(
        fs.stat(path.join(f.root, ".git/index.lock")),
      ).rejects.toThrow();
    },
  );
  it("denies existing index lock and leaves its content unchanged", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare();
    const lock = path.join(f.root, ".git/index.lock");
    await fs.writeFile(lock, "foreign lock");
    const before = await f.index();
    await expect(f.actions.execute(p.token)).rejects.toThrow(/блок|занят/i);
    expect(await fs.readFile(lock, "utf8")).toBe("foreign lock");
    expect(await f.index()).toEqual(before);
  });
  it("holds a stable real index lock while Git uses a private index", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare();
    let checked = false;
    f.intercept(async (args, options) => {
      if (args.includes("add") && options?.indexFile) {
        expect(options?.indexFile).not.toBe(
          path.join(f.root, ".git/index.lock"),
        );
        await expect(f.git(["add", "other"])).rejects.toThrow();
        checked = true;
      }
    });
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    expect(checked).toBe(true);
  });
  it("refuses symlinks, nested repositories and active operations before commit", async () => {
    const f = await fixture();
    await fs.symlink(path.join(f.root, "other"), path.join(f.root, "link"));
    await expect(f.prepare(["link"])).rejects.toThrow(/ссыл|тип|файл/i);
    await fs.mkdir(path.join(f.root, "nested"));
    await fs.mkdir(path.join(f.root, "nested/.git"));
    await f.write("nested/a", "nested\n");
    await expect(f.prepare(["nested/a"])).rejects.toThrow();
    await f.write("selected", "changed\n");
    await fs.writeFile(
      path.join(f.root, ".git/MERGE_HEAD"),
      `${await f.head()}\n`,
    );
    await expect(f.prepare()).rejects.toThrow(/операц|слиян/i);
  });
  it("retains journal, private index and owned lock when publication fails after commit", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const before = await f.index(),
      head = await f.head();
    const actions = new GitWorkspaceActions({
      context: async (_scope, action) => action(f.context),
      beforePublishIndex: () => {
        throw Error("simulated publication failure");
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "commit then fail publication",
    });
    const result = await actions.execute(p.token);
    expect(result).toMatchObject({
      status: "committed",
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(await f.head()).not.toBe(head);
    expect(await f.index()).toEqual(before);
    expect((await fs.stat(path.join(f.root, ".git/index.lock"))).isFile()).toBe(
      true,
    );
    expect(await fs.readdir(result.recoveryPath!)).toEqual(
      expect.arrayContaining(["index", "journal.json"]),
    );
  });
  it("retains built-in CRLF normalization and binary bytes", async () => {
    const f = await fixture();
    await f.git(["config", "core.autocrlf", "true"]);
    await f.write("selected", "line one\r\nline two\r\n");
    const binary = Buffer.from([0, 255, 1, 13, 10, 65]);
    await fs.writeFile(path.join(f.root, "binary"), binary);
    const p = await f.prepare(["selected", "binary"]);
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe(
      "line one\nline two\n",
    );
    expect((await f.git(["rev-parse", "HEAD:binary"])).stdout.trim()).toBe(
      (await f.git(["hash-object", "binary"])).stdout.trim(),
    );
    expect(await fs.readFile(path.join(f.root, "binary"))).toEqual(binary);
  });
  it("rechecks selected content after private preparation before any commit", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare(),
      before = await f.index(),
      head = await f.head();
    f.intercept(async (args, options) => {
      if (args.includes("add") && options?.indexFile)
        await f.write("selected", "raced\n");
    });
    await expect(f.actions.execute(p.token)).rejects.toThrow(/устар/i);
    expect(await f.index()).toEqual(before);
    expect(await f.head()).toBe(head);
    expect(f.calls.some((args) => args.includes("commit"))).toBe(false);
  });
  it("retains recovery material for ambiguous cancellation instead of retrying", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare(),
      before = await f.index(),
      head = await f.head();
    f.intercept(async (args) => {
      if (args.includes("update-ref"))
        throw new GitRefTransactionError("lost acknowledgement", true);
    });
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(await f.index()).toEqual(before);
    expect(await f.head()).toBe(head);
    expect((await fs.stat(path.join(f.root, ".git/index.lock"))).isFile()).toBe(
      true,
    );
  });
  it("never overwrites an externally changed real index after commit", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare(),
      before = await f.index();
    f.intercept(async (args, options) => {
      if (
        args.includes("update-ref") &&
        options?.stdin?.includes("verify HEAD")
      ) {
        const foreign = Buffer.concat([before, Buffer.from("foreign")]);
        await fs.writeFile(path.join(f.root, ".git/index"), foreign);
      }
    });
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({
      status: "committed",
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(await f.index()).toEqual(
      Buffer.concat([before, Buffer.from("foreign")]),
    );
  });
  it("rechecks expiry after waiting for serialized context admission", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    let time = 1000,
      delay = false;
    const actions = new GitWorkspaceActions({
      now: () => time,
      context: async (_scope, run) => {
        if (delay) time += 300001;
        return run(f.context);
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "before expiry",
    });
    delay = true;
    const before = await f.index();
    await expect(actions.execute(p.token)).rejects.toThrow(/ист|подтверж/i);
    expect(await f.index()).toEqual(before);
  });

  it.each(["COMMIT_EDITMSG", "logs/HEAD"])(
    "refuses linked writable Git metadata %s without outside writes",
    async (name) => {
      const f = await fixture();
      await f.write("selected", "changed\n");
      const outside = path.join(f.dir, "outside");
      await fs.writeFile(outside, "do not modify\n");
      await fs.rm(path.join(f.root, ".git", name), { force: true });
      await fs.symlink(outside, path.join(f.root, ".git", name));
      await expect(f.prepare()).rejects.toThrow(/метадан|ссыл|небезопас/i);
      expect(await fs.readFile(outside, "utf8")).toBe("do not modify\n");
    },
  );
  it("accepts literal object-prototype filenames and nested paths", async () => {
    const f = await fixture();
    await f.write("__proto__", "literal path\n");
    await fs.mkdir(path.join(f.root, "folder"));
    await f.write("folder/deep file", "nested\n");
    const p = await f.prepare(["__proto__", "folder/deep file"]);
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    expect((await f.git(["show", "HEAD:__proto__"])).stdout).toBe(
      "literal path\n",
    );
    expect((await f.git(["show", "HEAD:folder/deep file"])).stdout).toBe(
      "nested\n",
    );
  });
  it("reports published index truthfully and retains a recovery copy if final journal persistence fails", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const actions = new GitWorkspaceActions({
      context: async (_scope, action) => action(f.context),
      afterPublishIndex: (source, target) => {
        mkdirSync(path.join(path.dirname(source), "journal.next"));
        return undefined;
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "published then journal error",
    });
    const result = await actions.execute(p.token);
    expect(result).toMatchObject({
      status: "committed",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    expect(
      (await fs.stat(path.join(result.recoveryPath!, "index"))).isFile(),
    ).toBe(true);
    expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe("");
  });

  it("refuses a recreated rename source unless it was explicitly selected", async () => {
    const f = await fixture();
    await f.git(["mv", "selected", "renamed"]);
    await f.write("selected", "unselected recreated content\n");
    const before = await f.index(),
      head = await f.head();
    await expect(f.prepare(["renamed"])).rejects.toThrow(
      /переимен|исходн|выбер/i,
    );
    expect(await f.index()).toEqual(before);
    expect(await f.head()).toBe(head);
    const p = await f.prepare(["renamed", "selected"]);
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    expect((await f.git(["show", "HEAD:selected"])).stdout).toBe(
      "unselected recreated content\n",
    );
  });
  it("returns known committed outcome when releasing the owned lock fails", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const gitdir = path.join(f.root, ".git");
    const actions = new GitWorkspaceActions({
      context: async (_scope, run) => run(f.context),
      afterPublishIndex: (source, target) => {
        chmodSync(gitdir, 0o500);
        return undefined;
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "cleanup failure",
    });
    try {
      const result = await actions.execute(p.token);
      expect(result).toMatchObject({
        status: "committed",
        indexPublished: true,
        recoveryPath: expect.any(String),
      });
      expect(
        (await fs.stat(path.join(result.recoveryPath!, "index"))).isFile(),
      ).toBe(true);
      expect((await fs.stat(path.join(gitdir, "index.lock"))).isFile()).toBe(
        true,
      );
    } finally {
      await fs.chmod(gitdir, 0o700);
    }
  });
  it.each(["HEAD", "refs/heads/main"])(
    "aborts same-OID symbolic switch of %s before ref publication",
    async (ref) => {
      const f = await fixture();
      await f.git(["branch", "other"]);
      await f.write("selected", "changed\n");
      const p = await f.prepare(),
        before = await f.index(),
        old = await f.head();
      let switched = false;
      f.intercept(async (args, options) => {
        if (
          args.includes("update-ref") &&
          options?.stdin?.includes("update HEAD") &&
          !switched
        ) {
          switched = true;
          await f.git(["symbolic-ref", ref, "refs/heads/other"]);
        }
      });
      const result = await f.actions.execute(p.token);
      expect(result).toMatchObject({
        status: "not-committed",
        indexPublished: false,
      });
      expect((await f.git(["rev-parse", "main"])).stdout.trim()).toBe(old);
      expect((await f.git(["rev-parse", "other"])).stdout.trim()).toBe(old);
      expect(await f.index()).toEqual(before);
    },
  );
  it("retains index when symbolic HEAD switches in the ref-ACK to index-publication gap", async () => {
    const f = await fixture();
    await f.git(["branch", "other"]);
    await f.write("selected", "changed\n");
    const p = await f.prepare(),
      before = await f.index();
    f.intercept(async (args, options) => {
      if (
        args.includes("update-ref") &&
        options?.stdin?.includes("verify HEAD")
      )
        await f.git(["symbolic-ref", "HEAD", "refs/heads/other"]);
    });
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({
      status: "committed",
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(await f.index()).toEqual(before);
  });
  it("commits detached HEAD without moving the original branch", async () => {
    const f = await fixture(),
      old = await f.head();
    await f.git(["checkout", "--detach"]);
    await f.write("selected", "detached whole\n");
    const p = await f.prepare();
    expect(p.branch).toBe(null);
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({ status: "committed", indexPublished: true });
    expect((await f.git(["rev-parse", "main"])).stdout.trim()).toBe(old);
    expect(await f.head()).not.toBe(old);
  });
  it("does not create empty commit when selected worktree reverted to HEAD", async () => {
    const f = await fixture();
    await f.write("selected", "staged only\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "base\n");
    const p = await f.prepare(),
      before = await f.index(),
      head = await f.head();
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "not-committed",
      indexPublished: false,
    });
    expect(await f.head()).toBe(head);
    expect(await f.index()).toEqual(before);
  });
  it("preserves explicit executable mode, message, author, committer and HEAD reflog", async () => {
    const f = await fixture();
    await f.write("selected", "executable\n");
    await fs.chmod(path.join(f.root, "selected"), 0o755);
    const message = "subject\n\nbody with trailing spaces  \n";
    const p = await f.prepare(["selected"], message);
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    expect((await f.git(["ls-tree", "HEAD", "selected"])).stdout).toMatch(
      /^100755 blob /,
    );
    expect((await f.git(["show", "-s", "--format=%B", "HEAD"])).stdout).toBe(
      message + "\n",
    );
    expect(
      (
        await f.git(["show", "-s", "--format=%an <%ae>|%cn <%ce>", "HEAD"])
      ).stdout.trim(),
    ).toBe(
      "Fixture <fixture@example.invalid>|Fixture <fixture@example.invalid>",
    );
    expect(
      (
        await f.git(["reflog", "show", "-1", "--format=%gs", "HEAD"])
      ).stdout.trim(),
    ).toBe("commit: subject");
  });
  it("supports SHA256 unborn commit and preserves unrelated staging", async () => {
    const f = await fixture(true, "sha256");
    await f.write("selected", "selected\n");
    await f.write("other", "unrelated\n");
    await f.git(["add", "other"]);
    const p = await f.prepare(),
      result = await f.actions.execute(p.token);
    expect(result).toMatchObject({ status: "committed", indexPublished: true });
    expect(result.commit).toHaveLength(64);
    expect((await f.git(["ls-tree", "--name-only", "HEAD"])).stdout).toBe(
      "selected\n",
    );
    expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe(
      "other\n",
    );
  });
  it("preserves selected staged executable mode when core.filemode is false", async () => {
    const f = await fixture();
    await f.git(["config", "core.filemode", "false"]);
    await f.git(["update-index", "--chmod=+x", "selected"]);
    await f.write("selected", "whole\n");
    const p = await f.prepare();
    expect((await f.actions.execute(p.token)).status).toBe("committed");
    expect((await f.git(["ls-tree", "HEAD", "selected"])).stdout).toMatch(
      /^100755 blob /,
    );
  });
  it("blocks late index publication after prepared verification times out", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare(),
      before = await f.index(),
      short = new NodeRunner(250, f.env);
    cleanup.push(() => short.dispose());
    let release!: () => void, ready!: () => void, finished!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      prepared = new Promise<void>((resolve) => {
        ready = resolve;
      }),
      completed = new Promise<void>((resolve) => {
        finished = resolve;
      });
    const original = f.context.refTransaction!;
    f.context.refTransaction = (args, input, verify) =>
      input.includes("verify HEAD")
        ? short.gitRefTransaction(args, f.root, f.env, input, async (guard) => {
            ready();
            await gate;
            try {
              await verify(guard);
            } finally {
              finished();
            }
          })
        : original(args, input, verify);
    const pending = f.actions.execute(p.token);
    await Promise.race([
      prepared,
      pending.then(() => {
        throw Error("transaction did not reach prepared");
      }),
    ]);
    const result = await pending;
    expect(result).toMatchObject({
      status: "committed",
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(await f.index()).toEqual(before);
    release();
    await completed;
    expect(await f.index()).toEqual(before);
  });
  it("keeps indexPublished true when deadline expires immediately after atomic publication", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const short = new NodeRunner(250, f.env);
    cleanup.push(() => short.dispose());
    const original = f.context.refTransaction!;
    f.context.refTransaction = (args, input, verify) =>
      input.includes("verify HEAD")
        ? short.gitRefTransaction(args, f.root, f.env, input, verify)
        : original(args, input, verify);
    const actions = new GitWorkspaceActions({
      context: async (_scope, run) => run(f.context),
      afterPublishIndex: () => {
        const until = Date.now() + 350;
        while (Date.now() < until) {}
        return undefined;
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "published then expired",
    });
    const result = await actions.execute(p.token);
    expect(result).toMatchObject({
      status: "committed",
      indexPublished: true,
      recoveryPath: expect.any(String),
    });
    expect((await f.git(["diff", "--cached", "--name-only"])).stdout).toBe("");
  });
  it("uses only owner execute bit when deriving Git file mode", async () => {
    const f = await fixture();
    await f.write("selected", "group executable only\n");
    await fs.chmod(path.join(f.root, "selected"), 0o654);
    const p = await f.prepare();
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "committed",
      indexPublished: true,
    });
    expect((await f.git(["ls-tree", "HEAD", "selected"])).stdout).toMatch(
      /^100644 blob /,
    );
  });
  it("retains recovery and native ref lock when second transaction reports cleanup warning", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const heads = path.join(f.root, ".git/refs/heads");
    const actions = new GitWorkspaceActions({
      context: async (_scope, run) => run(f.context),
      afterPublishIndex: () => {
        chmodSync(heads, 0o500);
        return undefined;
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
      message: "native release warning",
    });
    try {
      const result = await actions.execute(p.token);
      expect(result).toMatchObject({
        status: "committed",
        indexPublished: true,
        recoveryPath: expect.any(String),
      });
      expect(result.log).toMatch(/unable to unlink|Permission denied/);
      expect((await fs.stat(path.join(heads, "main.lock"))).isFile()).toBe(
        true,
      );
      expect(
        (await fs.stat(path.join(result.recoveryPath!, "index"))).isFile(),
      ).toBe(true);
      expect(
        (await fs.stat(path.join(f.root, ".git/index.lock"))).isFile(),
      ).toBe(true);
    } finally {
      await fs.chmod(heads, 0o700);
    }
  });
  it("preserves first transaction diagnostics and refuses publication if its ref lock remains", async () => {
    const f = await fixture();
    await f.write("selected", "changed\n");
    const p = await f.prepare(),
      before = await f.index(),
      original = f.context.refTransaction!,
      nativeLock = path.join(f.root, ".git/refs/heads/main.lock");
    f.context.refTransaction = async (args, input, verify) => {
      const output = await original(args, input, verify);
      if (input.includes("update HEAD")) {
        await fs.writeFile(nativeLock, "foreign native lock");
        return {
          ...output,
          stderr:
            output.stderr + "warning: native release diagnostic fixture\n",
        };
      }
      return output;
    };
    const result = await f.actions.execute(p.token);
    expect(result).toMatchObject({
      status: "committed",
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(result.log).toContain("native release diagnostic fixture");
    expect(await f.index()).toEqual(before);
    expect(await fs.readFile(nativeLock, "utf8")).toBe("foreign native lock");
  });
});
