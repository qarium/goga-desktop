import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import { withPrivateGitRead, type PrivateGitRead } from "./git-private-read";
import {
  gitDiffRequestSchema,
  gitFilePathSchema,
  type GitDiffPart,
  type GitDiffRequest,
  type GitWorkspaceDiff,
  type GitWorkspaceFile,
  type GitWorkspaceSnapshot,
  type GitWorkspaceSummary,
} from "../shared/git-workspace";

const LIMIT = 1024 * 1024;
const EMPTY: GitDiffPart = { kind: "empty", text: "" };
const unavailable = (text: string): GitDiffPart => ({
  kind: "unavailable",
  text,
});
const stale = () => new Error("Снимок Git устарел. Обновите список изменений.");
const fingerprint = (stat: BigIntStats | null) =>
  stat
    ? [
        stat.dev,
        stat.ino,
        stat.mode,
        stat.size,
        stat.mtimeNs,
        stat.ctimeNs,
      ].join(":")
    : "missing";
async function stat(filename: string) {
  try {
    return await fs.lstat(filename, { bigint: true });
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return null;
    throw error;
  }
}
const safeArgs = [
  "--no-pager",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-replace-objects",
  "-c",
  "core.splitIndex=false",
  "-c",
  "gc.auto=0",
  "-c",
  "maintenance.auto=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "core.preloadIndex=false",
  "-c",
  "submodule.recurse=false",
  "-c",
  "status.submoduleSummary=false",
  "-c",
  "core.quotePath=true",
  "-c",
  "color.ui=false",
];

interface ParsedStatus {
  value: Omit<
    GitWorkspaceSnapshot,
    "scope" | "root" | "revision" | "operation"
  >;
  unsupportedPaths: Set<string>;
}
interface Capture {
  value: GitWorkspaceSnapshot;
  unsupportedPaths: Set<string>;
  identity: string;
  fingerprints: [string, string][];
}
function parseStatus(raw: string): ParsedStatus {
  const result: ParsedStatus["value"] = {
    head: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
  const unsupportedPaths = new Set<string>();
  if (raw && !raw.endsWith("\0")) throw new Error("Неполный ответ Git status.");
  const entries = raw.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.startsWith("# branch.oid ")) {
      const value = entry.slice(13);
      result.head = value === "(initial)" ? null : value;
    } else if (entry.startsWith("# branch.head ")) {
      const value = entry.slice(14);
      result.branch = value === "(detached)" ? null : value;
    } else if (entry.startsWith("# branch.upstream "))
      result.upstream = entry.slice(18);
    else if (entry.startsWith("# branch.ab ")) {
      const counts = /^# branch.ab \+(\d+) -(\d+)$/.exec(entry);
      if (!counts) throw new Error("Некорректный ответ Git status.");
      result.ahead = Number(counts[1]);
      result.behind = Number(counts[2]);
    } else if (entry.startsWith("# ")) continue;
    else if (entry.startsWith("? ")) {
      // Porcelain represents an untracked nested repository as one directory,
      // even with --untracked-files=all. Strip only Git's directory marker;
      // renderer-supplied paths retain the strict no-trailing-slash contract.
      const name = entry.slice(2),
        directory = name.endsWith("/");
      const filePath = gitFilePathSchema.parse(
        directory ? name.slice(0, -1) : name,
      );
      if (directory) unsupportedPaths.add(filePath);
      result.files.push({
        path: filePath,
        indexStatus: "?",
        worktreeStatus: "?",
        kind: "untracked",
        submodule: false,
      });
    } else {
      const fields =
        entry[0] === "1" ? 8 : entry[0] === "2" ? 9 : entry[0] === "u" ? 10 : 0;
      if (!fields) throw new Error("Неизвестная запись Git status.");
      const match = new RegExp(`^((?:[^ ]+ ){${fields}})([\\s\\S]+)$`).exec(
        entry,
      );
      if (!match) throw new Error("Неполная запись Git status.");
      const meta = match[1].trimEnd().split(" ");
      if (
        !/^[.MADRCUT?!]{2}$/.test(meta[1]) ||
        !/^(N\.\.\.|S[.C][.M][.U])$/.test(meta[2])
      )
        throw new Error("Некорректная запись Git status.");
      const file: GitWorkspaceFile = {
        path: gitFilePathSchema.parse(match[2]),
        indexStatus: meta[1][0],
        worktreeStatus: meta[1][1],
        kind: entry[0] === "u" ? "conflict" : "tracked",
        submodule: meta[2][0] === "S",
      };
      if (
        meta
          .slice(3, entry[0] === "u" ? 7 : 6)
          .some((mode) => mode === "120000" || mode === "160000")
      )
        unsupportedPaths.add(file.path);
      if (entry[0] === "2")
        file.originalPath = gitFilePathSchema.parse(entries[++i]);
      result.files.push(file);
    }
  }
  if (
    new Set(result.files.map((file) => file.path)).size !== result.files.length
  )
    throw new Error("Повторяющиеся пути в Git status.");
  return { value: result, unsupportedPaths };
}

