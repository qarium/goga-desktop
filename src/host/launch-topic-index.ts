import { t as tr } from "../shared/i18n";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Topic } from "../shared/types";
import { ByteCommandError, RunnerShutdownError, type Runner } from "./process";
import { assertReadActive } from "./read-scope";
import {
  launchTopicInterpreter,
  launchTopicGitPair,
  launchTopicRanksProgram,
} from "./launch-topic-index-provider";

export interface LaunchTopicIndex {
  topics: Topic[];
  branches: string[];
  currentBranch: string;
  /** Private, display-only evidence of a directory at an immutable branch tip. */
  byBranch: ReadonlyMap<string, { topic: string; oid: string }>;
}
interface IndexReads {
  cwd: string;
  year: string;
  git: (args: string[], stdin?: string) => Promise<string>;
  desktopGit?: IndexReads["git"];
  gitBytes: (args: string[], stdin: string) => Promise<Buffer>;
  rank: (groups: string[][]) => Promise<number[]>;
}
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PATH_BYTES = 4 * 1024 * 1024;
const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function unsupported(): never {
  throw Error(tr("host.couldNotPrepareTheFormCatalog"));
}
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
type TreeEntry = { name: string; tree: boolean; id: string };

// for-each-ref + branch produce one logical snapshot. Do not abandon a pending
// sibling process (e.g. when a read is cancelled and goes through the slow path).
function fatalProcessFailure(error: unknown) {
  return (
    error instanceof RunnerShutdownError ||
    (error instanceof ByteCommandError &&
      (!error.processSettled ||
        [
          "aborted",
          "shutdown",
          "timeout",
          "descendants",
          "process-unsettled",
        ].includes(error.reason)))
  );
}

async function readRefs(git: IndexReads["git"]): Promise<[string, string]> {
  const pair = await Promise.allSettled([
    git([
      "for-each-ref",
      "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(HEAD)",
      "refs/heads",
      "refs/remotes",
    ]),
    git(["branch", "--show-current"]),
  ]);
  assertReadActive();
  for (const result of pair)
    if (result.status === "rejected" && fatalProcessFailure(result.reason))
      throw result.reason;
  const [refs, head] = pair;
  if (refs.status === "rejected") throw refs.reason;
  if (head.status === "rejected") throw head.reason;
  assertReadActive();
  return [refs.value, head.value];
}

