import { constants } from "node:fs";
import { lstat, mkdir, open, rename, link, unlink } from "node:fs/promises";
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
export function managedWorktreeLocation(
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
      "worktrees",
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
const repositoryTails = new Map<string, Promise<void>>();
const mutable = (r: WorktreeRecord) =>
  JSON.stringify([r.state, r.preparation ?? null, r.reason ?? null]);
const immutable = (r: WorktreeRecord) =>
  JSON.stringify([
    r.projectId,
    r.projectPath,
    r.gitCommonDir,
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
 * plus content/revision CAS and an atomic replacement. An abandoned lock is NOT
 * guessed stale. Portable Node lacks dirfd/openat; a hostile same-user ancestor
 * replacement race cannot be eliminated entirely, so paths are rechecked at all
 * filesystem/command boundaries. No directory is removed by this store.
 */
export class WorktreeStore {
  readonly root: string;
  private readonly file: string;
  private registryKnown = false;
  private readonly directories = new Map<
    string,
    { dev: number; ino: number }
  >();
  constructor(private readonly home: string) {
    if (!boundedPath(home)) throw invalid();
    this.root = path.join(home, ".goga", "desktop", "worktrees");
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
      const location = managedWorktreeLocation(
        this.home,
        { id: r.projectId, path: r.projectPath },
        r.gitCommonDir,
        {
          projectId: r.projectId,
          year: r.year,
          topic: r.topic,
          branch: r.branch,
        },
      );
      if (
        r.repositoryKey !== location.repositoryKey ||
        r.contextId !== location.contextId ||
        (r.ownership === "managed" && r.path !== location.path) ||
        (r.ownership === "primary" && r.path !== r.projectPath) ||
        (r.state === "ready" && r.preparation) ||
        ids.has(r.contextId)
      )
        throw invalid();
      const prior = paths.get(r.path);
      if (
        prior &&
        !(
          prior.ownership === "primary" &&
          r.ownership === "primary" &&
          prior.projectId === r.projectId &&
          prior.projectPath === r.projectPath
        )
      )
        throw invalid();
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
    const file = path.join(this.root, name);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        await noSymlinks(file);
        try {
          handle = await open(
            file,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (attempt === 99)
            throw new Error("Хранилище рабочих копий занято. Повторите позже.");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      await this.assertRoot();
      return await action();
    } finally {
      if (handle) {
        const owned = await handle.stat().catch(() => undefined);
        const current = await lstat(file).catch(() => undefined);
        if (
          owned &&
          current &&
          owned.ino === current.ino &&
          owned.dev === current.dev
        )
          await unlink(file).catch(() => {});
        await handle.close().catch(() => {});
      }
    }
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
}