export class GitWorkspaceReader {
  private readonly root: string;
  private readonly scope: ScopeRef;
  constructor(
    private readonly options: {
      scope: ScopeRef;
      root: string;
      git: (args: string[]) => Promise<string>;
      verify: () => Promise<void>;
    },
  ) {
    this.root = path.resolve(options.root);
    this.scope = scopeRefSchema.parse(options.scope);
  }
  private git(args: string[]) {
    return this.options.git([
      ...safeArgs,
      `--git-dir=${path.join(this.root, ".git")}`,
      `--work-tree=${this.root}`,
      ...args,
    ]);
  }
  private async identity(auditObjects = false) {
    const root = await stat(this.root),
      gitdir = path.join(this.root, ".git"),
      gitstat = await stat(gitdir);
    if (
      !root?.isDirectory() ||
      root.isSymbolicLink() ||
      (await fs.realpath(this.root)) !== this.root
    )
      throw new Error(
        "Рабочая папка Git недоступна или является символической ссылкой.",
      );
    if (
      !gitstat?.isDirectory() ||
      gitstat.isSymbolicLink() ||
      (await fs.realpath(gitdir)) !== gitdir
    )
      throw new Error(
        "Git: требуется обычный каталог .git; связанные worktree в этом режиме пока не поддерживаются.",
      );
    // Reading a split index can freshen sharedindex timestamps even with
    // --no-optional-locks, including through a symlink outside this root.
    // Fail before invoking Git and without opening/dereferencing the file.
    // Conservatively reject leftover sharedindex files too; never rewrite or
    // convert a user's index just to make a read-only preview available.
    if (
      (await fs.readdir(gitdir)).some((name) =>
        name.toLowerCase().startsWith("sharedindex."),
      )
    )
      throw new Error(
        "Git split-index (sharedindex.*) пока не поддерживается в режиме безопасного чтения: Git может изменять его метаданные.",
      );
    const metadata: string[] = [];
    for (const name of [
      "HEAD",
      "index",
      "config",
      "config.worktree",
      "shallow",
      "packed-refs",
      "refs",
      "objects",
      "objects/info",
      "objects/pack",
      "info",
      "info/attributes",
      "info/exclude",
      "info/grafts",
      "info/sparse-checkout",
      "commondir",
      "objects/info/alternates",
      "objects/info/http-alternates",
      "MERGE_HEAD",
      "REBASE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-merge",
      "rebase-apply",
      "rebase-apply/rebasing",
      "sequencer",
    ]) {
      const value = await stat(path.join(gitdir, name));
      if (value?.isSymbolicLink())
        throw new Error("Небезопасная символическая ссылка в каталоге Git.");
      if (value) {
        const directory = [
          "refs",
          "objects",
          "objects/info",
          "objects/pack",
          "info",
          "rebase-merge",
          "rebase-apply",
          "sequencer",
        ].includes(name);
        if (directory ? !value.isDirectory() : !value.isFile())
          throw new Error("Недопустимый тип файла метаданных Git.");
      }
      if (
        value &&
        [
          "commondir",
          "objects/info/alternates",
          "objects/info/http-alternates",
        ].includes(name)
      )
        throw new Error(
          "Git с внешним хранилищем объектов пока не поддерживается.",
        );
      metadata.push(`${name}:${fingerprint(value)}`);
    }
    // Git itself follows symlinks in refs/object storage. Audit metadata names,
    // not blob contents; fail closed rather than reading an external store.
    let count = 0;
    const audit = async (
      directory: string,
      depth: number,
      record: boolean,
    ): Promise<void> => {
      const value = await stat(directory);
      if (!value) return;
      if (
        !value.isDirectory() ||
        value.isSymbolicLink() ||
        (await fs.realpath(directory)) !== directory
      )
        throw new Error("Небезопасная ссылка или каталог в метаданных Git.");
      if (depth > 8)
        throw new Error(
          "Структура метаданных Git превышает предел безопасного просмотра.",
        );
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (++count > 100000)
          throw new Error(
            "Метаданные Git превышают предел безопасного просмотра.",
          );
        if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
          throw new Error(
            "Небезопасная ссылка или специальный файл в метаданных Git.",
          );
        const filename = path.join(directory, entry.name);
        if (record)
          metadata.push(`${filename}:${fingerprint(await stat(filename))}`);
        if (entry.isDirectory()) await audit(filename, depth + 1, record);
      }
    };
    for (const name of [
      "refs",
      ...(auditObjects ? ["objects"] : []),
      "rebase-merge",
      "rebase-apply",
      "sequencer",
    ])
      await audit(path.join(gitdir, name), 0, name !== "objects");
    return `${root.dev}:${root.ino}:${gitstat.dev}:${gitstat.ino}:${metadata.join("|")}`;
  }
  private async withRead<T>(
    read: (context: PrivateGitRead) => Promise<T>,
  ): Promise<T> {
    await this.options.verify();
    const initial = await this.identity(true);
    return withPrivateGitRead(
      this.root,
      safeArgs,
      (args) => this.git(args),
      this.options.git,
      async (context) => {
        if ((await this.identity()) !== initial) throw stale();
        const result = await read(context);
        await context.verify();
        await this.options.verify();
        if ((await this.identity(true)) !== initial) throw stale();
        return result;
      },
    );
  }
  private async fileStat(name: string) {
    const parts = gitFilePathSchema.parse(name).split("/");
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const value = await stat(current);
      if (!value) return null;
      if (i === parts.length - 1) return value;
      if (value.isSymbolicLink() || !value.isDirectory())
        throw new Error(
          "Небезопасный путь Git: родитель файла не является обычным каталогом.",
        );
    }
    return null;
  }
  private async operation(): Promise<GitWorkspaceSnapshot["operation"]> {
    const exists = async (name: string) =>
      !!(await stat(path.join(this.root, ".git", name)));
    if (
      (await exists("rebase-merge")) ||
      (await exists("rebase-apply/rebasing"))
    )
      return "rebase";
    if (await exists("rebase-apply")) return "unknown"; // git am uses this directory too.
    if (await exists("MERGE_HEAD")) return "merge";
    if (await exists("CHERRY_PICK_HEAD")) return "cherry-pick";
    if (await exists("REVERT_HEAD")) return "revert";
    if ((await exists("sequencer")) || (await exists("REBASE_HEAD")))
      return "unknown";
    return "none";
  }
  private async status(context: PrivateGitRead) {
    const raw = await context.git([
      "status",
      "--porcelain=v2",
      "-z",
      "--branch",
      "--untracked-files=all",
      "--ignore-submodules=all",
      "--renames",
    ]);
    const { value: parsed, unsupportedPaths } = parseStatus(raw);
    // Ignore submodule working trees entirely. A cached raw diff still exposes
    // staged gitlink changes without opening the nested repository or its .git.
    const cached = await context.git([
      "diff",
      "--cached",
      "--raw",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--ignore-submodules=none",
      "--",
    ]);
    const entries = cached.split("\0");
    for (let i = 0; i < entries.length - 1; i += 2) {
      const entry = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([A-Z])$/.exec(
        entries[i],
      );
      if (!entry || !entries[i + 1])
        throw new Error("Некорректный ответ Git diff.");
      if (entry[1] !== "160000" && entry[2] !== "160000") continue;
      const name = gitFilePathSchema.parse(entries[i + 1]);
      const existing = parsed.files.find((file) => file.path === name);
      if (existing) existing.submodule = true;
      else
        parsed.files.push({
          path: name,
          kind: "tracked",
          indexStatus: entry[3],
          worktreeStatus: ".",
          submodule: true,
        });
    }
    return { parsed, unsupportedPaths, raw, cached };
  }
  async summary(): Promise<GitWorkspaceSummary> {
    return this.withRead(async (context) => {
      const { parsed } = await this.status(context);
      return {
        scope: this.scope,
        branch: parsed.branch,
        changedFiles: parsed.files.length,
        conflicts: parsed.files.filter((file) => file.kind === "conflict")
          .length,
      };
    });
  }
  private async capture(context: PrivateGitRead): Promise<Capture> {
    const before = await this.identity();
    const { parsed, unsupportedPaths, raw, cached } =
      await this.status(context);
    const operation = await this.operation();
    const hash = createHash("sha256")
      .update(JSON.stringify(this.scope))
      .update(this.root)
      .update(before)
      .update(context.policy)
      .update(raw)
      .update(cached)
      .update(operation);
    const fingerprints: Capture["fingerprints"] = [];
    for (const file of parsed.files)
      for (const name of [
        file.path,
        ...(file.originalPath ? [file.originalPath] : []),
      ]) {
        const value = fingerprint(await this.fileStat(name));
        hash.update(name).update(value);
        fingerprints.push([name, value]);
      }
    if ((await this.identity()) !== before) throw stale();
    return {
      value: {
        ...parsed,
        operation,
        scope: this.scope,
        root: this.root,
        revision: hash.digest("hex"),
      },
      unsupportedPaths,
      identity: before,
      fingerprints,
    };
  }
  private async snapshotState(context: PrivateGitRead): Promise<Capture> {
    const before = await this.capture(context),
      after = await this.capture(context);
    if (before.value.revision !== after.value.revision) throw stale();
    for (const [name, value] of after.fingerprints)
      if (fingerprint(await this.fileStat(name)) !== value) throw stale();
    return after;
  }
  async snapshot(): Promise<GitWorkspaceSnapshot> {
    return this.withRead(
      async (context) => (await this.snapshotState(context)).value,
    );
  }
  private async untracked(name: string): Promise<GitDiffPart> {
    const before = await this.fileStat(name);
    if (!before?.isFile() || before.isSymbolicLink())
      return unavailable(
        "Предпросмотр ссылок, каталогов и специальных файлов недоступен.",
      );
    if (before.size > BigInt(LIMIT))
      return unavailable("Файл превышает предел предпросмотра 1 МиБ.");
    const handle = await fs.open(
      path.join(this.root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || fingerprint(opened) !== fingerprint(before))
        throw stale();
      const buffer = Buffer.alloc(LIMIT + 1);
      let size = 0;
      while (size < buffer.length) {
        const chunk = await handle.read(
          buffer,
          size,
          buffer.length - size,
          size,
        );
        if (!chunk.bytesRead) break;
        size += chunk.bytesRead;
      }
      if (
        fingerprint(await handle.stat({ bigint: true })) !==
          fingerprint(before) ||
        fingerprint(await this.fileStat(name)) !== fingerprint(before)
      )
        throw stale();
      if (size > LIMIT)
        return unavailable("Файл превышает предел предпросмотра 1 МиБ.");
      const bytes = buffer.subarray(0, size);
      if (!size) return EMPTY;
      if (bytes.includes(0)) return { kind: "binary", text: "Двоичный файл." };
      try {
        return {
          kind: "text",
          text: new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes),
        };
      } catch {
        return { kind: "binary", text: "Файл не является текстом UTF-8." };
      }
    } finally {
      await handle.close();
    }
  }
  private async patch(
    file: GitWorkspaceFile,
    staged: boolean,
    context: PrivateGitRead,
  ): Promise<GitDiffPart> {
    if ((staged ? file.indexStatus : file.worktreeStatus) === ".") return EMPTY;
    let output: string;
    try {
      output = await context.git([
        "diff",
        ...(staged ? ["--cached"] : []),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-relative",
        "--ignore-submodules=all",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--",
        file.path,
        ...(file.originalPath ? [file.originalPath] : []),
      ]);
    } catch (error) {
      // Runner aborts instead of returning a truncated >8 MiB stream. Do not
      // swallow timeouts, cancellation, invalid ownership or other Git errors.
      if (
        error instanceof Error &&
        error.message === "Ответ команды слишком большой"
      )
        return unavailable("Изменения превышают предел предпросмотра 1 МиБ.");
      throw error;
    }
    if (Buffer.byteLength(output) > LIMIT)
      return unavailable("Изменения превышают предел предпросмотра 1 МиБ.");
    if (!output) return EMPTY;
    if (
      output.includes("\ufffd") ||
      /^Binary files .* differ$/m.test(output) ||
      /^GIT binary patch$/m.test(output)
    )
      return {
        kind: "binary",
        text: "Двоичный файл или текст с неподдерживаемой кодировкой.",
      };
    return { kind: "patch", text: output };
  }
  async diff(input: GitDiffRequest): Promise<GitWorkspaceDiff> {
    const request = gitDiffRequestSchema.parse(input);
    if (JSON.stringify(request.scope) !== JSON.stringify(this.scope))
      throw new Error("Запрошен другой контекст Git.");
    return this.withRead((context) => this.diffState(request, context));
  }
  private async diffState(
    request: GitDiffRequest,
    context: PrivateGitRead,
  ): Promise<GitWorkspaceDiff> {
    // The entire public read shares pinned filter-free metadata. Final checks
    // establish freshness; executing a driver never depends on winning a race.
    const state = await this.snapshotState(context),
      before = state.value;
    if (before.revision !== request.revision) throw stale();
    const file = before.files.find((entry) => entry.path === request.path);
    if (!file) throw new Error("Файла нет в списке изменений Git.");
    const info = await this.fileStat(file.path);
    let staged: GitDiffPart, unstaged: GitDiffPart;
    if (
      file.kind === "conflict" ||
      file.submodule ||
      state.unsupportedPaths.has(file.path) ||
      info?.isSymbolicLink() ||
      (info && !info.isFile())
    ) {
      staged = unstaged = unavailable(
        file.kind === "conflict"
          ? "Файл содержит конфликт. Обычный diff недоступен."
          : "Предпросмотр ссылок, подмодулей, каталогов и специальных файлов недоступен.",
      );
    } else if (file.kind === "untracked") {
      staged = EMPTY;
      unstaged = await this.untracked(file.path);
    } else {
      staged = await this.patch(file, true, context);
      unstaged = await this.patch(file, false, context);
    }
    if ((await this.snapshotState(context)).value.revision !== request.revision)
      throw stale();
    if (
      Buffer.byteLength(staged.text) + Buffer.byteLength(unstaged.text) >
      LIMIT
    )
      staged = unstaged = unavailable(
        "Суммарные изменения превышают предел предпросмотра 1 МиБ.",
      );
    return {
      scope: this.scope,
      path: file.path,
      revision: request.revision,
      staged,
      unstaged,
    };
  }
}
