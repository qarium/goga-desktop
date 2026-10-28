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
for (const scenario of scenarios) {
  it(`${scenario}: abort at the second native stop restores the original pre-sequence baseline after restart`, async () => {
    const f = await nativeSequenceFixture(scenario);
    const index = await f.git(["ls-files", "--stage", "-z"]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    expect(
      await f.engine.execute((await f.prepare("continue")).token),
    ).toMatchObject({ outcome: "conflicts" });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).not.toBe(f.original);
    await f.resolve();
    const resumed = f.restart(),
      preview = await f.prepare("abort", resumed);
    expect(preview.original).toBe(f.original);
    expect(await resumed.execute(preview.token)).toMatchObject({
      outcome: "completed",
      recovery: "removed",
    });
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
    expect(await f.git(["diff", "HEAD"])).toBe("");
    expect((await f.git(["symbolic-ref", "--short", "HEAD"])).trim()).toBe(
      f.branch,
    );
    expect(await f.read("untracked")).toBe("preserve untracked\n");
    expect(await f.read("ignored")).toBe("preserve ignored\n");
  });

  it(`${scenario}: abort refuses a permission change disguised as a resolved conflict without discarding it`, async () => {
    const f = await nativeSequenceFixture(scenario, 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    const [name] = await f.resolve();
    const full = path.join(f.root, name);
    const content = await f.read(name);
    await fs.chmod(full, 0o640);
    const head = await f.git(["rev-parse", "HEAD"]);
    await expect(f.prepare("abort")).rejects.toThrow();
    expect((await fs.stat(full)).mode & 0o777).toBe(0o640);
    expect(await f.read(name)).toBe(content);
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(f.calls).toHaveLength(1);
  });
}

for (const scenario of ["cherry-pick", "revert"] as const)
  it(`${scenario}: changed identity and signing policy revoke abort authority without invoking a signer`, async () => {
    const f = await nativeSequenceFixture(scenario, 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.git(["config", "--unset", "user.name"]);
    await f.git(["config", "--unset", "user.email"]);
    await f.git(["config", "commit.gpgsign", "true"]);
    await f.git(["config", "gpg.program", "/usr/bin/false"]);
    const head = await f.git(["rev-parse", "HEAD"]);
    await expect(f.prepare("abort")).rejects.toThrow();
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect((await f.git(["config", "commit.gpgsign"])).trim()).toBe("true");
    expect(f.calls).toHaveLength(1);
    expect(f.calls.filter((args) => args.includes("--abort"))).toHaveLength(0);
  });

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
    it(`${scenario}: repeated multiline picks preserve resolution, author, message and current committer (nested=${variant.nested}, fallback=${variant.fallback})`, async () => {
      const a = await multiline(scenario, variant.nested, variant.fallback);
      const b = await multiline(scenario, variant.nested, variant.fallback);
      expect(await a.f.start(a.start)).toMatchObject({ outcome: "conflicts" });
      await expect(b.f.git(b.rawStart)).rejects.toMatchObject({ exitCode: 1 });
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
        (await a.f.git(["log", "-3", "--format=%cn <%ce>"])).trim().split("\n"),
      ).toEqual(Array(3).fill("Current Committer <committer@example.invalid>"));
      expect(await a.f.read(a.name)).toContain("resolved\n");
      expect(await a.f.read(a.name)).toContain("preserved upstream tail\n");
      expect(await a.f.read("untracked")).toBe("preserve untracked\n");
      expect(await a.f.read("ignored")).toBe("preserve ignored\n");
    });

it.each(["foreign-marker", "unrelated-ref", "policy"] as const)(
  "real native completion followed by %s drift is uncertain and is never replayed",
  async (change) => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const p = await f.prepare("continue");
    f.afterNative(async () => {
      if (change === "foreign-marker")
        await f.write(".git/BISECT_START", "foreign marker\n");
      if (change === "unrelated-ref")
        await f.git(["update-ref", "refs/heads/foreign", "HEAD"]);
      if (change === "policy")
        await fs.appendFile(
          path.join(f.root, ".git/config"),
          "\n[user]\nname = Foreign identity\n",
        );
    });
    const result = await f.engine.execute(p.token);
    expect(result).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
      processSettled: true,
    });
    if (change === "foreign-marker")
      expect(await f.read(".git/BISECT_START")).toBe("foreign marker\n");
    if (change === "unrelated-ref")
      expect((await f.git(["rev-parse", "refs/heads/foreign"])).trim()).toMatch(
        /^[a-f0-9]{40,64}$/,
      );
    if (change === "policy")
      expect((await f.git(["config", "user.name"])).trim()).toBe(
        "Foreign identity",
      );
    await expect(f.engine.execute(p.token)).rejects.toThrow();
    expect(f.calls.filter((args) => args.includes("--continue"))).toHaveLength(
      1,
    );
  },
);
it("real next conflict with a foreign operation marker is not granted fresh native authority", async () => {
  const f = await nativeSequenceFixture("apply-rebase");
  expect(await f.start()).toMatchObject({ outcome: "conflicts" });
  await f.resolve();
  const p = await f.prepare("continue");
  f.afterNative(() => f.write(".git/CHERRY_PICK_HEAD", f.sources[0] + "\n"));
  expect(await f.engine.execute(p.token)).toMatchObject({
    outcome: "uncertain",
    recovery: "retained",
  });
  expect(await f.read(".git/CHERRY_PICK_HEAD")).toBe(f.sources[0] + "\n");
  await expect(f.prepare("continue")).rejects.toThrow();
  expect(f.calls.filter((args) => args.includes("--continue"))).toHaveLength(1);
});

