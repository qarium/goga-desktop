import {
  withNativeGitCompletion,
  deferNativeGitRecovery,
} from "./git-native-completion";
import { CommandExitError } from "./process";
import {
  inspectNativeRebasePlan,
  verifyNativeAutoMerge,
  verifyNativeConflictStages,
} from "./git-native-result-verifier";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ScopeRef } from "../shared/context";
import { scopeRefSchema } from "../shared/context";
import { gitRevisionSchema, gitFilePathSchema } from "../shared/git-workspace";
import {
  GitMergeSafety,
  GitMetadataLockCleanupError,
  auditMetadata,
  oid,
  stale,
  stat,
  type GitMergeContext,
  type State,
} from "./git-merge-safety";
import { nativeIntent } from "./git-native-context";
import { assertNativeGitState, type NativeGitState } from "./git-native-state";
import type { NativeGitRequest } from "./git-native-policy";
import { sanitizeRepositoryLog } from "./repository-actions";

const operation = z.enum(["rebase", "cherry-pick", "revert", "merge"]);
type Operation = z.infer<typeof operation>;
const requestSchema = z
  .object({
    scope: scopeRefSchema,
    operation: z.enum(["rebase", "cherry-pick", "revert"]),
    action: z.enum(["continue", "abort"]),
    revision: gitRevisionSchema,
  })
  .strict();
const objectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const startSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("merge"), source: objectId }).strict(),
  z
    .object({
      operation: z.literal("rebase"),
      source: objectId,
      backend: z.enum(["merge", "apply"]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("cherry-pick"),
      commits: z.array(objectId).min(1).max(256),
    })
    .strict(),
  z
    .object({
      operation: z.literal("revert"),
      commits: z.array(objectId).min(1).max(256),
    })
    .strict(),
]);
export type NativeSequenceStart = z.infer<typeof startSchema>;
const intentDetailsSchema = z.tuple([
  scopeRefSchema,
  startSchema,
  gitRevisionSchema,
  z
    .object({
      policy: z.literal("local-write"),
      command: operation,
      args: z.array(z.string().max(256)).max(256),
    })
    .strict(),
  z.literal("only-current-branch-and-protected-paths;no-hooks;no-publication"),
]);
function startCommand(start: NativeSequenceStart): NativeGitRequest {
  if (start.operation === "merge")
    return {
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
        start.source,
      ],
    };
  return start.operation === "rebase"
    ? {
        policy: "local-write",
        command: "rebase",
        args: [
          `--${start.backend}`,
          "--no-autostash",
          "--no-update-refs",
          "--no-fork-point",
          "--no-verify",
          start.source,
        ],
      }
    : {
        policy: "local-write",
        command: start.operation,
        args: [...start.commits],
      };
}

const external = () =>
  Error(
    "Происхождение операции не подтверждено журналом Desktop. Продолжите внешнюю операцию в терминале.",
  );
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
function entries(state: NativeGitState) {
  const result = new Map<string, string[]>();
  for (const row of new TextDecoder("utf-8", { fatal: true })
    .decode(Buffer.from(state.indexData, "base64"))
    .split("\0")
    .filter(Boolean)) {
    const m = /^(\d{6}) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t(.+)$/s.exec(row);
    if (!m) throw stale();
    const name = gitFilePathSchema.parse(m[4]);
    result.set(name, [...(result.get(name) ?? []), m.slice(1, 4).join(" ")]);
  }
  return result;
}
const files = (s: NativeGitState) => new Map(s.files.map((f) => [f.path, f]));
const dataEqual = (
  a: NativeGitState["files"][number] | undefined,
  b: NativeGitState["files"][number] | undefined,
) => equal(a ?? null, b ?? null);
interface Ticket {
  scope: ScopeRef;
  operation: Operation;
  action: "start" | "continue" | "abort";
  token: string;
  intent: string;
  expires: number;
  paths: string[];
  original: string;
  branch: string;
  command: NativeGitRequest;
  start?: NativeSequenceStart;
}
/** Host-only sequencer handler. Native Git owns replay/author/message/backend.
 * A start is a fixed command with durable recovery BEFORE mutation. Follow-ups
 * require that receipt and an opaque control seal; no Git todo/patch parser,
 * temporary Git directory, manual index/ref publication or external adoption. */
