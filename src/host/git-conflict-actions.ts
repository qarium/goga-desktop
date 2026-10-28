import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import {
  gitConflictSaveRequestSchema,
  gitConflictSaveTokenSchema,
  type GitConflictSavePreview,
  type GitConflictSaveRequest,
  type GitConflictSaveResult,
} from "../shared/git-conflict-save";
import {
  assertPolicySupported,
  capture,
  identity,
  parseStages,
  safe,
  stale,
  stateFingerprint,
  stateKey,
  type Policy,
  type State,
  type StoppedRebaseConflictBinding,
} from "./git-conflict-state";
import type { GitCommitContext } from "./git-workspace-actions";

/** The host supplies offline execution with empty global/system config and system
 * attributes. This is a host capability, never renderer-provided environment. */
export interface GitConflictActionContext extends GitCommitContext {
  readonly stoppedRebase?: StoppedRebaseConflictBinding;
  isolatedGit(
    args: string[],
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string }>;
}
const LIMIT = 1024 * 1024,
  MAX_TICKETS = 32,
  TTL = 5 * 60 * 1000,
  MAX_TICKET_BYTES = 16 * LIMIT;
export interface GitConflictTicket {
  retainedBytes: number;
  preview: GitConflictSavePreview;
  state: State;
  text: string | null;
  canonical: string | null;
  oid: string | null;
  mode: string | null;
}
/** One-use, owner-bound single literal path transaction. No commit, continuation,
 * rollback, rename inference or writes through Git to the real working file. */
