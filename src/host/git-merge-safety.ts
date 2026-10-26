import { withFrozenGitConfigScope } from "./git-private-read-scope";
import { createHash, randomUUID } from "node:crypto";
import { constants, renameSync, unlinkSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  scopeProjectId,
  scopeRefSchema,
  type ScopeRef,
} from "../shared/context";
import {
  type GitBranchInventory,
  type GitBranchRef,
} from "../shared/git-branches";
import {
  gitFilePathSchema,
  type GitWorkspaceSnapshot,
} from "../shared/git-workspace";
import { noSymlinks } from "./settings";
import { CommandExitError } from "./process";
export interface GitMergeContext {
  scope: ScopeRef;
  root: string;
  ownerKey: string;
  /** Host-bound settings redaction; never a renderer capability. */
  sanitizeDiagnostics?(value: string): string;
  snapshot(): Promise<GitWorkspaceSnapshot>;
  verify(): Promise<void>;
  git(
    args: string[],
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string }>;
  /** Host-only private index capability; never supplied by the renderer. */
  privateGit?(
    args: string[],
    indexFile: string,
  ): Promise<{ stdout: string; stderr: string }>;
}
export type Row = [string, string];
export interface State {
  inventory: GitBranchInventory;
  snapshot: GitWorkspaceSnapshot;
  config: Row[];
  worktrees: string;
  fingerprint: string;
  anchor: string;
  workspace: string;
  content: Row[];
}
export interface MergeDestinations {
  current: Set<string>;
  incoming: string[];
  tracked: Set<string>;
  original?: { paths: Set<string>; conflicts: Set<string> };
}
export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const stale = () =>
  Error(
    "Предпросмотр Git устарел или изменился владелец. Обновите список и подтвердите заново.",
  );
const safeArgs = [
  "--no-pager",
  "--literal-pathspecs",
  "--no-replace-objects",
  "--no-optional-locks",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.preloadIndex=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "diff.external=",
  "-c",
  "submodule.recurse=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "color.ui=false",
];
export const mergeFiles = [
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "MERGE_AUTOSTASH",
  "AUTO_MERGE",
  "ORIG_HEAD",
];
export const mixedOperations = [
  "rebase-merge",
  "rebase-apply",
  "sequencer",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
];
export const oid = (value: string) => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
    throw Error("Некорректный OID Git.");
  return value;
};
const rows = (raw: string): Row[] =>
  raw
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const i = row.indexOf("\n");
      return [i < 0 ? row : row.slice(0, i), i < 0 ? "" : row.slice(i + 1)];
    });
export async function stat(file: string) {
  return fs.lstat(file, { bigint: true }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}
const stamp = (s: Awaited<ReturnType<typeof stat>>) =>
  s
    ? [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":")
    : "missing";
export async function fileIdentity(file: string) {
  const s = await stat(file);
  if (!s) return "missing";
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.nlink !== 1n ||
    s.size > 256n * 1024n * 1024n
  )
    throw Error("Небезопасные метаданные Git.");
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (stamp(await handle.stat({ bigint: true })) !== stamp(s)) throw stale();
    const bytes = await handle.readFile();
    if (stamp(await stat(file)) !== stamp(s)) throw stale();
    return `${stamp(s)}:${digest(bytes)}`;
  } finally {
    await handle.close();
  }
}
/** Bind dirty content as well as timestamps, without following worktree symlinks. */
export async function contentIdentity(file: string): Promise<string> {
  const before = await stat(file);
  if (!before) return "missing";
  let value: string;
  if (before.isSymbolicLink()) value = `link:${await fs.readlink(file)}`;
  else if (before.isDirectory()) value = "directory";
  else {
    if (!before.isFile() || before.size > 256n * 1024n * 1024n)
      throw Error("Файл превышает безопасный предел проверки содержимого Git.");
    const handle = await fs.open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (stamp(await handle.stat({ bigint: true })) !== stamp(before))
        throw stale();
      value = digest(await handle.readFile());
    } finally {
      await handle.close();
    }
  }
  if (stamp(await stat(file)) !== stamp(before)) throw stale();
  return value;
}
/** Additional write destinations (logs, config, objects, ORIG_HEAD) are audited;
 * GitWorkspaceReader separately enforces supported gitdir/index/object topology. */
export async function auditMetadata(root: string) {
  let count = 0;
  const visit = async (file: string, depth: number): Promise<void> => {
    const s = await stat(file);
    if (!s) return;
    if (
      ++count > 100000 ||
      depth > 20 ||
      s.isSymbolicLink() ||
      (!s.isDirectory() && (!s.isFile() || s.nlink !== 1n))
    )
      throw Error("Небезопасная ссылка или тип записываемых метаданных Git.");
    if (s.isDirectory())
      for (const name of await fs.readdir(file))
        await visit(path.join(file, name), depth + 1);
  };
  await visit(path.join(root, ".git"), 0);
}
/** Cleanup failure is not evidence that the protected action did not run. */
export class GitMetadataLockCleanupError extends Error {
  constructor(
    readonly lock: string,
    readonly retained: boolean,
    cause: unknown,
    readonly unchecked = false,
  ) {
    super(
      `Не подтверждена очистка блокировки ${lock}: ${cause instanceof Error ? cause.message : String(cause)}${unchecked ? ". Состояние блокировки не удалось проверить." : ""}`,
      { cause },
    );
  }
}
/** Preserve only our typed cleanup facts across sanitizing Host boundaries.
 * Arbitrary thrown objects never gain trusted lock metadata. No raw cause survives. */
