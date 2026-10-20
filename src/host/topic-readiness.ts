import path from "node:path";
import { lstat } from "node:fs/promises";
import { noSymlinks } from "./settings";
import type { TopicContextIdentity } from "../shared/worktrees";
import {
  guardedProject,
  readCommittedTask,
  readWorkingTask,
  taskPath,
} from "./topic-task";
import { assertReadActive } from "./read-scope";
type Task = { text: string; exists: boolean };
type Git = (root: string, args: string[]) => Promise<string>;
const same = (a: Task, b: Task) => a.exists === b.exists && a.text === b.text;
const changed = () =>
  Error(
    "Ветка или данные задачи изменились во время проверки. Повторите подготовку.",
  );
const missing = () =>
  Error("Данные выбранного топика не найдены. Обновите каталог.");
async function snapshot(
  root: string,
  identity: TopicContextIdentity,
  git: Git,
  env?: NodeJS.ProcessEnv,
  readTask = true,
) {
  await guardedProject(root);
  assertReadActive();
  const gitRoot = path.join(root, ".git");
  await noSymlinks(gitRoot);
  if (!(await lstat(gitRoot)).isDirectory())
    throw Error("Для проверки задачи требуется автономная папка Git проекта.");
  const effective = async () => {
    const actual = (
      await git(root, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--absolute-git-dir",
        "--git-common-dir",
        "--git-path",
        "index",
        "--git-path",
        "objects",
      ])
    )
      .trim()
      .split("\n");
    const expected = [
      root,
      gitRoot,
      gitRoot,
      path.join(gitRoot, "index"),
      path.join(gitRoot, "objects"),
    ];
    if (
      actual.length !== expected.length ||
      actual.some((value, i) => path.resolve(root, value) !== expected[i])
    )
      throw Error(
        "Эффективные пути Git не соответствуют выбранной папке проекта.",
      );
    await noSymlinks(gitRoot);
  };
  await effective();
  const relative = taskPath(identity.topic, identity.year);
  const refs = async () => {
    const current = (await git(root, ["branch", "--show-current"])).trim();
    const head = (
      await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    const ref = `refs/heads/${identity.branch}`;
    const rows = (
      await git(root, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)",
        ref,
      ])
    )
      .trim()
      .split("\n")
      .filter((row) => row.split("\0")[0] === ref);
    if (rows.length > 1) throw changed();
    const commit = rows[0]?.split("\0")[1];
    if (
      !/^[a-f0-9]{40,64}$/.test(head) ||
      (commit !== undefined && !/^[a-f0-9]{40,64}$/.test(commit))
    )
      throw changed();
    if (!commit) throw missing();
    return { current, head, commit };
  };
  const before = await refs();
  const committed =
    readTask && before.commit
      ? await readCommittedTask(
          root,
          before.commit,
          relative,
          (args) => git(root, args),
          env,
        )
      : { text: "", exists: false };
  const working = readTask && before.current === identity.branch;
  let taskStamp: string | undefined;
  const value = working
    ? await readWorkingTask(root, relative, (stamp) => {
        taskStamp = stamp;
      })
    : committed;
  const verify = async () => {
    assertReadActive();
    await guardedProject(root);
    await effective();
    if (JSON.stringify(await refs()) !== JSON.stringify(before))
      throw changed();
    if (working) {
      let stamp: string | undefined;
      const latest = await readWorkingTask(root, relative, (value) => {
        stamp = value;
      });
      if (!same(value, latest) || stamp !== taskStamp) throw changed();
    }
    assertReadActive();
  };
  await verify();
  return { ...before, committed, value, relative, verify };
}
/** Clone-local task authority. Preparation never compares or imports primary todo. */
export async function assertTopicTaskReady(input: {
  identity: TopicContextIdentity;
  source: string;
  clone?: string;
  git: Git;
  catalog: () => Promise<{ topic: string; branch: string }[]>;
  env?: NodeJS.ProcessEnv;
}) {
  const local = await snapshot(
    input.clone ?? input.source,
    input.identity,
    input.git,
    input.env,
    !!input.clone,
  );
  if (input.clone && local.current !== input.identity.branch) throw changed();
  const exact = async () =>
    (await input.catalog())
      .filter(
        (row) =>
          row.topic === input.identity.topic &&
          row.branch === input.identity.branch,
      )
      .map((row) => ({ topic: row.topic, branch: row.branch }));
  const rows = await exact();
  if (rows.length > 1)
    throw Error("Топик неоднозначен в локальном каталоге. Обновите список.");
  if (!input.clone && !rows.length) throw missing();
  const verify = async () => {
    await local.verify();
    if (JSON.stringify(await exact()) !== JSON.stringify(rows)) throw changed();
    await local.verify();
  };
  await verify();
  return verify;
}
