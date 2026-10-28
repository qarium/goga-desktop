import { gitIntegrationBudget } from "./helpers/git-integration";
import { nativeSequenceScope as fixtureScope } from "./helpers/native-sequence-regression";
import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { nativeSequenceFixture } from "./helpers/native-sequence-regression";
import type { NativeSequenceStart } from "../src/host/git-native-sequence";

type Fixture = Awaited<ReturnType<typeof nativeSequenceFixture>>;

// Capture bytes/modes, not timestamps or the retired publisher's inode rules.
// Reading directly also avoids a Git status refresh masking an index write.
async function contents(root: string): Promise<unknown> {
  const s = await fs.lstat(root).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (!s) return null;
  if (s.isSymbolicLink()) return ["symlink", await fs.readlink(root)];
  if (s.isDirectory())
    return Promise.all(
      (await fs.readdir(root))
        .sort()
        .filter((n) => n !== ".git")
        .map(async (n) => [n, await contents(path.join(root, n))]),
    );
  return [
    s.mode & 0o777,
    createHash("sha256")
      .update(await fs.readFile(root))
      .digest("hex"),
  ];
}
async function preserved(f: Fixture) {
  return Promise.all([
    contents(f.root),
    ...["index", "HEAD", "refs", "packed-refs"].map((n) =>
      contents(path.join(f.root, ".git", n)),
    ),
  ]);
}
const rebase = (f: Fixture): NativeSequenceStart => ({
  operation: "rebase",
  source: f.onto,
  backend: "merge",
});

// Seed coherent Git objects without checking out aliases. A portable filesystem
// need not be able to represent all source-tree names simultaneously. All index
// changes here are fixture setup, restored before the operation under test.
async function future(
  f: Fixture,
  names: string[],
): Promise<NativeSequenceStart> {
  await f.git(["config", "core.ignoreCase", "false"]);
  await f.git(["config", "core.precomposeUnicode", "false"]);
  const blob = (
    await f.gitInput(["hash-object", "-w", "--stdin"], "future data\n")
  ).stdout.trim();
  await f.git(["read-tree", f.sources[0]]);
  await f.gitInput(
    ["update-index", "-z", "--index-info"],
    names.map((name) => `100644 ${blob}\t${name}\0`).join(""),
  );
  const tree = (await f.git(["write-tree"])).trim();
  const commit = (
    await f.gitInput(
      ["commit-tree", tree, "-p", f.sources[0]],
      "future paths\n",
    )
  ).stdout.trim();
  await f.git(["read-tree", "HEAD"]);
  return { operation: "cherry-pick", commits: [f.sources[0], commit] };
}

it.each([".gitattributes", ".GITATTRIBUTES"])(
  "managed start refuses source-only %s without changing bytes, index or refs",
  fixtureScope.run(async (name) => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    await f.write(name, "* text eol=crlf\n");
    await f.git(["add", "--", name]);
    await f.git(["commit", "-m", "source-only attributes"]);
    expect(await f.git(["ls-tree", "--name-only", f.onto, "--", name])).toBe(
      "",
    );
    const before = await preserved(f);
    await expect(
      f.engine.prepareStart("regression", rebase(f)),
    ).rejects.toThrow();
    expect(await preserved(f)).toEqual(before);
    expect(f.calls).toHaveLength(0);
  }),
  gitIntegrationBudget(15000),
);

