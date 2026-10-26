import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, renameSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { type ScopeRef, scopeRefSchema } from "../shared/context";
import {
  gitCommitRequestSchema,
  gitCommitTokenSchema,
  type GitCommitPreview,
  type GitCommitRequest,
  type GitCommitResult,
} from "../shared/git-commit";
import {
  gitFilePathSchema,
  type GitWorkspaceSnapshot,
} from "../shared/git-workspace";
import { CommandExitError, GitRefTransactionError } from "./process";
import { withPrivateGitRead, type PrivateGitRead } from "./git-private-read";
import { withPrivateGitIndexWrite } from "./git-index-scope";

export interface GitCommitContext {
  scope: ScopeRef;
  root: string;
  /** Complete owner and effective settings identity, reconstructed by HostService. */
  ownerKey: string;
  refTransaction?: (
    args: string[],
    prepareInput: string,
    verifyPrepared: (assertPreparedActive: () => void) => Promise<void>,
  ) => Promise<{ stdout: string; stderr: string }>;
  snapshot(): Promise<GitWorkspaceSnapshot>;
  verify(): Promise<void>;
  git(
    args: string[],
    options?: { stdin?: string; indexFile?: string },
  ): Promise<{ stdout: string; stderr: string }>;
}
interface State {
  revision: string;
  head: string | null;
  branch: string | null;
  headIdentity: string;
  index: string;
  config: string;
  files: string;
  blobs: Record<string, string | null>;
  modes: Record<string, string | null>;
  reference: string | null;
  author: string;
  committer: string;
  signing: boolean;
}
interface Ticket {
  preview: GitCommitPreview;
  ownerKey: string;
  state: State;
}
const stale = () =>
  Error(
    "Предпросмотр Git устарел или изменился владелец. Обновите список и подтвердите заново.",
  );
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
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
  "user.useConfigOnly=true",
  "-c",
  "color.ui=false",
];
const stat = async (filename: string) =>
  fs.lstat(filename, { bigint: true }).catch((error) => {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) return null;
    throw error;
  });
const fingerprint = (info: Awaited<ReturnType<typeof stat>>) =>
  info
    ? [
        info.dev,
        info.ino,
        info.mode,
        info.size,
        info.mtimeNs,
        info.ctimeNs,
      ].join(":")
    : "missing";
