import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  symlinkSync,
  renameSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTerminalInspector,
  createIsolatedTerminalInspector,
} from "../src/host/terminal-inspector";
const roots: string[] = [];
afterEach(() => {
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync("/private/tmp/goga-terminal-inspector-");
  roots.push(dir);
  const file = join(dir, "inspect");
  writeFileSync(file, "synthetic-binary", { mode: 0o700 });
  const exec = vi.fn((_file: string, args: string[], _options: unknown) =>
    JSON.stringify(
      args[0] === "version"
        ? { version: 1, platform: "darwin", arch: process.arch }
        : { ok: false },
    ),
  );
  return { dir, file, exec };
}
it("uses one pinned executable, strict arguments and a minimal environment, never a shell", () => {
  const f = fixture(),
    reader = createTerminalInspector(f.file, { execute: f.exec });
  reader.check!();
  reader.birth(200);
  reader.root(200);
  reader.snapshot(200);
  expect(f.exec.mock.calls.map((c) => c[1])).toEqual([
    ["version"],
    ["birth", "200"],
    ["root", "200"],
    ["snapshot", "200"],
  ]);
  for (const [file, , options] of f.exec.mock.calls) {
    expect(file).toBe(f.file);
    expect(options).toMatchObject({
      shell: false,
      encoding: "utf8",
      killSignal: "SIGTERM",
      timeout: 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    });
    expect(Object.keys((options as any).env)).toHaveLength(3);
  }
});
it("rejects missing, non-executable, symlink or group-writable helper before execution", () => {
  for (const mode of ["missing", "not-executable", "symlink", "writable"]) {
    const f = fixture();
    if (mode === "missing") rmSync(f.file);
    if (mode === "not-executable") chmodSync(f.file, 0o600);
    if (mode === "writable") chmodSync(f.file, 0o720);
    if (mode === "symlink") {
      renameSync(f.file, join(f.dir, "target"));
      symlinkSync("target", f.file);
    }
    expect(() =>
      createTerminalInspector(f.file, { execute: f.exec }).check!(),
    ).toThrow();
    expect(f.exec).not.toHaveBeenCalled();
  }
});
it("refuses replacement or modification after preflight, before another invocation", () => {
  for (const replace of [false, true]) {
    const f = fixture(),
      reader = createTerminalInspector(f.file, { execute: f.exec });
    reader.check!();
    f.exec.mockClear();
    if (replace) {
      renameSync(f.file, join(f.dir, "old"));
      writeFileSync(f.file, "replacement", { mode: 0o700 });
    } else writeFileSync(f.file, "modified-binary-size");
    expect(() => reader.snapshot(200)).toThrow();
    expect(f.exec).not.toHaveBeenCalled();
  }
});
it("rejects unsafe PID values and unsupported helper protocol/architecture", () => {
  const f = fixture(),
    reader = createTerminalInspector(f.file, { execute: f.exec });
  reader.check!();
  f.exec.mockClear();
  for (const pid of [0, 1, -200, 200.5, Infinity, 2147483648])
    expect(() => reader.birth(pid)).toThrow();
  expect(f.exec).not.toHaveBeenCalled();
  for (const result of [
    { version: 2, platform: "darwin", arch: process.arch },
    { version: 1, platform: "linux", arch: process.arch },
    { version: 1, platform: "darwin", arch: "unknown" },
  ]) {
    const f = fixture();
    f.exec.mockReturnValue(JSON.stringify(result));
    expect(() =>
      createTerminalInspector(f.file, { execute: f.exec }).check!(),
    ).toThrow();
  }
});
it("hides child stderr and malformed JSON, never falls back to ps or shell commands", () => {
  const f = fixture(),
    reader = createTerminalInspector(f.file, { execute: f.exec });
  reader.check!();
  f.exec.mockImplementation(() => {
    throw Error("synthetic-secret/native diagnostic");
  });
  expect(() => reader.snapshot(200)).toThrow(/процесс|адаптер/i);
  expect(() => reader.snapshot(200)).not.toThrow("synthetic-secret");
  f.exec.mockReturnValue("not-json");
  expect(() => reader.root(200)).toThrow();
});

it("keeps a private pinned helper through a rebuild, and removes it only on disposal", () => {
  const f = fixture();
  const reader = createIsolatedTerminalInspector(f.file, { execute: f.exec });
  expect(f.exec).not.toHaveBeenCalled();
  reader.check!();
  const retained = f.exec.mock.calls.at(-1)![0];
  expect(retained).not.toBe(f.file);
  expect(statSync(retained).nlink).toBe(1);
  expect(statSync(retained).mode & 0o077).toBe(0);
  expect(statSync(join(retained, "..")).mode & 0o077).toBe(0);
  renameSync(f.file, join(f.dir, "old"));
  writeFileSync(f.file, "rebuilt-helper", { mode: 0o700 });
  f.exec.mockClear();
  reader.snapshot(200);
  expect(f.exec.mock.calls[0][0]).toBe(retained);
  expect(readFileSync(retained, "utf8")).toBe("synthetic-binary");
  reader.dispose();
  expect(existsSync(retained)).toBe(false);
  expect(readFileSync(f.file, "utf8")).toBe("rebuilt-helper");
  expect(() => reader.snapshot(200)).toThrow();
  reader.dispose();
});
it("still refuses replacement of the retained helper without executing it", () => {
  const f = fixture();
  const reader = createIsolatedTerminalInspector(f.file, { execute: f.exec });
  try {
    reader.check!();
    const retained = f.exec.mock.calls.at(-1)![0];
    writeFileSync(retained, "tampered");
    f.exec.mockClear();
    expect(() => reader.snapshot(200)).toThrow();
    expect(f.exec).not.toHaveBeenCalled();
  } finally {
    reader.dispose();
  }
});

it("does not retain a helper replaced while preparing its private copy", () => {
  const f = fixture();
  const normal = f.exec.getMockImplementation()!;
  let first = true;
  f.exec.mockImplementation((file, args, options) => {
    const result = normal(file, args, options);
    if (first) {
      first = false;
      writeFileSync(f.file, "replacement-before-copy");
    }
    return result;
  });
  const reader = createIsolatedTerminalInspector(f.file, { execute: f.exec });
  try {
    expect(() => reader.check!()).toThrow(/изменился/);
    expect(f.exec).toHaveBeenCalledTimes(1);
  } finally {
    reader.dispose();
  }
});
it("cache cleanup failure cannot block an otherwise completed shutdown", () => {
  const f = fixture();
  const reader = createIsolatedTerminalInspector(f.file, { execute: f.exec });
  reader.check!();
  const dir = join(f.exec.mock.calls.at(-1)![0], "..");
  chmodSync(dir, 0o500);
  try {
    expect(() => reader.dispose()).not.toThrow();
    expect(() => reader.snapshot(200)).toThrow();
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
