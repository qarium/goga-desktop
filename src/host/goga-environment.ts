import path from "node:path";
import { userInfo } from "node:os";
import type { Runner } from "./process";
import type { ProjectEnvironmentEntry } from "./desktop-state";
import { readSignal, withReadScope } from "./read-scope";

/** Only PATH is imported. A fixed script never evaluates an executable, argv or project env. */
export function createGogaPathReader(
  home: string,
  runner: Pick<Runner, "command">,
  accountShell = () => userInfo().shell,
) {
  let cached: Promise<string> | undefined;
  return () => {
    if (cached) return cached;
    const load = async () => {
      const shell = accountShell();
      if (
        !shell ||
        !path.isAbsolute(shell) ||
        !["zsh", "bash"].includes(path.basename(shell))
      )
        throw Error("Не удалось прочитать PATH оболочки.");
      const env: NodeJS.ProcessEnv = { HOME: home, SHELL: shell, TERM: "dumb" };
      for (const key of ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"])
        if (process.env[key] !== undefined) env[key] = process.env[key];
      // Undefined overrides also remove injection flags inherited by NodeRunner.
      for (const key of Object.keys(process.env))
        if (
          /^(?:ELECTRON_|DYLD_|BASH_FUNC_|GIT_)/.test(key) ||
          [
            "NODE_OPTIONS",
            "NODE_PATH",
            "BASH_ENV",
            "ENV",
            "ZDOTDIR",
            "LD_PRELOAD",
            "LD_LIBRARY_PATH",
          ].includes(key)
        )
          env[key] = undefined;
      const caller = readSignal();
      const deadline = AbortSignal.timeout(5000);
      const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
      const result = await withReadScope(signal, () =>
        runner.command(
          shell,
          [
            "-i",
            "-l",
            "-c",
            `printf '\\000GOGA_DESKTOP_PATH\\000%s\\000' "$PATH"`,
          ],
          home,
          env,
        ),
      );
      const marker = "\0GOGA_DESKTOP_PATH\0";
      const start = result.stdout.lastIndexOf(marker);
      const value =
        start < 0
          ? ""
          : result.stdout.slice(start + marker.length).split("\0")[0];
      if (!value || value.length > 65536 || /[\0\r\n]/.test(value))
        throw Error("Не удалось прочитать PATH оболочки.");
      // Never search a project-controlled current/relative directory implicitly.
      const absolute = value.split(":").filter((p) => path.isAbsolute(p));
      if (!absolute.length) throw Error("Не удалось прочитать PATH оболочки.");
      return absolute.join(":");
    };
    cached = load().catch((error) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}
export async function gogaEnvironment(
  rows: readonly ProjectEnvironmentEntry[],
  shellPath?: () => Promise<string>,
): Promise<NodeJS.ProcessEnv> {
  const explicit = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  if (Object.hasOwn(explicit, "PATH") || !shellPath) return explicit;
  try {
    return { PATH: await shellPath(), ...explicit };
  } catch {
    // A broken shell rc must not prevent a configured absolute executable from working.
    // The process still uses inherited PATH and its real outcome is reported normally.
    return explicit;
  }
}
