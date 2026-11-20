import { t as tr } from "../shared/i18n";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { lstat, open, readlink, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import type { Project } from "../shared/types";
import type {
  TopicBoardSnapshot,
  TopicCatalogSnapshot,
  TopicDetails,
  TopicOperationRequest,
  TopicOperationPlan,
  TopicOperationResult,
  TopicTarget,
} from "../shared/topics";
import {
  topicYearSchema,
  topicTargetSchema,
  topicOperationSchema,
  topicRecordsSchema,
  topicEntriesSchema,
  topicTokenSchema,
} from "../shared/topics-schema";
import { assertReadActive } from "./read-scope";
import { digest, atomicWrite, noSymlinks } from "./settings";
import {
  guardedProject,
  readWorkingTask,
  readCommittedTask,
  taskPath,
  taskDocument,
  validateTaskText,
} from "./topic-task";
export interface TopicsContext {
  /** Host-only read-only preview; never used by execute. */
  deletionSwitchFrom?: string;
  /** Host-only topic-first removal. Never accepted through IPC. */
  removalFlow?: true;
  project: Project;
  root?: string;
  owner?: import("../shared/worktrees").TopicContextRef;
  gitEnv?: NodeJS.ProcessEnv;
  git: (args: string[]) => Promise<string>;
  goga: (args: string[], stdin?: string) => Promise<string>;
  fingerprint: () => Promise<string>;
  baseRef: () => Promise<string>;
  active: () => boolean;
  /** Host registry gate for primary update/deletion; never substitutes an owner context. */
  assertPrimaryOwnerAvailable?: (
    request: TopicOperationRequest,
  ) => Promise<void>;
  assertBranchesAvailable?: (
    branches: string[],
    operation: TopicOperationRequest["action"],
  ) => Promise<void>;
}
export const normalizeTopicBranch = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const normalize = normalizeTopicBranch;
const short = (name: string) => name.slice(name.indexOf("/") + 1);
export interface TopicRef {
  full: string;
  name: string;
  remote: boolean;
  commit: string;
}
export interface TopicMutationSnapshot {
  kind?: "selected-delete";
  refs: TopicRef[];
  current: string;
  dirty: boolean;
  revision: string;
}
type State = TopicMutationSnapshot;
interface Command {
  args: string[];
  stdin?: string;
}
interface Prepared {
  guards: string[];
  request: TopicOperationRequest;
  plan: TopicOperationPlan;
  commands: Command[];
  save?: { relative: string; text: string };
}
const stale = () =>
  new Error(
    tr("host.confirmationIsStaleTheProjectBranchesTaskOrSettingsChanged"),
  );
/** A read raced repository changes; never use this as a mutation retry signal. */
class TopicSnapshotChangedError extends Error {
  constructor() {
    super(
      tr("host.projectDataIsChangingWhileTopicsAreLoadingTryAgain"),
    );
    this.name = "TopicSnapshotChangedError";
  }
}
async function refs(d: Pick<TopicsContext, "git">): Promise<TopicRef[]> {
  const raw = await d.git([
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)",
    "refs/heads",
    "refs/remotes",
  ]);
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const [full, commit, symref] = line.split("\0");
      if (!full || !commit || !/^[a-f0-9]{40,64}$/.test(commit))
        throw Error(tr("host.invalidGitRefsDirectory"));
      if (symref || full.endsWith("/HEAD")) return [];
      const remote = full.startsWith("refs/remotes/");
      return [{ full, commit, remote, name: full.slice(remote ? 13 : 11) }];
    });
}
export async function readTopicRefInventory(git: TopicsContext["git"]) {
  return refs({ git });
}
const treeReadConcurrency = 4;
async function hostedSlugs(
  git: TopicsContext["git"],
  commit: string,
  prefix: string,
  target = prefix,
) {
  // Match Goga's --name-only line projection exactly for identity and
  // directory effects. Git C-quotes whole paths for certain filenames;
  // CLI skips those lines. Still protect the actual topic on such trees.
  const paths = await git([
    "ls-tree",
    "-r",
    "--name-only",
    "--full-name",
    commit,
    "--",
    target,
  ]);
  const visible = new Set<string>(),
    physical = new Set<string>();
  for (const line of paths.split("\n")) {
    const quoted = line.startsWith('"');
    const file = quoted ? line.slice(1, -1) : line;
    if (!file.startsWith(prefix)) continue;
    const topic = file.slice(prefix.length).split("/")[0]!;
    if (!quoted) visible.add(topic);
    physical.add(topic);
  }
  return { visible, physical };
}
/** Goga resolves the exact directory entry name, even on case-insensitive disks. */
async function topicsOnDisk(directory: string) {
  await noSymlinks(directory);
  const dirs = new Set<string>(),
    links = new Set<string>();
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(entry.name);
      if (entry.isSymbolicLink()) links.add(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return (topic: string) => {
    if (links.has(topic)) throw Error(tr("host.symbolicLinksAreNotAllowed"));
    return dirs.has(topic);
  };
}
/** A managed clone can coexist with a deletable, uncommitted topic in primary.
 * No own ref is not proof that primary has no native target. Checked-in history
 * carried by other refs is retained by Goga; inspect each unique tip at most once. */
export async function diskOnlyTopicDirectories(
  d: Pick<TopicsContext, "git" | "root" | "project">,
  refs: TopicRef[],
  year: string,
  topics: string[],
) {
  if (!topics.length) return new Set<string>();
  const prefix = `.goga/history/${year}/`;
  const onDisk = await topicsOnDisk(
    path.join(d.root ?? d.project.path, prefix),
  );
  const diskOnly = new Set(topics.filter(onDisk));
  if (!diskOnly.size) return diskOnly;
  const commits = [...new Set(refs.map((ref) => ref.commit))];
  for (
    let i = 0;
    i < commits.length && diskOnly.size;
    i += treeReadConcurrency
  ) {
    assertReadActive();
    const target = diskOnly.size === 1 ? prefix + [...diskOnly][0]! : prefix;
    const sets = await Promise.all(
      commits
        .slice(i, i + treeReadConcurrency)
        .map((commit) => hostedSlugs(d.git, commit, prefix, target)),
    );
    for (const tree of sets)
      for (const topic of tree.physical) diskOnly.delete(topic);
  }
  return diskOnly;
}
/** Names only; deliberately no state fingerprint, Goga, base config or clone inventory. */
export async function readBranchChoices(git: TopicsContext["git"]) {
  const inventory = await refs({ git });
  return {
    branches: inventory.map((r) => r.name),
    localBranches: inventory.filter((r) => !r.remote).map((r) => r.name),
  };
}
// A bounded buffer, not a bounded file: unrelated large files must not hide
// read-only boards. Pin the descriptor and verify its identity/metadata so a
// concurrent replacement or edit cannot yield a falsely stable fingerprint.
async function workingFileDigest(file: string): Promise<string> {
  await noSymlinks(file);
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new TopicSnapshotChangedError();
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      assertReadActive();
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new TopicSnapshotChangedError();
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat(),
      current = await lstat(file);
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.size !== before.size ||
      current.mtimeMs !== before.mtimeMs ||
      current.ctimeMs !== before.ctimeMs ||
      current.isSymbolicLink()
    )
      throw new TopicSnapshotChangedError();
    await noSymlinks(file);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}
