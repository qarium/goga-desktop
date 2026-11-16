import { constants } from "node:fs";
import { mkdir, open, link, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { noSymlinks } from "./settings";
import { acquireOwnedLock } from "./owned-lock";

/** Errors must contain fixed user-facing text, never file contents or native error details. */
export class PrivateFileError extends Error {}
const MAX_BYTES = 16 * 1024 * 1024;
const tails = new Map<string, Promise<void>>();
/** Private, symlink-resistant local state. All reads and mutations use the same owned lock.
 * Actions are synchronous so no code can keep writing to a draft after publication. */
export class TerminalPrivateFile {
  private readonly root: string;
  private readonly file: string;
  private readonly lock: string;
  private known = false;
  private knownRaw: string | undefined;
  private readonly directories = new Map<
    string,
    { dev: number; ino: number }
  >();
  constructor(
    private readonly home: string,
    basename: "terminals" | "terminal-presets",
    private readonly messages: {
      invalid: string;
      conflict: string;
      unavailable: string;
    },
  ) {
    if (
      !path.isAbsolute(home) ||
      path.resolve(home) !== home ||
      /[\x00-\x1f\x7f]/.test(home)
    )
      throw this.invalid();
    this.root = path.join(home, ".goga", "desktop");
    this.file = path.join(this.root, basename + ".json");
    this.lock = path.join(this.root, "." + basename + ".lock");
  }
  private invalid() {
    return new PrivateFileError(this.messages.invalid);
  }
  private conflict() {
    return new PrivateFileError(this.messages.conflict);
  }
  private async directory(
    target: string,
    create: boolean,
    privateDirectory: boolean,
  ) {
    await noSymlinks(target);
    if (create)
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat(),
        old = this.directories.get(target);
      if (
        !info.isDirectory() ||
        (process.getuid && info.uid !== process.getuid()) ||
        (old && (old.ino !== info.ino || old.dev !== info.dev))
      )
        throw this.invalid();
      this.directories.set(target, { dev: info.dev, ino: info.ino });
      if (privateDirectory) await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  private async assertRoot() {
    await this.directory(this.home, false, false);
    await this.directory(path.join(this.home, ".goga"), true, false);
    await this.directory(this.root, true, true);
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const previous = tails.get(this.lock) ?? Promise.resolve();
    const work = previous.then(async () => {
      try {
        await this.assertRoot();
        const lock = await acquireOwnedLock(this.lock);
        try {
          await this.assertRoot();
          return await action();
        } finally {
          await lock.release();
        }
      } catch (e) {
        if (e instanceof PrivateFileError) throw e;
        throw new PrivateFileError(this.messages.unavailable);
      }
    });
    const tail = work.then(
      () => {},
      () => {},
    );
    tails.set(this.lock, tail);
    return work.finally(() => {
      if (tails.get(this.lock) === tail) tails.delete(this.lock);
    });
  }
  private async readText(): Promise<string | undefined> {
    await noSymlinks(this.file);
    let handle;
    try {
      handle = await open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (this.known && this.knownRaw !== undefined) throw this.invalid();
      return undefined;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > MAX_BYTES ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw this.invalid();
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw) > MAX_BYTES) throw this.invalid();
      return raw;
    } finally {
      await handle.close();
    }
  }
  private async install(value: unknown, expected: string | undefined) {
    const raw = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(raw) > MAX_BYTES) throw this.invalid();
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
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertRoot();
      if ((await this.readText()) !== expected) throw this.conflict();
      await noSymlinks(this.file);
      if (expected === undefined) {
        try {
          await link(temp, this.file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST")
            throw this.conflict();
          throw e;
        }
      } else await rename(temp, this.file);
      // Remove the temporary hardlink before the next nlink == 1 validation.
      await unlink(temp).catch((e) => {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      });
      const directory = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.known = true;
      this.knownRaw = raw;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  run<T>(
    act: (
      raw: string | undefined,
      changedSinceRead: boolean,
    ) => { value: T; next?: unknown },
  ): Promise<T> {
    return this.locked(async () => {
      const raw = await this.readText();
      const out = act(raw, this.known && this.knownRaw !== raw);
      if (out.next !== undefined) await this.install(out.next, raw);
      else {
        this.known = true;
        this.knownRaw = raw;
      }
      return out.value;
    });
  }
}
