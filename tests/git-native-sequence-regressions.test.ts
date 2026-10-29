import { nativeSequenceScope as fixtureScope } from "./helpers/native-sequence-regression";
import { gitIntegrationBudget } from "./helpers/git-integration";
import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { nativeSequenceFixture } from "./helpers/native-sequence-regression";

const scenarios = [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
] as const;

for (const scenario of scenarios) {
  it(
    `${scenario}: abort at the second native stop restores the original pre-sequence baseline after restart`,
    fixtureScope.run(async () => {
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
    }),
    gitIntegrationBudget(15000),
  );

  it(
    `${scenario}: abort refuses a permission change disguised as a resolved conflict without discarding it`,
    fixtureScope.run(async () => {
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
    }),
    gitIntegrationBudget(15000),
  );
}

for (const scenario of ["cherry-pick", "revert"] as const)
  it(
    `${scenario}: changed identity and signing policy revoke abort authority without invoking a signer`,
    fixtureScope.run(async () => {
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
      expect(f.calls.filter((args) => args.includes("--abort"))).toHaveLength(
        0,
      );
    }),
    gitIntegrationBudget(15000),
  );

it.each(["foreign-marker", "unrelated-ref", "policy"] as const)(
  "real native completion followed by %s drift is uncertain and is never replayed",
  fixtureScope.run(async (change) => {
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
  }),
  gitIntegrationBudget(15000),
);

it(
  "real next conflict with a foreign operation marker is not granted fresh native authority",
  fixtureScope.run(async () => {
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
    expect(f.calls.filter((args) => args.includes("--continue"))).toHaveLength(
      1,
    );
  }),
  gitIntegrationBudget(15000),
);

it.each(["0002", "author-script", "patch", "next", "last"])(
  "managed apply rejects changed opaque %s after confirmation without a native attempt",
  fixtureScope.run(async (control) => {
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
  }),
  gitIntegrationBudget(15000),
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
    fixtureScope.run(async (control) => {
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
    }),
    gitIntegrationBudget(15000),
  );

for (const scenario of scenarios)
  it(
    `${scenario}: continue refuses both unresolved and unstaged manual resolutions`,
    fixtureScope.run(async () => {
      const f = await nativeSequenceFixture(scenario, 1, [1]);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      await expect(f.prepare("continue")).rejects.toThrow();
      for (const name of await f.conflicts())
        await f.write(name, "manual unstaged\n");
      await expect(f.prepare("continue")).rejects.toThrow();
      expect(f.calls).toHaveLength(1);
    }),
    gitIntegrationBudget(15000),
  );

it(
  "a real external git am never becomes a Desktop rebase continuation",
  fixtureScope.run(async () => {
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
  }),
  gitIntegrationBudget(15000),
);

for (const scenario of ["cherry-pick", "revert"] as const)
  it.each([1, 3])(
    `${scenario}: external --no-commit with %i source commits has no Desktop authority`,
    fixtureScope.run(async (count) => {
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
    }),
    gitIntegrationBudget(15000),
  );

it(
  "a removed unrelated baseline path cannot be disguised as a managed conflict resolution",
  fixtureScope.run(async () => {
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
    await expect(fs.stat(path.join(f.root, "untouched"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);
