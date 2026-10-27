import { scopeRefSchema, type ScopeRef } from "../shared/context";
import {
  gitCommitReadRequestSchema,
  gitCommitDiffRequestSchema,
  type GitCommitReadRequest,
  type GitCommitDiffRequest,
  type GitCommitDetails,
  type GitCommitDiff,
  type GitHistoryFile,
  gitHistoryRefSchema,
  gitHistoryRequestSchema,
  gitOidSchema,
  type GitHistoryCommit,
  type GitHistoryPage,
  type GitHistoryRefs,
  type GitHistoryRequest,
} from "../shared/git-history";
import { gitFilePathSchema, type GitDiffPart } from "../shared/git-workspace";
import { GitWorkspaceReader } from "./git-workspace-reader";
import type { PrivateGitRead } from "./git-private-read";
import { CommandExitError } from "./process";
import { withOfflineGitReadScope } from "./read-scope";

const PAGE_SIZE = 50;
const FILE_PAGE_SIZE = 200;
const DIFF_LIMIT = 1024 * 1024;
const COMMIT_FORMAT = "%H%x00%P%x00%s%x00%an%x00%aI%x00%cI";
const noPresentation = [
  "--no-decorate",
  "--no-show-signature",
  "--no-notes",
  "--no-patch",
  "--encoding=UTF-8",
];
const compareOptions = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-relative",
  "--ignore-submodules=none",
  "--submodule=short",
  "--no-commit-id",
  "-r",
  "--root",
  "--find-renames",
  "-l1000",
];
function commitFields(
  fields: string[],
  inventory: Inventory,
): GitHistoryCommit {
  if (fields.length !== 6) throw invalid();
  const [oid, parents, subject, author, authoredAt, committedAt] = fields;
  if (
    ![authoredAt, committedAt].every((date) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(date),
    )
  )
    throw invalid();
  return {
    oid: gitOidSchema.parse(oid),
    parents: parents
      ? parents.split(" ").map((p) => gitOidSchema.parse(p))
      : [],
    subject,
    author,
    authoredAt,
    committedAt,
    refs: inventory.entries
      .filter((entry) => entry.oid === oid)
      .map((entry) => entry.ref),
  };
}
/** Raw and numstat both use NUL framing; names may contain tabs/newlines. */
function comparisonFiles(raw: string): GitHistoryFile[] {
  if (!raw) return [];
  const tokens = bounded(raw).split("\0");
  if (tokens.pop() !== "") throw invalid();
  const files: GitHistoryFile[] = [];
  let i = 0;
  while (tokens[i]?.startsWith(":")) {
    const entry = /^:\d{6} \d{6} ([a-f0-9]+) ([a-f0-9]+) ([AMDRCT])\d*$/.exec(
      tokens[i++],
    );
    if (!entry) throw invalid();
    gitOidSchema.parse(entry[1]);
    gitOidSchema.parse(entry[2]);
    const first = gitFilePathSchema.parse(tokens[i++]);
    const rename = entry[3] === "R" || entry[3] === "C";
    const file: GitHistoryFile = {
      path: rename ? gitFilePathSchema.parse(tokens[i++]) : first,
      ...(rename ? { originalPath: first } : {}),
      status: entry[3],
      additions: null,
      deletions: null,
    };
    files.push(file);
  }
  let stats = 0;
  for (; i < tokens.length; stats++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i++]);
    if (!match) throw invalid();
    const originalPath =
      match[3] === "" ? gitFilePathSchema.parse(tokens[i++]) : undefined;
    const name = gitFilePathSchema.parse(
      originalPath === undefined ? match[3] : tokens[i++],
    );
    const file = files[stats];
    if (!file || file.path !== name || file.originalPath !== originalPath)
      throw invalid();
    file.additions = match[1] === "-" ? null : Number(match[1]);
    file.deletions = match[2] === "-" ? null : Number(match[2]);
    if (
      [file.additions, file.deletions].some(
        (n) => n !== null && !Number.isSafeInteger(n),
      )
    )
      throw invalid();
  }
  if (stats !== files.length) throw invalid();
  return files;
}
const READ_LIMIT = 2 * 1024 * 1024;
const stale = () =>
  Error("Снимок истории Git устарел. Обновите историю коммитов.");
