import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  fstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
} from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import {
  gitSequencerOperationRequestSchema,
  gitSequencerOperationTokenSchema,
  type GitSequencerOperationRequest,
  type GitSequencerOperationPreview,
  type GitSequencerOperationResult,
} from "../shared/git-sequencer-operations";
import type { ScopeRef } from "../shared/context";
import {
  directory,
  regular,
  stat,
  stale,
  hash,
  type File,
} from "./git-conflict-state";
import {
  args,
  raw,
  rawKey,
  assertPaths,
  matches,
  readTree,
} from "./git-rebase-operations-state";
import { sourceCommit, treeKey, stageText } from "./git-rebase-continue-state";
import { planSequencer, type SequencerPlan } from "./git-sequencer-plan";
import {
  readSequencerMetadata,
  quoteSequencerPath,
  type GitSequencerContext,
} from "./git-sequencer-state";
import { CommandExitError } from "./process";
import { sanitizeRepositoryLog } from "./repository-actions";
export interface SequencerOptions {
  context: <T>(
    scope: ScopeRef,
    fn: (c: GitSequencerContext) => Promise<T>,
  ) => Promise<T>;
  now?: () => number;
  beforeNative?: () => void;
  afterNative?: () => void;
  afterPublish?: (step: "objects" | "index" | "branch" | "metadata") => void;
  releaseLockFault?: (name: string, phase: "before" | "after") => void;
}
const TTL = 300000;
function sync(dir: string) {
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
function create(p: string, b: Buffer | string, settled?: (fd: number) => void) {
  const fd = openSync(
    p,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, b);
    fsyncSync(fd);
  } finally {
    try {
      settled?.(fd);
    } finally {
      closeSync(fd);
    }
  }
}
const alternate = (p: string) =>
  `"${[...Buffer.from(p)].map((b) => (b === 34 || b === 92 ? "\\" + String.fromCharCode(b) : b < 32 || b >= 127 ? "\\" + b.toString(8).padStart(3, "0") : String.fromCharCode(b))).join("")}"\n`;
interface Ticket {
  request: GitSequencerOperationRequest;
  preview: GitSequencerOperationPreview;
  key: string;
}
/** Operation-specific native sequencer transaction. Private Git metadata is not
 * a clone: objects are read through an alternate, writes remain private until
 * independently verified. Never auto-roll back uncertain live worktree writes. */
