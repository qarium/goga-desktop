import path from "node:path";
import { startGitUpdate, type UpdateStartProof } from "./git-update-start";
import { randomBytes } from "node:crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { ScopeRef } from "../shared/context";
import {
  gitUpdateHandoffRequestSchema,
  gitUpdateStrategySchema,
  gitUpdateHandoffTokenSchema,
  type GitUpdateHandoffPreview,
  type GitUpdateHandoffResult,
  type GitUpdateHandoffCandidate,
  type GitUpdateHandoffRequest,
  type GitUpdateStrategy,
} from "../shared/git-update-handoff";
import { gitFilePathSchema } from "../shared/git-workspace";
import { hash, safe, stat } from "./git-conflict-state";
import {
  raw,
  rawKey,
  readTree,
  blob,
  run,
  type GitRebaseOperationContext,
} from "./git-rebase-operations-state";
import {
  continuationPolicy,
  sameLayout,
  sourceCommit,
  type SourceCommit,
} from "./git-rebase-continue-state";
import { withPrivateGitRead } from "./git-private-read";
import { CommandExitError } from "./process";

/** Host-supplied command context. Never assembled from renderer arguments. */
export interface GitUpdateHandoffContext extends GitRebaseOperationContext {
  topicsConfig(): Promise<string>;
}
export interface GitUpdateAttemptInput {
  targetBranch: string;
  /** Exact direct ref passed as --base-ref, after any refresh/fetch prefix. */
  sourceRef: string;
  baseRef: string;
}
interface Capture {
  scope: ScopeRef;
  root: string;
  owner: string;
  revision: string;
  head: string;
  source: string;
  strategy: GitUpdateStrategy;
  key: string;
  attemptKey: string;
  input: GitUpdateAttemptInput;
}
interface Attempt {
  state: Capture;
  expiresAt: number;
}
interface Candidate {
  state: Capture;
  candidate: GitUpdateHandoffCandidate;
}
const stale = () =>
  Error(
    "Данные обновления изменились или подтверждение истекло. Повторно проверьте контекст и ветки.",
  );
const unsupported = () =>
  Error(
    "Состояние Git не допускает подтверждённое ручное обновление в этом контексте.",
  );
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const oid = (value: string) =>
  z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(value.trim());

/** Bounded host registry. Capture/eligibility/validation/prepare remain read-only.
 * Only a separately confirmed, single-use token can start the native operation;
 * neither an error string, candidate ID nor renderer-provided SHA authorizes it. */
