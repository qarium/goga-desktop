import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { copyFileSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  createTerminalInspector,
  createIsolatedTerminalInspector,
} from "../src/host/terminal-inspector";

it("a real native reader retains its executable across a development rebuild", () => {
  const dir = mkdtempSync("/private/tmp/goga-inspector-rebuild-test-");
  const helper = join(dir, "terminal-inspect");
  const invocations: {
    operation: string;
    elapsedMs: number;
    outcome: string;
    stdoutBytes: number;
    stderrBytes?: number;
    validJson?: boolean;
  }[] = [];
  // Preserve every production option and propagate failures. Record only safe
  // metadata so cold-start/OS errors remain distinguishable from invalid JSON.
  const execute = (
    file: string,
    args: string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ) => {
    const started = performance.now();
    try {
      const result = execFileSync(file, args, options);
      let validJson = false;
      try {
        JSON.parse(result);
        validJson = true;
      } catch {
        /* Adapter must still reject it. */
      }
      invocations.push({
        operation: args[0],
        elapsedMs: Math.round(performance.now() - started),
        outcome: "ok",
        stdoutBytes: Buffer.byteLength(result),
        validJson,
      });
      return result;
    } catch (error) {
      const failure = error as {
        code?: string;
        status?: number;
        signal?: string;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      invocations.push({
        operation: args[0],
        elapsedMs: Math.round(performance.now() - started),
        stdoutBytes: Buffer.byteLength(failure.stdout ?? ""),
        stderrBytes: Buffer.byteLength(failure.stderr ?? ""),
        outcome: `${failure.code ?? "exit"}/${failure.status ?? "none"}/${failure.signal ?? "none"}`,
      });
      throw error;
    }
  };
  const isolated = createIsolatedTerminalInspector(helper, { execute });
  try {
    execFileSync(
      "/usr/bin/clang",
      [
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        resolve("src/native/terminal-inspect.c"),
        "-lproc",
        "-o",
        helper,
      ],
      {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: dir,
          TMPDIR: dir,
          LANG: "C",
          LC_ALL: "C",
        },
        timeout: 10000,
        killSignal: "SIGTERM",
        stdio: "pipe",
      },
    );
    const old = createTerminalInspector(helper, { execute });
    old.check!();
    isolated.check!();
    const before = isolated.birth(process.pid);
    expect(before).toMatchObject({ pid: process.pid });
    copyFileSync(helper, join(dir, "replacement"));
    renameSync(join(dir, "replacement"), helper);
    // Reproduces the old app's refusal, without touching the live app or any PTY.
    expect(() => old.birth(process.pid)).toThrow(/изменился/);
    expect(isolated.birth(process.pid)).toEqual(before);
  } catch (error) {
    throw new Error(
      `Native rebuild check failed: ${JSON.stringify(invocations)}`,
      { cause: error },
    );
  } finally {
    isolated.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
