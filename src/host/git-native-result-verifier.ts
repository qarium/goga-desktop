import * as fs from "node:fs/promises";
import path from "node:path";
import { noSymlinks } from "./settings";
import type { createNativeGitClient } from "./git-native-client";
import {
  fingerprintNativeGitControls,
  type NativeGitState,
} from "./git-native-state";
import { ByteCommandError, type ByteCommandResult } from "./process";
import type { NativeSequenceStart } from "./git-native-sequence";
import { gitFilePathSchema } from "../shared/git-workspace";

type Client = Awaited<ReturnType<typeof createNativeGitClient>>;
const invalid = () =>
  Error(
    "Результат Git не совпадает с подтверждённой операцией. Данные и журнал сохранены.",
  );
const text = (bytes: Buffer) =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
function settled(result: ByteCommandResult) {
  if (!result.processSettled || result.signal !== null)
    throw new ByteCommandError(
      "process-unsettled",
      result.processSettled,
      result.stdout,
      result.stderr,
      result.exitCode,
      result.signal,
    );
  if (result.exitCode !== 0) throw invalid();
  return text(result.stdout);
}
/** Only the documented interactive editor interface, never private todo parsing.
 * Subjects are inert descriptions; commands and source object identities matter. */
export function validatePublicRebasePlan(
  plan: string,
  sources: string[],
  current: string,
) {
  if (
    Buffer.byteLength(plan) > 1024 * 1024 ||
    sources.length > 256 ||
    !sources.includes(current) ||
    plan.includes("\0")
  )
    throw invalid();
  let previous = sources.indexOf(current);
  const commands = plan
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (commands.length === 1 && commands[0] === "noop") return;
  for (const line of commands) {
    const match = /^(?:pick|p) ([a-f0-9]{4,64})(?:[ \t].*)?$/.exec(line);
    if (!match) throw invalid();
    const matches = sources
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => id.startsWith(match[1]));
    if (matches.length !== 1 || matches[0].index <= previous) throw invalid();
    previous = matches[0].index;
  }
}
/** Git may create its editor backup on the first public inspection. A second
 * inspection must leave the opaque controls unchanged; bind its output to that
 * stable seal rather than trusting an arbitrary first post-command snapshot. */
