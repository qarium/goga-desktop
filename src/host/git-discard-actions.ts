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
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import type { ScopeRef } from "../shared/context";
import {
  gitDiscardRequestSchema,
  gitDiscardTokenSchema,
  type GitDiscardRequest,
  type GitDiscardPreview,
  type GitDiscardResult,
} from "../shared/git-discard";
import { gitFilePathSchema } from "../shared/git-workspace";
import type { GitCommitContext } from "./git-workspace-actions";
import {
  safe,
  hash,
  stat,
  regular,
  directory,
  parents,
  assertParents,
  metadata,
  identity,
  policy,
  assertPolicySupported,
  type File,
  type Policy,
} from "./git-conflict-state";

const FILE_LIMIT = 8 * 1024 * 1024,
  TOTAL_LIMIT = 32 * 1024 * 1024,
  TTL = 5 * 60 * 1000;
// Over-conservative Unicode/case collision key; never used to access a path.
const collisionKey = (name: string) =>
  name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
const stale = () =>
  Error(
    "Предпросмотр отката Git устарел или изменился владелец. Обновите список и подтвердите заново.",
  );
interface Entry {
  mode: string;
  oid: string;
}
interface State {
  root: string;
  owner: string;
  scope: string;
  head: string;
  branch: string | null;
  parents: [string, string][];
  metadata: string;
  attributes: [string, string][];
  index: File;
  work: Map<string, File | null>;
  policies: Map<string, Policy>;
  entries: Map<string, Entry>;
}
interface Ticket {
  preview: GitDiscardPreview;
  fingerprint: string;
}
function fingerprint(s: State) {
  return hash(
    JSON.stringify({
      root: s.root,
      owner: s.owner,
      scope: s.scope,
      head: s.head,
      branch: s.branch,
      parents: s.parents,
      metadata: s.metadata,
      attributes: s.attributes,
      index: s.index.identity,
      work: [...s.work].map(([n, f]) => [n, f?.identity ?? "missing"]),
      policies: [...s.policies],
      entries: [...s.entries],
    }),
  );
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
    fchmodSync(fd, mode);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Refuse indirections before Git can follow them. This feature deliberately does
 * not support linked worktrees, split/sparse indexes, gitlinks or symlinks. */
function audit(root: string) {
  directory(root);
  const gd = path.join(root, ".git");
  directory(gd);
  for (const name of [
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "info/sparse-checkout",
  ])
    if (stat(path.join(gd, name)))
      throw Error(
        "Внешнее хранилище или sparse checkout Git не поддерживается безопасным откатом.",
      );
  if (readdirSync(gd).some((n) => n.toLowerCase().startsWith("sharedindex.")))
    throw Error("Split-index Git не поддерживается безопасным откатом.");
  for (const name of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "REBASE_HEAD",
    "rebase-merge",
    "rebase-apply",
    "sequencer",
  ])
    if (stat(path.join(gd, name)))
      throw Error(
        "Сначала завершите текущую операцию Git: откат выбранных файлов сейчас недоступен.",
      );
  let count = 0;
  const visit = (filename: string, depth: number) => {
    if (++count > 100000 || depth > 16)
      throw Error("Слишком много метаданных Git.");
    const s = stat(filename);
    if (!s) return;
    if (
      s.isSymbolicLink() ||
      (!s.isDirectory() && (!s.isFile() || s.nlink !== 1n))
    )
      throw Error("Небезопасная ссылка в метаданных Git.");
    if (s.isDirectory()) {
      directory(filename);
      for (const n of readdirSync(filename))
        visit(path.join(filename, n), depth + 1);
    }
  };
  directory(path.join(gd, "objects"));
  visit(path.join(gd, "objects"), 0);
  visit(path.join(gd, "info"), 0);
}
function stableMetadata(root: string) {
  // Native read-only HEAD transactions add transient ref lock files. These are
  // locks, not repository state; HEAD/ref contents remain pinned independently.
  const rows: [string, string][] = JSON.parse(metadata(root));
  const refs = path.join(root, ".git/refs") + path.sep;
  return JSON.stringify(
    rows.filter(([name]) => !(name.startsWith(refs) && name.endsWith(".lock"))),
  );
}
function assertRawRestore(p: Policy) {
  assertPolicySupported(p);
  // Raw object publication must never pretend to implement a checkout filter or
  // Git's platform-sensitive CRLF heuristics. Refuse any conversion ambiguity.
  if (
    p.values.text !== "unset" &&
    (p.autocrlf === "true" ||
      p.eol === "crlf" ||
      p.values.eol === "crlf" ||
      p.values.crlf === "set")
  )
    throw Error(
      "Откат с преобразованием CRLF пока не поддерживается. Файлы не изменены.",
    );
}