it.each(["0002", "author-script", "patch", "next", "last"])(
  "managed apply rejects changed opaque %s after confirmation without a native attempt",
  async (control) => {
    const f = await nativeSequenceFixture("apply-rebase");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const p = await f.prepare("continue"),
      head = await f.git(["rev-parse", "HEAD"]);
    await fs.appendFile(
      path.join(f.root, ".git/rebase-apply", control),
      "tampered control\n",
    );
    await expect(f.engine.execute(p.token)).rejects.toThrow();
    await expect(f.engine.execute(p.token)).rejects.toThrow();
    expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
    expect(f.calls).toHaveLength(1);
  },
);
for (const scenario of ["cherry-pick", "revert"] as const)
  it.each([
    "sequencer/todo",
    "sequencer/head",
    "sequencer/abort-safety",
    "sequencer/opts",
    "MERGE_MSG",
  ])(
    `${scenario}: changed opaque %s revokes managed continuation`,
    async (control) => {
      const f = await nativeSequenceFixture(scenario);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      await f.resolve();
      const p = await f.prepare("continue"),
        head = await f.git(["rev-parse", "HEAD"]);
      await fs.appendFile(
        path.join(f.root, ".git", control),
        "foreign control\n",
      );
      await expect(f.engine.execute(p.token)).rejects.toThrow();
      expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
      expect(f.calls).toHaveLength(1);
    },
  );
