import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as nativeFs from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { NodeRunner } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { NativeGitDiscardActions as GitDiscardActions } from "../src/host/git-native-discard";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../src/host/git-native-context";
import { NativeGitJournal } from "../src/host/git-native-journal";
import type { GitCommitContext } from "../src/host/git-workspace-actions";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
vi.setConfig({ testTimeout: 20000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(nativeFs.rmSync).mockRestore();
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
    native: createNativeGitCapability({
      root,
      env,
      runner,
      journal: new NativeGitJournal({ directory: path.join(home, "journal") }),
      owner: async () => ({
        scope: "project",
        projectPath: root,
        registryRevision: nativeIntent(ownerKey),
      }),
    }),
    root,
    ownerKey,
    snapshot: () => reader.snapshot(),
    verify: async () => {},
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
    home,
    trash,
    runner,
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

describe("native selected discard", () => {
  it("restores only selected HEAD bytes and index entries and removes verified recovery", async () => {
    const f = await fixture();
    await f.write("selected", "staged\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "work\n");
    await f.write("other", "other staged\n");
    await f.git(["add", "other"]);
    await f.write("other", "other work\n");
    const oldHead = (await f.git(["rev-parse", "HEAD"])).stdout;
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result).toMatchObject({
      status: "discarded",
      indexPublished: true,
      worktreePublished: true,
    });
    expect(result.recoveryPath).toBeUndefined();
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "base\n",
    );
    expect((await f.git(["show", ":selected"])).stdout).toBe("base\n");
    expect((await f.git(["show", ":other"])).stdout).toBe("other staged\n");
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other work\n",
    );
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(oldHead);
    expect(
      (await fs.readdir(path.join(f.root, ".git"))).filter((n) =>
        n.startsWith("goga-"),
      ),
    ).toEqual([]);
  });
  it("trashes new files including rename endpoints and restores the selected source", async () => {
    const f = await fixture();
    await f.git(["mv", "selected", "renamed\nЮ"]);
    await f.write("new", "new\n");
    await f.git(["add", "new"]);
    const result = await f.actions.execute(
      (await f.prepare(["renamed\nЮ", "new"])).token,
    );
    expect(result.status).toBe("discarded");
    expect(result.trashedPaths.sort()).toEqual(["new", "renamed\nЮ"]);
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "base\n",
    );
    expect((await f.git(["status", "--porcelain"])).stdout).toBe("");
    expect(await fs.readFile(path.join(f.trash, "new"), "utf8")).toBe("new\n");
  });
  it("retains portable recovery and reports partial work when index write is refused", async () => {
    const f = await fixture({
      afterPublishWork: () =>
        nativeFs.writeFileSync(path.join(f.root, ".git/index.lock"), "foreign"),
    });
    await f.write("selected", "staged\n");
    await f.git(["add", "selected"]);
    await f.write("selected", "work\n");
    const result = await f.actions.execute((await f.prepare()).token);
    expect(result).toMatchObject({
      status: "uncertain",
      worktreePublished: true,
      indexPublished: false,
      recoveryPath: expect.any(String),
    });
    expect(
      await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
    ).toBe("foreign");
    const record = JSON.parse(await fs.readFile(result.recoveryPath!, "utf8"));
    expect(
      record.recovery.indexRecovery.objects.some(
        (o: { data: string }) =>
          Buffer.from(o.data, "base64").toString() === "staged\n",
      ),
    ).toBe(true);
    expect((await f.git(["show", ":selected"])).stdout).toBe("staged\n");
  });
});