async function state(d: TopicsContext, year: string): Promise<State> {
  await guardedProject(d.root ?? d.project.path);
  const [
    inventory,
    current,
    status,
    diff,
    cached,
    untracked,
    config,
    gitConfig,
    allRefs,
  ] = await Promise.all([
    refs(d),
    d.git(["branch", "--show-current"]),
    d.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    d.git(["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]),
    d.git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      "--cached",
      "--",
    ]),
    d.git(["ls-files", "--others", "--exclude-standard", "-z"]),
    d.fingerprint(),
    d.git(["config", "--null", "--list", "--show-origin"]),
    d.git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"]),
  ]);
  const extra: string[] = [];
  for (const name of untracked.split("\0").filter(Boolean)) {
    assertReadActive();
    const file = path.resolve(d.root ?? d.project.path, name);
    if (!file.startsWith((d.root ?? d.project.path) + path.sep))
      throw Error(tr("host.invalidGitPath"));
    const info = await lstat(file);
    if (info.isSymbolicLink()) extra.push(name, await readlink(file));
    else if (info.isFile()) {
      extra.push(name, await workingFileDigest(file));
    } else extra.push(name, String(info.mtimeMs));
  }
  // Ignored current task also belongs to the stale guard.
  const own = normalize(current.trim());
  const task = own
    ? await readWorkingTask(d.root ?? d.project.path, taskPath(own, year))
    : null;
  return {
    refs: inventory,
    current: current.trim(),
    dirty: !!status,
    revision: digest(
      JSON.stringify([
        d.project,
        year,
        inventory,
        current,
        status,
        diff,
        cached,
        extra,
        config,
        gitConfig,
        allRefs,
        task,
      ]),
    ),
  };
}
/** A successful native catalog read proved only this exact target absent. */
export class TopicCatalogMissingError extends Error {
  constructor() {
    super(tr("host.topicNotFoundRefreshTheCatalog"));
    this.name = "TopicCatalogMissingError";
  }
}
/** Native admission snapshot without reading Goga display/status projections. */
export async function readTopicMutationSnapshot(
  d: TopicsContext,
  year: string,
) {
  return state(d, year);
}
/** For deletion of named topics, working files outside their history directories
 * aren't operands. Keep refs, checkout, Git configuration and invocation pinned;
 * deletion() separately verifies the removable directories and worktrees. */
