import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { NodeRunner, CommandExitError } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { withOfflineGitReadScope } from "../src/host/read-scope";

vi.setConfig({ testTimeout: 15000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
async function fixture(
  options: {
    rootName?: string;
    globalConfig?: boolean;
    legacyConfig?: boolean;
    legacyAttributes?: boolean;
    gitExecutable?: string;
  } = {},
) {
  const dir = await fs.mkdtemp("/private/tmp/goga-git-reader-");
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"),
    root = path.join(dir, options.rootName ?? "repo");
  await fs.mkdir(home);
  await fs.mkdir(root);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    GIT_CONFIG_GLOBAL: options.globalConfig
      ? path.join(home, ".gitconfig")
      : "/dev/null",
    GIT_CONFIG: options.legacyConfig
      ? path.join(home, "legacy-config")
      : undefined,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && !(key in env)) env[key] = undefined;
  const runner = new NodeRunner(10000, env);
  cleanup.push(() => runner.dispose());
  const git = async (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
    if (
      options.legacyAttributes &&
      args.includes("var") &&
      args.some((arg) => /^GIT_ATTR_(GLOBAL|SYSTEM)$/.test(arg))
    )
      throw new CommandExitError(
        "Неподдерживаемая переменная Git",
        129,
        "",
        "использование: git var (-l | <переменная>)\n",
      );
    return (
      await runner.command(
        options.gitExecutable ?? "git",
        ["-c", "core.hooksPath=/dev/null", ...args],
        root,
        { ...env, ...overrides },
      )
    ).stdout;
  };
  await git(["init", "-b", "main"]);
  const write = (name: string, text: string | Buffer) =>
    fs.writeFile(path.join(root, name), text);
  const commit = async () => {
    await git(["add", "."]);
    await git(["commit", "-m", "fixture"]);
  };
  const calls: string[][] = [];
  const verify = vi.fn(async () => {});
  const reader = new GitWorkspaceReader({
    scope: "project",
    root,
    git: async (args) => {
      calls.push(args);
      return git(args);
    },
    verify,
  });
  return { dir, root, home, git, write, commit, calls, verify, reader };
}

describe("read-only Git workspace", () => {
  it("reads empty unborn and detached repositories", async () => {
    const f = await fixture();
    expect(await f.reader.snapshot()).toMatchObject({
      scope: "project",
      root: f.root,
      head: null,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      operation: "none",
      files: [],
    });
    await f.write("a", "base\n");
    await f.commit();
    const head = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git(["checkout", "--detach"]);
    expect(await f.reader.snapshot()).toMatchObject({
      head,
      branch: null,
      files: [],
    });
  });

  it("preserves exact ordinary, add, delete, rename and untracked paths", async () => {
    const f = await fixture();
    for (const name of ["ordinary", "deleted", "old name"])
      await f.write(name, "base\n");
    await f.commit();
    await f.write("ordinary", "new\n");
    await fs.unlink(path.join(f.root, "deleted"));
    await f.git(["mv", "old name", "new\nЮникод name"]);
    await f.write("added", "added\n");
    await f.git(["add", "added"]);
    await f.write("untracked\nЮникод file", "free\n");
    const result = await f.reader.snapshot();
    expect(result.files).toEqual(
      expect.arrayContaining([
        {
          path: "ordinary",
          indexStatus: ".",
          worktreeStatus: "M",
          kind: "tracked",
          submodule: false,
        },
        {
          path: "deleted",
          indexStatus: ".",
          worktreeStatus: "D",
          kind: "tracked",
          submodule: false,
        },
        {
          path: "added",
          indexStatus: "A",
          worktreeStatus: ".",
          kind: "tracked",
          submodule: false,
        },
        {
          path: "new\nЮникод name",
          originalPath: "old name",
          indexStatus: "R",
          worktreeStatus: ".",
          kind: "tracked",
          submodule: false,
        },
        {
          path: "untracked\nЮникод file",
          indexStatus: "?",
          worktreeStatus: "?",
          kind: "untracked",
          submodule: false,
        },
      ]),
    );
    expect(result.files).toHaveLength(5);
  });

  it("separates staged and unstaged patches and preserves the dirty index byte-for-byte", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "staged\n");
    await f.git(["add", "a"]);
    await f.write("a", "working\n");
    const before = await fs.readFile(path.join(f.root, ".git/index"));
    const snap = await f.reader.snapshot();
    const diff = await f.reader.diff({
      scope: "project",
      path: "a",
      revision: snap.revision,
    });
    expect(diff.staged).toMatchObject({
      kind: "patch",
      text: expect.stringContaining("+staged"),
    });
    expect(diff.unstaged).toMatchObject({
      kind: "patch",
      text: expect.stringContaining("+working"),
    });
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(before);
    expect(f.verify).toHaveBeenCalled();
    for (const args of f.calls)
      expect(args).toEqual(
        expect.arrayContaining([
          "--no-optional-locks",
          "--no-pager",
          "--literal-pathspecs",
          "core.hooksPath=/dev/null",
          "core.fsmonitor=false",
          "diff.external=",
        ]),
      );
    for (const args of f.calls.filter((args) => args.includes("diff")))
      expect(args).toEqual(
        expect.arrayContaining(["--no-ext-diff", "--no-textconv"]),
      );
  });

  it("reads bounded untracked text and makes binary, empty and large files explicit", async () => {
    const f = await fixture();
    await f.write("text", "Юникод\n");
    await f.write("binary", Buffer.from([0, 1, 255]));
    await f.write("empty", "");
    await f.write("large", "x".repeat(1024 * 1024 + 1));
    const snap = await f.reader.snapshot();
    const read = (name: string) =>
      f.reader.diff({ scope: "project", path: name, revision: snap.revision });
    expect((await read("text")).unstaged).toEqual({
      kind: "text",
      text: "Юникод\n",
    });
    expect((await read("binary")).unstaged.kind).toBe("binary");
    expect((await read("empty")).unstaged.kind).toBe("empty");
    expect((await read("large")).unstaged.kind).toBe("unavailable");
  });

  it("rejects stale same-status content and index revisions, wrong owners and absent paths", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "work\n");
    const before = await f.reader.snapshot();
    await f.write("a", "edit\n");
    const after = await f.reader.snapshot();
    expect(after.revision).not.toBe(before.revision);
    await expect(
      f.reader.diff({ scope: "project", path: "a", revision: before.revision }),
    ).rejects.toThrow(/устарел/i);
    await expect(
      f.reader.diff({ scope: "other", path: "a", revision: after.revision }),
    ).rejects.toThrow(/контекст/i);
    await expect(
      f.reader.diff({
        scope: "project",
        path: "absent",
        revision: after.revision,
      }),
    ).rejects.toThrow(/списк/i);
    await f.git(["add", "a"]);
    expect((await f.reader.snapshot()).revision).not.toBe(after.revision);
  });

  it("does not follow untracked symlinks or linked Git directories", async () => {
    const f = await fixture();
    const secret = path.join(f.dir, "secret");
    await fs.writeFile(secret, "outside secret");
    await fs.symlink(secret, path.join(f.root, "link"));
    const snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "link",
          revision: snap.revision,
        })
      ).unstaged.kind,
    ).toBe("unavailable");
    await fs.rename(path.join(f.root, ".git"), path.join(f.dir, "metadata"));
    await fs.symlink(path.join(f.dir, "metadata"), path.join(f.root, ".git"));
    await expect(f.reader.snapshot()).rejects.toThrow(/Git|git/);
  });

  it("reports real merge conflicts without inventing ordinary patches", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.git(["checkout", "-b", "other"]);
    await f.write("a", "other\n");
    await f.commit();
    await f.git(["checkout", "main"]);
    await f.write("a", "main\n");
    await f.commit();
    await expect(f.git(["merge", "other"])).rejects.toThrow();
    const snap = await f.reader.snapshot();
    expect(snap.operation).toBe("merge");
    expect(snap.files[0]).toMatchObject({
      path: "a",
      kind: "conflict",
      indexStatus: "U",
      worktreeStatus: "U",
    });
    const diff = await f.reader.diff({
      scope: "project",
      path: "a",
      revision: snap.revision,
    });
    expect(diff.staged.kind).toBe("unavailable");
    expect(diff.unstaged.kind).toBe("unavailable");
  });

  it("never runs clean/process/textconv/external-diff/fsmonitor helpers", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    const sentinel = path.join(f.dir, "helper-ran");
    const command = `touch '${sentinel}'`;
    await f.git(["config", "filter.hostile.clean", command]);
    await f.git(["config", "filter.hostile.process", command]);
    await f.git(["config", "filter.hostile.required", "true"]);
    await f.git(["config", "diff.hostile.textconv", command]);
    await f.git(["config", "diff.external", command]);
    await f.git(["config", "core.fsmonitor", command]);
    await f.write(".gitattributes", "a filter=hostile diff=hostile\n");
    await f.write("a", "working\n");
    const snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged.text,
    ).toContain("+working");
    await expect(fs.access(sentinel)).rejects.toThrow();
  });

  it.each([
    ["snapshot", "clean", false],
    ["snapshot", "process", false],
    ["diff", "clean", false],
    ["diff", "process", false],
    ["snapshot", "clean", true],
    ["snapshot", "process", true],
    ["diff", "clean", true],
    ["diff", "process", true],
  ])(
    "never executes a newly installed %s %s filter at the command boundary (legacy attributes=%s)",
    async (operation, driver, legacyAttributes) => {
      const f = await fixture({ legacyAttributes: !!legacyAttributes });
      await f.write("a", "base\n");
      await f.write(".gitattributes", "a filter=late\n");
      await f.commit();
      await f.write("a", "work\n");
      const baseline = await f.reader.snapshot();
      const marker = path.join(f.dir, "late-filter-ran");
      let installed = false;
      const reader = new GitWorkspaceReader({
        scope: "project",
        root: f.root,
        verify: f.verify,
        git: async (args) => {
          const target =
            operation === "snapshot"
              ? args.includes("status")
              : args.includes("diff") && !args.includes("--raw");
          if (target && !installed) {
            installed = true;
            await f.git([
              "config",
              `filter.late.${driver}`,
              `printf ran > '${marker}'; cat`,
            ]);
          }
          return f.git(args);
        },
      });
      // Refusal after detecting concurrent config changes is valid, but executing
      // a newly installed driver before that refusal is never a read-only action.
      await (
        operation === "snapshot"
          ? reader.snapshot()
          : reader.diff({
              scope: "project",
              path: "a",
              revision: baseline.revision,
            })
      ).catch(() => undefined);
      expect(installed).toBe(true);
      expect(
        await fs.stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    },
  );

  it("preserves native racy-clean detection instead of trusting a newly timestamped copied index", async () => {
    const f = await fixture();
    await f.git(["config", "core.checkstat", "minimal"]);
    await f.git(["config", "core.trustctime", "false"]);
    await f.write("a", "base\n");
    const time = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(path.join(f.root, "a"), time, time);
    await f.commit();
    await f.write("a", "work\n");
    await fs.utimes(path.join(f.root, "a"), time, time);
    await fs.utimes(path.join(f.root, ".git/index"), time, time);
    expect(
      await f.git(["--no-optional-locks", "status", "--porcelain"]),
    ).toContain(" M a");
    const snap = await f.reader.snapshot();
    expect(snap.files).toContainEqual(
      expect.objectContaining({ path: "a", worktreeStatus: "M" }),
    );
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged.text,
    ).toContain("+work");
  });

  it.each(["local include", "conditional include", "global"])(
    "never reloads a late filter through %s",
    async (source) => {
      const f = await fixture({ globalConfig: true });
      await f.write("a", "base\n");
      await f.write(".gitattributes", "a filter=late\n");
      await f.commit();
      await f.write("a", "work\n");
      const config =
        source === "global"
          ? path.join(f.home, ".gitconfig")
          : path.join(f.dir, "included");
      await fs.writeFile(config, "[core]\n autocrlf = false\n");
      if (source !== "global")
        await f.git([
          "config",
          source === "conditional include"
            ? `includeIf.gitdir:${f.root}/.git.path`
            : "include.path",
          config,
        ]);
      const marker = path.join(f.dir, "included-filter-ran");
      let installed = false;
      const reader = new GitWorkspaceReader({
        scope: "project",
        root: f.root,
        verify: f.verify,
        git: async (args) => {
          if (args.includes("status") && !installed) {
            installed = true;
            await f.git([
              "config",
              "--file",
              config,
              "filter.late.clean",
              `printf ran > '${marker}'; cat`,
            ]);
          }
          return f.git(args);
        },
      });
      await expect(reader.snapshot()).rejects.toThrow(/устарел/i);
      expect(installed).toBe(true);
      expect(
        await fs.stat(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    },
  );

  it("preserves native newline conversion and global attributes with immutable flattened include configuration", async () => {
    const f = await fixture({ globalConfig: true });
    const included = path.join(f.dir, "included"),
      attributes = path.join(f.home, "attributes");
    await fs.writeFile(included, "[core]\n autocrlf = true\n");
    await f.git(["config", `includeIf.gitdir:${f.root}/.git.path`, included]);
    await f.git(["config", "--global", "core.attributesfile", attributes]);
    await fs.writeFile(attributes, "*.txt text eol=lf\n");
    await f.write("a.txt", "base\n");
    await f.write("native", "base\n");
    await f.commit();
    await f.write("a.txt", "base\r\n");
    await f.write("native", "base\r\n");
    const native = (
      await f.git(["--no-optional-locks", "status", "--porcelain", "-z"])
    )
      .split("\0")
      .filter(Boolean)
      .map((row) => ({
        path: row.slice(3),
        indexStatus: row[0].replace(" ", "."),
        worktreeStatus: row[1].replace(" ", "."),
      }));
    expect(
      (await f.reader.snapshot()).files.map(
        ({ path, indexStatus, worktreeStatus }) => ({
          path,
          indexStatus,
          worktreeStatus,
        }),
      ),
    ).toEqual(native);
    await f.write("a.txt", "work\r\n");
    const snap = await f.reader.snapshot();
    const diff = await f.reader.diff({
      scope: "project",
      path: "a.txt",
      revision: snap.revision,
    });
    expect(diff.unstaged.text).toBe(
      await f.git([
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "a.txt",
      ]),
    );
    expect(diff.unstaged.text).not.toContain("\r");
  });

  it("captures native repository policy rather than the legacy GIT_CONFIG override used only by git config", async () => {
    const f = await fixture({ legacyConfig: true });
    await fs.writeFile(
      path.join(f.home, "legacy-config"),
      "[core]\n autocrlf = false\n",
    );
    await fs.appendFile(
      path.join(f.root, ".git/config"),
      "[core]\n autocrlf = true\n",
    );
    await f.write("a", "base\r\n");
    await f.commit();
    await f.write("a", "work\r\n");
    const nativeStatus = await f.git([
      "--no-optional-locks",
      "status",
      "--porcelain",
    ]);
    expect(nativeStatus).toBe(" M a\n");
    const expected = await f.git([
      "--no-pager",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      "a",
    ]);
    expect(expected).not.toContain("\r");
    const snap = await f.reader.snapshot();
    expect(snap.files).toContainEqual(
      expect.objectContaining({ path: "a", worktreeStatus: "M" }),
    );
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged.text,
    ).toBe(expected);
  });

  it("reads a source root containing whitespace, Unicode, quotes and a newline without writing objects, index or refs", async () => {
    const f = await fixture({ rootName: 'repo Юникод "quote"\nline' });
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "work\n");
    const inspect = async () => {
      const rows: string[] = [];
      const visit = async (relative: string) => {
        const filename = path.join(f.root, ".git", relative),
          s = await fs.lstat(filename, { bigint: true });
        rows.push(
          `${relative}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
        );
        if (s.isDirectory())
          for (const name of (await fs.readdir(filename)).sort())
            await visit(path.join(relative, name));
        else
          rows.push(
            createHash("sha256")
              .update(await fs.readFile(filename))
              .digest("hex"),
          );
      };
      for (const name of ["objects", "refs", "index", "HEAD", "config"])
        await visit(name);
      return rows;
    };
    const before = await inspect(),
      snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged.text,
    ).toContain("+work");
    expect(await inspect()).toEqual(before);
  });

  it.each([
    ["capture", "GIT_TRACE"],
    ["private", "GIT_TRACE"],
    ["offline", "GIT_TRACE"],
    ["capture", "GIT_TRACE2_EVENT"],
    ["private", "GIT_TRACE2_EVENT"],
    ["offline", "GIT_TRACE2_EVENT"],
  ])(
    "never lets %s reads write an ambient %s trace into source metadata",
    async (phase, key) => {
      const f = await fixture();
      await f.write("a", "base\n");
      await f.commit();
      await f.write("a", "work\n");
      const target = path.join(f.root, ".git", "trace-side-effect");
      const reader = new GitWorkspaceReader({
        scope: "project",
        root: f.root,
        verify: f.verify,
        git: (args) =>
          f.git(
            args,
            (phase === "capture" && args.includes("config")) ||
              (phase === "private" && args.includes("status"))
              ? { [key]: target }
              : {},
          ),
      });
      if (phase === "offline")
        await withOfflineGitReadScope(() =>
          f.git(["rev-parse", "HEAD"], { [key]: target }),
        );
      else
        expect((await reader.snapshot()).files).toContainEqual(
          expect.objectContaining({ path: "a", worktreeStatus: "M" }),
        );
      expect(
        await fs.stat(target).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    },
  );

  it.each([
    ["eventTarget", false],
    ["normalTarget", false],
    ["perfTarget", false],
    ["eventTarget", true],
    ["normalTarget", true],
    ["perfTarget", true],
  ])(
    "suppresses global trace2.%s targets during snapshot/diff and offline resolution (legacy attributes=%s)",
    async (key, legacyAttributes) => {
      const f = await fixture({
        globalConfig: true,
        legacyAttributes: !!legacyAttributes,
      });
      await f.write("a", "base\n");
      await f.commit();
      await f.write("a", "work\n");
      const target = path.join(f.root, ".git", "configured-trace-side-effect");
      // Setup Git would itself write a trace, so install the fixture config directly.
      await fs.writeFile(
        path.join(f.home, ".gitconfig"),
        `[trace2]\n ${key} = ${target}\n`,
      );
      const snap = await f.reader.snapshot();
      expect(
        (
          await f.reader.diff({
            scope: "project",
            path: "a",
            revision: snap.revision,
          })
        ).unstaged.text,
      ).toContain("+work");
      expect(
        await fs.stat(target).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      await withOfflineGitReadScope(() => f.git(["rev-parse", "HEAD"]));
      expect(
        await fs.stat(target).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
    },
  );

  it.each(["123.key", "-section.key", "1.a-b", "section..key"])(
    "accepts valid native config key %s",
    async (key) => {
      const f = await fixture();
      await f.write("a", "base\n");
      await f.commit();
      await f.write("a", "work\n");
      await f.git(["config", "--", key, "value"]);
      expect(
        await f.git(["--no-optional-locks", "status", "--porcelain"]),
      ).toBe(" M a\n");
      expect((await f.reader.snapshot()).files).toContainEqual(
        expect.objectContaining({ path: "a", worktreeStatus: "M" }),
      );
    },
  );

  it.each(["configured", "xdg-default", "system-git"])(
    "preserves native %s attributes when legacy Git cannot disclose attribute paths",
    async (source) => {
      const hasSystemGit = await fs.access("/usr/bin/git").then(
        () => true,
        () => false,
      );
      const f = await fixture({
        globalConfig: true,
        legacyAttributes: source !== "system-git" || !hasSystemGit,
        gitExecutable:
          source === "system-git" && hasSystemGit ? "/usr/bin/git" : undefined,
      });
      const attrs =
        source === "xdg-default"
          ? path.join(f.home, ".config/git/attributes")
          : path.join(f.home, "attributes");
      await fs.mkdir(path.dirname(attrs), { recursive: true });
      await fs.writeFile(attrs, "*.txt text eol=lf\n");
      if (source !== "xdg-default")
        await f.git(["config", "--global", "core.attributesfile", attrs]);
      await f.write("a.txt", "base\n");
      await f.commit();
      await f.write("a.txt", "work\r\n");
      const index = await fs.readFile(path.join(f.root, ".git/index"));
      const expected = await f.git([
        "--no-pager",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        "a.txt",
      ]);
      expect(expected).not.toContain("\r");
      const snap = await f.reader.snapshot();
      expect(snap.files).toContainEqual(
        expect.objectContaining({ path: "a.txt", worktreeStatus: "M" }),
      );
      expect(
        (
          await f.reader.diff({
            scope: "project",
            path: "a.txt",
            revision: snap.revision,
          })
        ).unstaged.text,
      ).toBe(expected);
      expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
    },
  );

  it.each([
    new Error("request cancelled"),
    new CommandExitError(
      "attribute capability failure",
      128,
      "",
      "arbitrary error",
    ),
    new Error("command timeout"),
    Object.assign(new Error("untyped usage failure"), { exitCode: 129 }),
  ])(
    "does not hide non-capability errors while looking up attributes: %s",
    async (failure) => {
      const f = await fixture();
      let privateCalls = 0;
      const reader = new GitWorkspaceReader({
        scope: "project",
        root: f.root,
        verify: f.verify,
        git: (args) => {
          if (args.includes("var")) throw failure;
          if (args.includes("status")) privateCalls++;
          return f.git(args);
        },
      });
      await expect(reader.snapshot()).rejects.toBe(failure);
      expect(privateCalls).toBe(0);
    },
  );

  it("uses literal paths, including pathspec-looking and newline filenames", async () => {
    const f = await fixture();
    for (const name of [":(glob)*", "line\nbreak", "-option"])
      await f.write(name, "before\n");
    await f.commit();
    for (const name of [":(glob)*", "line\nbreak", "-option"])
      await f.write(name, `after ${name}\n`);
    const snap = await f.reader.snapshot();
    const diff = await f.reader.diff({
      scope: "project",
      path: ":(glob)*",
      revision: snap.revision,
    });
    expect(diff.unstaged.text).toContain("+after :(glob)*");
    expect(diff.unstaged.text).not.toContain("+after -option");
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "line\nbreak",
          revision: snap.revision,
        })
      ).unstaged.kind,
    ).toBe("patch");
  });

  it("handles unborn staged additions, staged deletion and rename diffs", async () => {
    const f = await fixture();
    await f.write("old", "base\n");
    await f.git(["add", "old"]);
    let snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "old",
          revision: snap.revision,
        })
      ).staged.text,
    ).toContain("+base");
    await f.git(["commit", "-m", "fixture"]);
    await f.git(["mv", "old", "new"]);
    snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "new",
          revision: snap.revision,
        })
      ).staged.text,
    ).toContain("rename from old");
    await f.git(["commit", "-m", "rename"]);
    await f.git(["rm", "new"]);
    snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "new",
          revision: snap.revision,
        })
      ).staged.text,
    ).toContain("-base");
  });

  it.each([
    ["rebase-merge", "rebase"],
    ["rebase-apply", "unknown"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["sequencer", "unknown"],
  ])("recognizes operation marker %s", async (marker, operation) => {
    const f = await fixture();
    if (["rebase-merge", "rebase-apply", "sequencer"].includes(marker))
      await fs.mkdir(path.join(f.root, ".git", marker));
    else await fs.writeFile(path.join(f.root, ".git", marker), "a".repeat(40));
    expect((await f.reader.snapshot()).operation).toBe(operation);
  });

  it("detects upstream divergence using only local references", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await f.git([
      "config",
      "remote.origin.url",
      "https://never-contact.example.invalid/repository",
    ]);
    await f.git([
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
    await f.git(["config", "branch.main.remote", "origin"]);
    await f.git(["config", "branch.main.merge", "refs/heads/main"]);
    await f.write("a", "ahead\n");
    await f.commit();
    expect(await f.reader.snapshot()).toMatchObject({
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
    });
    expect(
      f.calls.every(
        (args) => !args.some((arg) => ["fetch", "pull", "push"].includes(arg)),
      ),
    ).toBe(true);
  });

  it("shows a staged submodule pointer without reading its directory", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    const head = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},nested`,
    ]);
    const snap = await f.reader.snapshot();
    expect(snap.files).toContainEqual(
      expect.objectContaining({ path: "nested", submodule: true }),
    );
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "nested",
          revision: snap.revision,
        })
      ).staged.kind,
    ).toBe("unavailable");
  });

  it("rejects symlink parents and traversal payloads before reading content", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, "nested"));
    await f.write("nested/a", "base\n");
    await f.commit();
    await fs.mkdir(path.join(f.dir, "outside"));
    await fs.writeFile(path.join(f.dir, "outside/a"), "SECRET OUTSIDE");
    await fs.rm(path.join(f.root, "nested"), { recursive: true });
    await fs.symlink(path.join(f.dir, "outside"), path.join(f.root, "nested"));
    await expect(f.reader.snapshot()).rejects.toThrow(/путь|ссылк/i);
    await expect(
      f.reader.diff({
        scope: "project",
        path: "../outside/a",
        revision: "a".repeat(64),
      }),
    ).rejects.toThrow();
  });

  it("rejects linked worktrees and changed owner after a read without primary fallback", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await fs.rename(path.join(f.root, ".git"), path.join(f.dir, "metadata"));
    await f.write(".git", `gitdir: ${path.join(f.dir, "metadata")}\n`);
    await expect(f.reader.snapshot()).rejects.toThrow(/worktree/);
    await fs.unlink(path.join(f.root, ".git"));
    await fs.rename(path.join(f.dir, "metadata"), path.join(f.root, ".git"));
    f.verify
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new Error("Owner changed");
      });
    await expect(f.reader.snapshot()).rejects.toThrow("Owner changed");
  });

  it("rejects a diff when file contents change while Git reads it", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "work\n");
    const reader = new GitWorkspaceReader({
      scope: "project",
      root: f.root,
      verify: f.verify,
      git: async (args) => {
        const result = await f.git(args);
        if (args.includes("diff") && !args.includes("--raw"))
          await f.write("a", "changed during read\n");
        return result;
      },
    });
    const snap = await reader.snapshot();
    await expect(
      reader.diff({ scope: "project", path: "a", revision: snap.revision }),
    ).rejects.toThrow(/устарел/i);
  });

  it("marks tracked binary and oversized patches explicitly", async () => {
    const f = await fixture();
    await f.write("binary", Buffer.from([0, 1, 2]));
    await f.write("large", "base\n");
    await f.commit();
    await f.write("binary", Buffer.from([0, 3, 2]));
    await f.write("large", "x".repeat(1024 * 1024 + 1));
    const snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "binary",
          revision: snap.revision,
        })
      ).unstaged.kind,
    ).toBe("binary");
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "large",
          revision: snap.revision,
        })
      ).unstaged.kind,
    ).toBe("unavailable");
  });

  it("caps the combined staged and unstaged renderer response at 1 MiB", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "s".repeat(400000) + "\n");
    await f.git(["add", "a"]);
    await f.write("a", "w".repeat(400000) + "\n");
    const snap = await f.reader.snapshot();
    const diff = await f.reader.diff({
      scope: "project",
      path: "a",
      revision: snap.revision,
    });
    expect(
      Buffer.byteLength(diff.staged.text) +
        Buffer.byteLength(diff.unstaged.text),
    ).toBeLessThanOrEqual(1024 * 1024);
    expect([diff.staged.kind, diff.unstaged.kind]).toContain("unavailable");
  });

  it("makes an oversized Runner diff explicitly unavailable rather than returning a partial patch", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "work\n");
    const reader = new GitWorkspaceReader({
      scope: "project",
      root: f.root,
      verify: f.verify,
      git: async (args) => {
        if (args.includes("diff") && !args.includes("--raw"))
          throw new Error("Ответ команды слишком большой");
        return f.git(args);
      },
    });
    const snap = await reader.snapshot();
    expect(
      (
        await reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged.kind,
    ).toBe("unavailable");
  });

  it.each(["refs/heads/main", "objects/aa", "rebase-merge/head-name"])(
    "rejects symlinked Git metadata %s before invoking Git",
    async (relative) => {
      const f = await fixture();
      await f.write("a", "base\n");
      await f.commit();
      const target = path.join(f.dir, "outside");
      await fs.writeFile(target, "SECRET OUTSIDE");
      const filename = path.join(f.root, ".git", relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.rm(filename, { force: true, recursive: true });
      await fs.symlink(target, filename);
      await expect(f.reader.snapshot()).rejects.toThrow(/ссылк/i);
      expect(f.calls).toHaveLength(0);
    },
  );

  it("rejects non-UTF8 filenames instead of substituting a different path", async () => {
    const f = await fixture();
    // macOS rejects invalid filename bytes itself; emulate their lossy UTF-8
    // transport from a filesystem that supports them instead of changing HOME.
    const reader = new GitWorkspaceReader({
      scope: "project",
      root: f.root,
      verify: f.verify,
      git: (args) =>
        args.includes("status")
          ? Promise.resolve("? invalid\ufffd\0")
          : f.git(args),
    });
    await expect(reader.snapshot()).rejects.toThrow(/путь/i);
  });

  it("reports non-UTF8 tracked content as binary instead of a replacement-character patch", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", Buffer.from([255, 254, 10]));
    const snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged.kind,
    ).toBe("binary");
  });

  it("keeps a removed tracked symlink unavailable rather than presenting its target as file text", async () => {
    const f = await fixture();
    await fs.symlink("outside-target", path.join(f.root, "link"));
    await f.commit();
    await f.git(["rm", "link"]);
    const snap = await f.reader.snapshot();
    const diff = await f.reader.diff({
      scope: "project",
      path: "link",
      revision: snap.revision,
    });
    expect(diff.staged.kind).toBe("unavailable");
    expect(diff.unstaged.kind).toBe("unavailable");
  });

  it("fingerprints active operation files, not only their parent directory", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await fs.mkdir(path.join(f.root, ".git/rebase-merge"));
    await fs.writeFile(
      path.join(f.root, ".git/rebase-merge/done"),
      "pick 1111\n",
    );
    const before = await f.reader.snapshot();
    await fs.writeFile(
      path.join(f.root, ".git/rebase-merge/done"),
      "pick 2222\n",
    );
    expect((await f.reader.snapshot()).revision).not.toBe(before.revision);
  });

  it("does not return a snapshot if ownership verification changes the root after capture", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    f.verify
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        await fs.rename(f.root, path.join(f.dir, "previous-repo"));
        await fs.mkdir(f.root);
        await fs.mkdir(path.join(f.root, ".git"));
      });
    await expect(f.reader.snapshot()).rejects.toThrow(/устарел|Git/i);
  });

  it("preserves untracked UTF-8 BOM, CRLF and missing final newline", async () => {
    const f = await fixture();
    const content = "\ufefffirst\r\nlast";
    await f.write("a", content);
    const snap = await f.reader.snapshot();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged,
    ).toEqual({ kind: "text", text: content });
  });

  it("does not swallow cancellation or other Git errors as an unavailable diff", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "work\n");
    const reader = new GitWorkspaceReader({
      scope: "project",
      root: f.root,
      verify: f.verify,
      git: async (args) => {
        if (args.includes("diff") && !args.includes("--raw"))
          throw new Error("request cancelled");
        return f.git(args);
      },
    });
    const snap = await reader.snapshot();
    await expect(
      reader.diff({ scope: "project", path: "a", revision: snap.revision }),
    ).rejects.toThrow("request cancelled");
  });

  it("audits 10000 synthetic loose objects without an object-content inventory or Git subprocess per object", async () => {
    const f = await fixture();
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "work\n");
    for (let i = 0; i < 256; i++)
      await fs.mkdir(
        path.join(f.root, ".git/objects", i.toString(16).padStart(2, "0")),
        { recursive: true },
      );
    for (let base = 0; base < 10000; base += 250)
      await Promise.all(
        Array.from({ length: 250 }, async (_, index) => {
          const content = `synthetic object ${base + index}`;
          const blob = Buffer.from(
              `blob ${Buffer.byteLength(content)}\0${content}`,
            ),
            oid = createHash("sha1").update(blob).digest("hex");
          await fs.writeFile(
            path.join(f.root, ".git/objects", oid.slice(0, 2), oid.slice(2)),
            deflateSync(blob),
          );
        }),
      );
    f.calls.length = 0;
    const start = performance.now();
    const snap = await f.reader.snapshot();
    const snapshotMs = Math.round(performance.now() - start),
      snapshotCommands = f.calls.length;
    f.calls.length = 0;
    const diffStart = performance.now();
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "a",
          revision: snap.revision,
        })
      ).unstaged.kind,
    ).toBe("patch");
    console.info(
      "Git reader TEMP benchmark:",
      JSON.stringify({
        looseObjects: 10000,
        snapshotMs,
        snapshotCommands,
        diffMs: Math.round(performance.now() - diffStart),
        diffCommands: f.calls.length,
      }),
    );
    // Four native reads plus immutable policy capture/revalidation; no per-object commands.
    expect(snapshotCommands).toBeLessThanOrEqual(8);
    expect(f.calls.length).toBeLessThanOrEqual(14);
  });

  it("rejects metadata directories where Git expects regular files", async () => {
    const f = await fixture();
    await fs.unlink(path.join(f.root, ".git/HEAD"));
    await fs.mkdir(path.join(f.root, ".git/HEAD"));
    await expect(f.reader.snapshot()).rejects.toThrow(/метаданн/i);
    expect(f.calls).toHaveLength(0);
  });

  it.each(["config.worktree", "shallow", "info/exclude", "info/grafts"])(
    "rejects additional linked Git metadata %s",
    async (relative) => {
      const f = await fixture();
      const target = path.join(f.dir, "outside");
      await fs.writeFile(target, "SECRET OUTSIDE");
      const filename = path.join(f.root, ".git", relative);
      await fs.rm(filename, { force: true });
      await fs.symlink(target, filename);
      await expect(f.reader.snapshot()).rejects.toThrow(/ссылк/i);
      expect(f.calls).toHaveLength(0);
    },
  );

  it("verifies the host owner only at the two public request boundaries", async () => {
    const f = await fixture();
    await f.write("a", "work\n");
    const snap = await f.reader.snapshot();
    expect(f.verify).toHaveBeenCalledTimes(2);
    f.verify.mockClear();
    await f.reader.diff({
      scope: "project",
      path: "a",
      revision: snap.revision,
    });
    expect(f.verify).toHaveBeenCalledTimes(2);
  });

  it("keeps an untracked nested repository as one unavailable directory without hiding unrelated changes or running nested helpers", async () => {
    const f = await fixture();
    await f.write("ordinary", "base\n");
    await f.commit();
    await f.write("ordinary", "working\n");
    const nested = "nested repo\nЮникод";
    await fs.mkdir(path.join(f.root, nested));
    await f.git(["-C", nested, "init", "-b", "main"]);
    await f.write(`${nested}/private-file`, "nested private content\n");
    await f.git(["-C", nested, "add", "."]);
    await f.git(["-C", nested, "commit", "-m", "nested fixture"]);
    const sentinel = path.join(f.dir, "nested-helper-ran");
    const command = `touch '${sentinel}'`;
    for (const key of [
      "core.fsmonitor",
      "filter.hostile.clean",
      "filter.hostile.process",
      "diff.hostile.textconv",
      "diff.external",
    ])
      await f.git(["-C", nested, "config", key, command]);
    await f.git(["-C", nested, "config", "filter.hostile.required", "true"]);
    await f.write(
      `${nested}/.gitattributes`,
      "private-file filter=hostile diff=hostile\n",
    );
    await f.write(
      `${nested}/private-file`,
      "modified nested private content\n",
    );
    // A root-only reader must never walk nested worktree content or metadata.
    await fs.symlink(
      path.join(f.dir, "outside"),
      path.join(f.root, nested, "outside-link"),
    );
    const snap = await f.reader.snapshot();
    expect(snap.files).toHaveLength(2);
    expect(snap.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "ordinary",
          kind: "tracked",
          worktreeStatus: "M",
        }),
        {
          path: nested,
          kind: "untracked",
          indexStatus: "?",
          worktreeStatus: "?",
          submodule: false,
        },
      ]),
    );
    const nestedDiff = await f.reader.diff({
      scope: "project",
      path: nested,
      revision: snap.revision,
    });
    expect(nestedDiff.staged.kind).toBe("unavailable");
    expect(nestedDiff.unstaged.kind).toBe("unavailable");
    expect(JSON.stringify(nestedDiff)).not.toContain("private content");
    expect(
      (
        await f.reader.diff({
          scope: "project",
          path: "ordinary",
          revision: snap.revision,
        })
      ).unstaged.text,
    ).toContain("+working");
    expect(f.calls.every((args) => !args.includes("-C"))).toBe(true);
    await expect(fs.access(sentinel)).rejects.toThrow();
    await expect(
      f.reader.diff({
        scope: "project",
        path: `${nested}/`,
        revision: snap.revision,
      }),
    ).rejects.toThrow();
  });

  it.each(["snapshot", "diff"] as const)(
    "rejects a regular split index before the %s request can change metadata",
    async (operation) => {
      const f = await fixture();
      await f.write("a", "base\n");
      await f.commit();
      await f.write("a", "staged\n");
      await f.git(["add", "a"]);
      await f.git(["update-index", "--split-index"]);
      await f.write("a", "working\n");
      const gitdir = path.join(f.root, ".git"),
        entries = await fs.readdir(gitdir);
      const shared = entries.filter((name) => name.startsWith("sharedindex."));
      expect(shared.length).toBeGreaterThan(0);
      for (const name of shared)
        await fs.utimes(path.join(gitdir, name), new Date(0), new Date(0));
      const files = ["index", ...shared].map((name) => path.join(gitdir, name));
      const bytes = await Promise.all(files.map((name) => fs.readFile(name)));
      const monitored = [gitdir, ...files],
        before = await Promise.all(
          monitored.map((name) => fs.lstat(name, { bigint: true })),
        );
      const request =
        operation === "snapshot"
          ? f.reader.snapshot()
          : f.reader.diff({
              scope: "project",
              path: "a",
              revision: "a".repeat(64),
            });
      await expect(request).rejects.toThrow(/split.index|sharedindex/i);
      expect(f.calls).toHaveLength(0);
      expect(await fs.readdir(gitdir)).toEqual(entries);
      expect(await Promise.all(files.map((name) => fs.readFile(name)))).toEqual(
        bytes,
      );
      for (let index = 0; index < monitored.length; index++) {
        const after = await fs.lstat(monitored[index], { bigint: true });
        expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
          before[index].ino,
          before[index].size,
          before[index].mtimeNs,
          before[index].ctimeNs,
        ]);
      }
    },
  );

  it.each(["snapshot", "diff"] as const)(
    "rejects a shared-index symlink before the %s request invokes Git or freshens external metadata",
    async (operation) => {
      const f = await fixture();
      await f.write("a", "base\n");
      await f.commit();
      await f.write("a", "working\n");
      const snap = await f.reader.snapshot();
      await f.git(["update-index", "--split-index"]);
      const gitdir = path.join(f.root, ".git"),
        entries = await fs.readdir(gitdir);
      const shared = entries.find((name) => name.startsWith("sharedindex."));
      expect(shared).toBeDefined();
      const filename = path.join(gitdir, shared!),
        outside = path.join(f.dir, "external-shared-index");
      await fs.rename(filename, outside);
      await fs.utimes(outside, new Date(0), new Date(0));
      await fs.symlink(outside, filename);
      f.calls.length = 0;
      const monitored = [gitdir, path.join(gitdir, "index"), filename, outside],
        before = await Promise.all(
          monitored.map((name) => fs.lstat(name, { bigint: true })),
        );
      const externalBytes = await fs.readFile(outside);
      const request =
        operation === "snapshot"
          ? f.reader.snapshot()
          : f.reader.diff({
              scope: "project",
              path: "a",
              revision: snap.revision,
            });
      await expect(request).rejects.toThrow(/split.index|sharedindex/i);
      expect(f.calls).toHaveLength(0);
      expect(await fs.readdir(gitdir)).toEqual(entries);
      expect(await fs.readFile(outside)).toEqual(externalBytes);
      for (let index = 0; index < monitored.length; index++) {
        const after = await fs.lstat(monitored[index], { bigint: true });
        expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
          before[index].ino,
          before[index].size,
          before[index].mtimeNs,
          before[index].ctimeNs,
        ]);
      }
    },
  );

  it.each([
    ["SHAREDINDEX.", "snapshot"],
    ["SHAREDINDEX.", "diff"],
    ["ShArEdInDeX.", "snapshot"],
    ["ShArEdInDeX.", "diff"],
  ] as const)(
    "rejects %s casing before a %s request invokes Git on any filesystem",
    async (prefix, operation) => {
      const f = await fixture();
      await f.write("a", "base\n");
      await f.commit();
      await f.write("a", "working\n");
      const snap = await f.reader.snapshot();
      await f.git(["update-index", "--split-index"]);
      const gitdir = path.join(f.root, ".git"),
        shared = (await fs.readdir(gitdir)).find((name) =>
          name.startsWith("sharedindex."),
        );
      expect(shared).toBeDefined();
      const renamed = path.join(
        gitdir,
        prefix + shared!.slice("sharedindex.".length),
      );
      await fs.rename(path.join(gitdir, shared!), renamed);
      await fs.utimes(renamed, new Date(0), new Date(0));
      const entries = await fs.readdir(gitdir),
        bytes = await fs.readFile(renamed),
        monitored = [gitdir, path.join(gitdir, "index"), renamed];
      const before = await Promise.all(
        monitored.map((name) => fs.lstat(name, { bigint: true })),
      );
      f.calls.length = 0;
      const request =
        operation === "snapshot"
          ? f.reader.snapshot()
          : f.reader.diff({
              scope: "project",
              path: "a",
              revision: snap.revision,
            });
      await expect(request).rejects.toThrow(/split.index|sharedindex/i);
      expect(f.calls).toHaveLength(0);
      expect(await fs.readdir(gitdir)).toEqual(entries);
      expect(await fs.readFile(renamed)).toEqual(bytes);
      for (let index = 0; index < monitored.length; index++) {
        const after = await fs.lstat(monitored[index], { bigint: true });
        expect([after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
          before[index].ino,
          before[index].size,
          before[index].mtimeNs,
          before[index].ctimeNs,
        ]);
      }
    },
  );
});