it("keeps portable originals on Trash failure and never rolls back newer edits", async () => {
  const f = await fixture({
    trashItem: async () => {
      throw Error("Trash unavailable");
    },
  });
  await f.write("new", "recover me");
  const result = await f.actions.execute((await f.prepare(["new"])).token);
  expect(result).toMatchObject({
    status: "uncertain",
    trashedPaths: [],
    recoveryPath: expect.any(String),
  });
  const saved = JSON.parse(
    await fs.readFile(result.recoveryPath!, "utf8"),
  ).recovery;
  expect(
    saved.files.find((file: { path: string }) => file.path === "new").data,
  ).toBe(Buffer.from("recover me").toString("base64"));
});
it("preserves a later edit after work publication failure", async () => {
  const f = await fixture({
    afterPublishWork: () => {
      writeFileSync(path.join(f.root, "selected"), "later");
      throw Error("failure");
    },
  });
  await f.write("selected", "old");
  const oldIndex = await f.index();
  const result = await f.actions.execute((await f.prepare()).token);
  expect(result).toMatchObject({
    status: "uncertain",
    worktreePublished: true,
    indexPublished: false,
  });
  expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
    "later",
  );
  expect(await f.index()).toEqual(oldIndex);
});
it("does not touch a foreign index lock or linked source path", async () => {
  const f = await fixture();
  await f.write("selected", "edit");
  const p = await f.prepare(),
    oldIndex = await f.index();
  await fs.writeFile(path.join(f.root, ".git/index.lock"), "foreign");
  await expect(f.actions.execute(p.token)).rejects.toThrow();
  expect(await f.index()).toEqual(oldIndex);
  expect(await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8")).toBe(
    "foreign",
  );
  expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe("edit");
  await fs.unlink(path.join(f.root, ".git/index.lock"));
  await fs.unlink(path.join(f.root, "selected"));
  await fs.symlink("other", path.join(f.root, "selected"));
  await expect(f.prepare()).rejects.toThrow();
});
it("does not confuse a literal ready filename with prepared output", async () => {
  const f = await fixture();
  await f.git(["mv", "selected", "ready"]);
  await f.git(["commit", "-m", "name"]);
  await f.write("ready", "changed");
  expect(
    (await f.actions.execute((await f.prepare(["ready"])).token)).status,
  ).toBe("discarded");
  expect(await fs.readFile(path.join(f.root, "ready"), "utf8")).toBe("base\n");
});

