import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  link,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Project } from "../shared/types";
import {
  topicContextIdentitySchema,
  worktreeRecordSchema,
  type TopicContextIdentity,
  type WorktreeRecord,
  type WorktreeRegistry,
} from "../shared/worktrees";
import { noSymlinks } from "./settings";
import { acquireOwnedLock } from "./owned-lock";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const invalid = () =>
  new Error("Реестр рабочих копий повреждён или несовместим.");
const conflict = () =>
  new Error("Реестр рабочих копий изменён. Обновите данные и повторите.");
const boundedPath = (value: string) =>
  path.isAbsolute(value) &&
  path.resolve(value) === value &&
  !/[\x00-\x1f\x7f]/.test(value);
const slug = (value: string, fallback: string, length: number) =>
  value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, length)
    .replace(/-$/, "") || fallback;
export function managedCloneLocation(
  home: string,
  project: Pick<Project, "id" | "path">,
  gitCommonDir: string,
  input: TopicContextIdentity,
) {
  const identity = topicContextIdentitySchema.parse(input);
  if (
    identity.projectId !== project.id ||
    !boundedPath(home) ||
    !boundedPath(project.path) ||
    !boundedPath(gitCommonDir)
  )
    throw invalid();
  const repositoryKey = hash(gitCommonDir);
  const identityHash = hash(
    JSON.stringify([
      "standalone-clone-v1",
      project.id,
      project.path,
      gitCommonDir,
      identity.year,
      identity.topic,
      identity.branch,
    ]),
  );
  return {
    repositoryKey,
    contextId: `ctx-${identityHash}`,
    path: path.join(
      home,
      ".goga",
      "desktop",
      "clones",
      `${slug(path.basename(project.path), "project", 40)}-${hash(JSON.stringify([project.id, project.path, gitCommonDir])).slice(0, 24)}`,
      identity.year,
      `${slug(identity.topic, "topic", 48)}-${identityHash.slice(0, 24)}`,
    ),
  };
}
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().uuid(),
    records: z.array(worktreeRecordSchema).max(100000),
  })
  .strict();
const fingerprintSchema = z
  .object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
  })
  .strict();
const ownerSchema = z
  .object({
    contextId: z.string(),
    path: z.string(),
    projectPath: z.string(),
    sourceCommonDir: z.string(),
    nonce: z.string().uuid(),
    root: fingerprintSchema,
    sourceRoot: fingerprintSchema,
    sourceGit: fingerprintSchema,
    git: fingerprintSchema.optional(),
  })
  .strict();
type CloneOwner = z.infer<typeof ownerSchema>;
const repositoryTails = new Map<string, Promise<void>>();
const registryTails = new Map<string, Promise<void>>();
const mutable = (r: WorktreeRecord) =>
  JSON.stringify([
    r.state,
    r.preparation ?? null,
    r.reason ?? null,
    r.deletedAt ?? null,
  ]);
const immutable = (r: WorktreeRecord) =>
  JSON.stringify([
    r.projectId,
    r.projectPath,
    r.gitCommonDir,
    r.sourceCommonDir,
    r.storageKind,
    r.compatibility,
    r.repositoryKey,
    r.year,
    r.topic,
    r.branch,
    r.contextId,
    r.path,
    r.ownership,
  ]);

/**
 * Desktop ownership registry. Cooperating writers use exclusive no-follow locks
 * plus content/revision CAS and an atomic replacement. Only a versioned lock
 * with a definitely dead PID is reclaimed; unknown/live owners fail closed. Portable Node lacks dirfd/openat; a hostile same-user ancestor
 * replacement race cannot be eliminated entirely, so paths are rechecked at all
 * filesystem/command boundaries. No directory is removed by this store.
 */
