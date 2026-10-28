import { withNativeGitCompletion } from "./git-native-completion";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { ScopeRef } from "../shared/context";
import {
  gitUpdateHandoffRequestSchema,
  gitUpdateHandoffTokenSchema,
  gitUpdateStrategySchema,
  type GitUpdateHandoffCandidate,
  type GitUpdateHandoffPreview,
  type GitUpdateHandoffRequest,
  type GitUpdateHandoffResult,
} from "../shared/git-update-handoff";
import type { GitCommitContext } from "./git-workspace-actions";
export interface GitUpdateAttemptInput {
  targetBranch: string;
  /** Exact direct ref passed as --base-ref, after any refresh/fetch prefix. */
  sourceRef: string;
  baseRef: string;
}
import {
  GitMergeSafety,
  oid,
  stale,
  stat,
  type GitMergeContext,
} from "./git-merge-safety";
import { nativeIntent } from "./git-native-context";
import { NativeGitSequence } from "./git-native-sequence";
import { CommandExitError } from "./process";
export interface NativeGitUpdateContext extends GitCommitContext {
  topicsConfig(): Promise<string>;
}
const adapt = (c: NativeGitUpdateContext): GitMergeContext => ({
  ...c,
  git: (args, stdin) => c.git(args, { stdin }),
});
/** A failed Goga command is NOT an adoptable operation. Only an unchanged,
 * clean owner can offer an independent fixed native start, with NEW explicit
 * confirmation. We never predict replay trees or inspect a sequencer plan. */
