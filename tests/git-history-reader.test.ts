import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { historyFixture } from "./helpers/git-history-fixture";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});
const request = { scope: "project", ref: "HEAD", offset: 0 };

describe("read-only commit history", () => {
  it("reads unborn HEAD without treating a missing named branch as empty", async () => {
    const f = await historyFixture(cleanup);
    expect(await f.reader.refs()).toEqual({
      scope: "project",
      currentBranch: "main",
      local: [],
      remote: [],
    });
    expect(await f.reader.page(request)).toEqual({
      scope: "project",
      ref: "HEAD",
      currentBranch: "main",
      tip: null,
      commits: [],
      nextOffset: null,
    });
    await expect(
      f.reader.page({ ...request, ref: "refs/heads/missing" }),
    ).rejects.toThrow();
  });
  it("reads UTC Z dates in both the list and commit details", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "utc\n");
    await f.commit("UTC commit");
    const tree = (await f.git(["rev-parse", "HEAD^{tree}"])).trim();
    const object = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nUTC commit\n`;
    const oid = (
      await f.runner.command(
        "git",
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        f.root,
        { HOME: f.home },
        object,
      )
    ).stdout.trim();
    await f.git(["update-ref", "refs/heads/main", oid]);
    const page = await f.reader.page(request);
    expect(page.commits[0].authoredAt).toBe("2023-11-14T22:13:20Z");
    const details = await f.reader.commit({
      scope: request.scope,
      ref: request.ref,
      tip: oid,
      commit: oid,
      parentIndex: 0,
      fileOffset: 0,
    });
    expect(details.commit.committedAt).toBe("2023-11-14T22:13:20Z");
    expect(details.files[0].path).toBe("a");
  });
  it("separates local and remote refs, excludes symbolic aliases and internal refs", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "a\n");
    const oid = await f.commit();
    await f.git(["branch", "feature/задача"]);
    await f.git(["update-ref", "refs/remotes/origin/main", oid]);
    await f.git([
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
    await f.git(["update-ref", "refs/goga/private", oid]);
    await f.git(["tag", "v1"]);
    const refs = await f.reader.refs();
    expect(refs.local).toEqual([
      { ref: "refs/heads/feature/задача", name: "feature/задача" },
      { ref: "refs/heads/main", name: "main" },
    ]);
    expect(refs.remote).toEqual([
      { ref: "refs/remotes/origin/main", name: "origin/main" },
    ]);
    const page = await f.reader.page({
      ...request,
      ref: "refs/remotes/origin/main",
    });
    expect(page.commits[0].refs).toEqual([
      "refs/heads/feature/задача",
      "refs/heads/main",
      "refs/remotes/origin/main",
    ]);
    await expect(
      f.reader.page({ ...request, ref: "refs/remotes/origin/HEAD" }),
    ).rejects.toThrow();
  });
  it.each(["sha1", "sha256"] as const)(
    "preserves Unicode metadata and detached HEAD for %s",
    async (format) => {
      const f = await historyFixture(cleanup, format);
      await f.write("a", "a\n");
      const first = await f.commit("Начало\n\nПодробное описание");
      await f.write("a", "b\n");
      const second = await f.commit("Следующий\tшаг");
      await f.git(["checkout", "--detach"]);
      const page = await f.reader.page(request);
      expect(page.tip).toBe(second);
      expect(page.commits.map((c) => c.oid)).toEqual([second, first]);
      expect(page.commits[0]).toMatchObject({
        author: "Автор",
        subject: "Следующий\tшаг",
        parents: [first],
      });
      expect(page.commits[0].authoredAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(page.commits[1]).toMatchObject({ subject: "Начало", parents: [] });
      expect((await f.reader.refs()).currentBranch).toBeNull();
      expect(page.nextOffset).toBeNull();
    },
  );
  it("pages a pinned topology without counts, file status or diff, and rejects a moved tip", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "a\n");
    let oid = await f.commit();
    const tree = (await f.git(["rev-parse", "HEAD^{tree}"])).trim();
    for (let i = 0; i < 54; i++)
      oid = (
        await f.git(["commit-tree", tree, "-p", oid, "-m", `step ${i}`])
      ).trim();
    await f.git(["update-ref", "refs/heads/main", oid]);
    f.calls.length = 0;
    const first = await f.reader.page(request);
    expect(first.commits).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    const second = await f.reader.page({
      ...request,
      tip: first.tip!,
      offset: first.nextOffset!,
    });
    expect(second.commits).toHaveLength(5);
    expect(second.nextOffset).toBeNull();
    expect(
      new Set([...first.commits, ...second.commits].map((c) => c.oid)).size,
    ).toBe(55);
    expect(
      f.calls.some((args) =>
        args.some((s) =>
          ["status", "diff", "diff-tree", "--count", "board"].includes(s),
        ),
      ),
    ).toBe(false);
    const log = f.calls.find((args) => args.includes("log"))!;
    expect(log).toContain("--max-count=51");
    expect(log).toContain("--topo-order");
    await f.git(["update-ref", "refs/heads/main", first.commits[1].oid]);
    await expect(
      f.reader.page({ ...request, tip: first.tip!, offset: 50 }),
    ).rejects.toThrow(/устарел/i);
  });
  it("includes both sides of a merge in topological order", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "a\n");
    const base = await f.commit("base");
    await f.git(["checkout", "-b", "side"]);
    await f.write("side", "side\n");
    const side = await f.commit("side");
    await f.git(["checkout", "main"]);
    await f.write("main", "main\n");
    const main = await f.commit("main");
    await f.git(["merge", "--no-edit", "side"]);
    const page = await f.reader.page(request);
    expect(page.commits).toHaveLength(4);
    expect(page.commits[0].parents).toEqual([main, side]);
    expect(page.commits[3].oid).toBe(base);
  });
  it("keeps HEAD, index, refs and dirty files intact; rejects another scope and unsafe metadata", async () => {
    const f = await historyFixture(cleanup);
    await f.write("a", "base\n");
    await f.commit();
    await f.write("a", "dirty\n");
    const before = await Promise.all(
      [".git/HEAD", ".git/index", ".git/refs/heads/main", "a"].map((name) =>
        fs.readFile(path.join(f.root, name)),
      ),
    );
    await f.reader.page(request);
    await f.reader.refs();
    const after = await Promise.all(
      [".git/HEAD", ".git/index", ".git/refs/heads/main", "a"].map((name) =>
        fs.readFile(path.join(f.root, name)),
      ),
    );
    expect(after).toEqual(before);
    expect(f.verify).toHaveBeenCalled();
    f.calls.length = 0;
    await expect(
      f.reader.page({ ...request, scope: "another" }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
    await fs.symlink(f.dir, path.join(f.root, ".git/objects/unsafe"));
    await expect(f.reader.page(request)).rejects.toThrow(/ссылка/i);
  });
});