export async function readSelectedTopicDeletionSnapshot(
  d: TopicsContext,
  year: string,
): Promise<TopicMutationSnapshot> {
  const root = d.root ?? d.project.path;
  await guardedProject(root);
  assertReadActive();
  const [inventory, branch, config, invocation, directory, git] =
    await Promise.all([
      refs(d),
      d.git(["branch", "--show-current"]),
      d.git(["config", "--null", "--list", "--show-origin"]),
      d.fingerprint(),
      lstat(root),
      lstat(path.join(root, ".git")),
    ]);
  return {
    kind: "selected-delete",
    refs: inventory,
    current: branch.trim(),
    dirty: false,
    revision: digest(
      JSON.stringify([
        d.project,
        year,
        directory.dev,
        directory.ino,
        git.dev,
        git.ino,
        inventory,
        branch,
        config,
        invocation,
      ]),
    ),
  };
}
export class TopicsDomain {
  private tickets = new Map<string, Prepared>();
  scopeForToken(token: string) {
    const id = this.projectForToken(token);
    return this.tickets.get(token)?.request.context ?? id;
  }
  projectForToken(token: string) {
    topicTokenSchema.parse(token);
    const ticket = this.tickets.get(token);
    if (!ticket || Date.now() >= ticket.plan.expiresAt) {
      this.tickets.delete(token);
      throw stale();
    }
    return ticket.request.projectId;
  }
  async catalog(
    d: Pick<TopicsContext, "project" | "goga">,
    year: string,
  ): Promise<TopicCatalogSnapshot> {
    topicYearSchema.parse(year);
    assertReadActive();
    await guardedProject(d.project.path);
    assertReadActive();
    const raw = await d.goga(["topics", "--year", year, "board", "--json"]);
    assertReadActive();
    let rows;
    try {
      rows = topicEntriesSchema.parse(JSON.parse(raw));
    } catch {
      throw Error(tr("host.gogaReturnedAnInvalidJsonTopicCatalog"));
    }
    // The aggregated board already defines logical entries; per-host history
    // and clone inventories are deliberately not consulted for this display.
    const entries = new Map<string, TopicTarget>();
    const current = new Map<string, TopicTarget>();
    for (const row of rows) {
      if (row.remote) continue;
      const target = { topic: row.topic, branch: row.branch, remote: false };
      const key = JSON.stringify([target.topic, target.branch]);
      entries.set(key, target);
      if (row.current && normalize(row.branch) === row.topic)
        current.set(key, target);
    }
    await guardedProject(d.project.path);
    assertReadActive();
    return {
      projectId: d.project.id,
      year,
      entries: [...entries.values()],
      currentTopic: current.size === 1 ? [...current.values()][0]! : null,
    };
  }
  async board(d: TopicsContext, year: string): Promise<TopicBoardSnapshot> {
    topicYearSchema.parse(year);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.boardSnapshot(d, year);
      } catch (error) {
        if (!(error instanceof TopicSnapshotChangedError) || attempt >= 2)
          throw error;
        // Finalization may still be writing. Restart the complete read, never
        // accept a mixed snapshot or retry a prepared mutation/confirmation.
        await delay(100 * (attempt + 1));
      }
    }
  }
  private async boardSnapshot(
    d: TopicsContext,
    year: string,
  ): Promise<TopicBoardSnapshot> {
    const before = await state(d, year);
    const args = ["topics", "--year", year, "board", "--json"];
    let entries, records, remoteEntries, remoteRecords;
    try {
      const reads = [
        d.goga(args),
        d.goga([...args, "--per-host"]),
        d.goga([...args, "--remote"]),
        d.goga([...args, "--remote", "--per-host"]),
      ];
      const raw = await Promise.all(reads).catch(async (error) => {
        // Peers may still hold settings locks. Drain these same reads before
        // returning a failed snapshot; preserve the original error, never retry.
        await Promise.allSettled(reads);
        throw error;
      });
      entries = topicEntriesSchema.parse(JSON.parse(raw[0]!));
      records = topicRecordsSchema.parse(JSON.parse(raw[1]!));
      remoteEntries = topicEntriesSchema.parse(JSON.parse(raw[2]!));
      remoteRecords = topicRecordsSchema.parse(JSON.parse(raw[3]!));
    } catch (error) {
      if (error instanceof SyntaxError || (error as Error).name === "ZodError")
        throw Error(tr("host.gogaReturnedAnInvalidJsonTopicCatalog"));
      throw error;
    }
    const after = await state(d, year);
    if (before.revision !== after.revision)
      throw new TopicSnapshotChangedError();
    const own = records.find(
      (r) =>
        !r.remote &&
        r.branch === after.current &&
        r.topic === normalize(after.current),
    );
    return {
      projectId: d.project.id,
      year,
      revision: after.revision,
      currentBranch: after.current,
      currentTopic: own
        ? { topic: own.topic, branch: own.branch, remote: false }
        : null,
      baseRef: await d.baseRef(),
      branches: after.refs.map((r) => r.name),
      localBranches: after.refs.filter((r) => !r.remote).map((r) => r.name),
      dirty: after.dirty,
      active: d.active(),
      entries,
      records,
      remoteEntries,
      remoteRecords,
    };
  }
  async details(
    d: TopicsContext,
    year: string,
    target: TopicTarget,
  ): Promise<TopicDetails> {
    topicYearSchema.parse(year);
    topicTargetSchema.parse(target);
    const before = await state(d, year);
    const board = await this.board(d, year);
    const exactRows = (snapshot: TopicBoardSnapshot) =>
      (target.remote ? snapshot.remoteRecords : snapshot.records).filter(
        (r) =>
          r.topic === target.topic &&
          r.branch === target.branch &&
          r.remote === target.remote,
      );
    const rows = exactRows(board);
    if (rows.length > 1) throw Error(tr("host.theTopicIsAmbiguousRefreshTheCatalog"));
    const ownedCurrent =
      !!d.owner &&
      !target.remote &&
      d.owner.projectId === d.project.id &&
      d.owner.year === year &&
      d.owner.topic === target.topic &&
      d.owner.branch === target.branch &&
      before.current === target.branch &&
      normalize(target.branch) === target.topic;
    if (!rows.length && !ownedCurrent) throw new TopicCatalogMissingError();
    const catalogState = !rows.length
      ? ("missing-local-metadata" as const)
      : undefined;
    const ref = before.refs.find(
      (r) => r.name === target.branch && r.remote === target.remote,
    );
    if (!ref) throw Error(tr("host.branchNotFoundRefreshTheCatalog"));
    const own =
      normalize(target.remote ? short(target.branch) : target.branch) ===
      target.topic;
    const current = !target.remote && before.current === target.branch && own;
    const relative = taskPath(target.topic, year);
    let taskStamp: string | undefined;
    const value = current
      ? await readWorkingTask(d.root ?? d.project.path, relative, (stamp) => {
          taskStamp = stamp;
        })
      : await readCommittedTask(
          d.root ?? d.project.path,
          ref.commit,
          relative,
          d.git,
          d.gitEnv,
        );
    const after = await this.board(d, year);
    if (
      after.revision !== before.revision ||
      JSON.stringify(exactRows(after)) !== JSON.stringify(rows)
    )
      throw stale();
    if (current) {
      let stamp: string | undefined;
      await readWorkingTask(d.root ?? d.project.path, relative, (value) => {
        stamp = value;
      });
      if (stamp !== taskStamp) throw stale();
    }
    const document = taskDocument(
      d.root ?? d.project.path,
      target.branch,
      ref.commit,
      relative,
      { ...value, ...(catalogState ? { catalogState } : {}) },
    );
    return {
      projectId: d.project.id,
      year,
      target,
      ...(catalogState ? { catalogState } : {}),
      ...value,
      version: document.version,
      editable: current && !d.active(),
      ...(!current
        ? {
            reason: target.remote
              ? tr("host.remoteBranchTheTaskIsReadOnlySwitchToThe")
              : !own
                ? tr("host.thisIsAnotherTopicSHostedHistoryEditOnlyOn")
                : tr("host.switchToTheTopicSOwnBranchBeforeEditing"),
          }
        : d.active()
          ? {
              reason:
                tr("host.duringAnActiveRunTheTaskIsReadOnly"),
            }
          : {}),
    };
  }
  async prepare(
    d: TopicsContext,
    input: TopicOperationRequest,
    removalState?: TopicMutationSnapshot,
  ): Promise<TopicOperationPlan> {
    const request = topicOperationSchema.parse(input);
    const prepared = await this.resolve(d, request, removalState);
    for (const [token, ticket] of this.tickets)
      if (Date.now() >= ticket.plan.expiresAt) this.tickets.delete(token);
    if (this.tickets.size >= 100)
      this.tickets.delete(this.tickets.keys().next().value!);
    this.tickets.set(prepared.plan.token, prepared);
    return prepared.plan;
  }
  private async resolve(
    d: TopicsContext,
    r: TopicOperationRequest,
    removalState?: TopicMutationSnapshot,
  ): Promise<Prepared> {
    if (d.active())
      throw Error(
        tr("host.aPipelineIsRunningInTheRepositoryStopItBefore"),
      );
    // Destructive operations are resolved from exact Git refs, the target
    // directories and registry guards, never from Goga's display projections.
    const removing = r.action === "delete" || r.action === "clear";
    const board = removing ? null : await this.board(d, r.year);
    if (board && board.revision !== r.expectedRevision) throw stale();
    const s = removing && removalState ? removalState : await state(d, r.year);
    if (s.revision !== r.expectedRevision) throw stale();
    if (r.task !== undefined) validateTaskText(r.task);
    const prefix = ["topics", "--year", r.year],
      commands: Command[] = [],
      details: string[] = [],
      guards: string[] = [];
    let save: Prepared["save"];
    // Independent switch/current update require a clean worktree. Native create
    // protects checkout conflicts itself and can preserve unrelated dirty work.
    // Other-topic deletion and update are checkout-free; their own target/base
    // checks and fresh confirmation guards still apply below.
    const dirtyUnsafe =
      r.action === "switch" ||
      (r.action === "update" &&
        !r.target?.remote &&
        r.target?.branch === s.current);
    if (s.dirty && dirtyUnsafe)
      throw Error(
        tr("host.theWorkingCopyHasUncommittedChangesDirtySaveThemBefore"),
      );
    const ensureBase = async () => {
      const base = r.baseRef || board?.baseRef || (await d.baseRef());
      if (!base || base.startsWith("-") || /[\x00-\x20]/.test(base))
        throw Error(tr("host.selectABaseBranch"));
      await d.git(["rev-parse", "--verify", `${base}^{commit}`]);
      return base;
    };
    if (r.action === "create") {
      if (!board) throw stale();
      if (!r.branch) throw Error(tr("host.enterABranchName"));
      await d.git(["check-ref-format", "--branch", r.branch]);
      await d.assertBranchesAvailable?.([r.branch], r.action);
      const slug = normalize(r.branch);
      if (!slug) throw Error(tr("host.theBranchNameDoesNotFormAValidTopic2"));
      if (
        s.refs.some(
          (ref) => normalize(ref.remote ? short(ref.name) : ref.name) === slug,
        ) ||
        [...board.records, ...board.remoteRecords].some(
          (row) => row.topic === slug,
        )
      )
        throw Error(tr("host.topicOrBranchAlreadyExists"));
      await noSymlinks(
        path.join(d.root ?? d.project.path, ".goga/history", r.year, slug),
      );
      try {
        await lstat(
          path.join(d.root ?? d.project.path, ".goga/history", r.year, slug),
        );
        throw Error(tr("host.topicDirectoryAlreadyExists"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const base = await ensureBase();
      if ((r.publish || !r.switch) && !r.task)
        throw Error(
          tr("host.aTaskIsRequiredWhenPublishingOrCreatingWithoutSwitching"),
        );
      if (r.commit && !r.publish)
        throw Error(tr("host.commitOnlyAppliesWhenPublishing"));
      const args = [
        ...prefix,
        "create",
        r.branch,
        "--base-ref",
        base,
        ...(r.publish ? ["--publish"] : r.switch ? ["--switch"] : []),
        ...(r.commit ? ["--commit", r.commit] : []),
        ...(r.task ? ["--todo"] : []),
      ];
      commands.push({ args, ...(r.task ? { stdin: r.task } : {}) });
      details.push(
        tr("host.createBranchYearSlugFromBase", { branch: r.branch, year: r.year, slug: slug, base: base }),
        r.publish
          ? tr("host.commitTheTaskAndPublishTheBranchToOrigin")
          : r.switch
            ? tr("host.switchBranchesTheTaskWillRemainUncommitted")
            : tr("host.commitTheTaskLocallyWithoutSwitching"),
      );
      if (r.publish && r.switch) {
        commands.push({ args: [...prefix, "switch", r.branch] });
        details.push(
          tr("host.switchSeparatelyAfterPublishingIfSwitchingFailsThePublishedBranch"),
        );
      }
    } else if (r.action === "save-task") {
      if (!r.target || r.task === undefined || !r.taskVersion)
        throw Error(tr("host.theTaskOrItsVersionIsMissing"));
      const doc = await this.details(d, r.year, r.target);
      if (!doc.editable) throw Error(doc.reason);
      if (
        doc.catalogState === "missing-local-metadata" &&
        !doc.exists &&
        !r.task.trim()
      )
        throw Error(
          tr("host.enterANonEmptyTaskDescriptionToCreateLocalData"),
        );
      if (doc.version !== r.taskVersion) throw stale();
      save = { relative: taskPath(r.target.topic, r.year), text: r.task };
      details.push(
        tr("host.writeRelativeInTheCurrentBranchBranchWithoutCommittingOr", { relative: save.relative, branch: r.target.branch }),
      );
      if (!r.task.trim()) details.push(tr("host.theTaskWillBeCompletelyCleared"));
    } else if (r.action === "clear") {
      if (!d.removalFlow || d.owner)
        throw Error(tr("host.useTheSeparateTopicCleanupConfirmation"));
      await d.assertPrimaryOwnerAvailable?.(r);
      const base = await ensureBase();
      guards.push(
        (await d.git(["rev-parse", "--verify", `${base}^{commit}`])).trim(),
      );
      const yearRoot = path.join(
        d.root ?? d.project.path,
        ".goga/history",
        r.year,
      );
      await noSymlinks(yearRoot);
      try {
        guards.push(await this.guardDirectory(yearRoot));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        guards.push("absent");
      }
      const branches: string[] = [];
      for (const ref of s.refs.filter(
        (ref) => !ref.remote && ref.name !== s.current,
      )) {
        if (
          (
            await d.git([
              "ls-tree",
              "-d",
              "--name-only",
              ref.commit,
              "--",
              `.goga/history/${r.year}`,
            ])
          ).trim()
        )
          branches.push(ref.name);
      }
      await d.assertBranchesAvailable?.(branches, "delete");
      commands.push({
        args: [...prefix, "clear", "--base-ref", base, "--yes"],
      });
      details.push(
        tr("host.clearTopicsForYearUnderGogaSRulesUsingBase", { year: r.year, base: base }),
        tr("host.searchFiltersCategoriesAndSelectedCardsDoNotLimitCleanup"),
        tr("host.topicBranchesIncludingBranchesOnOriginAndTopicHistoryMay"),
      );
    } else if (r.action === "delete") {
      await d.assertPrimaryOwnerAvailable?.(r);
      const topics = [
        ...new Set(r.topics ?? (r.target ? [r.target.topic] : [])),
      ];
      if (!topics.length) throw Error(tr("host.selectTopicsToRemove"));
      const identifiers = await this.deletion(
        d,
        r.year,
        s,
        topics,
        details,
        guards,
      );
      commands.push({ args: [...prefix, "delete", ...identifiers, "--yes"] });
      details.push(
        tr("host.removeWithoutTrashIfALaterRemovalFailsPreviouslyRemoved"),
      );
    } else {
      if (!board || !r.target) throw Error(tr("host.selectATopic"));
      if (r.action === "update") await d.assertPrimaryOwnerAvailable?.(r);
      if (
        ![...board.records, ...board.remoteRecords].some(
          (row) =>
            row.topic === r.target!.topic &&
            row.branch === r.target!.branch &&
            row.remote === r.target!.remote,
        )
      ) {
        // Old managed clones can have a valid checked-out owner but no
        // history directory (Git never transports empty directories).
        // Admit only this host-bound update, not arbitrary board targets.
        if (
          r.action !== "update" ||
          !d.owner ||
          !r.context ||
          d.owner.contextId !== r.context.contextId ||
          d.owner.revision !== r.context.revision ||
          d.owner.projectId !== r.projectId ||
          d.owner.year !== r.year ||
          d.owner.topic !== r.target.topic ||
          d.owner.branch !== r.target.branch ||
          s.current !== r.target.branch ||
          r.target.remote
        )
          throw Error(tr("host.topicMissing"));
        const directory = path.dirname(
          path.join(d.root ?? d.project.path, taskPath(d.owner.topic, r.year)),
        );
        await noSymlinks(directory);
        if (
          await lstat(directory).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          })
        )
          throw Error(tr("host.topicNotFoundInTheGogaCatalog"));
      }
      if (
        normalize(
          r.target.remote ? short(r.target.branch) : r.target.branch,
        ) !== r.target.topic
      )
        throw Error(
          tr("host.thisOperationIsOnlyAvailableForTheTopicSOwn"),
        );
      if (r.target.remote && r.action !== "switch")
        throw Error(tr("host.thisOperationRequiresTheTopicSOwnLocalBranch"));
      const own = s.refs.filter(
        (ref) =>
          normalize(ref.remote ? short(ref.name) : ref.name) ===
            r.target!.topic && !ref.remote,
      );
      if (own.length > 1)
        throw Error(tr("host.ambiguousTopicMultipleBranchesClaimOwnership"));
      if (
        r.target.remote &&
        (own.length ||
          s.refs.some((ref) => !ref.remote && ref.name === r.target!.branch))
      )
        throw Error(
          tr("host.switchIsAmbiguousALocalBranchWithTheSameName"),
        );
      const identifier = r.target.branch;
      const args = [...prefix, r.action, identifier];
      if (r.action === "switch" || r.action === "update")
        await d.assertBranchesAvailable?.(
          [r.target.remote ? short(identifier) : identifier],
          r.action,
        );
      if (r.action === "update" || r.action === "propagate") {
        const base = await ensureBase();
        // Mirror Goga exchange._base_branch_names: a literal local
        // "origin/..." branch wins over the remote shorthand. HEAD, full
        // refs, tags and hashes are pinned revisions, not branch aliases.
        const localSpelling = s.refs.some(
          (ref) => !ref.remote && ref.name === base,
        );
        const originAlias = base.startsWith("origin/") && !localSpelling;
        const localBase = originAlias ? short(base) : base;
        const twin = originAlias ? base : `origin/${base}`;
        const branchShaped = s.refs.some((ref) =>
          ref.remote ? ref.name === twin : ref.name === localBase,
        );
        if (branchShaped && localBase === s.current)
          throw Error(
            tr("host.baseBranchLocalbaseIsCurrentlyCheckedOutSwitchToThe", { localBase: localBase }),
          );
        if (r.action === "propagate" && branchShaped)
          await d.assertBranchesAvailable?.([localBase], r.action);
        args.push("--base-ref", base);
        details.push(tr("host.baseBranchBase", { base: base }));
      }
      if (r.action === "update" && r.publish) args.push("--publish");
      if (r.action === "propagate") {
        args.push("--yes");
        details.push(
          tr("host.propagateTheTopicToTheBaseBranchAndPushThe"),
        );
      }
      if (r.action === "publish" || (r.action === "update" && r.publish))
        details.push(tr("host.pushBranchIdentifierToOrigin", { identifier: identifier }));
      if (s.dirty && (r.action === "publish" || r.action === "propagate"))
        details.push(
          tr("host.commitsOnlyUncommittedChangesAreNotIncludedAndRemainIn"),
        );
      details.unshift(`${r.action}: ${r.target.topic} → ${identifier}.`);
      commands.push({ args });
    }
    const after =
      s.kind === "selected-delete" && r.action === "delete"
        ? await readSelectedTopicDeletionSnapshot(d, r.year)
        : await state(d, r.year);
    if (after.revision !== s.revision) throw stale();
    return {
      guards,
      request: r,
      commands,
      save,
      plan: {
        token: randomUUID(),
        projectId: r.projectId,
        year: r.year,
        action: r.action,
        title: {
          create: tr("host.createTopic"),
          switch: tr("host.switchBranch"),
          "save-task": tr("host.saveTask"),
          update: tr("host.updateTopic"),
          publish: tr("host.publishToOrigin"),
          propagate: tr("host.propagateToBase"),
          delete: tr("host.deleteTopics"),
          clear: tr("host.clearTopics"),
        }[r.action],
        details,
        expiresAt: Date.now() + 5 * 60 * 1000,
      },
    };
  }
  private async deletion(
    d: TopicsContext,
    year: string,
    s: State,
    topics: string[],
    details: string[],
    guards: string[],
  ) {
    const prefix = `.goga/history/${year}/`;
    const byCommit = new Map<string, Awaited<ReturnType<typeof hostedSlugs>>>();
    // A local branch and its remote twins frequently point to the same
    // immutable tree; no ref checkout or per-ref duplicate traversal.
    const commits = [...new Set(s.refs.map((ref) => ref.commit))];
    for (let i = 0; i < commits.length; i += treeReadConcurrency) {
      assertReadActive();
      await Promise.all(
        commits.slice(i, i + treeReadConcurrency).map(async (commit) => {
          byCommit.set(commit, await hostedSlugs(d.git, commit, prefix));
        }),
      );
    }
    const onDisk = await topicsOnDisk(
      path.join(d.root ?? d.project.path, prefix),
    );
    const identifiers: string[] = [];
    const removingRefs = new Set<TopicRef>();
    for (const topic of topics) {
      if (normalize(s.current) === topic && d.deletionSwitchFrom !== s.current)
        throw Error(
          tr("host.theTopicForTheCurrentBranchCannotBeRemovedSwitch"),
        );
      const own = s.refs.filter(
          (r) => normalize(r.remote ? short(r.name) : r.name) === topic,
        ),
        local = own.filter((r) => !r.remote),
        origin = own.filter((r) => r.remote && r.name.startsWith("origin/"));
      if (local.length > 1 || origin.length > 1)
        throw Error(tr("host.ambiguousTopicMultipleBranchesClaimOwnership"));
      const directory = path.join(d.root ?? d.project.path, prefix, topic);
      const disk = onDisk(topic);
      const carried = s.refs.some((r) =>
        byCommit.get(r.commit)!.physical.has(topic),
      );
      if (!own.length && carried)
        throw Error(
          tr("host.thisTopicHasNoBranchOfItsOwnOnlyHistory"),
        );
      // No CLI identifier may fall through to prefix matching.
      if (!carried && !disk) throw Error(tr("host.topicTopicNotFound", { topic: topic }));
      if (
        !disk &&
        !s.refs.some((r) => byCommit.get(r.commit)!.visible.has(topic))
      )
        throw Error(
          tr("host.gogaCouldNotIdentifyTopicTopicUnambiguouslyFromFileNames", { topic: topic }),
        );
      // Goga prioritizes exact branch names over normalized slugs. For a
      // colliding name force the verified exact-slug tier: ':' cannot occur
      // in a Git ref and is stripped by Goga's slug normalizer.
      const exact = s.refs.filter(
        (r) => (r.remote ? short(r.name) : r.name) === topic,
      );
      const collides = exact.some((r) =>
        [...byCommit.get(r.commit)!.visible].some((name) => name !== topic),
      );
      identifiers.push(collides ? `:${topic}` : topic);
      if (local[0]) removingRefs.add(local[0]);
      if (origin[0]) removingRefs.add(origin[0]);
      const survivors = s.refs.filter((r) => r !== local[0] && r !== origin[0]);
      const removeDir =
        disk &&
        !survivors.some((r) => byCommit.get(r.commit)!.visible.has(topic));
      if (!local.length && !origin.length && !removeDir)
        throw Error(
          tr("host.thereIsNoRemovableLocalBranchOrMatchingOriginBranch"),
        );
      // Guard the entire removable directory, not only todo.md: CLI recursively removes it.
      if (removeDir) guards.push(await this.guardDirectory(directory));
      details.push(
        tr("host.topicLocalBranchValue2RemoteBranchOriginValue3", { topic: topic, value2: local[0]?.name ?? tr("host.missing"), value3: origin[0] ? short(origin[0].name) : tr("host.missing2") }),
        removeDir
          ? tr("host.removeDirectoryPrefixTopic", { prefix: prefix, topic: topic })
          : tr("host.directoryPrefixTopicWillBeKeptItIsMissingOr", { prefix: prefix, topic: topic }),
      );
    }
    const localBranches = [...removingRefs]
      .filter((ref) => !ref.remote)
      .map((ref) => ref.name);
    if (localBranches.length)
      await d.assertBranchesAvailable?.(localBranches, "delete");
    // Shared history is not ambiguity. Only stop if the whole selection
    // would remove the last carrier of an unselected, non-disk topic.
    const surviving = new Set(topics);
    const dropping = new Set<string>();
    for (const ref of s.refs) {
      const kept = removingRefs.has(ref) ? dropping : surviving;
      for (const name of byCommit.get(ref.commit)!.physical) kept.add(name);
    }
    for (const name of dropping) {
      if (surviving.has(name) || onDisk(name)) continue;
      throw Error(
        tr("host.unselectedTopicNameWouldBeLostBecauseItExistsOnly", { name: name }),
      );
    }
    return identifiers;
  }
  private async guardDirectory(directory: string, depth = 0): Promise<string> {
    assertReadActive();
    if (depth > 32) throw Error(tr("host.theTopicDirectoryIsNestedTooDeeply"));
    await noSymlinks(directory);
    const parts: string[] = [];
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name),
        info = await lstat(file);
      if (entry.isSymbolicLink())
        throw Error(tr("host.linksAreNotSupportedInATopicDirectorySelectedFor"));
      parts.push(
        entry.name,
        JSON.stringify([
          info.ino,
          info.dev,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ]),
      );
      if (entry.isDirectory())
        parts.push(await this.guardDirectory(file, depth + 1));
    }
    return digest(JSON.stringify(parts));
  }
  async execute(
    d: TopicsContext,
    token: string,
    removalState?: TopicMutationSnapshot,
  ): Promise<TopicOperationResult> {
    if (d.deletionSwitchFrom)
      throw Error(
        tr("host.aBranchSwitchPreviewDoesNotAuthorizeRemoval"),
      );
    const id = this.projectForToken(token),
      ticket = this.tickets.get(token)!;
    this.tickets.delete(token);
    if (id !== d.project.id) throw stale();
    const fresh = await this.resolve(d, ticket.request, removalState);
    if (
      JSON.stringify([
        fresh.commands,
        fresh.save,
        fresh.plan.details,
        fresh.guards,
      ]) !==
      JSON.stringify([
        ticket.commands,
        ticket.save,
        ticket.plan.details,
        ticket.guards,
      ])
    )
      throw stale();
    // Recheck after all Git/file validation, outside the mutation error handler:
    // an owner appearing after preview is a rejected admission, not a partial mutation.
    if (["delete", "clear", "update"].includes(ticket.request.action))
      await d.assertPrimaryOwnerAvailable?.(ticket.request);
    let completed = 0;
    try {
      if (fresh.save) {
        const file = path.join(d.root ?? d.project.path, fresh.save.relative);
        await noSymlinks(file);
        await atomicWrite(file, fresh.save.text);
      }
      for (const command of fresh.commands) {
        await d.goga(command.args, command.stdin);
        completed++;
      }
      return {
        projectId: id,
        status: "success",
        message: tr("host.operationCompletedRefreshTheBoardToSeeItsState"),
      };
    } catch {
      // Local refs cannot prove that an origin push failed before taking effect.
      const remoteUncertain =
        ["publish", "propagate", "delete", "clear"].includes(
          ticket.request.action,
        ) || ticket.request.publish === true;
      let changed = completed > 0 || remoteUncertain;
      try {
        // Diagnostics must not refresh the real index after the failed command:
        // a handoff may already pin its physical identity for confirmation.
        const diagnostic = {
          ...d,
          git: (args: string[]) => d.git(["--no-optional-locks", ...args]),
        };
        changed ||=
          (await state(diagnostic, ticket.request.year)).revision !==
          ticket.request.expectedRevision;
      } catch {
        changed = true;
      }
      return {
        projectId: id,
        status: changed ? "partial" : "failed",
        message: changed
          ? tr("host.commandFailedPartialChangesArePossibleThereIsNoAutomatic")
          : tr("host.commandFailedNoChangesDetectedInTheLocalSnapshotCheck"),
      };
    }
  }
}
