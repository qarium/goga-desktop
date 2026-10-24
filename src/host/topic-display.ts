import { randomUUID } from "node:crypto";
import type { TopicsContext } from "./topics";
import type {
  TopicBoardSnapshot,
  TopicDetails,
  TopicTarget,
} from "../shared/topics";
import {
  topicEntriesSchema,
  topicTargetSchema,
  topicYearSchema,
} from "../shared/topics-schema";
import { assertReadActive } from "./read-scope";
import {
  guardedProject,
  readWorkingTask,
  readCommittedTask,
  taskDocument,
  taskPath,
} from "./topic-task";

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const changed = () =>
  Error("Ветка или задача изменились во время чтения. Откройте задачу заново.");

/** Display data only: never computes a mutation fingerprint or reads per-host/remote boards. */
export async function readTopicTableDisplay(
  d: Pick<TopicsContext, "project" | "root" | "goga">,
  year: string,
): Promise<TopicBoardSnapshot> {
  topicYearSchema.parse(year);
  assertReadActive();
  await guardedProject(d.root ?? d.project.path);
  const raw = await d.goga(["topics", "--year", year, "board", "--json"]);
  assertReadActive();
  let entries;
  try {
    entries = topicEntriesSchema
      .parse(JSON.parse(raw))
      .filter((row) => !row.remote)
      .map((row) => ({
        ...row,
        todo: null,
      }));
  } catch {
    throw Error("Goga вернула некорректный JSON каталог топиков");
  }
  const keys = new Set<string>();
  for (const row of entries) {
    const key = JSON.stringify([row.topic, row.branch]);
    if (keys.has(key)) throw Error("Топик неоднозначен. Обновите каталог.");
    keys.add(key);
  }
  const own = entries.filter(
    (row) => row.current && slug(row.branch) === row.topic,
  );
  const current = own.length === 1 ? own[0]! : null;
  await guardedProject(d.root ?? d.project.path);
  assertReadActive();
  return {
    projectId: d.project.id,
    year,
    // The explicit prefix is intentionally rejected by topicOperationSchema.
    revision: `display:${randomUUID()}`,
    currentBranch: current?.branch ?? "",
    currentTopic: current
      ? { topic: current.topic, branch: current.branch, remote: false }
      : null,
    baseRef: "",
    branches: [],
    dirty: false,
    active: false,
    entries,
    records: entries.map(({ hosts: _hosts, ...row }) => row),
    remoteEntries: [],
    remoteRecords: [],
  };
}

/** Task-only snapshot. An explicit owner uses working text; primary is committed read-only. */
export async function readTopicTaskOverview(
  d: TopicsContext,
  year: string,
  target: TopicTarget,
): Promise<TopicDetails> {
  topicYearSchema.parse(year);
  topicTargetSchema.parse(target);
  assertReadActive();
  const root = d.root ?? d.project.path;
  const relative = taskPath(target.topic, year);
  if (
    d.owner &&
    (d.owner.projectId !== d.project.id ||
      d.owner.year !== year ||
      d.owner.topic !== target.topic ||
      d.owner.branch !== target.branch ||
      target.remote)
  )
    throw Error("Топик относится к другому контексту.");
  const snapshot = async () => {
    assertReadActive();
    await guardedProject(root);
    const full = `${target.remote ? "refs/remotes/" : "refs/heads/"}${target.branch}`;
    const [raw, branch, head] = await Promise.all([
      d.git(["for-each-ref", "--format=%(refname)%00%(objectname)", full]),
      d.git(["branch", "--show-current"]),
      d.git(["rev-parse", "--verify", "HEAD^{commit}"]),
    ]);
    assertReadActive();
    const matches = raw
      .split("\n")
      .filter((line) => line.split("\0")[0] === full);
    const commit = matches[0]?.split("\0")[1];
    if (matches.length !== 1 || !commit || !/^[a-f0-9]{40,64}$/.test(commit))
      throw Error("Ветка отсутствует или неоднозначна. Обновите каталог.");
    if (!/^[a-f0-9]{40,64}$/.test(head.trim())) throw changed();
    return { commit, current: branch.trim(), head: head.trim() };
  };
  const before = await snapshot();
  const working =
    !!d.owner &&
    before.current === target.branch &&
    slug(target.branch) === target.topic;
  if (d.owner && !working) throw changed();
  let stamp: string | undefined;
  const value = working
    ? await readWorkingTask(root, relative, (value) => {
        stamp = value;
      })
    : await readCommittedTask(root, before.commit, relative, d.git, d.gitEnv);
  assertReadActive();
  if (JSON.stringify(await snapshot()) !== JSON.stringify(before))
    throw changed();
  if (working) {
    let afterStamp: string | undefined;
    const after = await readWorkingTask(root, relative, (value) => {
      afterStamp = value;
    });
    if (
      stamp !== afterStamp ||
      value.text !== after.text ||
      value.exists !== after.exists
    )
      throw changed();
  }
  assertReadActive();
  const editable = working && !d.active();
  return {
    projectId: d.project.id,
    year,
    target,
    ...value,
    version: taskDocument(root, target.branch, before.commit, relative, value)
      .version,
    editable,
    ...(!editable
      ? {
          reason: working
            ? "Во время активного запуска задача доступна только для чтения."
            : "Задача из коммита доступна только для чтения. Для редактирования выберите рабочий контекст топика.",
        }
      : {}),
  };
}
