import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { NodeRunner } from "../src/host/process";
import {
  withPrivateGitRead,
  type PrivateGitRead,
} from "../src/host/git-private-read";
import { installGitFixtureScope } from "./helpers/git-test-scope";
const scope = installGitFixtureScope();
async function fixture() {
  const root = await fs.mkdtemp("/private/tmp/goga-commit-proof-");
  scope().cleanup(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const runner = scope.runner(new NodeRunner(undefined, env));
  const git = async (args: string[]) =>
    (await runner.command("git", args, root, env)).stdout;
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(root, "selected"), "base\n");
  await git(["add", "selected"]);
  await git([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "base",
  ]);
  return { root, git };
}
it(
  "optional commit source witness closes copied index bytes after all private reads",
  scope.run(async () => {
    const f = await fixture();
    await withPrivateGitRead(
      f.root,
      [],
      f.git,
      f.git,
      async (read) => {
        const source = read as PrivateGitRead & {
          verifySources?: () => Promise<void>;
        };
        expect(source.verifySources).toBeTypeOf("function");
        await read.git(["status", "--porcelain=v2", "-z"]);
        const filename = path.join(f.root, ".git/index");
        const before = await fs.stat(filename);
        const bytes = await fs.readFile(filename);
        bytes[20] ^= 1;
        await fs.writeFile(filename, bytes);
        await fs.utimes(filename, before.atime, before.mtime);
        await expect(source.verifySources!()).rejects.toThrow();
      },
      { commitSourcePaths: ["selected"] },
    );
  }),
);

it.each([
  "HEAD",
  "refs/heads/main",
  "packed-refs",
  "info/attributes",
  "info/exclude",
  "info/grafts",
  "info/sparse-checkout",
  "ORIG_HEAD",
  "config.worktree",
  "absent-attributes",
  "refs-membership",
])(
  "commit witness rejects changed %s after private copy, including missing paths",
  scope.run(async (name) => {
    const f = await fixture();
    if (name === "packed-refs") await f.git(["pack-refs", "--all"]);
    await withPrivateGitRead(
      f.root,
      [],
      f.git,
      f.git,
      async (read) => {
        const file = path.join(
          f.root,
          name === "absent-attributes"
            ? ".gitattributes"
            : name === "refs-membership"
              ? ".git/refs/heads/foreign"
              : `.git/${name}`,
        );
        const before = await fs.stat(file).catch(() => null);
        const bytes = await fs
          .readFile(file)
          .catch(() => Buffer.from("new metadata\n"));
        if (before) bytes[0] ^= 1;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
        if (before) await fs.utimes(file, before.atime, before.mtime);
        await expect(read.verifySources!()).rejects.toThrow();
      },
      { commitSourcePaths: ["selected"] },
    );
  }),
);
it(
  "default private reader has no commit source capability and unchanged config verification",
  scope.run(async () => {
    const f = await fixture();
    await withPrivateGitRead(f.root, [], f.git, f.git, async (read) => {
      expect(read.sources).toBeUndefined();
      expect(read.verifySources).toBeUndefined();
      await expect(read.verify()).resolves.toBeUndefined();
    });
  }),
);
it.each(["symlink", "hardlink", "directory-replacement"])(
  "commit witness rejects %s metadata",
  scope.run(async (kind) => {
    const f = await fixture();
    await withPrivateGitRead(
      f.root,
      [],
      f.git,
      f.git,
      async (read) => {
        const target = path.join(f.root, ".git/index"),
          moved = path.join(f.root, "original-index");
        if (kind === "directory-replacement") {
          const refs = path.join(f.root, ".git/refs"),
            saved = path.join(f.root, "original-refs");
          await fs.rename(refs, saved);
          await fs.cp(saved, refs, { recursive: true });
        } else {
          await fs.rename(target, moved);
          if (kind === "symlink") await fs.symlink(moved, target);
          else await fs.link(moved, target);
        }
        await expect(read.verifySources!()).rejects.toThrow();
      },
      { commitSourcePaths: ["selected"] },
    );
  }),
);

it.each(["index", "HEAD", "info/exclude"])(
  "SPEC-05 behavioral source closure rejects same-size/mtime copied %s drift",
  scope.run(async (name) => {
    const f = await fixture(),
      filename = path.join(f.root, ".git", name);
    await f.git(["branch", "else"]);
    if (name === "info/exclude") await fs.writeFile(filename, "# before\n");
    const timestamp = new Date(1700000000000);
    await fs.utimes(filename, timestamp, timestamp);
    const original = await fs.readFile(filename),
      stat = await fs.stat(filename);
    // Isolated old-check arrangement: no product source or baseline edits.
    // Opt-in RED uses the unchanged legacy policy.verify closure, not a missing API.
    const oldCheck = process.env.GOGA_COMMIT_SOURCE_BEHAVIOR_OLD_CHECK === "1";
    await withPrivateGitRead(
      f.root,
      [],
      f.git,
      f.git,
      async (read) => {
        const before = await read.git(["status", "--porcelain=v2", "-z"]);
        if (name === "index") {
          // One SHA-1 index-v2 entry: change CE_VALID in place and recompute the
          // native index checksum. This remains a valid index with the SAME inode.
          const changed = Buffer.from(original);
          expect(changed.readUInt32BE(4)).toBe(2);
          expect(changed.readUInt32BE(8)).toBe(1);
          changed[12 + 40 + 20] ^= 0x80;
          createHash("sha1")
            .update(changed.subarray(0, -20))
            .digest()
            .copy(changed, changed.length - 20);
          await fs.writeFile(filename, changed);
          expect(await f.git(["ls-files", "-v", "selected"])).toBe(
            "h selected\n",
          );
          expect(await read.git(["ls-files", "-v", "selected"])).toBe(
            "H selected\n",
          );
        } else
          await fs.writeFile(
            filename,
            name === "HEAD" ? "ref: refs/heads/else\n" : "# change\n",
          );
        await fs.utimes(filename, stat.atime, stat.mtime);
        const changed = await fs.readFile(filename),
          after = await fs.stat(filename);
        expect(changed.length).toBe(original.length);
        expect(changed).not.toEqual(original);
        expect(after.mtimeMs).toBe(stat.mtimeMs);
        expect(after.ino).toBe(stat.ino);
        // The copied private repository still reads old metadata successfully.
        expect(await read.git(["status", "--porcelain=v2", "-z"])).toBe(before);
        const close = async () => {
          await read.verify();
          if (!oldCheck) await read.verifySources!();
        };
        await expect(close()).rejects.toThrow();
      },
      oldCheck ? undefined : { commitSourcePaths: ["selected"] },
    );
  }),
);
