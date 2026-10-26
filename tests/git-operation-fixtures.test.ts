import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  createOperationFixture,
  type OperationFixture,
  type Scenario,
} from "./helpers/git-operation-fixtures";
import { CommandExitError } from "../src/host/process";
import { readRebaseBinding } from "../src/host/git-rebase-read-binding";

const fixtures: OperationFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.dispose();
});
const create = async (s: Scenario, commits: number, conflictAt: number[]) => {
  const f = await createOperationFixture(s, { commits, conflictAt });
  fixtures.push(f);
  return f;
};
const scenarios: Scenario[] = [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
];
async function finish(f: OperationFixture) {
  const stops: string[][] = [];
  for (let step = 0; step <= f.sources.length; step++) {
    const names = await f.resolve();
    expect(names.length).toBeGreaterThan(0);
    stops.push(names);
    try {
      await f.git([f.command, "--continue"]);
      return stops;
    } catch (e) {
      expect(e).toBeInstanceOf(CommandExitError);
      expect((e as CommandExitError).exitCode).toBe(1);
      expect((await f.conflicts()).length).toBeGreaterThan(0);
    }
  }
  throw Error("Native operation did not settle within its sequence");
}
async function assertClean(f: OperationFixture) {
  expect(await f.git(["diff", "HEAD", "--"])).toBe("");
  expect(await f.git(["diff", "--cached"])).toBe("");
  expect(await f.read("ignored")).toBe("preserve ignored\n");
  expect(await f.read("untracked")).toBe("preserve untracked\n");
  const names = await fs.readdir(path.join(f.root, ".git"));
  for (const name of [
    "rebase-merge",
    "rebase-apply",
    "sequencer",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
  ])
    expect(names).not.toContain(name);
  expect((await f.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(
    f.branch,
  );
}
for (const scenario of scenarios) {
  it.each([1, scenario.endsWith("rebase") ? 4 : 3])(
    `${scenario}: native continuation preserves sequence, tree and messages (%i commits)`,
    async (commits) => {
      const conflictAt = commits === 1 ? [1] : [1, 3];
      const f = await create(scenario, commits, conflictAt);
      const control = await create(scenario, commits, conflictAt);
      const stops = await finish(f);
      expect(stops).toHaveLength(conflictAt.length);
      expect(await finish(control)).toEqual(stops);
      await assertClean(f);
      expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
        await control.git(["rev-parse", "HEAD^{tree}"]),
      );
      const fields = [
        "log",
        `-${commits}`,
        "--reverse",
        "--format=%H%n%P%n%an <%ae>%n%aI%n%B",
      ];
      expect(await f.git(fields)).toBe(await control.git(fields));
      expect(
        (await f.git(["rev-list", "--count", `${f.onto}..HEAD`])).trim(),
      ).toBe(String(commits));
      const actual = (await f.git(["rev-list", "--reverse", `${f.onto}..HEAD`]))
        .trim()
        .split("\n");
      for (let i = 0; i < actual.length; i++) {
        const message = await f.git(["show", "-s", "--format=%B", actual[i]]);
        if (scenario === "revert")
          expect(message).toContain(`This reverts commit ${f.sources[i]}.`);
        else
          expect(
            await f.git([
              "show",
              "-s",
              "--format=%an <%ae>%n%aI%n%B",
              actual[i],
            ]),
          ).toBe(
            await f.git([
              "show",
              "-s",
              "--format=%an <%ae>%n%aI%n%B",
              f.sources[i],
            ]),
          );
      }
    },
  );
  it.each([false, true])(
    `${scenario}: native abort after manual resolution (staged=%s) restores original and preserves unrelated files`,
    async (staged) => {
      const f = await create(scenario, 3, [1, 3]);
      if (staged) await f.resolve();
      else
        for (const n of await f.conflicts())
          await f.write(n, "manual resolution\n");
      await f.git([f.command, "--abort"]);
      expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
      await assertClean(f);
    },
  );
}
it.each(["merge-rebase", "apply-rebase"] as const)(
  "%s metadata proves owner and backend; apply cannot be confused with am",
  async (s) => {
    const f = await create(s, 4, [1, 3]);
    const owner = {
      path: f.root,
      gitCommonDir: path.join(f.root, ".git"),
      branch: f.branch,
    };
    expect(await readRebaseBinding(owner, f.git)).toMatch(/^[a-f0-9]{64}$/);
    const folder =
      s === "merge-rebase" ? ".git/rebase-merge" : ".git/rebase-apply";
    expect((await f.read(`${folder}/orig-head`)).trim()).toBe(f.original);
    expect((await f.read(`${folder}/onto`)).trim()).toBe(f.onto);
    if (s === "apply-rebase") {
      expect(await f.read(`${folder}/rebasing`)).toBe("");
      await f.write(`${folder}/applying`, "");
      await expect(readRebaseBinding(owner, f.git)).rejects.toThrow();
    }
  },
);
it.each(["cherry-pick", "revert"] as const)(
  "%s captures sequencer baseline, ordered todo and stopped source without trusting ORIG_HEAD",
  async (s) => {
    const f = await create(s, 3, [1, 3]);
    expect((await f.read(".git/sequencer/head")).trim()).toBe(f.original);
    expect((await f.read(".git/sequencer/abort-safety")).trim()).toBe(
      f.original,
    );
    const todo = await f.read(".git/sequencer/todo");
    expect(todo.trim().split("\n")).toHaveLength(3);
    expect(todo).toMatch(new RegExp(`^${s === "revert" ? "revert" : "pick"} `));
    expect(
      (
        await f.read(
          s === "revert" ? ".git/REVERT_HEAD" : ".git/CHERRY_PICK_HEAD",
        )
      ).trim(),
    ).toBe(f.sources[0]);
  },
);
it.each(scenarios)(
  "%s: private metadata continuation matches native control without publishing live index/ref/operation",
  async (s) => {
    const f = await create(s, 3, [1, 3]);
    const control = await create(s, 3, [1, 3]);
    await f.resolve();
    await control.resolve();
    const native = path.join(f.home, "native");
    // Test-only proof of the existing metadata-only strategy, not a user clone.
    await fs.cp(path.join(f.root, ".git"), native, {
      recursive: true,
      filter: (p) => p !== path.join(f.root, ".git/objects"),
    });
    await fs.mkdir(path.join(native, "objects/info"), { recursive: true });
    await fs.writeFile(
      path.join(native, "objects/info/alternates"),
      path.join(f.root, ".git/objects") + "\n",
    );
    const ngit = (args: string[]) =>
      f.git([`--git-dir=${native}`, `--work-tree=${f.root}`, ...args]);
    const before = {
      index: await fs.readFile(path.join(f.root, ".git/index")),
      head: await f.read(".git/HEAD"),
      refs: await f.git(["show-ref"]),
      marker: await f.read(
        `.git/${s.endsWith("rebase") ? "REBASE_HEAD" : s === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD"}`,
      ),
    };
    for (const git of [ngit, control.git])
      await expect(git([f.command, "--continue"])).rejects.toMatchObject({
        exitCode: 1,
      });
    expect(await ngit(["rev-parse", "HEAD"])).toBe(
      await control.git(["rev-parse", "HEAD"]),
    );
    expect(await ngit(["ls-files", "--stage", "-z"])).toBe(
      await control.git(["ls-files", "--stage", "-z"]),
    );
    for (let i = 1; i <= 3; i++)
      expect(await f.read(`file-${i}`)).toBe(await control.read(`file-${i}`));
    expect(await fs.readFile(path.join(f.root, ".git/index"))).toEqual(
      before.index,
    );
    expect(await f.read(".git/HEAD")).toBe(before.head);
    expect(await f.git(["show-ref"])).toBe(before.refs);
    expect(
      await f.read(
        `.git/${s.endsWith("rebase") ? "REBASE_HEAD" : s === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD"}`,
      ),
    ).toBe(before.marker);
    // Resolve only the private index's next conflict, then finish and check the
    // candidate tree; source publication remains a separate CAS in production.
    const names = (await ngit(["diff", "--name-only", "--diff-filter=U", "-z"]))
      .split("\0")
      .filter(Boolean);
    for (const name of names) await f.write(name, `resolved ${name}\n`);
    await ngit(["add", "--", ...names]);
    await ngit([f.command, "--continue"]);
    await finish(control);
    expect(await ngit(["rev-parse", "HEAD^{tree}"])).toBe(
      await control.git(["rev-parse", "HEAD^{tree}"]),
    );
  },
);
it.each(["cherry-pick", "revert"] as const)(
  "%s single-commit abort has no sequencer: original attached HEAD is the baseline",
  async (s) => {
    const f = await create(s, 1, [1]);
    expect(await fs.readdir(path.join(f.root, ".git"))).not.toContain(
      "sequencer",
    );
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    await f.resolve();
    await f.git([s, "--abort"]);
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
  },
);