it.each(["smudge", "process"] as const)(
  "repository %s filter never executes during managed admission",
  fixtureScope.run(async (kind) => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    if (kind === "process")
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const marker = path.join(f.home, "filter-executed");
    await f.git([
      "config",
      `filter.fixture.${kind}`,
      `printf unsafe > '${marker}'; cat`,
    ]);
    await f.write(".git/info/attributes", "* filter=fixture\n");
    const before = await preserved(f);
    if (kind === "smudge")
      await expect(
        f.engine.prepareStart("regression", rebase(f)),
      ).rejects.toThrow();
    else await expect(f.prepare("abort")).rejects.toThrow();
    expect(await preserved(f)).toEqual(before);
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).toHaveLength(kind === "smudge" ? 0 : 1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "managed abort isolates a default global helper and restores exact baseline bytes",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    const marker = path.join(f.home, "global-filter-executed");
    const attributes = path.join(f.home, "git", "attributes");
    await fs.mkdir(path.dirname(attributes), { recursive: true });
    await fs.writeFile(attributes, "* filter=hostile\n");
    await fs.writeFile(
      path.join(f.home, ".gitconfig"),
      `[filter "hostile"]\nsmudge = "printf unsafe > '${marker}'; cat"\n`,
    );
    // Initial policy is admitted and remains unchanged through start and abort.
    // Injecting this source after the managed seal would instead test policy drift.
    const baseline = await contents(f.root);
    const index = await f.git(["ls-files", "--stage", "-z"]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    expect(
      await f.engine.execute((await f.prepare("abort")).token),
    ).toMatchObject({
      outcome: "completed",
      recovery: "removed",
    });
    expect(await contents(f.root)).toEqual(baseline);
    expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    expect((await f.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(
      f.branch,
    );
    expect(await fs.readFile(attributes, "utf8")).toBe("* filter=hostile\n");
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.calls).toHaveLength(2);
  }),
  gitIntegrationBudget(15000),
);

it(
  "changed default global attributes after a managed seal revoke abort authority without native writes",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    const attributes = path.join(f.home, "git", "attributes");
    await fs.mkdir(path.dirname(attributes), { recursive: true });
    await fs.writeFile(attributes, "* text eol=lf\n");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const preview = await f.prepare("abort");
    await fs.writeFile(attributes, "* text eol=crlf\n");
    const before = await preserved(f);
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    expect(await preserved(f)).toEqual(before);
    expect(await fs.readFile(attributes, "utf8")).toBe("* text eol=crlf\n");
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "commit.cleanup drift after a managed seal refuses abort without losing user data",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const preview = await f.prepare("abort");
    await f.git(["config", "commit.cleanup", "verbatim"]);
    const before = await preserved(f);
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    expect(await preserved(f)).toEqual(before);
    expect((await f.git(["config", "commit.cleanup"])).trim()).toBe("verbatim");
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "managed abort does not remove an originally empty pinned directory",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    await f.git(["checkout", "main"]);
    await fs.mkdir(path.join(f.root, "pinned"));
    await f.write("pinned/upstream", "upstream only\n");
    await f.git(["add", "pinned/upstream"]);
    await f.git(["commit", "-m", "upstream directory"]);
    const source = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git(["checkout", "topic"]);
    await fs.mkdir(path.join(f.root, "pinned"), { recursive: true });
    const baseline = await contents(f.root);
    const index = await f.git(["ls-files", "--stage", "-z"]);
    // Either conservative admission or supported directory retention is safe;
    // success without the original directory is never accepted.
    const start = await f.engine
      .prepareStart("regression", {
        operation: "rebase",
        source,
        backend: "merge",
      })
      .then(
        (preview) => ({ preview }),
        (error: unknown) => ({ error }),
      );
    if (!("preview" in start)) {
      expect(start.error).toBeInstanceOf(Error);
      expect(await contents(f.root)).toEqual(baseline);
      expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
      expect(f.calls).toHaveLength(0);
      return;
    }
    expect(await f.engine.execute(start.preview.token)).toMatchObject({
      outcome: "conflicts",
    });
    const before = await preserved(f);
    const abort = await f.prepare("abort").then(
      (preview) => ({ preview }),
      (error: unknown) => ({ error }),
    );
    if (!("preview" in abort)) {
      expect(abort.error).toBeInstanceOf(Error);
      expect(await preserved(f)).toEqual(before);
      expect(f.calls).toHaveLength(1);
    } else {
      expect(await f.engine.execute(abort.preview.token)).toMatchObject({
        outcome: "completed",
        recovery: "removed",
      });
      expect(await contents(f.root)).toEqual(baseline);
      expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
      expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
      expect(f.calls).toHaveLength(2);
    }
    expect((await fs.stat(path.join(f.root, "pinned"))).isDirectory()).toBe(
      true,
    );
  }),
  gitIntegrationBudget(15000),
);

