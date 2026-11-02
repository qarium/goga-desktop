import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { noSymlinks } from "./settings";

const ownerSchema = z
  .object({
    schemaVersion: z.literal(1),
    pid: z.number().int().min(1).max(2147483647),
    nonce: z.string().uuid(),
  })
  .strict();
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const privateMode = (s: { mode: number; uid: number }) =>
  !(s.mode & 0o077) && (!process.getuid || s.uid === process.getuid());
export class DesktopStateLockBusyError extends Error {
  constructor() {
    super(
      "Хранилище Desktop занято: владелец блокировки работает или не может быть подтверждён. Повторите позже.",
    );
  }
}
export interface LegacyLockSnapshot {
  file: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}
export class LegacyDesktopStateLockError extends DesktopStateLockBusyError {
  constructor(readonly snapshot: LegacyLockSnapshot) {
    super();
    this.message =
      "Обнаружена блокировка хранилища Desktop от предыдущей версии. Требуется подтверждённое восстановление.";
  }
}
const busy = () => new DesktopStateLockBusyError();
type Owner = z.infer<typeof ownerSchema>;
type Owned = {
  dev: number;
  ino: number;
  name: string;
  raw: string;
  owner: Owner;
  fileDev: number;
  fileIno: number;
};
function validPath(file: string) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw busy();
}
async function syncDirectory(dir: string) {
  await noSymlinks(dir);
  const fd = await open(
    dir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function stat(file: string) {
  try {
    return await lstat(file);
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}
async function legacySnapshot(
  file: string,
): Promise<LegacyLockSnapshot | undefined> {
  await noSymlinks(file);
  const info = await stat(file);
  if (
    !info?.isFile() ||
    info.nlink !== 1 ||
    info.size !== 0 ||
    !privateMode(info)
  )
    return undefined;
  return {
    file,
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
  };
}
async function readOwner(dir: string): Promise<Owned | undefined> {
  await noSymlinks(dir);
  const info = await stat(dir);
  if (!info) return undefined;
  if (info.isFile()) {
    const legacy = await legacySnapshot(dir);
    if (legacy) throw new LegacyDesktopStateLockError(Object.freeze(legacy));
    throw busy();
  }
  if (!info.isDirectory() || !privateMode(info)) throw busy();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (missing(e) || code(e) === "ENOTDIR") return undefined;
    throw e;
  }
  if (!entries.length) return undefined; // release crashed after removing its owner
  if (entries.length !== 1 || !/^owner\.[0-9a-f-]{36}\.json$/.test(entries[0]))
    throw busy();
  const file = path.join(dir, entries[0]);
  await noSymlinks(file);
  let fd;
  try {
    fd = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if (missing(e) || code(e) === "ENOTDIR") return undefined;
    throw e;
  }
  try {
    const f = await fd.stat();
    // Another cooperating reclaimer may unlink this exact owner after open.
    // The detached FD is not an unknown/live owner; retry publication instead.
    if (f.isFile() && f.nlink === 0) return undefined;
    if (!f.isFile() || f.nlink !== 1 || f.size > 1024 || !privateMode(f))
      throw busy();
    const buffer = Buffer.alloc(1025);
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 1024) throw busy();
    const raw = buffer.subarray(0, bytesRead).toString("utf8");
    let owner: Owner;
    try {
      owner = ownerSchema.parse(JSON.parse(raw));
    } catch {
      throw busy();
    }
    if (entries[0] !== `owner.${owner.nonce}.json`) throw busy();
    const current = await stat(dir);
    if (
      !current?.isDirectory() ||
      current.dev !== info.dev ||
      current.ino !== info.ino
    )
      return undefined;
    return {
      dev: info.dev,
      ino: info.ino,
      name: entries[0],
      raw,
      owner,
      fileDev: f.dev,
      fileIno: f.ino,
    };
  } finally {
    await fd.close();
  }
}
async function removeOwned(dir: string, expected: Owned) {
  const current = await readOwner(dir);
  if (
    !current ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.fileDev !== expected.fileDev ||
    current.fileIno !== expected.fileIno ||
    current.raw !== expected.raw
  )
    return;
  // Each publication has a unique child name. A late reclaimer/releaser cannot
  // unlink a new owner's child. rmdir never removes a non-empty replacement.
  await unlink(path.join(dir, expected.name)).catch((e) => {
    if (!missing(e) && code(e) !== "ENOTDIR") throw e;
  });
  await rmdir(dir).catch((e) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(code(e) ?? ""))
      throw e;
  });
  await syncDirectory(path.dirname(dir));
}

