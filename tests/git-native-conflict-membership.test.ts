import * as fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeSequenceFixture } from "./helpers/native-sequence-regression";

for (const scenario of [
  "merge-rebase",
  "apply-rebase",
  "cherry-pick",
  "revert",
] as const) {
  it(`${scenario}: a forged conflict cannot exempt unrelated data from the first seal`, async () => {
    const f = await nativeSequenceFixture(scenario, 1, [1]);
    const oid = (await f.git(["rev-parse", "HEAD:untouched"])).trim();
    f.afterNative(async () => {
      await f.gitInput(
        ["update-index", "--index-info"],
        `0 ${"0".repeat(40)}\tuntouched\n` +
          [1, 2, 3]
            .map((stage) => `100644 ${oid} ${stage}\tuntouched\n`)
            .join(""),
      );
    });
    expect(await f.start()).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
    });
    expect(f.calls).toHaveLength(1);
    expect(await f.read("untouched")).toBe("keep\n");
    await expect(f.prepare("continue")).rejects.toThrow();
  });
}

async function renameFixture(backend: "merge" | "apply") {
  const f = await nativeSequenceFixture(
    backend === "apply" ? "apply-rebase" : "merge-rebase",
    1,
    [1],
  );
  // All Git mutations are in the disposable fixture; create a well-detected rename.
  await f.write(
    "rename-source",
    Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(""),
  );
  await f.git(["add", "--", "rename-source"]);
  await f.git(["commit", "-m", "rename base"]);
  const base = (await f.git(["rev-parse", "HEAD"])).trim();
  await f.git(["checkout", "-b", "incoming-rename"]);
  await f.git(["mv", "rename-source", "theirs"]);
  await f.write(
    "theirs",
    (await f.read("theirs")).replace("line 10", "incoming 10"),
  );
  await f.git(["commit", "-am", "incoming rename"]);
  const current = (await f.git(["rev-parse", "HEAD"])).trim();
  await f.git(["checkout", "-B", "topic", base]);
  await f.git(["mv", "rename-source", "ours"]);
  await f.write("ours", (await f.read("ours")).replace("line 10", "local 10"));
  await f.git(["commit", "-am", "local rename"]);
  const start = () =>
    f.start({ operation: "rebase", source: current, backend });
  return { f, start };
}
it.each(["merge", "apply"] as const)(
  "%s rename/rename keeps synthesized stages and can continue in Desktop",
  async (backend) => {
    const { f, start } = await renameFixture(backend);
    expect(await start()).toMatchObject({ outcome: "conflicts" });
    await f.git(["rm", "--", "rename-source"]);
    await f.write("ours", "resolved rename\n");
    await f.write("theirs", "resolved rename\n");
    await f.git(["add", "--", "ours", "theirs"]);
    expect(
      await f.engine.execute((await f.prepare("continue")).token),
    ).toMatchObject({ outcome: "completed" });
  },
);
it.each(["merge", "apply"] as const)(
  "%s rejects coordinated stage, worktree and AUTO_MERGE substitution",
  async (backend) => {
    const { f, start } = await renameFixture(backend);
    f.afterNative(async () => {
      const row = (await f.git(["ls-files", "--unmerged", "-z"]))
        .split("\0")
        .find((row) => row.includes(" 2\t"))!;
      const m = /^(\d{6}) ([a-f0-9]+) 2\t(.+)$/s.exec(row)!;
      const content = "foreign synthesized result\n";
      const blob = (
        await f.gitInput(["hash-object", "-w", "--stdin"], content)
      ).stdout.trim();
      await f.gitInput(
        ["update-index", "--index-info"],
        `${m[1]} ${blob} 2\t${m[3]}\n`,
      );
      await f.write(m[3], content);
      const auto = await fs.stat(path.join(f.root, ".git/AUTO_MERGE")).then(
        () => true,
        (error) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (auto) {
        const entries = (await f.git(["ls-tree", "AUTO_MERGE"]))
          .split("\n")
          .filter(Boolean)
          .map((row) =>
            row.endsWith(`\t${m[3]}`) ? `${m[1]} blob ${blob}\t${m[3]}` : row,
          );
        const tree = (
          await f.gitInput(["mktree"], entries.join("\n") + "\n")
        ).stdout.trim();
        await f.git(["update-ref", "AUTO_MERGE", tree]);
      }
    });
    expect(await start()).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
    });
    expect(f.calls).toHaveLength(1);
  },
);

it("root cherry-pick uses a native empty tree witness and retains continuation", async () => {
  const f = await nativeSequenceFixture("cherry-pick", 1, [1]);
  const root = (await f.git(["rev-list", "--max-parents=0", "HEAD"])).trim();
  const result = await f.start({ operation: "cherry-pick", commits: [root] });
  expect(result, JSON.stringify(result)).toMatchObject({
    outcome: "conflicts",
  });
  await f.resolve();
  expect(
    await f.engine.execute((await f.prepare("continue")).token),
  ).toMatchObject({ outcome: "completed" });
});