export abstract class GitConflictActions {
  private readonly tickets = new Map<string, GitConflictTicket>();
  constructor(
    protected readonly options: {
      context: <T>(
        scope: ScopeRef,
        fn: (context: GitConflictActionContext) => Promise<T>,
      ) => Promise<T>;
      now?: () => number;
      /** Host-only synchronous failure/race seams; not IPC inputs. */
      beforePublishWork?: () => void;
      afterPublishWork?: () => void;
      beforePublishIndex?: () => void;
      afterPublishIndex?: () => void;
    },
  ) {}
  protected now() {
    return this.options.now?.() ?? Date.now();
  }
  protected git(
    c: GitCommitContext,
    args: string[],
    options?: { stdin?: string; indexFile?: string },
  ) {
    return c.git(
      [
        ...safe,
        `--git-dir=${path.join(c.root, ".git")}`,
        `--work-tree=${c.root}`,
        ...args,
      ],
      options,
    );
  }
  protected capture(c: GitCommitContext, name: string, revision: string) {
    return capture(c, name, revision);
  }
  private async canonicalize(
    c: GitConflictActionContext,
    text: string,
    policy: Policy,
    oidLength: number,
  ) {
    // Native newline conversion must not consult live repository attributes or
    // execute a newly-installed clean/process filter between CAS and Git spawn.
    // The tiny disposable repo is not a clone/worktree of the source repository.
    const temp = await fs.mkdtemp(
      path.join(os.tmpdir(), "goga-conflict-canonical-"),
    );
    const root = await fs.realpath(temp),
      gitdir = path.join(root, ".git");
    try {
      await c.isolatedGit([
        ...safe,
        "-c",
        "init.templateDir=",
        "init",
        "--quiet",
        `--object-format=${oidLength === 64 ? "sha256" : "sha1"}`,
        root,
      ]);
      await fs.mkdir(path.join(gitdir, "info"), {
        recursive: true,
        mode: 0o700,
      });
      const attributes = Object.entries(policy.values).map(([key, value]) =>
        value === "unspecified"
          ? `!${key}`
          : value === "unset"
            ? `-${key}`
            : value === "set"
              ? key
              : `${key}=${value}`,
      );
      await fs.writeFile(
        path.join(gitdir, "info/attributes"),
        `content ${attributes.join(" ")} -filter -ident -working-tree-encoding\n`,
      );
      const args = [
        ...safe,
        `--git-dir=${gitdir}`,
        `--work-tree=${root}`,
        "-c",
        "core.attributesfile=/dev/null",
        "-c",
        `core.autocrlf=${policy.autocrlf}`,
        "-c",
        `core.eol=${policy.eol}`,
        "-c",
        `core.safecrlf=${policy.safecrlf}`,
      ];
      const oid = (
        await c.isolatedGit(
          [...args, "hash-object", "-w", "--path=content", "--stdin"],
          text,
        )
      ).stdout.trim();
      if (!new RegExp(`^[a-f0-9]{${oidLength}}$`).test(oid)) throw stale();
      const canonical = (
        await c.isolatedGit([...args, "cat-file", "blob", oid])
      ).stdout;
      if (
        Buffer.byteLength(canonical) > LIMIT ||
        identity(Buffer.from(canonical), oidLength) !== oid
      )
        throw stale();
      return { canonical, oid };
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  }
  async prepare(
    input: GitConflictSaveRequest,
  ): Promise<GitConflictSavePreview> {
    const req = gitConflictSaveRequestSchema.parse(input);
    return this.options.context(req.scope, async (c) => {
      const state = await this.capture(c, req.path, req.revision);
      assertPolicySupported(state.policy);
      const readSource = async (
        row: ReturnType<typeof parseStages>[number],
      ) => {
        if (!row)
          return { kind: "absent", mode: null, oid: null, text: undefined };
        if (!["100644", "100755"].includes(row.mode))
          throw Error("Разрешение symlink/gitlink пока не поддерживается.");
        const size = (await this.git(c, ["cat-file", "-s", row.oid])).stdout;
        if (!/^(0|[1-9]\d*)\n$/.test(size) || Number(size) > LIMIT)
          throw Error("Версия файла превышает предел 1 МиБ.");
        const text = (await this.git(c, ["cat-file", "blob", row.oid])).stdout,
          bytes = Buffer.from(text);
        if (
          bytes.includes(0) ||
          bytes.length !== Number(size) ||
          identity(bytes, row.oid.length) !== row.oid
        )
          throw Error("Разрешение binary/non-UTF8 пока не поддерживается.");
        return { ...row, kind: "text", text };
      };
      if (state.disk.work) {
        try {
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            state.disk.work.bytes,
          );
        } catch {
          throw Error("Разрешение binary/non-UTF8 пока не поддерживается.");
        }
        if (state.disk.work.bytes.includes(0))
          throw Error("Разрешение binary пока не поддерживается.");
      }
      if (stateFingerprint(state) !== req.fingerprint) throw stale();
      // A rejection must not release the owner/read scope while sibling Git
      // children still run. Each child keeps its existing finite Runner/read
      // cancellation budget; drain them and preserve the first actual failure.
      let firstFailure: { error: unknown } | undefined;
      const reads = await Promise.allSettled(
        parseStages(state.stages, req.path).map((row) =>
          readSource(row).catch((error) => {
            firstFailure ??= { error };
            throw error;
          }),
        ),
      );
      if (firstFailure) throw firstFailure.error;
      const [base, current, incoming] = reads.map((read) => {
        if (read.status === "rejected") throw read.reason;
        return read.value;
      });
      const doc = { base, current, incoming };
      const source =
        req.resolution.kind === "current"
          ? doc.current
          : req.resolution.kind === "incoming"
            ? doc.incoming
            : null;
      if (source?.kind === "absent")
        throw Error(
          "Выбранная сторона отсутствует. Подтвердите удаление явно.",
        );
      const text =
        req.resolution.kind === "delete"
          ? null
          : req.resolution.kind === "text"
            ? req.resolution.text
            : source!.text!;
      const mode =
        text === null
          ? null
          : (source?.mode ??
            (state.disk.work && state.policy.filemode === "true"
              ? state.disk.work.mode & 0o100
                ? "100755"
                : "100644"
              : (doc.current.mode ?? doc.incoming.mode)));
      if (mode !== null && !["100644", "100755"].includes(mode ?? ""))
        throw stale();
      const oidLength = (doc.current.oid ?? doc.incoming.oid ?? doc.base.oid)!
        .length;
      const normalized =
        text === null
          ? { canonical: null, oid: null }
          : await this.canonicalize(c, text, state.policy, oidLength);
      if (
        stateKey(await this.capture(c, req.path, req.revision)) !==
        stateKey(state)
      )
        throw stale();
      // Copies freeze the authority binding; mutating a returned preview cannot
      // mutate a ticket. Do not retain original index/work buffers between calls.
      const preview: GitConflictSavePreview = {
        token: randomBytes(32).toString("hex"),
        scope: req.scope,
        path: req.path,
        branch: state.branch,
        resolution: req.resolution.kind,
        bytes: text === null ? 0 : Buffer.byteLength(text),
        expiresAt: this.now() + TTL,
        hooks: "disabled",
        canonicalization: "git-text-attributes",
      };
      for (const [token, t] of this.tickets)
        if (t.preview.expiresAt <= this.now()) this.tickets.delete(token);
      const retainedState: State = {
        ...state,
        disk: {
          ...state.disk,
          index: { ...state.disk.index, bytes: Buffer.alloc(0) },
          work: state.disk.work
            ? { ...state.disk.work, bytes: Buffer.alloc(0) }
            : null,
        },
      };
      // UTF-16 strings plus a conservative metadata allowance. Both count and
      // aggregate payload are bounded; large indexes never multiply per ticket.
      const retainedBytes =
        4 *
          (stateKey(retainedState).length +
            JSON.stringify(preview).length +
            (text?.length ?? 0) +
            (normalized.canonical?.length ?? 0)) +
        4096;
      if (retainedBytes > MAX_TICKET_BYTES)
        throw Error("Слишком большой предпросмотр конфликта Git.");
      const used = () =>
        [...this.tickets.values()].reduce((sum, t) => sum + t.retainedBytes, 0);
      while (
        this.tickets.size >= MAX_TICKETS ||
        used() + retainedBytes > MAX_TICKET_BYTES
      )
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(preview.token, {
        preview: structuredClone(preview),
        state: retainedState,
        text,
        ...normalized,
        mode,
        retainedBytes,
      });
      return preview;
    });
  }
  async execute(input: string): Promise<GitConflictSaveResult> {
    const token = gitConflictSaveTokenSchema.parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now())
      throw Error("Подтверждение истекло или уже использовано.");
    let result: GitConflictSaveResult | undefined;
    let finalize: (() => Promise<void>) | undefined;
    try {
      const contextual = await this.options.context(
        ticket.preview.scope,
        async (c) => {
          const current = await this.capture(
            c,
            ticket.preview.path,
            ticket.state.revision,
          );
          if (
            ticket.preview.expiresAt <= this.now() ||
            stateKey(current) !== stateKey(ticket.state)
          )
            throw stale();
          result = await this.transact(
            c,
            { ...ticket, state: current },
            (cleanup) => {
              finalize = cleanup;
            },
          );
          return result;
        },
      );
      // Host may sanitize diagnostics or downgrade the result after releasing
      // its lifecycle lock. Preserve those facts before final recovery cleanup.
      Object.assign(result!, contextual);
      if (finalize && result!.status !== "saved") {
        result!.lockRetained = true; // Native journal still owns its pending fence.
        return result!;
      }
      await finalize?.();
      return result!;
    } catch (error) {
      if (!result) throw error;
      return {
        ...result,
        status: "uncertain",
        lockRetained: true,
        message:
          "Завершение сохранения не подтверждено. Материалы восстановления сохранены; автоматическое повторение запрещено.",
        // A throwing context never returned its sanitized diagnostics. Finalize
        // also runs outside that boundary; never expose raw command/error data.
        log: "Завершающая проверка сохранения или освобождение контекста завершились ошибкой. Диагностика окружения скрыта.",
      };
    }
  }

  protected abstract transact(
    c: GitConflictActionContext,
    t: GitConflictTicket,
    onVerified: (cleanup: () => Promise<void>) => void,
  ): Promise<GitConflictSaveResult>;
}
