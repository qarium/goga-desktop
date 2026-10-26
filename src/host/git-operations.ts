import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  lstatSync,
  openSync,
  readFileSync,
  closeSync,
  unlinkSync,
  writeFileSync,
  fsyncSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { type ScopeRef } from "../shared/context";
import {
  gitMergeOperationRequestSchema,
  gitMergeOperationTokenSchema,
  type GitMergeOperationRequest,
  type GitMergeOperationPreview,
  type GitMergeOperationResult,
} from "../shared/git-operations";
import { gitFilePathSchema } from "../shared/git-workspace";
import { type GitCommitContext } from "./git-workspace-actions";
import {
  GitMergeSafety,
  GitMetadataLockCleanupError,
  type GitMergeContext,
  type State,
  type MergeDestinations,
  auditMetadata,
  digest,
  fileIdentity,
  contentIdentity,
  mixedOperations,
  oid,
  stale,
  stat,
} from "./git-merge-safety";
import { CommandExitError, GitRefTransactionError } from "./process";
import { sanitizeRepositoryLog } from "./repository-actions";

const cleanupFiles = [
  "MERGE_HEAD",
  "MERGE_MSG",
  "MERGE_MODE",
  "AUTO_MERGE",
] as const;
const ident = (raw: string) => {
  const match = /^(.+ <[^<>\r\n]+>) \d+ [+-]\d{4}\s*$/.exec(raw);
  if (!match) throw Error("Git не подтвердил автора коммита.");
  return match[1];
};
type GitMergeOperationContext = GitCommitContext &
  Pick<GitMergeContext, "sanitizeDiagnostics">;
interface Validation {
  source: string;
  attributes: string;
  message: string;
  author: string | null;
  committer: string | null;
  signing: boolean;
  paths: string[];
  metadata: Record<string, string>;
}
interface Ticket {
  preview: GitMergeOperationPreview;
  request: GitMergeOperationRequest;
  state: State;
  validation: Validation;
  ownerKey: string;
}
/** No branch/create/fetch capability. Host supplies the exact current owner and
 * serial admission, just as for selected-file commits. */
