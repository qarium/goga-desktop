import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as nativeFs from "node:fs";
vi.mock("node:fs", { spy: true });
import {
  writeFileSync,
  unlinkSync,
  renameSync,
  symlinkSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { NodeRunner } from "../src/host/process";
import { GitWorkspaceReader } from "../src/host/git-workspace-reader";
import { GitConflictReader } from "../src/host/git-conflicts";
import type { GitCommitContext } from "../src/host/git-workspace-actions";
import { withTrustedGitIndex } from "../src/host/git-index-scope";
import type { GitConflictResolution } from "../src/shared/git-conflict-save";
import { NativeGitConflictActions } from "../src/host/git-native-conflict-save";
import {
  createNativeGitCapability,
  nativeIntent,
} from "../src/host/git-native-context";
import { NativeGitJournal } from "../src/host/git-native-journal";
const api = { GitConflictActions: NativeGitConflictActions };
vi.setConfig({ testTimeout: 30000 });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function fixture(
  name = "a",
  sides: [string | null, string | null, string | null] = [
    "base\n",
    "current\n",
    "incoming\n",
  ],
  format: "sha1" | "sha256" = "sha1",
) {
  expect(api?.GitConflictActions).toBeDefined();
  const dir = await fs.mkdtemp("/private/tmp/goga-conflict-save-");
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
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
  cleanups.push(() => runner.dispose());
  const git = (args: string[], stdin?: string) =>
    runner.command("git", args, root, env, stdin);
  const write = (n: string, text: string) =>
    fs.writeFile(path.join(root, n), text);
  await git(["init", "-b", "main", `--object-format=${format}`]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await write(name, "base\n");
  await write("other", "base\n");
  await write("flags", "base\n");
  await git(["add", "."]);
  await git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
  await write("other", "other staged\n");
  await git(["add", "other"]);
  await write("other", "other working\n");
  await git(["update-index", "--assume-unchanged", "flags"]);
  const oid = async (text: string) =>
    (await git(["hash-object", "-w", "--stdin"], text)).stdout.trim();
  let records = `0 ${"0".repeat(format === "sha256" ? 64 : 40)}\t${name}\0`;
  for (let i = 0; i < 3; i++)
    if (sides[i] !== null)
      records += `100644 ${await oid(sides[i]!)} ${i + 1}\t${name}\0`;
  records += `100644 ${await oid("base\n")} 1\tconflict-other\0`;
  records += `100644 ${await oid("other conflict\n")} 2\tconflict-other\0`;
  await git(["update-index", "-z", "--index-info"], records);
  await write(name, "manual working\n");
  await write("conflict-other", "unrelated conflict\n");
  await write(".git/MERGE_HEAD", (await git(["rev-parse", "HEAD"])).stdout);
  let now = 1000,
    owner = "owner";
  const verify = vi.fn(async () => {}),
    calls: string[][] = [];
  const reader = new GitWorkspaceReader({
    scope: "project",
    root,
    verify,
    git: async (args) => (await git(args)).stdout,
  });
  const context: GitCommitContext & { isolatedGit: typeof git } = {
    native: createNativeGitCapability({
      root,
      env,
      runner,
      journal: new NativeGitJournal({ directory: path.join(home, "journal") }),
      owner: async () => ({
        scope: "project",
        projectPath: root,
        registryRevision: nativeIntent(owner),
      }),
    }),
    isolatedGit: git,
    scope: "project",
    root,
    ownerKey: owner,
    verify,
    snapshot: () => reader.snapshot(),
    git: async (args, options) => {
      calls.push(args);
      return options?.indexFile
        ? withTrustedGitIndex(options.indexFile, () => git(args, options.stdin))
        : git(args, options?.stdin);
    },
  };
  const seams: Record<string, unknown> = {};
  const bound = async <T>(
    _scope: unknown,
    fn: (c: GitCommitContext & { isolatedGit: typeof git }) => Promise<T>,
  ) => {
    const result = await fn({ ...context, ownerKey: owner });
    (seams.outerContext as (() => void) | undefined)?.();
    return (
      (seams.contextResult as ((value: T) => T) | undefined)?.(result) ?? result
    );
  };
  const conflicts = new GitConflictReader({ context: bound });
  const actions = new api.GitConflictActions({
    context: bound,
    now: () => now,
    beforePublishWork: () => {
      (seams.beforePublishWork as (() => undefined) | undefined)?.();
    },
    afterPublishWork: () => {
      (seams.afterPublishWork as (() => undefined) | undefined)?.();
    },
    beforePublishIndex: () => {
      (seams.beforePublishIndex as (() => undefined) | undefined)?.();
    },
    afterPublishIndex: () => {
      (seams.afterPublishIndex as (() => undefined) | undefined)?.();
    },
  });
  const request = async (
    resolution: GitConflictResolution = { kind: "text", text: "resolved\n" },
  ) => {
    const doc = await conflicts.read({
      scope: "project",
      path: name,
      revision: (await reader.snapshot()).revision,
    });
    return {
      scope: "project",
      path: name,
      revision: doc.revision,
      fingerprint: doc.fingerprint,
      resolution,
    };
  };
  const prepare = async (resolution?: GitConflictResolution) =>
    actions.prepare(await request(resolution));
  const index = () => fs.readFile(path.join(root, ".git/index"));
  return {
    runner,
    dir,
    root,
    home,
    name,
    git,
    write,
    oid,
    reader,
    context,
    verify,
    calls,
    seams,
    actions,
    request,
    prepare,
    index,
    setOwner: (value: string) => {
      owner = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

it.each(["text", "current", "incoming", "delete"] as const)(
  "native resolution %s preserves unrelated data",
  async (kind) => {
    const f = await fixture();
    const other = (
      await f.git([
        "ls-files",
        "--stage",
        "--debug",
        "--",
        "other",
        "flags",
        "conflict-other",
      ])
    ).stdout;
    const head = (await f.git(["rev-parse", "HEAD"])).stdout;
    const p = await f.prepare(
      kind === "text" ? { kind, text: "resolved\n" } : { kind },
    );
    const r = await f.actions.execute(p.token);
    expect(r, r.log).toMatchObject({
      status: "saved",
      indexPublished: true,
      worktreePublished: true,
      lockRetained: false,
    });
    expect(
      (
        await f.git([
          "ls-files",
          "--stage",
          "--debug",
          "--",
          "other",
          "flags",
          "conflict-other",
        ])
      ).stdout,
    ).toBe(other);
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other working\n",
    );
    if (kind === "delete")
      await expect(fs.stat(path.join(f.root, "a"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    else
      expect((await f.git(["show", ":a"])).stdout).toBe(
        kind === "text" ? "resolved\n" : kind + "\n",
      );
    await expect(f.actions.execute(p.token)).rejects.toThrow();
    expect(
      (await fs.readdir(path.join(f.root, ".git"))).filter((n) =>
        n.startsWith("goga-native-resolution-"),
      ),
    ).toEqual([]);
  },
);

// Shared admission regressions retain their original assertions; native writer
// internals (portable recovery/fence instead of binary index locks) are below.
describe("native shared admission regressions", () => {
  it("previews without changes, publishes only selected text and preserves staged entries, flags and conflicts", async () => {
    const f = await fixture(),
      before = await f.index();
    const other = (
      await f.git([
        "ls-files",
        "--stage",
        "--debug",
        "--",
        "other",
        "flags",
        "conflict-other",
      ])
    ).stdout;
    const head = (await f.git(["rev-parse", "HEAD"])).stdout;
    const p = await f.prepare({
      kind: "text",
      text: "\ufeff<<<<<<< literal\r\nwithout newline",
    });
    expect(await f.index()).toEqual(before);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "manual working\n",
    );
    expect(p).toMatchObject({
      path: "a",
      hooks: "disabled",
      canonicalization: "git-text-attributes",
    });
    const r = await f.actions.execute(p.token);
    expect(r).toMatchObject({
      status: "saved",
      worktreePublished: true,
      indexPublished: true,
      lockRetained: false,
    });
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "\ufeff<<<<<<< literal\r\nwithout newline",
    );
    expect((await f.git(["show", ":a"])).stdout).toBe(
      "\ufeff<<<<<<< literal\r\nwithout newline",
    );
    expect(
      (
        await f.git([
          "ls-files",
          "--stage",
          "--debug",
          "--",
          "other",
          "flags",
          "conflict-other",
        ])
      ).stdout,
    ).toBe(other);
    expect((await f.git(["rev-parse", "HEAD"])).stdout).toBe(head);
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other working\n",
    );
    await expect(f.actions.execute(p.token)).rejects.toThrow(
      /использован|истек/,
    );
  });
  it.each(["current", "incoming"] as const)(
    "uses exact %s side including modify-delete",
    async (kind) => {
      const f = await fixture("a", [
        "base\n",
        kind === "current" ? "\ufeffcurrent\r\nlast" : null,
        kind === "incoming" ? "incoming\r\nlast" : null,
      ]);
      const p = await f.prepare({ kind });
      const result = await f.actions.execute(p.token);
      expect(result.status, result.log).toBe("saved");
      expect((await f.git(["show", ":a"])).stdout).toBe(
        kind === "current" ? "\ufeffcurrent\r\nlast" : "incoming\r\nlast",
      );
    },
  );
  it("explicitly deletes only the literal selected conflict and never guesses rename siblings", async () => {
    const f = await fixture("renamed", ["base", null, "incoming"]),
      p = await f.prepare({ kind: "delete" });
    const result = await f.actions.execute(p.token);
    expect(result.status, result.log).toBe("saved");
    await expect(fs.lstat(path.join(f.root, "renamed"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await f.git(["ls-files", "--stage", "-z", "--", "renamed"])).stdout,
    ).toBe("");
    expect((await f.git(["ls-files", "--unmerged", "-z"])).stdout).toContain(
      "conflict-other",
    );
  });
  it("restores a missing leaf without making parent directories", async () => {
    const f = await fixture("dir/a");
    await fs.unlink(path.join(f.root, f.name));
    expect(
      (await f.actions.execute((await f.prepare({ kind: "incoming" })).token))
        .status,
    ).toBe("saved");
    expect(await fs.readFile(path.join(f.root, f.name), "utf8")).toBe(
      "incoming\n",
    );
  });
  it.each(["work", "index", "head", "owner", "operation", "config"])(
    "refuses stale %s before edits",
    async (cause) => {
      const f = await fixture(),
        p = await f.prepare();
      if (cause === "work") await f.write("a", "external\n");
      if (cause === "index")
        await f.git(["update-index", "--no-assume-unchanged", "flags"]);
      if (cause === "head")
        await f.write(".git/HEAD", "ref: refs/heads/other\n");
      if (cause === "owner") f.setOwner("other");
      if (cause === "operation")
        await f.write(".git/MERGE_HEAD", "f".repeat(40) + "\n");
      if (cause === "config") await f.git(["config", "core.filemode", "false"]);
      const work = await fs.readFile(path.join(f.root, "a")),
        index = await f.index();
      await expect(f.actions.execute(p.token)).rejects.toThrow();
      expect(await fs.readFile(path.join(f.root, "a"))).toEqual(work);
      expect(await f.index()).toEqual(index);
    },
  );
  it("expires tokens and consumes them even on refused execution", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.setNow(p.expiresAt);
    await expect(f.actions.execute(p.token)).rejects.toThrow(/истек/);
    await expect(f.actions.execute(p.token)).rejects.toThrow(
      /истек|использован/,
    );
  });
  it("refuses a foreign lock without changing it", async () => {
    const f = await fixture(),
      p = await f.prepare(),
      before = await f.index();
    await f.write(".git/index.lock", "foreign");
    await expect(f.actions.execute(p.token)).rejects.toThrow();
    expect(
      await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
    ).toBe("foreign");
    expect(await f.index()).toEqual(before);
  });
  it.each(["leaf-symlink", "hardlink", "parent-symlink"])(
    "refuses %s without following it",
    async (kind) => {
      const f = await fixture("dir/a"),
        p = await f.prepare(),
        outside = path.join(f.dir, "outside");
      await fs.writeFile(outside, "outside");
      if (kind === "parent-symlink") {
        await fs.rename(
          path.join(f.root, "dir"),
          path.join(f.root, "saved-dir"),
        );
        await fs.symlink(f.dir, path.join(f.root, "dir"));
      } else {
        await fs.unlink(path.join(f.root, f.name));
        if (kind === "hardlink")
          await fs.link(outside, path.join(f.root, f.name));
        else await fs.symlink(outside, path.join(f.root, f.name));
      }
      await expect(f.actions.execute(p.token)).rejects.toThrow();
      expect(await fs.readFile(outside, "utf8")).toBe("outside");
    },
  );
  it("uses literal odd UTF8 paths, not pathspecs", async () => {
    const f = await fixture(":(glob)звезда*\nfile"),
      p = await f.prepare();
    const result = await f.actions.execute(p.token);
    expect(result.status, result.log).toBe("saved");
    expect(await fs.readFile(path.join(f.root, f.name), "utf8")).toBe(
      "resolved\n",
    );
  });
  it("never runs external filters, textconv or hooks", async () => {
    const f = await fixture();
    await f.write(
      ".git/hooks/post-index-change",
      "#!/bin/sh\ntouch '" + path.join(f.dir, "hook-ran") + "'\n",
    );
    await fs.chmod(path.join(f.root, ".git/hooks/post-index-change"), 0o755);
    await f.git([
      "config",
      "filter.evil.clean",
      "touch '" + path.join(f.dir, "filter-ran") + "'",
    ]);
    await f.git([
      "config",
      "diff.evil.textconv",
      "touch '" + path.join(f.dir, "textconv-ran") + "'",
    ]);
    await f.write(".gitattributes", "a filter=evil diff=evil\n");
    await expect(f.prepare()).rejects.toThrow(/фильтр|filter/);
    await f.write(".gitattributes", "a diff=evil\n");
    expect((await f.actions.execute((await f.prepare()).token)).status).toBe(
      "saved",
    );
    for (const n of ["hook-ran", "filter-ran", "textconv-ran"])
      await expect(fs.lstat(path.join(f.dir, n))).rejects.toMatchObject({
        code: "ENOENT",
      });
  });
  it.each(["attr", "autocrlf"])(
    "preserves CRLF working bytes while applying native %s canonicalization",
    async (mode) => {
      const f = await fixture();
      if (mode === "attr") await f.write(".gitattributes", "a text eol=lf\n");
      else await f.git(["config", "core.autocrlf", "true"]);
      const p = await f.prepare({ kind: "text", text: "\ufefffirst\r\nlast" });
      const result = await f.actions.execute(p.token);
      expect(result.status, result.log).toBe("saved");
      expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
        "\ufefffirst\r\nlast",
      );
      expect((await f.git(["show", ":a"])).stdout).toBe("\ufefffirst\nlast");
    },
  );
  it("bounds tickets and protects authority from preview mutation", async () => {
    const f = await fixture(),
      req = await f.request();
    const first = await f.actions.prepare(req);
    for (let i = 0; i < 32; i++) await f.actions.prepare(req);
    await expect(f.actions.execute(first.token)).rejects.toThrow(
      /использован|истек/,
    );
    const p = await f.actions.prepare(req);
    p.path = "other";
    p.scope = "forged";
    expect((await f.actions.execute(p.token)).status).toBe("saved");
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other working\n",
    );
  }, 60000);
  it("refuses missing parents and unsupported source bytes without changing index", async () => {
    const f = await fixture("dir/a"),
      before = await f.index();
    await fs.rm(path.join(f.root, "dir"), { recursive: true });
    await expect(f.prepare()).rejects.toThrow();
    expect(await f.index()).toEqual(before);
    const binary = await fixture("a", ["base", "a\0b", "incoming"]);
    await expect(binary.prepare({ kind: "current" })).rejects.toThrow(/binary/);
    const absent = await fixture("a", ["base", null, "incoming"]);
    await expect(absent.prepare({ kind: "current" })).rejects.toThrow(
      /отсутствует/,
    );
  });
  it("rejects changed effective attributes between preview and execution", async () => {
    const f = await fixture(),
      p = await f.prepare();
    await f.write(".gitattributes", "a text eol=lf\n");
    await expect(f.actions.execute(p.token)).rejects.toThrow();
  });
  it("preserves private POSIX permissions when saving manual text", async () => {
    const f = await fixture();
    await fs.chmod(path.join(f.root, "a"), 0o600);
    const r = await f.actions.execute((await f.prepare()).token);
    expect(r.status).toBe("saved");
    expect((await fs.stat(path.join(f.root, "a"))).mode & 0o777).toBe(0o600);
  });
  it("supports SHA256 object format with isolated canonicalization", async () => {
    const f = await fixture("a", ["base", "current", "incoming"], "sha256"),
      p = await f.prepare();
    expect((await f.actions.execute(p.token)).status).toBe("saved");
    expect((await f.git(["ls-files", "--stage", "--", "a"])).stdout).toMatch(
      /^100644 [a-f0-9]{64} 0/,
    );
  });
  it("changes only executable bits for an explicit executable side", async () => {
    const f = await fixture();
    await fs.chmod(path.join(f.root, "a"), 0o600);
    await f.git(
      ["update-index", "-z", "--index-info"],
      `100755 ${await f.oid("current\n")} 2\ta\0`,
    );
    expect(
      (await f.actions.execute((await f.prepare({ kind: "current" })).token))
        .status,
    ).toBe("saved");
    expect((await fs.stat(path.join(f.root, "a"))).mode & 0o777).toBe(0o700);
    expect((await f.git(["ls-files", "--stage", "--", "a"])).stdout).toMatch(
      /^100755 /,
    );
  });
  it("binds the read document fingerprint to captured bytes even under an unchanged revision", async () => {
    const f = await fixture(),
      req = await f.request();
    let armed = true;
    const native = f.context.git;
    f.context.git = async (args, options) => {
      if (armed && args.includes("config") && args.includes("--list")) {
        armed = false;
        await f.write("a", "new external bytes\n");
      }
      return native(args, options);
    };
    await expect(f.actions.prepare(req)).rejects.toThrow(/устарел/);
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "new external bytes\n",
    );
  });
  it("evicts by total payload budget, not only number of tickets", async () => {
    const f = await fixture(),
      req = await f.request({ kind: "text", text: "a".repeat(1024 * 1024) });
    const p = await f.actions.prepare(req);
    await f.actions.prepare(req);
    await f.actions.prepare(req);
    await expect(f.actions.execute(p.token)).rejects.toThrow(
      /использован|истек/,
    );
  });
  it("restores an executable absent file with private executable permissions", async () => {
    const f = await fixture();
    await f.git(
      ["update-index", "-z", "--index-info"],
      `100755 ${await f.oid("current\n")} 2\ta\0`,
    );
    await fs.unlink(path.join(f.root, "a"));
    expect((await f.actions.execute((await f.prepare()).token)).status).toBe(
      "saved",
    );
    expect((await fs.stat(path.join(f.root, "a"))).mode & 0o777).toBe(0o700);
  });
  it.each(["prepare", "execute"] as const)(
    "never runs status or a newly installed filter during %s",
    async (phase) => {
      const f = await fixture(),
        marker = path.join(f.dir, "filter-invoked");
      await f.write(".gitattributes", "other filter=late\n");
      await f.write("other", "other edited\n");
      const req = await f.request(),
        p = phase === "execute" ? await f.actions.prepare(req) : null;
      const native = f.runner.command.bind(f.runner);
      let armed = true;
      const forbidden: string[][] = [];
      const spy = vi
        .spyOn(f.runner, "command")
        .mockImplementation(async (exe, args, cwd, env, stdin) => {
          if (args.includes("status") || args.includes("diff"))
            forbidden.push(args);
          if (armed && args.includes("status")) {
            armed = false;
            await native(
              "git",
              [
                "config",
                "filter.late.clean",
                `printf invoked >> '${marker}'; cat`,
              ],
              cwd,
              env,
            );
          }
          return native(exe, args, cwd, env, stdin);
        });
      try {
        if (p) await f.actions.execute(p.token);
        else await f.actions.prepare(req);
      } finally {
        spy.mockRestore();
      }
      expect(forbidden).toEqual([]);
      expect(await fs.readFile(marker, "utf8").catch(() => null)).toBeNull();
    },
  );
  it("does not depend on the filter-capable snapshot callback for prepare or execute", async () => {
    const f = await fixture(),
      req = await f.request();
    const snapshot = vi.fn(async () => {
      throw Error("unsafe snapshot invoked");
    });
    f.context.snapshot = snapshot;
    const p = await f.actions.prepare(req);
    expect((await f.actions.execute(p.token)).status).toBe("saved");
    expect(snapshot).not.toHaveBeenCalled();
  });
  it.each(["text", "current", "delete"] as const)(
    "saves a benign .gitattributes %s resolution with only its own metadata delta",
    async (kind) => {
      const f = await fixture(".gitattributes", [
        "# base\n",
        "# current\n",
        "# incoming\n",
      ]);
      await f.write(".gitattributes", "# edited\n");
      const before = (
        await f.git(["check-attr", "-z", "--all", "--", ".gitattributes"])
      ).stdout;
      const p = await f.prepare(
        kind === "text" ? { kind, text: "# resolved comment\n" } : { kind },
      );
      const r = await f.actions.execute(p.token);
      expect(r.status, r.log).toBe("saved");
      expect(r.lockRetained).toBe(false);
      expect(
        (await f.git(["check-attr", "-z", "--all", "--", ".gitattributes"]))
          .stdout,
      ).toBe(before);
      expect(
        (await f.git(["ls-files", "--unmerged", "--", ".gitattributes"]))
          .stdout,
      ).toBe("");
    },
  );
});
it.each([
  "beforePublishWork",
  "afterPublishWork",
  "beforePublishIndex",
  "afterPublishIndex",
])(
  "native %s fault preserves portable recovery and blocks restart",
  async (seam) => {
    const f = await fixture();
    const p = await f.prepare();
    const index = await f.index();
    f.seams[seam] = () => {
      throw Error("fault");
    };
    const r = await f.actions.execute(p.token);
    expect(r.status).toBe("uncertain");
    expect(r.lockRetained).toBe(true);
    const record = JSON.parse(await fs.readFile(r.recoveryPath!, "utf8"));
    expect(record.state).toBe("uncertain");
    expect(
      record.recovery.files.find((v: { path: string }) => v.path === "a").data,
    ).toBe(Buffer.from("manual working\n").toString("base64"));
    expect(record.recovery.indexRecovery.objects.length).toBeGreaterThanOrEqual(
      3,
    );
    if (seam !== "afterPublishIndex") expect(await f.index()).toEqual(index);
    const journal = new NativeGitJournal({
      directory: path.join(f.home, "journal"),
    });
    await expect(
      journal.assertAdmission(f.root, await f.context.native!.owner()),
    ).rejects.toThrow();
  },
);
it.each(["work", "index", "ready", "parent", "controls"])(
  "native rejects %s replacement before publication",
  async (kind) => {
    const f = await fixture("dir/a");
    const p = await f.prepare();
    const index = await f.index();
    f.seams.beforePublishWork = () => {
      if (kind === "work") writeFileSync(path.join(f.root, f.name), "external");
      if (kind === "index")
        writeFileSync(path.join(f.root, ".git/index"), "external");
      if (kind === "controls")
        writeFileSync(
          path.join(f.root, ".git/MERGE_HEAD"),
          "b".repeat(40) + "\n",
        );
      if (kind === "parent") {
        renameSync(path.join(f.root, "dir"), path.join(f.root, "moved"));
        symlinkSync(path.join(f.root, "moved"), path.join(f.root, "dir"));
      }
      if (kind === "ready") {
        const d = readdirSync(path.join(f.root, ".git")).find((n) =>
          n.startsWith("goga-native-resolution-"),
        )!;
        const ready = path.join(f.root, ".git", d, "ready");
        unlinkSync(ready);
        symlinkSync(path.join(f.root, "other"), ready);
      }
    };
    const r = await f.actions.execute(p.token);
    expect(r).toMatchObject({
      status: "uncertain",
      worktreePublished: false,
      indexPublished: false,
    });
    expect(await fs.readFile(path.join(f.root, f.name), "utf8")).toBe(
      kind === "work" ? "external" : "manual working\n",
    );
    if (kind !== "index") expect(await f.index()).toEqual(index);
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other working\n",
    );
  },
);
it.each(["work", "index", "lock"])(
  "native preserves external %s after work publication without rollback",
  async (kind) => {
    const f = await fixture();
    const p = await f.prepare();
    const index = await f.index();
    f.seams.beforePublishIndex = () =>
      writeFileSync(
        path.join(
          f.root,
          kind === "work"
            ? "a"
            : kind === "index"
              ? ".git/index"
              : ".git/index.lock",
        ),
        "external",
      );
    const r = await f.actions.execute(p.token);
    expect(r).toMatchObject({
      status: "uncertain",
      worktreePublished: true,
      indexPublished: false,
    });
    if (kind !== "index") expect(await f.index()).toEqual(index);
    expect(
      await fs.readFile(
        path.join(
          f.root,
          kind === "work"
            ? "a"
            : kind === "index"
              ? ".git/index"
              : ".git/index.lock",
        ),
        "utf8",
      ),
    ).toBe("external");
  },
);
it("native cleanup failure retains recovery and a restart fence", async () => {
  const f = await fixture();
  const p = await f.prepare();
  const real = await vi.importActual<typeof nativeFs>("node:fs");
  const spy = vi
    .spyOn(nativeFs, "rmSync")
    .mockImplementation((file, options) => {
      if (String(file).includes("goga-native-resolution-"))
        throw Error("cleanup denied");
      return real.rmSync(file, options);
    });
  try {
    const r = await f.actions.execute(p.token);
    expect(r).toMatchObject({ status: "uncertain", lockRetained: true });
    const record = JSON.parse(await fs.readFile(r.recoveryPath!, "utf8"));
    expect(record.recovery).not.toBeNull();
    await expect(
      new NativeGitJournal({
        directory: path.join(f.home, "journal"),
      }).assertAdmission(f.root, await f.context.native!.owner()),
    ).rejects.toThrow();
  } finally {
    spy.mockRestore();
  }
});
it.each([true, false])(
  "native text save preserves exact 0740 permissions with filemode=%s",
  async (filemode) => {
    const f = await fixture();
    await fs.chmod(path.join(f.root, "a"), 0o740);
    await f.git(["config", "core.filemode", String(filemode)]);
    expect((await f.actions.execute((await f.prepare()).token)).status).toBe(
      "saved",
    );
    expect((await fs.stat(path.join(f.root, "a"))).mode & 0o777).toBe(0o740);
  },
);
it.each(["edit", "replace", "chmod", "delete"])(
  "native never adopts external %s before first published read",
  async (mode) => {
    const f = await fixture();
    await fs.chmod(path.join(f.root, "a"), 0o600);
    const p = await f.prepare(
      mode === "delete"
        ? { kind: "delete" }
        : { kind: "text", text: "approved\n" },
    );
    const index = await f.index();
    const real = await vi.importActual<typeof nativeFs>("node:fs");
    const spy =
      mode !== "delete"
        ? vi.spyOn(nativeFs, "unlinkSync").mockImplementation((file) => {
            real.unlinkSync(file);
            if (String(file).endsWith("/ready")) {
              const work = path.join(f.root, "a");
              if (mode === "edit") real.writeFileSync(work, "external\n");
              if (mode === "replace") {
                real.renameSync(work, path.join(f.dir, "approved"));
                real.writeFileSync(work, "approved\n", { mode: 0o600 });
              }
              if (mode === "chmod") real.chmodSync(work, 0o644);
            }
          })
        : vi.spyOn(nativeFs, "renameSync").mockImplementation((from, to) => {
            real.renameSync(from, to);
            if (String(from) === path.join(f.root, "a"))
              real.writeFileSync(from, "external\n");
          });
    try {
      const r = await f.actions.execute(p.token);
      expect(r).toMatchObject({
        status: "uncertain",
        worktreePublished: true,
        indexPublished: false,
      });
      expect(await f.index()).toEqual(index);
      expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
        ["replace", "chmod"].includes(mode) ? "approved\n" : "external\n",
      );
    } finally {
      spy.mockRestore();
    }
  },
);