// The checked-out branch may have a new, deleted, or empty uncommitted topic.
// Use paths only; never open the user's todo or follow links while classifying.
async function workingFiles(
  cwd: string,
  year: string,
  own: string,
): Promise<string[] | undefined> {
  let at = cwd;
  for (const part of [".goga", "history", year, own]) {
    assertReadActive();
    at = path.join(at, part);
    try {
      const item = await lstat(at);
      if (item.isSymbolicLink()) unsupported();
      if (!item.isDirectory()) return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
  const stack: [string, number][] = [["", 0]],
    files: string[] = [];
  let entries = 0,
    bytes = 0;
  while (stack.length) {
    assertReadActive();
    const [parent, depth] = stack.pop()!;
    const dir = path.join(at, parent);
    if (depth > 20 || (await realpath(dir)) !== dir) unsupported();
    for await (const item of await opendir(dir)) {
      assertReadActive();
      if (++entries > 8192) unsupported();
      const rel = parent ? parent + "/" + item.name : item.name;
      bytes += Buffer.byteLength(rel);
      if (bytes > MAX_PATH_BYTES || item.name.includes("\uFFFD")) unsupported();
      if (item.isDirectory()) stack.push([rel, depth + 1]);
      else if (item.isFile()) files.push(rel);
      else unsupported();
    }
    if ((await realpath(dir)) !== dir) unsupported();
  }
  return files;
}
function parseTree(data: Buffer, hashBytes: number): TreeEntry[] {
  const result: TreeEntry[] = [];
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset),
      zero = data.indexOf(0, space + 1);
    if (
      space <= offset ||
      zero <= space + 1 ||
      zero + 1 + hashBytes > data.length ||
      result.length >= 32768
    )
      unsupported();
    const mode = data.toString("ascii", offset, space),
      name = data.toString("utf8", space + 1, zero);
    // Delegate quoted names and submodules instead of projecting names that
    // may not match Goga's text-based ls-tree interpretation.
    if (
      !["40000", "100644", "100755", "120000"].includes(mode) ||
      !/^[\x20-\x7e]+$/.test(name) ||
      /["\\/]/.test(name) ||
      name === "." ||
      name === ".."
    )
      unsupported();
    result.push({
      name,
      tree: mode === "40000",
      id: data.subarray(zero + 1, zero + 1 + hashBytes).toString("hex"),
    });
    offset = zero + 1 + hashBytes;
  }
  return result;
}
function decodeTrees(
  ids: string[],
  data: Buffer,
  cache: Map<string, TreeEntry[]>,
) {
  let off = 0;
  for (const id of ids) {
    const nl = data.indexOf(10, off);
    if (nl < off || nl - off > 100) unsupported();
    const [got, type, size] = data.toString("ascii", off, nl).split(" ");
    const end = nl + 1 + Number(size);
    if (
      got !== id ||
      type !== "tree" ||
      !/^\d+$/.test(size) ||
      end >= data.length ||
      data[end] !== 10
    )
      unsupported();
    cache.set(id, parseTree(data.subarray(nl + 1, end), id.length / 2));
    off = end + 1;
  }
  if (off !== data.length) unsupported();
}
export async function collectLaunchTopicIndex({
  cwd,
  year,
  git,
  gitBytes,
  desktopGit,
  rank,
}: IndexReads): Promise<LaunchTopicIndex> {
  assertReadActive();
  if (!/^\d{4}$/.test(year)) unsupported();
  const [refs, head] = await readRefs(git),
    currentBranch = head.trim();
  if (desktopGit) {
    const [desktopRefs, desktopHead] = await readRefs(desktopGit);
    if (desktopRefs !== refs || desktopHead !== head) unsupported();
  }
  const lines = refs.split("\n").filter(Boolean);
  if (lines.length > 4096) unsupported();
  const branches: string[] = [],
    seen = new Set<string>(),
    rows: Topic[] = [];
  const files = new Map<Topic, string[]>(),
    sources: { row: Topic; id: string; expr: string }[] = [];
  for (const line of lines) {
    const [full, short, id, marker, ...extra] = line.split("\0");
    if (
      extra.length ||
      !short ||
      !oid.test(id) ||
      ![" ", "*"].includes(marker) ||
      /[\x00-\x20\x7f\uFFFD]/.test(short) ||
      short.startsWith("-")
    )
      unsupported();
    const local = full.startsWith("refs/heads/");
    if (!local && !full.startsWith("refs/remotes/")) unsupported();
    if ((local ? full.slice(11) : full.slice(13)) !== short || seen.has(short))
      unsupported();
    seen.add(short);
    if (short.endsWith("/HEAD")) continue;
    branches.push(short);
    if (!local) continue;
    const topic = slug(short),
      current = short === currentBranch;
    if ((marker === "*") !== current) unsupported();
    if (!topic) continue;
    const row = {
      topic,
      branch: short,
      remote: false,
      current,
      todo: "",
      statuses: [],
    };
    rows.push(row);
    if (current) {
      const localFiles = await workingFiles(cwd, year, topic);
      if (localFiles) files.set(row, localFiles);
    } else
      sources.push({
        row,
        id,
        expr: id + ":.goga/history/" + year + "/" + topic,
      });
  }
  // Resolve the own-topic directory of each ref by commit ID in one command.
  // Read only trees, batching a whole level at a time (no history or blobs).
  if (sources.length) {
    const query = sources.map((s) => s.expr).join("\n") + "\n";
    if (Buffer.byteLength(query) > MAX_PATH_BYTES) unsupported();
    const check = (
      await git(
        ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        query,
      )
    )
      .trimEnd()
      .split("\n");
    if (check.length !== sources.length) unsupported();
    type Cursor = { row: Topic; prefix: string; id: string };
    let pending: Cursor[] = [];
    for (let i = 0; i < check.length; i++) {
      const { row, expr } = sources[i];
      if (check[i] === expr + " missing") continue;
      const [id, type] = check[i].split(" ");
      if (!oid.test(id) || !["tree", "blob", "commit"].includes(type))
        unsupported();
      if (type === "tree") {
        files.set(row, []);
        pending.push({ row, id, prefix: "" });
      }
    }
    const cache = new Map<string, TreeEntry[]>();
    let bytes = 0,
      count = 0,
      pathBytes = 0;
    for (let depth = 0; pending.length; depth++) {
      assertReadActive();
      if (depth > 20) unsupported();
      const ids = Array.from(
        new Set(pending.map((p) => p.id).filter((id) => !cache.has(id))),
      );
      if (ids.length) {
        const data = await gitBytes(
          ["cat-file", "--batch"],
          ids.join("\n") + "\n",
        );
        if ((bytes += data.length) > MAX_BYTES) unsupported();
        decodeTrees(ids, data, cache);
      }
      const next: Cursor[] = [];
      for (const { row, id, prefix } of pending)
        for (const entry of cache.get(id)!) {
          const rel = prefix + entry.name;
          if (
            ++count > 32768 ||
            (pathBytes += Buffer.byteLength(rel)) > MAX_PATH_BYTES
          )
            unsupported();
          if (entry.tree) next.push({ row, id: entry.id, prefix: rel + "/" });
          else files.get(row)!.push(rel);
        }
      pending = next;
    }
    for (const { row } of sources)
      if (files.get(row)?.length === 0) files.delete(row);
  }
  const topics = rows.filter((row) => files.has(row));
  assertReadActive();
  const ranks = await rank(topics.map((row) => files.get(row)!));
  if (
    !Array.isArray(ranks) ||
    ranks.length !== topics.length ||
    ranks.some((i) => !Number.isSafeInteger(i) || i < 0)
  )
    unsupported();
  const scores = new Map(topics.map((row, i) => [row, ranks[i]]));
  topics.sort(
    (a, b) =>
      scores.get(a)! - scores.get(b)! ||
      (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0),
  );
  const [lastRefs, lastHead] = await readRefs(git);
  if (lastRefs !== refs || lastHead !== head)
    throw Error(tr("host.branchesChangedWhileBeingReadReload"));
  const byBranch = new Map(
    sources
      .filter((s) => files.has(s.row))
      .map((s) => [s.row.branch, { topic: s.row.topic, oid: s.id }]),
  );
  return { topics, branches, currentBranch, byBranch };
}

export async function readLaunchTopicIndex({
  cwd,
  year,
  executable,
  env,
  gitEnv,
  runner,
}: {
  cwd: string;
  year: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  gitEnv?: NodeJS.ProcessEnv;
  runner: Runner;
}): Promise<LaunchTopicIndex | undefined> {
  assertReadActive();
  if (!runner.commandBytes) return;
  const python = await launchTopicInterpreter(cwd, executable, env);
  assertReadActive();
  if (!python) return;
  const pair = await launchTopicGitPair(env.PATH ?? "", gitEnv?.PATH);
  assertReadActive();
  if (!pair) return;
  const run = runner.commandBytes.bind(runner);
  let hooksMayHaveRun = false;
  const bytes = async (args: string[], stdin?: string, desktop = false) => {
    assertReadActive();
    const result = await run({
      executable: (desktop ? pair.desktopGit : pair.catalogGit) ?? "git",
      args,
      cwd,
      env: {
        ...gitEnv,
        ...(!desktop && pair.catalogGit ? { PATH: env.PATH } : {}),
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
      },
      stdin: stdin === undefined ? undefined : Buffer.from(stdin),
      maxOutputBytes: MAX_BYTES,
    });
    if (result.exitCode !== 0 || result.signal) unsupported();
    return result.stdout;
  };
  try {
    // Unsupported providers should pay only for their own catalog, not first
    // for our Git traversal. Probe package metadata without loading any Goga
    // modules/hooks. Ranking checks the version again in case of an upgrade.
    const probe = await run({
      executable: python,
      args: ["-IB", "-c", launchTopicRanksProgram, "--check-version"],
      cwd,
      env,
      maxOutputBytes: 4096,
    });
    assertReadActive();
    if (probe.exitCode !== 0 || probe.signal) return undefined;
    return await collectLaunchTopicIndex({
      cwd,
      year,
      git: async (args, stdin) => (await bytes(args, stdin)).toString("utf8"),
      gitBytes: bytes,
      desktopGit: pair.desktopGit
        ? async (args, stdin) =>
            (await bytes(args, stdin, true)).toString("utf8")
        : undefined,
      rank: async (groups) => {
        const input = Buffer.from(JSON.stringify(groups));
        if (input.length > MAX_PATH_BYTES) unsupported();
        assertReadActive();
        hooksMayHaveRun = true;
        const r = await run({
          executable: python,
          args: ["-IB", "-c", launchTopicRanksProgram],
          cwd,
          env,
          stdin: input,
          maxOutputBytes: 1024 * 1024,
        });
        assertReadActive();
        if (r.exitCode === 74 && !r.signal) {
          hooksMayHaveRun = false;
          unsupported();
        }
        if (r.exitCode !== 0 || r.signal)
          throw Error(
            tr("host.couldNotReadGogaTopicConfigurationOrStatusesCheckThe"),
          );
        try {
          return JSON.parse(r.stdout.toString("utf8"));
        } catch {
          throw Error(tr("host.gogaReturnedInvalidStatusRankings"));
        }
      },
    });
  } catch (e) {
    assertReadActive();
    if (fatalProcessFailure(e)) throw e;
    if (hooksMayHaveRun) throw e;
    return undefined;
  }
}