export class NativeGitUpdateHandoff extends GitMergeSafety {
  private attempts = new WeakMap<
    object,
    {
      state: Awaited<ReturnType<NativeGitUpdateHandoff["state"]>>;
      expires: number;
    }
  >();
  private candidates = new Map<
    string,
    {
      candidate: GitUpdateHandoffCandidate;
      state: Awaited<ReturnType<NativeGitUpdateHandoff["state"]>>;
    }
  >();
  private tickets = new Map<
    string,
    { request: GitUpdateHandoffRequest; preview: GitUpdateHandoffPreview }
  >();
  constructor(
    private options: {
      context<T>(
        scope: ScopeRef,
        fn: (c: NativeGitUpdateContext) => Promise<T>,
      ): Promise<T>;
      now?: () => number;
    },
  ) {
    super();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async state(c: NativeGitUpdateContext, input: GitUpdateAttemptInput) {
    const ctx = adapt(c),
      state = await this.capture(ctx, c.scope);
    if (
      state.snapshot.operation !== "none" ||
      !state.snapshot.head ||
      state.snapshot.branch !== input.targetBranch ||
      state.snapshot.files.length ||
      !ctx.native ||
      (await stat(path.join(ctx.root, ".git/BISECT_START")))
    )
      throw stale();
    if (
      !/^refs\/(heads|remotes|desktop)\//.test(input.sourceRef) ||
      /[\0\r\n]/.test(input.baseRef) ||
      !input.baseRef
    )
      throw stale();
    await this.git(ctx, ["check-ref-format", input.sourceRef]);
    try {
      await this.git(ctx, ["symbolic-ref", "--quiet", input.sourceRef]);
      throw stale();
    } catch (e) {
      if (!(e instanceof CommandExitError) || e.exitCode !== 1) throw e;
    }
    const source = oid(
      (
        await this.git(ctx, ["show-ref", "--verify", "--hash", input.sourceRef])
      ).stdout.trim(),
    );
    if (
      (await this.git(ctx, ["cat-file", "-t", source])).stdout.trim() !==
      "commit"
    )
      throw stale();
    const config = await c.topicsConfig();
    if (Buffer.byteLength(config) > 65536) throw stale();
    const yaml = parseDocument(config, { uniqueKeys: true });
    if (yaml.errors.length) throw stale();
    const parsed = z
      .object({
        base_ref: z.string().min(1),
        update: z
          .object({ strategy: gitUpdateStrategySchema.nullable().optional() })
          .nullable()
          .optional(),
      })
      .parse(yaml.toJS({ maxAliasCount: 10 }));
    const strategy = parsed.update?.strategy ?? "merge";
    const backend = z
      .enum(["merge", "apply"])
      .parse(
        state.config
          .filter(([key]) => key.toLowerCase() === "rebase.backend")
          .at(-1)?.[1] ?? "merge",
      );
    const protectedOthers = (
      await this.git(ctx, ["ls-files", "--others", "-z"])
    ).stdout
      .split("\0")
      .filter(Boolean);
    const guard = await this.nativeGuard(ctx, state, protectedOthers),
      observed = await guard.capture();
    // Public index/refs/controls and physical owner, not the inode of an index
    // that Goga may rewrite byte-identically during a clean refusal.
    const key = nativeIntent([input, source, config, observed]);
    await c.verify();
    if ((await this.capture(ctx, c.scope)).fingerprint !== state.fingerprint)
      throw stale();
    return {
      input: structuredClone(input),
      source,
      strategy,
      backend,
      key,
      revision: state.snapshot.revision,
      scope: c.scope,
      root: c.root,
      head: state.snapshot.head,
    };
  }
  async captureAttempt(
    c: NativeGitUpdateContext,
    input: GitUpdateAttemptInput,
  ) {
    const state = await this.state(c, input),
      handle = Object.freeze({});
    this.attempts.set(handle, { state, expires: this.now() + 300000 });
    return handle;
  }
  async afterFailure(
    c: NativeGitUpdateContext,
    handle: object,
    error: unknown,
  ): Promise<GitUpdateHandoffCandidate | null> {
    const attempt = this.attempts.get(handle);
    this.attempts.delete(handle);
    if (
      !attempt ||
      attempt.expires <= this.now() ||
      !(error instanceof CommandExitError) ||
      error.exitCode !== 1
    )
      return null;
    try {
      const state = await this.state(c, attempt.state.input);
      if (state.key !== attempt.state.key) return null;
      const bases = (
        await this.git(adapt(c), [
          "merge-base",
          "--all",
          state.head,
          state.source,
        ])
      ).stdout
        .trim()
        .split("\n");
      if (
        bases.length !== 1 ||
        bases[0] === state.head ||
        bases[0] === state.source
      )
        return null;
      if (
        (await this.state(c, attempt.state.input)).key !== state.key ||
        attempt.expires <= this.now()
      )
        return null;
      const candidate: GitUpdateHandoffCandidate = {
        candidateId: randomBytes(32).toString("hex"),
        scope: state.scope,
        root: state.root,
        targetBranch: state.input.targetBranch,
        targetHead: state.head,
        sourceRef: state.input.sourceRef,
        sourceOid: state.source,
        baseRef: state.input.baseRef,
        strategy: state.strategy,
        algorithm: state.strategy.endsWith("rebase") ? "rebase" : "merge",
        ...(state.strategy.endsWith("rebase")
          ? { backend: state.backend }
          : {}),
        conflicts: [],
        expiresAt: attempt.expires,
      };
      for (const [id, item] of this.candidates)
        if (item.candidate.expiresAt <= this.now()) this.candidates.delete(id);
      if (this.candidates.size >= 8)
        this.candidates.delete(this.candidates.keys().next().value!);
      this.candidates.set(candidate.candidateId, { candidate, state });
      return structuredClone(candidate);
    } catch {
      return null;
    }
  }
  private async validateIn(
    c: NativeGitUpdateContext,
    request: GitUpdateHandoffRequest,
  ) {
    const saved = this.candidates.get(request.candidateId);
    if (
      !saved ||
      saved.candidate.expiresAt <= this.now() ||
      JSON.stringify(saved.candidate.scope) !== JSON.stringify(request.scope)
    )
      throw stale();
    const state = await this.state(c, saved.state.input);
    if (
      state.key !== saved.state.key ||
      state.revision !== request.revision ||
      saved.candidate.expiresAt <= this.now()
    )
      throw stale();
    return saved;
  }
  async prepare(
    input: GitUpdateHandoffRequest,
  ): Promise<GitUpdateHandoffPreview> {
    const request = gitUpdateHandoffRequestSchema.parse(input);
    return this.options.context(request.scope, async (c) => {
      const saved = await this.validateIn(c, request),
        preview: GitUpdateHandoffPreview = {
          token: randomBytes(32).toString("hex"),
          candidate: structuredClone(saved.candidate),
          hooks: "disabled",
          publishes: false,
          effects:
            (saved.candidate.backend
              ? `Rebase backend: ${saved.candidate.backend}. `
              : "") +
            "Будет отдельно начата штатная Git-операция в текущей ветке. Git может завершить её или остановиться на конфликте; конфликтные файлы определяются после запуска. Хуки отключены. Это не повтор и не завершение всей операции Goga, публикации нет.",
          expiresAt: saved.candidate.expiresAt,
        };
      for (const [id, t] of this.tickets)
        if (t.preview.expiresAt <= this.now()) this.tickets.delete(id);
      if (this.tickets.size >= 8)
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(preview.token, { request, preview });
      return preview;
    });
  }
  async execute(input: string): Promise<GitUpdateHandoffResult> {
    return withNativeGitCompletion(() => this.executeInCompletion(input));
  }
  private async executeInCompletion(
    input: string,
  ): Promise<GitUpdateHandoffResult> {
    const token = gitUpdateHandoffTokenSchema.parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now()) throw stale();
    return this.options.context(ticket.request.scope, async (c) => {
      const saved = await this.validateIn(c, ticket.request);
      this.candidates.delete(ticket.request.candidateId);
      // Same already-locked physical context; never recursively acquire Host locks.
      const engine = new NativeGitSequence({
        context: async (_scope, fn) => fn(adapt(c)),
        now: () => this.now(),
        confirmationExpiresAt: ticket.preview.expiresAt,
      });
      const start = await engine.prepareStart(
        c.scope,
        saved.candidate.algorithm === "rebase"
          ? {
              operation: "rebase",
              backend: saved.state.backend,
              source: saved.state.source,
            }
          : { operation: "merge", source: saved.state.source },
      );
      if (
        (await this.state(c, saved.state.input)).key !== saved.state.key ||
        ticket.preview.expiresAt <= this.now()
      )
        throw stale();
      const { log, lockRetained, retainedLocks, uncheckedLocks, ...native } =
        await engine.execute(start.token);
      return {
        scope: c.scope,
        root: c.root,
        algorithm: saved.candidate.algorithm,
        status:
          native.outcome === "completed"
            ? "success"
            : native.outcome === "conflicts"
              ? "conflict"
              : native.outcome === "rejected"
                ? "error"
                : "uncertain",
        changed: native.outcome !== "rejected",
        conflicts: native.conflicts,
        native,
        log,
        lockRetained,
        retainedLocks,
        uncheckedLocks,
        message:
          native.outcome === "completed"
            ? "Git завершил локальную операцию. Это не подтверждает выполнение всей операции Goga или публикацию."
            : native.outcome === "conflicts"
              ? "Git остановился на конфликте. Защитный снимок сохранён; продолжение требует отдельного подтверждения."
              : "Результат Git не подтверждён. Автоматического повтора нет.",
      };
    });
  }
}
