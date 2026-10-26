import { verifyApplyNext } from "./git-rebase-apply";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  readdirSync,
  fstatSync,
} from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import type {
  GitRebaseOperationPreview,
  GitRebaseOperationRequest,
  GitRebaseOperationResult,
} from "../shared/git-rebase-operations";
import {
  directory,
  regular,
  stat,
  stale,
  hash,
  assertStoppedRebaseOwnership,
  type File,
} from "./git-conflict-state";
import {
  args,
  raw,
  rawKey,
  assertPaths,
  matches,
  readTree,
  type GitRebaseOperationContext,
} from "./git-rebase-operations-state";
import {
  captureContinue,
  continuationPolicy,
  sourceCommit,
  treeKey,
  stageText,
  refuse,
  type ContinueState,
  type SourceCommit,
} from "./git-rebase-continue-state";
import { readRebaseBinding } from "./git-rebase-read-binding";
import { CommandExitError } from "./process";
import { sanitizeRepositoryLog } from "./repository-actions";
export interface RebaseOptions {
  context: <T>(
    scope: ScopeRef,
    fn: (c: GitRebaseOperationContext) => Promise<T>,
  ) => Promise<T>;
  now?: () => number;
  beforeNative?: () => void;
  afterNative?: () => void;
  afterPublish?: (
    step: "objects" | "index" | "head" | "branch" | "metadata",
  ) => void;
  releaseLockFault?: (name: string, phase: "before" | "after") => void;
}
const TTL = 5 * 60 * 1000;
const sync = (dir: string) => {
  const fd = openSync(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const create = (p: string, b: Buffer | string, created?: () => void) => {
  const fd = openSync(
    p,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    created?.();
    writeFileSync(fd, b);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};
const alternate = (file: string) =>
  `"${[...Buffer.from(file)].map((b) => (b === 34 || b === 92 ? `\\${String.fromCharCode(b)}` : b < 32 || b >= 127 ? `\\${b.toString(8).padStart(3, "0")}` : String.fromCharCode(b))).join("")}"\n`;
interface Ticket {
  request: GitRebaseOperationRequest;
  preview: GitRebaseOperationPreview;
  key: string;
}
/** One native continuation in private metadata, never a replay implementation.
 * All source publication is separately journaled and CAS guarded. Portable Node
 * does not exclude arbitrary same-user writes after the last synchronous guard. */
export class GitRebaseContinue {
  private tickets = new Map<string, Ticket>();
  constructor(private options: RebaseOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  has(token: string) {
    return this.tickets.has(token);
  }
  async prepare(
    request: GitRebaseOperationRequest,
  ): Promise<GitRebaseOperationPreview> {
    return this.options.context(request.scope, async (c) => {
      const s = await captureContinue(c, request.revision),
        b = s.base;
      const preview: GitRebaseOperationPreview = {
        token: randomBytes(32).toString("hex"),
        scope: request.scope,
        root: c.root,
        operation: "rebase",
        backend: b.backend,
        action: "continue",
        branch: b.branch,
        head: b.head,
        original: b.original,
        paths: s.paths,
        hooks: "disabled",
        expiresAt: this.now() + TTL,
        effects: `Продолжить линейный rebase --${b.backend} до следующего конфликта или конца проверенной последовательности: только существующие текстовые пути. Посторонние staged/unstaged правки, signing и нестандартная политика запрещены. Следующий конфликт останется в том же rebase. Hooks/editor отключены; публикации на сервер нет.`,
      };
      for (const [token, t] of this.tickets)
        if (t.preview.expiresAt <= this.now()) this.tickets.delete(token);
      while (this.tickets.size >= 8)
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(preview.token, {
        request: structuredClone(request),
        preview: structuredClone(preview),
        key: s.key,
      });
      return preview;
    });
  }
  async execute(token: string): Promise<GitRebaseOperationResult> {
    const t = this.tickets.get(token);
    this.tickets.delete(token);
    if (!t || t.preview.expiresAt <= this.now())
      throw Error("Подтверждение истекло или уже использовано.");
    return this.options.context(t.request.scope, async (c) => {
      const s = await captureContinue(c, t.request.revision);
      if (s.key !== t.key || this.now() >= t.preview.expiresAt) throw stale();
      return this.perform(c, t, s);
    });
  }
  private async perform(
    c: GitRebaseOperationContext,
    t: Ticket,
    s: ContinueState,
  ): Promise<GitRebaseOperationResult> {
    const b = s.base,
      operationName = `rebase-${b.backend}`,
      topFiles =
        b.backend === "merge"
          ? ["AUTO_MERGE", "REBASE_HEAD", "MERGE_MSG"]
          : ["REBASE_HEAD"],
      gd = path.join(c.root, ".git"),
      ref = `refs/heads/${b.branch}`,
      recovery = path.join(gd, `goga-continue-${randomUUID()}`),
      native = path.join(recovery, "native");
    const locks = new Map<string, string>(),
      unchecked = new Set<string>(),
      backups = new Map<string, Buffer>();
    let recoveryCreated = false,
      recoveryIdentity = "",
      nativeIdentity = "",
      mutationStarted = false,
      indexPublished = false,
      headPublished = false,
      branchPublished = false,
      objectsPublished = false,
      publishedObjectCount = 0,
      metadataPublished = false,
      metadataCleared = false,
      worktreeUpdated = false,
      status: GitRebaseOperationResult["status"] = "error",
      message = "Продолжение не начато.",
      log = "";
    const expectedMetadata = new Map<string, string>(
      JSON.parse(b.disk.metadata),
    );
    let expectedIndex = b.disk.index.identity;
    const metadataKey = (rows: Iterable<[string, string]>) =>
      JSON.stringify([...rows].sort(([a], [b]) => a.localeCompare(b)));
    const updateFile = (name: string) =>
      expectedMetadata.set(
        path.join(gd, name),
        regular(path.join(gd, name))?.identity ?? "missing",
      );
    const removeOperation = () => {
      const target = path.join(gd, operationName);
      for (const n of expectedMetadata.keys())
        if (n === target || n.startsWith(`${target}/`))
          expectedMetadata.delete(n);
      expectedMetadata.set(target, "missing");
    };
    const lockId = (n: string) => regular(path.join(gd, n))?.identity;
    const guardLocks = () => {
      for (const [n, id] of locks) if (lockId(n) !== id) throw stale();
    };
    const guardRecovery = () => {
      assertPaths(b.disk);
      if (
        directory(recovery) !== recoveryIdentity ||
        directory(native) !== nativeIdentity
      )
        throw stale();
    };
    const unchanged = () => {
      c.assertPublicationOwner?.();
      assertStoppedRebaseOwnership(c.stoppedRebase);
      guardRecovery();
      guardLocks();
      const r = raw(c.root, [...locks.keys()]);
      if (
        metadataKey(JSON.parse(r.metadata)) !== metadataKey(expectedMetadata) ||
        r.index.identity !== expectedIndex
      )
        throw stale();
    };
    const backup = (n: string, v: Buffer) => {
      mkdirSync(path.dirname(path.join(recovery, n)), {
        recursive: true,
        mode: 0o700,
      });
      create(path.join(recovery, n), v);
      backups.set(n, v);
    };
    const backupValid = () => {
      for (const [n, bytes] of backups) {
        let parent = recovery;
        for (const part of n.split("/").slice(0, -1)) {
          parent = path.join(parent, part);
          directory(parent);
        }
        if (!regular(path.join(recovery, n))?.bytes.equals(bytes))
          throw stale();
      }
      guardRecovery();
    };
    const facts = () => ({
      scope: t.request.scope,
      operation: "rebase" as const,
      action: "continue" as const,
      status,
      changed:
        mutationStarted ||
        publishedObjectCount > 0 ||
        indexPublished ||
        headPublished ||
        metadataPublished,
      mutationStarted,
      worktreeRestored: false,
      worktreeUpdated,
      objectsPublished,
      publishedObjectCount,
      indexPublished,
      headPublished,
      branchPublished,
      metadataPublished,
      metadataCleared,
      lockRetained: locks.size > 0,
      retainedLocks: [...locks.keys()],
      uncheckedLocks: [...unchecked],
      message: sanitizeRepositoryLog(message),
      log: sanitizeRepositoryLog(log),
    });
    const journal = () => {
      guardRecovery();
      const temp = path.join(recovery, `journal-${randomUUID()}`);
      create(
        temp,
        JSON.stringify(
          {
            version: 1,
            kind: "bounded-linear-rebase-continue",
            root: c.root,
            ownerHash: hash(b.owner),
            head: b.head,
            original: b.original,
            branch: b.branch,
            ...facts(),
          },
          null,
          2,
        ),
      );
      renameSync(temp, path.join(recovery, "journal.json"));
      sync(recovery);
    };
    const guardWork = (after: boolean) => {
      const r = raw(c.root, [...locks.keys()]),
        expected = after ? s.resultTree : s.resolved;
      if (Object.keys(r.files).length !== Object.keys(b.disk.files).length)
        throw stale();
      for (const [n, f] of Object.entries(b.disk.files)) {
        if (after && s.changedBytes[n]) {
          if (!matches(r.files[n], expected[n])) throw stale();
        } else if (r.files[n]?.identity !== f.identity) throw stale();
      }
      assertPaths(b.disk);
    };
    const guardOwner = async (
      same: "current" | "finish" | "next" = "current",
    ) => {
      await (same === "current"
        ? c.verify()
        : same === "next"
          ? (c.verifyNextRebase ?? c.verifyOwner)()
          : c.verifyOwner());
      c.assertPublicationOwner?.();
      assertStoppedRebaseOwnership(c.stoppedRebase);
      if (c.ownerKey !== b.owner || JSON.stringify(c.scope) !== b.scope)
        throw stale();
      const p = await continuationPolicy(c, b.backend);
      if (
        p.policy !== s.policy ||
        p.committer !== s.committer ||
        p.config !== s.config
      )
        throw stale();
    };
    const guardBefore = async () => {
      await guardOwner();
      unchanged();
      backupValid();
      guardWork(false);
      if (
        this.now() >= t.preview.expiresAt ||
        rawKey(raw(c.root, [...locks.keys()])) !== rawKey(b.disk)
      )
        throw stale();
    };
    const replace = (name: string, bytes: Buffer) => {
      unchanged();
      backupValid();
      guardWork(true);
      const ready = path.join(recovery, `ready-${randomUUID()}`);
      create(ready, bytes);
      guardLocks();
      renameSync(ready, path.join(gd, `${name}.lock`));
      locks.set(`${name}.lock`, lockId(`${name}.lock`)!);
      unchanged();
      renameSync(path.join(gd, `${name}.lock`), path.join(gd, name));
      locks.delete(`${name}.lock`);
      if (name === "index") {
        indexPublished = true;
        expectedIndex = regular(path.join(gd, name))!.identity;
      } else {
        if (name === "HEAD") headPublished = true;
        else branchPublished = true;
        updateFile(name);
      }
      sync(path.dirname(path.join(gd, name)));
      journal();
    };
    try {
      mkdirSync(recovery, { mode: 0o700 });
      recoveryCreated = true;
      recoveryIdentity = directory(recovery);
      mkdirSync(native, { mode: 0o700 });
      nativeIdentity = directory(native);
      backup("original-index", b.disk.index.bytes);
      backup("original-HEAD", regular(path.join(gd, "HEAD"))!.bytes);
      for (const [n, f] of Object.entries(b.operationFiles))
        backup(`backup/${n}`, f.bytes);
      for (const n of s.paths) backup(`work/${n}`, b.disk.files[n].bytes);
      for (const n of [
        "objects",
        "objects/info",
        "refs",
        "refs/heads",
        operationName,
      ])
        mkdirSync(path.join(native, n), { mode: 0o700 });
      mkdirSync(path.dirname(path.join(native, ref)), {
        recursive: true,
        mode: 0o700,
      });
      create(
        path.join(native, "objects/info/alternates"),
        alternate(path.join(gd, "objects")),
      );
      create(path.join(native, "config"), s.config);
      create(path.join(native, "HEAD"), `${b.head}\n`);
      create(path.join(native, ref), `${b.original}\n`);
      create(path.join(native, "index"), b.disk.index.bytes);
      for (const [n, f] of Object.entries(b.operationFiles))
        create(path.join(native, n), f.bytes);
      for (const [n, bytes] of [
        ["config.lock", regular(path.join(gd, "config"))!.bytes],
        [
          "packed-refs.lock",
          regular(path.join(gd, "packed-refs"))?.bytes ?? Buffer.alloc(0),
        ],
        [`${ref}.lock`, Buffer.from(`${b.original}\n`)],
        ["index.lock", b.disk.index.bytes],
        ["HEAD.lock", Buffer.from(`${b.head}\n`)],
      ] as const) {
        assertPaths(b.disk);
        const p = path.join(gd, n),
          fd = openSync(
            p,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          try {
            const held = fstatSync(fd, { bigint: true }),
              observed = regular(p),
              stamp = [
                held.dev,
                held.ino,
                held.mode,
                held.size,
                held.mtimeNs,
                held.ctimeNs,
              ].join(":");
            if (
              !observed?.identity.startsWith(`${stamp}:`) ||
              !observed.bytes.equals(bytes.subarray(0, observed.bytes.length))
            )
              throw stale();
            locks.set(n, observed.identity);
          } catch (e) {
            unchecked.add(n);
            throw e;
          } finally {
            closeSync(fd);
          }
        }
        sync(path.dirname(p));
      }
      journal();
      sync(gd);
      // Capture private input bytes before callbacks; never trust a replaced config,
      // alternate, todo, author-script or index when invoking native Git.
      const privateInput = () => {
        const rows: unknown[] = [];
        const visit = (p: string) => {
          if (stat(p)?.isDirectory()) {
            rows.push([p, directory(p)]);
            for (const n of readdirSync(p).sort()) visit(path.join(p, n));
          } else rows.push([p, regular(p)!.identity]);
        };
        visit(native);
        return hash(JSON.stringify(rows));
      };
      const authority = privateInput();
      await guardBefore();
      this.options.beforeNative?.();
      await guardBefore();
      if (privateInput() !== authority) throw stale();
      mutationStarted = true;
      journal();
      let nativeError: unknown;
      try {
        const out = await c.isolatedGit(
          args(c.root, ["-c", "core.editor=:", "rebase", "--continue"], native),
        );
        log += out.stdout + out.stderr;
      } catch (e) {
        nativeError = e;
        const v = e as { stdout?: string; stderr?: string; message?: string };
        log += `${v.stdout ?? ""}${v.stderr ?? ""}\n${v.message ?? String(e)}`;
      }
      this.options.afterNative?.();
      if (
        nativeError &&
        (!(nativeError instanceof CommandExitError) ||
          nativeError.exitCode === null)
      )
        throw nativeError;
      unchanged();
      backupValid();
      guardWork(true);
      await guardOwner();
      if (
        regular(path.join(native, "config"))?.bytes.toString() !== s.config ||
        regular(
          path.join(native, "objects/info/alternates"),
        )?.bytes.toString() !== alternate(path.join(gd, "objects"))
      )
        throw stale();
      const ngit = async (a: string[]) =>
        (await c.isolatedGit(args(c.root, a, native))).stdout;
      const nc = {
        ...c,
        isolatedGit: (a: string[]) =>
          c.isolatedGit(
            a.map((v) => (v === `--git-dir=${gd}` ? `--git-dir=${native}` : v)),
          ),
      };
      const lastStep = s.steps.at(-1);
      const conflict =
        !!lastStep && Object.keys(lastStep.proof.conflicts).length > 0;
      if (
        (conflict &&
          (!(nativeError instanceof CommandExitError) ||
            nativeError.exitCode !== 1)) ||
        (!conflict && nativeError)
      )
        throw nativeError ?? stale();
      const newHead = (await ngit(["rev-parse", "HEAD"])).trim();
      if (!/^[a-f0-9]{40}$/.test(newHead)) throw stale();
      const expectedCommits = [
        { source: s.current, tree: s.resolved },
        ...s.steps
          .filter(({ proof }) => !Object.keys(proof.conflicts).length)
          .map(({ source, proof }) => ({ source, tree: proof.tree })),
      ];
      const actualCommits: SourceCommit[] = [];
      let at = newHead;
      for (let i = expectedCommits.length - 1; i >= 0; i--) {
        const actual = await sourceCommit(nc, at);
        actualCommits.unshift(actual);
        at = actual.parent;
      }
      if (at !== b.head) throw stale();
      const first = actualCommits[0],
        final = actualCommits.at(-1)!;
      const checkCommit = (
        actual: typeof first,
        source: typeof s.current,
        parent: string,
        tree: typeof s.resolved,
      ) => {
        if (
          actual.parent !== parent ||
          actual.author !== source.author ||
          actual.message !== source.message ||
          treeKey(actual.tree) !== treeKey(tree)
        )
          throw stale();
      };
      for (let i = 0; i < expectedCommits.length; i++)
        checkCommit(
          actualCommits[i],
          expectedCommits[i].source,
          i ? actualCommits[i - 1].oid : b.head,
          expectedCommits[i].tree,
        );
      for (const commit of actualCommits.map((c) => c.oid))
        if (
          !(await ngit(["cat-file", "commit", commit])).includes(
            `\ncommitter ${s.committer} `,
          )
        )
          throw stale();
      const expectedTree = s.resultTree,
        stages = await ngit(["ls-files", "--stage", "-z"]);
      if (
        stages !==
        stageText(expectedTree, conflict ? lastStep!.proof.conflicts : {})
      )
        throw stale();
      let nativeFiles = new Map<string, File>();
      if (b.backend === "apply") {
        if (
          [
            "MERGE_HEAD",
            "MERGE_MODE",
            "CHERRY_PICK_HEAD",
            "REVERT_HEAD",
            "sequencer",
            "BISECT_START",
          ].some((n) => stat(path.join(native, n)))
        )
          throw stale();
        if (conflict)
          nativeFiles = await verifyApplyNext(nc, s, native, actualCommits);
        else if (
          stat(path.join(native, "rebase-apply")) ||
          stat(path.join(native, "rebase-merge")) ||
          stat(path.join(native, "REBASE_HEAD")) ||
          stat(path.join(native, "AUTO_MERGE")) ||
          stat(path.join(native, "MERGE_MSG")) ||
          regular(path.join(native, "HEAD"))?.bytes.toString() !==
            `ref: ${ref}\n` ||
          regular(path.join(native, ref))?.bytes.toString() !== `${final.oid}\n`
        )
          throw stale();
      } else if (conflict) {
        const actualOp = path.join(native, "rebase-merge");
        directory(actualOp);
        const allowed = new Set([
          ...Object.keys(b.operationFiles)
            .filter((n) => n.startsWith("rebase-merge/"))
            .map((n) => n.slice(13)),
          "rewritten-list",
        ]);
        for (const n of readdirSync(actualOp)) {
          if (!allowed.has(n)) throw stale();
          nativeFiles.set(
            `rebase-merge/${n}`,
            regular(path.join(actualOp, n), 1024 * 1024)!,
          );
        }
        for (const n of ["REBASE_HEAD", "AUTO_MERGE", "MERGE_MSG"]) {
          const f = regular(path.join(native, n));
          if (!f) throw stale();
          nativeFiles.set(n, f);
        }
        if (
          regular(path.join(native, "HEAD"))?.bytes.toString() !==
            `${final.oid}\n` ||
          regular(path.join(native, ref))?.bytes.toString() !==
            `${b.original}\n`
        )
          throw stale();
        for (const n of [
          "head-name",
          "orig-head",
          "onto",
          "end",
          "interactive",
          "drop_redundant_commits",
          "no-reschedule-failed-exec",
          "git-rebase-todo.backup",
        ])
          if (
            !nativeFiles
              .get(`rebase-merge/${n}`)
              ?.bytes.equals(b.operationFiles[`rebase-merge/${n}`].bytes)
          )
            throw stale();
        const oldText = (name: string) =>
          b.operationFiles[`rebase-merge/${name}`].bytes.toString();
        if (
          nativeFiles.get("rebase-merge/done")?.bytes.toString() !==
            oldText("done") +
              s.todoLines
                .slice(0, s.steps.length)
                .map((l) => l + "\n")
                .join("") ||
          nativeFiles.get("rebase-merge/msgnum")?.bytes.toString() !==
            `${Number(oldText("msgnum")) + s.steps.length}\n` ||
          nativeFiles.get("rebase-merge/rewritten-list")?.bytes.toString() !==
            (b.operationFiles[
              "rebase-merge/rewritten-list"
            ]?.bytes.toString() ?? "") +
              expectedCommits
                .map((c, i) => `${c.source.oid} ${actualCommits[i].oid}\n`)
                .join("")
        )
          throw stale();
        const author =
          /^author (.+) <([^<>\r\n]+)> ([0-9]+) ([+-][0-9]{4})$/.exec(
            lastStep!.source.author,
          )!;
        const quote = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
        if (
          nativeFiles.get("rebase-merge/author-script")?.bytes.toString() !==
          `GIT_AUTHOR_NAME=${quote(author[1])}\nGIT_AUTHOR_EMAIL=${quote(author[2])}\nGIT_AUTHOR_DATE=${quote(`@${author[3]} ${author[4]}`)}\n`
        )
          throw stale();
        if (
          nativeFiles.get("rebase-merge/stopped-sha")?.bytes.toString() !==
            `${lastStep!.source.oid}\n` ||
          nativeFiles.get("REBASE_HEAD")?.bytes.toString() !==
            `${lastStep!.source.oid}\n` ||
          nativeFiles.get("rebase-merge/git-rebase-todo")?.bytes.toString() !==
            s.todoLines
              .slice(s.steps.length)
              .map((l) => l + "\n")
              .join("") ||
          nativeFiles.get("rebase-merge/message")?.bytes.toString() !==
            lastStep!.source.message + "\n"
        )
          throw stale();
        const auto = nativeFiles.get("AUTO_MERGE")!.bytes.toString().trim();
        if (treeKey(await readTree(nc, auto)) !== treeKey(expectedTree))
          throw stale();
      } else if (
        stat(path.join(native, "rebase-merge")) ||
        (s.steps.length
          ? !!stat(path.join(native, "REBASE_HEAD"))
          : regular(path.join(native, "REBASE_HEAD"))?.bytes.toString() !==
            `${s.current.oid}\n`) ||
        (!s.steps.length && !!stat(path.join(native, "AUTO_MERGE"))) ||
        regular(path.join(native, "HEAD"))?.bytes.toString() !==
          `ref: ${ref}\n` ||
        regular(path.join(native, ref))?.bytes.toString() !== `${final.oid}\n`
      )
        throw stale();
      if (b.backend === "merge" && !conflict && s.steps.length) {
        const auto = regular(path.join(native, "AUTO_MERGE"))
          ?.bytes.toString()
          .trim();
        if (
          !auto ||
          treeKey(await readTree(nc, auto)) !== treeKey(expectedTree)
        )
          throw stale();
      }
      const readyIndex = regular(path.join(native, "index"))!;
      worktreeUpdated = true;
      journal();
      const sourceObjects = path.join(gd, "objects"),
        objectIdentity = directory(sourceObjects),
        newObjects: [string, Buffer][] = [];
      let objectBytes = 0;
      for (const prefix of readdirSync(path.join(native, "objects")).sort()) {
        if (prefix === "info") continue;
        if (!/^[a-f0-9]{2}$/.test(prefix)) throw stale();
        directory(path.join(native, "objects", prefix));
        for (const suffix of readdirSync(
          path.join(native, "objects", prefix),
        ).sort()) {
          if (!/^[a-f0-9]{38}$/.test(suffix) || newObjects.length >= 256)
            throw stale();
          const f = regular(
              path.join(native, "objects", prefix, suffix),
              2 * 1024 * 1024,
            )!,
            inflated = inflateSync(f.bytes, {
              maxOutputLength: 2 * 1024 * 1024,
            });
          const header = /^(blob|tree|commit) (0|[1-9][0-9]*)\0/.exec(
            inflated.toString("utf8", 0, 64),
          );
          if (
            createHash("sha1").update(inflated).digest("hex") !==
              prefix + suffix ||
            !header ||
            !Number.isSafeInteger(Number(header[2])) ||
            Number(header[2]) !== inflated.length - header[0].length
          )
            throw stale();
          objectBytes += f.bytes.length;
          if (objectBytes > 32 * 1024 * 1024) throw refuse();
          newObjects.push([`${prefix}/${suffix}`, f.bytes]);
        }
      }
      // No source object publication happens before the native outcome and owner
      // are proved. Every created loose object is independently counted.
      await guardOwner();
      unchanged();
      backupValid();
      guardWork(true);
      for (const [n, bytes] of newObjects) {
        unchanged();
        guardWork(true);
        if (directory(sourceObjects) !== objectIdentity) throw stale();
        const dest = path.join(sourceObjects, n),
          parent = path.dirname(dest);
        if (!stat(parent)) mkdirSync(parent, { mode: 0o755 });
        directory(parent);
        const old = regular(dest, 2 * 1024 * 1024);
        if (old) {
          if (!old.bytes.equals(bytes)) throw stale();
          continue;
        }
        create(dest, bytes, () => {
          publishedObjectCount++;
        });
        sync(parent);
        journal();
      }
      objectsPublished = true;
      sync(sourceObjects);
      journal();
      this.options.afterPublish?.("objects");
      await guardOwner();
      unchanged();
      backupValid();
      guardWork(true);
      replace("index", readyIndex.bytes);
      this.options.afterPublish?.("index");
      replace(
        "HEAD",
        Buffer.from(conflict ? `${final.oid}\n` : `ref: ${ref}\n`),
      );
      this.options.afterPublish?.("head");
      if (!conflict) {
        replace(ref, Buffer.from(`${final.oid}\n`));
        this.options.afterPublish?.("branch");
      }
      unchanged();
      backupValid();
      guardWork(true);
      const oldOperation = path.join(gd, operationName);
      if (directory(oldOperation) !== b.operationDirectory) throw stale();
      // Move the exact captured directory into recovery, not recursive deletion.
      renameSync(oldOperation, path.join(recovery, `retired-${operationName}`));
      removeOperation();
      journal();
      if (conflict) {
        const prepared = path.join(recovery, `next-${operationName}`);
        mkdirSync(prepared, { mode: 0o700 });
        for (const [n, f] of nativeFiles)
          if (n.startsWith(`${operationName}/`))
            create(
              path.join(prepared, n.slice(operationName.length + 1)),
              f.bytes,
            );
        sync(prepared);
        unchanged();
        renameSync(prepared, oldOperation);
        expectedMetadata.set(oldOperation, directory(oldOperation));
        for (const [n, f] of nativeFiles)
          if (n.startsWith(`${operationName}/`)) {
            if (!regular(path.join(gd, n))?.bytes.equals(f.bytes))
              throw stale();
            updateFile(n);
          }
        journal();
      }
      for (const n of topFiles) {
        unchanged();
        backupValid();
        guardWork(true);
        if (conflict) {
          const candidate = path.join(recovery, `op-${randomUUID()}`);
          create(candidate, nativeFiles.get(n)!.bytes);
          renameSync(candidate, path.join(gd, n));
        } else unlinkSync(path.join(gd, n));
        updateFile(n);
        journal();
      }
      metadataPublished = true;
      metadataCleared = !conflict;
      sync(gd);
      journal();
      this.options.afterPublish?.("metadata");
      await guardOwner(conflict ? "next" : "finish");
      unchanged();
      backupValid();
      guardWork(true);
      if (conflict)
        await readRebaseBinding(
          { path: c.root, gitCommonDir: gd, branch: b.branch },
          async (a) => (await c.isolatedGit(args(c.root, a))).stdout,
        );
      else if (
        regular(path.join(gd, "HEAD"))?.bytes.toString() !== `ref: ${ref}\n` ||
        regular(path.join(gd, ref))?.bytes.toString() !== `${final.oid}\n`
      )
        throw stale();
      unchanged();
      backupValid();
      guardWork(true);
      status = conflict ? "conflict" : "success";
      message = conflict
        ? "Продолжение остановлено на следующем конфликте в том же rebase. Обновите resolver; публикации на сервер нет."
        : "Rebase завершён native Git; исходные author/message сохранены. Посторонние файлы не изменены; публикации на сервер нет.";
      journal();
    } catch (e) {
      status = mutationStarted ? "uncertain" : "error";
      message = mutationStarted
        ? "Продолжение частично выполнено или итог не подтверждён. Не повторяйте автоматически; исходные данные, журнал и принадлежащие операции блокировки оставлены. Отката поверх правок нет."
        : "Продолжение не начато; исходные данные не опубликованы.";
      log += `\n${e instanceof Error ? e.message : String(e)}`;
      try {
        if (recoveryIdentity && nativeIdentity) journal();
      } catch {}
    }
    if (status === "success" || status === "conflict" || !mutationStarted) {
      for (const [n, id] of [...locks].reverse()) {
        try {
          this.options.releaseLockFault?.(n, "before");
          if (lockId(n) !== id) throw stale();
          unlinkSync(path.join(gd, n));
          locks.delete(n);
          this.options.releaseLockFault?.(n, "after");
          sync(path.dirname(path.join(gd, n)));
        } catch (e) {
          status = mutationStarted ? "uncertain" : "error";
          log += `\n${String(e)}`;
          message =
            "Снятие блокировки не подтверждено; не повторяйте автоматически.";
          try {
            if (lockId(n) !== id) locks.delete(n);
          } catch {
            locks.delete(n);
            unchecked.add(n);
          }
        }
      }
    }
    for (const [n, id] of [...locks])
      try {
        if (lockId(n) !== id) locks.delete(n);
      } catch {
        locks.delete(n);
        unchecked.add(n);
      }
    try {
      if (recoveryIdentity && nativeIdentity) journal();
    } catch (e) {
      if (status === "success" || status === "conflict") status = "uncertain";
      message =
        "Финальный журнал операции не подтверждён; итог неопределён. Не повторяйте автоматически.";
      log += `\n${String(e)}`;
    }
    let recoveryStatus: GitRebaseOperationResult["recoveryStatus"] =
      "not-created";
    if (recoveryCreated) {
      try {
        if (!stat(recovery)) recoveryStatus = "missing";
        else {
          backupValid();
          if (!regular(path.join(recovery, "journal.json"))) throw stale();
          recoveryStatus = "retained";
        }
      } catch {
        recoveryStatus = "unverified";
      }
    }
    if (recoveryStatus === "missing" || recoveryStatus === "unverified") {
      status = mutationStarted ? "uncertain" : "error";
      message =
        "Материалы восстановления отсутствуют или не подтверждены. Автоматически не повторяйте.";
    }
    return {
      ...facts(),
      recoveryStatus,
      ...(recoveryCreated ? { lastKnownRecoveryPath: recovery } : {}),
      ...(recoveryStatus === "retained" ? { recoveryPath: recovery } : {}),
    };
  }
}