export class NativeGitSequence extends GitMergeSafety {
  private tickets = new Map<string, Ticket>();
  constructor(
    private options: {
      context<T>(
        scope: ScopeRef,
        fn: (ctx: GitMergeContext) => Promise<T>,
      ): Promise<T>;
      now?: () => number;
      /** Nested handoffs must not extend the original confirmation deadline. */
      confirmationExpiresAt?: number;
    },
  ) {
    super();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private issue<T extends object = object>(ticket: Ticket, extra: T = {} as T) {
    for (const [key, value] of this.tickets)
      if (value.expires <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 64)
      throw Error("Слишком много незавершённых предпросмотров Git.");
    const token = randomBytes(32).toString("hex");
    this.tickets.set(token, structuredClone(ticket));
    return {
      token,
      scope: ticket.scope,
      operation: ticket.operation,
      action: ticket.action,
      original: ticket.original,
      branch: ticket.branch,
      paths: ticket.paths,
      expiresAt: ticket.expires,
      requiresCommitWarning:
        ticket.operation === "revert" && ticket.action === "continue",
      ...extra,
    };
  }
  private async policy(ctx: GitMergeContext, state: State) {
    await auditMetadata(ctx.root);
    if (!ctx.native || !state.snapshot.head) throw external();
    if (
      (
        await this.git(ctx, [
          "config",
          "--type=bool",
          "--default=false",
          "--get",
          "commit.gpgsign",
        ])
      ).stdout.trim() === "true"
    )
      throw Error(
        "Подписание коммитов требует отдельного допуска; продолжите операцию в терминале.",
      );
    // Rewriting notes would mutate refs outside the confirmed branch.
    // Signature verification may invoke an external signer not shown here.
    if (
      state.config.some(([key]) => /^notes\.rewriteref$/i.test(key)) ||
      (
        await this.git(ctx, [
          "config",
          "--type=bool",
          "--default=false",
          "--get",
          "merge.verifySignatures",
        ])
      ).stdout.trim() === "true"
    )
      throw Error(
        "Операция с переписыванием notes или проверкой подписей требует терминала.",
      );
    if (state.config.some(([key]) => /^include(?:if\..*)?\.path$/i.test(key)))
      throw Error(
        "Внешние include конфигурации не допускаются для штатной последовательности Git.",
      );
    if (
      state.config.some(([key]) =>
        /^(filter\..+\.(clean|smudge|process|required)|merge\..+\.driver)$/i.test(
          key,
        ),
      )
    )
      throw Error(
        "Внешние filters/merge drivers не допускаются для штатной последовательности Git.",
      );
    if (
      (await this.git(ctx, ["ls-files", "-v", "-z"])).stdout
        .split("\0")
        .some((s) => /^[a-z] |^S /.test(s))
    )
      throw Error("Индекс скрывает изменения; операция не разрешена.");
    if (await stat(path.join(ctx.root, ".git/BISECT_START"))) throw external();
  }
  private async others(ctx: GitMergeContext) {
    return (await this.git(ctx, ["ls-files", "--others", "-z"])).stdout
      .split("\0")
      .filter(Boolean)
      .map((p) => gitFilePathSchema.parse(p));
  }
  private async refs(ctx: GitMergeContext, branch: string) {
    return (
      await this.git(ctx, [
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)%00%(objectname)%00%(symref)",
      ])
    ).stdout
      .split("\n")
      .filter((line) => line && line.split("\0")[0] !== `refs/heads/${branch}`);
  }
  private guard(
    ctx: GitMergeContext,
    state: State,
    paths: string[],
    original: string,
  ) {
    // Pin the policy domain to the original tree across detached HEAD/stops.
    // Current public index paths and external attribute sources are also sealed.
    return this.nativeGuard(
      ctx,
      { ...state, snapshot: { ...state.snapshot, head: original } },
      paths,
      original,
    );
  }
  private async protectEmptyParents(
    ctx: GitMergeContext,
    destinations: readonly string[],
    originalIndex: Map<string, string[]>,
  ) {
    // Git does not retain empty directories. Existing parents with no original
    // tracked descendants are user state, not disposable checkout directories.
    const trackedParents = new Set<string>();
    for (const p of originalIndex.keys()) {
      let parent = path.posix.dirname(p);
      while (parent !== ".") {
        trackedParents.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    const checkedParents = new Set<string>();
    for (const p of destinations) {
      let parent = path.posix.dirname(p);
      while (parent !== "." && !checkedParents.has(parent)) {
        checkedParents.add(parent);
        if (
          !trackedParents.has(parent) &&
          (await stat(path.join(ctx.root, parent)))?.isDirectory()
        )
          throw Error(
            "Существующий каталог занимает будущий путь операции; сохраните его отдельно.",
          );
        parent = path.posix.dirname(parent);
      }
    }
  }
  /** Private admission for a separately confirmed Desktop/Goga handoff. Never
   * expose arbitrary argv, backend or object lists directly to the renderer. */
  async prepareStart(scope: ScopeRef, input: NativeSequenceStart) {
    scope = scopeRefSchema.parse(scope);
    const start = startSchema.parse(input);
    return this.options.context(scope, async (ctx) => {
      const state = await this.capture(ctx, scope);
      await this.policy(ctx, state);
      await ctx.native!.journal.assertAdmission(
        ctx.root,
        await ctx.native!.owner(),
      );
      if (
        state.snapshot.operation !== "none" ||
        !state.snapshot.branch ||
        (typeof scope !== "string" && state.snapshot.branch !== scope.branch) ||
        state.snapshot.files.some((f) => f.kind !== "untracked")
      )
        throw Error(
          "Начало операции требует чистые отслеживаемые файлы и текущую локальную ветку.",
        );
      const head = oid(state.snapshot.head!),
        branch = state.snapshot.branch;
      let commits: string[];
      if (start.operation === "merge") {
        if (
          (
            await this.git(ctx, ["cat-file", "-t", start.source])
          ).stdout.trim() !== "commit"
        )
          throw stale();
        commits = [];
      } else if (start.operation === "rebase") {
        if (
          (
            await this.git(ctx, ["cat-file", "-t", start.source])
          ).stdout.trim() !== "commit"
        )
          throw stale();
        commits = (
          await this.git(ctx, [
            "rev-list",
            "--reverse",
            `${start.source}..${head}`,
          ])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(oid);
      } else commits = start.commits;
      if (commits.length > 256)
        throw Error("Последовательность превышает безопасный предел проверки.");
      const trees = new Set([
        head,
        ...("source" in start ? [start.source] : []),
        ...commits,
      ]);
      for (const commit of commits) {
        const parents = (
          await this.git(ctx, ["rev-list", "--parents", "-n", "1", commit])
        ).stdout
          .trim()
          .split(" ");
        if (parents.length > 2)
          throw Error(
            "Merge-коммиты требуют отдельного выбора mainline; используйте терминал.",
          );
        parents.slice(1).forEach((v) => trees.add(oid(v)));
      }
      await this.assertNoGitlinks(ctx, [...trees]);
      const envelope = new Set<string>();
      for (const tree of trees)
        for (const p of await this.treePaths(ctx, tree)) envelope.add(p);
      // Preserve the existing bounded rebase admission; do not promise support
      // for attributes/filter transitions merely because native Git is used.
      if (
        [...envelope].some(
          (p) => path.posix.basename(p).toLowerCase() === ".gitattributes",
        )
      )
        throw Error(
          "Изменение .gitattributes в последовательности пока требует терминала.",
        );
      // Validate every source-tree prefix, not only paths already materialized
      // on this volume. Native checkout must not collapse case/Unicode aliases.
      const portable = (p: string) => p.normalize("NFC").toLowerCase();
      const spellings = new Map<string, string>();
      const fileNames = new Set([...envelope].map(portable));
      for (const p of envelope) {
        let prefix = p;
        while (prefix !== ".") {
          const key = portable(prefix),
            previous = spellings.get(key);
          if (previous !== undefined && previous !== prefix)
            throw Error(
              "Неоднозначные имена файлов или каталогов требуют терминала.",
            );
          spellings.set(key, prefix);
          const parent = path.posix.dirname(prefix);
          if (fileNames.has(portable(parent)))
            throw Error(
              "Замена файла каталогом в последовательности требует терминала.",
            );
          prefix = parent;
        }
      }
      const untracked = await this.others(ctx);
      for (const p of untracked)
        if (
          [...envelope].some(
            (q) => q === p || q.startsWith(p + "/") || p.startsWith(q + "/"),
          )
        )
          throw Error(
            "Неотслеживаемый или игнорируемый файл занимает путь операции.",
          );
      const paths = [...new Set([...envelope, ...untracked])].sort();
      const guard =
          start.operation === "merge"
            ? await this.nativeGuard(ctx, state, paths, start.source)
            : await this.guard(ctx, state, paths, head),
        snapshot = await guard.capture();
      const originalIndex = entries(snapshot),
        protectedFiles = files(snapshot);
      // Probe the destination itself, not only string equality with ls-files.
      // On case-insensitive filesystems an ignored `name` also occupies `NAME`.
      for (const p of envelope)
        if (!originalIndex.has(p) && protectedFiles.get(p)?.data !== null)
          throw Error(
            "Неотслеживаемый или игнорируемый файл занимает будущий путь операции.",
          );
      await this.protectEmptyParents(ctx, [...envelope], originalIndex);
      if ((await this.capture(ctx, scope)).fingerprint !== state.fingerprint)
        throw stale();
      const command = startCommand(start);
      const details = intentDetailsSchema.parse([
        scope,
        start,
        snapshot.revision,
        command,
        "only-current-branch-and-protected-paths;no-hooks;no-publication",
      ]);
      const intent = nativeIntent(details);
      return this.issue({
        scope,
        operation: start.operation,
        action: "start",
        token: guard.journal.prepare(
          start.operation,
          snapshot,
          intent,
          JSON.stringify(details),
        ),
        intent,
        expires: Math.min(
          this.now() + 300000,
          this.options.confirmationExpiresAt ?? Infinity,
        ),
        paths,
        original: head,
        branch,
        command,
        start,
      });
    });
  }
  private async admit(
    ctx: GitMergeContext,
    state: State,
    op: Operation,
    action: "continue" | "abort",
  ) {
    await this.policy(ctx, state);
    if (state.snapshot.operation !== op) throw external();
    const probe = await this.nativeGuard(ctx, state, []),
      observed = await probe.capture();
    const record = await probe.journal.inspect(observed);
    if (
      !record ||
      record.operation !== op ||
      !["conflicts", "stopped"].includes(record.state) ||
      !record.controlMatches ||
      !record.recovery ||
      !record.checkpoint ||
      !record.result?.processSettled ||
      (record.state === "stopped" && action !== "abort") ||
      !record.recovery.headRef?.startsWith("refs/heads/")
    )
      throw external();
    // Only our own durable command descriptor grants continuation. Old/external
    // markers and an error from Goga cannot manufacture this receipt.
    const details = intentDetailsSchema.safeParse(
      record.intentDetails ? JSON.parse(record.intentDetails) : null,
    );
    if (
      !details.success ||
      !equal(details.data[0], ctx.scope) ||
      details.data[1].operation !== op ||
      details.data[2] !== record.baselineRevision ||
      !equal(details.data[3], startCommand(details.data[1]))
    )
      throw external();
    const original = oid(record.recovery.head!),
      branch = record.recovery.headRef.slice(11);
    if (typeof ctx.scope !== "string" && branch !== ctx.scope.branch)
      throw external();
    if (op !== "rebase" && state.snapshot.branch !== branch) throw external();
    if (op === "rebase" && state.snapshot.branch !== null) throw external();
    const paths = [
      ...new Set([
        ...record.recovery.files.map((f) => f.path),
        ...record.checkpoint.files.map((f) => f.path),
        ...(await this.others(ctx)),
      ]),
    ].sort();
    const guard = await this.guard(ctx, state, paths, original),
      current = await guard.capture();
    if (
      current.policyFingerprint !== record.recovery.policyFingerprint ||
      current.head !== record.checkpoint.head ||
      current.headRef !== record.checkpoint.headRef ||
      current.refs !== record.checkpoint.refs
    )
      throw external();
    const beforeIndex = entries(record.checkpoint),
      nowIndex = entries(current),
      conflicts = new Set(record.result.conflicts);
    for (const p of new Set([...beforeIndex.keys(), ...nowIndex.keys()]))
      if (!equal(beforeIndex.get(p), nowIndex.get(p)) && !conflicts.has(p))
        throw Error(
          "Посторонние staged изменения не принадлежат исходному конфликту.",
        );
    const previous = files(record.checkpoint),
      actual = files(current),
      originalFiles = files(record.recovery);
    for (const p of beforeIndex.keys())
      if (!conflicts.has(p) && !dataEqual(previous.get(p), actual.get(p)))
        throw Error(
          "Посторонние рабочие изменения необходимо сохранить перед продолжением или отменой.",
        );
    // Conflict text/staging may be a user resolution; permission changes are
    // independent edits and must not be discarded by a native checkout/abort.
    // Only an explicitly saved Desktop side resolution may authorize its mode.
    for (const p of conflicts) {
      const before = previous.get(p),
        now = actual.get(p);
      if (
        before?.mode != null &&
        now?.mode != null &&
        before.mode !== now.mode &&
        !record.resolvedModes?.some((f) => f.path === p && f.mode === now.mode)
      )
        throw Error(
          "Изменены права конфликтного файла; сохраните их перед продолжением или отменой.",
        );
    }
    const originalIndex = entries(record.recovery);
    for (const f of record.recovery.files)
      if (
        !nowIndex.has(f.path) &&
        actual.get(f.path)?.data !== null &&
        (originalIndex.has(f.path) || f.data === null)
      )
        throw Error("Неотслеживаемый файл занимает будущий путь операции.");
    if (
      action === "continue" &&
      state.snapshot.files.some((f) => f.kind === "conflict")
    )
      throw Error("Сначала разрешите все конфликты.");
    return {
      guard,
      current,
      record,
      original,
      branch,
      paths,
      start: details.data[1],
    };
  }
  async prepare(input: z.infer<typeof requestSchema>) {
    const request = requestSchema.parse(input);
    return this.options.context(request.scope, async (ctx) => {
      const state = await this.capture(ctx, request.scope);
      if (state.snapshot.revision !== request.revision) throw stale();
      const ready = await this.admit(
        ctx,
        state,
        request.operation,
        request.action,
      );
      const intent = nativeIntent([request, ready.current.revision]);
      return this.issue(
        {
          scope: request.scope,
          operation: request.operation,
          action: request.action,
          intent,
          token: await ready.guard.journal.prepareFollowup(
            request.operation,
            ready.current,
            intent,
          ),
          expires: this.now() + 300000,
          paths: ready.paths,
          original: ready.original,
          branch: ready.branch,
          command: {
            policy: "local-write",
            command: request.operation,
            args: [`--${request.action}`],
          },
        },
        {
          root: ctx.root,
          head: state.snapshot.head!,
          current:
            request.operation === "rebase"
              ? state.snapshot.head!
              : oid(
                  (
                    await this.git(ctx, [
                      "rev-parse",
                      "--verify",
                      `${request.operation === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD"}^{commit}`,
                    ])
                  ).stdout.trim(),
                ),
          paths: ready.record.result!.conflicts,
          discardedResolutionPaths:
            request.action === "abort" ? ready.record.result!.conflicts : [],
          backend:
            request.operation === "rebase"
              ? (await stat(path.join(ctx.root, ".git/rebase-apply")))
                ? "apply"
                : "merge"
              : undefined,
        },
      );
    });
  }
  async execute(input: string) {
    return withNativeGitCompletion(() => this.executeInCompletion(input));
  }
  private async executeInCompletion(input: string) {
    const token = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.expires <= this.now()) throw stale();
    return this.options.context(ticket.scope, async (ctx) => {
      const state = await this.capture(ctx, ticket.scope);
      await this.policy(ctx, state);
      const ready =
        ticket.action === "start"
          ? null
          : await this.admit(ctx, state, ticket.operation, ticket.action);
      if (ready && !equal(ready.paths, ticket.paths)) throw stale();
      const guard =
        ticket.start?.operation === "merge"
          ? await this.nativeGuard(
              ctx,
              state,
              ticket.paths,
              ticket.start.source,
            )
          : await this.guard(ctx, state, ticket.paths, ticket.original);
      const baseline = ready?.record.recovery;
      const othersBefore = await this.others(ctx),
        refsBefore = await this.refs(ctx, ticket.branch);
      if (othersBefore.some((p) => !ticket.paths.includes(p))) throw stale();
      const lines: string[] = [];
      const client = await ctx.native!.client([
        ...state.config,
        [`branch.${ticket.branch}.mergeOptions`, ""],
        ["merge.autoStash", "false"],
        ["rerere.enabled", "false"],
        ["rerere.autoupdate", "false"],
        ["rebase.autoStash", "false"],
        ["rebase.updateRefs", "false"],
        ["rebase.autoSquash", "false"],
        ["rebase.rebaseMerges", "false"],
        ["rebase.rescheduleFailedExec", "false"],
        ["rebase.instructionFormat", "%s"],
      ]);
      const origin = ticket.start ?? ready?.start;
      let validatedControls: string | undefined;
      let cleanup: GitMetadataLockCleanupError | undefined;
      const result = await guard.journal.execute({
        deferRecoveryCleanup: deferNativeGitRecovery,
        token: ticket.token,
        operation: ticket.operation,
        intentFingerprint: ticket.intent,
        capture: guard.capture,
        run: (confirmed) =>
          this.withMetadataLock(ctx, "config.lock", async () => {
            await ctx.verify();
            if (ticket.expires <= this.now())
              throw Error(
                "Подтверждение истекло после записи намерения. Журнал сохранён для проверки.",
              );
            if (ticket.start?.operation === "merge") {
              // Native merge-tree's destination discovery occurs AFTER durable
              // intent, and never supplies a hand-written index or ref result.
              const probing: GitMergeContext = {
                ...ctx,
                git: async (args, stdin) => {
                  const at = args.indexOf("merge-tree");
                  if (at < 0) return ctx.git(args, stdin);
                  const out = await client.run({
                    policy: "local-write",
                    command: "merge-tree",
                    args: args.slice(at + 1),
                  });
                  if (out.exitCode !== 0)
                    throw new CommandExitError(
                      "Native merge-tree",
                      out.exitCode ?? -1,
                      out.stdout.toString("utf8"),
                      out.stderr.toString("utf8"),
                    );
                  return {
                    stdout: out.stdout.toString("utf8"),
                    stderr: out.stderr.toString("utf8"),
                  };
                },
              };
              const destinations = await this.protectMergeDestinations(
                probing,
                state,
                ticket.start.source,
                [],
              );
              await this.checkMergeDestinations(ctx, {
                ...destinations,
                tracked: new Set([
                  ...destinations.current,
                  ...(await this.indexPaths(ctx)),
                ]),
              });
            }
            // Re-check the public plan inside the confirmed operation, never
            // inside read-only prepare. The previous durable seal is still required.
            if (
              ticket.action === "continue" &&
              origin?.operation === "rebase" &&
              origin.backend === "merge"
            )
              await inspectNativeRebasePlan(
                client,
                ctx.root,
                origin.source,
                ticket.original,
              );
            // All awaited admission/plan checks above may yield to a writer.
            // Compare with the journal's confirmed snapshot once more at the
            // final native boundary, including user bytes and opaque controls.
            if (ticket.action === "start") {
              const originalIndex = entries(confirmed);
              await this.protectEmptyParents(
                ctx,
                confirmed.files
                  .filter((f) => originalIndex.has(f.path) || f.data === null)
                  .map((f) => f.path),
                originalIndex,
              );
            }
            assertNativeGitState(confirmed, await guard.capture());
            if (ticket.expires <= this.now()) throw stale();
            const out = await client.run(ticket.command);
            lines.push(
              out.stdout.toString("utf8"),
              out.stderr.toString("utf8"),
            );
            return out;
          }).catch((error) => {
            if (error instanceof GitMetadataLockCleanupError) cleanup = error;
            throw error;
          }),
        afterSettled: async (command) => {
          if (
            command.exitCode === 1 &&
            ticket.action !== "abort" &&
            origin?.operation === "rebase" &&
            origin.backend === "merge" &&
            (await ctx.snapshot()).operation === "rebase"
          )
            validatedControls = await inspectNativeRebasePlan(
              client,
              ctx.root,
              origin.source,
              ticket.original,
            );
        },
        verify: async (before, after, command) => {
          if (
            validatedControls &&
            after.controlFingerprint !== validatedControls
          )
            throw stale();
          const actual = await ctx.snapshot();
          if (!equal(refsBefore, await this.refs(ctx, ticket.branch)))
            throw stale();
          const beforeFiles = files(before),
            afterFiles = files(after);
          for (const p of othersBefore)
            if (!dataEqual(beforeFiles.get(p), afterFiles.get(p)))
              throw stale();
          if ([...entries(after).keys()].some((p) => !ticket.paths.includes(p)))
            throw stale();
          // A public workspace classification is not sufficient evidence that
          // no second operation appeared after the child settled. Keep foreign
          // markers intact, retain recovery, and refuse to certify the result.
          for (const [marker, owner] of [
            ["MERGE_HEAD", "merge"],
            ["CHERRY_PICK_HEAD", "cherry-pick"],
            ["REVERT_HEAD", "revert"],
            ["rebase-merge", "rebase"],
            ["rebase-apply", "rebase"],
            ["BISECT_START", "unsupported"],
          ] as const)
            if (await stat(path.join(ctx.root, ".git", marker))) {
              if (owner !== ticket.operation || actual.operation !== owner)
                throw stale();
              if (
                marker === "rebase-merge" &&
                (await stat(path.join(ctx.root, ".git/rebase-apply")))
              )
                throw stale();
            }
          if (
            (await stat(path.join(ctx.root, ".git/sequencer"))) &&
            !["cherry-pick", "revert"].includes(actual.operation)
          )
            throw stale();
          const conflicts = actual.files
            .filter((f) => f.kind === "conflict")
            .map((f) => f.path);
          if (
            command.exitCode !== 0 &&
            actual.operation === ticket.operation &&
            conflicts.length
          ) {
            if (ticket.action === "abort") throw stale();
            if (
              ticket.operation === "rebase"
                ? after.headRef !== null
                : after.headRef !== `refs/heads/${ticket.branch}`
            )
              throw stale();
            if (
              actual.files.some(
                (f) =>
                  f.kind !== "conflict" &&
                  f.kind !== "untracked" &&
                  ![".", " "].includes(f.worktreeStatus),
              )
            )
              throw stale();
            // Git diff honors these flags. Recheck after the native child so
            // an external writer cannot hide edits from the result witness.
            if (
              (await this.git(ctx, ["ls-files", "-v", "-z"])).stdout
                .split("\0")
                .some((row) => /^[a-z] |^S /.test(row))
            )
              throw stale();
            if (!origin) throw stale();
            const independentConflicts = await verifyNativeConflictStages(
              client,
              after,
              before,
              origin,
              ticket.original,
              othersBefore,
            );
            if (!equal([...conflicts].sort(), independentConflicts))
              throw stale();
            const witnessed = await verifyNativeAutoMerge(
              client,
              after,
              independentConflicts,
            );
            if (
              !witnessed &&
              !(origin?.operation === "rebase" && origin.backend === "apply")
            )
              throw stale();
            // Public result probes must describe this exact checkpoint. Do not
            // certify bytes or controls changed while Git's witness was read.
            assertNativeGitState(after, await guard.capture());
            return {
              outcome: "conflicts",
              afterHead: after.head,
              conflicts,
              verifiedUnrelatedData: true,
            };
          }
          // A managed empty resolution may stop native Git without changing
          // any public/user/control state. Preserve only explicit abort authority;
          // never skip it, call it completed, or adopt changed opaque controls.
          if (
            ticket.action === "continue" &&
            command.exitCode === 1 &&
            command.signal === null &&
            actual.operation === ticket.operation &&
            conflicts.length === 0 &&
            equal(before, after)
          )
            return {
              outcome: "stopped",
              afterHead: after.head,
              conflicts: [],
              verifiedUnrelatedData: true,
            };
          if (
            command.exitCode !== 0 &&
            actual.operation === "none" &&
            equal(before, after)
          )
            return {
              outcome: "rejected",
              afterHead: after.head,
              conflicts: [],
              verifiedUnrelatedData: true,
            };
          if (
            command.exitCode !== 0 ||
            actual.operation !== "none" ||
            conflicts.length ||
            after.headRef !== `refs/heads/${ticket.branch}`
          )
            throw stale();
          if (ticket.action === "abort") {
            if (
              !baseline ||
              after.head !== baseline.head ||
              after.index !== baseline.index
            )
              throw stale();
            const originalIndex = entries(baseline);
            for (const f of baseline.files)
              if (
                (originalIndex.has(f.path) || f.data === null) &&
                !dataEqual(f, afterFiles.get(f.path))
              )
                throw stale();
          } else if (actual.files.some((f) => f.kind !== "untracked"))
            throw stale();
          return {
            outcome: "completed",
            afterHead: after.head,
            conflicts: [],
            verifiedUnrelatedData: true,
          };
        },
      });
      return {
        ...result,
        lockRetained: !!cleanup && (cleanup.retained || cleanup.unchecked),
        retainedLocks: cleanup?.retained ? [cleanup.lock] : [],
        uncheckedLocks: cleanup?.unchecked ? [cleanup.lock] : [],
        log: (ctx.sanitizeDiagnostics ?? sanitizeRepositoryLog)(
          [...lines, ...(cleanup ? [cleanup.message] : [])].join("\n"),
        ),
      };
    });
  }
}
