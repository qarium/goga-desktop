import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  NotificationInputSchema,
  NotificationPageRequestSchema,
  NotificationRecordSchema,
  type NotificationInput,
  type NotificationKind,
  type NotificationRecord,
  type NotificationSnapshot,
} from "../../shared/notifications";
import { noSymlinks } from "../settings";

const MAX_BYTES = 16 * 1024 * 1024;
const StateSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    systemEnabled: z.boolean(),
    records: z.array(NotificationRecordSchema),
  })
  .strict()
  .superRefine((state, ctx) => {
    const ids = new Set<string>(),
      sequences = new Set<number>();
    for (const record of state.records) {
      if (ids.has(record.id) || sequences.has(record.sequence)) {
        ctx.addIssue({
          code: "custom",
          message: "Duplicate notification identity",
        });
        return;
      }
      ids.add(record.id);
      sequences.add(record.sequence);
    }
  });
type State = z.infer<typeof StateSchema>;
type Observer = (
  snapshot: NotificationSnapshot,
  added?: NotificationRecord,
) => void;
const empty = (): State => ({
  schemaVersion: 1,
  revision: 0,
  systemEnabled: false,
  records: [],
});
const copy = <T>(value: T): T => structuredClone(value);
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";
const safeError = () =>
  new Error(
    "Не удалось прочитать или сохранить историю уведомлений. История не удалена.",
  );
const terminalSeverity: Partial<Record<NotificationKind, number>> = {
  "process-exited": 1,
  "run-finished": 2,
  "run-failed": 3,
};
function sameOwner(a: NotificationRecord, b: NotificationInput) {
  return (
    a.runId === b.runId &&
    a.projectId === b.projectId &&
    a.stageId === b.stageId &&
    a.pipeline === b.pipeline &&
    a.topic === b.topic &&
    a.branch === b.branch &&
    JSON.stringify(a.context) === JSON.stringify(b.context)
  );
}

/**
 * Main-process owner of the complete history. Never stores event payloads or sends OS notifications.
 * Node cannot eliminate hostile same-user ancestor replacement without a portable openat/dirfd API;
 * validate ancestors, opened inode and destination again around every atomic replacement.
 */
export class NotificationCenter {
  private state = empty();
  private error?: string;
  private initialized = false;
  private diskDigest: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private observers = new Set<Observer>();
  private readonly file: string;

  constructor(private readonly dataDir: string) {
    this.file = path.join(dataDir, "notifications.json");
  }

  initialize(): Promise<void> {
    return this.serialized(async () => {
      await this.load();
    });
  }