for (const scenario of scenarios)
  it(`${scenario}: continue refuses both unresolved and unstaged manual resolutions`, async () => {
    const f = await nativeSequenceFixture(scenario, 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await expect(f.prepare("continue")).rejects.toThrow();
    for (const name of await f.conflicts())
      await f.write(name, "manual unstaged\n");
    await expect(f.prepare("continue")).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
for (const scenario of ["merge-rebase", "apply-rebase"] as const)
  it.each([
    { stops: [1] },
    { stops: [1, 3] },
    { stops: [1, 2, 4] },
    { stops: [4] },
  ])(
    `${scenario}: four native picks match control at every stop $stops`,
    async ({ stops }) => {
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
    },
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
    it(`${scenario}: ${action} preserves literal, prototype, numeric, Unicode and nested paths`, async () => {
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
        expect(await f.git(["ls-files", "--stage", "-z"])).toBe(originalIndex);
      }
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      expect(await f.read("ignored")).toBe("preserve ignored\n");
    });

it.each([
  ["apply.whitespace", "fix"],
  ["core.quotepath", "false"],
  ["am.threeway", "true"],
])(
  "initial apply policy %s is forwarded intact and matches real native continuation",
  async (key, value) => {
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
  },
);
it("initial inherited apply policy is captured rather than silently dropped by native child isolation", async () => {
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
  expect(a.f.calls.every((args) => args.includes("apply.whitespace=fix"))).toBe(
    true,
  );
});
it("initial revert.reference preserves the configured native message rather than replacing it", async () => {
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
});
it("a real external git am never becomes a Desktop rebase continuation", async () => {
  const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
  const patch = await f.git([
    "format-patch",
    "-k",
    "--stdout",
    "--full-index",
    "-1",
    f.sources[0],
  ]);
  const mailbox = path.join(f.home, "incoming.patch");
  await fs.writeFile(mailbox, patch);
  await f.git(["checkout", "main"]);
  await expect(f.git(["am", "--3way", mailbox])).rejects.toThrow();
  expect((await f.conflicts()).length).toBeGreaterThan(0);
  expect(
    (await fs.stat(path.join(f.root, ".git/rebase-apply/applying"))).isFile(),
  ).toBe(true);
  const head = await f.git(["rev-parse", "HEAD"]),
    index = await f.git(["ls-files", "--stage", "-z"]);
  for (const action of ["continue", "abort"] as const)
    await expect(f.prepare(action)).rejects.toThrow();
  expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
  expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
  expect(f.calls).toHaveLength(0);
});
for (const scenario of ["cherry-pick", "revert"] as const)
  it.each([1, 3])(
    `${scenario}: external --no-commit with %i source commits has no Desktop authority`,
    async (count) => {
      const f = await nativeSequenceFixture(scenario, count, [1]);
      await expect(
        f.git([scenario, "--no-commit", ...f.sources]),
      ).rejects.toMatchObject({ exitCode: 1 });
      const head = await f.git(["rev-parse", "HEAD"]),
        index = await f.git(["ls-files", "--stage", "-z"]);
      for (const action of ["continue", "abort"] as const)
        await expect(f.prepare(action)).rejects.toThrow();
      expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
      expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
      expect(f.calls).toHaveLength(0);
    },
  );
it("empty remaining apply follows native Git tree and commit count, preserves drop diagnostics and never invokes skip", async () => {
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
  expect(a.f.calls.filter((args) => args.includes("--continue"))).toHaveLength(
    1,
  );
});

it.each(["add", "delete", "mode", "binary"] as const)(
  "native rebase supports future %s through real Git instead of a private replay restriction",
  async (kind) => {
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
  },
);
it("native abort restores an original nested hierarchy without overwriting unrelated data", async () => {
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
});

it.each(["diff.external", "format.signaturefile"])(
  "initial apply %s does not execute a configured file and preserves native replay semantics",
  async (key) => {
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
  },
);
it("a removed unrelated baseline path cannot be disguised as a managed conflict resolution", async () => {
  const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
  expect(await f.start()).toMatchObject({ outcome: "conflicts" });
  await f.resolve();
  await f.git(["rm", "untouched"]);
  const head = await f.git(["rev-parse", "HEAD"]),
    index = await f.git(["ls-files", "--stage", "-z"]);
  for (const action of ["continue", "abort"] as const)
    await expect(f.prepare(action)).rejects.toThrow();
  expect(await f.git(["rev-parse", "HEAD"])).toBe(head);
  expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
  await expect(fs.stat(path.join(f.root, "untouched"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.calls).toHaveLength(1);
});
it("native abort preserves the old inclusive one MiB and twenty-four-parent restoration boundary", async () => {
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
});

it("apply whitespace fix keeps native conflict bytes and Desktop continuation", async () => {
  const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
  await f.write("file-1", "topic with spaces   \n");
  await f.git(["commit", "-am", "trailing whitespace", "--amend", "--no-edit"]);
  await f.git(["config", "apply.whitespace", "fix"]);
  expect(await f.start()).toMatchObject({ outcome: "conflicts" });
  const stage3 = await f.git(["show", ":3:file-1"]);
  expect(stage3).toBe("topic with spaces\n");
  await f.resolve();
  expect(
    await f.engine.execute((await f.prepare("continue")).token),
  ).toMatchObject({ outcome: "completed" });
});