describe("native discard retained admission", () => {
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
  it("preserves completed facts if the outer owner-lock release throws", async () => {
    const f = await fixture();
    await f.write("selected", "edit");
    let releaseFailure = false;
    const actions = new GitDiscardActions({
      context: async (_scope, fn) => {
        const r = await fn(f.context);
        if (releaseFailure) throw Error("fixture-secret-owner-lock");
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
    expect(result.log).not.toContain("fixture-secret-owner-lock");
    const directory = path.join(f.home, "journal");
    const files = await fs.readdir(directory);
    const record = JSON.parse(
      await fs.readFile(
        path.join(
          directory,
          files.find((n) => n.endsWith(".json"))!,
        ),
        "utf8",
      ),
    );
    expect(record.recovery).not.toBeNull();
    expect(files.some((n) => n.endsWith(".pending"))).toBe(true);
    await expect(
      f.context.native!.journal.assertAdmission(f.root, record.recovery.owner),
    ).rejects.toThrow();
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

it.each(["saved-parent", "ready"])(
  "refuses replaced staging %s before moving user data",
  async (what) => {
    const f = await fixture({
      beforePublishWork: () => {
        const stage = path.join(
          f.root,
          ".git",
          nativeFs
            .readdirSync(path.join(f.root, ".git"))
            .find((n) => n.startsWith("goga-native-files-"))!,
          "0",
        );
        if (what === "saved-parent") {
          nativeFs.rmdirSync(path.join(stage, "original"));
          nativeFs.symlinkSync(
            path.join(f.home, "outside"),
            path.join(stage, "original"),
          );
        } else {
          nativeFs.writeFileSync(
            path.join(stage, "ready"),
            "foreign prepared content",
          );
        }
      },
    });
    await fs.mkdir(path.join(f.home, "outside"));
    await fs.writeFile(path.join(f.home, "outside/selected"), "untouched");
    await f.write("selected", "original draft");
    const oldIndex = await f.index(),
      result = await f.actions.execute((await f.prepare()).token);
    expect(result.status).not.toBe("discarded");
    expect(
      await fs.readFile(path.join(f.home, "outside/selected"), "utf8"),
    ).toBe("untouched");
    expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
      "original draft",
    );
    expect(await f.index()).toEqual(oldIndex);
  },
);
it("syncs the staging directory entry before publishing files", async () => {
  const f = await fixture();
  await f.write("selected", "draft");
  const gd = await fs.stat(path.join(f.root, ".git"));
  let synced = false;
  const original = nativeFs.fsyncSync;
  vi.spyOn(nativeFs, "fsyncSync").mockImplementation((fd) => {
    const st = nativeFs.fstatSync(fd);
    if (st.dev === gd.dev && st.ino === gd.ino) synced = true;
    original(fd);
  });
  const result = await f.actions.execute((await f.prepare()).token);
  expect(result.status).toBe("discarded");
  expect(synced).toBe(true);
});

it("retains discard recovery on a successful index command with cleanup warning", async () => {
  const f = await fixture();
  await f.write("selected", "changed\n");
  const run = f.runner.commandBytes.bind(f.runner);
  vi.spyOn(f.runner, "commandBytes").mockImplementation(async (command) => {
    const result = await run(command);
    return command.args.includes("update-index")
      ? { ...result, stderr: Buffer.from("index cleanup warning") }
      : result;
  });
  const result = await f.actions.execute((await f.prepare()).token);
  expect(result).toMatchObject({
    status: "uncertain",
    indexPublished: true,
    recoveryPath: expect.any(String),
  });
  expect(result.log).toContain("index cleanup warning");
});

it("trashes exact binary new bytes and cleans only its own recovery", async () => {
  const f = await fixture();
  const old = path.join(f.root, ".git/goga-commit-old");
  await fs.mkdir(old);
  await fs.writeFile(path.join(old, "keep"), "prior backup");
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  await f.write("new", bytes);
  await f.write("staged-new", bytes);
  await f.git(["add", "staged-new"]);
  await f.write("unselected", "keep new");
  const result = await f.actions.execute(
    (await f.prepare(["new", "staged-new"])).token,
  );
  expect(result).toMatchObject({ status: "discarded", indexPublished: true });
  expect(result.recoveryPath).toBeUndefined();
  for (const name of ["new", "staged-new"])
    expect(await fs.readFile(path.join(f.trash, name))).toEqual(bytes);
  expect(await fs.readFile(path.join(f.root, "unselected"), "utf8")).toBe(
    "keep new",
  );
  expect(await fs.readFile(path.join(old, "keep"), "utf8")).toBe(
    "prior backup",
  );
  expect(
    (await fs.readdir(path.join(f.root, ".git"))).filter((n) =>
      n.startsWith("goga-"),
    ),
  ).toEqual(["goga-commit-old"]);
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
  expect(result.status).not.toBe("discarded");
  expect(result).toMatchObject({
    indexPublished: false,
    worktreePublished: false,
  });
  expect(await f.index()).toEqual(before);
  expect(await fs.readFile(path.join(root, "selected"), "utf8")).toBe("later");
});
it("retains verified discard originals and fences writes if cleanup fails", async () => {
  const f = await fixture();
  await f.write("selected", "saved edits");
  vi.spyOn(nativeFs, "rmSync").mockImplementation(() => {
    throw Error("fixture-secret-cleanup");
  });
  const result = await f.actions.execute((await f.prepare()).token);
  expect(result).toMatchObject({
    status: "uncertain",
    worktreePublished: true,
    indexPublished: true,
  });
  expect(result.log).not.toContain("fixture-secret-cleanup");
  expect(result.recoveryPath).toBeTruthy();
  const saved = JSON.parse(
    await fs.readFile(result.recoveryPath!, "utf8"),
  ).recovery;
  expect(
    Buffer.from(
      saved.files.find((file: { path: string }) => file.path === "selected")
        .data,
      "base64",
    ).toString(),
  ).toBe("saved edits");
  await expect(
    f.context.native!.journal.assertAdmission(f.root, saved.owner),
  ).rejects.toThrow();
  const staging = (await fs.readdir(path.join(f.root, ".git"))).find((name) =>
    name.startsWith("goga-native-files-"),
  )!;
  const original = JSON.parse(
    await fs.readFile(
      path.join(f.root, ".git", staging, "snapshot.json"),
      "utf8",
    ),
  );
  expect(
    await fs.readFile(
      original.originals.find(([name]: [string]) => name === "selected")[1],
      "utf8",
    ),
  ).toBe("saved edits");
});

it("retains discard recovery on a native ref cleanup warning", async () => {
  const f = await fixture();
  await f.write("selected", "edit");
  const run = f.runner.commandBytes.bind(f.runner);
  vi.spyOn(f.runner, "commandBytes").mockImplementation(async (command) => {
    const result = await run(command);
    return command.args.includes("update-ref")
      ? { ...result, stderr: Buffer.from("ref cleanup warning") }
      : result;
  });
  const result = await f.actions.execute((await f.prepare()).token);
  expect(result).toMatchObject({
    status: "uncertain",
    indexPublished: true,
    worktreePublished: true,
    recoveryPath: expect.any(String),
  });
  expect(result.log).toContain("ref cleanup warning");
});

it("cleans deferred recovery after a verified native rejection without changing files", async () => {
  const f = await fixture();
  await f.write("selected", "keep edits");
  const index = await f.index();
  const run = f.runner.commandBytes.bind(f.runner);
  vi.spyOn(f.runner, "commandBytes").mockImplementation((command) =>
    command.args.includes("update-ref")
      ? Promise.resolve({
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          exitCode: 1,
          signal: null,
          processSettled: true,
        })
      : run(command),
  );
  const result = await f.actions.execute((await f.prepare()).token);
  expect(result).toMatchObject({
    status: "not-discarded",
    worktreePublished: false,
    indexPublished: false,
  });
  expect(result.recoveryPath).toBeUndefined();
  expect(await f.index()).toEqual(index);
  expect(await fs.readFile(path.join(f.root, "selected"), "utf8")).toBe(
    "keep edits",
  );
  const directory = path.join(f.home, "journal");
  const files = await fs.readdir(directory);
  expect(files.some((name) => name.endsWith(".pending"))).toBe(false);
  const record = JSON.parse(
    await fs.readFile(
      path.join(
        directory,
        files.find((name) => name.endsWith(".json"))!,
      ),
      "utf8",
    ),
  );
  expect(record.recovery).toBeNull();
  expect(
    (await fs.readdir(path.join(f.root, ".git"))).some((name) =>
      name.startsWith("goga-native-files-"),
    ),
  ).toBe(false);
});

it("does not claim discard completion if deferred journal finalization is unknown", async () => {
  const f = await fixture();
  await f.write("selected", "recover edits");
  const journal = f.context.native!.journal;
  const execute = journal.execute.bind(journal);
  vi.spyOn(journal, "execute").mockImplementation((options) =>
    execute({
      ...options,
      deferRecoveryCleanup: (finish, result) =>
        options.deferRecoveryCleanup?.(async () => {
          // Simulate a failed final journal settlement without releasing its real fence.
          void finish;
          const directory = path.join(f.home, "journal");
          const file = (await fs.readdir(directory)).find((name) =>
            name.endsWith(".json"),
          )!;
          const record = JSON.parse(
            await fs.readFile(path.join(directory, file), "utf8"),
          );
          return { ...record.result, recovery: "unknown" };
        }, result),
    }),
  );
  const result = await f.actions.execute((await f.prepare()).token);
  expect(result).toMatchObject({
    status: "uncertain",
    worktreePublished: true,
    indexPublished: true,
  });
  const record = JSON.parse(await fs.readFile(result.recoveryPath!, "utf8"));
  expect(
    Buffer.from(
      record.recovery.files.find(
        (file: { path: string }) => file.path === "selected",
      ).data,
      "base64",
    ).toString(),
  ).toBe("recover edits");
  await expect(
    journal.assertAdmission(f.root, record.recovery.owner),
  ).rejects.toThrow();
});