it.each([
  "untracked-attributes",
  "relative-attributes",
  "executable-0744",
  "clean-lf",
  "checkout-attributes",
  "baseline-executable",
] as const)(
  "independent witness preserves admitted %s representation",
  async (kind) => {
    const f = await nativeSequenceFixture("cherry-pick", 1, [1]);
    if (kind === "untracked-attributes")
      await f.write(".gitattributes", "file-1 conflict-marker-size=20\n");
    if (kind === "relative-attributes") {
      await f.write("attributes", "file-1 conflict-marker-size=20\n");
      await f.git(["config", "core.attributesFile", "attributes"]);
    }
    if (kind === "executable-0744") {
      await f.git(["update-index", "--chmod=+x", "untouched"]);
      await f.git(["commit", "-m", "executable fixture"]);
      await fs.chmod(path.join(f.root, "untouched"), 0o744);
    }
    if (kind === "baseline-executable") {
      await f.git(["config", "core.fileMode", "false"]);
      await fs.chmod(path.join(f.root, "untouched"), 0o755);
    }
    if (kind === "clean-lf") await f.git(["config", "core.autocrlf", "true"]);
    if (kind === "checkout-attributes") {
      await f.git(["config", "core.autocrlf", "true"]);
      await f.write(".gitattributes", "* -text\n");
    }
    const before = await f.read("untouched");
    expect(await f.start()).toMatchObject({ outcome: "conflicts" });
    expect(await f.read("untouched")).toBe(before);
    if (kind === "clean-lf") {
      await f.resolve();
      expect(
        await f.engine.execute((await f.prepare("continue")).token),
      ).toMatchObject({ outcome: "completed" });
      expect(await f.read("untouched")).toBe(before);
    } else {
      expect(
        await f.engine.execute((await f.prepare("abort")).token),
      ).toMatchObject({ outcome: "completed" });
    }
  },
);

it("apply rejects a conflict executable-bit substitution before the first seal", async () => {
  const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
  f.afterNative(async () => {
    await fs.chmod(path.join(f.root, "file-1"), 0o755);
  });
  expect(await f.start()).toMatchObject({
    outcome: "uncertain",
    recovery: "retained",
  });
  expect((await fs.stat(path.join(f.root, "file-1"))).mode & 0o100).toBe(0o100);
  expect(f.calls).toHaveLength(1);
});

it("native abort retains recovery instead of certifying rewritten original LF bytes", async () => {
  const f = await nativeSequenceFixture("cherry-pick", 1, [1]);
  await f.git(["config", "core.autocrlf", "true"]);
  expect(await f.start()).toMatchObject({ outcome: "conflicts" });
  expect(
    await f.engine.execute((await f.prepare("abort")).token),
  ).toMatchObject({ outcome: "uncertain", recovery: "retained" });
});

it("apply rejects post-stop chmod even with core.fileMode=false", async () => {
  const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
  await f.git(["config", "core.fileMode", "false"]);
  f.afterNative(async () => {
    await fs.chmod(path.join(f.root, "untouched"), 0o755);
  });
  expect(await f.start()).toMatchObject({
    outcome: "uncertain",
    recovery: "retained",
  });
  expect((await fs.stat(path.join(f.root, "untouched"))).mode & 0o100).toBe(
    0o100,
  );
  expect(f.calls).toHaveLength(1);
});

it.each([0o640, 0o654])(
  "apply rejects new non-owner-executable permission bits %s before first seal",
  async (mode) => {
    const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
    f.afterNative(async () => {
      await fs.chmod(path.join(f.root, "file-1"), mode);
    });
    expect(await f.start()).toMatchObject({
      outcome: "uncertain",
      recovery: "retained",
    });
    expect((await fs.stat(path.join(f.root, "file-1"))).mode & 0o777).toBe(
      mode,
    );
  },
);
it("native apply permission normalization retains Desktop continuation", async () => {
  const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
  await fs.chmod(path.join(f.root, "file-1"), 0o640);

  expect(await f.start()).toMatchObject({ outcome: "conflicts" });
  await f.resolve();
  expect(
    await f.engine.execute((await f.prepare("continue")).token),
  ).toMatchObject({ outcome: "completed" });
});

it("apply rejects chmod of an unchanged file even when it matches fresh checkout permissions", async () => {
  const f = await nativeSequenceFixture("apply-rebase", 1, [1]);
  await fs.chmod(path.join(f.root, "untouched"), 0o640);
  let nativeMode = 0;
  f.afterNative(async () => {
    nativeMode = (await fs.stat(path.join(f.root, "untouched"))).mode & 0o777;
    await fs.chmod(path.join(f.root, "untouched"), 0o644);
  });
  const result = await f.start();
  expect(nativeMode).toBe(0o640);
  expect(result).toMatchObject({ outcome: "uncertain", recovery: "retained" });
  expect((await fs.stat(path.join(f.root, "untouched"))).mode & 0o777).toBe(
    0o644,
  );
});
