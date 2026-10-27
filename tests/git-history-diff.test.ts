import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { historyFixture } from "./helpers/git-history-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
const read = (oid: string, parentIndex = 0) => ({
  scope: "project",
  ref: "HEAD",
  tip: oid,
  commit: oid,
  parentIndex,
  fileOffset: 0,
});
const diff = (oid: string, path: string, extra = {}) => ({
  scope: "project",
  ref: "HEAD",
  tip: oid,
  commit: oid,
  parentIndex: 0,
  path,
  ...extra,
});

describe("read-only commit details and diff", () => {
  it.each(["sha1", "sha256"] as const)(
    "shows root commit against an empty tree for %s",
    async (format) => {
      const f = await historyFixture(cleanup, format);
      await f.write("a", "first\n");
      const oid = await f.commit("Первый\n\nПолное описание\nС новой строкой");
      const details = await f.reader.commit(read(oid));
      expect(details).toMatchObject({
        parent: null,
        parentIndex: 0,
        message: "Первый\n\nПолное описание\nС новой строкой\n",
        files: [{ path: "a", status: "A", additions: 1, deletions: 0 }],
        nextFileOffset: null,
      });
      expect(details.commit.parents).toEqual([]);
      expect((await f.reader.diff(diff(oid, "a"))).part).toMatchObject({
        kind: "patch",
        text: expect.stringContaining("+first"),
      });
      await expect(f.reader.commit(read(oid, 1))).rejects.toThrow(/родител/i);
    },
  );
  it("reads added, deleted, renamed and modified files from objects rather than dirty working files", async () => {
    const f = await historyFixture(cleanup);
    for (const name of ["a", "deleted", "old"])
      await f.write(name, `${name}\n`);
    await f.commit();
    await f.write("a", "committed\n");
    await fs.unlink(path.join(f.root, "deleted"));
    await f.git(["mv", "old", "new\nЮникод name"]);
    await f.write("added", "added\n");
    const oid = await f.commit();
    await f.write("a", "DO NOT DISPLAY WORKTREE\n");
    const details = await f.reader.commit(read(oid));
    expect(details.files).toEqual(
      expect.arrayContaining([
        { path: "a", status: "M", additions: 1, deletions: 1 },
        { path: "deleted", status: "D", additions: 0, deletions: 1 },
        { path: "added", status: "A", additions: 1, deletions: 0 },
        {
          path: "new\nЮникод name",
          originalPath: "old",
          status: "R",
          additions: 0,
          deletions: 0,
        },
      ]),
    );
    const change = await f.reader.diff(diff(oid, "a"));
    expect(change.part.text).toContain("+committed");
    expect(change.part.text).not.toContain("DO NOT DISPLAY");
    expect((await f.reader.diff(diff(oid, "deleted"))).part.text).toContain(
      "-deleted",
    );
    expect(
      (
        await f.reader.diff(
          diff(oid, "new\nЮникод name", { originalPath: "old" }),
        )
      ).part.text,
    ).toContain("rename from");
    await expect(
      f.reader.diff(diff(oid, "new\nЮникод name", { originalPath: "a" })),
    ).rejects.toThrow(/файл/i);
    await expect(f.reader.diff(diff(oid, "missing"))).rejects.toThrow(/файл/i);
  });
  it("compares the actual chosen merge parent and rejects commits outside the viewed history", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "base\n");
    const base = await f.commit();
    await f.git(["checkout", "-b", "side"]);
    await f.write("side", "side\n");
    const side = await f.commit();
    await f.git(["checkout", "main"]);
    await f.write("main", "main\n");
    const main = await f.commit();
    await f.git(["merge", "--no-edit", "side"]);
    const oid = (await f.git(["rev-parse", "HEAD"])).trim();
    const first = await f.reader.commit(read(oid));
    const second = await f.reader.commit(read(oid, 1));
    expect(first.parent).toBe(main);
    expect(second.parent).toBe(side);
    expect(first.commit.parents).toEqual([main, side]);
    expect(first.files).not.toEqual(second.files);
    expect(first.files.map((x) => x.path)).toEqual(["side"]);
    expect(second.files.map((x) => x.path)).toEqual(["main"]);
    expect(
      (await f.reader.diff(diff(oid, "main", { parentIndex: 1 }))).part.text,
    ).toContain("+main");
    await expect(f.reader.diff(diff(oid, "main"))).rejects.toThrow(/файл/i);
    await expect(f.reader.commit(read(oid, 2))).rejects.toThrow(/родител/i);
    expect(
      (await f.reader.commit({ ...read(oid), commit: base })).parent,
    ).toBeNull();
    const tree = (await f.git(["rev-parse", "HEAD^{tree}"])).trim();
    const unrelated = (
      await f.git(["commit-tree", tree, "-m", "unrelated"])
    ).trim();
    await expect(
      f.reader.commit({ ...read(oid), commit: unrelated }),
    ).rejects.toThrow(/истори/i);
  });
  it("paginates files and distinguishes an empty commit from binary and oversized previews", async () => {
    const f = await historyFixture(cleanup);
    for (let i = 0; i < 202; i++)
      await f.write(`a-${String(i).padStart(3, "0")}`, "text\n");
    await f.write("binary", Buffer.from([0, 1, 2]));
    await f.write("large", "x".repeat(1024 * 1024 + 1));
    const oid = await f.commit();
    const first = await f.reader.commit(read(oid));
    expect(first.files).toHaveLength(200);
    expect(first.nextFileOffset).toBe(200);
    const second = await f.reader.commit({ ...read(oid), fileOffset: 200 });
    expect(second.files).toHaveLength(4);
    expect(second.nextFileOffset).toBeNull();
    expect((await f.reader.diff(diff(oid, "binary"))).part.kind).toBe("binary");
    expect((await f.reader.diff(diff(oid, "large"))).part.kind).toBe(
      "unavailable",
    );
    await f.git(["commit", "--allow-empty", "-m", "empty"]);
    const empty = (await f.git(["rev-parse", "HEAD"])).trim();
    expect((await f.reader.commit(read(empty))).files).toEqual([]);
    await expect(f.reader.diff(diff(empty, "binary"))).rejects.toThrow(/файл/i);
  });
  it("renders symlink and gitlink changes without opening targets or submodules", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "base\n");
    const base = await f.commit();
    await fs.symlink("/nonexistent/external", path.join(f.root, "link"));
    await f.git(["add", "link"]);
    await f.git([
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${base},module`,
    ]);
    await f.git(["commit", "-m", "special files"]);
    const oid = (await f.git(["rev-parse", "HEAD"])).trim();
    const details = await f.reader.commit(read(oid));
    expect(details.files.map((x) => x.path)).toEqual(["link", "module"]);
    expect((await f.reader.diff(diff(oid, "link"))).part.text).toContain(
      "+/nonexistent/external",
    );
    expect((await f.reader.diff(diff(oid, "module"))).part.text).toContain(
      `+Subproject commit ${base}`,
    );
  });
  it("treats a reused source as a modification plus addition, without mixing their patches", async () => {
    const f = await historyFixture(cleanup);
    await f.write("old", "original content\n");
    await f.commit();
    await f.git(["mv", "old", "new"]);
    await f.write("old", "UNRELATED replacement\n");
    const oid = await f.commit();
    const files = (await f.reader.commit(read(oid))).files;
    expect(files).toEqual(
      expect.arrayContaining([
        { path: "new", status: "A", additions: 1, deletions: 0 },
      ]),
    );
    const result = await f.reader.diff(diff(oid, "new"));
    expect(result.part.kind).toBe("patch");
    expect(result.part.text).toContain("+original content");
    expect(result.part.text).not.toContain("UNRELATED");
  });
  it("does not mistake a shallow boundary for a root commit", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "one\n");
    const parent = await f.commit();
    await f.write("a", "two\n");
    const oid = await f.commit();
    await fs.writeFile(path.join(f.root, ".git/shallow"), `${oid}\n`);
    await fs.unlink(
      path.join(f.root, ".git/objects", parent.slice(0, 2), parent.slice(2)),
    );
    expect(
      (await f.reader.page({ scope: "project", ref: "HEAD", offset: 0 }))
        .commits,
    ).toHaveLength(1);
    await expect(f.reader.commit(read(oid))).rejects.toThrow(
      /родител.*недоступ/i,
    );
  });
  it("never executes custom filters or diff drivers and leaves dirty/staged bytes untouched", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "old\n");
    await f.commit();
    await f.write("a", "new\n");
    const oid = await f.commit();
    const marker = path.join(f.dir, "MUST-NOT-EXIST");
    await f.write(".gitattributes", "a diff=hostile filter=hostile\n");
    for (const key of [
      "diff.external",
      "diff.hostile.command",
      "diff.hostile.textconv",
      "filter.hostile.clean",
      "filter.hostile.smudge",
      "core.fsmonitor",
    ])
      await f.git(["config", key, `touch '${marker}'`]);
    await f.write("a", "dirty\n");
    const names = [
      ".git/index",
      ".git/HEAD",
      ".git/refs/heads/main",
      "a",
      ".gitattributes",
    ];
    const before = await Promise.all(
      names.map((name) => fs.readFile(path.join(f.root, name))),
    );
    expect((await f.reader.diff(diff(oid, "a"))).part.text).toContain("+new");
    expect(
      await Promise.all(
        names.map((name) => fs.readFile(path.join(f.root, name))),
      ),
    ).toEqual(before);
    await expect(fs.stat(marker)).rejects.toThrow();
    await f.git(["update-ref", "refs/heads/main", `${oid}^`]);
    await expect(f.reader.commit(read(oid))).rejects.toThrow(/устарел/i);
  });
});
