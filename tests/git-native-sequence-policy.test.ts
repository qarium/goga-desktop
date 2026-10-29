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

async function multiline(
  scenario: Scenario,
  nested: boolean,
  fallback: boolean,
) {
  const f = await nativeSequenceFixture(scenario, 1, [1]);
  const name = nested ? "nested/sequence.txt" : "sequence.txt";
  if (nested) await fs.mkdir(path.join(f.root, "nested"));
  const lines = Array.from({ length: 180 }, (_, i) => `line ${i}`);
  await f.write(name, lines.join("\n") + "\n");
  await f.git(["add", "--", name]);
  await f.git(["commit", "-m", "multiline base"]);
  const baseBranch = (await f.git(["symbolic-ref", "--short", "HEAD"])).trim();
  await f.git(["checkout", "-b", "multiline-source"]);
  await f.git(["config", "user.name", "Original Author"]);
  await f.git(["config", "user.email", "original@example.invalid"]);
  const sources: string[] = [];
  for (const i of [5, 70, 140]) {
    lines[i] = `incoming ${i}`;
    await f.write(name, lines.join("\n") + "\n");
    await f.git(["commit", "-am", `subject ${i}\n\nbody ${i}`]);
    sources.push((await f.git(["rev-parse", "HEAD"])).trim());
  }
  await f.git(["checkout", baseBranch]);
  if (scenario === "revert")
    await f.git(["merge", "--ff-only", "multiline-source"]);
  else for (const i of [5, 70, 140]) lines[i] = `line ${i}`;
  const conflict = scenario === "revert" ? 140 : 5;
  lines[conflict] = "local";
  if (fallback) lines[68] = "upstream adjacent context";
  lines[179] = "preserved upstream tail";
  await f.write(name, lines.join("\n") + "\n");
  await f.git(["commit", "-am", "upstream local"]);
  const onto = (await f.git(["rev-parse", "HEAD"])).trim();
  if (scenario.endsWith("rebase"))
    await f.git(["checkout", "multiline-source"]);
  await f.git(["config", "user.name", "Current Committer"]);
  await f.git(["config", "user.email", "committer@example.invalid"]);
  const start: NativeSequenceStart = scenario.endsWith("rebase")
    ? {
        operation: "rebase",
        source: onto,
        backend: scenario === "apply-rebase" ? "apply" : "merge",
      }
    : {
        operation: scenario as "cherry-pick" | "revert",
        commits: scenario === "revert" ? [...sources].reverse() : sources,
      };
  const rawStart =
    start.operation === "rebase"
      ? ["rebase", `--${start.backend}`, start.source]
      : [start.operation, ...("commits" in start ? start.commits : [])];
  lines[conflict] = "resolved";
  const resolve = async () => {
    await f.write(name, lines.join("\n") + "\n");
    await f.git(["add", "--", name]);
  };
  return { f, name, start, rawStart, resolve };
}

for (const scenario of scenarios)
  for (const variant of scenario === "apply-rebase"
    ? [
        { nested: false, fallback: false },
        { nested: false, fallback: true },
        { nested: true, fallback: true },
      ]
    : [{ nested: false, fallback: false }])
    it(
      `${scenario}: repeated multiline picks preserve resolution, author, message and current committer (nested=${variant.nested}, fallback=${variant.fallback})`,
      fixtureScope.run(async () => {
        const a = await multiline(scenario, variant.nested, variant.fallback);
        const b = await multiline(scenario, variant.nested, variant.fallback);
        expect(await a.f.start(a.start)).toMatchObject({
          outcome: "conflicts",
        });
        await expect(b.f.git(b.rawStart)).rejects.toMatchObject({
          exitCode: 1,
        });
        await a.resolve();
        await b.resolve();
        const preview = await a.f.prepare("continue");
        expect(await a.f.engine.execute(preview.token)).toMatchObject({
          outcome: "completed",
          recovery: "removed",
        });
        await b.f.git([b.f.command, "--continue"]);
        expect(await a.f.read(a.name)).toBe(await b.f.read(b.name));
        expect(await a.f.git(["rev-parse", "HEAD^{tree}"])).toBe(
          await b.f.git(["rev-parse", "HEAD^{tree}"]),
        );
        const fields = [
          "log",
          "-3",
          "--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%B%x00",
        ];
        expect(await a.f.git(fields)).toBe(await b.f.git(fields));
        expect(
          (await a.f.git(["log", "-3", "--format=%cn <%ce>"]))
            .trim()
            .split("\n"),
        ).toEqual(
          Array(3).fill("Current Committer <committer@example.invalid>"),
        );
        expect(await a.f.read(a.name)).toContain("resolved\n");
        expect(await a.f.read(a.name)).toContain("preserved upstream tail\n");
        expect(await a.f.read("untracked")).toBe("preserve untracked\n");
        expect(await a.f.read("ignored")).toBe("preserve ignored\n");
      }),
      gitIntegrationBudget(15000),
    );