  snapshot(limit = 50, beforeSequence?: number): NotificationSnapshot {
    const page = NotificationPageRequestSchema.parse({
      limit: Math.min(limit, 50),
      beforeSequence,
    });
    const sorted = [...this.state.records].sort(
      (a, b) => b.sequence - a.sequence,
    );
    const rows =
      page.beforeSequence === undefined
        ? sorted
        : sorted.filter((row) => row.sequence < page.beforeSequence!);
    const byProject: Record<string, number> = Object.create(null);
    const unreadRunIds = new Set<string>();
    let unreadCount = 0;
    for (const record of this.state.records)
      if (record.readAt === null) {
        unreadCount++;
        byProject[record.projectId] = (byProject[record.projectId] ?? 0) + 1;
        unreadRunIds.add(record.runId);
      }
    return {
      revision: this.state.revision,
      records: copy(rows.slice(0, page.limit)),
      throughSequence: sorted[0]?.sequence ?? 0,
      hasMore: rows.length > page.limit,
      unreadCount,
      byProject,
      unreadRunIds: [...unreadRunIds].sort(),
      systemEnabled: this.state.systemEnabled,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  find(id: string): NotificationRecord | undefined {
    const record = this.state.records.find((row) => row.id === id);
    return record && copy(record);
  }

  add(
    input: NotificationInput,
    readIf?: () => boolean,
  ): Promise<NotificationRecord | null> {
    return this.serialized(async () => {
      await this.load();
      const parsed = NotificationInputSchema.parse(input);
      const previous = this.state.records.find((row) => row.id === parsed.id);
      if (
        previous &&
        !(
          sameOwner(previous, parsed) &&
          (terminalSeverity[parsed.kind] ?? 0) >
            (terminalSeverity[previous.kind] ?? 0) &&
          terminalSeverity[previous.kind]
        )
      )
        return null;
      // An upgraded terminal remains one identity, but its new sequence protects it from old read-all snapshots.
      const record: NotificationRecord = {
        ...parsed,
        sequence: this.nextSequence(),
        // Evaluate actual viewing inside the serialized mutation. Subscribers
        // must never observe an unread increment for an already viewed arrival.
        readAt: readIf?.() ? new Date().toISOString() : null,
      };
      const next = this.changed();
      next.records = previous
        ? next.records.map((row) => (row.id === record.id ? record : row))
        : [...next.records, record];
      await this.commit(next);
      this.publish(record);
      return copy(record);
    });
  }

  markRead(
    id: string,
    expectedSequence?: number,
  ): Promise<NotificationSnapshot> {
    return this.serialized(async () => {
      await this.load();
      const record = this.state.records.find((row) => row.id === id);
      if (expectedSequence !== undefined) {
        const expected = NotificationPageRequestSchema.parse({
          beforeSequence: expectedSequence,
        }).beforeSequence!;
        if (!record || record.sequence !== expected) return this.snapshot();
      }
      if ((!record || record.readAt !== null) && !this.error)
        return this.snapshot();
      const next = this.changed();
      const now = new Date().toISOString();
      next.records = next.records.map((row) =>
        row.id === id && row.readAt === null ? { ...row, readAt: now } : row,
      );
      await this.commit(next);
      this.publish();
      return this.snapshot();
    });
  }

  markAllRead(throughSequence: number): Promise<NotificationSnapshot> {
    return this.serialized(async () => {
      await this.load();
      const bound = NotificationPageRequestSchema.parse({
        beforeSequence: throughSequence,
      }).beforeSequence!;
      const eligible = (row: NotificationRecord) =>
        row.sequence <= bound && row.readAt === null;
      if (!this.state.records.some(eligible) && !this.error)
        return this.snapshot();
      const next = this.changed();
      const now = new Date().toISOString();
      next.records = next.records.map((row) =>
        eligible(row) ? { ...row, readAt: now } : row,
      );
      await this.commit(next);
      this.publish();
      return this.snapshot();
    });
  }

  /** Main-only batch acknowledgement, fenced to the observed history version.
   * Recheck the caller's viewing/owner predicate when this transaction executes. */
  markMatchingRead(
    throughSequence: number,
    matches: (record: NotificationRecord) => boolean,
  ): Promise<NotificationSnapshot> {
    return this.serialized(async () => {
      await this.load();
      const bound = NotificationPageRequestSchema.parse({
        beforeSequence: throughSequence,
      }).beforeSequence!;
      const ids = new Set(
        this.state.records
          .filter(
            (row) =>
              row.sequence <= bound &&
              row.readAt === null &&
              matches(copy(row)),
          )
          .map((row) => row.id),
      );
      if (!ids.size) return this.snapshot();
      const next = this.changed();
      const now = new Date().toISOString();
      next.records = next.records.map((row) =>
        ids.has(row.id) ? { ...row, readAt: now } : row,
      );
      await this.commit(next);
      this.publish();
      return this.snapshot();
    });
  }

  setSystemEnabled(enabled: boolean): Promise<NotificationSnapshot> {
    return this.serialized(async () => {
      await this.load();
      if (typeof enabled !== "boolean") throw safeError();
      if (this.state.systemEnabled === enabled && !this.error)
        return this.snapshot();
      const next = this.changed();
      next.systemEnabled = enabled;
      await this.commit(next);
      this.publish();
      return this.snapshot();
    });
  }

  onChanged(callback: Observer): () => void {
    this.observers.add(callback);
    return () => {
      this.observers.delete(callback);
    };
  }

  private nextSequence() {
    const value =
      this.state.records.reduce((max, row) => Math.max(max, row.sequence), 0) +
      1;
    if (!Number.isSafeInteger(value)) throw safeError();
    return value;
  }

  private changed(): State {
    if (!Number.isSafeInteger(this.state.revision + 1)) throw safeError();
    return { ...this.state, revision: this.state.revision + 1 };
  }

  private async directory() {
    if (!path.isAbsolute(this.dataDir)) throw safeError();
    await noSymlinks(this.dataDir);
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await noSymlinks(this.dataDir);
    const directory = await open(
      this.dataDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await directory.stat();
      if (
        !stat.isDirectory() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw safeError();
      await directory.chmod(0o700);
    } finally {
      await directory.close();
    }
  }

  private async readDisk(): Promise<
    { state: State; hash: string } | undefined
  > {
    await noSymlinks(this.file);
    let info;
    try {
      info = await lstat(this.file);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES)
      throw safeError();
    const handle = await open(
      this.file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > MAX_BYTES ||
        stat.dev !== info.dev ||
        stat.ino !== info.ino ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw safeError();
      // A bounded read also enforces the limit if the file grows after fstat.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > stat.size || length > MAX_BYTES) throw safeError();
      const text = buffer.subarray(0, length).toString("utf8");
      const state = StateSchema.parse(JSON.parse(text));
      await handle.chmod(0o600);
      return { state, hash: digest(text) };
    } finally {
      await handle.close();
    }
  }

  private async load() {
    if (this.initialized) return;
    await this.directory();
    const stored = await this.readDisk();
    // Recovery can follow a successful rename whose directory fsync failed. Confirm it
    // before adopting disk read flags; failed mutations never publish speculative state.
    const directory = await open(
      this.dataDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    const loaded = stored?.state ?? empty();
    const revisionFloor = this.state.revision + (this.error ? 1 : 0);
    if (!Number.isSafeInteger(revisionFloor)) throw safeError();
    this.state = {
      ...loaded,
      revision: Math.max(loaded.revision, revisionFloor),
    };
    this.diskDigest = stored?.hash;
    this.initialized = true;
    this.error = undefined;
  }

  private async commit(next: State) {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_BYTES) throw safeError();
    await this.directory();
    const current = await this.readDisk();
    if (current?.hash !== this.diskDigest) throw safeError();
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await noSymlinks(this.file);
      const checked = await this.readDisk();
      if (checked?.hash !== this.diskDigest) throw safeError();
      await rename(temporary, this.file);
      renamed = true;
      const directory = await open(
        this.dataDir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.diskDigest = digest(text);
      this.state = next;
      this.error = undefined;
    } catch (error) {
      // The rename may have succeeded before a directory-sync failure. Do not overwrite that uncertain state.
      if (renamed) this.initialized = false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private publish(added?: NotificationRecord) {
    for (const observer of this.observers) {
      try {
        observer(this.snapshot(), added && copy(added));
      } catch {
        /* UI/delivery listeners must not break persistence or other subscribers. */
      }
    }
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action).catch(() => {
      const error = safeError();
      this.error = error.message;
      if (Number.isSafeInteger(this.state.revision + 1))
        this.state = { ...this.state, revision: this.state.revision + 1 };
      this.publish();
      throw error;
    });
    this.tail = next.catch(() => {});
    return next;
  }
}
