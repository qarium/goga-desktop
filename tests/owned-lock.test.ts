import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireOwnedLock } from "../src/host/owned-lock";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
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
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args),
        sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await actual.rename(file, `${file}.preserved`);
        await actual.writeFile(file, replacement, { mode: 0o600 });
      };
      return handle;
    });
    await expect(acquireOwnedLock(file)).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(replacement);
  });
});
