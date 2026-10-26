import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { NodeRunner } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { GitDiscardActions } from "../src/host/git-discard-actions";
import type { GitCommitContext } from "../src/host/git-workspace-actions";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
vi.setConfig({ testTimeout: 20000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture(
  extra: Partial<ConstructorParameters<typeof GitDiscardActions>[0]> = {},
) {
  const dir = await fs.mkdtemp("/private/tmp/goga-discard-test-");
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, "repo"),
    home = path.join(dir, "home"),
    trash = path.join(dir, "trash");
  for (const p of [root, home, trash]) await fs.mkdir(p);
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
  const write = (name: string, text: string | Buffer) =>
    fs.writeFile(path.join(root, name), text);
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await write("selected", "base\n");
  await write("other", "base\n");
  await git(["add", "."]);
  await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "base"]);
  let ownerKey = "owner",
    now = 1000;
  const reader = new GitWorkspaceReader({
    root,
    scope: "project",
    verify: async () => {},
    git: async (args) => (await git(args)).stdout,
  });
  const context: GitCommitContext = {
    scope: "project",
    root,
    ownerKey,
    snapshot: () => reader.snapshot(),
    verify: async () => {},
    refTransaction: (args, input, check) =>
      runner.gitRefTransaction(args, root, env, input, check),
    git: (args, options) =>
      options?.indexFile
        ? withTrustedGitIndex(options.indexFile, () => git(args, options.stdin))
        : git(args, options?.stdin),
  };
  const actions = new GitDiscardActions({
    context: async (_scope, fn) => fn({ ...context, ownerKey }),
    now: () => now,
    trashItem: async (filename) =>
      fs.rename(filename, path.join(trash, path.basename(filename))),
    ...extra,
  });
  const prepare = async (paths = ["selected"]) =>
    actions.prepare({
      scope: "project",
      revision: (await reader.snapshot()).revision,
      paths,
    });
  return {
    root,
    trash,
    git,
    write,
    reader,
    context,
    actions,
    prepare,
    index: () => fs.readFile(path.join(root, ".git/index")),
    setOwner: (v: string) => {
      ownerKey = v;
    },
    setNow: (v: number) => {
      now = v;
    },
  };
}
describe("selected whole-file discard", () => {
  it("restores HEAD in worktree and index while preserving unselected staged and working content", async () => {
    const f = await fixture();
    await f.write("selected", "staged\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "working\n");
    await f.write("other", "other staged\n");
    await f.git(["add", "other"]);
    await f.write("other", "other working\n");
    const before = await f.index(),
      p = await f.prepare();
    expect(p.items).toEqual([{ path: "selected", action: "restore" }]);
    expect(await f.index()).toEqual(before);
    const result = await f.actions.execute(p.token);
    expect(result.log).toBe("");
    expect(result).toMatchObject({
      status: "discarded",
      changedPaths: ["selected"],
      indexPublished: true,
      worktreePublished: true,
    });
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "base\n",
    );
    expect((await f.git(["show", ":selected"])).stdout).toBe("base\n");
    expect((await f.git(["show", ":other"])).stdout).toBe("other staged\n");
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other working\n",
    );
  });
  it("moves untracked and staged-new bytes to injected Trash, never deleting unselected files", async () => {
    const f = await fixture();
    await f.write("new", Buffer.from([255, 0, 1]));
    await f.write("untracked", "trash");
    await f.write("unselected", "keep");
    await f.git(["add", "new"]);
    const p = await f.prepare(["new", "untracked"]);
    expect(p.items.every((i) => i.action === "trash")).toBe(true);
    expect(await f.actions.execute(p.token)).toMatchObject({
      status: "discarded",
      trashedPaths: ["new", "untracked"],
    });
    expect(await fs.readFile(path.join(f.trash, "new"))).toEqual(
      Buffer.from([255, 0, 1]),
    );
    expect(await fs.readFile(path.join(f.root, "unselected"), "utf8")).toBe(
      "keep",
    );
    expect((await f.git(["ls-files", "--", "new"])).stdout).toBe("");
  });
  it("restores deletion and explicitly expands both staged rename endpoints", async () => {
    const f = await fixture();
    await f.git(["mv", "selected", "renamed"]);
    const p = await f.prepare(["renamed"]);
    expect(new Set(p.paths)).toEqual(new Set(["selected", "renamed"]));
    expect(p.items).toContainEqual({ path: "selected", action: "restore" });
    expect(p.items).toContainEqual({ path: "renamed", action: "trash" });
    expect((await f.actions.execute(p.token)).status).toBe("discarded");
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "base\n",
    );
    await fs.unlink(path.join(f.root, "selected"));
    expect((await f.actions.execute((await f.prepare()).token)).status).toBe(
      "discarded",
    );
  });
  it("rejects changed bytes with restored mtime and token replay", async () => {
    const f = await fixture();
    await f.write("selected", "aaaa\n");
    const p = await f.prepare();
    const s = await fs.stat(path.join(f.root, "selected"));
    await f.write("selected", "bbbb\n");
    await fs.utimes(path.join(f.root, "selected"), s.atime, s.mtime);
    await expect(f.actions.execute(p.token)).rejects.toThrow(/устарел|измен/);
    await expect(f.actions.execute(p.token)).rejects.toThrow(
      /использован|истек/,
    );
  });
  it("rejects expired, foreign-owner and malformed path requests", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    let p = await f.prepare();
    f.setNow(p.expiresAt);
    await expect(f.actions.execute(p.token)).rejects.toThrow(/истек/);
    f.setNow(1000);
    p = await f.prepare();
    f.setOwner("foreign");
    await expect(f.actions.execute(p.token)).rejects.toThrow(
      /владелец|устарел/,
    );
    await expect(f.prepare(["../escape"])).rejects.toThrow();
  });
  it("leaves foreign index.lock untouched and refuses linked worktree paths", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    const p = await f.prepare();
    const before = await f.index();
    await fs.writeFile(path.join(f.root, ".git/index.lock"), "foreign");
    expect((await f.actions.execute(p.token)).status).toBe("not-discarded");
    expect(await f.index()).toEqual(before);
    expect(
      await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
    ).toBe("foreign");
    await fs.unlink(path.join(f.root, ".git/index.lock"));
    await fs.unlink(path.join(f.root, "selected"));
    await fs.symlink("other", path.join(f.root, "selected"));
    await expect(f.prepare()).rejects.toThrow(/тип|ссылк|Небезопас/);
  });
  it("reports partial publication and never rolls back over a later edit", async () => {
    let root = "";
    const f = await fixture({
      afterPublishWork: () => {
        writeFileSync(path.join(root, "selected"), "newer edit");
        throw Error("injected failure");
      },
    });
    root = f.root;
    await f.write("selected", "old edit");
    const before = await f.index();
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result).toMatchObject({
      status: "uncertain",
      worktreePublished: true,
      indexPublished: false,
    });
    expect(result.recoveryPath).toBeTruthy();
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "newer edit",
    );
    expect(await f.index()).toEqual(before);
    expect(
      await fs.readFile(
        path.join(result.recoveryPath!, "originals", "selected"),
        "utf8",
      ),
    ).toBe("old edit");
  });
  it("keeps new originals recoverable on Trash failure", async () => {
    const f = await fixture({
      trashItem: async () => {
        throw Error("Trash unavailable");
      },
    });
    await f.write("new", "recover me");
    const result = await f.actions.execute((await f.prepare(["new"])).token);
    expect(result.status).toBe("uncertain");
    expect(result.trashedPaths).toEqual([]);
    expect(
      await fs.readFile(
        path.join(result.recoveryPath!, "originals", "new"),
        "utf8",
      ),
    ).toBe("recover me");
  });
  it("completes an index-only discard when a staged-new working file is already absent", async () => {
    const f = await fixture();
    await f.write("new", "staged new");
    await f.git(["add", "new"]);
    await fs.unlink(path.join(f.root, "new"));
    const result = await f.actions.execute((await f.prepare(["new"])).token);
    expect(result).toMatchObject({
      status: "discarded",
      worktreePublished: true,
      indexPublished: true,
      changedPaths: ["new"],
      trashedPaths: [],
    });
    expect((await f.git(["ls-files", "--", "new"])).stdout).toBe("");
  });
  it("refuses unsupported non-UTF8 HEAD bytes without changing any source file", async () => {
    const f = await fixture();
    await f.write("selected", Buffer.from([255, 0, 1]));
    await f.git(["add", "selected"]);
    await f.git(["commit", "-m", "binary"]);
    await f.write("selected", "edit");
    const before = await f.index();
    await expect(f.prepare()).rejects.toThrow(/non-UTF8/);
    expect(await f.index()).toEqual(before);
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "edit",
    );
  });
  it("restores exact NUL-containing UTF8 bytes and executable mode", async () => {
    const f = await fixture();
    await f.write("selected", Buffer.from("hello\0world"));
    await fs.chmod(path.join(f.root, "selected"), 0o755);
    await f.git(["add", "selected"]);
    await f.git(["commit", "-m", "binary executable"]);
    await f.write("selected", "edit");
    await fs.chmod(path.join(f.root, "selected"), 0o644);
    expect((await f.actions.execute((await f.prepare()).token)).status).toBe(
      "discarded",
    );
    expect(await fs.readFile(path.join(f.root, "selected"))).toEqual(
      Buffer.from("hello\0world"),
    );
    expect((await fs.stat(path.join(f.root, "selected"))).mode & 0o111).toBe(
      0o111,
    );
  });
  it("refuses CRLF/filter conversions and missing parent directories before publication", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    await f.git(["config", "core.autocrlf", "true"]);
    await expect(f.prepare()).rejects.toThrow(/CRLF/);
    await f.git(["config", "core.autocrlf", "false"]);
    await f.write(".gitattributes", "selected filter=custom\n");
    await expect(f.prepare()).rejects.toThrow(/filter/);
    await fs.unlink(path.join(f.root, ".gitattributes"));
    await fs.mkdir(path.join(f.root, "sub"));
    await f.write("sub/file", "base");
    await f.git(["add", "sub/file"]);
    await f.git(["commit", "-m", "nested"]);
    await fs.rm(path.join(f.root, "sub"), { recursive: true });
    await expect(f.prepare(["sub/file"])).rejects.toThrow(/Родительская папка/);
  });
  it("refuses unborn HEAD and unavailable Trash without source writes", async () => {
    const f = await fixture({ trashItem: undefined });
    await f.write("new", "keep");
    await expect(f.prepare(["new"])).rejects.toThrow(/Корзина/);
    await f.git(["checkout", "--orphan", "unborn"]);
    await expect(f.prepare()).rejects.toThrow(/HEAD/);
  });
  it("binds config, selected index and HEAD changes to the one-use ticket", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    let p = await f.prepare();
    await f.git(["config", "test.changed", "yes"]);
    await expect(f.actions.execute(p.token)).rejects.toThrow(/устарел/);
    p = await f.prepare();
    await f.git(["add", "selected"]);
    await expect(f.actions.execute(p.token)).rejects.toThrow(/устарел/);
    p = await f.prepare();
    await f.git(["commit", "-m", "new head"]);
    await expect(f.actions.execute(p.token)).rejects.toThrow(/устарел/);
  });
  it("does not let caller mutation of a returned preview grant extra paths", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    await f.write("other", "other edit");
    const p = await f.prepare();
    p.paths.push("other");
    p.items.push({ path: "other", action: "restore" });
    expect((await f.actions.execute(p.token)).status).toBe("discarded");
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other edit",
    );
  });
  it("refuses a last-moment work edit before publication", async () => {
    let root = "";
    const f = await fixture({
      beforePublishWork: () =>
        writeFileSync(path.join(root, "selected"), "later"),
    });
    root = f.root;
    await f.write("selected", "old");
    const before = await f.index();
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result.status).toBe("not-discarded");
    expect(await f.index()).toEqual(before);
    expect(await fs.readFile(path.join(root, "selected"), "utf8")).toBe(
      "later",
    );
  });
  it("preserves completed facts if the outer owner-lock release throws", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    let releaseFailure = false;
    const actions = new GitDiscardActions({
      context: async (_scope, fn) => {
        const r = await fn(f.context);
        if (releaseFailure) throw Error("owner lock release");
        return r;
      },
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
    });
    releaseFailure = true;
    const result = await actions.execute(p.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      worktreePublished: true,
      changedPaths: ["selected"],
    });
    expect(result.recoveryPath).toBeTruthy();
  });
  it("refuses case-only rename aliases on case-insensitive filesystems before mutation", async () => {
    const f = await fixture();
    await f.git(["mv", "selected", "SELECTED"]);
    const before = await f.index();
    await expect(f.prepare(["SELECTED"])).rejects.toThrow(
      /пут.*один|регистр|совпад/,
    );
    expect(await f.index()).toEqual(before);
    expect(await fs.readFile(path.join(f.root, "SELECTED"), "utf8")).toBe(
      "base\n",
    );
  });
  it("reports a native HEAD lock-release warning as uncertain", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    const actions = new GitDiscardActions({
      context: async (_scope, fn) =>
        fn({
          ...f.context,
          refTransaction: async (...args) => ({
            ...(await f.context.refTransaction!(...args)),
            stderr: "ref lock cleanup warning",
          }),
        }),
    });
    const p = await actions.prepare({
      scope: "project",
      revision: (await f.reader.snapshot()).revision,
      paths: ["selected"],
    });
    const result = await actions.execute(p.token);
    expect(result).toMatchObject({
      status: "uncertain",
      indexPublished: true,
      worktreePublished: true,
    });
    expect(result.log).toContain("ref lock cleanup warning");
  });
  it("refuses normalized case-alias rename endpoints even when both working paths are absent", async () => {
    const f = await fixture();
    await f.git(["mv", "selected", "SELECTED"]);
    await fs.unlink(path.join(f.root, "SELECTED"));
    const before = await f.index();
    await expect(f.prepare(["SELECTED"])).rejects.toThrow(/регистр|совпад/);
    expect(await f.index()).toEqual(before);
    await expect(fs.lstat(path.join(f.root, "selected"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
  it("refuses a selected pathname that aliases an unselected tracked path", async () => {
    const f = await fixture();
    const oid = (
      await f.git(["hash-object", "-w", "--stdin"], "upper base")
    ).stdout.trim();
    await f.git([
      "-c",
      "core.ignorecase=false",
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${oid},SELECTED`,
    ]);
    await f.git(["commit", "-m", "case-colliding tree"]);
    await f.write("selected", "edit");
    const before = await f.index();
    await expect(f.prepare()).rejects.toThrow(/регистр|совпад/);
    expect(await f.index()).toEqual(before);
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "edit",
    );
  });
});
