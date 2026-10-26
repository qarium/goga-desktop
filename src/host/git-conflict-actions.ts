import { randomBytes, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fchmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import {
  gitConflictSaveRequestSchema,
  gitConflictSaveTokenSchema,
  type GitConflictSaveRequest,
  type GitConflictSavePreview,
  type GitConflictSaveResult,
} from "../shared/git-conflict-save";
import {
  hash,
  stale,
  safe,
  stat,
  directory,
  regular,
  parents,
  assertParents,
  metadata,
  disk,
  stateKey,
  identity,
  capture,
  stateFingerprint,
  parseStages,
  assertPolicySupported,
  type File,
  type State,
  type Policy,
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
interface Ticket {
  retainedBytes: number;
  preview: GitConflictSavePreview;
  state: State;
  text: string | null;
  canonical: string | null;
  oid: string | null;
  mode: string | null;
}
function syncDirectory(dir: string) {
  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function writeNew(file: string, bytes: string | Buffer, mode = 0o600) {
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    mode,
  );
  try {
    // Recovery directories are private; preserve approved permissions exactly,
    // rather than widening a 0600 working file to a generic Git 0644 default.
    fchmodSync(fd, mode);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** One-use, owner-bound single literal path transaction. No commit, continuation,
 * rollback, rename inference or writes through Git to the real working file. */
export class GitConflictActions {
  private readonly tickets = new Map<string, Ticket>();
  constructor(
    private readonly options: {
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
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private git(
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
  private capture(c: GitCommitContext, name: string, revision: string) {
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
      for (const name of ["objects", "refs", "info"])
        await fs.mkdir(path.join(gitdir, name), {
          recursive: true,
          mode: 0o700,
        });
      await fs.writeFile(path.join(gitdir, "HEAD"), "ref: refs/heads/unused\n");
      await fs.writeFile(
        path.join(gitdir, "config"),
        oidLength === 64
          ? "[core]\nrepositoryformatversion = 1\n[extensions]\nobjectformat = sha256\n"
          : "[core]\nrepositoryformatversion = 0\n",
      );
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
    return this.options.context(ticket.preview.scope, async (c) => {
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
      return this.transact(c, { ...ticket, state: current });
    });
  }
  private async transact(
    c: GitConflictActionContext,
    t: Ticket,
  ): Promise<GitConflictSaveResult> {
    const root = t.state.root,
      name = t.preview.path,
      gitdir = path.join(root, ".git"),
      work = path.join(root, name),
      index = path.join(gitdir, "index"),
      lock = path.join(gitdir, "index.lock"),
      recovery = path.join(gitdir, `goga-commit-${randomUUID()}`),
      privateIndex = path.join(recovery, "index"),
      candidate = path.join(recovery, "index-ready"),
      workReady = path.join(recovery, "work-ready");
    let workPublished = false,
      indexPublished = false,
      lockIdentity = "",
      lockContentHash = "",
      recoveryIdentity = "",
      readyWork: File | null = null,
      publishedWork: File | null = null;
    const ownLock = () => {
      try {
        if (!lockIdentity || !lockContentHash) return false;
        // Work parents may have changed; .git ownership alone determines whether
        // our lock can safely be released on a pre-publication refusal.
        assertParents(t.state.disk.parents.slice(0, 2));
        const s = stat(lock);
        return (
          !!s &&
          `${s.dev}:${s.ino}` === lockIdentity &&
          s.nlink === 1n &&
          hash(regular(lock)!.bytes) === lockContentHash
        );
      } catch {
        return false;
      }
    };
    const journal = {
      version: 1,
      kind: "single-conflict-save",
      scope: t.preview.scope,
      path: name,
      root,
      oldHead: t.state.head,
      operation: t.state.operation,
      ownerHash: hash(t.state.owner),
      parents: t.state.disk.parents,
      lockIdentity: "",
      preparedIndexHash: "",
      publishedWorkIdentity: null as string | null,
      oldWork: t.state.disk.work?.identity ?? "missing",
      oldIndex: t.state.disk.index.identity,
      submittedHash: t.text === null ? null : hash(t.text),
      canonicalOid: t.oid,
      mode: t.mode,
      worktreePublished: false,
      indexPublished: false,
      state: "prepared",
      lockRetained: false,
    };
    const writeJournal = () => {
      if (directory(recovery) !== recoveryIdentity) throw stale();
      assertParents(t.state.disk.parents);
      const next = path.join(recovery, `journal-${randomUUID()}`);
      writeNew(next, JSON.stringify(journal, null, 2));
      renameSync(next, path.join(recovery, "journal.json"));
      syncDirectory(recovery);
    };
    const expectedMetadata = () => {
      if (!workPublished) return t.state.disk.metadata;
      // A selected .gitattributes is itself a metadata row. Admit only our exact
      // published inode/content delta; every other attribute/metadata row and the
      // effective normalization policy remain strictly pinned.
      const rows: [string, string][] = JSON.parse(t.state.disk.metadata);
      return JSON.stringify(
        rows.map(([filename, identity]) => [
          filename,
          filename === work ? (publishedWork?.identity ?? "missing") : identity,
        ]),
      );
    };
    const assertDisk = (expectedWork: File | null) => {
      const fresh = disk(root, name);
      if (
        JSON.stringify(fresh.parents) !==
          JSON.stringify(t.state.disk.parents) ||
        fresh.metadata !== expectedMetadata() ||
        fresh.index.identity !== t.state.disk.index.identity ||
        (fresh.work?.identity ?? "missing") !==
          (expectedWork?.identity ?? "missing") ||
        c.root !== root ||
        c.ownerKey !== t.state.owner ||
        JSON.stringify(c.scope) !== t.state.scope ||
        !ownLock()
      )
        throw stale();
      if (directory(recovery) !== recoveryIdentity) throw stale();
      if (
        !workPublished &&
        t.text !== null &&
        regular(workReady, LIMIT)?.identity !== readyWork?.identity
      )
        throw stale();
    };
    const verify = async (expectedWork: File | null) => {
      const actual = await this.capture(c, name, t.state.revision);
      const expected = {
        ...t.state,
        disk: {
          ...t.state.disk,
          work: expectedWork,
          metadata: expectedMetadata(),
        },
      };
      if (stateKey(actual) !== stateKey(expected)) throw stale();
      if (t.preview.expiresAt <= this.now()) throw stale();
      assertDisk(expectedWork);
    };
    const result = (
      status: GitConflictSaveResult["status"],
      message: string,
      log = "",
    ): GitConflictSaveResult => ({
      scope: t.preview.scope,
      path: name,
      status,
      message,
      log,
      worktreePublished: workPublished,
      indexPublished,
      lockRetained: ownLock(),
      ...(recoveryIdentity ? { recoveryPath: recovery } : {}),
    });
    try {
      assertParents(t.state.disk.parents);
      mkdirSync(recovery, { mode: 0o700 });
      assertParents(t.state.disk.parents);
      recoveryIdentity = directory(recovery);
      writeNew(path.join(recovery, "original-index"), t.state.disk.index.bytes);
      writeNew(privateIndex, t.state.disk.index.bytes);
      if (t.state.disk.work)
        writeNew(path.join(recovery, "original-work"), t.state.disk.work.bytes);
      if (t.text !== null) {
        writeNew(path.join(recovery, "submitted-work"), t.text);
        const originalMode =
          t.state.disk.work?.mode ?? (t.mode === "100755" ? 0o700 : 0o600);
        const workMode =
          t.preview.resolution === "text"
            ? originalMode
            : t.mode === "100755"
              ? originalMode | ((originalMode & 0o444) >> 2)
              : originalMode & ~0o111;
        writeNew(workReady, t.text, workMode);
        readyWork = regular(workReady, LIMIT);
      }
      writeJournal();
      syncDirectory(gitdir);
      if (t.canonical !== null) {
        const oid = (
          await this.git(c, ["hash-object", "--no-filters", "-w", "--stdin"], {
            stdin: t.canonical,
          })
        ).stdout.trim();
        if (oid !== t.oid) throw stale();
      }
      const zeros = "0".repeat(t.oid?.length ?? t.state.head?.length ?? 40);
      assertParents(t.state.disk.parents);
      if (
        directory(recovery) !== recoveryIdentity ||
        !regular(privateIndex)?.bytes.equals(t.state.disk.index.bytes)
      )
        throw stale();
      await this.git(c, ["update-index", "-z", "--index-info"], {
        stdin:
          `0 ${zeros}\t${name}\0` +
          (t.oid ? `${t.mode} ${t.oid} 0\t${name}\0` : ""),
        indexFile: privateIndex,
      });
      const ready = regular(privateIndex);
      if (!ready) throw stale();
      writeNew(candidate, ready.bytes);
      lockContentHash = hash(ready.bytes);
      // Hard-link publication is O_EXCL-like and exposes an already complete
      // valid index, never an empty placeholder. Remove our extra link at once.
      const s = stat(candidate)!;
      lockIdentity = `${s.dev}:${s.ino}`;
      journal.lockIdentity = lockIdentity;
      journal.preparedIndexHash = lockContentHash;
      journal.state = "index-prepared";
      writeJournal();
      try {
        linkSync(candidate, lock);
      } catch (e) {
        lockIdentity = "";
        if ((e as NodeJS.ErrnoException).code === "EEXIST")
          throw Error("Индекс Git занят: чужая index.lock не изменена.");
        throw e;
      }
      unlinkSync(candidate);
      syncDirectory(gitdir);
      await verify(t.state.disk.work);
      this.options.beforePublishWork?.();
      await verify(t.state.disk.work);
      journal.state = "publishing-work";
      writeJournal();
      assertDisk(t.state.disk.work);
      if (t.text === null) {
        if (t.state.disk.work) unlinkSync(work);
      } else renameSync(workReady, work);
      workPublished = true;
      publishedWork = regular(work, LIMIT);
      // Do not adopt a later writer's first observed bytes as our own publish.
      // Rename may change timestamps, but must retain the prepared inode, mode,
      // size and exact bytes. Deletion must still be missing at this boundary.
      if (
        t.text === null
          ? publishedWork !== null
          : !readyWork ||
            !publishedWork ||
            publishedWork.identity.split(":").slice(0, 4).join(":") !==
              readyWork.identity.split(":").slice(0, 4).join(":") ||
            !publishedWork.bytes.equals(readyWork.bytes)
      )
        throw stale();
      journal.publishedWorkIdentity = publishedWork?.identity ?? "missing";
      syncDirectory(path.dirname(work));
      this.options.afterPublishWork?.();
      journal.worktreePublished = true;
      journal.state = "work-published";
      writeJournal();
      await verify(publishedWork);
      this.options.beforePublishIndex?.();
      await verify(publishedWork);
      journal.state = "publishing-index";
      writeJournal();
      assertDisk(publishedWork);
      renameSync(lock, index);
      indexPublished = true;
      lockIdentity = "";
      syncDirectory(gitdir);
      this.options.afterPublishIndex?.();
      // A subsequent external write is not rolled back or called solved.
      await c.verify();
      assertParents(t.state.disk.parents);
      if (
        metadata(root, name) !== expectedMetadata() ||
        (regular(work, LIMIT)?.identity ?? "missing") !==
          (publishedWork?.identity ?? "missing") ||
        !regular(index)?.bytes.equals(ready.bytes)
      )
        throw stale();
      journal.indexPublished = true;
      journal.state = "complete";
      writeJournal();
      // Keep the durable journal/backups: recovery is explicit and never automatic.
      return result(
        "saved",
        "Файл сохранён и подготовлен. Другие конфликты и операция Git не завершены.",
      );
    } catch (error) {
      // Once worktree publication succeeds, keep our valid index.lock and all
      // recovery material. Releasing it could let another Git operation hide the
      // partial transaction. A foreign/replaced lock is never removed or retained
      // on our behalf. No automatic restoration ever overwrites newer edits.
      if (!workPublished && ownLock()) {
        unlinkSync(lock);
        lockIdentity = "";
        syncDirectory(gitdir);
      }
      journal.worktreePublished = workPublished;
      journal.indexPublished = indexPublished;
      journal.lockRetained = ownLock();
      journal.state = indexPublished
        ? "uncertain"
        : workPublished
          ? "partial"
          : "not-saved";
      try {
        if (recoveryIdentity) writeJournal();
      } catch {
        /* Original durable intent and backups remain; never restore blindly. */
      }
      return result(
        indexPublished ? "uncertain" : workPublished ? "partial" : "not-saved",
        indexPublished
          ? "Публикация индекса выполнена, но итоговая проверка не завершена. Проверьте журнал восстановления; не повторяйте автоматически."
          : workPublished
            ? "Рабочий файл сохранён, но индекс не опубликован. Конфликт не объявлен решённым; сохранены черновик, резервные копии и собственная блокировка, если она ещё принадлежит операции."
            : "Файл и индекс не опубликованы. Подтверждение использовано; повторите предпросмотр.",
        String(error),
      );
    }
  }
}