export class GitMergeOperations extends GitMergeSafety {
  private tickets = new Map<string, Ticket>();
  constructor(
    private readonly options: {
      context: <T>(
        scope: ScopeRef,
        action: (ctx: GitMergeOperationContext) => Promise<T>,
      ) => Promise<T>;
      now?: () => number;
      /** Host-only fault-injection seam, never exposed through IPC. */
      beforeCleanup?: () => void;
      afterCleanupFile?: (name: string) => void;
      beforeRemoveRecovery?: () => void;
      releaseLockFault?: (name: string, phase: "before" | "after") => void;
    },
  ) {
    super();
  }
  protected override releaseLockFault(name: string, phase: "before" | "after") {
    this.options.releaseLockFault?.(name, phase);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private adapt(ctx: GitCommitContext): GitMergeContext {
    return {
      ...ctx,
      git: (args, stdin) => ctx.git(args, { stdin }),
      privateGit: (args, indexFile) => ctx.git(args, { indexFile }),
    };
  }
  private mergeOptions(branch: string) {
    return [
      "-c",
      `branch.${branch}.mergeOptions=`,
      "-c",
      "rerere.enabled=false",
      "-c",
      "rerere.autoupdate=false",
      "-c",
      "merge.autoStash=false",
    ];
  }
  private async validate(
    ctx: GitMergeContext,
    state: State,
    action: "continue" | "abort",
    explicitMessage?: string,
  ): Promise<Validation> {
    await auditMetadata(ctx.root);
    const s = state.snapshot;
    if (!s.branch || !s.head || s.operation !== "merge")
      throw Error(
        "Доступно только обычное незавершённое слияние на текущей локальной ветке.",
      );
    const ref = `refs/heads/${s.branch}`;
    if (
      state.worktrees.split("\0").filter((row) => row === `branch ${ref}`)
        .length !== 1 ||
      !state.inventory.local.some(
        (row) => row.ref === ref && row.oid === s.head,
      ) ||
      (
        await this.git(ctx, ["symbolic-ref", "--no-recurse", "HEAD"])
      ).stdout.trim() !== ref ||
      (await this.git(ctx, ["symbolic-ref", "HEAD"])).stdout.trim() !== ref
    )
      throw Error(
        "Текущая ветка неоднозначна или занята другой рабочей копией.",
      );
    for (const name of [...mixedOperations, "MERGE_AUTOSTASH", "SQUASH_MSG"])
      if (await stat(path.join(ctx.root, ".git", name)))
        throw Error(
          "Смешанная или неподдерживаемая операция Git. Автоматическое продолжение/отмена запрещены.",
        );
    for (const name of [
      "index.lock",
      "HEAD.lock",
      "config.lock",
      "packed-refs.lock",
    ])
      if (await stat(path.join(ctx.root, ".git", name)))
        throw Error("Репозиторий занят другой операцией Git.");
    if (
      state.config.some(([key]) =>
        /^(filter\..+\.(clean|smudge|process|required)|merge\..+\.driver)$/i.test(
          key,
        ),
      )
    )
      throw Error(
        "Внешние filters/merge drivers не поддерживаются для безопасного завершения слияния.",
      );
    if (
      (await this.git(ctx, ["ls-files", "-v", "-z"])).stdout
        .split("\0")
        .some((row) => row && (/^[a-z] /.test(row) || row.startsWith("S ")))
    )
      throw Error(
        "Индекс скрывает изменения: assume-unchanged/skip-worktree не поддерживаются.",
      );
    const merge = await this.mergeState(ctx, state);
    if (action === "continue" && merge.conflictCount)
      throw Error(
        "Сначала разрешите все конфликты: индекс содержит unmerged пути.",
      );
    if (merge.source === s.head)
      throw Error("Некорректная идентичность незавершённого слияния.");
    await this.assertNoGitlinks(ctx, [s.head, merge.source]);
    const metadata: Record<string, string> = {};
    for (const name of [...cleanupFiles, "ORIG_HEAD"])
      metadata[name] = await fileIdentity(path.join(ctx.root, ".git", name));
    if (metadata.AUTO_MERGE === "missing" || metadata.MERGE_MSG === "missing")
      throw Error(
        "Нет исходного AUTO_MERGE/MERGE_MSG: безопасная принадлежность изменений слиянию не подтверждена.",
      );
    oid(
      (
        await fs.readFile(path.join(ctx.root, ".git/AUTO_MERGE"), "utf8")
      ).trim(),
    );
    const mode =
      metadata.MERGE_MODE === "missing"
        ? ""
        : await fs.readFile(path.join(ctx.root, ".git/MERGE_MODE"), "utf8");
    if (!["", "no-ff"].includes(mode.trim()))
      throw Error("Неподдерживаемый режим исходного слияния.");
    const rawMessage = await fs.readFile(path.join(ctx.root, ".git/MERGE_MSG"));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(rawMessage);
    if (rawMessage.length > 1024 * 1024 || text.includes("\0") || !text.trim())
      throw Error("Неподдерживаемый размер или текст MERGE_MSG.");
    const paths = (
      await this.git(ctx, [
        "diff",
        "--cached",
        "--name-only",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "-z",
        s.head,
        "--",
      ])
    ).stdout
      .split("\0")
      .filter(Boolean)
      .map((p) => gitFilePathSchema.parse(p));
    if (
      paths.length > 10000 ||
      paths.reduce((n, p) => n + p.length, 0) > 1024 * 1024
    )
      throw Error(
        "Слишком много файлов для безопасного предпросмотра слияния.",
      );
    let author: string | null = null,
      committer: string | null = null,
      signing = false,
      message = "";
    if (action === "continue") {
      // No author placeholders or editor. Native identity and signing are preserved.
      const identityArgs = ["-c", "user.useConfigOnly=true"];
      author = ident(
        (await this.git(ctx, [...identityArgs, "var", "GIT_AUTHOR_IDENT"]))
          .stdout,
      );
      committer = ident(
        (await this.git(ctx, [...identityArgs, "var", "GIT_COMMITTER_IDENT"]))
          .stdout,
      );
      const value = (
        await this.git(ctx, [
          "config",
          "--type=bool",
          "--default=false",
          "--get",
          "commit.gpgsign",
        ])
      ).stdout.trim();
      if (!["true", "false"].includes(value))
        throw Error("Git не подтвердил настройку подписи.");
      signing = value === "true";
      const cleanups = state.config
        .filter(([key]) => key.toLowerCase() === "commit.cleanup")
        .map(([, value]) => value);
      if (
        cleanups.some(
          (value) => !["default", "whitespace", "verbatim"].includes(value),
        )
      )
        throw Error(
          "Этот commit.cleanup не поддерживается без редактора. Завершите слияние самостоятельно.",
        );
      const requestedMessage = explicitMessage ?? text;
      message =
        cleanups.at(-1) === "verbatim"
          ? requestedMessage
          : (await this.git(ctx, ["stripspace"], requestedMessage)).stdout;
      if (!message.trim()) throw Error("Пустое сообщение слияния.");
      const entries = (
        await this.git(ctx, ["ls-files", "--stage", "-z"])
      ).stdout
        .split("\0")
        .filter(Boolean);
      for (const row of entries) {
        const match = /^(\d{6}) ([a-f0-9]+) 0\t(.+)$/s.exec(row);
        if (!match)
          throw Error("Неразрешённый или неподдерживаемый индекс Git.");
        if (
          paths.includes(match[3]) &&
          !["100644", "100755"].includes(match[1])
        )
          throw Error(
            "Изменённые symlink/специальные файлы в слиянии не поддерживаются.",
          );
      }
      for (const name of paths) {
        const info = await stat(path.join(ctx.root, name));
        if (
          info &&
          (!info.isFile() ||
            info.isSymbolicLink() ||
            info.nlink !== 1n ||
            info.size > 256n * 1024n * 1024n)
        )
          throw Error(
            "Небезопасный тип или размер разрешённого файла слияния.",
          );
      }
    }
    return {
      source: merge.source,
      attributes: await this.mergeAttributes(ctx, s.head, merge.source),
      message,
      author,
      committer,
      signing,
      paths,
      metadata,
    };
  }
  async prepare(
    input: GitMergeOperationRequest,
  ): Promise<GitMergeOperationPreview> {
    const request = gitMergeOperationRequestSchema.parse(input);
    return this.options.context(request.scope, async (original) => {
      if (request.action === "continue" && !original.refTransaction)
        throw Error(
          "Исполнитель не поддерживает безопасную транзакцию refs. Завершение не начато.",
        );
      const ctx = this.adapt(original),
        state = await this.capture(ctx, request.scope);
      if (state.snapshot.revision !== request.revision) throw stale();
      const validation = await this.validate(
        ctx,
        state,
        request.action,
        request.action === "continue" ? request.message : undefined,
      );
      if (
        (await this.capture(ctx, request.scope)).fingerprint !==
        state.fingerprint
      )
        throw stale();
      const preview: GitMergeOperationPreview = {
        token: randomBytes(32).toString("hex"),
        scope: request.scope,
        root: ctx.root,
        operation: "merge",
        action: request.action,
        branch: state.snapshot.branch!,
        head: state.snapshot.head!,
        sourceOid: validation.source,
        paths: validation.paths,
        message: validation.message,
        author: validation.author,
        committer: validation.committer,
        signing: validation.signing,
        hooks: "disabled",
        expiresAt: this.now() + 300000,
        effects:
          request.action === "continue"
            ? "Создать merge-коммит из текущего индекса: только исходное слияние и разрешения его конфликтов. Принадлежность будет проверена после подтверждения; посторонние staged изменения приведут к отказу. Рабочие файлы и индекс не переписываются; хуки отключены."
            : "Отменить только текущее слияние. Разрешения исходных конфликтов будут отброшены; посторонние staged изменения приведут к отказу. Несвязанные рабочие файлы сохраняются; хуки отключены.",
      };
      for (const [token, ticket] of this.tickets)
        if (ticket.preview.expiresAt <= this.now()) this.tickets.delete(token);
      while (this.tickets.size >= 64)
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(
        preview.token,
        structuredClone({
          preview,
          request,
          state,
          validation,
          ownerKey: ctx.ownerKey,
        }),
      );
      return structuredClone(preview);
    });
  }
  async execute(input: string): Promise<GitMergeOperationResult> {
    const token = gitMergeOperationTokenSchema.parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now()) throw stale();
    let executed: GitMergeOperationResult | undefined;
    let sanitize = (value: string) => sanitizeRepositoryLog(value);
    const diagnostics = (
      result: GitMergeOperationResult,
    ): GitMergeOperationResult => ({
      ...result,
      message: sanitize(result.message),
      log: sanitize(result.log),
    });
    try {
      const result = await this.options.context(
        ticket.request.scope,
        async (original) => {
          sanitize = original.sanitizeDiagnostics ?? sanitize;
          if (original.ownerKey !== ticket.ownerKey) throw stale();
          if (ticket.request.action === "continue" && !original.refTransaction)
            throw Error("Безопасная транзакция refs недоступна.");
          const ctx = this.adapt(original),
            state = await this.capture(ctx, ticket.request.scope);
          if (state.fingerprint !== ticket.state.fingerprint) throw stale();
          const validation = await this.validate(
            ctx,
            state,
            ticket.request.action,
            ticket.request.action === "continue"
              ? ticket.request.message
              : undefined,
          );
          if (JSON.stringify(validation) !== JSON.stringify(ticket.validation))
            throw stale();
          return this.withMetadataLock(
            ctx,
            "config.lock",
            async () => {
              if (
                (await this.capture(ctx, ticket.request.scope)).fingerprint !==
                state.fingerprint
              )
                throw stale();
              // Object creation only after explicit confirmation, before live mutation.
              const tree = await this.protectMergeDestinations(
                ctx,
                state,
                validation.source,
                this.mergeOptions(state.snapshot.branch!),
              );
              await this.assertAbortIndex(ctx, tree);
              if (
                (await this.mergeAttributes(
                  ctx,
                  state.snapshot.head!,
                  validation.source,
                  tree.incoming,
                )) !== validation.attributes
              )
                throw stale();
              if (ticket.request.action === "continue")
                return (executed = this.holdConfigForUnknown(
                  await this.complete(original, ctx, ticket),
                ));
              const indexPaths = await this.indexPaths(ctx);
              const destinations: MergeDestinations = {
                current: new Set(indexPaths),
                incoming: [...tree.current],
                tracked: new Set([...tree.current, ...indexPaths]),
                original: {
                  paths: new Set(tree.incoming),
                  conflicts: tree.conflicts,
                },
              };
              return (executed = this.holdConfigForUnknown(
                await this.abort(ctx, ticket, destinations),
              ));
            },
            () => executed?.lockRetained ?? false,
          );
        },
      );
      if (
        result.recoveryPath &&
        !result.lockRetained &&
        result.status !== "uncertain"
      ) {
        this.options.beforeRemoveRecovery?.();
        await fs.rm(result.recoveryPath, { recursive: true, force: true });
        delete result.recoveryPath;
      }
      return diagnostics(result);
    } catch (error) {
      const retained = [...(executed?.retainedLocks ?? [])];
      if (
        error instanceof GitMetadataLockCleanupError &&
        error.retained &&
        !retained.includes(error.lock)
      )
        retained.push(error.lock);
      const unchecked = [...(executed?.uncheckedLocks ?? [])];
      if (
        error instanceof GitMetadataLockCleanupError &&
        error.unchecked &&
        !unchecked.includes(error.lock)
      )
        unchecked.push(error.lock);
      const cleanupState = {
        uncheckedLocks: unchecked,
        lockRetained: retained.length > 0,
        retainedLocks: retained,
      };
      if (executed) executed = await this.recoveryDiagnostics(executed);
      if (executed?.changed)
        return diagnostics({
          ...executed,
          ...cleanupState,
          status: "uncertain",
          message:
            "Операция Git могла изменить состояние; итоговое подтверждение контекста не получено. Проверьте состояние; не повторяйте автоматически.",
          log: sanitizeRepositoryLog(executed.log + this.errorLog(error)),
        });
      return diagnostics(
        this.result(
          ticket,
          "error",
          false,
          error instanceof Error ? error.message : String(error),
          {
            ...executed,
            ...cleanupState,
            status: "error",
            changed: false,
            message: sanitizeRepositoryLog(
              error instanceof Error ? error.message : String(error),
            ),
            log: sanitizeRepositoryLog(
              (executed?.log ?? "") + this.errorLog(error),
            ),
          },
        ),
      );
    }
  }
  private result(
    ticket: Ticket,
    status: GitMergeOperationResult["status"],
    changed: boolean,
    message: string,
    extras: Partial<GitMergeOperationResult> = {},
  ): GitMergeOperationResult {
    return {
      scope: ticket.request.scope,
      operation: "merge",
      action: ticket.request.action,
      status,
      changed,
      lockRetained: false,
      message: sanitizeRepositoryLog(message),
      log: "",
      ...extras,
    };
  }
  private async abort(
    ctx: GitMergeContext,
    ticket: Ticket,
    destinations: MergeDestinations,
  ): Promise<GitMergeOperationResult> {
    const result = await this.pinnedMergeAbort(
      ctx,
      ticket.state,
      destinations,
      async () => {
        await ctx.verify();
        if (
          ticket.preview.expiresAt <= this.now() ||
          (await this.mergeAttributes(
            ctx,
            ticket.preview.head,
            ticket.preview.sourceOid,
            destinations.incoming,
          )) !== ticket.validation.attributes
        )
          throw stale();
      },
    );
    return this.result(ticket, result.status, result.changed, result.message, {
      ...result,
      retainedLocks: result.lockRetained
        ? [...result.retainedLocks, "config.lock"]
        : [],
      message: sanitizeRepositoryLog(result.message),
      log: sanitizeRepositoryLog(result.log),
    });
  }

