import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
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
const busy = () =>
  Error(
    "Хранилище занято: владелец блокировки жив или неопределён. Повторите позже.",
  );
type Snapshot = {
  dev: number;
  ino: number;
  raw: string;
  owner: z.infer<typeof ownerSchema>;
};
async function snapshot(file: string): Promise<Snapshot | undefined> {
  await noSymlinks(file);
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 1024 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw busy();
    const raw = await handle.readFile("utf8");
    let owner;
    try {
      owner = ownerSchema.parse(JSON.parse(raw));
    } catch {
      throw busy();
    }
    return { dev: info.dev, ino: info.ino, raw, owner };
  } finally {
    await handle.close();
  }
}
async function same(file: string, expected: Snapshot) {
  let current;
  try {
    current = await snapshot(file);
  } catch {
    return false;
  }
  return (
    !!current &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.raw === expected.raw
  );
}
async function syncParent(file: string) {
  const handle = await open(
    path.dirname(file),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/**
 * Reclaims ONLY this versioned Desktop lock when signal 0 reports ESRCH.
 * A live/reused PID, EPERM, malformed/empty old lock, or changed inode/bytes is
 * never guessed stale. Portable Node cannot eliminate a hostile same-user race
 * between the final pinned comparison and unlink (there is no dirfd/unlinkat).
 */
export async function acquireOwnedLock(
  file: string,
  options: { attempts?: number; delayMs?: number } = {},
): Promise<{ release(): Promise<void> }> {
  const attempts = options.attempts ?? 100,
    delayMs = options.delayMs ?? 20;
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 1000 ||
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    delayMs > 1000
  )
    throw busy();
  let reclaimed = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await noSymlinks(file);
    let handle;
    try {
      handle = await open(
        file,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!reclaimed) {
        let old;
        try {
          old = await snapshot(file);
        } catch {
          throw busy();
        }
        if (old) {
          let dead = false;
          try {
            process.kill(old.owner.pid, 0);
          } catch (error) {
            dead = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
          if (dead && (await same(file, old))) {
            await noSymlinks(file);
            if (await same(file, old)) {
              await unlink(file);
              await syncParent(file);
              reclaimed = true;
              attempt--;
              continue;
            }
          }
        }
      }
      if (attempt === attempts - 1) throw busy();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    const raw = JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      nonce: randomUUID(),
    });
    try {
      await handle.writeFile(raw);
      await handle.sync();
      const info = await handle.stat();
      await syncParent(file);
      const owned: Snapshot = {
        dev: info.dev,
        ino: info.ino,
        raw,
        owner: ownerSchema.parse(JSON.parse(raw)),
      };
      if (!(await same(file, owned))) throw busy();
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          try {
            if (await same(file, owned)) {
              await noSymlinks(file);
              if (await same(file, owned)) {
                await unlink(file);
                await syncParent(file);
              }
            }
          } finally {
            await handle.close();
          }
        },
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  throw busy();
}