/** Whole selected files only. The host supplies owner validation, exclusive
 * lifecycle locking and offline Git. Not an atomic multi-file transaction: every
 * moved original and old index remain recoverable until final success verification. */
export class GitDiscardActions {
  private readonly tickets = new Map<string, Ticket>();
  constructor(
    private readonly options: {
      context: <T>(
        scope: ScopeRef,
        fn: (context: GitCommitContext) => Promise<T>,
      ) => Promise<T>;
      trashItem?: (path: string) => Promise<void>;
      now?: () => number;
      /** Synchronous host-only failure/race seams; never IPC inputs. */
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
  private disk(root: string, names: string[]) {
    const ps = new Map<string, string>(),
      attrs = new Map<string, string>(),
      work = new Map<string, File | null>();
    let total = 0;
    const inodes = new Set<string>(),
      normalizedPaths = new Set<string>();
    for (const name of names) {
      gitFilePathSchema.parse(name);
      // Conservative on every filesystem: absent endpoints have no inode to
      // compare, and macOS may fold Unicode normalization as well as case.
      // This is collision detection only, never path rewriting.
      const normalized = collisionKey(name);
      if (normalizedPaths.has(normalized))
        throw Error(
          "Выбранные пути совпадают после нормализации или изменения регистра; безопасный откат не поддерживается.",
        );
      normalizedPaths.add(normalized);
      let rows: [string, string][];
      try {
        rows = parents(root, name);
      } catch {
        throw Error(
          "Родительская папка отсутствует, заменена или содержит ссылку; безопасный откат недоступен.",
        );
      }
      for (const [p, id] of rows) ps.set(p, id);
      for (const [p] of rows.filter(([p]) => p !== path.join(root, ".git"))) {
        const attr = path.join(p, ".gitattributes");
        if (!attrs.has(attr))
          attrs.set(attr, regular(attr)?.identity ?? "missing");
      }
      const file = regular(path.join(root, name), FILE_LIMIT);
      if (file) {
        const inode = file.identity.split(":").slice(0, 2).join(":");
        if (inodes.has(inode))
          throw Error(
            "Выбранные пути указывают на один файл (переименование с изменением регистра); безопасный откат не поддерживается.",
          );
        inodes.add(inode);
      }
      work.set(name, file);
      total += file?.bytes.length ?? 0;
      if (total > TOTAL_LIMIT)
        throw Error(
          "Выбранные файлы превышают предел безопасного отката 32 МиБ.",
        );
    }
    const index = regular(path.join(root, ".git/index"));
    if (!index)
      throw Error("Индекс Git отсутствует; безопасный откат недоступен.");
    assertParents([...ps]);
    return {
      parents: [...ps] as [string, string][],
      attributes: [...attrs] as [string, string][],
      work,
      index,
      metadata: stableMetadata(root),
    };
  }
  private async capture(c: GitCommitContext, names: string[]): Promise<State> {
    await c.verify();
    audit(c.root);
    const root = c.root,
      owner = c.ownerKey,
      scope = JSON.stringify(c.scope),
      initial = this.disk(root, names);
    const rawHead =
      regular(path.join(root, ".git/HEAD"))?.bytes.toString("utf8") ?? "";
    const ref =
      /^ref: (refs\/heads\/[^\0\r\n]+)\n?$/.exec(rawHead)?.[1] ?? null;
    if (!ref && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})\n?$/.test(rawHead))
      throw stale();
    const branch = ref?.slice("refs/heads/".length) ?? null;
    if (typeof c.scope !== "string" && branch !== c.scope.branch) throw stale();
    const head = (
      await this.git(c, ["rev-parse", "--verify", "HEAD"])
    ).stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw stale();
    if (
      ref &&
      (await this.git(c, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trim() !==
        ref
    )
      throw stale();
    const selectedNames = new Map(
      names.map((name) => [collisionKey(name), name]),
    );
    // Also protect unselected entries: a case-colliding tree can exist even on
    // a filesystem unable to materialize both names. Never overwrite its alias.
    for (const args of [
      ["ls-files", "-z"],
      ["ls-tree", "-r", "--name-only", "-z", head],
    ]) {
      const inventory = (await this.git(c, args)).stdout;
      for (const name of inventory.split("\0").filter(Boolean)) {
        const selected = selectedNames.get(collisionKey(name));
        if (selected !== undefined && selected !== name)
          throw Error(
            "Выбранный путь совпадает с другим путём Git после нормализации или изменения регистра; откат не поддерживается.",
          );
      }
    }
    const entries = new Map<string, Entry>();
    const rows = (await this.git(c, ["ls-tree", "-z", head, "--", ...names]))
      .stdout;
    for (const row of rows.split("\0").filter(Boolean)) {
      const m =
        /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(
          row,
        );
      if (!m || !names.includes(m[3]) || entries.has(m[3]))
        throw Error(
          "Выбранная версия HEAD является ссылкой, подмодулем или каталогом; откат не поддерживается.",
        );
      entries.set(m[3], { mode: m[1], oid: m[2] });
    }
    const staged = (
      await this.git(c, ["ls-files", "--stage", "-z", "--", ...names])
    ).stdout;
    for (const row of staged.split("\0").filter(Boolean))
      if (!/^(100644|100755) [a-f0-9]{40,64} 0\t/.test(row))
        throw Error(
          "Конфликт, ссылка или подмодуль в индексе: откат не поддерживается.",
        );
    const flags = (await this.git(c, ["ls-files", "-v", "-z", "--", ...names]))
      .stdout;
    if (
      flags
        .split("\0")
        .filter(Boolean)
        .some((row) => !row.startsWith("H "))
    )
      throw Error(
        "Специальные флаги выбранного индекса Git не поддерживаются.",
      );
    const policies = new Map<string, Policy>();
    for (const name of names) {
      const p = await policy(c, name);
      if (entries.has(name)) assertRawRestore(p);
      policies.set(name, p);
    }
    await c.verify();
    audit(root);
    const final = this.disk(root, names);
    const state = {
      root,
      owner,
      scope,
      head,
      branch,
      entries,
      policies,
      ...initial,
    };
    if (
      c.root !== root ||
      c.ownerKey !== owner ||
      JSON.stringify(c.scope) !== scope ||
      fingerprint(state) !== fingerprint({ ...state, ...final })
    )
      throw stale();
    return state;
  }
  private async sources(c: GitCommitContext, s: State) {
    const result = new Map<string, Buffer>();
    let total = 0;
    for (const [name, e] of s.entries) {
      const size = (await this.git(c, ["cat-file", "-s", e.oid])).stdout;
      if (
        !/^(0|[1-9]\d*)\n$/.test(size) ||
        Number(size) > FILE_LIMIT ||
        (total += Number(size)) > TOTAL_LIMIT
      )
        throw Error(
          "Версии HEAD превышают безопасный предел размера (8 МиБ на файл, 32 МиБ всего).",
        );
      const bytes = Buffer.from(
        (await this.git(c, ["cat-file", "blob", e.oid])).stdout,
      );
      // String-only transport is acceptable only when it reproduces the exact
      // raw Git blob. NUL/binary UTF8 is safe; non-UTF8 is explicitly refused.
      if (
        bytes.length !== Number(size) ||
        identity(bytes, e.oid.length) !== e.oid
      )
        throw Error(
          "Версия HEAD содержит non-UTF8 байты; безопасный откат такого файла пока не поддерживается.",
        );
      result.set(name, bytes);
    }
    return result;
  }
  async prepare(input: GitDiscardRequest): Promise<GitDiscardPreview> {
    const req = gitDiscardRequestSchema.parse(input);
    return this.options.context(req.scope, async (c) => {
      const snapshot = await c.snapshot();
      if (
        snapshot.revision !== req.revision ||
        JSON.stringify(snapshot.scope) !== JSON.stringify(req.scope)
      )
        throw stale();
      if (!snapshot.head)
        throw Error(
          "В репозитории ещё нет HEAD (первого коммита); откат выбранных файлов пока не поддерживается.",
        );
      if (snapshot.operation !== "none")
        throw Error("Сначала завершите текущую операцию Git.");
      const paths = new Set(req.paths);
      for (const name of req.paths)
        if (
          !snapshot.files.some(
            (f) => f.path === name || f.originalPath === name,
          )
        )
          throw Error(
            "Выбранный файл отсутствует в актуальном списке изменений.",
          );
      for (const f of snapshot.files)
        if (
          f.originalPath &&
          (paths.has(f.path) || paths.has(f.originalPath))
        ) {
          paths.add(f.path);
          paths.add(f.originalPath);
        }
      const names = [...paths];
      gitDiscardRequestSchema.parse({ ...req, paths: names });
      const s = await this.capture(c, names);
      if (s.head !== snapshot.head || s.branch !== snapshot.branch)
        throw stale();
      const items: GitDiscardPreview["items"] = names.map((name) => ({
        path: name,
        action: s.entries.has(name) ? "restore" : "trash",
      }));
      if (
        !this.options.trashItem &&
        items.some((i) => i.action === "trash" && s.work.get(i.path))
      )
        throw Error(
          "Системная Корзина недоступна; новые файлы не будут удалены.",
        );
      await this.sources(c, s);
      if (fingerprint(await this.capture(c, names)) !== fingerprint(s))
        throw stale();
      const preview: GitDiscardPreview = {
        token: randomBytes(32).toString("hex"),
        scope: structuredClone(req.scope),
        root: s.root,
        head: s.head,
        branch: s.branch,
        paths: names,
        items,
        expiresAt: this.now() + TTL,
      };
      for (const [token, t] of this.tickets)
        if (t.preview.expiresAt <= this.now()) this.tickets.delete(token);
      while (this.tickets.size >= 32)
        this.tickets.delete(this.tickets.keys().next().value!);
      this.tickets.set(preview.token, {
        preview: structuredClone(preview),
        fingerprint: fingerprint(s),
      });
      return preview;
    });
  }
  async execute(input: string): Promise<GitDiscardResult> {
    const token = gitDiscardTokenSchema.parse(input),
      ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (!ticket || ticket.preview.expiresAt <= this.now())
      throw Error("Подтверждение истекло или уже использовано.");
    let completed: GitDiscardResult | undefined;
    let cleanupRecovery: (() => void) | undefined;
    try {
      const result = await this.options.context(
        ticket.preview.scope,
        async (c) => {
          const s = await this.capture(c, ticket.preview.paths);
          if (
            ticket.fingerprint !== fingerprint(s) ||
            ticket.preview.expiresAt <= this.now()
          )
            throw stale();
          completed = await this.transact(c, ticket, s, (cleanup) => {
            cleanupRecovery = cleanup;
          });
          return completed;
        },
      );
      // Keep recovery if even the outer lifecycle lock failed to release.
      if (result.status === "discarded" && cleanupRecovery) {
        try {
          cleanupRecovery();
          delete result.recoveryPath;
        } catch (error) {
          return {
            ...result,
            message:
              "Отмена изменений завершена и проверена, но очистка служебных материалов не завершена. Повторять отмену не нужно.",
            log: `${result.log}\n${String(error)}`,
          };
        }
      }
      return result;
    } catch (error) {
      if (!completed) throw error;
      return {
        ...completed,
        status:
          completed.worktreePublished || completed.indexPublished
            ? "uncertain"
            : "not-discarded",
        message:
          "Завершение служебной блокировки не подтверждено. Не повторяйте откат автоматически; проверьте результат и журнал.",
        log: `${completed.log}\n${String(error)}`,
      };
    }
  }
  private async transact(
    c: GitCommitContext,
    t: Ticket,
    s: State,
    onVerified: (cleanup: () => void) => void,
  ): Promise<GitDiscardResult> {
    const root = s.root,
      gd = path.join(root, ".git"),
      index = path.join(gd, "index"),
      lock = path.join(gd, "index.lock");
    // Existing trusted-index capability admits this namespace. Journal kind
    // identifies discard; this is not a commit and never changes any Git ref.
    const recovery = path.join(gd, `goga-commit-${randomUUID()}`),
      privateIndex = path.join(recovery, "index");
    let recoveryId = "",
      lockId = "",
      lockHash = "",
      indexPublished = false,
      worktreePublished = false;
    const changedPaths: string[] = [],
      trashedPaths: string[] = [],
      expectedWork = new Map(s.work),
      moved = new Map<string, File>(),
      ready = new Map<string, File>();
    const ownLock = () => {
      try {
        assertParents(s.parents.slice(0, 2));
        const f = regular(lock);
        return (
          !!lockId &&
          !!f &&
          f.identity.split(":").slice(0, 2).join(":") === lockId &&
          hash(f.bytes) === lockHash
        );
      } catch {
        return false;
      }
    };
    const result = (
      status: GitDiscardResult["status"],
      message: string,
      log = "",
    ): GitDiscardResult => ({
      scope: t.preview.scope,
      status,
      changedPaths: [...changedPaths],
      trashedPaths: [...trashedPaths],
      indexPublished,
      worktreePublished,
      message,
      log,
      ...(recoveryId ? { recoveryPath: recovery } : {}),
    });
    const journal = () => {
      if (directory(recovery) !== recoveryId) throw stale();
      const next = path.join(recovery, `journal-${randomUUID()}`);
      writeNew(
        next,
        JSON.stringify(
          {
            version: 1,
            kind: "discard-selected",
            root,
            scope: t.preview.scope,
            head: s.head,
            paths: t.preview.paths,
            ownerHash: hash(s.owner),
            changedPaths,
            trashedPaths,
            indexPublished,
            worktreePublished,
            lockRetained: ownLock(),
            oldIndex: s.index.identity,
            originalFiles: [...s.work].map(([name, f]) => [
              name,
              f?.identity ?? "missing",
            ]),
          },
          null,
          2,
        ),
      );
      renameSync(next, path.join(recovery, "journal.json"));
      syncDirectory(recovery);
    };
    const guard = (readyIndex?: File) => {
      assertParents(s.parents);
      if (
        c.root !== root ||
        c.ownerKey !== s.owner ||
        JSON.stringify(c.scope) !== s.scope ||
        directory(recovery) !== recoveryId ||
        stableMetadata(root) !== s.metadata ||
        t.preview.expiresAt <= this.now()
      )
        throw stale();
      if (
        !indexPublished &&
        (regular(index)?.identity !== s.index.identity || !ownLock())
      )
        throw stale();
      if (
        indexPublished &&
        readyIndex &&
        !regular(index)?.bytes.equals(readyIndex.bytes)
      )
        throw stale();
      for (const [name, expected] of expectedWork)
        if (
          (regular(path.join(root, name), FILE_LIMIT)?.identity ??
            "missing") !== (expected?.identity ?? "missing")
        )
          throw stale();
      for (const [filename, id] of s.attributes) {
        const name = path.relative(root, filename).split(path.sep).join("/");
        const expected = expectedWork.has(name)
          ? (expectedWork.get(name)?.identity ?? "missing")
          : id;
        if ((regular(filename)?.identity ?? "missing") !== expected)
          throw stale();
      }
    };
    try {
      if (!c.refTransaction)
        throw Error(
          "Безопасная блокировка HEAD недоступна; откат не выполнен.",
        );
      if (
        !this.options.trashItem &&
        t.preview.items.some((i) => i.action === "trash" && s.work.get(i.path))
      )
        throw Error("Системная Корзина недоступна.");
      assertParents(s.parents);
      mkdirSync(recovery, { mode: 0o700 });
      recoveryId = directory(recovery);
      mkdirSync(path.join(recovery, "originals"), { mode: 0o700 });
      mkdirSync(path.join(recovery, "ready"), { mode: 0o700 });
      writeNew(path.join(recovery, "original-index"), s.index.bytes);
      writeNew(privateIndex, s.index.bytes);
      journal();
      const sources = await this.sources(c, s),
        zero = "0".repeat(s.head.length);
      const stdin = t.preview.paths
        .map((name) => {
          const e = s.entries.get(name);
          return `0 ${zero}\t${name}\0${e ? `${e.mode} ${e.oid} 0\t${name}\0` : ""}`;
        })
        .join("");
      await this.git(c, ["update-index", "-z", "--index-info"], {
        stdin,
        indexFile: privateIndex,
      });
      const preparedIndex = regular(privateIndex);
      if (!preparedIndex) throw stale();
      for (const [name, bytes] of sources) {
        const output = path.join(recovery, "ready", name);
        mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        const mode = s.work.get(name)?.mode ?? 0o644;
        const workMode =
          s.entries.get(name)!.mode === "100755"
            ? mode | ((mode & 0o444) >> 2) | 0o100
            : mode & ~0o111;
        writeNew(output, bytes, workMode);
        ready.set(name, regular(output, FILE_LIMIT)!);
      }
      for (const name of t.preview.paths)
        mkdirSync(path.dirname(path.join(recovery, "originals", name)), {
          recursive: true,
          mode: 0o700,
        });
      const candidate = path.join(recovery, "index-ready");
      writeNew(candidate, preparedIndex.bytes);
      lockHash = hash(preparedIndex.bytes);
      const cs = stat(candidate)!;
      lockId = `${cs.dev}:${cs.ino}`;
      try {
        linkSync(candidate, lock);
      } catch (error) {
        lockId = "";
        throw Error(
          `Индекс Git занят или index.lock недоступна. Чужая блокировка не изменена. ${String(error)}`,
        );
      }
      unlinkSync(candidate);
      syncDirectory(gd);
      if (fingerprint(await this.capture(c, t.preview.paths)) !== t.fingerprint)
        throw stale();
      const referenceResult = await c.refTransaction(
        [
          ...safe,
          `--git-dir=${gd}`,
          `--work-tree=${root}`,
          "update-ref",
          "--stdin",
        ],
        `start\nverify HEAD ${s.head}\nprepare\n`,
        async (assertPreparedActive) => {
          await c.verify();
          if (
            fingerprint(await this.capture(c, t.preview.paths)) !==
            t.fingerprint
          )
            throw stale();
          this.options.beforePublishWork?.();
          guard();
          assertPreparedActive();
          // No await from final guard through publication: native HEAD locks stay
          // held and no late callback can run after their timeout/release.
          for (const name of t.preview.paths) {
            guard();
            assertPreparedActive();
            const filename = path.join(root, name),
              original = s.work.get(name);
            if (original) {
              const saved = path.join(recovery, "originals", name);
              directory(path.dirname(saved));
              if (stat(saved)) throw stale();
              renameSync(filename, saved);
              worktreePublished = true;
              changedPaths.push(name);
              expectedWork.set(name, null);
              const actual = regular(saved, FILE_LIMIT);
              if (
                !actual ||
                !actual.bytes.equals(original.bytes) ||
                actual.identity.split(":").slice(0, 4).join(":") !==
                  original.identity.split(":").slice(0, 4).join(":")
              )
                throw stale();
              moved.set(name, actual);
              syncDirectory(path.dirname(saved));
              syncDirectory(path.dirname(filename));
            }
            const source = ready.get(name);
            if (source) {
              const output = path.join(recovery, "ready", name);
              directory(path.dirname(output));
              if (regular(output, FILE_LIMIT)?.identity !== source.identity)
                throw stale();
              // link is no-clobber: an editor's newly-created pathname wins.
              linkSync(output, filename);
              unlinkSync(output);
              worktreePublished = true;
              if (!changedPaths.includes(name)) changedPaths.push(name);
              const actual = regular(filename, FILE_LIMIT);
              expectedWork.set(name, actual);
              if (
                !actual ||
                !actual.bytes.equals(source.bytes) ||
                actual.identity.split(":").slice(0, 4).join(":") !==
                  source.identity.split(":").slice(0, 4).join(":")
              )
                throw stale();
              syncDirectory(path.dirname(filename));
            }
            journal();
            this.options.afterPublishWork?.();
          }
          this.options.beforePublishIndex?.();
          guard();
          assertPreparedActive();
          renameSync(lock, index);
          indexPublished = true;
          lockId = "";
          worktreePublished = true;
          for (const name of t.preview.paths)
            if (!changedPaths.includes(name)) changedPaths.push(name);
          syncDirectory(gd);
          this.options.afterPublishIndex?.();
          guard(preparedIndex);
          assertPreparedActive();
          journal();
        },
      );
      if (referenceResult.stderr.trim()) throw Error(referenceResult.stderr);
      // Trash only receives the exact moved originals in the private recovery
      // area, never a live user pathname that an editor may have recreated.
      for (const item of t.preview.items)
        if (item.action === "trash" && moved.has(item.path)) {
          guard(preparedIndex);
          const saved = path.join(recovery, "originals", item.path);
          directory(path.dirname(saved));
          if (
            regular(saved, FILE_LIMIT)?.identity !==
            moved.get(item.path)!.identity
          )
            throw stale();
          await this.options.trashItem!(saved);
          if (stat(saved))
            throw Error("Корзина не подтвердила перемещение файла.");
          trashedPaths.push(item.path);
          journal();
        }
      await c.verify();
      guard(preparedIndex);
      journal();
      // Register cleanup only after final verification; execute after context release.
      onVerified(() => {
        assertParents(s.parents.slice(0, 2));
        if (directory(recovery) !== recoveryId) throw stale();
        rmSync(recovery, { recursive: true });
      });
      return result(
        "discarded",
        "Выбранные файлы возвращены к HEAD, новые файлы перемещены в Корзину. Остальные изменения сохранены.",
      );
    } catch (error) {
      if (!worktreePublished && !indexPublished && ownLock()) {
        unlinkSync(lock);
        lockId = "";
        syncDirectory(gd);
      }
      try {
        if (recoveryId) journal();
      } catch {
        /* Durable originals remain; never overwrite user files. */
      }
      return result(
        worktreePublished || indexPublished ? "uncertain" : "not-discarded",
        worktreePublished || indexPublished
          ? "Откат выполнен не полностью или итог не подтверждён. Не повторяйте автоматически; исходные файлы и индекс сохранены для восстановления."
          : "Откат не выполнен. Файлы и исходный индекс не изменены; обновите предпросмотр.",
        String(error),
      );
    }
  }
}