  private errorLog(error: unknown) {
    const e = error as { message?: string; stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}\n${e.message ?? String(error)}`;
  }
  /** Only index.lock is ours. Native prepared transactions own HEAD/ref locks.
   * Index/worktree are never published or rewritten by merge completion. */
  private async complete(
    original: GitCommitContext,
    ctx: GitMergeContext,
    ticket: Ticket,
  ): Promise<GitMergeOperationResult> {
    const gitdir = path.join(ctx.root, ".git"),
      lock = path.join(gitdir, "index.lock"),
      recovery = path.join(gitdir, `goga-merge-${randomUUID()}`),
      privateIndex = path.join(recovery, "index"),
      journalFile = path.join(recovery, "journal.json");
    const indexIdentity = await fileIdentity(path.join(gitdir, "index"));
    let lockHandle: Awaited<ReturnType<typeof fs.open>> | undefined,
      lockIdentity = "",
      lockOwned = false,
      lockUnchecked = false,
      recoveryPresent = false,
      retain = false,
      publishAttempted = false,
      knownNotPublished = true,
      commit: string | undefined,
      log = "";
    const journal = {
      version: 1,
      scope: ticket.request.scope,
      root: ctx.root,
      head: ticket.preview.head,
      branch: ticket.preview.branch,
      source: ticket.preview.sourceOid,
      commit: null as string | null,
      state: "prepared",
      removed: [] as string[],
      metadata: ticket.validation.metadata,
    };
    const writeJournal = () => {
      const fd = openSync(journalFile, "w", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(journal, null, 2));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    const ownLock = async () => {
      const info = await stat(lock);
      return (
        !!info && `${info.dev}:${info.ino}` === lockIdentity && info.isFile()
      );
    };
    const assertHead = async (expected: string) => {
      const ref = `refs/heads/${ticket.preview.branch}`;
      if (
        (await fs.readFile(path.join(gitdir, "HEAD"), "utf8")) !==
          `ref: ${ref}\n` ||
        (
          await this.git(ctx, ["symbolic-ref", "--no-recurse", "HEAD"])
        ).stdout.trim() !== ref ||
        (await this.git(ctx, ["symbolic-ref", "HEAD"])).stdout.trim() !== ref ||
        (
          await this.git(ctx, ["rev-parse", "--verify", "HEAD"])
        ).stdout.trim() !== expected
      )
        throw stale();
    };
    const metadataUnchanged = async () => {
      for (const [name, identity] of Object.entries(ticket.validation.metadata))
        if ((await fileIdentity(path.join(gitdir, name))) !== identity)
          throw stale();
    };
    const result = (
      status: GitMergeOperationResult["status"],
      message: string,
    ) =>
      this.result(ticket, status, status !== "error", message, {
        ...(commit && status !== "error" ? { commit } : {}),
        ...(recoveryPresent ? { recoveryPath: recovery } : {}),
        lockRetained: retain && lockOwned,
        retainedLocks: retain && lockOwned ? ["index.lock", "config.lock"] : [],
        uncheckedLocks: lockUnchecked ? ["index.lock"] : [],
        log: sanitizeRepositoryLog(log),
      });
    try {
      lockHandle = await fs.open(
        lock,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      const info = await lockHandle.stat({ bigint: true });
      lockIdentity = `${info.dev}:${info.ino}`;
      lockOwned = true;
      await lockHandle.writeFile(
        JSON.stringify({ pid: process.pid, recoveryPath: recovery }),
      );
      await lockHandle.sync();
      if (
        (await this.capture(ctx, ticket.request.scope)).fingerprint !==
        ticket.state.fingerprint
      )
        throw stale();
      await fs.mkdir(recovery, { mode: 0o700 });
      recoveryPresent = true;
      await fs.copyFile(
        path.join(gitdir, "index"),
        privateIndex,
        constants.COPYFILE_EXCL,
      );
      for (const name of cleanupFiles)
        if (ticket.validation.metadata[name] !== "missing")
          await fs.copyFile(
            path.join(gitdir, name),
            path.join(recovery, name),
            constants.COPYFILE_EXCL,
          );
      writeJournal();
      const tree = oid(
        (
          await original.git(this.args(ctx, ["write-tree"]), {
            indexFile: privateIndex,
          })
        ).stdout.trim(),
      );
      if (
        (await this.capture(ctx, ticket.request.scope)).fingerprint !==
          ticket.state.fingerprint ||
        !(await ownLock()) ||
        ticket.preview.expiresAt <= this.now()
      )
        throw stale();
      await ctx.verify();
      const out = await this.git(
        ctx,
        [
          "-c",
          "user.useConfigOnly=true",
          "commit-tree",
          tree,
          "-p",
          ticket.preview.head,
          "-p",
          ticket.preview.sourceOid,
          ...(ticket.validation.signing ? ["-S"] : []),
          "-F",
          "-",
        ],
        ticket.validation.message,
      );
      log += out.stderr;
      commit = oid(out.stdout.trim());
      journal.commit = commit;
      const contents = (await this.git(ctx, ["cat-file", "-p", commit])).stdout;
      const headers = contents.split("\n\n", 1)[0].split("\n");
      if (
        headers.find((line) => line.startsWith("tree ")) !== `tree ${tree}` ||
        JSON.stringify(
          headers
            .filter((line) => line.startsWith("parent "))
            .map((line) => line.slice(7)),
        ) !== JSON.stringify([ticket.preview.head, ticket.preview.sourceOid]) ||
        ident(
          headers.find((line) => line.startsWith("author "))?.slice(7) ?? "",
        ) !== ticket.validation.author ||
        ident(
          headers.find((line) => line.startsWith("committer "))?.slice(10) ??
            "",
        ) !== ticket.validation.committer ||
        (ticket.validation.signing &&
          !headers.some((line) => /^gpgsig(?:-sha256)? /.test(line)))
      )
        throw Error(
          "Объект merge-коммита не соответствует подтверждённым parents/tree/author/signing.",
        );
      const refArgs = this.args(ctx, [
        "update-ref",
        "-m",
        "goga: complete merge",
        "--stdin",
      ]);
      journal.state = "ref-preparing";
      writeJournal();
      publishAttempted = true;
      try {
        const updated = await original.refTransaction!(
          refArgs,
          `start\nupdate HEAD ${commit} ${ticket.preview.head}\nprepare\n`,
          async (active) => {
            await assertHead(ticket.preview.head);
            if (
              (await this.capture(ctx, ticket.request.scope)).fingerprint !==
                ticket.state.fingerprint ||
              !(await ownLock()) ||
              ticket.preview.expiresAt <= this.now()
            )
              throw stale();
            await metadataUnchanged();
            await ctx.verify();
            if (
              (await this.mergeAttributes(
                ctx,
                ticket.preview.head,
                ticket.preview.sourceOid,
              )) !== ticket.validation.attributes
            )
              throw stale();
            active();
            journal.state = "ref-commit-authorized";
            writeJournal();
            active();
          },
        );
        log += updated.stdout + updated.stderr;
        knownNotPublished = false;
      } catch (error) {
        if (error instanceof GitRefTransactionError && !error.commitSent) {
          knownNotPublished = true;
          throw error;
        }
        knownNotPublished = false;
        throw error;
      }
      journal.state = "committed-pending-cleanup";
      writeJournal();
      const cleanup = await original.refTransaction!(
        refArgs,
        `start\nverify HEAD ${commit}\nprepare\n`,
        async (active) => {
          await assertHead(commit!);
          await ctx.verify();
          // Compare exact live index to the preview, not private write-tree's cache.
          if (
            !(await ownLock()) ||
            (await fileIdentity(path.join(gitdir, "index"))) !== indexIdentity
          )
            throw stale();
          await metadataUnchanged();
          const after = await this.capture(ctx, ticket.request.scope);
          if (
            JSON.stringify(after.config) !==
              JSON.stringify(ticket.state.config) ||
            after.worktrees !==
              ticket.state.worktrees.replace(
                `HEAD ${ticket.preview.head}\0`,
                `HEAD ${commit}\0`,
              )
          )
            throw stale();
          for (const [name, identity] of ticket.state.content)
            if ((await contentIdentity(path.join(ctx.root, name))) !== identity)
              throw stale();
          if (
            (await this.mergeAttributes(
              ctx,
              ticket.preview.head,
              ticket.preview.sourceOid,
            )) !== ticket.validation.attributes
          )
            throw stale();
          this.options.beforeCleanup?.();
          // Entire final guard and cleanup is synchronous under the prepared pin.
          // Direct uncooperative filesystem tampering after this guard is not atomic.
          for (const name of cleanupFiles)
            if (
              this.syncIdentity(path.join(gitdir, name)) !==
              ticket.validation.metadata[name]
            )
              throw stale();
          active();
          for (const name of cleanupFiles)
            if (ticket.validation.metadata[name] !== "missing") {
              unlinkSync(path.join(gitdir, name));
              journal.removed.push(name);
              this.options.afterCleanupFile?.(name);
            }
          journal.state = "cleared";
          writeJournal();
          active();
        },
      );
      log += cleanup.stdout + cleanup.stderr;
      await ctx.verify();
      const after = await this.capture(ctx, ticket.request.scope);
      if (
        after.snapshot.head !== commit ||
        after.snapshot.branch !== ticket.preview.branch ||
        after.snapshot.operation !== "none" ||
        cleanup.stderr.trim()
      )
        throw stale();
      return result(
        "success",
        "Слияние завершено. Индекс и рабочие файлы сохранены; публикация не выполнялась.",
      );
    } catch (error) {
      log += this.errorLog(error);
      if (publishAttempted && !knownNotPublished) {
        retain = true;
        journal.state = "uncertain";
        try {
          writeJournal();
        } catch {}
        return result(
          "uncertain",
          "Результат завершения слияния не подтверждён. Не повторяйте операцию: сохранены материалы проверки и блокировка индекса. Автоматическая отмена не выполнялась.",
        );
      }
      return result(
        "error",
        "Слияние не завершено: ветки, индекс и рабочие файлы не изменены. " +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      if (lockHandle) {
        try {
          await lockHandle.close();
        } catch (error) {
          retain = true;
          log += this.errorLog(error);
          return result(
            publishAttempted && !knownNotPublished ? "uncertain" : "error",
            "Не удалось подтвердить закрытие служебной блокировки. Проверьте состояние Git.",
          );
        }
      }
      if (!retain && lockIdentity) {
        try {
          if (!(await ownLock()))
            throw Error("Владелец блокировки индекса изменился.");
          await fs.unlink(lock);
          lockOwned = false;
          // Recovery belongs to execute until the outer config lock and owner
          // context also settle; a late failure must retain its journal.
        } catch (error) {
          retain = true;
          try {
            lockOwned = await ownLock();
          } catch (probe) {
            lockOwned = false;
            lockUnchecked = true;
            log += this.errorLog(probe);
          }
          log += this.errorLog(error);
          return this.recoveryDiagnostics(
            result(
              publishAttempted && !knownNotPublished ? "uncertain" : "error",
              "Очистка служебного состояния не подтверждена; проверьте журнал и блокировки, не повторяйте автоматически.",
            ),
          );
        }
      }
    }
  }
  private syncIdentity(file: string) {
    let info;
    try {
      info = lstatSync(file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.size > 256n * 1024n * 1024n
    )
      throw stale();
    const fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      return `${[info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":")}:${digest(readFileSync(fd))}`;
    } finally {
      closeSync(fd);
    }
  }
}