it("outer context failure keeps native resolution recovery fenced", async () => {
  const f = await fixture();
  const p = await f.prepare();
  f.seams.outerContext = () => {
    throw Error("release failed");
  };
  const r = await f.actions.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    worktreePublished: true,
    indexPublished: true,
    lockRetained: true,
  });
  const record = JSON.parse(await fs.readFile(r.recoveryPath!, "utf8"));
  expect(record.recovery).not.toBeNull();
  await expect(
    new NativeGitJournal({
      directory: path.join(f.home, "journal"),
    }).assertAdmission(f.root, await f.context.native!.owner()),
  ).rejects.toThrow();
});
it("changed attribute policy stops native resolution before staging", async () => {
  const f = await fixture(".gitattributes", [
    "# base\n",
    "# current\n",
    "# incoming\n",
  ]);
  await f.write(".gitattributes", "# old\n");
  const p = await f.prepare({ kind: "text", text: "* text eol=lf\n" });
  const index = await f.index();
  const r = await f.actions.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    worktreePublished: true,
    indexPublished: false,
  });
  expect(await f.index()).toEqual(index);
});
it.each(["original", "snapshot.json", "submitted-work", "directory"])(
  "native retains recovery when %s ownership changes",
  async (kind) => {
    const f = await fixture();
    const p = await f.prepare();
    const index = await f.index();
    f.seams.afterPublishWork = () => {
      const d = path.join(
        f.root,
        ".git",
        readdirSync(path.join(f.root, ".git")).find((n) =>
          n.startsWith("goga-native-resolution-"),
        )!,
      );
      if (kind === "directory") renameSync(d, path.join(f.dir, "moved"));
      else writeFileSync(path.join(d, kind), "foreign");
    };
    const r = await f.actions.execute(p.token);
    expect(r).toMatchObject({ status: "uncertain", indexPublished: false });
    expect(await f.index()).toEqual(index);
    await expect(
      new NativeGitJournal({
        directory: path.join(f.home, "journal"),
      }).assertAdmission(f.root, await f.context.native!.owner()),
    ).rejects.toThrow();
  },
);
it("native stat refresh never executes a newly installed filter", async () => {
  const f = await fixture();
  await f.write(".gitattributes", "other filter=late\n");
  const p = await f.prepare();
  const marker = path.join(f.dir, "filter-executed");
  const original = f.runner.commandBytes.bind(f.runner);
  let refreshed = false;
  const spy = vi
    .spyOn(f.runner, "commandBytes")
    .mockImplementation(async (request) => {
      if (request.args.includes("--refresh") && !refreshed) {
        refreshed = true;
        await f.git([
          "config",
          "filter.late.clean",
          `printf called > '${marker}'; cat`,
        ]);
        expect(request.args.find((v) => v.startsWith("--git-dir="))).not.toBe(
          `--git-dir=${f.root}/.git`,
        );
      }
      return original(request);
    });
  try {
    const r = await f.actions.execute(p.token);
    expect(refreshed).toBe(true);
    expect(r.status).toBe("uncertain");
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.root, "other"), "utf8")).toBe(
      "other working\n",
    );
  } finally {
    spy.mockRestore();
  }
});
it("recovery retains submitted bytes even after a later external work edit", async () => {
  const f = await fixture();
  const p = await f.prepare();
  f.seams.afterPublishWork = () =>
    writeFileSync(path.join(f.root, "a"), "external\n");
  const r = await f.actions.execute(p.token);
  expect(r.status).toBe("uncertain");
  const staging = path.join(
    f.root,
    ".git",
    (await fs.readdir(path.join(f.root, ".git"))).find((n) =>
      n.startsWith("goga-native-resolution-"),
    )!,
  );
  expect(await fs.readFile(path.join(staging, "submitted-work"), "utf8")).toBe(
    "resolved\n",
  );
  expect(await fs.readFile(path.join(staging, "canonical-blob"), "utf8")).toBe(
    "resolved\n",
  );
  expect(await fs.readFile(path.join(staging, "original"), "utf8")).toBe(
    "manual working\n",
  );
});