it.each([
  ["future/NewFile", "future/newfile"],
  ["future/NewDir/file", "future/newdir/file"],
  ["future/Caf\u00e9", "future/Cafe\u0301"],
  ["future/Caf\u00e9/file", "future/Cafe\u0301/file"],
])(
  "future ignored alias %s / %s never overwrites physical user bytes",
  fixtureScope.run(async (target, alias) => {
    const f = await nativeSequenceFixture("cherry-pick", 1, [1]);
    const start = await future(f, [target]);
    await f.write(".git/info/exclude", "future/\n");
    await fs.mkdir(path.dirname(path.join(f.root, alias)), { recursive: true });
    await f.write(alias, "private alias draft\n");
    const physicalAlias = await fs.stat(path.join(f.root, target)).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return false;
        throw e;
      },
    );
    const before = await preserved(f);
    const preview = await f.engine.prepareStart("regression", start).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if ("error" in preview) {
      expect(preview.error).toBeInstanceOf(Error);
      expect(await preserved(f)).toEqual(before);
      expect(f.calls).toHaveLength(0);
    } else {
      // A case/normalization-sensitive volume may safely retain both names.
      expect(physicalAlias).toBe(false);
      expect(await f.engine.execute(preview.value.token)).toMatchObject({
        outcome: "conflicts",
      });
      await f.resolve();
      expect(
        await f.engine.execute((await f.prepare("continue")).token),
      ).toMatchObject({ outcome: "completed", recovery: "removed" });
      expect(await f.read(target)).toBe("future data\n");
      expect(await f.git(["diff", "HEAD"])).toBe("");
      expect(f.calls).toHaveLength(2);
    }
    expect(await f.read(alias)).toBe("private alias draft\n");
    expect(await f.read("ignored")).toBe("preserve ignored\n");
    expect(await f.read("untracked")).toBe("preserve untracked\n");
  }),
  gitIntegrationBudget(15000),
);

it.each([
  { kind: "file case", names: ["Future", "future"] },
  { kind: "parent case", names: ["Future/one", "future/two"] },
  { kind: "file versus parent", names: ["Future", "future/child"] },
  { kind: "canonical Unicode file", names: ["Caf\u00e9", "Cafe\u0301"] },
  {
    kind: "canonical Unicode parent",
    names: ["Caf\u00e9/one", "Cafe\u0301/two"],
  },
])(
  "future-only coherent $kind aliases are rejected before native writes",
  fixtureScope.run(async ({ names }) => {
    const f = await nativeSequenceFixture("cherry-pick", 1, [1]);
    const start = await future(f, names);
    const before = await preserved(f);
    await expect(f.engine.prepareStart("regression", start)).rejects.toThrow();
    expect(await preserved(f)).toEqual(before);
    expect(f.calls).toHaveLength(0);
  }),
  gitIntegrationBudget(15000),
);

it(
  "a non-ASCII future path without aliases is restored by managed native abort",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    const name = "будущее/данные";
    await fs.mkdir(path.dirname(path.join(f.root, name)), { recursive: true });
    await f.write(name, "future data\n");
    await f.git(["add", "--", name]);
    await f.git(["commit", "-m", "future Unicode restoration"]);
    const original = (await f.git(["rev-parse", "HEAD"])).trim();
    const index = await f.git(["ls-files", "--stage", "-z"]);
    const baseline = await contents(f.root);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await expect(fs.stat(path.join(f.root, name))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await f.engine.execute((await f.prepare("abort")).token),
    ).toMatchObject({ outcome: "completed", recovery: "removed" });
    expect(await contents(f.root)).toEqual(baseline);
    expect(await f.read(name)).toBe("future data\n");
    expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(original);
    expect((await f.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(
      f.branch,
    );
    expect(f.calls).toHaveLength(2);
  }),
  gitIntegrationBudget(15000),
);

it(
  "a new empty future parent after preview cannot be consumed by native start",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("cherry-pick", 1, [1]);
    const start = await future(f, ["late-empty/value"]);
    const preview = await f.engine.prepareStart("regression", start);
    await fs.mkdir(path.join(f.root, "late-empty"));
    const before = await preserved(f);
    const result = await f.engine.execute(preview.token);
    expect(result).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
    });
    expect(f.calls).toHaveLength(0);
    expect(await preserved(f)).toEqual(before);
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
  }),
  gitIntegrationBudget(15000),
);
