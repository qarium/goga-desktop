import { TerminalInspectorError } from "./terminal-errors";
import {
  execFileSync,
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
  const invoke = (args: string[], timeout = 1000) => {
    verify();
    try {
      return JSON.parse(
        execute(helper, args, {
          shell: false,
          cwd: dirname(helper),
          encoding: "utf8",
          timeout,
          killSignal: "SIGTERM",
          maxBuffer: 16 * 1024 * 1024,
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
          windowsHide: true,
        }),
      );
    } catch {
      throw unavailable();
    }
  };
  const check = () => {
    verify();
    if (checked) return;
    const version = versionSchema.safeParse(invoke(["version"]));
    if (!version.success || version.data.arch !== process.arch)
      throw unavailable();
    checked = true;
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
  const get = () => {
    if (disposed) throw Error("Системный адаптер процессов терминала закрыт.");
    if (reader) return reader;
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
  return {
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
