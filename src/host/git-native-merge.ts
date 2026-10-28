import {
  withNativeGitCompletion,
  deferNativeGitRecovery,
} from "./git-native-completion";
import { randomBytes } from "node:crypto";
import path from "node:path";
import * as fs from "node:fs/promises";
import {
  gitMergeOperationRequestSchema,
  gitMergeOperationTokenSchema,
  type GitMergeOperationRequest,
  type GitMergeOperationPreview,
  type GitMergeOperationResult,
} from "../shared/git-operations";
import type { ScopeRef } from "../shared/context";
import {
  GitMergeSafety,
  GitMetadataLockCleanupError,
  auditMetadata,
  mixedOperations,
  oid,
  stale,
  stat,
  type GitMergeContext,
  type State,
} from "./git-merge-safety";
import { nativeIntent } from "./git-native-context";
import type { NativeGitState } from "./git-native-state";
import { sanitizeRepositoryLog } from "./repository-actions";

const external = () =>
  Error(
    "Происхождение слияния не подтверждено журналом Desktop. Продолжите внешнюю операцию в терминале.",
  );
function indexEntries(state: NativeGitState) {
  const result = new Map<string, string[]>();
  for (const row of new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.from(state.indexData, "base64"))
    .split("\0")
    .filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/s.exec(
      row,
    );
    if (!match) throw stale();
    const entries = result.get(match[4]) ?? [];
    entries.push(match.slice(1, 4).join(" "));
    result.set(match[4], entries);
  }
  return result;
}
function changedIndex(a: NativeGitState, b: NativeGitState) {
  const left = indexEntries(a),
    right = indexEntries(b);
  return new Set(
    [...new Set([...left.keys(), ...right.keys()])].filter(
      (p) => JSON.stringify(left.get(p)) !== JSON.stringify(right.get(p)),
    ),
  );
}
interface Ticket {
  preview: GitMergeOperationPreview;
  request: GitMergeOperationRequest;
  ownerKey: string;
  fingerprint: string;
  source: string;
  paths: string[];
  token: string;
  intent: string;
}
/** Git alone writes the index, refs, reflog and merge control files. Desktop
 * proves provenance against its own receipt, never parses MERGE_MSG/MERGE_MODE
 * or synthesizes a Git directory to publish afterwards. */
