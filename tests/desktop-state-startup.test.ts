import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  LegacyDesktopStateLockError,
  acquireDesktopStateLock,
} from "../src/host/desktop-state-lock";
import {
  handleDesktopStartupFailure,
  inspectLegacyDesktopLock,
} from "../src/main/desktop-state-startup";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function legacyError() {
  const root = await fs.mkdtemp("/private/tmp/goga-state-startup-");
  roots.push(root);
  const file = path.join(root, ".write.lock");
  await fs.writeFile(file, "", { mode: 0o600 });
  try {
    await acquireDesktopStateLock(file, { attempts: 1 });
  } catch (e) {
    return e as LegacyDesktopStateLockError;
  }
  throw Error("Expected legacy error");
}
function deps(approve = true) {
  return {
    confirmRecovery: vi.fn(async () => approve),
    recover: vi.fn(async () => "/fixture/backup"),
    showError: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  };
}
it("offers explicit recovery only for a recognized legacy lock; cancel changes nothing", async () => {
  const error = await legacyError(),
    d = deps(false);
  await handleDesktopStartupFailure(error, d);
  expect(d.confirmRecovery).toHaveBeenCalledOnce();
  expect(d.recover).not.toHaveBeenCalled();
  expect(d.relaunch).not.toHaveBeenCalled();
  expect(d.exit).toHaveBeenCalledWith(1);
  expect((await fs.stat(error.snapshot.file)).size).toBe(0);
});
it("relaunches only after confirmed recovery has completed, never retrying partial Host initialization", async () => {
  const error = await legacyError(),
    d = deps();
  let release!: () => void;
  d.recover.mockImplementation(
    () =>
      new Promise<string>((done) => {
        release = () => done("/fixture/backup");
      }),
  );
  const pending = handleDesktopStartupFailure(error, d);
  await vi.waitFor(() =>
    expect(d.recover).toHaveBeenCalledWith(error.snapshot),
  );
  expect(d.relaunch).not.toHaveBeenCalled();
  expect(d.exit).not.toHaveBeenCalled();
  release();
  await pending;
  expect(d.relaunch).toHaveBeenCalledOnce();
  expect(d.exit).toHaveBeenCalledWith(0);
});
it("leaves recovery failures visible and never restarts or resets data", async () => {
  const error = await legacyError(),
    d = deps();
  d.recover.mockRejectedValue(Error("unknown owner"));
  await handleDesktopStartupFailure(error, d);
  expect(d.showError).toHaveBeenCalledWith(
    expect.stringMatching(/Восстановление не выполнено/),
  );
  expect(d.relaunch).not.toHaveBeenCalled();
  expect(d.exit).toHaveBeenCalledWith(1);
  expect((await fs.stat(error.snapshot.file)).size).toBe(0);
});
it("does not offer lock recovery for unrelated startup failures", async () => {
  const d = deps();
  await handleDesktopStartupFailure(Error("Synthetic startup failure"), d);
  expect(d.confirmRecovery).not.toHaveBeenCalled();
  expect(d.recover).not.toHaveBeenCalled();
  expect(d.showError).toHaveBeenCalledWith(
    expect.stringContaining("Synthetic startup failure"),
  );
  expect(d.exit).toHaveBeenCalledWith(1);
});
it.each([
  [null, "123\n456\n", "", "busy"],
  [{ code: 1 }, "", "", "free"],
  [{ code: 1 }, "", "permission warning", "unknown"],
  [{ code: "ENOENT" }, "", "", "unknown"],
  [{ code: "ETIMEDOUT" }, "", "", "unknown"],
  [{ code: 1, killed: true }, "", "", "unknown"],
  [{ code: 1, signal: "SIGTERM" }, "", "", "unknown"],
  [{ code: 1 }, "  ", "", "unknown"],
  [null, "not-pids", "", "unknown"],
  [null, "", "", "unknown"],
] as const)(
  "interprets bounded open-file diagnostics conservatively: %j %j %j",
  async (error, stdout, stderr, expected) => {
    vi.mocked(execFile).mockImplementation(((
      _bin: any,
      _args: any,
      _opts: any,
      callback: any,
    ) => {
      callback(error, stdout, stderr);
    }) as any);
    expect(await inspectLegacyDesktopLock("/fixture/.write.lock")).toBe(
      expected,
    );
    const [bin, args, options] = vi.mocked(execFile).mock.calls[0] as any;
    expect(bin).toBe("/usr/sbin/lsof");
    expect(args.at(-1)).toBe("/fixture/.write.lock");
    expect(args.indexOf("+w")).toBeGreaterThan(args.indexOf("-t"));
    expect(options.timeout).toBeLessThanOrEqual(5000);
    expect(options.maxBuffer).toBeLessThanOrEqual(128 * 1024);
    expect(options.env).not.toHaveProperty("TOKEN");
  },
);