export function preserveGitMergeCleanupError(
  error: unknown,
  message: string,
): Error {
  if (!(error instanceof GitMetadataLockCleanupError)) return Error(message);
  const clean = new GitMetadataLockCleanupError(
    error.lock,
    error.retained,
    message,
    error.unchecked,
  );
  clean.message = message;
  return clean;
}
/** Shared safety only: this base has no public mutation or branch authority. */
export class GitMergeSafety {
  /** A failed diagnostic read must never replace known operation effects. */
  protected async recoveryDiagnostics<
    T extends {
      recoveryPath?: string;
      recoveryUnverified?: boolean;
      log: string;
    },
  >(result: T): Promise<T> {
    if (!result.recoveryPath) return result;
    const value = { ...result };
    try {
      if (!(await stat(value.recoveryPath!))) delete value.recoveryPath;
      delete value.recoveryUnverified;
    } catch (error) {
      value.recoveryUnverified = true;
      value.log += `\nНе удалось проверить последний известный путь материалов восстановления: ${error instanceof Error ? error.message : String(error)}`;
    }
    return value;
  }
  /** Called only while our config pin is held, before its retain decision. */
  protected holdConfigForUnknown<
    T extends {
      lockRetained?: boolean;
      retainedLocks?: string[];
      uncheckedLocks?: string[];
      recoveryUnverified?: boolean;
    },
  >(result: T): T {
    if (!result.uncheckedLocks?.length && !result.recoveryUnverified)
      return result;
    return {
      ...result,
      lockRetained: true,
      retainedLocks: [
        ...new Set([...(result.retainedLocks ?? []), "config.lock"]),
      ],
    };
  }

