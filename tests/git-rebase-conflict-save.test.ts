import { randomUUID } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { gitIntegrationBudget } from "./helpers/git-integration";
import {
  fixture,
  fixtureScope,
  request,
  stable,
  tree,
} from "./helpers/rebase-conflict-save-fixture";
it.each(["merge", "apply"] as const)(
  "saves one conflict during a native multi-commit %s rebase without advancing the operation",
  fixtureScope.run(async (backend) => {
    const f = await fixture(backend, 1);
    await writeFile(path.join(f.record.path, "other.txt"), "staged other\n");
    await f.git(f.record.path, ["add", "--", "other.txt"]);
    await writeFile(path.join(f.record.path, "other.txt"), "working other\n");
    await writeFile(path.join(f.record.path, "untracked.txt"), "untracked\n");
    const untouched = await stable(f),
      before = await tree(f.record.path);
    const unrelatedIndex = await f.git(f.record.path, [
      "ls-files",
      "--stage",
      "-z",
      "--",
      "second.txt",
      "other.txt",
    ]);
    const unrelatedWork = await tree(path.join(f.record.path, "second.txt"));
    const start = Date.now();
    const call = vi.spyOn(f.runner, "command");
    const req = await request(f);
    console.info(
      `M5D4 read ${Date.now() - start} ms, ${call.mock.calls.length} calls`,
    );
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "text", text: "resolved\n" },
    });
    expect(await tree(f.record.path)).toBe(before);
    expect(await stable(f)).toBe(untouched);
    console.info(
      `M5D4 prepared ${Date.now() - start} ms, ${call.mock.calls.length} calls`,
    );
    const result = await f.host.executeGitConflictSave(preview.token);
    console.info(
      `M5D4 executed ${Date.now() - start} ms, ${call.mock.calls.length} calls`,
    );
    expect(result).toMatchObject({
      status: "saved",
      worktreePublished: true,
      indexPublished: true,
    });
    expect(await readFile(path.join(f.record.path, "file.txt"), "utf8")).toBe(
      "resolved\n",
    );
    expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
      "resolved\n",
    );
    expect(
      await f.git(f.record.path, ["ls-files", "--unmerged", "--", "file.txt"]),
    ).toBe("");
    expect(await f.git(f.record.path, ["show", ":other.txt"])).toBe(
      "staged other\n",
    );
    expect(await readFile(path.join(f.record.path, "other.txt"), "utf8")).toBe(
      "working other\n",
    );
    expect(
      await readFile(path.join(f.record.path, "untracked.txt"), "utf8"),
    ).toBe("untracked\n");
    expect(await stable(f)).toBe(untouched);
    expect(
      await f.git(f.record.path, [
        "ls-files",
        "--stage",
        "-z",
        "--",
        "second.txt",
        "other.txt",
      ]),
    ).toBe(unrelatedIndex);
    expect(await tree(path.join(f.record.path, "second.txt"))).toBe(
      unrelatedWork,
    );
    for (const [exe, args] of call.mock.calls) {
      expect(exe).toBe("git");
      expect(
        args.some((arg) =>
          [
            "commit",
            "checkout",
            "rebase",
            "fetch",
            "push",
            "reset",
            "stash",
          ].includes(arg),
        ),
      ).toBe(false);
    }
    expect(
      await f.git(f.record.path, [
        "ls-files",
        "--unmerged",
        "--",
        "second.txt",
      ]),
    ).not.toBe("");
    await expect(
      f.host.executeGitConflictSave(preview.token),
    ).rejects.toThrow();
    await writeFile(
      `/private/tmp/goga-m5d4-metrics-${backend}.json`,
      JSON.stringify({
        backend,
        elapsedMs: Date.now() - start,
        calls: call.mock.calls.length,
      }),
    );
  }),
  gitIntegrationBudget(45000),
);

describe.each(["merge", "apply"] as const)("next conflict in %s", (backend) => {
  let f: Awaited<ReturnType<typeof fixture>>,
    req: Awaited<ReturnType<typeof request>>;
  beforeEach(
    fixtureScope.run(async () => {
      f = await fixture(backend, 1);
      req = await request(f);
    }),
    gitIntegrationBudget(30000),
  );
  beforeEach(
    fixtureScope.run(async () => {
      const preview = await f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "current" },
      });
      expect((await f.host.executeGitConflictSave(preview.token)).status).toBe(
        "saved",
      );
    }),
    gitIntegrationBudget(30000),
  );
  it(
    "keeps the operation pending and the next unresolved file readable and preparable",
    fixtureScope.run(async () => {
      expect((await f.host.readGitWorkspace(f.scope)).operation).toBe("rebase");
      const req = await request(f, "second.txt"),
        before = await tree(f.record.path);
      expect(
        (
          await f.host.prepareGitConflictSave({
            ...req,
            resolution: { kind: "incoming" },
          })
        ).path,
      ).toBe("second.txt");
      expect(await tree(f.record.path)).toBe(before);
      expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
        "upstream\n",
      );
    }),
    gitIntegrationBudget(45000),
  );
});