it("context-returned cleanup failure retains native recovery and sanitized diagnostics", async () => {
  const f = await fixture();
  const p = await f.prepare();
  f.seams.contextResult = (value: object) => ({
    ...value,
    status: "uncertain",
    message: "sanitized cleanup failure",
    log: "sanitized context diagnostics",
  });
  const r = await f.actions.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    worktreePublished: true,
    indexPublished: true,
    lockRetained: true,
    message: "sanitized cleanup failure",
    log: "sanitized context diagnostics",
  });
  expect(r.recoveryPath).toBeTruthy();
  await expect(fs.stat(r.recoveryPath!)).resolves.toBeTruthy();
  await expect(
    new NativeGitJournal({
      directory: path.join(f.home, "journal"),
    }).assertAdmission(f.root, await f.context.native!.owner()),
  ).rejects.toThrow();
});

it("throwing context cannot expose unsanitized conflict-save diagnostics", async () => {
  const f = await fixture();
  const p = await f.prepare();
  const secret = "private-native-context-secret";
  f.seams.contextResult = (value: { log: string }) => {
    value.log += secret;
    throw Error(`cleanup ${secret}`);
  };
  const r = await f.actions.execute(p.token);
  expect(r).toMatchObject({
    status: "uncertain",
    worktreePublished: true,
    indexPublished: true,
    lockRetained: true,
  });
  expect(JSON.stringify(r)).not.toContain(secret);
  await expect(
    new NativeGitJournal({
      directory: path.join(f.home, "journal"),
    }).assertAdmission(f.root, await f.context.native!.owner()),
  ).rejects.toThrow();
});