export async function inspectNativeRebasePlan(
  client: Client,
  root: string,
  source: string,
  original: string,
) {
  const sources = settled(
    await client.run({
      policy: "local-read",
      command: "rev-list",
      args: ["--reverse", `${source}..${original}`],
    }),
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const current = settled(
    await client.run({
      policy: "local-read",
      command: "rev-parse",
      args: ["--verify", "REBASE_HEAD^{commit}"],
    }),
  ).trim();
  await fingerprintNativeGitControls(root); // bounded/no symlink audit before invoking the editor interface
  validatePublicRebasePlan(
    settled(await client.run({ policy: "rebase-plan", command: "rebase" })),
    sources,
    current,
  );
  const before = await fingerprintNativeGitControls(root);
  const plan = settled(
    await client.run({ policy: "rebase-plan", command: "rebase" }),
  );
  const after = await fingerprintNativeGitControls(root);
  if (before !== after) throw invalid();
  validatePublicRebasePlan(plan, sources, current);
  return after;
}
/** AUTO_MERGE is Git's documented worktree-result tree, including conflict
 * markers. Compare against it, never against a Desktop recreation of a merge.
 * Returns false only when Git has no such witness (e.g. older apply backend). */
export async function verifyNativeAutoMerge(
  client: Client,
  after: NativeGitState,
  conflicts: string[],
) {
  const found = await client.run({
    policy: "local-read",
    command: "rev-parse",
    args: ["--verify", "--quiet", "AUTO_MERGE^{tree}"],
  });
  if (
    found.processSettled &&
    found.signal === null &&
    found.exitCode === 1 &&
    !found.stdout.length &&
    !found.stderr.length
  )
    return false;
  const tree = settled(found).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw invalid();
  const raw = settled(
    await client.run({
      policy: "local-read",
      command: "ls-tree",
      args: ["-r", "-z", "--full-tree", tree],
    }),
  );
  const expected = new Map<string, string>();
  for (const row of raw.split("\0").filter(Boolean)) {
    const m =
      /^(100644|100755|120000) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/s.exec(
        row,
      );
    if (!m) throw invalid();
    expected.set(gitFilePathSchema.parse(m[3]), `${m[1]} ${m[2]}`);
  }
  const stage0 = new Map<string, string>();
  for (const row of text(Buffer.from(after.indexData, "base64"))
    .split("\0")
    .filter(Boolean)) {
    const m = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/s.exec(row);
    if (!m) throw invalid();
    if (m[3] === "0")
      stage0.set(gitFilePathSchema.parse(m[4]), `${m[1]} ${m[2]}`);
  }
  const unresolved = new Set(conflicts);
  for (const p of new Set([...expected.keys(), ...stage0.keys()]))
    if (!unresolved.has(p) && expected.get(p) !== stage0.get(p))
      throw invalid();
  // Native diff handles Git's own EOL/text conversions; no external textconv or
  // diff helpers are allowed. It also catches a staged edit mirrored on disk.
  const changed = settled(
    await client.run({
      policy: "local-read",
      command: "diff",
      args: ["--no-ext-diff", "--no-textconv", "--name-only", "-z", tree, "--"],
    }),
  );
  if (changed.length) throw invalid();
  return true;
}

const objectId = (value: string) => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw invalid();
  return value;
};
function indexRows(raw: string) {
  if (raw && !raw.endsWith("\0")) throw invalid();
  const rows = new Map<string, string>();
  const paths = new Set<string>();
  for (const row of raw.split("\0").filter(Boolean)) {
    const m =
      /^(100644|100755|120000) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/s.exec(
        row,
      );
    if (!m) throw invalid();
    const name = gitFilePathSchema.parse(m[4]);
    const key = `${m[3]}\0${name}`;
    if (rows.has(key)) throw invalid();
    rows.set(key, row);
    if (m[3] !== "0") paths.add(name);
  }
  for (const p of paths) if (rows.has(`0\0${p}`)) throw invalid();
  return {
    allRows: [...rows.values()].sort(),
    paths: [...paths].sort(),
  };
}
/** Compare all documented ls-files --stage -z records, including stage 0.
 * Neither the source conflict list nor its AUTO_MERGE is an independent witness. */
export function verifyNativeConflictIndex(
  expectedIndex: string,
  actualIndex: string,
) {
  const expected = indexRows(expectedIndex),
    actual = indexRows(actualIndex);
  if (
    !expected.paths.length ||
    JSON.stringify(expected.allRows) !== JSON.stringify(actual.allRows)
  )
    throw invalid();
  return expected.paths;
}
/** Independent native witness: one stopped step in a disposable repository.
 * Git owns algorithms, apply policy and generated conflict labels. Never import
 * its index/ref/worktree into the project, and never trust the project's mutable
 * conflict list (or AUTO_MERGE alone) as evidence of conflict membership. */