  protected args(ctx: GitMergeContext, args: string[]) {
    return [
      ...safeArgs,
      `--git-dir=${path.join(ctx.root, ".git")}`,
      `--work-tree=${ctx.root}`,
      ...args,
    ];
  }
  protected git(ctx: GitMergeContext, args: string[], stdin?: string) {
    return ctx.git(this.args(ctx, args), stdin);
  }
  protected async capture(
    ctx: GitMergeContext,
    scope: ScopeRef,
  ): Promise<State> {
    if (
      JSON.stringify(scopeRefSchema.parse(ctx.scope)) !==
        JSON.stringify(scopeRefSchema.parse(scope)) ||
      !path.isAbsolute(ctx.root) ||
      path.resolve(ctx.root) !== ctx.root
    )
      throw Error("Область операции Git не соответствует владельцу.");
    await ctx.verify();
    const snapshot = await ctx.snapshot();
    if (
      snapshot.root !== ctx.root ||
      JSON.stringify(snapshot.scope) !== JSON.stringify(scope)
    )
      throw stale();
    const config = rows(
      (await this.git(ctx, ["config", "--null", "--list"])).stdout,
    );
    const raw = (
      await this.git(ctx, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(symref)%00%(upstream)",
        "refs/heads/",
        "refs/remotes/",
      ])
    ).stdout;
    const worktrees = (
      await this.git(ctx, ["worktree", "list", "--porcelain", "-z"])
    ).stdout;
    const checked = new Set(
      worktrees
        .split("\0")
        .filter((v) => v.startsWith("branch "))
        .map((v) => v.slice(7)),
    );
    const local: GitBranchRef[] = [],
      remote: GitBranchRef[] = [];
    for (const line of raw.split("\n").filter(Boolean)) {
      const [ref, object, symref, upstream, ...rest] = line.split("\0");
      if (rest.length || upstream === undefined)
        throw Error("Некорректный список веток Git.");
      if (symref) continue;
      const target = ref.startsWith("refs/heads/")
        ? local
        : ref.startsWith("refs/remotes/")
          ? remote
          : null;
      if (!target) throw Error("Неожиданная ссылка Git.");
      target.push({
        ref,
        name: ref.slice(target === local ? 11 : 13),
        oid: oid(object),
        upstream: upstream || null,
        checkedOut: checked.has(ref),
      });
    }
    const files = [];
    const content: Row[] = [];
    for (const f of snapshot.files)
      for (const p of [f.path, ...(f.originalPath ? [f.originalPath] : [])]) {
        files.push([p, stamp(await stat(path.join(ctx.root, p)))]);
        content.push([p, await contentIdentity(path.join(ctx.root, p))]);
      }
    const mergeMetadata = [];
    for (const name of [...mergeFiles, "info/attributes"])
      mergeMetadata.push([
        name,
        await fileIdentity(path.join(ctx.root, ".git", name)),
      ]);
    for (const name of mixedOperations)
      mergeMetadata.push([
        name,
        stamp(await stat(path.join(ctx.root, ".git", name))),
      ]);
    const head = await fileIdentity(path.join(ctx.root, ".git/HEAD")),
      index = await fileIdentity(path.join(ctx.root, ".git/index"));
    const after = await ctx.snapshot();
    if (after.revision !== snapshot.revision) throw stale();
    await ctx.verify();
    const { revision: _revision, ...semantic } = snapshot;
    const fingerprint = digest(
      JSON.stringify([
        ctx.ownerKey,
        semantic,
        config,
        raw,
        worktrees,
        files,
        content,
        mergeMetadata,
        head,
        index,
      ]),
    );
    const {
      ahead: _ahead,
      behind: _behind,
      upstream: _upstream,
      ...stable
    } = semantic;
    const workspace = digest(
      JSON.stringify([
        ctx.ownerKey,
        stable,
        worktrees,
        files,
        content,
        mergeMetadata,
        head,
        index,
      ]),
    );
    const anchor = digest(JSON.stringify([workspace, config]));
    return {
      snapshot,
      content,
      config,
      worktrees,
      fingerprint,
      anchor,
      workspace,
      inventory: {
        projectId: scopeProjectId(scope),
        root: ctx.root,
        revision: fingerprint,
        head: snapshot.head,
        branch: snapshot.branch,
        upstream: snapshot.upstream,
        dirty: snapshot.files.length > 0,
        operation: snapshot.operation,
        local,
        remote,
      },
    };
  }
  /** The reader deliberately never enters submodules. Until a separately audited
   * submodule policy exists, tree-changing mutations reject gitlinks rather
   * than treating ignored nested dirt as a clean parent workspace. */
  protected async assertNoGitlinks(
    ctx: GitMergeContext,
    objects: (string | null)[],
  ) {
    const fail = () =>
      Error(
        "Переключение и pull для деревьев с подмодулями (gitlink) пока не поддерживаются: состояние подмодулей не проверяется.",
      );
    const index = (await this.git(ctx, ["ls-files", "--stage", "-z"])).stdout;
    if (index.split("\0").some((row) => row.startsWith("160000 ")))
      throw fail();
    for (const object of new Set(
      objects.filter((value): value is string => value !== null),
    )) {
      const tree = (await this.git(ctx, ["ls-tree", "-r", "-z", oid(object)]))
        .stdout;
      if (tree.split("\0").some((row) => row.startsWith("160000 ")))
        throw fail();
    }
  }
  /** Host-only test seam, not part of any renderer request. */
  protected releaseLockFault(_name: string, _phase: "before" | "after"): void {}
  protected async withMetadataLock<T>(
    ctx: GitMergeContext,
    name: string,
    fn: () => Promise<T>,
    retain: () => boolean = () => false,
  ): Promise<T> {
    const file = path.join(ctx.root, ".git", name);
    await noSymlinks(file);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await noSymlinks(file);
    const handle = await fs.open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const owned = await handle.stat();
    try {
      return await fn();
    } finally {
      try {
        await handle.close();
        if (!retain()) {
          this.releaseLockFault(name, "before");
          const current = await fs.lstat(file).catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (current?.dev === owned.dev && current.ino === owned.ino)
            await fs.unlink(file);
          this.releaseLockFault(name, "after");
        }
      } catch (error) {
        let current: Awaited<ReturnType<typeof fs.lstat>> | null = null,
          unchecked = false;
        try {
          current = await fs.lstat(file);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ENOENT")
            unchecked = true;
        }
        throw new GitMetadataLockCleanupError(
          name,
          current?.dev === owned.dev && current.ino === owned.ino,
          error,
          unchecked,
        );
      }
    }
  }

  /** A native pending merge, not merely a status label or a failed command. */
  protected async mergeState(ctx: GitMergeContext, state: State) {
    if (state.snapshot.operation !== "merge" || !state.snapshot.head)
      throw Error("Отмена доступна только для незавершённого слияния Git.");
    for (const name of [...mixedOperations, "MERGE_AUTOSTASH"])
      if (await stat(path.join(ctx.root, ".git", name)))
        throw Error(
          "Смешанная операция Git или внешний autostash: автоматическая отмена запрещена.",
        );
    const readOid = async (name: string) => {
      const file = path.join(ctx.root, ".git", name);
      await fileIdentity(file);
      return oid((await fs.readFile(file, "utf8")).trim());
    };
    const source = await readOid("MERGE_HEAD"),
      original = await readOid("ORIG_HEAD");
    if (original !== state.snapshot.head)
      throw Error(
        "ORIG_HEAD не совпадает с текущим HEAD: безопасная отмена слияния невозможна.",
      );
    for (const object of [source, original])
      if (
        (await this.git(ctx, ["cat-file", "-t", object])).stdout.trim() !==
        "commit"
      )
        throw Error("Метаданные слияния не указывают на коммит.");
    const unmerged = (await this.git(ctx, ["ls-files", "--unmerged", "-z"]))
      .stdout;
    const paths = new Set<string>();
    for (const row of unmerged.split("\0").filter(Boolean)) {
      const match = /^\d{6} [a-f0-9]+ [123]\t(.+)$/s.exec(row);
      if (!match) throw Error("Некорректный конфликтный индекс Git.");
      paths.add(match[1]);
    }
    return { source, conflictCount: paths.size };
  }
  protected async treePaths(ctx: GitMergeContext, object: string) {
    return (
      await this.git(ctx, ["ls-tree", "-r", "--name-only", "-z", object])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .map((name) => gitFilePathSchema.parse(name));
  }
  /** Bind actual attributes, not guessed HOME paths: Git resolves configured,
   * XDG/global and system sources. The dependency contents also cover policies
   * for synthetic ORT paths that were not known during preview. */
  protected async mergeAttributes(
    ctx: GitMergeContext,
    head: string,
    source: string,
    extraPaths: string[] = [],
  ) {
    const paths = [
      ...new Set([
        ...(await this.treePaths(ctx, head)),
        ...(await this.treePaths(ctx, source)),
        ...(await this.git(ctx, ["ls-files", "-z"])).stdout
          .split("\0")
          .filter(Boolean)
          .map((name) => gitFilePathSchema.parse(name)),
      ]),
    ].sort();
    const files = new Set([
      path.join(ctx.root, ".git/info/attributes"),
      path.join(ctx.root, ".gitattributes"),
    ]);
    for (const name of [...paths, ...extraPaths]) {
      let parent = path.posix.dirname(name);
      while (parent !== ".") {
        files.add(path.join(ctx.root, parent, ".gitattributes"));
        parent = path.posix.dirname(parent);
      }
    }
    for (const variable of ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"]) {
      let raw: string;
      try {
        raw = (await this.git(ctx, ["var", variable])).stdout.replace(
          /\r?\n$/,
          "",
        );
      } catch {
        throw Error(
          "Установленный Git не умеет безопасно определять источники attributes. Обновите Git для слияния.",
        );
      }
      if (!raw || /[\0\r\n]/.test(raw))
        throw Error("Недопустимый путь attributes Git.");
      if (raw !== "/dev/null") files.add(path.resolve(ctx.root, raw));
    }
    const sources: Row[] = [];
    for (const file of [...files].sort()) {
      let identity: string;
      try {
        await noSymlinks(file);
        identity = await fileIdentity(file);
      } catch (error) {
        // A merge may replace a tracked file with a directory. There cannot be
        // a current attributes source beneath that ordinary file.
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        throw error;
      }
      // New synthetic directories without attributes are not extra policy.
      if (identity !== "missing") sources.push([file, identity]);
    }
    const effective = (
      await this.git(
        ctx,
        ["check-attr", "--all", "-z", "--stdin"],
        paths.length ? `${paths.join("\0")}\0` : "",
      )
    ).stdout;
    return digest(JSON.stringify([sources, effective]));
  }
  /** ORT can overwrite ignored files even with --no-overwrite-ignore (including
   * synthesized directory-rename/conflict paths). After confirmation only,
   * compute the same tree without touching refs, index or worktree. Git may add
   * immutable objects; this is not a trial merge or a rollback. */
  protected async protectMergeDestinations(
    ctx: GitMergeContext,
    state: State,
    source: string,
    options: string[],
  ) {
    let output: string;
    try {
      output = (
        await this.git(ctx, [
          ...options,
          "merge-tree",
          "--write-tree",
          "--no-messages",
          "-z",
          "HEAD",
          source,
        ])
      ).stdout;
    } catch (error) {
      if (!(error instanceof CommandExitError) || error.exitCode !== 1)
        throw error;
      output = error.stdout;
    }
    const tree = oid(output.split("\0")[0]);
    const conflicts = new Set<string>();
    for (const row of output.split("\0").slice(1).filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]+) [123]\t(.+)$/s.exec(row);
      if (!match)
        throw Error("Неподдерживаемый вывод merge-tree; операция остановлена.");
      oid(match[2]);
      conflicts.add(gitFilePathSchema.parse(match[3]));
    }
    return {
      tree,
      conflicts,
      current: new Set(await this.treePaths(ctx, state.snapshot.head!)),
      incoming: await this.treePaths(ctx, tree),
    };
  }
  protected async indexPaths(ctx: GitMergeContext) {
    return (await this.git(ctx, ["ls-files", "-z"])).stdout
      .split("\0")
      .filter(Boolean)
      .map((name) => gitFilePathSchema.parse(name));
  }
  /** Native --abort discards staged edits too. Only the original conflict paths
   * are explicitly disposable. AUTO_MERGE must authenticate the reproduced
   * baseline; changed policies, old/external unsupported merges fail closed. */
  protected async assertAbortIndex(
    ctx: GitMergeContext,
    expected: { tree: string; conflicts: Set<string> },
  ) {
    const auto = path.join(ctx.root, ".git/AUTO_MERGE");
    if ((await fileIdentity(auto)) === "missing")
      throw Error(
        "Отсутствует исходное дерево AUTO_MERGE. Безопасная отмена без риска потери изменений не подтверждена.",
      );
    if (oid((await fs.readFile(auto, "utf8")).trim()) !== expected.tree)
      throw Error(
        "Исходное слияние нельзя воспроизвести: изменились attributes/настройки или исходная операция не поддерживается. Операция не выполнялась; индекс, ветки и рабочие файлы не изменялись.",
      );
    const baseline = new Map<string, string>();
    for (const row of (
      await this.git(ctx, ["ls-tree", "-r", "-z", expected.tree])
    ).stdout
      .split("\0")
      .filter(Boolean)) {
      const match = /^(\d{6}) blob ([a-f0-9]+)\t(.+)$/s.exec(row);
      if (!match) throw Error("Неподдерживаемое исходное дерево слияния.");
      baseline.set(
        gitFilePathSchema.parse(match[3]),
        `${match[1]} ${oid(match[2])}`,
      );
    }
    const actual = new Map<string, string>();
    for (const row of (
      await this.git(ctx, ["ls-files", "--stage", "-z"])
    ).stdout
      .split("\0")
      .filter(Boolean)) {
      const match = /^(\d{6}) ([a-f0-9]+) ([0123])\t(.+)$/s.exec(row);
      if (!match) throw Error("Некорректный индекс Git.");
      const name = gitFilePathSchema.parse(match[4]);
      if (expected.conflicts.has(name)) continue;
      if (match[3] !== "0" || actual.has(name))
        throw Error(
          "Конфликтный индекс не соответствует исходному слиянию. Отмена запрещена.",
        );
      actual.set(name, `${match[1]} ${oid(match[2])}`);
    }
    for (const name of new Set([...baseline.keys(), ...actual.keys()]))
      if (
        !expected.conflicts.has(name) &&
        baseline.get(name) !== actual.get(name)
      )
        throw Error(
          "В индексе есть изменения вне исходных конфликтов. Native abort может их потерять; сохраните их самостоятельно. Отмена не выполнялась.",
        );
  }
  /** A native D/F conflict may create a directory where HEAD had a file.
   * Permit abort only when every actual descendant is owned by the proven
   * original merge; never treat an entire generated directory as disposable. */
  protected async checkOwnedMergeDirectory(
    ctx: GitMergeContext,
    directory: string,
    current: Set<string>,
    original: NonNullable<MergeDestinations["original"]>,
  ) {
    const unsafe = () =>
      Error(
        "В каталоге исходного конфликта есть посторонние или изменённые данные. Безопасная отмена невозможна; сохраните их самостоятельно.",
      );
    let count = 0;
    const visit = async (name: string, depth: number): Promise<void> => {
      if (++count > 100000 || depth > 20) throw unsafe();
      const value = await stat(path.join(ctx.root, name));
      if (!value) return;
      if (value.isDirectory() && !value.isSymbolicLink()) {
        if (![...original.paths].some((p) => p.startsWith(`${name}/`)))
          throw unsafe();
        for (const child of await fs.readdir(path.join(ctx.root, name))) {
          if (child.toLowerCase() === ".git") throw unsafe();
          await visit(`${name}/${child}`, depth + 1);
        }
        return;
      }
      if (
        (!value.isFile() && !value.isSymbolicLink()) ||
        !original.paths.has(name) ||
        !current.has(name)
      )
        throw unsafe();
      if (!original.conflicts.has(name)) {
        try {
          await this.git(ctx, [
            "diff-files",
            "--quiet",
            "--no-ext-diff",
            "--no-textconv",
            "--",
            name,
          ]);
        } catch (error) {
          if (error instanceof CommandExitError && error.exitCode === 1)
            throw unsafe();
          throw error;
        }
      }
    };
    await visit(directory, 0);
  }
  protected async checkMergeDestinations(
    ctx: GitMergeContext,
    { current, incoming, tracked, original }: MergeDestinations,
  ) {
    const verifiedDirectories = new Set<string>();
    // ORT's failure cleanup can replace a user-created directory even on an
    // unrelated tracked path. Audit all tracked HEAD/index leaves, not only
    // incoming destinations, without following symlink parents.
    for (const name of tracked) {
      const parts = name.split("/");
      let prefix = "";
      for (let i = 0; i < parts.length; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        const value = await stat(path.join(ctx.root, prefix));
        if (!value) break;
        if (
          i === parts.length - 1 &&
          value.isDirectory() &&
          original &&
          [...original.paths].some((p) => p.startsWith(`${prefix}/`))
        ) {
          await this.checkOwnedMergeDirectory(ctx, prefix, current, original);
          verifiedDirectories.add(prefix);
          break;
        }
        if (
          i === parts.length - 1
            ? value.isDirectory()
            : !value.isDirectory() || value.isSymbolicLink()
        )
          throw Error(
            "На месте отслеживаемого файла или его родителя находится пользовательский каталог/другой тип. Git может удалить его при восстановлении; сначала сохраните данные самостоятельно.",
          );
      }
    }
    const conflict = () =>
      Error(
        "Слияние может перезаписать неотслеживаемый или игнорируемый файл/каталог. Переместите его самостоятельно и подтвердите новый предпросмотр.",
      );
    for (const name of incoming) {
      if (current.has(name)) continue; // Tracked overwrites remain native Git's responsibility.
      const parts = name.split("/");
      let prefix = "";
      for (let i = 0; i < parts.length; i++) {
        prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
        const value = await stat(path.join(ctx.root, prefix));
        if (!value) break;
        // A tracked file may be legitimately replaced by a directory by Git;
        // do not follow it, especially when it is a symlink.
        if (i < parts.length - 1 && current.has(prefix) && !value.isDirectory())
          break;
        if (
          i === parts.length - 1 &&
          value.isDirectory() &&
          verifiedDirectories.has(prefix)
        )
          break;
        if (
          i === parts.length - 1 ||
          !value.isDirectory() ||
          value.isSymbolicLink()
        )
          throw conflict();
        if (await stat(path.join(ctx.root, prefix, ".git")))
          throw Error(
            "Слияние затрагивает вложенный репозиторий; его файлы не проверяются и не изменяются.",
          );
      }
    }
  }
  /** Logical user-visible state, ignoring native index stat-cache refreshes and
   * ORIG_HEAD/AUTO_MERGE bookkeeping on an ordinary refusal. Staged blobs are included. */
  protected async mergeEffect(ctx: GitMergeContext, state: State) {
    const { revision: _revision, ...snapshot } = state.snapshot;
    const metadata = [];
    for (const name of mergeFiles.filter(
      (name) => name !== "ORIG_HEAD" && name !== "AUTO_MERGE",
    ))
      metadata.push([
        name,
        await contentIdentity(path.join(ctx.root, ".git", name)),
      ]);
    return digest(
      JSON.stringify([
        snapshot,
        state.content,
        metadata,
        (await this.git(ctx, ["ls-files", "--stage", "-z"])).stdout,
      ]),
    );
  }
  /** Keep live HEAD/ref/index pinned while native abort operates on a private
   * metadata directory and index, sharing only the explicitly owned worktree.
   * Publish the verified index and merge cleanup only after native success. */
  protected async pinnedMergeAbort(
    ctx: GitMergeContext,
    before: State,
    destinations: MergeDestinations,
    finalCheck: () => Promise<void>,
  ): Promise<PinnedMergeAbortResult> {
    if (!ctx.privateGit)
      throw Error(
        "Исполнитель не поддерживает безопасный частный индекс для отмены слияния.",
      );
    const head = before.snapshot.head!,
      branch = before.snapshot.branch!,
      ref = `refs/heads/${branch}`;
    await this.git(ctx, ["check-ref-format", ref]);
    const gitdir = path.join(ctx.root, ".git"),
      recovery = path.join(gitdir, `goga-abort-${randomUUID()}`),
      realIndex = path.join(gitdir, "index"),
      privateIndex = path.join(recovery, "index"),
      nativeDir = path.join(recovery, "native");
    let attempted = false,
      unchanged = false,
      retain = false,
      created = false,
      published = false,
      log = "";
    const locks = new Map<string, string>();
    const lockId = async (name: string) => {
      const info = await stat(path.join(gitdir, name));
      return info && info.isFile() && !info.isSymbolicLink()
        ? `${info.dev}:${info.ino}`
        : "missing";
    };
    const assertPins = async () => {
      for (const [name, identity] of locks)
        if ((await lockId(name)) !== identity) throw stale();
      if (
        (await fs.readFile(path.join(gitdir, "HEAD"), "utf8")) !==
          `ref: ${ref}\n` ||
        (
          await this.git(ctx, ["symbolic-ref", "--no-recurse", "HEAD"])
        ).stdout.trim() !== ref ||
        (await this.git(ctx, ["symbolic-ref", "HEAD"])).stdout.trim() !== ref ||
        (
          await this.git(ctx, ["rev-parse", "--verify", "HEAD"])
        ).stdout.trim() !== head
      )
        throw stale();
    };
    const workIdentity = async (name: string) => {
      const info = await stat(path.join(ctx.root, name));
      return JSON.stringify([
        info
          ? info.isSymbolicLink()
            ? "link"
            : info.isFile()
              ? "file"
              : info.isDirectory()
                ? "directory"
                : "other"
          : "missing",
        info ? Number(info.mode & 0o777n) : null,
        await contentIdentity(path.join(ctx.root, name)),
      ]);
    };
    const outcome = (
      status: PinnedMergeAbortResult["status"],
      message: string,
      nativeWarning = false,
    ): PinnedMergeAbortResult => ({
      status,
      changed: status !== "error",
      message,
      log,
      nativeWarning,
      lockRetained: retain,
      retainedLocks: retain ? [...locks.keys()] : [],
      ...(created ? { recoveryPath: recovery } : {}),
    });
    const journal = async (
      state: string,
      heldLocks = [...locks.keys()],
      uncheckedLocks: string[] = [],
    ) =>
      fs.writeFile(
        path.join(recovery, "journal.json"),
        JSON.stringify({
          version: 1,
          root: ctx.root,
          scope: ctx.scope,
          head,
          ref,
          state,
          published,
          locks: heldLocks,
          uncheckedLocks,
          log,
        }),
        { mode: 0o600 },
      );
    // Freeze effective settings resolved for the original gitdir (including
    // includeIf). Re-evaluating includes against the private gitdir could change
    // checkout conversion and other policy.
    const nativeConfigArgs = before.config
      .filter(([key]) => !/^include(?:if\..*)?\.path$/i.test(key))
      .flatMap(([key, value]) => ["-c", `${key}=${value}`]);
    const privateGit = (args: string[]) =>
      withFrozenGitConfigScope(() =>
        ctx.privateGit!(
          [
            ...nativeConfigArgs,
            ...safeArgs,
            `--git-dir=${nativeDir}`,
            `--work-tree=${ctx.root}`,
            ...args,
          ],
          privateIndex,
        ),
      );
    let result: PinnedMergeAbortResult;
    try {
      result = await this.withMetadataLock(
        ctx,
        "HEAD.lock",
        async () => {
          locks.set("HEAD.lock", await lockId("HEAD.lock"));
          return this.withMetadataLock(
            ctx,
            `${ref}.lock`,
            async () => {
              locks.set(`${ref}.lock`, await lockId(`${ref}.lock`));
              return this.withMetadataLock(
                ctx,
                "index.lock",
                async () => {
                  locks.set("index.lock", await lockId("index.lock"));
                  try {
                    await assertPins();
                    if (
                      (await this.capture(ctx, ctx.scope)).fingerprint !==
                      before.fingerprint
                    )
                      throw stale();
                    const indexIdentity = await fileIdentity(realIndex),
                      indexMode = (await fs.lstat(realIndex)).mode & 0o777;
                    const preserved = new Map<string, string>();
                    for (const file of before.snapshot.files) {
                      if (destinations.original!.conflicts.has(file.path))
                        continue;
                      if (
                        file.kind === "untracked" ||
                        file.worktreeStatus !== "."
                      )
                        for (const name of [
                          file.path,
                          ...(file.originalPath ? [file.originalPath] : []),
                        ])
                          preserved.set(name, await workIdentity(name));
                    }
                    await fs.mkdir(recovery, { mode: 0o700 });
                    created = true;
                    await fs.copyFile(
                      realIndex,
                      privateIndex,
                      constants.COPYFILE_EXCL,
                    );
                    await fs.copyFile(
                      realIndex,
                      path.join(recovery, "original-index"),
                      constants.COPYFILE_EXCL,
                    );
                    for (const name of mergeFiles)
                      if (await stat(path.join(gitdir, name)))
                        await fs.copyFile(
                          path.join(gitdir, name),
                          path.join(recovery, name),
                          constants.COPYFILE_EXCL,
                        );
                    // Native reset updates HEAD even when its OID does not change.
                    // Give it private refs rather than deliberately causing EEXIST
                    // against our live HEAD pin. Effective config is pinned above;
                    // objects are read through alternates, never fetched.
                    await fs.mkdir(path.join(nativeDir, "objects", "info"), {
                      recursive: true,
                    });
                    await fs.mkdir(path.dirname(path.join(nativeDir, ref)), {
                      recursive: true,
                    });
                    await fs.mkdir(path.join(nativeDir, "info"));
                    await fs.writeFile(
                      path.join(nativeDir, "HEAD"),
                      `ref: ${ref}\n`,
                      { flag: "wx" },
                    );
                    await fs.writeFile(path.join(nativeDir, ref), `${head}\n`, {
                      flag: "wx",
                    });
                    await fs.writeFile(
                      path.join(nativeDir, "config"),
                      head.length === 64
                        ? "[core]\nrepositoryformatversion = 1\n[extensions]\nobjectFormat = sha256\n"
                        : "[core]\nrepositoryformatversion = 0\n",
                      { flag: "wx" },
                    );
                    await fs.writeFile(
                      path.join(nativeDir, "objects", "info", "alternates"),
                      JSON.stringify(path.join(gitdir, "objects")) + "\n",
                      { flag: "wx" },
                    );
                    for (const name of [...mergeFiles, "info/attributes"])
                      if (await stat(path.join(gitdir, name)))
                        await fs.copyFile(
                          path.join(gitdir, name),
                          path.join(nativeDir, name),
                          constants.COPYFILE_EXCL,
                        );
                    const metadataBefore = new Map<string, string>();
                    for (const name of [...mergeFiles, ...mixedOperations])
                      metadataBefore.set(
                        name,
                        await fileIdentity(path.join(gitdir, name)),
                      );
                    await journal("native-abort-prepared");
                    await finalCheck();
                    await assertPins();
                    if (
                      (await this.capture(ctx, ctx.scope)).fingerprint !==
                        before.fingerprint ||
                      (await fileIdentity(realIndex)) !== indexIdentity
                    )
                      throw stale();
                    await this.checkMergeDestinations(ctx, destinations);
                    let failure: unknown;
                    attempted = true;
                    try {
                      const output = await privateGit([
                        "-c",
                        "rerere.enabled=false",
                        "-c",
                        "rerere.autoupdate=false",
                        "-c",
                        "merge.autoStash=false",
                        "merge",
                        "--abort",
                      ]);
                      log += output.stdout + output.stderr;
                    } catch (error) {
                      failure = error;
                      const e = error as {
                        stdout?: string;
                        stderr?: string;
                        message?: string;
                      };
                      log += `${e.stdout ?? ""}${e.stderr ?? ""}\n${e.message ?? String(error)}`;
                    }
                    // Timeout/unknown child outcome must retain all pins even when a
                    // snapshot looks completed. No automatic retry or rollback.
                    if (
                      failure &&
                      (!(failure instanceof CommandExitError) ||
                        failure.exitCode === null)
                    )
                      throw failure;
                    await assertPins();
                    await ctx.verify();
                    if (
                      failure &&
                      (await stat(path.join(gitdir, "MERGE_HEAD"))) &&
                      (await this.capture(ctx, ctx.scope)).fingerprint ===
                        before.fingerprint
                    ) {
                      unchanged = true;
                      return outcome(
                        "error",
                        "Git отказал в отмене. Слияние и данные сохранены; повтор не выполнялся.",
                      );
                    }
                    for (const name of [
                      ...mergeFiles.filter((n) => n !== "ORIG_HEAD"),
                      ...mixedOperations,
                    ])
                      if (await stat(path.join(nativeDir, name))) throw stale();
                    if (
                      (
                        await fs.readFile(
                          path.join(nativeDir, "ORIG_HEAD"),
                          "utf8",
                        )
                      ).trim() !== head
                    )
                      throw stale();
                    if (failure) throw failure;
                    if (
                      (
                        await privateGit(["rev-parse", "--verify", "HEAD"])
                      ).stdout.trim() !== head ||
                      (
                        await privateGit(["symbolic-ref", "HEAD"])
                      ).stdout.trim() !== ref
                    )
                      throw stale();
                    const expected = (
                      await this.git(ctx, ["ls-tree", "-r", "-z", head])
                    ).stdout
                      .split("\0")
                      .filter(Boolean)
                      .map((row) => {
                        const match = /^(\d{6}) blob ([a-f0-9]+)\t(.+)$/s.exec(
                          row,
                        );
                        if (!match)
                          throw Error(
                            "Не подтверждено исходное дерево после отмены.",
                          );
                        return `${match[1]} ${match[2]} 0\t${match[3]}`;
                      })
                      .sort();
                    const actual = (
                      await privateGit(["ls-files", "--stage", "-z"])
                    ).stdout
                      .split("\0")
                      .filter(Boolean)
                      .sort();
                    if (JSON.stringify(actual) !== JSON.stringify(expected))
                      throw stale();
                    for (const [name, identity] of preserved)
                      if ((await workIdentity(name)) !== identity)
                        throw stale();
                    // Private index contains HEAD: any remaining tracked dirt must be
                    // the explicitly preserved working edits, not incomplete restoration.
                    const dirty = (
                      await privateGit([
                        "diff-files",
                        "--name-only",
                        "--no-ext-diff",
                        "--no-textconv",
                        "-z",
                      ])
                    ).stdout
                      .split("\0")
                      .filter(Boolean);
                    if (dirty.some((name) => !preserved.has(name)))
                      throw stale();
                    for (const name of destinations.original!.paths) {
                      if (
                        destinations.incoming.includes(name) ||
                        preserved.has(name)
                      )
                        continue;
                      const info = await stat(path.join(ctx.root, name)).catch(
                        (error) => {
                          if (error.code === "ENOTDIR") return null;
                          throw error;
                        },
                      );
                      if (info) throw stale();
                    }
                    await fs.chmod(privateIndex, indexMode);
                    const privateIdentity = await fileIdentity(privateIndex);
                    const h = await fs.open(privateIndex, "r");
                    try {
                      await h.sync();
                    } finally {
                      await h.close();
                    }
                    await journal("native-aborted-index-unpublished");
                    await ctx.verify();
                    await assertPins();
                    if (
                      (await fileIdentity(realIndex)) !== indexIdentity ||
                      (await fileIdentity(privateIndex)) !== privateIdentity
                    )
                      throw stale();
                    for (const [name, identity] of metadataBefore)
                      if (
                        (await fileIdentity(path.join(gitdir, name))) !==
                        identity
                      )
                        throw stale();
                    // Only our confirmed native merge bookkeeping is removed.
                    // Keep ORIG_HEAD and the backups until all outer guards settle.
                    // No await between final guards, index publication and cleanup.
                    renameSync(privateIndex, realIndex);
                    published = true;
                    for (const name of mergeFiles.filter(
                      (name) => name !== "ORIG_HEAD",
                    ))
                      if (metadataBefore.get(name) !== "missing")
                        unlinkSync(path.join(gitdir, name));
                    await journal("published");
                    const after = await this.capture(ctx, ctx.scope);
                    if (
                      after.snapshot.operation !== "none" ||
                      after.snapshot.head !== head ||
                      after.snapshot.branch !== branch ||
                      after.snapshot.files.some(
                        (file) => !preserved.has(file.path),
                      )
                    )
                      throw stale();
                    await assertPins();
                    return outcome(
                      "success",
                      "Слияние отменено и результат проверен. Несвязанные изменения сохранены.",
                    );
                  } catch (error) {
                    log += `\n${error instanceof Error ? error.message : String(error)}`;
                    retain = attempted;
                    if (retain && created)
                      await journal("uncertain").catch(() => {});
                    return outcome(
                      attempted ? "uncertain" : "error",
                      attempted
                        ? "Результат отмены не подтверждён. Сохранены материалы проверки и защитные блокировки HEAD, ветки и индекса; не повторяйте операцию автоматически."
                        : error instanceof Error
                          ? error.message
                          : String(error),
                    );
                  }
                },
                () => retain,
              );
            },
            () => retain,
          );
        },
        () => retain,
      );
    } catch (error) {
      log += `\n${error instanceof Error ? error.message : String(error)}`;
      result = outcome(
        attempted && !unchanged ? "uncertain" : "error",
        "Очистка защитных блокировок не подтверждена. Проверьте журнал и оставшиеся блокировки; автоматический повтор не выполнялся.",
      );
    }
    // Run outside every finally: failed close/unlink must not turn a completed
    // native mutation into changed=false. Never claim a removed inode is held.
    const remaining: string[] = [],
      unchecked: string[] = [];
    const diagnosticFailure = (error: unknown) => {
      result.status = result.changed ? "uncertain" : "error";
      result.message =
        "Итоговая диагностика не завершена. Результат операции и последний известный путь восстановления сохранены; непроверенные блокировки не считаются отсутствующими. Не повторяйте автоматически.";
      result.log += `\n${error instanceof Error ? error.message : String(error)}`;
    };
    for (const [name, identity] of locks) {
      try {
        if ((await lockId(name)) === identity) remaining.push(name);
      } catch (error) {
        unchecked.push(name);
        diagnosticFailure(error);
      }
    }
    result.lockRetained = remaining.length > 0;
    result.retainedLocks = remaining;
    result.uncheckedLocks = unchecked;
    if (created) {
      try {
        await journal(result.status, remaining, unchecked);
      } catch (error) {
        diagnosticFailure(error);
      }
    }
    // The caller removes recovery only AFTER its outer config pin and owner
    // context have settled. Any late cleanup failure retains the original copy.
    return result;
  }
}

export interface PinnedMergeAbortResult {
  status: "success" | "error" | "uncertain";
  changed: boolean;
  message: string;
  log: string;
  nativeWarning: boolean;
  lockRetained: boolean;
  retainedLocks: string[];
  uncheckedLocks?: string[];
  recoveryUnverified?: boolean;
  recoveryPath?: string;
}
