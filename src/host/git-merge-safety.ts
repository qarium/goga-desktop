import { createHash } from "node:crypto";
import { constants } from "node:fs";
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
import {
  nativeGitGuard,
  nativeIntent,
  type NativeGitCapability,
} from "./git-native-context";
import { CommandExitError } from "./process";
import { noSymlinks } from "./settings";
export interface GitMergeContext {
  scope: ScopeRef;
  root: string;
  ownerKey: string;
  native?: NativeGitCapability;
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
  protected nativeGuard(
    ctx: GitMergeContext,
    state: State,
    paths: string[],
    source?: string,
    configAdditions: Row[] = [],
  ) {
    let observed = state.snapshot;
    return nativeGitGuard({
      root: ctx.root,
      capability: ctx.native,
      paths,
      configuration: state.config,
      verify: () => ctx.verify(),
      admittedStatus: async () => {
        observed = await ctx.snapshot();
        const { revision: _, ...semantic } = observed;
        return {
          data: Buffer.from(JSON.stringify(semantic)),
          headRef: semantic.branch ? `refs/heads/${semantic.branch}` : null,
        };
      },
      policy: async () => {
        let raw = (await this.git(ctx, ["config", "--null", "--list"])).stdout;
        // The remote-switch handler admits exactly two previously absent
        // tracking entries. Every other config byte remains part of the seal.
        // A partial/duplicate/wrong addition is not an allowed policy change.
        if (configAdditions.length) {
          const entries = rows(raw);
          const found = configAdditions.map(([key, value]) => {
            const values = entries.filter(([k]) => k === key).map(([, v]) => v);
            if (values.length > 1 || (values.length && values[0] !== value))
              throw stale();
            return values.length;
          });
          if (found.some(Boolean) && !found.every(Boolean)) throw stale();
          raw = raw
            .split("\0")
            .filter(
              (row) =>
                !configAdditions.some(
                  ([key, value]) => row === `${key}\n${value}`,
                ),
            )
            .join("\0");
        }
        return nativeIntent([
          raw,
          source
            ? await this.mergeAttributes(
                ctx,
                state.snapshot.head!,
                source,
                [],
                observed,
              )
            : null,
        ]);
      },
    });
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
    nativePolicy?: GitWorkspaceSnapshot,
  ) {
    const indexedPaths = (await this.git(ctx, ["ls-files", "-z"])).stdout
      .split("\0")
      .filter(Boolean)
      .map((name) => gitFilePathSchema.parse(name));
    const paths = [
      ...new Set([
        ...(await this.treePaths(ctx, head)),
        ...(await this.treePaths(ctx, source)),
        ...indexedPaths,
      ]),
    ].sort();
    // Tracked attributes are repository data: native merge/abort may replace
    // them. Seal external sources and dirty overrides, not a clean checkout of
    // the index. The ordinary preview still seals *all* effective attributes.
    // Only the CURRENT public index grants that exemption. A removed path
    // still present as an ignored file is an external policy source again.
    // Index changes are separately verified by the journalled operation; a
    // follow-up permits only the original conflict paths to change in the index.
    const managed = new Set(
      indexedPaths.filter((p) => path.posix.basename(p) === ".gitattributes"),
    );
    const dirty = nativePolicy
      ? new Set(
          nativePolicy.files
            .filter(
              (f) =>
                f.kind !== "conflict" && ![".", " "].includes(f.worktreeStatus),
            )
            .map((f) => f.path),
        )
      : new Set<string>();
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
    const externalFiles = new Set([
      path.join(ctx.root, ".git/info/attributes"),
    ]);
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
      if (raw !== "/dev/null") {
        const file = path.resolve(ctx.root, raw);
        files.add(file);
        externalFiles.add(file);
      }
    }
    const sources: Row[] = [];
    for (const file of [...files].sort()) {
      const relative = path.relative(ctx.root, file).split(path.sep).join("/");
      if (
        nativePolicy &&
        !externalFiles.has(file) &&
        managed.has(relative) &&
        !dirty.has(relative)
      )
        continue;
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
      if (identity !== "missing" || (nativePolicy && dirty.has(relative)))
        sources.push([file, identity]);
    }
    const effective = nativePolicy
      ? null
      : (
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
}