async function regularFile(
  filename: string,
): Promise<{ bytes: Buffer; stamp: string } | null> {
  const info = await stat(filename);
  if (!info) return null;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    info.size > 256n * 1024n * 1024n
  )
    throw Error("Небезопасный тип или размер файла Git.");
  const handle = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (fingerprint(await handle.stat({ bigint: true })) !== fingerprint(info))
      throw stale();
    const bytes = await handle.readFile();
    if (
      fingerprint(await handle.stat({ bigint: true })) !== fingerprint(info) ||
      fingerprint(await stat(filename)) !== fingerprint(info)
    )
      throw stale();
    return { bytes, stamp: fingerprint(info) };
  } finally {
    await handle.close();
  }
}
async function indexFingerprint(root: string) {
  const file = await regularFile(path.join(root, ".git/index"));
  return file ? `${file.stamp}:${digest(file.bytes)}` : "missing";
}
async function selectedFile(root: string, name: string) {
  const parts = gitFilePathSchema.parse(name).split("/");
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await stat(current);
    if (!info) return null;
    if (info.isSymbolicLink())
      throw Error("Символические ссылки не поддерживаются при коммите.");
    if (i === parts.length - 1) return regularFile(current);
    if (!info.isDirectory() || (await stat(path.join(current, ".git"))))
      throw Error("Вложенный репозиторий или небезопасный путь Git.");
  }
  return null;
}
// Git commit writes COMMIT_EDITMSG and reflogs, unlike the read-only reader.
// Audit these additional destinations before invoking Git, including hardlinks
// whose append/truncate would otherwise modify another pathname.
async function auditWritableMetadata(root: string) {
  let count = 0;
  const visit = async (filename: string, depth: number): Promise<void> => {
    const info = await stat(filename);
    if (!info) return;
    if (
      ++count > 100000 ||
      depth > 10 ||
      info.isSymbolicLink() ||
      (!info.isDirectory() && (!info.isFile() || info.nlink !== 1n))
    )
      throw Error("Небезопасная ссылка или тип записываемых метаданных Git.");
    if (info.isDirectory())
      for (const name of await fs.readdir(filename))
        await visit(path.join(filename, name), depth + 1);
  };
  await visit(path.join(root, ".git/logs"), 0);
  const message = await stat(path.join(root, ".git/COMMIT_EDITMSG"));
  if (
    message &&
    (!message.isFile() || message.isSymbolicLink() || message.nlink !== 1n)
  )
    throw Error("Небезопасные метаданные Git COMMIT_EDITMSG.");
}
function entries(raw: string) {
  return raw
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const newline = row.indexOf("\n");
      return [
        newline < 0 ? row : row.slice(0, newline),
        newline < 0 ? "" : row.slice(newline + 1),
      ] as const;
    });
}
function ident(raw: string) {
  const match = /^(.+ <[^<>\n]+>) \d+ [+-]\d{4}\n?$/.exec(raw);
  if (!match) throw Error("Git не подтвердил настроенное авторство коммита.");
  return match[1];
}
async function syncDirectory(directory: string) {
  const handle = await fs.open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Serial admission is supplied by HostService. Tickets never authorize a path or
 * a project by themselves: their context is reconstructed inside each operation. */
export class GitWorkspaceActions {
  private tickets = new Map<string, Ticket>();
  constructor(
    private readonly options: {
      context: <T>(
        scope: ScopeRef,
        action: (context: GitCommitContext) => Promise<T>,
      ) => Promise<T>;
      now?: () => number;
      /** Host-only fault-injection seam; production uses atomic rename. */
      beforePublishIndex?: (source: string, target: string) => undefined;
      afterPublishIndex?: (source: string, target: string) => undefined;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private git(
    context: GitCommitContext,
    args: string[],
    filters: string[] = [],
    options?: { stdin?: string; indexFile?: string },
  ) {
    return context.git(
      [
        ...safeArgs,
        `--git-dir=${path.join(context.root, ".git")}`,
        `--work-tree=${context.root}`,
        ...filters,
        ...args,
      ],
      options,
    );
  }
  private withPolicy<T>(
    context: GitCommitContext,
    action: (policy: PrivateGitRead) => Promise<T>,
    options?: { stdin?: string; indexFile?: string },
  ) {
    return withPrivateGitRead(
      context.root,
      safeArgs,
      async (args) => (await this.git(context, args)).stdout,
      async (args) =>
        (
          await (options?.indexFile
            ? withPrivateGitIndexWrite(() => context.git(args, options))
            : context.git(args, options))
        ).stdout,
      action,
    );
  }
  private async config(context: GitCommitContext) {
    const raw = (await this.git(context, ["config", "--null", "--list"]))
      .stdout;
    const rows = entries(raw),
      filters: string[] = [];
    for (const key of new Set(rows.map(([key]) => key)))
      if (/^filter\..+\.(clean|smudge|process|required)$/i.test(key))
        filters.push(
          "-c",
          `${key}=${key.toLowerCase().endsWith(".required") ? "false" : ""}`,
        );
    const author = ident(
      (await this.git(context, ["var", "GIT_AUTHOR_IDENT"], filters)).stdout,
    );
    const committer = ident(
      (await this.git(context, ["var", "GIT_COMMITTER_IDENT"], filters)).stdout,
    );
    // Let Git parse its own booleans (including nonzero numeric values).
    // Invalid signing configuration must fail preview rather than display false.
    const signingValue = (
      await this.git(
        context,
        ["config", "--type=bool", "--default=false", "--get", "commit.gpgsign"],
        filters,
      )
    ).stdout.trim();
    if (!["true", "false"].includes(signingValue))
      throw Error("Git не подтвердил настройку подписи коммита.");
    const signing = signingValue === "true";
    const filemodeValue = (
      await this.git(
        context,
        ["config", "--type=bool", "--default=true", "--get", "core.filemode"],
        filters,
      )
    ).stdout.trim();
    if (!["true", "false"].includes(filemodeValue))
      throw Error("Git не подтвердил режим файлов.");
    return {
      config: digest(`${raw}\0${author}\0${committer}`),
      author,
      committer,
      signing,
      filemode: filemodeValue === "true",
      filters,
    };
  }
  private async capture(
    context: GitCommitContext,
    paths: string[],
  ): Promise<State> {
    scopeRefSchema.parse(context.scope);
    if (
      !path.isAbsolute(context.root) ||
      path.resolve(context.root) !== context.root
    )
      throw Error("Небезопасная рабочая папка Git.");
    await context.verify();
    await auditWritableMetadata(context.root);
    const snapshot = await context.snapshot();
    if (
      snapshot.root !== context.root ||
      JSON.stringify(snapshot.scope) !== JSON.stringify(context.scope)
    )
      throw stale();
    if (
      snapshot.operation !== "none" ||
      snapshot.files.some((f) => f.kind === "conflict")
    )
      throw Error(
        "Сначала завершите текущую операцию Git и разрешите конфликты.",
      );
    const headFile = await regularFile(path.join(context.root, ".git/HEAD"));
    if (!headFile) throw stale();
    const reference =
      snapshot.branch === null ? null : `refs/heads/${snapshot.branch}`;
    if (reference) {
      const recursive = (
        await this.git(context, ["symbolic-ref", "--quiet", "HEAD"])
      ).stdout.trim();
      if (
        headFile.bytes.toString("utf8") !== `ref: ${reference}\n` ||
        recursive !== reference
      )
        throw Error(
          "Цепочки символических Git refs не поддерживаются для коммита.",
        );
    } else if (headFile.bytes.toString("utf8").trim() !== snapshot.head)
      throw stale();
    const config = await this.config(context),
      index = await indexFingerprint(context.root);
    const attributes = (
      await this.git(
        context,
        ["check-attr", "-z", "--stdin", "filter"],
        config.filters,
        { stdin: paths.join("\0") + "\0" },
      )
    ).stdout.split("\0");
    if (attributes.length !== paths.length * 3 + 1 || attributes.at(-1) !== "")
      throw Error("Некорректный ответ Git attributes.");
    for (let i = 0; i < paths.length; i++)
      if (
        attributes[i * 3] !== paths[i] ||
        attributes[i * 3 + 1] !== "filter" ||
        !["unspecified", "unset"].includes(attributes[i * 3 + 2])
      )
        throw Error(
          "Внешние clean/process фильтры выбранных файлов (например LFS) пока не поддерживаются.",
        );
    const modes = (
      await this.git(
        context,
        ["ls-files", "--stage", "-z", "--", ...paths],
        config.filters,
      )
    ).stdout;
    if (modes.split("\0").some((row) => /^(120000|160000) /.test(row)))
      throw Error("Коммит ссылок и подмодулей пока не поддерживается.");
    if (snapshot.head) {
      const tree = (
        await this.git(
          context,
          ["ls-tree", "-z", snapshot.head, "--", ...paths],
          config.filters,
        )
      ).stdout;
      if (tree.split("\0").some((row) => /^(120000|160000) /.test(row)))
        throw Error("Коммит ссылок и подмодулей пока не поддерживается.");
    }
    const modesByPath: Record<string, string> = Object.create(null);
    for (const row of modes.split("\0").filter(Boolean)) {
      const match = /^(\d{6}) [a-f0-9]+ 0\t([\s\S]+)$/.exec(row);
      if (match) modesByPath[match[2]] = match[1];
    }
    const selectedModes: State["modes"] = Object.create(null);
    const blobs: State["blobs"] = Object.create(null),
      hash = createHash("sha256");
    // Pin the complete filter-free configuration, not just filter names known
    // before check-attr. A concurrently added driver can never be executed.
    await this.withPolicy(context, async (policy) => {
      for (const name of paths) {
        const file = await selectedFile(context.root, name);
        hash
          .update(name)
          .update(file ? `${file.stamp}:${digest(file.bytes)}` : "missing");
        blobs[name] = file
          ? (
              await policy.git(["hash-object", `--path=${name}`, "--", name])
            ).trim()
          : null;
        selectedModes[name] = file
          ? config.filemode
            ? (await stat(path.join(context.root, name)))!.mode & 0o100n
              ? "100755"
              : "100644"
            : (modesByPath[name] ?? "100644")
          : null;
        if (file && !/^[a-f0-9]{40,64}$/.test(blobs[name]!))
          throw Error("Некорректный хеш выбранного файла.");
        if (
          fingerprint(await stat(path.join(context.root, name))) !==
          (file?.stamp ?? "missing")
        )
          throw stale();
      }
      await policy.verify();
    });
    if (
      index !== (await indexFingerprint(context.root)) ||
      (await context.snapshot()).revision !== snapshot.revision ||
      (await this.config(context)).config !== config.config
    )
      throw stale();
    await context.verify();
    return {
      revision: snapshot.revision,
      head: snapshot.head,
      branch: snapshot.branch,
      headIdentity: digest(headFile.bytes),
      reference,
      index,
      config: config.config,
      files: hash.digest("hex"),
      blobs,
      modes: selectedModes,
      author: config.author,
      committer: config.committer,
      signing: config.signing,
    };
  }
  async prepare(input: GitCommitRequest): Promise<GitCommitPreview> {
    const request = gitCommitRequestSchema.parse(input);
    return this.options.context(request.scope, async (context) => {
      if (JSON.stringify(context.scope) !== JSON.stringify(request.scope))
        throw stale();
      const snapshot = await context.snapshot();
      if (snapshot.revision !== request.revision) throw stale();
      const selected = request.paths.map((name) => {
        const file = snapshot.files.find((file) => file.path === name);
        if (!file) throw Error("Выбранного файла нет в списке изменений Git.");
        if (file.submodule || file.kind === "conflict")
          throw Error("Коммит подмодулей и конфликтов не поддерживается.");
        return file;
      });
      // A rename source is implicit only as a deletion. If it was recreated,
      // committing it would capture a whole file the user did not select.
      for (const file of selected)
        if (
          file.originalPath &&
          !request.paths.includes(file.originalPath) &&
          (await selectedFile(context.root, file.originalPath))
        )
          throw Error(
            "Исходный путь переименованного файла создан заново. Выберите его отдельно либо исключите переименование.",
          );
      const paths = [
        ...new Set(
          selected.flatMap((file) => [
            file.path,
            ...(file.originalPath ? [file.originalPath] : []),
          ]),
        ),
      ];
      if (paths.length > 2000) throw Error("Слишком много выбранных путей.");
      const state = await this.capture(context, paths);
      if (state.revision !== request.revision) throw stale();
      const now = this.now();
      for (const [token, ticket] of this.tickets)
        if (ticket.preview.expiresAt <= now) this.tickets.delete(token);
      if (this.tickets.size >= 64)
        this.tickets.delete(this.tickets.keys().next().value!);
      const preview: GitCommitPreview = {
        token: randomBytes(32).toString("hex"),
        scope: request.scope,
        root: context.root,
        branch: snapshot.branch,
        paths,
        deletedCount: Object.values(state.blobs).filter((v) => v === null)
          .length,
        message: request.message,
        wholeFiles: true,
        author: state.author,
        committer: state.committer,
        signing: state.signing,
        hooks: "disabled",
        expiresAt: now + 5 * 60 * 1000,
      };
      this.tickets.set(preview.token, {
        preview: structuredClone(preview),
        ownerKey: context.ownerKey,
        state,
      });
      return preview;
    });
  }
  async execute(input: string): Promise<GitCommitResult> {
    const token = gitCommitTokenSchema.parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now())
      throw Error("Подтверждение коммита истекло или уже использовано.");
    return this.options.context(ticket.preview.scope, async (context) => {
      if (ticket.preview.expiresAt <= this.now())
        throw Error("Подтверждение коммита истекло; подтвердите заново.");
      if (
        context.root !== ticket.preview.root ||
        context.ownerKey !== ticket.ownerKey ||
        JSON.stringify(context.scope) !== JSON.stringify(ticket.preview.scope)
      )
        throw stale();
      if (!context.refTransaction)
        throw Error(
          "Исполнитель не поддерживает безопасную транзакцию Git refs; коммит не начат.",
        );
      const current = await this.capture(context, ticket.preview.paths);
      if (JSON.stringify(current) !== JSON.stringify(ticket.state))
        throw stale();
      return this.transact(context, ticket);
    });
  }
  private async transact(
    context: GitCommitContext,
    ticket: Ticket,
  ): Promise<GitCommitResult> {
    const root = context.root,
      gitdir = path.join(root, ".git"),
      realIndex = path.join(gitdir, "index"),
      lock = path.join(gitdir, "index.lock"),
      recovery = path.join(gitdir, `goga-commit-${randomUUID()}`),
      temporary = path.join(recovery, "index"),
      publication = path.join(recovery, "publication"),
      candidate = path.join(recovery, "lock"),
      journalFile = path.join(recovery, "journal.json");
    await fs.mkdir(recovery, { mode: 0o700 });
    const journal = {
      version: 2,
      pid: process.pid,
      root,
      scope: ticket.preview.scope,
      paths: ticket.preview.paths,
      old: ticket.state.head,
      new: null as string | null,
      reference: ticket.state.reference,
      headIdentity: ticket.state.headIdentity,
      originalIndexFingerprint: ticket.state.index,
      expectedBlobs: ticket.state.blobs,
      expectedModes: ticket.state.modes,
      privateIndex: temporary,
      publication,
      realIndex,
      state: "prepared",
    };
    const syncedWrite = async (filename: string, bytes: string | Buffer) => {
      const handle = await fs.open(filename, "w", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    };
    const writeJournal = async () => {
      const next = path.join(recovery, "journal.next");
      await syncedWrite(next, JSON.stringify(journal, null, 2));
      await fs.rename(next, journalFile);
      await syncDirectory(recovery);
    };
    const lockBytes = JSON.stringify({
      version: 2,
      pid: process.pid,
      recoveryPath: recovery,
    });
    let lockOwned = false,
      retain = false,
      attempted = false,
      indexPublished = false,
      knownNotCommitted = true,
      committed: string | undefined,
      log = "",
      lockIdentity = "";
    const ownLock = async () => {
      const info = await stat(lock);
      return (
        !!info &&
        `${info.dev}:${info.ino}` === lockIdentity &&
        info.isFile() &&
        (await fs.readFile(lock, "utf8")) === lockBytes
      );
    };
    const assertHead = async (oid: string | null) => {
      const actual = await regularFile(path.join(gitdir, "HEAD"));
      if (!actual) throw stale();
      if (ticket.state.reference) {
        if (
          digest(actual.bytes) !== ticket.state.headIdentity ||
          (
            await this.git(context, ["symbolic-ref", "--quiet", "HEAD"])
          ).stdout.trim() !== ticket.state.reference
        )
          throw stale();
      } else if (actual.bytes.toString("utf8").trim() !== oid) throw stale();
    };
    const refArgs = (message: string) => [
      ...safeArgs,
      `--git-dir=${gitdir}`,
      `--work-tree=${root}`,
      "update-ref",
      "-m",
      message,
      "--stdin",
    ];
    const result = (
      status: GitCommitResult["status"],
      message: string,
    ): GitCommitResult => ({
      scope: ticket.preview.scope,
      status,
      ...(committed ? { commit: committed } : {}),
      message,
      log,
      indexPublished,
      ...(retain ? { recoveryPath: recovery } : {}),
    });
    try {
      await writeJournal();
      const handle = await fs.open(candidate, "wx", 0o600);
      try {
        await handle.writeFile(lockBytes);
        await handle.sync();
        const info = await handle.stat({ bigint: true });
        lockIdentity = `${info.dev}:${info.ino}`;
      } finally {
        await handle.close();
      }
      try {
        await fs.link(candidate, lock);
        lockOwned = true;
        await syncDirectory(gitdir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw Error(
            "Индекс Git занят: существует блокировка index.lock. Существующая блокировка не изменена.",
          );
        throw error;
      }
      if (
        JSON.stringify(await this.capture(context, ticket.preview.paths)) !==
        JSON.stringify(ticket.state)
      )
        throw stale();
      const original = await regularFile(realIndex);
      if (original) {
        await syncedWrite(temporary, original.bytes);
        await syncedWrite(
          path.join(recovery, "original-index"),
          original.bytes,
        );
      }
      const config = await this.config(context),
        existing = ticket.preview.paths.filter(
          (name) => ticket.state.blobs[name] !== null,
        ),
        missing = ticket.preview.paths.filter(
          (name) => ticket.state.blobs[name] === null,
        );
      if (!original)
        await this.git(context, ["read-tree", "--empty"], config.filters, {
          indexFile: temporary,
        });
      // Stage selected whole files once against the original index: unrelated
      // stage entries/flags survive and Git's filemode/encoding rules are kept.
      if (missing.length)
        await this.git(
          context,
          ["update-index", "--force-remove", "-z", "--stdin"],
          config.filters,
          { stdin: missing.join("\0") + "\0", indexFile: temporary },
        );
      if (existing.length)
        await this.withPolicy(
          context,
          async (policy) => {
            await policy.git([
              "add",
              "--all",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ]);
            await policy.verify();
          },
          { stdin: existing.join("\0") + "\0", indexFile: temporary },
        );
      const selectedEntries = (
        await this.git(
          context,
          ["ls-files", "--stage", "-z", "--", ...ticket.preview.paths],
          config.filters,
          { indexFile: temporary },
        )
      ).stdout
        .split("\0")
        .filter(Boolean);
      const actualEntries: Record<string, { mode: string; blob: string }> =
        Object.create(null);
      for (const row of selectedEntries) {
        const match = /^(100644|100755) ([a-f0-9]{40,64}) 0\t([\s\S]+)$/.exec(
          row,
        );
        if (!match) throw Error("Неподдерживаемый тип выбранной записи Git.");
        actualEntries[match[3]] = { mode: match[1], blob: match[2] };
      }
      for (const name of ticket.preview.paths)
        if (
          (actualEntries[name]?.blob ?? null) !== ticket.state.blobs[name] ||
          (actualEntries[name]?.mode ?? null) !== ticket.state.modes[name]
        )
          throw stale();
      const ready = await regularFile(temporary);
      if (!ready) throw Error("Подготовленный индекс отсутствует.");
      await syncedWrite(publication, ready.bytes);
      await syncDirectory(recovery);
      // Commit-tree gets HEAD plus ONLY the selected canonical index entries.
      // The full publication index is kept separately, never used as the tree.
      await this.git(
        context,
        ticket.state.head
          ? ["read-tree", ticket.state.head]
          : ["read-tree", "--empty"],
        config.filters,
        { indexFile: temporary },
      );
      const zero = "0".repeat(
        ticket.state.head?.length ??
          Object.values(ticket.state.blobs).find(Boolean)?.length ??
          40,
      );
      const indexInfo = ticket.preview.paths
        .map((name) =>
          actualEntries[name]
            ? `${actualEntries[name].mode} ${actualEntries[name].blob} 0\t${name}\0`
            : `0 ${zero}\t${name}\0`,
        )
        .join("");
      await this.git(
        context,
        ["update-index", "-z", "--index-info"],
        config.filters,
        { stdin: indexInfo, indexFile: temporary },
      );
      const tree = (
        await this.git(context, ["write-tree"], config.filters, {
          indexFile: temporary,
        })
      ).stdout.trim();
      await syncedWrite(temporary, ready.bytes);
      await syncDirectory(recovery);
      if (
        ticket.state.head &&
        tree ===
          (
            await this.git(
              context,
              ["rev-parse", `${ticket.state.head}^{tree}`],
              config.filters,
            )
          ).stdout.trim()
      )
        return result(
          "not-committed",
          "Выбранные файлы не содержат изменений для коммита. Исходный индекс сохранён.",
        );
      const last = await this.capture(context, ticket.preview.paths);
      if (
        JSON.stringify({ ...last, revision: ticket.state.revision }) !==
          JSON.stringify(ticket.state) ||
        !(await ownLock())
      )
        throw stale();
      await context.verify();
      if (ticket.preview.expiresAt <= this.now())
        throw Error("Подтверждение коммита истекло; подтвердите заново.");
      attempted = true;
      let newCommit: string;
      try {
        const output = await this.git(
          context,
          [
            "commit-tree",
            tree,
            ...(ticket.state.head ? ["-p", ticket.state.head] : []),
            ...(ticket.state.signing ? ["-S"] : []),
            "-F",
            "-",
          ],
          config.filters,
          { stdin: ticket.preview.message },
        );
        log = output.stderr;
        newCommit = output.stdout.trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(newCommit))
          throw Error("Git не подтвердил объект коммита.");
      } catch (error) {
        log +=
          error instanceof CommandExitError
            ? `${error.stdout}${error.stderr}`
            : String(error);
        return result(
          "not-committed",
          "Git не создал подтверждённый объект коммита. Ветки и исходный индекс не изменены.",
        );
      }
      // No ref has moved yet. Validate the object and all selected tree modes.
      const contents = (
        await this.git(context, ["cat-file", "-p", newCommit], config.filters)
      ).stdout;
      const headers = contents.split("\n\n", 1)[0].split("\n"),
        parents = headers
          .filter((line) => line.startsWith("parent "))
          .map((line) => line.slice(7));
      if (
        JSON.stringify(parents) !==
          JSON.stringify(ticket.state.head ? [ticket.state.head] : []) ||
        ident(headers.find((line) => line.startsWith("author "))!.slice(7)) !==
          ticket.state.author ||
        ident(
          headers.find((line) => line.startsWith("committer "))!.slice(10),
        ) !== ticket.state.committer
      )
        throw Error(
          "Созданный объект коммита не соответствует подтверждённому авторству или родителю.",
        );
      const changed = (
        await this.git(
          context,
          [
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            "--no-renames",
            newCommit,
          ],
          config.filters,
        )
      ).stdout
        .split("\0")
        .filter(Boolean);
      if (
        !changed.length ||
        changed.some((name) => !ticket.preview.paths.includes(name))
      )
        throw Error(
          "Состав созданного дерева не соответствует выбранным файлам.",
        );
      const treeRows = (
          await this.git(
            context,
            ["ls-tree", "-z", newCommit, "--", ...ticket.preview.paths],
            config.filters,
          )
        ).stdout
          .split("\0")
          .filter(Boolean),
        treeEntries: Record<string, { mode: string; blob: string }> =
          Object.create(null);
      for (const row of treeRows) {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (!match) throw Error("Неподдерживаемый тип созданного дерева Git.");
        treeEntries[match[3]] = { mode: match[1], blob: match[2] };
      }
      for (const name of ticket.preview.paths)
        if (
          (treeEntries[name]?.blob ?? null) !== ticket.state.blobs[name] ||
          (treeEntries[name]?.mode ?? null) !== ticket.state.modes[name]
        )
          throw Error(
            "Содержимое или режим файла отличаются от подтверждённых.",
          );
      journal.new = newCommit;
      journal.state = "ref-preparing";
      await writeJournal();
      try {
        const update = await context.refTransaction!(
          refArgs(`commit: ${ticket.preview.message.split(/\r?\n/, 1)[0]}`),
          `start\nupdate HEAD ${newCommit} ${ticket.state.head ?? zero}\nprepare\n`,
          async (assertPreparedActive) => {
            // Git owns HEAD+resolved ref locks. Raw and recursive symbolic identity
            // must both match: a branch can itself become a symbolic-ref chain.
            await assertHead(ticket.state.head);
            const prepared = await this.capture(context, ticket.preview.paths);
            if (
              JSON.stringify({
                ...prepared,
                revision: ticket.state.revision,
              }) !== JSON.stringify(ticket.state) ||
              !(await ownLock()) ||
              (await indexFingerprint(root)) !== ticket.state.index
            )
              throw stale();
            await context.verify();
            if (ticket.preview.expiresAt <= this.now())
              throw Error("Подтверждение коммита истекло; подтвердите заново.");
            assertPreparedActive();
            journal.state = "ref-commit-authorized";
            await writeJournal();
            assertPreparedActive();
          },
        );
        log += update.stdout + update.stderr;
      } catch (error) {
        log +=
          error instanceof GitRefTransactionError
            ? `${error.stdout}${error.stderr}\n${error.message}`
            : String(error);
        if (error instanceof GitRefTransactionError && !error.commitSent) {
          knownNotCommitted = true;
          return result(
            "not-committed",
            "Коммит не применён: подтверждение транзакции отклонено. Ветки и исходный индекс не изменены.",
          );
        }
        knownNotCommitted = false;
        retain = true;
        journal.state = "ref-outcome-uncertain";
        await writeJournal().catch(() => {});
        return result(
          "uncertain",
          "Результат публикации Git ref неизвестен. Не повторяйте коммит; сохранены журнал и индексы для проверки.",
        );
      }
      committed = newCommit;
      knownNotCommitted = false;
      journal.state = "committed-unpublished";
      await writeJournal();
      // A second read-only prepared transaction closes the ACK→index gap. It
      // pins HEAD and its referent while the real index is atomically published.
      const verifiedPublication = await context.refTransaction!(
        refArgs("goga: verify index publication"),
        `start\nverify HEAD ${newCommit}\nprepare\n`,
        async (assertPreparedActive) => {
          await assertHead(newCommit);
          await context.verify();
          if (
            !(await ownLock()) ||
            (await indexFingerprint(root)) !== ticket.state.index
          )
            throw stale();
          const expected = await regularFile(publication);
          if (!expected || digest(expected.bytes) !== digest(ready.bytes))
            throw Error("Подготовленный индекс изменился.");
          // NO await between guard, publication and its recorded outcome: timeout
          // cannot release native ref locks and allow this write to happen later.
          this.options.beforePublishIndex?.(publication, realIndex);
          assertPreparedActive();
          renameSync(publication, realIndex);
          indexPublished = true;
          this.options.afterPublishIndex?.(publication, realIndex);
          await syncDirectory(gitdir);
          assertPreparedActive();
          journal.state = "published";
          await writeJournal();
          assertPreparedActive();
        },
      );
      log += verifiedPublication.stdout + verifiedPublication.stderr;
      // Git may ACK a successful read-only transaction yet fail to unlink its
      // native ref locks. Never discard that warning or delete recovery state;
      // those locks belong to Git, not to our owned index-lock cleanup.
      if (verifiedPublication.stderr.trim()) {
        retain = true;
        journal.state = "published-native-warning";
        await writeJournal().catch(() => {});
        return result(
          "committed",
          "Коммит создан и индекс опубликован, но Git сообщил предупреждение при завершении транзакции. Не повторяйте коммит; проверьте сохранённый журнал и блокировки Git.",
        );
      }
      return result(
        "committed",
        "Локальный коммит создан. Посторонние подготовленные изменения сохранены.",
      );
    } catch (error) {
      if (!attempted) throw error;
      log += `\n${error instanceof GitRefTransactionError ? `${error.message}\n${error.stdout}${error.stderr}` : error instanceof Error ? error.message : String(error)}`;
      if (knownNotCommitted && !committed)
        return result(
          "not-committed",
          "Объект не применён к ветке. Ветки и исходный индекс не изменены.",
        );
      retain = true;
      journal.state = indexPublished
        ? "published-needs-check"
        : committed
          ? "committed-unpublished"
          : "uncertain";
      await writeJournal().catch(() => {});
      return result(
        committed ? "committed" : "uncertain",
        indexPublished
          ? "Коммит создан и индекс опубликован, но окончательное подтверждение не получено. Не повторяйте коммит; сохранён материал восстановления."
          : committed
            ? "Коммит создан, но индекс не опубликован. Не повторяйте коммит; сохранены журнал, частный индекс и блокировка."
            : "Результат операции неизвестен. Не повторяйте коммит; проверьте сохранённый журнал и HEAD.",
      );
    } finally {
      if (!retain) {
        try {
          if (lockOwned) {
            if (!(await ownLock()))
              throw Error(
                "Владелец блокировки Git изменился; очистка остановлена.",
              );
            await fs.unlink(lock);
            await syncDirectory(gitdir);
          }
          await fs.rm(recovery, { recursive: true, force: true });
        } catch (error) {
          if (!attempted) throw error;
          retain = true;
          journal.state = indexPublished
            ? "published-needs-cleanup"
            : committed
              ? "committed-unpublished"
              : knownNotCommitted
                ? "not-committed-needs-cleanup"
                : "uncertain";
          await writeJournal().catch(() => {});
          log += `\n${error instanceof Error ? error.message : String(error)}`;
          return result(
            committed
              ? "committed"
              : knownNotCommitted
                ? "not-committed"
                : "uncertain",
            committed
              ? "Коммит создан, но очистка служебного состояния не завершена. Не повторяйте коммит; проверьте сохранённый журнал."
              : "Очистка служебного состояния Git не завершена. Перед повторением проверьте сохранённый журнал и HEAD.",
          );
        }
      }
    }
  }
}
