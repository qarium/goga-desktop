import { nativeSequenceScope as fixtureScope } from "./helpers/native-sequence-regression";
import { gitIntegrationBudget } from "./helpers/git-integration";
import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { nativeSequenceFixture } from "./helpers/native-sequence-regression";
import type { Scenario } from "./helpers/git-operation-fixtures";
import type { NativeSequenceStart } from "../src/host/git-native-sequence";

const scenarios = [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
] as const;

for (const scenario of ["merge-rebase", "apply-rebase"] as const)
  it.each([
    { stops: [1] },
    { stops: [1, 3] },
    { stops: [1, 2, 4] },
    { stops: [4] },
  ])(
    `${scenario}: four native picks match control at every stop $stops`,
    fixtureScope.run(async ({ stops }) => {
      const f = await nativeSequenceFixture(scenario, 4, stops),
        control = await nativeSequenceFixture(scenario, 4, stops);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      await expect(
        control.git([
          "rebase",
          scenario === "apply-rebase" ? "--apply" : "--merge",
          control.onto,
        ]),
      ).rejects.toMatchObject({ exitCode: 1 });
      for (let i = 0; i < stops.length; i++) {
        await f.resolve();
        await control.resolve();
        expect(
          await f.engine.execute((await f.prepare("continue")).token),
        ).toMatchObject({
          outcome: i + 1 === stops.length ? "completed" : "conflicts",
        });
        if (i + 1 === stops.length) await control.git(["rebase", "--continue"]);
        else
          await expect(
            control.git(["rebase", "--continue"]),
          ).rejects.toMatchObject({ exitCode: 1 });
        expect(await f.git(["ls-files", "--stage", "-z"])).toBe(
          await control.git(["ls-files", "--stage", "-z"]),
        );
        expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
          await control.git(["rev-parse", "HEAD^{tree}"]),
        );
        expect(
          await f.git([
            "log",
            "--reverse",
            "--format=%an <%ae>%n%aI%n%B",
            `${f.onto}..HEAD`,
          ]),
        ).toBe(
          await control.git([
            "log",
            "--reverse",
            "--format=%an <%ae>%n%aI%n%B",
            `${control.onto}..HEAD`,
          ]),
        );
        expect(await f.read("ignored")).toBe("preserve ignored\n");
        expect(await f.read("untracked")).toBe("preserve untracked\n");
        if (i + 1 < stops.length) {
          expect(
            (
              await fs.stat(
                path.join(
                  f.root,
                  scenario === "apply-rebase"
                    ? ".git/rebase-apply"
                    : ".git/rebase-merge",
                ),
              )
            ).isDirectory(),
          ).toBe(true);
          await expect(
            fs.stat(
              path.join(
                f.root,
                scenario === "apply-rebase"
                  ? ".git/rebase-merge"
                  : ".git/rebase-apply",
              ),
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      }
      expect(
        (await f.git(["rev-list", "--count", `${f.onto}..HEAD`])).trim(),
      ).toBe("4");
      expect((await f.reader.snapshot()).operation).toBe("none");
    }),
    gitIntegrationBudget(30000),
  );

const literalNames = [
  "__proto__",
  "constructor",
  "toString",
  "2",
  "10",
  "-leading-option",
  ":(glob)*.txt",
  "line\nbreak",
  "имя",
  "nested/deeper/file",
];

async function literalFixture(scenario: Scenario) {
  const f = await nativeSequenceFixture(scenario, 1, [1]);
  await fs.mkdir(path.join(f.root, "nested/deeper"), { recursive: true });
  for (const name of literalNames) await f.write(name, "base literal\n");
  await f.git(["add", "--", ...literalNames]);
  await f.git(["commit", "-m", "literal base"]);
  const branch = (await f.git(["symbolic-ref", "--short", "HEAD"])).trim();
  await f.git(["checkout", "-b", "literal-source"]);
  for (const name of literalNames) await f.write(name, "incoming literal\n");
  await f.git(["commit", "-am", "literal source"]);
  const source = (await f.git(["rev-parse", "HEAD"])).trim();
  await f.git(["checkout", branch]);
  if (scenario === "revert")
    await f.git(["merge", "--ff-only", "literal-source"]);
  for (const name of literalNames) await f.write(name, "local literal\n");
  await f.git(["commit", "-am", "literal local"]);
  const onto = (await f.git(["rev-parse", "HEAD"])).trim();
  if (scenario.endsWith("rebase")) await f.git(["checkout", "literal-source"]);
  const original = (await f.git(["rev-parse", "HEAD"])).trim();
  const start: NativeSequenceStart = scenario.endsWith("rebase")
    ? {
        operation: "rebase",
        source: onto,
        backend: scenario === "apply-rebase" ? "apply" : "merge",
      }
    : { operation: scenario as "cherry-pick" | "revert", commits: [source] };
  return { f, start, original };
}

for (const scenario of scenarios)
  for (const action of ["continue", "abort"] as const)
    it(
      `${scenario}: ${action} preserves literal, prototype, numeric, Unicode and nested paths`,
      fixtureScope.run(async () => {
        const { f, start, original } = await literalFixture(scenario);
        const originalIndex = await f.git(["ls-files", "--stage", "-z"]);
        expect(await f.start(start)).toMatchObject({ outcome: "conflicts" });
        expect((await f.conflicts()).sort()).toEqual([...literalNames].sort());
        for (const name of literalNames)
          await f.write(name, "resolved literal\n");
        await f.git(["add", "--", ...literalNames]);
        expect(
          await f.engine.execute((await f.prepare(action)).token),
        ).toMatchObject({ outcome: "completed", recovery: "removed" });
        const expected =
          action === "continue"
            ? "resolved literal\n"
            : scenario.endsWith("rebase")
              ? "incoming literal\n"
              : "local literal\n";
        for (const name of literalNames)
          expect(await f.read(name)).toBe(expected);
        if (action === "abort") {
          expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(original);
          expect(await f.git(["ls-files", "--stage", "-z"])).toBe(
            originalIndex,
          );
        }
        expect(await f.read("untracked")).toBe("preserve untracked\n");
        expect(await f.read("ignored")).toBe("preserve ignored\n");
      }),
      gitIntegrationBudget(15000),
    );

it.each(["add", "delete", "mode", "binary"] as const)(
  "native rebase supports future %s through real Git instead of a private replay restriction",
  fixtureScope.run(async (kind) => {
    async function seed() {
      const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
      if (kind === "add") {
        await f.write("future.txt", "future data\n");
        await f.git(["add", "future.txt"]);
      }
      if (kind === "delete") await f.git(["rm", "untouched"]);
      if (kind === "mode") {
        await fs.chmod(path.join(f.root, "untouched"), 0o755);
        await f.git(["add", "untouched"]);
      }
      if (kind === "binary") {
        await fs.writeFile(
          path.join(f.root, "untouched"),
          Buffer.from([0, 255, 1, 0, 7]),
        );
        await f.git(["add", "untouched"]);
      }
      await f.git(["commit", "-m", `future ${kind}`]);
      return f;
    }
    const f = await seed(),
      control = await seed();
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await expect(
      control.git(["rebase", "--merge", control.onto]),
    ).rejects.toMatchObject({ exitCode: 1 });
    await f.resolve();
    await control.resolve();
    expect(
      await f.engine.execute((await f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed", recovery: "removed" });
    await control.git(["rebase", "--continue"]);
    expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await control.git(["rev-parse", "HEAD^{tree}"]),
    );
    expect(await f.git(["ls-files", "--stage", "-z"])).toBe(
      await control.git(["ls-files", "--stage", "-z"]),
    );
    expect(await f.read("untracked")).toBe("preserve untracked\n");
    expect(await f.read("ignored")).toBe("preserve ignored\n");
  }),
  gitIntegrationBudget(15000),
);

it(
  "native abort restores an original nested hierarchy without overwriting unrelated data",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    await fs.mkdir(path.join(f.root, "original/nested"), { recursive: true });
    await f.write("original/nested/value", "original content\n");
    await f.git(["add", "original/nested/value"]);
    await f.git(["commit", "-m", "common nested base"]);
    const branch = (await f.git(["symbolic-ref", "--short", "HEAD"])).trim();
    await f.git(["checkout", "-b", "nested-source"]);
    await f.write("file-1", "source conflict\n");
    await f.git(["commit", "-am", "source"]);
    const original = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git(["checkout", branch]);
    await f.git(["rm", "original/nested/value"]);
    await f.write("file-1", "upstream conflict\n");
    await f.git(["commit", "-am", "upstream removes nested"]);
    const source = (await f.git(["rev-parse", "HEAD"])).trim();
    await f.git(["checkout", "nested-source"]);
    expect(
      await f.start({ operation: "rebase", source, backend: "merge" }),
    ).toMatchObject({ outcome: "conflicts" });
    await expect(
      fs.stat(path.join(f.root, "original/nested/value")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await f.engine.execute((await f.prepare("abort")).token),
    ).toMatchObject({ outcome: "completed", recovery: "removed" });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(original);
    expect(await f.read("original/nested/value")).toBe("original content\n");
    expect(await f.read("untracked")).toBe("preserve untracked\n");
    expect(await f.read("ignored")).toBe("preserve ignored\n");
  }),
  gitIntegrationBudget(15000),
);

it(
  "native abort preserves the old inclusive one MiB and twenty-four-parent restoration boundary",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    const parent = Array.from({ length: 24 }, (_, i) => `d${i}`).join("/"),
      name = parent + "/file";
    await fs.mkdir(path.join(f.root, parent), { recursive: true });
    await f.write(name, "x".repeat(1024 * 1024));
    await f.git(["add", "--", name]);
    await f.git(["commit", "-m", "inclusive restoration boundary"]);
    const original = (await f.git(["rev-parse", "HEAD"])).trim();
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await expect(fs.stat(path.join(f.root, name))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await f.engine.execute((await f.prepare("abort")).token),
    ).toMatchObject({ outcome: "completed", recovery: "removed" });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(original);
    expect(await f.read(name)).toBe("x".repeat(1024 * 1024));
    expect(await f.read("untracked")).toBe("preserve untracked\n");
  }),
  gitIntegrationBudget(15000),
);