it("display summary counts each changed path once without full snapshot fingerprints", async () => {
  const f = await fixture();
  await f.write("tracked.txt", "base\n");
  await f.commit();
  await f.write("tracked.txt", "staged\n");
  await f.git(["add", "tracked.txt"]);
  await f.write("tracked.txt", "working\n");
  await f.write("untracked.txt", "new\n");
  f.calls.length = 0;
  const summary = await (f.reader as any).summary();
  expect(summary).toEqual({
    scope: "project",
    branch: "main",
    changedFiles: 2,
    conflicts: 0,
  });
  expect(f.calls.filter((a) => a.includes("status"))).toHaveLength(1);
  expect(f.calls.filter((a) => a.includes("diff"))).toHaveLength(1);
  expect(summary).not.toHaveProperty("revision");
  expect(summary).not.toHaveProperty("files");
});
it("display summary reports actual conflicts and never treats owner failure as clean", async () => {
  const f = await fixture();
  await f.write("file.txt", "base\n");
  await f.commit();
  await f.git(["checkout", "-b", "side"]);
  await f.write("file.txt", "side\n");
  await f.commit();
  await f.git(["checkout", "main"]);
  await f.write("file.txt", "main\n");
  await f.commit();
  await f.git(["merge", "side"]).catch(() => {});
  expect(await (f.reader as any).summary()).toEqual({
    scope: "project",
    branch: "main",
    changedFiles: 1,
    conflicts: 1,
  });
  f.verify.mockRejectedValueOnce(Error("owner changed"));
  await expect((f.reader as any).summary()).rejects.toThrow("owner changed");
});
it("display summary keeps private reads and index bytes intact", async () => {
  const f = await fixture();
  await f.write("file.txt", "base\n");
  await f.commit();
  await f.write("file.txt", "changed\n");
  const index = await fs.readFile(path.join(f.root, ".git/index"));
  const summary = await withOfflineGitReadScope(() =>
    (f.reader as any).summary(),
  );
  expect(summary.changedFiles).toBe(1);
  expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(index);
  expect(f.calls.some((a) => a.includes("--no-optional-locks"))).toBe(true);
});