it.each(["current", "incoming", "delete", "crlf"] as const)(
  "supports explicit %s resolution without completing rebase",
  fixtureScope.run(async (kind) => {
    const f = await fixture("merge", 1);
    if (kind === "crlf")
      await f.git(f.record.path, ["config", "core.autocrlf", "true"]);
    const req = await request(f),
      unchanged = await stable(f);
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution:
        kind === "crlf" ? { kind: "text", text: "resolved\r\n" } : { kind },
    });
    expect((await f.host.executeGitConflictSave(preview.token)).status).toBe(
      "saved",
    );
    if (kind === "delete") {
      await expect(
        lstat(path.join(f.record.path, "file.txt")),
      ).rejects.toThrow();
      expect(await f.git(f.record.path, ["ls-files", "--", "file.txt"])).toBe(
        "",
      );
    } else {
      const work =
        kind === "current"
          ? "upstream\n"
          : kind === "incoming"
            ? "topic\n"
            : "resolved\r\n";
      expect(await readFile(path.join(f.record.path, "file.txt"), "utf8")).toBe(
        work,
      );
      expect(await f.git(f.record.path, ["show", ":file.txt"])).toBe(
        work.replaceAll("\r\n", "\n"),
      );
    }
    expect(await stable(f)).toBe(unchanged);
  }),
  gitIntegrationBudget(45000),
);

it(
  "rejects every forged owner dimension and revision without a primary fallback",
  fixtureScope.run(async () => {
    const f = await fixture(),
      req = await request(f);
    const before = await tree(f.record.path),
      primary = await tree(f.root);
    for (const change of [
      { projectId: "other-project" },
      { year: "2025" },
      { topic: "other" },
      { branch: "other" },
      { contextId: "ctx-other" },
      { revision: randomUUID() },
    ])
      await expect(
        f.host.prepareGitConflictSave({
          ...req,
          scope: { ...f.scope, ...change },
          resolution: { kind: "current" },
        }),
      ).rejects.toThrow();
    expect(await tree(f.record.path)).toBe(before);
    expect(await tree(f.root)).toBe(primary);
  }),
  gitIntegrationBudget(45000),
);

it(
  "requires explicit deletion instead of silently selecting an absent current side",
  fixtureScope.run(async () => {
    const f = await fixture();
    const stages = await f.git(f.record.path, [
      "ls-files",
      "--unmerged",
      "--stage",
      "-z",
      "--",
      "file.txt",
    ]);
    const retained =
      stages
        .split("\0")
        .filter((row) => row && !row.includes(" 2\t"))
        .join("\0") + "\0";
    await f.git(
      f.record.path,
      ["update-index", "-z", "--index-info"],
      `0 ${"0".repeat(40)}\tfile.txt\0${retained}`,
    );
    const req = await request(f),
      before = await tree(f.record.path);
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "current" },
      }),
    ).rejects.toThrow(/отсутствует/);
    expect(await tree(f.record.path)).toBe(before);
    const preview = await f.host.prepareGitConflictSave({
      ...req,
      resolution: { kind: "delete" },
    });
    expect((await f.host.executeGitConflictSave(preview.token)).status).toBe(
      "saved",
    );
    expect(await f.git(f.record.path, ["ls-files", "--", "file.txt"])).toBe("");
  }),
  gitIntegrationBudget(45000),
);

it.each(["symlink stage", "binary stage"])(
  "refuses unsupported %s even for explicit deletion",
  fixtureScope.run(async (kind) => {
    const f = await fixture();
    const original = (
      await f.git(f.record.path, [
        "ls-files",
        "--unmerged",
        "--stage",
        "-z",
        "--",
        "file.txt",
      ])
    )
      .split("\0")
      .filter(Boolean);
    const blob = (
      await f.git(
        f.record.path,
        ["hash-object", "-w", "--stdin"],
        kind === "binary stage" ? "binary\0data" : "target",
      )
    ).trim();
    const stages =
      original
        .map((row) =>
          row.includes(" 2\t")
            ? `${kind === "symlink stage" ? "120000" : "100644"} ${blob} 2\tfile.txt`
            : row,
        )
        .join("\0") + "\0";
    await f.git(
      f.record.path,
      ["update-index", "-z", "--index-info"],
      `0 ${"0".repeat(40)}\tfile.txt\0${stages}`,
    );
    const req = await request(f),
      before = await tree(f.record.path);
    await expect(
      f.host.prepareGitConflictSave({
        ...req,
        resolution: { kind: "delete" },
      }),
    ).rejects.toThrow(/symlink|binary/);
    expect(await tree(f.record.path)).toBe(before);
  }),
  gitIntegrationBudget(45000),
);
