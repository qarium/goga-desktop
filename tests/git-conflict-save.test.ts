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
import * as api from "../src/host/git-conflict-actions";
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
  const bound = async <T>(
    _scope: unknown,
    fn: (c: GitCommitContext & { isolatedGit: typeof git }) => Promise<T>,
  ) => fn({ ...context, ownerKey: owner });
  const conflicts = new GitConflictReader({ context: bound });
  const seams: Record<string, unknown> = {};
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
describe("single path conflict save transaction", () => {
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
    const r = await f.actions.execute(p.token);
    expect(r.status).toBe("not-saved");
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
  it.each([
    "beforePublishWork",
    "afterPublishWork",
    "beforePublishIndex",
    "afterPublishIndex",
  ])("reports honest recovery when %s fails", async (seam) => {
    const f = await fixture(),
      p = await f.prepare(),
      before = await f.index();
    f.seams[seam] = () => {
      throw Error("injected");
    };
    const r = await f.actions.execute(p.token);
    expect(r.status).toBe(
      seam === "beforePublishWork"
        ? "not-saved"
        : seam === "afterPublishIndex"
          ? "uncertain"
          : "partial",
    );
    if (seam !== "beforePublishWork") {
      expect(r.recoveryPath).toBeTruthy();
      const journal = JSON.parse(
        await fs.readFile(path.join(r.recoveryPath!, "journal.json"), "utf8"),
      );
      expect(journal.lockIdentity).toMatch(/^\d+:\d+$/);
      expect(journal.preparedIndexHash).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await fs.readFile(path.join(r.recoveryPath!, "original-index")),
      ).toEqual(before);
      expect(
        await fs.readFile(path.join(r.recoveryPath!, "original-work"), "utf8"),
      ).toBe("manual working\n");
      expect(
        await fs.readFile(path.join(r.recoveryPath!, "submitted-work"), "utf8"),
      ).toBe("resolved\n");
      expect(
        JSON.parse(
          await fs.readFile(path.join(r.recoveryPath!, "journal.json"), "utf8"),
        ).state,
      ).not.toBe("complete");
    }
    expect(r.lockRetained).toBe(
      seam === "afterPublishWork" || seam === "beforePublishIndex",
    );
    if (seam !== "afterPublishIndex") expect(await f.index()).toEqual(before);
  });
  it("CAS refuses external work edits before publish and leaves no own lock", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.seams.beforePublishWork = () => {
      writeFileSync(path.join(f.root, "a"), "external");
    };
    expect((await f.actions.execute(p.token)).status).toBe("not-saved");
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe("external");
    await expect(
      fs.lstat(path.join(f.root, ".git/index.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never restores old bytes over a later external edit after work publication", async () => {
    const f = await fixture(),
      p = await f.prepare(),
      before = await f.index();
    f.seams.beforePublishIndex = () => {
      writeFileSync(path.join(f.root, "a"), "new external");
    };
    const r = await f.actions.execute(p.token);
    expect(r).toMatchObject({ status: "partial", indexPublished: false });
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "new external",
    );
    expect(await f.index()).toEqual(before);
  });
  it("never publishes or removes a replaced foreign lock", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.seams.beforePublishIndex = () => {
      unlinkSync(path.join(f.root, ".git/index.lock"));
      writeFileSync(path.join(f.root, ".git/index.lock"), "foreign");
    };
    const r = await f.actions.execute(p.token);
    expect(r).toMatchObject({
      status: "partial",
      indexPublished: false,
      lockRetained: false,
    });
    expect(
      await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
    ).toBe("foreign");
  });
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
  it("releases only its own lock when a work parent becomes a symlink before publication", async () => {
    const f = await fixture("dir/a"),
      p = await f.prepare();
    const outside = path.join(f.dir, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "a"), "outside");
    f.seams.beforePublishWork = () => {
      renameSync(path.join(f.root, "dir"), path.join(f.root, "old-dir"));
      symlinkSync(outside, path.join(f.root, "dir"));
    };
    const r = await f.actions.execute(p.token);
    expect(r.status).toBe("not-saved");
    expect(await fs.readFile(path.join(outside, "a"), "utf8")).toBe("outside");
    await expect(
      fs.lstat(path.join(f.root, ".git/index.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not overwrite external index bytes after work was published", async () => {
    const f = await fixture(),
      p = await f.prepare();
    const external = Buffer.from(await f.index());
    f.seams.beforePublishIndex = () => {
      writeFileSync(path.join(f.root, ".git/index"), external);
    };
    const r = await f.actions.execute(p.token);
    expect(r.status).toBe("partial");
    expect(await f.index()).toEqual(external);
  });
  it("rejects changed effective attributes between preview and execution", async () => {
    const f = await fixture(),
      p = await f.prepare();
    await f.write(".gitattributes", "a text eol=lf\n");
    await expect(f.actions.execute(p.token)).rejects.toThrow();
  });
  it("captures .gitattributes self-modification as partial before staging", async () => {
    const f = await fixture(".gitattributes", [
      "*.txt text\n",
      "*.txt text eol=lf\n",
      "*.txt -text\n",
    ]);
    const p = await f.prepare({ kind: "text", text: "* text eol=lf\n" });
    const result = await f.actions.execute(p.token);
    expect(result.status).toBe("partial");
  });
  it("preserves private POSIX permissions when saving manual text", async () => {
    const f = await fixture();
    await fs.chmod(path.join(f.root, "a"), 0o600);
    const r = await f.actions.execute((await f.prepare()).token);
    expect(r.status).toBe("saved");
    expect((await fs.stat(path.join(f.root, "a"))).mode & 0o777).toBe(0o600);
  });
  it("refuses replacement of prepared working bytes with a symlink", async () => {
    const f = await fixture(),
      p = await f.prepare(),
      outside = path.join(f.dir, "outside");
    await fs.writeFile(outside, "outside");
    f.seams.beforePublishWork = () => {
      const dir = path.join(
        f.root,
        ".git",
        readdirSync(path.join(f.root, ".git")).find((n) =>
          n.startsWith("goga-commit-"),
        )!,
      );
      unlinkSync(path.join(dir, "work-ready"));
      symlinkSync(outside, path.join(dir, "work-ready"));
    };
    const r = await f.actions.execute(p.token);
    expect(r.status).toBe("not-saved");
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "manual working\n",
    );
    expect(await fs.readFile(outside, "utf8")).toBe("outside");
  });
  it("publishes a complete valid lock and refuses in-place lock content replacement", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.seams.beforePublishWork = () => {
      const lock = path.join(f.root, ".git/index.lock"),
        bytes = readFileSync(lock);
      expect(bytes.subarray(0, 4).toString()).toBe("DIRC");
      expect(bytes.length).toBeGreaterThan(100);
      const dir = path.join(
        f.root,
        ".git",
        readdirSync(path.join(f.root, ".git")).find((n) =>
          n.startsWith("goga-commit-"),
        )!,
      );
      writeFileSync(lock, "foreign");
      writeFileSync(path.join(dir, "index"), "foreign");
    };
    const r = await f.actions.execute(p.token);
    expect(r.status).toBe("not-saved");
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "manual working\n",
    );
    expect(
      await fs.readFile(path.join(f.root, ".git/index.lock"), "utf8"),
    ).toBe("foreign");
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
  it("releases a verified own lock if the private recovery directory was moved before publication", async () => {
    const f = await fixture(),
      p = await f.prepare();
    f.seams.beforePublishWork = () => {
      const dir = path.join(
        f.root,
        ".git",
        readdirSync(path.join(f.root, ".git")).find((n) =>
          n.startsWith("goga-commit-"),
        )!,
      );
      renameSync(dir, path.join(f.root, ".git", "external-moved"));
    };
    expect((await f.actions.execute(p.token)).status).toBe("not-saved");
    await expect(
      fs.lstat(path.join(f.root, ".git/index.lock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
      "manual working\n",
    );
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
  it.each(["edit", "replace", "chmod", "delete"] as const)(
    "does not adopt an external %s before the first published read",
    async (mode) => {
      const f = await fixture();
      await fs.chmod(path.join(f.root, "a"), 0o600);
      const p = await f.prepare(
          mode === "delete"
            ? { kind: "delete" }
            : { kind: "text", text: "approved draft\n" },
        ),
        originalIndex = await f.index();
      const real = await vi.importActual<typeof import("node:fs")>("node:fs");
      const spy =
        mode !== "delete"
          ? vi.spyOn(nativeFs, "renameSync").mockImplementation((from, to) => {
              real.renameSync(from, to);
              if (String(from).endsWith("/work-ready")) {
                if (mode === "edit") real.writeFileSync(to, "external edit\n");
                if (mode === "replace") {
                  real.renameSync(to, path.join(f.dir, "moved-approved"));
                  real.writeFileSync(to, "approved draft\n", { mode: 0o600 });
                }
                if (mode === "chmod") real.chmodSync(to, 0o644);
              }
            })
          : vi.spyOn(nativeFs, "unlinkSync").mockImplementation((file) => {
              real.unlinkSync(file);
              if (String(file) === path.join(f.root, "a"))
                real.writeFileSync(file, "external edit\n");
            });
      try {
        const r = await f.actions.execute(p.token);
        expect(r).toMatchObject({
          status: "partial",
          worktreePublished: true,
          indexPublished: false,
          lockRetained: true,
        });
        expect(await fs.readFile(path.join(f.root, "a"), "utf8")).toBe(
          ["replace", "chmod"].includes(mode)
            ? "approved draft\n"
            : "external edit\n",
        );
        if (mode === "chmod")
          expect((await fs.stat(path.join(f.root, "a"))).mode & 0o777).toBe(
            0o644,
          );
        expect(await f.index()).toEqual(originalIndex);
        expect(
          await fs.readFile(
            path.join(r.recoveryPath!, "original-work"),
            "utf8",
          ),
        ).toBe("manual working\n");
      } finally {
        spy.mockRestore();
      }
    },
  );
});
