import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireOwnedLock } from "../src/host/owned-lock";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});
async function setup() {
  const root = await fs.mkdtemp(
    "/private/tmp/goga-context-ab-research-20261019-impl-clones-locks-",
  );
  return { root, file: path.join(root, ".owned.lock") };
}
const metadata = (pid: number) =>
  JSON.stringify({ schemaVersion: 1, pid, nonce: randomUUID() });
afterEach(() => vi.restoreAllMocks());
describe("recoverable new Desktop ownership locks", () => {
  it("writes restrictive PID/nonce metadata and releases only its own lock", async () => {
    const { file } = await setup(),
      lock = await acquireOwnedLock(file);
    const owner = JSON.parse(await fs.readFile(file, "utf8"));
    expect(owner).toMatchObject({
      schemaVersion: 1,
      pid: process.pid,
      nonce: expect.any(String),
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await lock.release();
    expect(await fs.stat(file).catch(() => null)).toBe(null);
  });
  it("reclaims only a well-formed lock whose owner PID is definitely dead", async () => {
    const { file } = await setup();
    await fs.writeFile(file, metadata(2147483647), { mode: 0o600 });
    const lock = await acquireOwnedLock(file, { attempts: 1, delayMs: 0 });
    expect(JSON.parse(await fs.readFile(file, "utf8")).pid).toBe(process.pid);
    await lock.release();
  });
  it.each(["live", "reused", "malformed", "legacy-empty"])(
    "refuses %s owner metadata without unlinking it",
    async (kind) => {
      const { file } = await setup();
      const raw =
        kind === "legacy-empty"
          ? ""
          : kind === "malformed"
            ? '{"pid":2147483647}'
            : metadata(process.pid);
      await fs.writeFile(file, raw, { mode: 0o600 });
      await expect(
        acquireOwnedLock(file, { attempts: 1, delayMs: 0 }),
      ).rejects.toThrow(/занят|неопредел|блокиров/);
      expect(await fs.readFile(file, "utf8")).toBe(raw);
    },
  );
  it("never removes a replacement that appears while a dead PID is being checked", async () => {
    const { file } = await setup();
    await fs.writeFile(file, metadata(2147483647), { mode: 0o600 });
    const replacement = metadata(process.pid);
    vi.spyOn(process, "kill").mockImplementation(() => {
      renameSync(file, `${file}.preserved`);
      writeFileSync(file, replacement, { mode: 0o600 });
      throw Object.assign(Error("dead"), { code: "ESRCH" });
    });
    await expect(
      acquireOwnedLock(file, { attempts: 1, delayMs: 0 }),
    ).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(replacement);
  });
  it("does not unlink a same-inode lock whose contents were changed before release", async () => {
    const { file } = await setup(),
      lock = await acquireOwnedLock(file),
      replacement = metadata(process.pid);
    await fs.writeFile(file, replacement);
    await lock.release();
    expect(await fs.readFile(file, "utf8")).toBe(replacement);
  });
});

describe("ownership lock admission race", () => {
  it("does not enter a critical section if its newly written lock was replaced before admission", async () => {
    const { file } = await setup(),
      replacement = metadata(process.pid);
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(fs.link).mockImplementationOnce(async (candidate, target) => {
      await actual.link(candidate, target);
      await actual.rename(file, `${file}.preserved`);
      await actual.writeFile(file, replacement, { mode: 0o600 });
    });
    await expect(acquireOwnedLock(file)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(replacement);
  });
});

describe("atomic ownership publication", () => {
  it.each(["writeFile", "sync"] as const)(
    "does not publish a lock when preparation %s fails",
    async (method) => {
      const { file, root } = await setup();
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        handle[method] = async () => {
          throw Error("injected preparation failure");
        };
        return handle;
      });
      await expect(acquireOwnedLock(file)).rejects.toThrow(
        "injected preparation failure",
      );
      expect(await fs.stat(file).catch(() => null)).toBeNull();
      expect(await fs.readdir(root)).toEqual([]);
      const retry = await acquireOwnedLock(file);
      await retry.release();
    },
  );
  it("keeps the final path absent until owner metadata has been fully written and synced", async () => {
    const { file } = await setup();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let observed = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args),
        sync = handle.sync.bind(handle);
      handle.sync = async () => {
        expect(await actual.stat(file).catch(() => null)).toBeNull();
        await sync();
        observed = true;
      };
      return handle;
    });
    const lock = await acquireOwnedLock(file);
    expect(observed).toBe(true);
    await lock.release();
  });
});

it("recovers a dead owner interrupted after atomic publication before candidate cleanup", async () => {
  const { file, root } = await setup();
  const raw = metadata(2147483647),
    candidate = `${file}.${JSON.parse(raw).nonce}.prepared`;
  await fs.writeFile(candidate, raw, { mode: 0o600 });
  await fs.link(candidate, file);
  const lock = await acquireOwnedLock(file, { attempts: 1 });
  expect(await fs.stat(candidate).catch(() => null)).toBeNull();
  await lock.release();
  expect(await fs.readdir(root)).toEqual([]);
});
it("rejects an unrelated extra hard link rather than trusting nlink=2", async () => {
  const { file, root } = await setup();
  const raw = metadata(2147483647);
  await fs.writeFile(file, raw, { mode: 0o600 });
  await fs.link(file, path.join(root, "untrusted"));
  await expect(acquireOwnedLock(file, { attempts: 1 })).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe(raw);
});
it("never overwrites a contender and cleans its own preparation", async () => {
  const { file, root } = await setup();
  const first = await acquireOwnedLock(file);
  const original = await fs.readFile(file, "utf8");
  await expect(acquireOwnedLock(file, { attempts: 1 })).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe(original);
  expect(await fs.readdir(root)).toEqual([path.basename(file)]);
  await first.release();
});
it("published metadata is complete even before the second name is removed", async () => {
  const { file } = await setup();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(fs.link).mockImplementationOnce(async (candidate, target) => {
    await actual.link(candidate, target);
    expect(JSON.parse(await actual.readFile(file, "utf8"))).toMatchObject({
      pid: process.pid,
    });
    await expect(acquireOwnedLock(file, { attempts: 1 })).rejects.toThrow();
  });
  const lock = await acquireOwnedLock(file);
  await lock.release();
});
it("rolls back publication when closing the preparation handle fails", async () => {
  const { file, root } = await setup();
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args),
      close = handle.close.bind(handle);
    let failed = false;
    handle.close = async () => {
      if (!failed) {
        failed = true;
        throw Error("injected close failure");
      }
      await close();
    };
    return handle;
  });
  await expect(acquireOwnedLock(file)).rejects.toThrow(
    "injected close failure",
  );
  expect(await fs.stat(file).catch(() => null)).toBeNull();
  expect(await fs.readdir(root)).toEqual([]);
});
