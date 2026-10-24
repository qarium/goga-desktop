import { TerminalInspectorError } from "./terminal-errors";
import {
  execFileSync,
  execFile,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  lstatSync,
  realpathSync,
  mkdtempSync,
  copyFileSync,
  chmodSync,
  rmSync,
  constants,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, normalize, join } from "node:path";
import { z } from "zod";
import type { TerminalInspector } from "./terminal-native";
const versionSchema = z
  .object({
    version: z.literal(1),
    platform: z.literal("darwin"),
    arch: z.enum(["arm64", "x64"]),
  })
  .strict();
/** Fixed application-bundled executable; caller supplies no commands, cwd or env. */
export function createTerminalInspector(
  helper: string,
  options: {
    executeAsync?: (
      file: string,
      args: string[],
      options: ExecFileSyncOptionsWithStringEncoding & { signal: AbortSignal },
    ) => Promise<string>;
    execute?: (
      file: string,
      args: string[],
      options: ExecFileSyncOptionsWithStringEncoding,
    ) => string;
  } = {},
): TerminalInspector {
  const execute =
    options.execute ??
    ((file, args, options) => execFileSync(file, args, options));
  const executeAsync =
    options.executeAsync ??
    ((file, args, settings) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          file,
          args,
          { ...settings, encoding: "utf8" },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(stdout);
          },
        );
      }));
  let preparing: Promise<void> | undefined;
  let pin: string | undefined,
    checked = false;
  const unavailable = () => new TerminalInspectorError("unavailable");
  const verify = () => {
    try {
      if (
        !isAbsolute(helper) ||
        normalize(helper) !== helper ||
        realpathSync(helper) !== helper
      )
        throw Error();
      const s = lstatSync(helper, { bigint: true });
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.nlink !== 1n ||
        (s.mode & 0o111n) === 0n ||
        (s.mode & 0o022n) !== 0n
      )
        throw Error();
      const identity = [
        s.dev,
        s.ino,
        s.size,
        s.mtimeNs,
        s.ctimeNs,
        s.uid,
        s.mode,
      ].join(":");
      if (pin && identity !== pin) throw new TerminalInspectorError("changed");
      pin = identity;
    } catch (error) {
      if (error instanceof TerminalInspectorError) throw error;
      throw unavailable();
    }
  };
  const settings = (
    timeout: number,
  ): ExecFileSyncOptionsWithStringEncoding => ({
    shell: false,
    cwd: dirname(helper),
    encoding: "utf8",
    timeout,
    killSignal: "SIGTERM",
    maxBuffer: 16 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    windowsHide: true,
  });
  const invoke = (args: string[], timeout = 1000) => {
    verify();
    try {
      return JSON.parse(execute(helper, args, settings(timeout)));
    } catch {
      throw unavailable();
    }
  };
  const check = () => {
    verify();
    if (checked) return;
    if (preparing) throw unavailable();
    const version = versionSchema.safeParse(invoke(["version"]));
    if (!version.success || version.data.arch !== process.arch)
      throw unavailable();
    checked = true;
  };
  // Only cold readiness gets a separate asynchronous budget. Working PID/TTY
  // inspection and shutdown continue using the strict synchronous deadline.
  const prepare = async (budget = 5000): Promise<void> => {
    verify();
    if (checked) return;
    if (preparing) return preparing;
    if (!Number.isInteger(budget) || budget < 1 || budget > 5000)
      throw unavailable();
    const deadline = performance.now() + budget;
    preparing = (async () => {
      const abort = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(unavailable());
          }, budget);
        });
        let result: string;
        try {
          result = await Promise.race([
            executeAsync(helper, ["version"], {
              ...settings(budget),
              signal: abort.signal,
            }),
            expired,
          ]);
        } catch {
          throw unavailable();
        }
        if (performance.now() >= deadline) throw unavailable();
        verify();
        let version: ReturnType<typeof versionSchema.safeParse>;
        try {
          version = versionSchema.safeParse(JSON.parse(result));
        } catch {
          throw unavailable();
        }
        if (!version.success || version.data.arch !== process.arch)
          throw unavailable();
        checked = true;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    try {
      await preparing;
    } finally {
      preparing = undefined;
    }
  };
  const read = (kind: string, pid: number, timeout = 1000) => {
    if (!Number.isInteger(pid) || pid < 2 || pid > 2147483647)
      throw unavailable();
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 1000)
      throw unavailable();
    check();
    return invoke([kind, String(pid)], timeout);
  };
  return {
    prepare,
    check,
    birth: (pid, timeout) => read("birth", pid, timeout),
    root: (pid, timeout) => read("root", pid, timeout),
    snapshot: (pid) => read("snapshot", pid),
  };
}

