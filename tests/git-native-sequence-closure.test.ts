import { gitIntegrationBudget } from "./helpers/git-integration";
import { nativeSequenceScope as fixtureScope } from "./helpers/native-sequence-regression";
import { expect, it } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { CommandExitError } from "../src/host/process";
import { nativeSequenceFixture } from "./helpers/native-sequence-regression";

// Include raw index, HEAD, refs, object/control bytes, ignored and untracked
// files, modes and empty directories; do not mistake timestamp refresh for data.
async function treeDigest(root: string, omit: string[] = []) {
  const rows: unknown[] = [];
  async function visit(relative: string) {
    if (omit.includes(relative)) return;
    const full = path.join(root, relative);
    const stat = await fs.lstat(full);
    rows.push([relative, stat.mode]);
    if (stat.isSymbolicLink()) rows.push(await fs.readlink(full));
    else if (stat.isDirectory()) {
      for (const name of (await fs.readdir(full)).sort())
        await visit(relative ? `${relative}/${name}` : name);
    } else rows.push((await fs.readFile(full)).toString("base64"));
  }
  await visit("");
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

it(
  "G1 managed apply: late unrelated bytes revoke preview and replay without changing the complete repository",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const preview = await f.prepare("continue");
    await f.write("untouched", "late user bytes\n");
    const before = await treeDigest(f.root);
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    expect(await treeDigest(f.root)).toBe(before);
    expect(await f.read("untouched")).toBe("late user bytes\n");
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it(
  "G1 managed apply: patch changed at final locked verify cannot reach native spawn",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const preview = await f.prepare("continue");
    let injected = 0;
    let changedTree: string | undefined;
    f.verify(async () => {
      if (injected) return;
      try {
        await fs.lstat(path.join(f.root, ".git/config.lock"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const records = (await fs.readdir(f.directory)).filter((name) =>
        name.endsWith(".json"),
      );
      expect(records).toHaveLength(1);
      expect(
        JSON.parse(
          await fs.readFile(path.join(f.directory, records[0]), "utf8"),
        ),
      ).toMatchObject({ state: "running" });
      injected++;
      await fs.appendFile(
        path.join(f.root, ".git/rebase-apply/patch"),
        "late opaque patch bytes\n",
      );
      changedTree = await treeDigest(f.root, [".git/config.lock"]);
    });
    const result = await f.engine.execute(preview.token);
    expect(injected).toBe(1);
    expect(result).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
    });
    expect(f.calls).toHaveLength(1);
    expect(await treeDigest(f.root)).toBe(changedTree);
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

it.each([
  "message",
  "author-script",
  "update-refs",
  "gpg_sign_opt",
  "autostash",
  "AUTO_MERGE",
])(
  "G2 managed merge-rebase: changed opaque %s revokes continue and abort tickets without writes",
  fixtureScope.run(async (control) => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const proceed = await f.prepare("continue");
    const abort = await f.prepare("abort");
    const relative =
      control === "AUTO_MERGE"
        ? ".git/AUTO_MERGE"
        : `.git/rebase-merge/${control}`;
    if (control === "AUTO_MERGE")
      expect((await f.read(relative)).trim()).toMatch(/^[a-f0-9]{40,64}$/);
    await fs.appendFile(
      path.join(f.root, relative),
      "changed opaque control\n",
    );
    const before = await treeDigest(f.root);
    for (const preview of [proceed, abort]) {
      await expect(f.engine.execute(preview.token)).rejects.toThrow();
      await expect(f.engine.execute(preview.token)).rejects.toThrow();
    }
    await expect(f.prepare("continue")).rejects.toThrow();
    await expect(f.prepare("abort")).rejects.toThrow();
    expect(await treeDigest(f.root)).toBe(before);
    expect(await f.read(relative)).toContain("changed opaque control\n");
    expect(f.calls).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

for (const scenario of ["merge-rebase", "cherry-pick", "revert"] as const)
  it(
    `G3 ${scenario}: current empty resolution follows raw Git, never skips and retains explicit abort when stopped`,
    fixtureScope.run(async () => {
      const f = await nativeSequenceFixture(scenario, 1, [1]);
      const control = await nativeSequenceFixture(scenario, 1, [1]);
      const baselineIndex = await f.git(["ls-files", "--stage", "-z"]);
      expect(await f.start()).toMatchObject({ outcome: "conflicts" });
      await expect(
        control.git(
          scenario === "merge-rebase"
            ? ["rebase", "--merge", control.onto]
            : [control.command, ...control.sources],
        ),
      ).rejects.toMatchObject({ exitCode: 1 });
      for (const fixture of [f, control]) {
        const conflicts = await fixture.conflicts();
        expect(conflicts).toEqual(["file-1"]);
        // Resolve the CURRENT conflict to its already checked-out HEAD tree.
        for (const name of conflicts)
          await fixture.write(
            name,
            await fixture.git(["show", `HEAD:${name}`]),
          );
        await fixture.git(["add", "--", ...conflicts]);
        expect(await fixture.git(["diff", "--cached", "HEAD"])).toBe("");
      }
      let rawExit = 0;
      try {
        await control.git([control.command, "--continue"]);
      } catch (error) {
        expect(error).toBeInstanceOf(CommandExitError);
        rawExit = (error as CommandExitError).exitCode!;
        expect(rawExit).not.toBe(0);
      }
      const preview = await f.prepare("continue");
      const result = await f.engine.execute(preview.token);
      expect(result.exitCode).toBe(rawExit);
      expect(await f.git(["rev-parse", "HEAD^{tree}"])).toBe(
        await control.git(["rev-parse", "HEAD^{tree}"]),
      );
      expect(await f.git(["rev-list", "--count", "HEAD"])).toBe(
        await control.git(["rev-list", "--count", "HEAD"]),
      );
      expect(await f.git(["ls-files", "--stage", "-z"])).toBe(
        await control.git(["ls-files", "--stage", "-z"]),
      );
      expect((await f.reader.snapshot()).operation).toBe(
        (await control.reader.snapshot()).operation,
      );
      expect(
        f.calls.filter((args) => args.includes("--continue")),
      ).toHaveLength(1);
      expect(f.calls.some((args) => args.includes("--skip"))).toBe(false);
      await expect(f.engine.execute(preview.token)).rejects.toThrow();
      if (rawExit === 0) {
        expect(result).toMatchObject({
          outcome: "completed",
          recovery: "removed",
        });
        expect((await f.reader.snapshot()).operation).toBe("none");
      } else {
        expect(["stopped", "uncertain"]).toContain(result.outcome);
        expect(result.recovery).toBe("retained");
        expect(result.recoveryPath).toEqual(expect.any(String));
        await fs.access(result.recoveryPath!);
        const restarted = f.restart();
        expect(
          await restarted.execute((await f.prepare("abort", restarted)).token),
        ).toMatchObject({ outcome: "completed", recovery: "removed" });
        expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
        expect(await f.git(["ls-files", "--stage", "-z"])).toBe(baselineIndex);
        expect(await f.git(["diff", "HEAD"])).toBe("");
        expect((await f.reader.snapshot()).operation).toBe("none");
        expect(f.calls.filter((args) => args.includes("--abort"))).toHaveLength(
          1,
        );
      }
      expect(await f.read("ignored")).toBe("preserve ignored\n");
      expect(await f.read("untracked")).toBe("preserve untracked\n");
      expect(f.calls.some((args) => args.includes("--skip"))).toBe(false);
    }),
    gitIntegrationBudget(15000),
  );

it(
  "G8 actual native abort completes but transport exit 7 remains uncertain with retained recovery and no replay",
  fixtureScope.run(async () => {
    const f = await nativeSequenceFixture("merge-rebase", 1, [1]);
    const index = await f.git(["ls-files", "--stage", "-z"]);
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    await f.resolve();
    const preview = await f.prepare("abort");
    let completed = 0;
    f.nativeResult((result) => {
      expect(result).toMatchObject({
        exitCode: 0,
        signal: null,
        processSettled: true,
      });
      completed++;
      return { ...result, exitCode: 7, stderr: Buffer.alloc(0) };
    });
    const result = await f.engine.execute(preview.token);
    expect(completed).toBe(1);
    expect(result).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
      exitCode: 7,
      signal: null,
      processSettled: true,
    });
    expect(result.recoveryPath).toEqual(expect.any(String));
    await fs.access(result.recoveryPath!);
    expect((await f.git(["rev-parse", "HEAD"])).trim()).toBe(f.original);
    expect(await f.git(["ls-files", "--stage", "-z"])).toBe(index);
    expect(await f.git(["diff", "HEAD"])).toBe("");
    expect((await f.reader.snapshot()).operation).toBe("none");
    expect(await f.read("ignored")).toBe("preserve ignored\n");
    expect(await f.read("untracked")).toBe("preserve untracked\n");
    await expect(f.engine.execute(preview.token)).rejects.toThrow();
    await expect(f.prepare("abort", f.restart())).rejects.toThrow();
    expect(f.calls).toHaveLength(2);
    expect(f.calls.filter((args) => args.includes("--abort"))).toHaveLength(1);
  }),
  gitIntegrationBudget(15000),
);

for (const scenario of ["cherry-pick", "revert"] as const)
  for (const commits of [1, 3])
    it(
      `G9 ${scenario}/${commits}: managed continue and abort previews are read-only and stale revision grants no authority`,
      fixtureScope.run(async () => {
        const f = await nativeSequenceFixture(scenario, commits, [1]);
        expect(await f.start()).toMatchObject({ outcome: "conflicts" });
        const staleRevision = (await f.reader.snapshot()).revision;
        const conflicts = await f.resolve();
        const state = await f.reader.snapshot();
        expect(state.revision).not.toBe(staleRevision);
        const repository = await treeDigest(f.root);
        const journal = await treeDigest(f.directory);
        for (const action of ["continue", "abort"] as const) {
          const preview = await f.engine.prepare({
            scope: "regression",
            operation: f.command,
            action,
            revision: state.revision,
          });
          expect(preview).toMatchObject({
            scope: "regression",
            operation: f.command,
            action,
            original: f.original,
            head: state.head,
            current: f.sources[0],
            branch: f.branch,
            paths: conflicts,
            discardedResolutionPaths: action === "abort" ? conflicts : [],
            requiresCommitWarning:
              scenario === "revert" && action === "continue",
          });
          expect(preview.token).toMatch(/^[a-f0-9]{64}$/);
          expect(await treeDigest(f.root)).toBe(repository);
          expect(await treeDigest(f.directory)).toBe(journal);
          await expect(
            f.engine.prepare({
              scope: "regression",
              operation: f.command,
              action,
              revision: staleRevision,
            }),
          ).rejects.toThrow();
          expect(await treeDigest(f.root)).toBe(repository);
          expect(await treeDigest(f.directory)).toBe(journal);
        }
        expect(f.calls).toHaveLength(1);
      }),
      gitIntegrationBudget(15000),
    );