export class GitUpdateHandoffCandidates {
  private attempts = new WeakMap<object, Attempt>();
  private candidates = new Map<string, Candidate>();
  private tickets = new Map<
    string,
    {
      request: GitUpdateHandoffRequest;
      preview: GitUpdateHandoffPreview;
      key: string;
    }
  >();
  constructor(
    private options: {
      context<T>(
        scope: ScopeRef,
        fn: (c: GitUpdateHandoffContext) => Promise<T>,
      ): Promise<T>;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async config(c: GitUpdateHandoffContext) {
    const text = await c.topicsConfig();
    if (Buffer.byteLength(text) > 65536) throw unsupported();
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) throw unsupported();
    const value = z
      .object({
        base_ref: z.string().min(1),
        update: z
          .object({ strategy: z.string().nullable().optional() })
          .nullable()
          .optional(),
      })
      .parse(document.toJS({ maxAliasCount: 10 }));
    const strategy = gitUpdateStrategySchema.safeParse(
      value.update?.strategy ?? "merge",
    );
    if (!strategy.success)
      throw Error(
        "Неподдерживаемая стратегия обновления Goga; другой алгоритм не подставляется.",
      );
    return { text, strategy: strategy.data };
  }
  private async state(
    c: GitUpdateHandoffContext,
    input: GitUpdateAttemptInput,
  ): Promise<Capture> {
    input = structuredClone(input);
    const owner = c.ownerKey,
      scope = structuredClone(c.scope),
      root = c.root;
    await c.verifyOwner();
    const disk = raw(root),
      config = await this.config(c),
      policy = await continuationPolicy(c);
    const snapshot = await c.snapshot();
    if (
      snapshot.root !== root ||
      !equal(snapshot.scope, scope) ||
      snapshot.operation !== "none" ||
      stat(path.join(root, ".git/BISECT_START")) ||
      !snapshot.head ||
      snapshot.branch !== input.targetBranch ||
      snapshot.files.length
    )
      throw Error(
        "Для ручного обновления перейдите в чистый контекст ветки топика; переключение автоматически не выполняется.",
      );
    if (
      !/^refs\/(heads|remotes|desktop)\//.test(input.sourceRef) ||
      /[\0\r\n]/.test(input.baseRef) ||
      !input.baseRef ||
      input.baseRef.length > 4096
    )
      throw unsupported();
    await run(c, ["check-ref-format", input.sourceRef]);
    try {
      await run(c, ["symbolic-ref", "--quiet", input.sourceRef]);
      throw unsupported();
    } catch (error) {
      if (!(error instanceof CommandExitError) || error.exitCode !== 1)
        throw error;
    }
    const source = oid(
      await run(c, ["show-ref", "--verify", "--hash", input.sourceRef]),
    );
    if ((await run(c, ["cat-file", "-t", source])).trim() !== "commit")
      throw unsupported();
    const head = oid(snapshot.head);
    if (
      (await run(c, ["symbolic-ref", "HEAD"])).trim() !==
        `refs/heads/${input.targetBranch}` ||
      oid(await run(c, ["rev-parse", "--verify", "HEAD"])) !== head
    )
      throw stale();
    const finalConfig = await this.config(c);
    const finalPolicy = await continuationPolicy(c);
    await c.verifyOwner();
    if (
      owner !== c.ownerKey ||
      root !== c.root ||
      !equal(scope, c.scope) ||
      rawKey(raw(root)) !== rawKey(disk) ||
      finalConfig.text !== config.text ||
      finalPolicy.policy !== policy.policy
    )
      throw stale();
    const facts = [scope, root, owner, head, source, config, policy, input];
    return {
      scope,
      root,
      owner,
      revision: snapshot.revision,
      head,
      source,
      strategy: config.strategy,
      input: structuredClone(input),
      key: hash(JSON.stringify([...facts, snapshot.revision, rawKey(disk)])),
      // Observed native Goga preflight rewrites index atomically even on a
      // clean conflict refusal. Only byte-identical content and mode may cross
      // this one boundary; candidate validation pins the NEW physical index
      // and revision strictly again. No semantic staged change is tolerated.
      attemptKey: hash(
        JSON.stringify([
          ...facts,
          rawKey({
            ...disk,
            index: {
              ...disk.index,
              identity: `${disk.index.mode}:${hash(disk.index.bytes)}`,
            },
          }),
        ]),
      ),
    };
  }

  async capture(
    c: GitUpdateHandoffContext,
    input: GitUpdateAttemptInput,
  ): Promise<object> {
    const state = await this.state(c, input),
      handle = Object.freeze({});
    this.attempts.set(handle, { state, expiresAt: this.now() + 300000 });
    return handle;
  }
  /** Only a normally completed nonzero CLI invocation is eligible. Its text is
   * never inspected. Independent tree proof, unchanged owner/state, effective
   * policy and no active Git operation are still mandatory. */
  async afterFailure(
    c: GitUpdateHandoffContext,
    handle: object,
    error: unknown,
  ): Promise<GitUpdateHandoffCandidate | null> {
    const attempt = this.attempts.get(handle);
    this.attempts.delete(handle);
    if (
      !attempt ||
      attempt.expiresAt <= this.now() ||
      !(error instanceof CommandExitError) ||
      error.exitCode !== 1
    )
      return null;
    try {
      const state = await this.state(c, attempt.state.input);
      if (state.attemptKey !== attempt.state.attemptKey) return null;
      const proof = await this.prove(c, state);
      if (
        !proof ||
        this.now() >= attempt.expiresAt ||
        (await this.state(c, state.input)).key !== state.key
      )
        return null;
      const candidate: GitUpdateHandoffCandidate = {
        candidateId: randomBytes(32).toString("hex"),
        scope: structuredClone(state.scope),
        root: state.root,
        targetBranch: state.input.targetBranch,
        targetHead: state.head,
        sourceRef: state.input.sourceRef,
        sourceOid: state.source,
        baseRef: state.input.baseRef,
        strategy: state.strategy,
        algorithm: proof.algorithm,
        conflicts: proof.conflicts,
        expiresAt: attempt.expiresAt,
      };
      for (const [id, value] of this.candidates)
        if (value.candidate.expiresAt <= this.now()) this.candidates.delete(id);
      while (this.candidates.size >= 8)
        this.candidates.delete(this.candidates.keys().next().value!);
      this.candidates.set(candidate.candidateId, { state, candidate });
      return structuredClone(candidate);
    } catch {
      // Eligibility failure must not replace the original Goga operation log.
      return null;
    }
  }
  async validate(input: GitUpdateHandoffRequest) {
    const request = gitUpdateHandoffRequestSchema.parse(input),
      saved = this.candidates.get(request.candidateId);
    if (
      !saved ||
      saved.candidate.expiresAt <= this.now() ||
      !equal(saved.state.scope, request.scope)
    )
      throw stale();
    return this.options.context(request.scope, async (c) => {
      const { state } = await this.validateIn(c, request, saved);
      return {
        candidate: structuredClone(saved.candidate),
        proofKey: state.key,
      };
    });
  }
  private async validateIn(
    c: GitUpdateHandoffContext,
    request: GitUpdateHandoffRequest,
    saved: Candidate,
  ) {
    const state = await this.state(c, saved.state.input);
    if (
      state.key !== saved.state.key ||
      state.revision !== request.revision ||
      !equal(c.scope, request.scope)
    )
      throw stale();
    const proof = await this.prove(c, state);
    if (
      !proof ||
      !equal(proof.conflicts, saved.candidate.conflicts) ||
      proof.algorithm !== saved.candidate.algorithm ||
      (await this.state(c, state.input)).key !== state.key ||
      saved.candidate.expiresAt <= this.now()
    )
      throw stale();
    return { state, proof };
  }
  async prepare(
    input: GitUpdateHandoffRequest,
  ): Promise<GitUpdateHandoffPreview> {
    const request = gitUpdateHandoffRequestSchema.parse(input);
    const checked = await this.validate(request);
    const preview: GitUpdateHandoffPreview = {
      token: randomBytes(32).toString("hex"),
      candidate: checked.candidate,
      hooks: "disabled",
      publishes: false,
      effects:
        "Будет начата ручная Git-операция с конфликтами в указанном контексте. Рабочие файлы изменятся; разрешение конфликтов потребует отдельного действия. Hooks отключены. Публикации и автоматического повтора Goga нет. Предыдущее обновление базовой ветки могло уже выполниться.",
      expiresAt: checked.candidate.expiresAt,
    };
    for (const [id, t] of this.tickets)
      if (t.preview.expiresAt <= this.now()) this.tickets.delete(id);
    while (this.tickets.size >= 8)
      this.tickets.delete(this.tickets.keys().next().value!);
    this.tickets.set(preview.token, {
      request: structuredClone(request),
      preview: structuredClone(preview),
      key: checked.proofKey,
    });
    return preview;
  }
  async execute(input: string): Promise<GitUpdateHandoffResult> {
    const token = gitUpdateHandoffTokenSchema.parse(input),
      t = this.tickets.get(token);
    this.tickets.delete(token);
    if (!t || t.preview.expiresAt <= this.now()) throw stale();
    const saved = this.candidates.get(t.request.candidateId);
    // A candidate may authorize at most one attempt, even with multiple previews.
    this.candidates.delete(t.request.candidateId);
    if (!saved) throw stale();
    return this.options.context(t.request.scope, async (c) => {
      const { state, proof } = await this.validateIn(c, t.request, saved);
      if (state.key !== t.key) throw stale();
      return startGitUpdate(c, saved.candidate, proof, async () => {
        if (
          this.now() >= t.preview.expiresAt ||
          (await this.state(c, state.input)).key !== t.key
        )
          throw stale();
      });
    });
  }
  private async prove(
    c: GitUpdateHandoffContext,
    s: Capture,
  ): Promise<UpdateStartProof | null> {
    const bases = (await run(c, ["merge-base", "--all", s.head, s.source]))
      .trim()
      .split("\n");
    if (bases.length !== 1) throw unsupported();
    const base = oid(bases[0]);
    // Already up to date or a fast-forward: there can be no conflict handoff.
    if (base === s.source || base === s.head) return null;
    const algorithm = s.strategy.endsWith("rebase") ? "rebase" : "merge";
    const commits =
      algorithm === "rebase"
        ? (
            await run(c, [
              "rev-list",
              "--reverse",
              "--topo-order",
              "--max-count=129",
              `${base}..${s.head}`,
            ])
          )
            .trim()
            .split("\n")
            .map(oid)
        : [];
    if (commits.length > 128) throw unsupported();
    const trees = new Set([base, s.head, s.source, ...commits]),
      paths = new Set<string>(),
      blobs = new Set<string>();
    let total = 0;
    for (const id of trees) {
      const tree = await readTree(c, id);
      for (const [name, entry] of Object.entries(tree)) {
        paths.add(name);
        if (!blobs.has(entry.oid)) {
          blobs.add(entry.oid);
          const contents = await blob(c, entry.oid);
          // Existing marker-like lines make native conflict labels ambiguous.
          if (/^(?:<{7}|>{7}|\|{7})(?: |$)/m.test(contents.toString("utf8")))
            throw unsupported();
          total += contents.length;
        }
        if (total > 32 * 1024 * 1024 || paths.size > 4096) throw unsupported();
      }
    }
    // Validate source chain now, before creating even private probe objects.
    const sources: SourceCommit[] = [];
    let parent = base;
    for (const id of commits) {
      const source = await sourceCommit(c, id);
      if (source.parent !== parent) throw unsupported();
      sources.push(source);
      parent = id;
    }
    return withPrivateGitRead(
      c.root,
      safe,
      async (a) => (await c.git(a)).stdout,
      async (a) => (await c.isolatedGit(a)).stdout,
      async (p) => {
        if (
          paths.size &&
          (await p.git(["check-attr", "--all", "-z", "--", ...paths]))
        )
          throw unsupported();
        if (algorithm === "rebase") {
          // Default native rebase drops clean patch-equivalent commits. Until
          // that selection is independently modelled, refuse rather than claim
          // a conflict by replaying a commit native Git would skip.
          const cherry = (await p.git(["cherry", s.source, s.head, base]))
            .trim()
            .split("\n")
            .filter(Boolean);
          if (
            cherry.length !== sources.length ||
            cherry.some((row) => !/^\+ [a-f0-9]{40}$/.test(row)) ||
            !equal(
              cherry.map((row) => row.slice(2)).sort(),
              sources.map((source) => source.oid).sort(),
            )
          )
            throw unsupported();
        }
        const merge = async (
          ours: string,
          theirs: string,
          mergeBase?: string,
          nativeLabel = theirs,
        ) => {
          let stdout: string,
            conflict = false;
          try {
            stdout = await p.git([
              "merge-tree",
              "--write-tree",
              "--no-messages",
              "-z",
              ...(mergeBase ? [`--merge-base=${mergeBase}`] : []),
              ours,
              theirs,
            ]);
          } catch (error) {
            if (!(error instanceof CommandExitError) || error.exitCode !== 1)
              throw error;
            stdout = error.stdout;
            conflict = true;
          }
          if (!stdout.endsWith("\0") || Buffer.byteLength(stdout) > 1024 * 1024)
            throw unsupported();
          const fields = stdout.slice(0, -1).split("\0"),
            tree = oid(fields.shift()!);
          const stages = fields.filter(Boolean).map((row) => {
            const match = /^(100644|100755) ([a-f0-9]{40}) ([123])\t(.+)$/.exec(
              row,
            );
            if (!match) throw unsupported();
            gitFilePathSchema.parse(match[4]);
            return {
              path: match[4],
              row: `${match[1]} ${match[2]} ${match[3]}\t${match[4]}\0`,
            };
          });
          const conflicts = [...new Set(stages.map((s) => s.path))];
          if (
            conflict !== conflicts.length > 0 ||
            conflicts.length > 128 ||
            new Set(conflicts).size !== conflicts.length ||
            conflicts.some((n) => !paths.has(n))
          )
            throw unsupported();
          const entries = (await p.git(["ls-tree", "-r", "-z", tree]))
            .split("\0")
            .filter(Boolean)
            .map((row) => {
              const m = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
              if (!m || !paths.has(m[3])) throw unsupported();
              return {
                path: m[3],
                mode: m[1],
                oid: m[2],
                row: `${m[1]} ${m[2]} 0\t${m[3]}\0`,
              };
            });
          const worktree: UpdateStartProof["worktree"] = {};
          let outputSize = 0;
          for (const e of entries) {
            let text = await p.git(["cat-file", "blob", e.oid]);
            if (conflicts.includes(e.path)) {
              text = text.replace(
                /^(<{7}|>{7}) (.*)$/gm,
                (line, marker, label) => {
                  if (label !== (marker === "<<<<<<<" ? ours : theirs))
                    throw unsupported();
                  return `${marker} ${marker === "<<<<<<<" ? "HEAD" : nativeLabel}`;
                },
              );
            }
            const bytes = Buffer.from(text);
            outputSize += bytes.length;
            if (
              bytes.length > 1024 * 1024 ||
              outputSize > 32 * 1024 * 1024 ||
              bytes.includes(0)
            )
              throw unsupported();
            worktree[e.path] = { mode: e.mode, bytes };
          }
          const clean = entries.filter((row) => !conflicts.includes(row.path));
          const expectedIndex = [...clean, ...stages]
            .sort((a, b) =>
              Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
            )
            .map((row) => row.row)
            .join("");
          return { tree, conflicts: conflicts.sort(), expectedIndex, worktree };
        };
        let outcome: UpdateStartProof | null = null;
        const prefix: UpdateStartProof["prefix"] = [];
        if (algorithm === "merge") {
          const result = await merge(s.head, s.source);
          if (result.conflicts.length)
            outcome = {
              algorithm,
              conflicts: result.conflicts,
              expectedIndex: result.expectedIndex,
              worktree: result.worktree,
              picks: sources.map((s) => s.oid),
              prefix,
              stopped: null,
              paths: [...paths],
            };
        } else {
          let onto = s.source;
          for (const source of sources) {
            const short = (
              await p.git(["rev-parse", "--short", source.oid])
            ).trim();
            const result = await merge(
              onto,
              source.oid,
              source.parent,
              `${short} (${source.message.split("\n")[0]})`,
            );
            if (result.conflicts.length) {
              // The existing continuation writer cannot introduce/remove paths
              // or change modes in later picks. Refuse the offer before START,
              // including changes undone again before the topic tip.
              sameLayout(
                source.tree,
                ...sources.slice(prefix.length + 1).map((next) => next.tree),
              );
              outcome = {
                algorithm,
                conflicts: result.conflicts,
                expectedIndex: result.expectedIndex,
                worktree: result.worktree,
                picks: sources.map((s) => s.oid),
                prefix,
                stopped: source.oid,
                paths: [...paths],
              };
              break;
            }
            prefix.push({
              source: source.oid,
              tree: result.tree,
              author: source.author,
              message: source.message,
            });
            onto = oid(
              await p.git([
                "-c",
                "commit.gpgsign=false",
                "commit-tree",
                result.tree,
                "-p",
                onto,
                "-m",
                "Goga isolated conflict proof",
              ]),
            );
          }
        }
        await p.verify();
        return outcome;
      },
    );
  }
}