export class CloneStore {
  readonly root: string;
  private readonly file: string;
  private registryKnown = false;
  private readonly directories = new Map<
    string,
    { dev: number; ino: number }
  >();
  constructor(private readonly home: string) {
    if (!boundedPath(home)) throw invalid();
    this.root = path.join(home, ".goga", "desktop", "clones");
    this.file = path.join(this.root, "registry.json");
  }
  private async directory(dir: string, privateDirectory = true, create = true) {
    await noSymlinks(dir);
    const trusted = this.directories.get(dir);
    if (trusted || !create) {
      const current = await lstat(dir);
      if (
        !current.isDirectory() ||
        (trusted &&
          (trusted.dev !== current.dev || trusted.ino !== current.ino))
      )
        throw invalid();
    } else {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    await noSymlinks(dir);
    const handle = await open(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isDirectory() ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw invalid();
      if (trusted && (trusted.dev !== info.dev || trusted.ino !== info.ino))
        throw invalid();
      this.directories.set(dir, { dev: info.dev, ino: info.ino });
      if (privateDirectory) await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  async assertRoot() {
    await this.directory(this.home, false, false);
    await this.directory(path.join(this.home, ".goga"), false);
    for (const dir of [path.join(this.home, ".goga", "desktop"), this.root])
      await this.directory(dir);
  }
  async prepareParent(record: WorktreeRecord) {
    this.validate([record]);
    if (record.ownership !== "managed") throw invalid();
    await this.assertRoot();
    const relative = path.relative(this.root, path.dirname(record.path));
    let cursor = this.root;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      await this.directory(cursor);
    }
    await noSymlinks(record.path);
  }
  private validate(records: WorktreeRecord[]) {
    const ids = new Set<string>(),
      paths = new Map<string, WorktreeRecord>();
    for (const value of records) {
      const parsed = worktreeRecordSchema.safeParse(value);
      if (!parsed.success) throw invalid();
      const r = parsed.data;
      if (![r.projectPath, r.gitCommonDir, r.path].every(boundedPath))
        throw invalid();
      if (!r.sourceCommonDir || !boundedPath(r.sourceCommonDir))
        throw invalid();
      const location = managedCloneLocation(
        this.home,
        { id: r.projectId, path: r.projectPath },
        r.sourceCommonDir,
        {
          projectId: r.projectId,
          year: r.year,
          topic: r.topic,
          branch: r.branch,
        },
      );
      if (
        r.storageKind !== "clone" ||
        r.compatibility !== undefined ||
        r.ownership !== "managed" ||
        !r.sourceCommonDir ||
        !boundedPath(r.sourceCommonDir) ||
        r.gitCommonDir !== path.join(r.path, ".git") ||
        r.path === r.projectPath ||
        r.repositoryKey !== location.repositoryKey ||
        r.contextId !== location.contextId ||
        (r.ownership === "managed" && r.path !== location.path) ||
        (r.state === "ready" && r.preparation) ||
        (r.deletedAt !== undefined &&
          (r.state !== "missing" || r.preparation !== undefined)) ||
        ids.has(r.contextId)
      )
        throw invalid();
      const prior = paths.get(r.path);
      if (prior) throw invalid();
      ids.add(r.contextId);
      paths.set(r.path, r);
    }
  }
  private async readText(): Promise<string | undefined> {
    await noSymlinks(this.file);
    let handle;
    try {
      handle = await open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (absent(error)) {
        if (this.registryKnown) throw invalid();
        return undefined;
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 16 * 1024 * 1024 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw invalid();
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw invalid();
      this.registryKnown = true;
      return text;
    } finally {
      await handle.close();
    }
  }
  private parse(raw: string): WorktreeRegistry {
    try {
      const doc = documentSchema.parse(JSON.parse(raw));
      this.validate(doc.records);
      return { revision: doc.revision, records: doc.records };
    } catch {
      throw invalid();
    }
  }
  private async install(value: WorktreeRegistry, expected: string | undefined) {
    const text = JSON.stringify({ schemaVersion: 1, ...value }, null, 2) + "\n";
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw invalid();
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(
        temp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(text);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertRoot();
      if ((await this.readText()) !== expected) throw conflict();
      await noSymlinks(this.file);
      if (expected === undefined) {
        try {
          await link(temp, this.file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw conflict();
          throw error;
        }
      } else await rename(temp, this.file);
      // Avoid retaining a second link across asynchronous directory fsync.
      await unlink(temp).catch(() => {});
      this.registryKnown = true;
      const directory = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  private async locked<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.assertRoot();
    const key = path.join(
      name === ".registry.lock" ? await realpath(this.root) : this.root,
      name,
    );
    const acquire = async () => {
      const lock = await acquireOwnedLock(key);
      try {
        await this.assertRoot();
        return await action();
      } finally {
        await lock.release();
      }
    };
    if (name !== ".registry.lock") return acquire();
    // A cooperating in-process reader must not inspect another reader's lock
    // between O_EXCL and owner-JSON publication. Disk locks remain fail closed
    // for unknown/malformed/live owners in other processes. Keep this queue
    // separate from repositoryTails: repository actions acquire the registry.
    const previous = registryTails.get(key) ?? Promise.resolve();
    const work = previous.then(acquire);
    const tail = work.then(
      () => {},
      () => {},
    );
    registryTails.set(key, tail);
    return work.finally(() => {
      if (registryTails.get(key) === tail) registryTails.delete(key);
    });
  }
  withRepositoryLock<T>(
    repositoryKey: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!/^[a-f0-9]{64}$/.test(repositoryKey)) throw invalid();
    const name = `.repository-${repositoryKey}.lock`;
    const key = path.join(this.root, name);
    // In-process requests can wait for a long Git checkout without treating a
    // live lock as stale. The on-disk lock still protects independent processes.
    const previous = repositoryTails.get(key) ?? Promise.resolve();
    const work = previous.then(() => this.locked(name, action));
    const tail = work.then(
      () => {},
      () => {},
    );
    repositoryTails.set(key, tail);
    return work.finally(() => {
      if (repositoryTails.get(key) === tail) repositoryTails.delete(key);
    });
  }
  private async current(): Promise<{
    value: WorktreeRegistry;
    raw: string | undefined;
  }> {
    const raw = await this.readText();
    return {
      value:
        raw === undefined
          ? { revision: randomUUID(), records: [] }
          : this.parse(raw),
      raw,
    };
  }
  read(): Promise<WorktreeRegistry> {
    return this.locked(".registry.lock", async () => {
      const { value, raw } = await this.current();
      if (raw === undefined) await this.install(value, undefined);
      return value;
    });
  }
  write(
    expectedRevision: string,
    records: WorktreeRecord[],
  ): Promise<WorktreeRegistry> {
    return this.locked(".registry.lock", async () => {
      const { value, raw } = await this.current();
      if (!raw || value.revision !== expectedRevision) throw conflict();
      this.validate(records);
      for (const record of records) {
        const old = value.records.find((r) => r.contextId === record.contextId);
        if (old && immutable(old) !== immutable(record)) throw invalid();
        if (old?.deletedAt && old.deletedAt !== record.deletedAt)
          throw invalid();
        if (
          old &&
          mutable(old) !== mutable(record) &&
          old.revision === record.revision
        )
          throw conflict();
      }
      const next = { revision: randomUUID(), records };
      await this.install(next, raw);
      return next;
    });
  }
  update(
    record: WorktreeRecord,
    expectedRevision: string | undefined,
  ): Promise<WorktreeRecord> {
    return this.locked(".registry.lock", async () => {
      const { value, raw } = await this.current();
      const old = value.records.find((r) => r.contextId === record.contextId);
      if (old?.revision !== expectedRevision) throw conflict();
      if (old && immutable(old) !== immutable(record)) throw invalid();
      if (old?.deletedAt && old.deletedAt !== record.deletedAt) throw invalid();
      if (
        old &&
        mutable(old) !== mutable(record) &&
        old.revision === record.revision
      )
        throw conflict();
      const records = [
        ...value.records.filter((r) => r.contextId !== record.contextId),
        record,
      ];
      this.validate(records);
      await this.install({ revision: randomUUID(), records }, raw);
      return record;
    });
  }
  private ownerFile(record: WorktreeRecord) {
    this.validate([record]);
    return path.join(this.root, `.owner-${record.contextId}.json`);
  }
  private async fingerprint(target: string) {
    await noSymlinks(target);
    const value = await lstat(target);
    if (
      !value.isDirectory() ||
      (process.getuid && value.uid !== process.getuid())
    )
      throw invalid();
    return { dev: value.dev, ino: value.ino };
  }
  private async owner(record: WorktreeRecord): Promise<CloneOwner> {
    await this.assertRoot();
    const file = this.ownerFile(record);
    await noSymlinks(file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 4096 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw invalid();
      const owner = ownerSchema.parse(
        JSON.parse(await handle.readFile("utf8")),
      );
      if (
        owner.contextId !== record.contextId ||
        owner.path !== record.path ||
        owner.sourceCommonDir !== record.sourceCommonDir ||
        owner.projectPath !== record.projectPath
      )
        throw invalid();
      return owner;
    } finally {
      await handle.close();
    }
  }
  async assertOwned(record: WorktreeRecord, requireGit = true) {
    const owner = await this.owner(record);
    if (
      JSON.stringify(await this.fingerprint(record.projectPath)) !==
        JSON.stringify(owner.sourceRoot) ||
      JSON.stringify(await this.fingerprint(record.sourceCommonDir!)) !==
        JSON.stringify(owner.sourceGit)
    )
      throw invalid();
    if (
      JSON.stringify(await this.fingerprint(record.path)) !==
      JSON.stringify(owner.root)
    )
      throw invalid();
    if (requireGit) {
      if (
        !owner.git ||
        JSON.stringify(await this.fingerprint(record.gitCommonDir)) !==
          JSON.stringify(owner.git)
      )
        throw invalid();
      const marker = path.join(record.gitCommonDir, "desktop-owner.json");
      await noSymlinks(marker);
      const handle = await open(
        marker,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 1024 ||
          (info.mode & 0o077) !== 0
        )
          throw invalid();
        const expected = JSON.stringify({
          contextId: record.contextId,
          nonce: owner.nonce,
        });
        if ((await handle.readFile("utf8")) !== expected) throw invalid();
      } finally {
        await handle.close();
      }
    }
    await this.assertRoot();
  }
  /** Exclusively reserve a NEW empty directory before Git ever touches it. */
  async reserve(record: WorktreeRecord) {
    await this.prepareParent(record);
    await mkdir(record.path, { mode: 0o700 });
    const owner: CloneOwner = {
      contextId: record.contextId,
      path: record.path,
      projectPath: record.projectPath,
      sourceCommonDir: record.sourceCommonDir!,
      nonce: randomUUID(),
      root: await this.fingerprint(record.path),
      sourceRoot: await this.fingerprint(record.projectPath),
      sourceGit: await this.fingerprint(record.sourceCommonDir!),
    };
    const handle = await open(this.ownerFile(record), "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await this.update(record, undefined);
    await this.assertOwned(record, false);
  }
  /** Called only immediately after init, before transport/checkout. */
  async claimGit(record: WorktreeRecord) {
    await this.assertOwned(record, false);
    const owner = await this.owner(record);
    if (owner.git) throw invalid();
    owner.git = await this.fingerprint(record.gitCommonDir);
    const marker = path.join(record.gitCommonDir, "desktop-owner.json");
    await noSymlinks(marker);
    const handle = await open(marker, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ contextId: record.contextId, nonce: owner.nonce }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    const file = this.ownerFile(record);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const output = await open(temp, "wx", 0o600);
      try {
        await output.writeFile(JSON.stringify(owner));
        await output.sync();
      } finally {
        await output.close();
      }
      await this.assertOwned(record, false);
      await rename(temp, file);
    } finally {
      await unlink(temp).catch(() => {});
    }
    await this.assertOwned(record);
  }
}