it.each([
  ["apply.whitespace", "fix"],
  ["core.quotepath", "false"],
  ["am.threeway", "true"],
])(
  "initial apply policy %s is forwarded intact and matches real native continuation",
  fixtureScope.run(async (key, value) => {
    const a = await multiline("apply-rebase", true, true),
      b = await multiline("apply-rebase", true, true);
    await a.f.git(["config", key, value]);
    await b.f.git(["config", key, value]);
    expect(await a.f.start(a.start)).toMatchObject({ outcome: "conflicts" });
    await expect(b.f.git(b.rawStart)).rejects.toMatchObject({ exitCode: 1 });
    await a.resolve();
    await b.resolve();
    expect(
      await a.f.engine.execute((await a.f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed" });
    await b.f.git(["rebase", "--continue"]);
    expect(await a.f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await b.f.git(["rev-parse", "HEAD^{tree}"]),
    );
    expect(await a.f.git(["log", "-3", "--format=%B"])).toBe(
      await b.f.git(["log", "-3", "--format=%B"]),
    );
    expect(
      a.f.calls.every((args) => args.includes(`${key.toLowerCase()}=${value}`)),
    ).toBe(true);
  }),
  gitIntegrationBudget(15000),
);

it(
  "initial inherited apply policy is captured rather than silently dropped by native child isolation",
  fixtureScope.run(async () => {
    const a = await multiline("apply-rebase", false, true),
      b = await multiline("apply-rebase", false, true);
    const config = path.join(a.f.home, "global-config");
    await fs.writeFile(config, "[apply]\nwhitespace = fix\n");
    a.f.env.GIT_CONFIG_GLOBAL = config;
    await b.f.git(["config", "apply.whitespace", "fix"]);
    expect(await a.f.start(a.start)).toMatchObject({ outcome: "conflicts" });
    await expect(b.f.git(b.rawStart)).rejects.toMatchObject({ exitCode: 1 });
    await a.resolve();
    await b.resolve();
    expect(
      await a.f.engine.execute((await a.f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed" });
    await b.f.git(["rebase", "--continue"]);
    expect(await a.f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await b.f.git(["rev-parse", "HEAD^{tree}"]),
    );
    expect(
      a.f.calls.every((args) => args.includes("apply.whitespace=fix")),
    ).toBe(true);
  }),
  gitIntegrationBudget(15000),
);

it(
  "initial revert.reference preserves the configured native message rather than replacing it",
  fixtureScope.run(async () => {
    const a = await multiline("revert", false, false),
      b = await multiline("revert", false, false);
    await a.f.git(["config", "revert.reference", "true"]);
    await b.f.git(["config", "revert.reference", "true"]);
    expect(await a.f.start(a.start)).toMatchObject({ outcome: "conflicts" });
    await expect(b.f.git(b.rawStart)).rejects.toMatchObject({ exitCode: 1 });
    await a.resolve();
    await b.resolve();
    expect(
      await a.f.engine.execute((await a.f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed" });
    await b.f.git(["revert", "--continue"]);
    expect(await a.f.git(["log", "-3", "--format=%B"])).toBe(
      await b.f.git(["log", "-3", "--format=%B"]),
    );
    expect(await a.f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await b.f.git(["rev-parse", "HEAD^{tree}"]),
    );
    expect(
      a.f.calls.every((args) => args.includes("revert.reference=true")),
    ).toBe(true);
  }),
  gitIntegrationBudget(15000),
);

it(
  "empty remaining apply follows native Git tree and commit count, preserves drop diagnostics and never invokes skip",
  fixtureScope.run(async () => {
    const a = await multiline("apply-rebase", false, false),
      b = await multiline("apply-rebase", false, false);
    expect(await a.f.start(a.start)).toMatchObject({ outcome: "conflicts" });
    await expect(b.f.git(b.rawStart)).rejects.toMatchObject({ exitCode: 1 });
    await a.resolve();
    await b.resolve();
    for (const x of [a, b]) {
      const lines = (await x.f.read(x.name)).split("\n");
      lines[70] = "incoming 70";
      lines[140] = "incoming 140";
      await x.f.write(x.name, lines.join("\n"));
      await x.f.git(["add", "--", x.name]);
    }
    const result = await a.f.engine.execute(
      (await a.f.prepare("continue")).token,
    );
    const nativeLog = await b.f.git(["rebase", "--continue"]);
    expect(result).toMatchObject({ outcome: "completed", recovery: "removed" });
    expect(await a.f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await b.f.git(["rev-parse", "HEAD^{tree}"]),
    );
    expect(
      await a.f.git([
        "rev-list",
        "--count",
        `${"source" in a.start ? a.start.source : ""}..HEAD`,
      ]),
    ).toBe(
      await b.f.git([
        "rev-list",
        "--count",
        `${"source" in b.start ? b.start.source : ""}..HEAD`,
      ]),
    );
    expect(nativeLog).toMatch(/already applied|No changes|Patch is empty/i);
    expect(result.log).toMatch(/already applied|No changes|Patch is empty/i);
    expect(a.f.calls.some((args) => args.includes("--skip"))).toBe(false);
    expect(
      a.f.calls.filter((args) => args.includes("--continue")),
    ).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it.each(["diff.external", "format.signaturefile"])(
  "initial apply %s does not execute a configured file and preserves native replay semantics",
  fixtureScope.run(async (key) => {
    const a = await multiline("apply-rebase", false, false),
      b = await multiline("apply-rebase", false, false);
    const marker = path.join(a.f.home, "helper-ran"),
      configured = path.join(a.f.home, "configured-file");
    await fs.writeFile(
      configured,
      `#!/bin/sh\nprintf unsafe > '${marker}'\nexit 1\n`,
      { mode: 0o700 },
    );
    await a.f.git(["config", key, configured]);
    await b.f.git(["config", key, configured]);
    expect(await a.f.start(a.start)).toMatchObject({ outcome: "conflicts" });
    await expect(b.f.git(b.rawStart)).rejects.toMatchObject({ exitCode: 1 });
    await a.resolve();
    await b.resolve();
    expect(
      await a.f.engine.execute((await a.f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed" });
    await b.f.git(["rebase", "--continue"]);
    expect(await a.f.git(["rev-parse", "HEAD^{tree}"])).toBe(
      await b.f.git(["rev-parse", "HEAD^{tree}"]),
    );
    expect(await a.f.git(["log", "-3", "--format=%B"])).toBe(
      await b.f.git(["log", "-3", "--format=%B"]),
    );
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      a.f.calls.every((args) => args.includes(`${key}=${configured}`)),
    ).toBe(true);
  }),
  gitIntegrationBudget(15000),
);

it(
  "apply whitespace fix keeps native conflict bytes and Desktop continuation",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
    await f.write("file-1", "topic with spaces   \n");
    await f.git([
      "commit",
      "-am",
      "trailing whitespace",
      "--amend",
      "--no-edit",
    ]);
    await f.git(["config", "apply.whitespace", "fix"]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const stage3 = await f.git(["show", ":3:file-1"]);
    expect(stage3).toBe("topic with spaces\n");
    await f.resolve();
    expect(
      await f.engine.execute((await f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed" });
  }),
  gitIntegrationBudget(15000),
);