const invalid = () => Error("Некорректный ответ истории Git.");
function bounded(raw: string) {
  if (Buffer.byteLength(raw, "utf8") > READ_LIMIT)
    throw Error("История Git превышает предел одного ответа.");
  return raw;
}
interface RefEntry {
  ref: string;
  oid: string;
}
interface Inventory {
  entries: RefEntry[];
  currentBranch: string | null;
}
/** Object-only view. No status scan, checkout, fetch, index write or Goga call. */
export class GitHistoryReader {
  private readonly workspace: GitWorkspaceReader;
  private readonly scope: ScopeRef;
  constructor(options: ConstructorParameters<typeof GitWorkspaceReader>[0]) {
    this.scope = scopeRefSchema.parse(options.scope);
    this.workspace = new GitWorkspaceReader(options);
  }
  private read<T>(fn: (context: PrivateGitRead) => Promise<T>): Promise<T> {
    return withOfflineGitReadScope(() => this.workspace.readObjects(fn));
  }
  private owner(scope: ScopeRef) {
    if (JSON.stringify(scope) !== JSON.stringify(this.scope))
      throw Error("Контекст истории Git изменился.");
  }
  private async inventory(context: PrivateGitRead): Promise<Inventory> {
    const raw = bounded(
      await context.git([
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)%00%(objectname)%00%(symref)",
        "refs/heads/",
        "refs/remotes/",
      ]),
    );
    const entries: RefEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const fields = line.split("\0");
      if (fields.length !== 3) throw invalid();
      const [ref, oid, symbolic] = fields;
      if (symbolic) continue;
      entries.push({
        ref: gitHistoryRefSchema.parse(ref),
        oid: gitOidSchema.parse(oid),
      });
    }
    let currentBranch: string | null = null;
    try {
      const head = (
        await context.git(["symbolic-ref", "--quiet", "HEAD"])
      ).trim();
      if (!head.startsWith("refs/heads/")) throw invalid();
      currentBranch = gitHistoryRefSchema
        .parse(head)
        .slice("refs/heads/".length);
    } catch (error) {
      if (!(error instanceof CommandExitError) || error.exitCode !== 1)
        throw error;
    }
    return { entries, currentBranch };
  }
  async refs(): Promise<GitHistoryRefs> {
    return this.read(async (context) => {
      const { entries, currentBranch } = await this.inventory(context);
      const group = (prefix: string) =>
        entries
          .filter((entry) => entry.ref.startsWith(prefix))
          .map(({ ref }) => ({ ref, name: ref.slice(prefix.length) }));
      return {
        scope: this.scope,
        currentBranch,
        local: group("refs/heads/"),
        remote: group("refs/remotes/"),
      };
    });
  }
  private async tip(
    context: PrivateGitRead,
    inventory: Inventory,
    ref: string,
    expected?: string,
  ) {
    if (ref !== "HEAD" && !inventory.entries.some((entry) => entry.ref === ref))
      throw Error("Ветка просмотра Git недоступна. Обновите список веток.");
    let tip: string | null;
    try {
      tip = gitOidSchema.parse(
        (
          await context.git([
            "rev-parse",
            "--verify",
            "--quiet",
            `${ref}^{commit}`,
          ])
        ).trim(),
      );
    } catch (error) {
      const unborn =
        ref === "HEAD" &&
        inventory.currentBranch !== null &&
        !inventory.entries.some(
          (entry) => entry.ref === `refs/heads/${inventory.currentBranch}`,
        );
      if (
        !(error instanceof CommandExitError) ||
        error.exitCode !== 1 ||
        !unborn
      )
        throw error;
      tip = null;
    }
    if (expected !== undefined && expected !== tip) throw stale();
    return tip;
  }
  async page(input: GitHistoryRequest): Promise<GitHistoryPage> {
    const request = gitHistoryRequestSchema.parse(input);
    this.owner(request.scope);
    return this.read(async (context) => {
      const inventory = await this.inventory(context),
        tip = await this.tip(context, inventory, request.ref, request.tip);
      if (tip === null)
        return {
          scope: this.scope,
          ref: request.ref,
          currentBranch: inventory.currentBranch,
          tip,
          commits: [],
          nextOffset: null,
        };
      const raw = bounded(
        await context.git([
          "log",
          "-z",
          "--topo-order",
          `--max-count=${PAGE_SIZE + 1}`,
          `--skip=${request.offset}`,
          "--no-decorate",
          "--no-show-signature",
          "--no-notes",
          "--no-patch",
          "--encoding=UTF-8",
          `--format=${COMMIT_FORMAT}`,
          tip,
          "--",
        ]),
      );
      const fields = raw ? raw.split("\0") : [];
      if (fields.length && fields.pop() !== "") throw invalid();
      if (fields.length % 6 !== 0 || fields.length > (PAGE_SIZE + 1) * 6)
        throw invalid();
      const commits: GitHistoryCommit[] = [];
      for (let i = 0; i < fields.length; i += 6)
        commits.push(commitFields(fields.slice(i, i + 6), inventory));
      return {
        scope: this.scope,
        ref: request.ref,
        currentBranch: inventory.currentBranch,
        tip,
        commits: commits.slice(0, PAGE_SIZE),
        nextOffset:
          commits.length > PAGE_SIZE ? request.offset + PAGE_SIZE : null,
      };
    });
  }
  private async comparison(
    context: PrivateGitRead,
    request: Omit<GitCommitReadRequest, "fileOffset">,
  ) {
    const inventory = await this.inventory(context);
    await this.tip(context, inventory, request.ref, request.tip);
    if (request.commit !== request.tip) {
      try {
        await context.git([
          "merge-base",
          "--is-ancestor",
          request.commit,
          request.tip,
        ]);
      } catch (error) {
        if (!(error instanceof CommandExitError) || error.exitCode !== 1)
          throw error;
        throw Error("Коммит не принадлежит выбранной истории Git.");
      }
    }
    // %P from log deliberately hides shallow parents. Read the real header so a
    // shallow boundary cannot silently masquerade as an initial commit.
    const object = bounded(
      await context.git(["cat-file", "commit", request.commit]),
    );
    const boundary = object.indexOf("\n\n");
    if (boundary < 0) throw invalid();
    const parents = object
      .slice(0, boundary)
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => gitOidSchema.parse(line.slice(7)));
    if (request.parentIndex >= Math.max(1, parents.length))
      throw Error("Выбранный родитель коммита недоступен.");
    const parent = parents[request.parentIndex] ?? null;
    if (parent !== null) {
      try {
        await context.git(["cat-file", "-e", `${parent}^{commit}`]);
      } catch (error) {
        if (!(error instanceof CommandExitError)) throw error;
        throw Error(
          "Родитель коммита недоступен в локальной истории Git. Сравнение не загружено.",
        );
      }
    }
    const pair = parent ? [parent, request.commit] : [request.commit];
    return { inventory, parents, parent, pair };
  }
  private files(context: PrivateGitRead, pair: string[]) {
    return context
      .git([
        "diff-tree",
        ...compareOptions,
        "--raw",
        "--numstat",
        "--no-abbrev",
        "-z",
        ...pair,
        "--",
      ])
      .then(comparisonFiles);
  }
  async commit(input: GitCommitReadRequest): Promise<GitCommitDetails> {
    const request = gitCommitReadRequestSchema.parse(input);
    this.owner(request.scope);
    return this.read(async (context) => {
      const comparison = await this.comparison(context, request);
      const raw = bounded(
        await context.git([
          "show",
          ...noPresentation,
          `--format=${COMMIT_FORMAT}%x00%B%x00`,
          request.commit,
          "--",
        ]),
      );
      const fields = raw.split("\0");
      if (fields.length !== 8 || fields[7] !== "\n") throw invalid();
      const commit = commitFields(fields.slice(0, 6), comparison.inventory);
      commit.parents = comparison.parents;
      const files = await this.files(context, comparison.pair);
      const end = request.fileOffset + FILE_PAGE_SIZE;
      return {
        scope: this.scope,
        ref: request.ref,
        tip: request.tip,
        commit,
        message: fields[6],
        parentIndex: request.parentIndex,
        parent: comparison.parent,
        files: files.slice(request.fileOffset, end),
        nextFileOffset: files.length > end ? end : null,
      };
    });
  }
  async diff(input: GitCommitDiffRequest): Promise<GitCommitDiff> {
    const request = gitCommitDiffRequestSchema.parse(input);
    this.owner(request.scope);
    return this.read(async (context) => {
      const comparison = await this.comparison(context, request);
      const files = await this.files(context, comparison.pair);
      const file = files.find(
        (entry) =>
          entry.path === request.path &&
          entry.originalPath === request.originalPath,
      );
      if (!file) throw Error("Файла нет в выбранном сравнении коммита.");
      let part: GitDiffPart;
      if (file.additions === null || file.deletions === null) {
        part = {
          kind: "binary",
          text: "Двоичный файл: текстовый предпросмотр недоступен.",
        };
      } else {
        let output: string | null;
        try {
          output = await context.git([
            "diff-tree",
            ...compareOptions,
            "--patch",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=3",
            ...comparison.pair,
            "--",
            file.path,
            ...(file.originalPath ? [file.originalPath] : []),
          ]);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "Ответ команды слишком большой"
          )
            throw error;
          output = null;
        }
        part =
          output === null || Buffer.byteLength(output) > DIFF_LIMIT
            ? {
                kind: "unavailable",
                text: "Изменения превышают предел предпросмотра 1 МиБ.",
              }
            : output.includes("\ufffd")
              ? {
                  kind: "unavailable",
                  text: "Текст содержит неподдерживаемую кодировку.",
                }
              : { kind: output ? "patch" : "empty", text: output };
      }
      return {
        scope: this.scope,
        tip: request.tip,
        commit: request.commit,
        parent: comparison.parent,
        path: file.path,
        part,
      };
    });
  }
}
