import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import {
  gitCommitRequestSchema,
  type GitCommitPreview,
  type GitCommitRequest,
  type GitCommitResult,
} from "../shared/git-commit";
import {
  gitFilePathSchema,
  type GitWorkspaceSnapshot,
} from "../shared/git-workspace";
import { withPrivateGitIndexWrite } from "./git-index-scope";
import type { NativeGitCapability } from "./git-native-context";
import { withPrivateGitRead, type PrivateGitRead } from "./git-private-read";

export interface GitCommitContext {
  scope: ScopeRef;
  root: string;
  /** Complete owner and effective settings identity, reconstructed by HostService. */
  ownerKey: string;
  native?: NativeGitCapability;
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
/** Serial admission is supplied by HostService. Tickets never authorize a path or
 * a project by themselves: their context is reconstructed inside each operation. */
export abstract class GitWorkspaceActions {
  protected tickets = new Map<string, Ticket>();
  constructor(
    protected readonly options: {
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
  protected now() {
    return this.options.now?.() ?? Date.now();
  }
  protected git(
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
  protected withPolicy<T>(
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
  protected async capture(
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
  abstract execute(input: string): Promise<GitCommitResult>;
}