export async function verifyNativeConflictStages(
  client: Client,
  after: NativeGitState,
  before: NativeGitState,
  origin: NativeSequenceStart,
  original: string,
  unrelated: readonly string[] = [],
) {
  const read = async (command: "rev-parse" | "rev-list", args: string[]) =>
    settled(await client.run({ policy: "local-read", command, args })).trim();
  const ours = objectId(after.head ?? "");
  let current: string | undefined, parent: string | undefined;
  if (origin.operation === "merge") {
    if (ours !== objectId(original)) throw invalid();
  } else {
    const marker =
      origin.operation === "rebase"
        ? "REBASE_HEAD"
        : origin.operation === "revert"
          ? "REVERT_HEAD"
          : "CHERRY_PICK_HEAD";
    current = objectId(
      await read("rev-parse", ["--verify", `${marker}^{commit}`]),
    );
    const sources =
      origin.operation === "rebase"
        ? (
            await read("rev-list", [
              "--reverse",
              `${origin.source}..${original}`,
            ])
          )
            .split("\n")
            .filter(Boolean)
            .map(objectId)
        : origin.commits;
    if (sources.length > 256 || !sources.includes(current)) throw invalid();
    const parents = (await read("rev-list", ["--parents", "-n", "1", current]))
      .split(" ")
      .map(objectId);
    if (parents[0] !== current || parents.length > 2) throw invalid();
    parent = parents[1];
  }
  return client.inTemporaryRepository(async (isolated, root) => {
    // Untracked/ignored attributes are admitted and guarded too. Reuse their
    // sealed bytes, not mutable live files, so native replay sees the same policy.
    for (const file of after.files) {
      if (
        path.posix.basename(file.path) !== ".gitattributes" ||
        file.data === null
      )
        continue;
      const filename = path.join(root, gitFilePathSchema.parse(file.path));
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await noSymlinks(path.dirname(filename));
      await fs.writeFile(filename, Buffer.from(file.data, "base64"), {
        flag: "wx",
        mode: 0o600,
      });
    }
    settled(
      await isolated.run({
        policy: "local-write",
        command: "switch",
        args: ["--detach", ours],
      }),
    );
    const replay =
      origin.operation === "rebase" && origin.backend === "apply"
        ? await isolated.run({
            policy: "local-write",
            command: "rebase",
            args: [
              "--apply",
              "--no-autostash",
              "--no-update-refs",
              "--no-fork-point",
              "--no-verify",
              "--onto",
              ours,
              ...(parent ? [parent] : ["--root"]),
              current!,
            ],
          })
        : origin.operation === "merge"
          ? await isolated.run({
              policy: "local-write",
              command: "merge",
              args: [
                "--ff",
                "--commit",
                "--no-edit",
                "--no-squash",
                "--no-autostash",
                "--no-overwrite-ignore",
                "--no-verify-signatures",
                "--no-stat",
                "--strategy=ort",
                "--",
                origin.source,
              ],
            })
          : await isolated.run({
              policy: "local-write",
              command: origin.operation === "revert" ? "revert" : "cherry-pick",
              args: ["--no-commit", current!],
            });
    if (!replay.processSettled || replay.signal !== null) settled(replay);
    if (replay.exitCode !== 1) throw invalid();
    const raw = settled(
      await isolated.run({
        policy: "local-read",
        command: "ls-files",
        args: ["--stage", "-z"],
      }),
    );
    const conflicts = verifyNativeConflictIndex(
      raw,
      text(Buffer.from(after.indexData, "base64")),
    );
    const originalRows = new Set(
      indexRows(text(Buffer.from(before.indexData, "base64"))).allRows,
    );
    const unchanged = new Set(
      indexRows(raw)
        .allRows.filter((row) => row.includes(" 0\t") && originalRows.has(row))
        .map((row) => row.slice(row.indexOf("\t") + 1)),
    );
    const originalFiles = new Map(
      before.files.map((file) => [file.path, file]),
    );
    // Apply on older Git has no AUTO_MERGE. Compare the native worktree too,
    // including stage-0 paths, without accepting forged index flags/diff output.
    const ignored = new Set(unrelated);
    for (const file of after.files) {
      if (ignored.has(file.path)) continue; // original untracked/ignored bytes are checked separately
      const filename = path.join(root, gitFilePathSchema.parse(file.path));
      let data: string | null = null,
        mode: number | null = null;
      try {
        await noSymlinks(filename);
        const stat = await fs.lstat(filename);
        if (!stat.isFile()) throw invalid();
        data = (await fs.readFile(filename)).toString("base64");
        mode = stat.mode & 0o777;
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
      const originalFile = originalFiles.get(file.path);
      // An unchanged stage-0 file must retain its approved permissions even
      // when a post-stop chmod happens to match a fresh checkout's default mode.
      if (unchanged.has(file.path) && originalFile?.mode !== file.mode)
        throw invalid();
      if (mode !== file.mode) {
        // A clean existing file may have non-default permissions (including
        // core.fileMode=false). Preserve ONLY its exact approved representation.
        // Changed/conflicted paths must match the independently generated mode.
        if (
          !unchanged.has(file.path) ||
          !originalFile ||
          originalFile.mode !== file.mode ||
          originalFile.data !== file.data
        )
          throw invalid();
      }
      if (data !== file.data) {
        if (data === null || file.data === null) throw invalid();
        // A fresh checkout can use different EOLs than an existing clean file.
        // Git owns canonicalization; external filters were denied at admission.
        const hash = async (bytes: string) =>
          objectId(
            settled(
              await isolated.run({
                policy: "local-write",
                command: "hash-object",
                args: ["--path", file.path, "--stdin"],
                stdin: Buffer.from(bytes, "base64"),
              }),
            ).trim(),
          );
        if ((await hash(data)) !== (await hash(file.data))) throw invalid();
      }
    }
    return conflicts;
  });
}