/** Development builds replace their output in place. Keep a private, independently
 * pinned copy for the lifetime of this app, never repin a live inspector to a new
 * executable. No PTY is started here; copying/version checks are lazy.
 */
export function createIsolatedTerminalInspector(
  helper: string,
  options: Parameters<typeof createTerminalInspector>[1] = {},
): TerminalInspector & { dispose(): void } {
  let reader: TerminalInspector | undefined;
  let directory: string | undefined;
  let disposed = false;
  let preparing: Promise<void> | undefined;
  const get = () => {
    if (disposed) throw Error("Системный адаптер процессов терминала закрыт.");
    if (reader) return reader;
    if (preparing) throw new TerminalInspectorError("unavailable");
    const source = createTerminalInspector(helper, options);
    source.check!();
    const dir = mkdtempSync(
      join(realpathSync(tmpdir()), "goga-terminal-inspector-"),
    );
    try {
      const retained = join(dir, "terminal-inspect");
      copyFileSync(helper, retained, constants.COPYFILE_EXCL);
      chmodSync(retained, 0o700);
      // Detect a rebuild/replacement during copying instead of adopting unknown bytes.
      source.check!();
      const candidate = createTerminalInspector(retained, options);
      candidate.check!();
      directory = dir;
      reader = candidate;
      return candidate;
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  };
  const prepare = async (budget = 5000): Promise<void> => {
    if (disposed) throw new TerminalInspectorError("unavailable");
    if (reader) return reader.prepare!(budget);
    if (preparing) return preparing;
    if (!Number.isInteger(budget) || budget < 1 || budget > 5000)
      throw new TerminalInspectorError("unavailable");
    const deadline = performance.now() + budget;
    const remaining = () => {
      const left = Math.floor(deadline - performance.now());
      if (disposed || left < 1) throw new TerminalInspectorError("unavailable");
      return left;
    };
    preparing = (async () => {
      const source = createTerminalInspector(helper, options);
      await source.prepare!(remaining());
      remaining();
      source.check!();
      const dir = mkdtempSync(
        join(realpathSync(tmpdir()), "goga-terminal-inspector-"),
      );
      try {
        const retained = join(dir, "terminal-inspect");
        copyFileSync(helper, retained, constants.COPYFILE_EXCL);
        chmodSync(retained, 0o700);
        source.check!();
        const candidate = createTerminalInspector(retained, options);
        await candidate.prepare!(remaining());
        remaining();
        source.check!();
        candidate.check!();
        directory = dir;
        reader = candidate;
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    })();
    try {
      await preparing;
    } finally {
      preparing = undefined;
    }
  };
  return {
    prepare,
    check: () => get().check!(),
    birth: (pid, timeout) => get().birth(pid, timeout),
    root: (pid, timeout) => get().root(pid, timeout),
    snapshot: (pid) => get().snapshot(pid),
    dispose: () => {
      disposed = true;
      if (directory) {
        try {
          rmSync(directory, { recursive: true, force: true });
        } catch {
          // All owned processes are already stopped. Cache cleanup must not
          // turn successful shutdown into an unrecoverable finalize failure.
        }
        directory = undefined;
      }
    },
  };
}