/** Desktop settings only. No TTL eviction, no changes to Git's owned-lock.
 * Atomic publication of a NONEMPTY directory avoids incomplete owner files.
 * Unique owner children + rmdir protect cooperating concurrent reclaimers.
 * As elsewhere, portable Node cannot defend hostile same-UID ancestor swaps. */
export async function acquireDesktopStateLock(
  file: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<{ release(): Promise<void> }> {
  validPath(file);
  const attempts = options.attempts ?? 100,
    delayMs = options.delayMs ?? 20;
  if (
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 1000 ||
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    delayMs > 1000
  )
    throw busy();
  await noSymlinks(file);
  const parent = await lstat(path.dirname(file));
  if (!parent.isDirectory() || !privateMode(parent)) throw busy();
  const nonce = randomUUID(),
    candidate = `${file}.${nonce}.prepared`;
  await noSymlinks(candidate);
  await mkdir(candidate, { mode: 0o700 });
  let prepared: Owned | undefined,
    published = false,
    admitted = false;
  try {
    const owner = { schemaVersion: 1 as const, pid: process.pid, nonce };
    const fd = await open(
      path.join(candidate, `owner.${nonce}.json`),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.writeFile(JSON.stringify(owner));
      await fd.sync();
    } finally {
      await fd.close();
    }
    await syncDirectory(candidate);
    prepared = await readOwner(candidate);
    if (!prepared) throw busy();
    const publish = async () => {
      await noSymlinks(file);
      // rename may replace an EMPTY directory. Validate that directory before
      // publication too, not only owners of a nonempty directory afterwards.
      const target = await stat(file);
      if (target?.isDirectory() && !privateMode(target)) throw busy();
      try {
        await rename(candidate, file);
        published = true;
        return true;
      } catch (e) {
        if (["EEXIST", "ENOTEMPTY", "ENOTDIR"].includes(code(e) ?? ""))
          return false;
        throw e;
      }
    };
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (!(await publish())) {
        let old: Owned | undefined;
        try {
          old = await readOwner(file);
        } catch (e) {
          if (e instanceof LegacyDesktopStateLockError) throw e;
          if (!(e instanceof DesktopStateLockBusyError)) throw e;
        }
        let dead = false;
        if (old) {
          try {
            process.kill(old.owner.pid, 0);
          } catch (e) {
            dead = code(e) === "ESRCH";
          }
          if (dead) await removeOwned(file, old);
        }
        if ((old && !dead) || !(await publish())) {
          if (attempt === attempts - 1) throw busy();
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
      }
      await syncDirectory(path.dirname(file));
      const checked = await readOwner(file);
      if (
        !checked ||
        checked.ino !== prepared.ino ||
        checked.dev !== prepared.dev ||
        checked.raw !== prepared.raw
      )
        throw busy();
      admitted = true;
      let released = false;
      return {
        release: async () => {
          if (!released) {
            await removeOwned(file, prepared!);
            released = true;
          }
        },
      };
    }
    throw busy();
  } finally {
    if (!admitted && published && prepared) await removeOwned(file, prepared);
    if (!published && prepared) await removeOwned(candidate, prepared);
  }
}

export type LegacyLockInspection = "free" | "busy" | "unknown";
export async function recoverLegacyDesktopStateLock(
  expected: LegacyLockSnapshot,
  inspectOpen: (file: string) => Promise<LegacyLockInspection>,
): Promise<string> {
  validPath(expected.file);
  const gate = await acquireDesktopStateLock(`${expected.file}.recovery`);
  const same = async () => {
    const current = await legacySnapshot(expected.file);
    if (
      !current ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.mtimeMs !== expected.mtimeMs ||
      current.ctimeMs !== expected.ctimeMs
    )
      throw busy();
  };
  try {
    await same();
    if ((await inspectOpen(expected.file)) !== "free") throw busy();
    await same();
    const backup = `${expected.file}.recovered-${randomUUID()}`;
    await noSymlinks(backup);
    const fd = await open(
      backup,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await syncDirectory(path.dirname(backup));
    if ((await inspectOpen(expected.file)) !== "free") throw busy();
    await same();
    // unlink cannot remove a modern directory lock even if publication raced us.
    await unlink(expected.file);
    await syncDirectory(path.dirname(expected.file));
    return backup;
  } finally {
    await gate.release();
  }
}
