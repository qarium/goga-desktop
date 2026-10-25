import { it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  prepareDeletionSwitch,
  verifyDeletionSwitch,
  executeDeletionSwitch,
} from "../src/host/deletion-branch-switch";
const exec = promisify(execFile),
  roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp("/private/tmp/goga-delete-switch-");
  roots.push(root);
  const git = async (args: string[]) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      })
    ).stdout;
  await git(["init", "-b", "main"]);
  await writeFile(root + "/file", "base");
  await git(["add", "."]);
  await git(["commit", "-m", "base"]);
  await git(["checkout", "-b", "feature/test"]);
  return { root, git };
}
it("previews without switching, then switches only to the pinned existing branch", async () => {
  const f = await fixture();
  const plan = await prepareDeletionSwitch(
    f.git,
    f.root,
    "feature/test",
    "main",
  );
  expect((await f.git(["branch", "--show-current"])).trim()).toBe(
    "feature/test",
  );
  await executeDeletionSwitch(f.git, f.root, plan);
  expect((await f.git(["branch", "--show-current"])).trim()).toBe("main");
});
it("rejects dirty primary before deletion and before switching", async () => {
  const f = await fixture();
  const plan = await prepareDeletionSwitch(
    f.git,
    f.root,
    "feature/test",
    "main",
  );
  await writeFile(f.root + "/file", "user edit");
  await expect(verifyDeletionSwitch(f.git, f.root, plan)).rejects.toThrow(
    /изменения/,
  );
  expect((await f.git(["branch", "--show-current"])).trim()).toBe(
    "feature/test",
  );
});
it("rejects missing, same, occupied and moved destination branches", async () => {
  const f = await fixture();
  await expect(
    prepareDeletionSwitch(f.git, f.root, "feature/test", "absent"),
  ).rejects.toThrow();
  await expect(
    prepareDeletionSwitch(f.git, f.root, "feature/test", "feature/test"),
  ).rejects.toThrow();
  const plan = await prepareDeletionSwitch(
    f.git,
    f.root,
    "feature/test",
    "main",
  );
  const linked = f.root + "-linked";
  roots.push(linked);
  await f.git(["worktree", "add", linked, "main"]);
  await expect(verifyDeletionSwitch(f.git, f.root, plan)).rejects.toThrow(
    /другой рабочей/,
  );
  await f.git(["worktree", "remove", linked]);
  await writeFile(f.root + "/file", "next");
  await f.git(["commit", "-am", "next"]);
  await f.git(["branch", "-f", "main", "HEAD"]);
  await expect(verifyDeletionSwitch(f.git, f.root, plan)).rejects.toThrow(
    /измен/,
  );
});
it("blocks an unfinished Git operation before checkout", async () => {
  const f = await fixture();
  await writeFile(
    f.root + "/.git/MERGE_HEAD",
    (await f.git(["rev-parse", "HEAD"])).trim(),
  );
  await expect(
    prepareDeletionSwitch(f.git, f.root, "feature/test", "main"),
  ).rejects.toThrow(/не завершена операция/);
  expect((await f.git(["branch", "--show-current"])).trim()).toBe(
    "feature/test",
  );
});
it("read-only preflight detects ignored file collisions without changing files or index", async () => {
  const f = await fixture();
  await f.git(["switch", "main"]);
  await writeFile(f.root + "/collision", "tracked base");
  await f.git(["add", "."]);
  await f.git(["commit", "-m", "base file"]);
  await f.git(["switch", "feature/test"]);
  await writeFile(f.root + "/.git/info/exclude", "collision\n");
  await writeFile(f.root + "/collision", "valuable ignored");
  await expect(
    prepareDeletionSwitch(f.git, f.root, "feature/test", "main"),
  ).rejects.toThrow();
  expect((await f.git(["branch", "--show-current"])).trim()).toBe(
    "feature/test",
  );
});
it("revalidates terminal readiness after the last asynchronous Git check before switching", async () => {
  const f = await fixture();
  const plan = await prepareDeletionSwitch(
    f.git,
    f.root,
    "feature/test",
    "main",
  );
  let ready = true;
  const git = async (args: string[]) => {
    const result = await f.git(args);
    if (args[0] === "read-tree") ready = false;
    return result;
  };
  await expect(
    executeDeletionSwitch(git, f.root, plan, () => {
      if (!ready) throw Error("terminal became busy");
    }),
  ).rejects.toThrow("terminal became busy");
  expect((await f.git(["branch", "--show-current"])).trim()).toBe(
    "feature/test",
  );
});