export class GitSequencerOperations {
  private tickets = new Map<string, Ticket>();
  constructor(private options: SequencerOptions) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  async prepare(
    input: GitSequencerOperationRequest,
  ): Promise<GitSequencerOperationPreview> {
    const request = gitSequencerOperationRequestSchema.parse(input);
    return this.options.context(request.scope, async (c) => {
      const plan = await planSequencer(c, request),
        s = plan.state;
      const preview: GitSequencerOperationPreview = {
        token: randomBytes(32).toString("hex"),
        scope: structuredClone(c.scope),
        root: c.root,
        operation: s.operation,
        action: request.action,
        branch: s.branch,
        head: s.head,
        original: s.original,
        current: s.current.oid,
        paths: Object.keys(plan.tree).sort(),
        discardedResolutionPaths: s.discardedResolutionPaths,
        hooks: "disabled",
        expiresAt: this.now() + TTL,
        requiresCommitWarning:
          s.requiresCommitWarning && request.action === "continue",
        effects:
          request.action === "continue"
            ? `Продолжить ${s.operation} до следующего конфликта или конца последовательности. Будут созданы коммиты. Hooks и редактор отключены; публикации на сервер нет. Исходные reflog не обновляются.`
            : `Отменить ${s.operation} и восстановить указанную исходную точку. Решения конфликтов будут удалены; посторонние файлы сохраняются. Hooks отключены; публикации на сервер нет. Исходные reflog не обновляются.`,
      };
      for (const [token, t] of this.tickets)
        if (t.preview.expiresAt <= this.now()) this.tickets.delete(token);
      while (this.tickets.size >= 8)
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(preview.token, {
        request: structuredClone(request),
        preview: structuredClone(preview),
        key: plan.key,
      });
      return preview;
    });
  }
  async execute(input: string): Promise<GitSequencerOperationResult> {
    const token = gitSequencerOperationTokenSchema.parse(input),
      t = this.tickets.get(token);
    this.tickets.delete(token);
    if (!t || t.preview.expiresAt <= this.now())
      throw Error("Подтверждение истекло или уже использовано.");
    return this.options.context(t.request.scope, async (c) => {
      const p = await planSequencer(c, t.request);
      if (p.key !== t.key || t.preview.expiresAt <= this.now()) throw stale();
      return this.perform(c, t, p);
    });
  }
  private async perform(
    c: GitSequencerContext,
    t: Ticket,
    p: SequencerPlan,
  ): Promise<GitSequencerOperationResult> {
    const s = p.state,
      gd = path.join(c.root, ".git"),
      ref = `refs/heads/${s.branch}`,
      recovery = path.join(gd, `goga-sequencer-${randomUUID()}`),
      native = path.join(recovery, "native");
    const locks = new Map<string, string>(),
      unchecked = new Set<string>(),
      backups = new Map<string, Buffer>(),
      backupFiles = new Map<string, string>(),
      backupDirectories = new Map<string, string>();
    const expected = new Map<string, string>(JSON.parse(s.disk.metadata));
    let recoveryId = "",
      created = false,
      candidateKey = "",
      readyIndex: File | undefined,
      finalHead = s.head;
    let status: GitSequencerOperationResult["status"] = "error",
      message = "Операция не выполнялась.",
      log = "";
    const facts = {
      mutationStarted: false,
      worktreeRestored: false,
      worktreeUpdated: false,
      indexPublished: false,
      branchPublished: false,
      metadataCleared: false,
      metadataPublished: false,
      objectsPublished: false,
      publishedObjectCount: 0,
    };
    const guardOwner = () => {
      if (
        c.root !== s.root ||
        c.ownerKey !== s.owner ||
        JSON.stringify(c.scope) !== s.scope
      )
        throw stale();
      c.assertPublicationOwner?.();
    };
    const guardBackups = () => {
      for (const [name, id] of backupDirectories)
        if (directory(name) !== id) throw stale();
      for (const [name, id] of backupFiles)
        if (regular(name)?.identity !== id) throw stale();
    };
    const guardRecovery = () => {
      guardOwner();
      assertPaths(s.disk);
      if (directory(recovery) !== recoveryId) throw stale();
      guardBackups();
    };
    const lockId = (n: string) => regular(path.join(gd, n))?.identity;
    const guardLocks = () => {
      for (const [n, id] of locks) if (lockId(n) !== id) throw stale();
    };
    const metadataEqual = (value: string) => {
      const actual = new Map<string, string>(JSON.parse(value));
      return (
        actual.size === expected.size &&
        [...expected].every(([n, id]) => actual.get(n) === id)
      );
    };
    const guardMetadata = () => {
      if (!metadataEqual(raw(c.root, [...locks.keys()]).metadata))
        throw stale();
    };
    const guardWork = () => {
      const a = raw(c.root, [...locks.keys()]);
      const tree = facts.mutationStarted ? p.tree : null;
      if (!tree) {
        if (rawKey(a) !== rawKey(s.disk)) throw stale();
        return;
      }
      const names = new Set([
        ...Object.keys(tree),
        ...Object.keys(s.disk.files).filter((n) => !s.auto[n]),
      ]);
      if (names.size !== Object.keys(a.files).length) throw stale();
      for (const n of names)
        if (
          tree[n]
            ? !matches(a.files[n], tree[n])
            : a.files[n]?.identity !== s.disk.files[n]?.identity
        )
          throw stale();
    };
    const privateKey = () => {
      const rows: unknown[] = [];
      let count = 0,
        total = 0;
      const visit = (file: string, depth: number) => {
        if (++count > 20000 || depth > 32) throw stale();
        const info = stat(file);
        if (!info) throw stale();
        if (info.isDirectory()) {
          rows.push([file, directory(file)]);
          for (const n of readdirSync(file).sort())
            if (!(file === recovery && n === "journal.json"))
              visit(path.join(file, n), depth + 1);
        } else {
          const f = regular(file)!;
          total += f.bytes.length;
          if (total > 160 * 1024 * 1024) throw stale();
          rows.push([file, f.identity]);
        }
      };
      visit(recovery, 0);
      return hash(JSON.stringify(rows));
    };
    const journal = () => {
      guardRecovery();
      const file = path.join(recovery, `journal-${randomUUID()}`);
      create(
        file,
        JSON.stringify(
          {
            version: 1,
            kind: "native-sequencer",
            operation: s.operation,
            action: s.action,
            root: s.root,
            ownerHash: hash(s.owner),
            scope: t.request.scope,
            branch: s.branch,
            head: s.head,
            original: s.original,
            status,
            ...facts,
            retainedLocks: [...locks.keys()],
          },
          null,
          2,
        ),
      );
      renameSync(file, path.join(recovery, "journal.json"));
      sync(recovery);
    };
    const syncGuard = () => {
      guardRecovery();
      guardLocks();
      guardMetadata();
      guardWork();
      if (candidateKey && privateKey() !== candidateKey) throw stale();
      if (
        readyIndex &&
        facts.indexPublished &&
        !regular(path.join(gd, "index"))?.bytes.equals(readyIndex.bytes)
      )
        throw stale();
    };
    const guarded = async () => {
      await c.verifyOwner();
      syncGuard();
    };
    const backup = (name: string, bytes: Buffer) => {
      const file = path.join(recovery, "backup", name);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      create(file, bytes);
      backups.set(name, bytes);
      backupFiles.set(file, regular(file)!.identity);
      let parent = path.dirname(file);
      while (parent !== recovery) {
        backupDirectories.set(parent, directory(parent));
        parent = path.dirname(parent);
      }
    };
    const updateExpected = (name: string, bytes: Buffer | string) => {
      const f = regular(path.join(gd, name));
      if (!f?.bytes.equals(Buffer.from(bytes))) throw stale();
      expected.set(path.join(gd, name), f.identity);
    };
    const put = (name: string, bytes: Buffer) => {
      syncGuard();
      const candidate = path.join(recovery, `publish-${randomUUID()}`);
      create(candidate, bytes);
      candidateKey = "";
      syncGuard();
      renameSync(candidate, path.join(gd, name));
      updateExpected(name, bytes);
      sync(path.dirname(path.join(gd, name)));
      candidateKey = privateKey();
    };
    try {
      guardOwner();
      assertPaths(s.disk);
      mkdirSync(recovery, { mode: 0o700 });
      created = true;
      recoveryId = directory(recovery);
      mkdirSync(native, { mode: 0o700 });
      for (const n of ["objects", "objects/info", "refs", "refs/heads"])
        mkdirSync(path.join(native, n), { mode: 0o700 });
      mkdirSync(path.dirname(path.join(native, ref)), {
        recursive: true,
        mode: 0o700,
      });
      if (s.metadata.directoryIdentity)
        mkdirSync(path.join(native, "sequencer"), { mode: 0o700 });
      backup("index", s.disk.index.bytes);
      backup("HEAD", s.metadata.files.HEAD.bytes);
      backup("owner-ref", Buffer.from(s.head + "\n"));
      for (const [n, f] of Object.entries(s.metadata.files))
        backup(`metadata/${n}`, f.bytes);
      for (const n of Object.keys(s.auto))
        backup(`work/${n}`, s.disk.files[n].bytes);
      const originalOrig = regular(path.join(gd, "ORIG_HEAD"));
      if (originalOrig) backup("ORIG_HEAD", originalOrig.bytes);
      create(path.join(native, "config"), p.config);
      create(
        path.join(native, "objects/info/alternates"),
        alternate(path.join(gd, "objects")),
      );
      create(path.join(native, ref), s.head + "\n");
      create(path.join(native, "index"), s.disk.index.bytes);
      for (const [n, f] of Object.entries(s.metadata.files))
        create(path.join(native, n), f.bytes);
      if (originalOrig)
        create(path.join(native, "ORIG_HEAD"), originalOrig.bytes);
      for (const [n, value] of [
        ["config.lock", regular(path.join(gd, "config"))!.bytes],
        [
          "packed-refs.lock",
          regular(path.join(gd, "packed-refs"))?.bytes ?? Buffer.alloc(0),
        ],
        ["HEAD.lock", s.metadata.files.HEAD.bytes],
        [ref + ".lock", s.head + "\n"],
        ["index.lock", s.disk.index.bytes],
      ] as const) {
        guardOwner();
        assertPaths(s.disk);
        create(path.join(gd, n), value, (fd) => {
          try {
            const held = fstatSync(fd, { bigint: true }),
              stamp = [
                held.dev,
                held.ino,
                held.mode,
                held.size,
                held.mtimeNs,
                held.ctimeNs,
              ].join(":"),
              f = regular(path.join(gd, n)),
              intended = Buffer.from(value);
            if (
              !f?.identity.startsWith(stamp + ":") ||
              f.bytes.length > intended.length ||
              !f.bytes.equals(intended.subarray(0, f.bytes.length))
            )
              throw stale();
            locks.set(n, f.identity);
          } catch (e) {
            unchecked.add(n);
            throw e;
          }
        });
        sync(path.dirname(path.join(gd, n)));
      }
      journal();
      sync(gd);
      candidateKey = privateKey();
      await guarded();
      this.options.beforeNative?.();
      await guarded();
      if (this.now() >= t.preview.expiresAt) throw stale();
      facts.mutationStarted = true;
      journal();
      if (privateKey() !== candidateKey) throw stale();
      let nativeError: unknown;
      try {
        const out = await c.isolatedGit(
          args(c.root, [s.operation, "--" + s.action], native),
        );
        log += out.stdout + out.stderr;
      } catch (e) {
        nativeError = e;
        const out = e as { stdout?: string; stderr?: string };
        log += (out.stdout ?? "") + (out.stderr ?? "");
      }
      this.options.afterNative?.();
      candidateKey = "";
      if (
        nativeError &&
        (!(nativeError instanceof CommandExitError) ||
          nativeError.exitCode === null)
      )
        throw nativeError;
      guardRecovery();
      guardLocks();
      guardMetadata();
      guardWork();
      if (regular(path.join(gd, "index"))?.identity !== s.disk.index.identity)
        throw stale();
      if (
        !regular(path.join(native, "config"))?.bytes.equals(
          Buffer.from(p.config),
        ) ||
        !regular(path.join(native, "objects/info/alternates"))?.bytes.equals(
          Buffer.from(alternate(path.join(gd, "objects"))),
        )
      )
        throw stale();
      const nc: GitSequencerContext = {
        ...c,
        isolatedGit: (a) =>
          c.isolatedGit(
            a.map((v) => (v === `--git-dir=${gd}` ? `--git-dir=${native}` : v)),
          ),
      };
      const git = async (a: string[]) =>
        (await nc.isolatedGit(args(c.root, a))).stdout;
      if (
        regular(path.join(native, "HEAD"))?.bytes.toString() !== `ref: ${ref}\n`
      )
        throw stale();
      finalHead = (await git(["rev-parse", "--verify", ref])).trim();
      const nextFiles = new Map<string, Buffer>();
      if (s.action === "abort") {
        if (
          nativeError ||
          finalHead !== s.original ||
          regular(path.join(native, "ORIG_HEAD"))?.bytes.toString() !==
            s.head + "\n"
        )
          throw nativeError ?? stale();
        nextFiles.set("ORIG_HEAD", Buffer.from(s.head + "\n"));
      } else {
        const ids = (
          await git(["rev-list", "--reverse", `${s.head}..${finalHead}`])
        )
          .trim()
          .split("\n")
          .filter(Boolean);
        if (ids.length !== p.commits.length) throw stale();
        let parent = s.head;
        for (const [i, id] of ids.entries()) {
          const actual = await sourceCommit(nc, id),
            expected = p.commits[i];
          const subject = (
            await git(["show", "-s", "--format=%s", expected.source.oid])
          ).replace(/\n$/, "");
          const message =
            s.operation === "cherry-pick"
              ? expected.source.message
              : `Revert "${subject}"\n\nThis reverts commit ${expected.source.oid}.\n`;
          if (
            actual.parent !== parent ||
            actual.message !== message ||
            treeKey(actual.tree) !== treeKey(expected.tree) ||
            (s.operation === "cherry-pick"
              ? actual.author !== expected.source.author
              : !actual.author.startsWith("author " + p.committer + " "))
          )
            throw stale();
          const rawCommit = await git(["cat-file", "commit", id]);
          if (
            !rawCommit
              .split("\n")
              .some((l) => l.startsWith("committer " + p.committer + " "))
          )
            throw stale();
          parent = id;
        }
        const currentOrig = regular(path.join(native, "ORIG_HEAD"));
        if (
          originalOrig
            ? !currentOrig?.bytes.equals(originalOrig.bytes)
            : !!currentOrig
        )
          throw stale();
      }
      for (const n of [
        "rebase-merge",
        "rebase-apply",
        "REBASE_HEAD",
        "MERGE_HEAD",
        "MERGE_MODE",
        "BISECT_START",
        s.operation === "revert" ? "CHERRY_PICK_HEAD" : "REVERT_HEAD",
      ])
        if (stat(path.join(native, n))) throw stale();
      if (p.next) {
        if (
          !(nativeError instanceof CommandExitError) ||
          nativeError.exitCode !== 1
        )
          throw stale();
        const op = readSequencerMetadata(c.root, s.operation, native);
        if (
          op.branch !== s.branch ||
          op.stopped !== p.next.source.oid ||
          op.original !== s.original ||
          op.safety !== finalHead ||
          op.todo.length !== p.next.remaining.length ||
          treeKey(await readTree(nc, op.auto)) !== treeKey(p.tree)
        )
          throw stale();
        for (const [i, row] of op.todo.entries())
          if (
            (
              await git(["rev-parse", "--verify", `${row.short}^{commit}`])
            ).trim() !== p.next.remaining[i].oid ||
            row.subject !==
              (
                await git([
                  "show",
                  "-s",
                  "--format=%s",
                  p.next.remaining[i].oid,
                ])
              ).replace(/\n$/, "")
          )
            throw stale();
        // Read-only admission's canonical message proof is reused without treating
        // its source-root snapshot as authority for candidate metadata.
        const subject = (
          await git(["show", "-s", "--format=%s", p.next.source.oid])
        ).replace(/\n$/, "");
        const message =
          (s.operation === "cherry-pick"
            ? p.next.source.message
            : `Revert "${subject}"\n\nThis reverts commit ${p.next.source.oid}.\n`) +
          `\n# Conflicts:\n${Object.keys(p.next.proof.conflicts)
            .sort()
            .map((n) => "#\t" + quoteSequencerPath(n) + "\n")
            .join("")}`;
        if (op.files.MERGE_MSG.bytes.toString() !== message) throw stale();
        for (const [n, f] of Object.entries(op.files))
          if (n !== "HEAD") nextFiles.set(n, f.bytes);
      } else {
        if (nativeError) throw nativeError;
        for (const n of [
          "sequencer",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "MERGE_MSG",
        ])
          if (stat(path.join(native, n))) throw stale();
        const auto = regular(path.join(native, "AUTO_MERGE"));
        if (auto) {
          if (
            s.action === "abort" ||
            treeKey(await readTree(nc, auto.bytes.toString().trim())) !==
              treeKey(p.tree)
          )
            throw stale();
          nextFiles.set("AUTO_MERGE", auto.bytes);
        }
      }
      if (
        (await git(["ls-files", "--stage", "-z"])) !==
        stageText(p.tree, p.next?.proof.conflicts)
      )
        throw stale();
      readyIndex = regular(path.join(native, "index")) ?? undefined;
      if (!readyIndex) throw stale();
      const objects: { name: string; file: File }[] = [];
      let objectBytes = 0;
      for (const prefix of readdirSync(path.join(native, "objects"))) {
        if (prefix === "info") {
          if (
            readdirSync(path.join(native, "objects/info")).join() !==
            "alternates"
          )
            throw stale();
          continue;
        }
        if (prefix === "pack") {
          if (readdirSync(path.join(native, "objects/pack")).length)
            throw stale();
          continue;
        }
        if (!/^[a-f0-9]{2}$/.test(prefix)) throw stale();
        directory(path.join(native, "objects", prefix));
        for (const suffix of readdirSync(
          path.join(native, "objects", prefix),
        )) {
          if (!/^[a-f0-9]{38}$/.test(suffix) || objects.length >= 256)
            throw stale();
          const file = regular(
            path.join(native, "objects", prefix, suffix),
            2 * 1024 * 1024,
          )!;
          const b = inflateSync(file.bytes, {
            maxOutputLength: 2 * 1024 * 1024,
          });
          objectBytes += b.length;
          if (
            objectBytes > 32 * 1024 * 1024 ||
            createHash("sha1").update(b).digest("hex") !== prefix + suffix ||
            !/^(blob|tree|commit) [0-9]+\0/.test(b.toString("utf8", 0, 50))
          )
            throw stale();
          objects.push({ name: prefix + "/" + suffix, file });
        }
      }
      if (s.action === "abort" && objects.length) throw stale();
      facts.worktreeRestored = s.action === "abort";
      facts.worktreeUpdated = s.action === "continue";
      journal();
      candidateKey = privateKey();
      await guarded();
      for (const object of objects) {
        await guarded();
        const parent = path.join(gd, "objects", path.dirname(object.name));
        directory(path.join(gd, "objects"));
        if (!stat(parent)) mkdirSync(parent, { mode: 0o700 });
        directory(parent);
        const destination = path.join(gd, "objects", object.name),
          existing = regular(destination, 2 * 1024 * 1024);
        if (existing) {
          const b = inflateSync(existing.bytes, {
            maxOutputLength: 2 * 1024 * 1024,
          });
          if (
            createHash("sha1").update(b).digest("hex") !==
            object.name.replace("/", "")
          )
            throw stale();
        } else {
          create(destination, object.file.bytes, () => {
            facts.publishedObjectCount++;
          });
          sync(parent);
        }
      }
      facts.objectsPublished = s.action === "continue";
      journal();
      this.options.afterPublish?.("objects");
      await guarded();
      const replaceLock = (name: string, bytes: Buffer) => {
        syncGuard();
        const candidate = path.join(recovery, `ready-${randomUUID()}`);
        create(candidate, bytes);
        candidateKey = "";
        syncGuard();
        renameSync(candidate, path.join(gd, name));
        locks.set(name, lockId(name)!);
        candidateKey = privateKey();
      };
      replaceLock("index.lock", readyIndex.bytes);
      syncGuard();
      renameSync(path.join(gd, "index.lock"), path.join(gd, "index"));
      locks.delete("index.lock");
      facts.indexPublished = true;
      sync(gd);
      journal();
      this.options.afterPublish?.("index");
      await guarded();
      replaceLock(ref + ".lock", Buffer.from(finalHead + "\n"));
      syncGuard();
      renameSync(path.join(gd, ref + ".lock"), path.join(gd, ref));
      locks.delete(ref + ".lock");
      facts.branchPublished = true;
      updateExpected(ref, finalHead + "\n");
      sync(path.dirname(path.join(gd, ref)));
      journal();
      this.options.afterPublish?.("branch");
      await guarded();
      const captured = Object.keys(s.metadata.files).filter(
        (n) => n !== "HEAD",
      );
      for (const n of captured) {
        await guarded();
        if (nextFiles.has(n)) {
          put(n, nextFiles.get(n)!);
          nextFiles.delete(n);
        } else {
          syncGuard();
          unlinkSync(path.join(gd, n));
          if (n.startsWith("sequencer/")) expected.delete(path.join(gd, n));
          else expected.set(path.join(gd, n), "missing");
          sync(path.dirname(path.join(gd, n)));
        }
      }
      if (s.metadata.directoryIdentity && !p.next) {
        await guarded();
        if (
          directory(path.join(gd, "sequencer")) !==
            s.metadata.directoryIdentity ||
          readdirSync(path.join(gd, "sequencer")).length
        )
          throw stale();
        rmdirSync(path.join(gd, "sequencer"));
        expected.set(path.join(gd, "sequencer"), "missing");
        sync(gd);
      }
      for (const [n, bytes] of nextFiles) {
        await guarded();
        put(n, bytes);
      }
      facts.metadataCleared = !p.next;
      facts.metadataPublished = true;
      journal();
      this.options.afterPublish?.("metadata");
      await guarded();
      if (
        regular(path.join(gd, "HEAD"))?.bytes.toString() !== `ref: ${ref}\n` ||
        regular(path.join(gd, ref))?.bytes.toString() !== finalHead + "\n"
      )
        throw stale();
      status = p.next ? "conflict" : "success";
      message = p.next
        ? "Операция продолжена до следующего конфликта. Разрешите его и подтвердите продолжение."
        : s.action === "abort"
          ? `${s.operation} отменён. Исходное состояние восстановлено; посторонние файлы сохранены.`
          : `${s.operation} завершён. Коммиты созданы; публикации на сервер не было.`;
      journal();
    } catch (e) {
      status = facts.mutationStarted ? "uncertain" : "error";
      message = facts.mutationStarted
        ? "Операция выполнена частично или итог не подтверждён. Не повторяйте автоматически: проверьте журнал и материалы восстановления."
        : "Операция не начата; ветка, индекс и рабочие файлы не опубликованы.";
      log += "\n" + (e instanceof Error ? e.message : String(e));
      try {
        if (recoveryId) journal();
      } catch {}
    }
    if (
      status === "success" ||
      status === "conflict" ||
      !facts.mutationStarted
    ) {
      for (const [n, id] of [...locks].reverse()) {
        try {
          this.options.releaseLockFault?.(n, "before");
          if (lockId(n) !== id) throw stale();
          unlinkSync(path.join(gd, n));
          locks.delete(n);
          this.options.releaseLockFault?.(n, "after");
          sync(path.dirname(path.join(gd, n)));
        } catch (e) {
          status = facts.mutationStarted ? "uncertain" : "error";
          message =
            "Снятие блокировки не подтверждено; автоматически не повторяйте операцию.";
          log += "\n" + String(e);
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
      if (recoveryId) journal();
    } catch (e) {
      log += "\n" + String(e);
      if (status === "success" || status === "conflict") {
        status = "uncertain";
        message =
          "Финальная запись журнала не подтверждена; проверьте состояние.";
      }
    }
    let recoveryStatus: GitSequencerOperationResult["recoveryStatus"] =
      "not-created";
    if (created) {
      try {
        if (!stat(recovery)) recoveryStatus = "missing";
        else {
          recoveryStatus = "unverified";
          guardBackups();
          if (
            directory(recovery) === recoveryId &&
            regular(path.join(recovery, "journal.json")) &&
            [...backups].every(([n, b]) => {
              let parent = path.join(recovery, "backup");
              directory(parent);
              for (const part of n.split("/").slice(0, -1)) {
                parent = path.join(parent, part);
                directory(parent);
              }
              return regular(path.join(recovery, "backup", n))?.bytes.equals(b);
            })
          )
            recoveryStatus = "retained";
        }
      } catch {
        recoveryStatus = "unverified";
      }
    }
    if (recoveryStatus === "missing" || recoveryStatus === "unverified") {
      status = facts.mutationStarted ? "uncertain" : "error";
      message =
        "Сохранность материалов восстановления не подтверждена. Автоматически не повторяйте.";
    }
    return {
      scope: t.request.scope,
      operation: s.operation,
      action: s.action,
      status,
      changed: facts.mutationStarted || facts.publishedObjectCount > 0,
      ...facts,
      recoveryStatus,
      ...(created ? { lastKnownRecoveryPath: recovery } : {}),
      ...(recoveryStatus === "retained" ? { recoveryPath: recovery } : {}),
      lockRetained: locks.size > 0,
      retainedLocks: [...locks.keys()],
      uncheckedLocks: [...unchecked],
      message: sanitizeRepositoryLog(message),
      log: sanitizeRepositoryLog(log),
    };
  }
}