export class NativeGitMergeOperations extends GitMergeSafety {
  private readonly tickets = new Map<string, Ticket>();
  constructor(
    private readonly options: {
      context<T>(
        scope: ScopeRef,
        action: (ctx: GitMergeContext) => Promise<T>,
      ): Promise<T>;
      now?: () => number;
    },
  ) {
    super();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async admit(
    ctx: GitMergeContext,
    state: State,
    action: "continue" | "abort",
  ) {
    await auditMetadata(ctx.root);
    const snapshot = state.snapshot;
    if (
      !ctx.native ||
      snapshot.operation !== "merge" ||
      !snapshot.head ||
      !snapshot.branch
    )
      throw external();
    // An old REBASE_HEAD is not an active operation or write authority.
    for (const name of [
      ...mixedOperations.filter((n) => n !== "REBASE_HEAD"),
      "MERGE_AUTOSTASH",
      "SQUASH_MSG",
    ])
      if (await stat(path.join(ctx.root, ".git", name))) throw external();
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
    const ref = `refs/heads/${snapshot.branch}`;
    if (
      state.worktrees.split("\0").filter((s) => s === `branch ${ref}`)
        .length !== 1 ||
      (
        await this.git(ctx, ["symbolic-ref", "--no-recurse", "HEAD"])
      ).stdout.trim() !== ref
    )
      throw stale();
    if (
      (await this.git(ctx, ["ls-files", "-v", "-z"])).stdout
        .split("\0")
        .some((s) => /^[a-z] |^S /.test(s))
    )
      throw Error(
        "Индекс скрывает изменения: assume-unchanged/skip-worktree не поддерживаются.",
      );
    const source = oid(
      (
        await this.git(ctx, ["rev-parse", "--verify", "MERGE_HEAD^{commit}"])
      ).stdout.trim(),
    );
    await this.assertNoGitlinks(ctx, [snapshot.head, source]);
    // Inspect ownership first, without following a directory that Git may have
    // created for a D/F conflict. Only proved merge-owned descendants may then
    // be included as individual recovery files.
    const probe = await this.nativeGuard(ctx, state, [], source);
    const current = await probe.capture();
    const record = await probe.journal.inspect(current);
    if (
      !record ||
      record.operation !== "merge" ||
      !["conflicts", "stopped"].includes(record.state) ||
      (record.state === "stopped" && action !== "abort") ||
      !record.controlMatches ||
      !record.recovery ||
      !record.checkpoint ||
      !record.result?.processSettled ||
      record.recovery.policyFingerprint !== current.policyFingerprint ||
      record.recovery.head !== current.head ||
      record.recovery.headRef !== current.headRef
    )
      throw external();
    const conflicts = new Set(record.result.conflicts);
    if (
      [...changedIndex(record.checkpoint, current)].some(
        (p) => !conflicts.has(p),
      )
    )
      throw Error(
        "Посторонние staged изменения не принадлежат исходному слиянию. Уберите их перед продолжением или отменой.",
      );
    const ownedPaths = changedIndex(record.recovery, record.checkpoint);
    const paths: string[] = [],
      directories = new Set<string>();
    const checkpointPaths = new Set(indexEntries(record.checkpoint).keys());
    const currentPaths = new Set(indexEntries(current).keys());
    for (const name of new Set(
      snapshot.files.flatMap((f) => [
        f.path,
        ...(f.originalPath ? [f.originalPath] : []),
      ]),
    )) {
      const info = await stat(path.join(ctx.root, name));
      if (info?.isDirectory()) {
        if (!ownedPaths.has(name))
          throw Error(
            "Пользовательский каталог не принадлежит исходному слиянию.",
          );
        await this.checkOwnedMergeDirectory(ctx, name, currentPaths, {
          paths: checkpointPaths,
          conflicts,
        });
        directories.add(name);
        paths.push(
          ...[...currentPaths].filter((p) => p.startsWith(name + "/")),
        );
      } else paths.push(name);
    }
    const guard = await this.nativeGuard(
      ctx,
      state,
      [...new Set(paths)],
      source,
    );
    const captured = await guard.capture();
    for (const key of [
      "head",
      "headRef",
      "index",
      "refs",
      "policyFingerprint",
      "controlFingerprint",
      "physicalGit",
      "physicalRoot",
    ] as const)
      if (captured[key] !== current[key]) throw stale();
    if (
      action === "abort" &&
      snapshot.files.some(
        (f) =>
          !directories.has(f.path) &&
          ownedPaths.has(f.path) &&
          !conflicts.has(f.path) &&
          ![".", " "].includes(f.worktreeStatus),
      )
    )
      throw Error(
        "В результат слияния внесены посторонние рабочие изменения. Сохраните их отдельно перед отменой.",
      );
    if (
      action === "continue" &&
      snapshot.files.some((f) => f.kind === "conflict")
    )
      throw Error(
        "Сначала разрешите все конфликты: индекс содержит unmerged пути.",
      );
    if (action === "abort") {
      await this.checkMergeDestinations(ctx, {
        current: currentPaths,
        incoming: await this.treePaths(ctx, record.recovery.head!),
        tracked: new Set([
          ...currentPaths,
          ...(await this.treePaths(ctx, record.recovery.head!)),
        ]),
        original: { paths: checkpointPaths, conflicts },
      });
    }
    return {
      guard,
      current: captured,
      record,
      source,
      paths: [...new Set(paths)],
      conflicts,
      ownedPaths,
    };
  }
  private async message(ctx: GitMergeContext, state: State) {
    // Display data only. Git itself cleans and consumes the native message on
    // continuation; Desktop does not infer operation ownership from its text.
    const handle = await fs.open(
      path.join(ctx.root, ".git", "MERGE_MSG"),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 16384)
        throw Error(
          "Сообщение слияния превышает размер предпросмотра; завершите его в терминале.",
        );
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== info.size) throw stale();
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      );
      if (raw.includes("\0")) throw stale();
      const cleanup =
        state.config
          .filter(([key]) => key.toLowerCase() === "commit.cleanup")
          .at(-1)?.[1] ?? "default";
      const value =
        cleanup === "verbatim" || cleanup === "scissors"
          ? raw
          : (
              await this.git(
                ctx,
                [
                  "stripspace",
                  ...(cleanup === "whitespace" ? [] : ["--strip-comments"]),
                ],
                raw,
              )
            ).stdout;
      if (!value.trim()) throw Error("Пустое сообщение слияния.");
      return value;
    } finally {
      await handle.close();
    }
  }
  async prepare(
    input: GitMergeOperationRequest,
  ): Promise<GitMergeOperationPreview> {
    const request = gitMergeOperationRequestSchema.parse(input);
    return this.options.context(request.scope, async (ctx) => {
      const state = await this.capture(ctx, request.scope);
      if (state.snapshot.revision !== request.revision) throw stale();
      const admission = await this.admit(ctx, state, request.action);
      const { guard, current, source, paths } = admission;
      const ident = async (name: string) =>
        (
          await this.git(ctx, ["-c", "user.useConfigOnly=true", "var", name])
        ).stdout
          .trim()
          .replace(/ \d+ [+-]\d{4}$/, "");
      const preview: GitMergeOperationPreview = {
        token: randomBytes(32).toString("hex"),
        scope: request.scope,
        root: ctx.root,
        operation: "merge",
        action: request.action,
        branch: state.snapshot.branch!,
        head: state.snapshot.head!,
        sourceOid: source,
        paths: [...admission.ownedPaths].sort(),
        hooks: "disabled",
        expiresAt: this.now() + 300000,
        message:
          request.action === "continue"
            ? (request.message ?? (await this.message(ctx, state)))
            : "",
        author:
          request.action === "continue"
            ? await ident("GIT_AUTHOR_IDENT")
            : null,
        committer:
          request.action === "continue"
            ? await ident("GIT_COMMITTER_IDENT")
            : null,
        signing:
          (
            await this.git(ctx, [
              "config",
              "--type=bool",
              "--default=false",
              "--get",
              "commit.gpgsign",
            ])
          ).stdout.trim() === "true",
        effects:
          request.action === "continue"
            ? "Git создаст merge-коммит из исходного слияния и разрешённых конфликтов. Посторонние staged изменения запрещены; хуки отключены. Git обновит индекс и reflog штатно."
            : "Git отменит исходное слияние; решения его конфликтов будут отброшены. Несвязанные правки проверяются и сохраняются; исходный снимок остаётся до проверки результата.",
      };
      if (
        (await this.capture(ctx, request.scope)).fingerprint !==
        state.fingerprint
      )
        throw stale();
      const intent = nativeIntent([
        request,
        preview,
        ctx.ownerKey,
        admission.record.id,
      ]);
      const token = await guard.journal.prepareFollowup(
        "merge",
        current,
        intent,
      );
      for (const [key, item] of this.tickets)
        if (item.preview.expiresAt <= this.now()) this.tickets.delete(key);
      if (this.tickets.size >= 64)
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(preview.token, {
        preview,
        request,
        ownerKey: ctx.ownerKey,
        fingerprint: state.fingerprint,
        source,
        paths,
        token,
        intent,
      });
      return structuredClone(preview);
    });
  }
  async execute(input: string): Promise<GitMergeOperationResult> {
    return withNativeGitCompletion(() => this.executeInCompletion(input));
  }
  private async executeInCompletion(
    input: string,
  ): Promise<GitMergeOperationResult> {
    const key = gitMergeOperationTokenSchema.parse(input),
      ticket = this.tickets.get(key);
    this.tickets.delete(key);
    if (!ticket || ticket.preview.expiresAt <= this.now()) throw stale();
    return this.options.context(ticket.request.scope, async (ctx) => {
      if (ctx.ownerKey !== ticket.ownerKey) throw stale();
      const before = await this.capture(ctx, ticket.request.scope);
      if (before.fingerprint !== ticket.fingerprint) throw stale();
      const admission = await this.admit(ctx, before, ticket.request.action);
      if (admission.source !== ticket.source) throw stale();
      const { guard, record, ownedPaths } = admission;
      const indexMode =
        Number((await stat(path.join(ctx.root, ".git/index")))!.mode) & 0o777;
      const lines: string[] = [];
      let cleanup: GitMetadataLockCleanupError | undefined;
      const result = await guard.journal.execute({
        deferRecoveryCleanup: deferNativeGitRecovery,
        token: ticket.token,
        intentFingerprint: ticket.intent,
        operation: "merge",
        capture: guard.capture,
        run: () =>
          this.withMetadataLock(ctx, "config.lock", async () => {
            if (ticket.request.action === "abort") {
              const current = new Set(await this.indexPaths(ctx));
              await this.checkMergeDestinations(ctx, {
                current,
                incoming: await this.treePaths(ctx, record.recovery!.head!),
                tracked: new Set([
                  ...current,
                  ...(await this.treePaths(ctx, record.recovery!.head!)),
                ]),
                original: {
                  paths: new Set(indexEntries(record.checkpoint!).keys()),
                  conflicts: admission.conflicts,
                },
              });
            }
            if (
              (await this.capture(ctx, ticket.request.scope)).fingerprint !==
              before.fingerprint
            )
              throw stale();
            const command =
              ticket.request.action === "continue" &&
              ticket.request.message !== undefined
                ? {
                    policy: "local-write" as const,
                    command: "commit" as const,
                    args: ["--file=-"],
                    stdin: Buffer.from(ticket.request.message),
                  }
                : {
                    policy: "local-write" as const,
                    command: "merge" as const,
                    args: [
                      ticket.request.action === "continue"
                        ? "--continue"
                        : "--abort",
                    ],
                  };
            // Native Git replaces the index using the process umask by default.
            // Pin its creation mode through Git's public policy instead of
            // publishing/chmod-ing an index ourselves (notably 0600 -> 0644).
            const executor =
              ticket.request.action === "abort"
                ? await ctx.native!.client([
                    ...before.config,
                    ["core.sharedRepository", `0${indexMode.toString(8)}`],
                  ])
                : guard.client;
            const output = await executor.run(command);
            lines.push(
              output.stdout.toString("utf8"),
              output.stderr.toString("utf8"),
            );
            return output;
          }).catch((error) => {
            if (error instanceof GitMetadataLockCleanupError) cleanup = error;
            throw error;
          }),
        verify: async (current, after) => {
          const actual = await this.capture(ctx, ticket.request.scope);
          if (
            actual.snapshot.operation !== "none" ||
            actual.snapshot.branch !== before.snapshot.branch ||
            actual.snapshot.files.some((f) => f.kind === "conflict")
          )
            throw stale();
          const preserved = (state: NativeGitState) =>
            state.files.filter(
              (f) =>
                ticket.request.action === "continue" || !ownedPaths.has(f.path),
            );
          if (
            JSON.stringify(preserved(current)) !==
            JSON.stringify(preserved(after))
          )
            throw stale();
          if (ticket.request.action === "abort") {
            if (
              after.head !== record.recovery!.head ||
              after.index !== record.recovery!.index
            )
              throw stale();
          } else {
            if (
              !after.head ||
              after.index !== current.index ||
              (
                await this.git(ctx, [
                  "rev-list",
                  "--parents",
                  "-n",
                  "1",
                  after.head,
                ])
              ).stdout.trim() !==
                [after.head, record.recovery!.head, ticket.source].join(" ")
            )
              throw stale();
          }
          if (
            ticket.request.action === "abort" &&
            (Number((await stat(path.join(ctx.root, ".git/index")))!.mode) &
              0o777) !==
              indexMode
          )
            throw stale();
          // Only the current branch may move. No publication or other ref writes.
          const refs = (s: State) => [
            s.inventory.local.filter(
              (r) => r.ref !== `refs/heads/${before.snapshot.branch}`,
            ),
            s.inventory.remote,
          ];
          if (JSON.stringify(refs(actual)) !== JSON.stringify(refs(before)))
            throw stale();
          return {
            outcome: "completed",
            afterHead: after.head,
            conflicts: [],
            verifiedUnrelatedData: true,
          };
        },
      });
      const sanitize = ctx.sanitizeDiagnostics ?? sanitizeRepositoryLog;
      return {
        scope: ticket.request.scope,
        operation: "merge",
        action: ticket.request.action,
        status: result.outcome === "completed" ? "success" : "uncertain",
        changed: true,
        native: result,
        lockRetained: !!cleanup && (cleanup.retained || cleanup.unchecked),
        retainedLocks: cleanup?.retained ? [cleanup.lock] : [],
        uncheckedLocks: cleanup?.unchecked ? [cleanup.lock] : [],
        ...(result.recoveryPath ? { recoveryPath: result.recoveryPath } : {}),
        ...(result.outcome === "completed" &&
        ticket.request.action === "continue" &&
        result.afterHead
          ? { commit: result.afterHead }
          : {}),
        message:
          result.outcome === "completed"
            ? ticket.request.action === "continue"
              ? "Слияние завершено штатным Git; результат проверен."
              : "Слияние отменено штатным Git; несвязанные изменения сохранены и проверены."
            : "Результат операции не подтверждён. Материалы восстановления сохранены; автоматический повтор запрещён.",
        log: sanitize(
          [...lines, ...(cleanup ? [cleanup.message] : [])].join("\n"),
        ),
      };
    });
  }
}
