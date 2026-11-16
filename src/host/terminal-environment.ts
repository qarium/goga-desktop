import { parseTerminalPresetEnv } from "../shared/terminal-presets";
import { prepareTopicPrompt } from "./terminal-prompt";
import {
  terminalContextSchema,
  terminalContextKey,
  type TerminalContext,
} from "../shared/terminal";
import { constants } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { isBlockedTerminalChildEnvKey } from "../shared/terminal-environment-policy";
import { childEnvironment } from "./process-environment";
import type { ProjectEnvironmentEntry } from "./desktop-state";
export interface TerminalRoot {
  context: TerminalContext;
  root: string;
  env: ProjectEnvironmentEntry[];
}
export interface TerminalSystem {
  presetEnv?: import("../shared/terminal-presets").TerminalPresetEnv;
  inherited?: NodeJS.ProcessEnv;
  accountShell?: () => string | null;
}
export interface TerminalLaunch {
  context: TerminalContext;
  cwd: string;
  shell: string;
  args: string[];
  env: Record<string, string>;
  verifyRoot: () => Promise<void>;
  dispose?: () => void;
  /** Host-created private shim, never a project- or renderer-supplied file. */
  presetShellHooks?: { addZshHook(script: string): Promise<void> };
  /** Private shell integration; absence is unknown, never proof of idle. */
  activity?: { idle(shellPid: number): boolean; input(data: string): void };
}
export async function prepareTerminalEnvironment(
  context: TerminalContext,
  resolve: () => Promise<TerminalRoot>,
  system: TerminalSystem = {},
): Promise<TerminalLaunch> {
  const owner = terminalContextSchema.safeParse(context);
  if (!owner.success) throw Error("Недопустимый контекст терминала.");
  const key = terminalContextKey(owner.data);
  const resolveOwned = async () => {
    try {
      const value = await resolve();
      const actual = terminalContextSchema.parse(value.context);
      if (terminalContextKey(actual) !== key) throw Error();
      return value;
    } catch {
      throw Error(
        "Не удалось подтвердить контекст терминала. Выберите его заново.",
      );
    }
  };
  const initial = await resolveOwned();
  const pin = await directoryIdentity(initial.root);
  let shell: string;
  try {
    const candidate = (system.accountShell ?? (() => userInfo().shell))();
    if (
      !candidate ||
      !path.isAbsolute(candidate) ||
      !["zsh", "bash"].includes(path.basename(candidate))
    )
      throw Error();
    if (!(await stat(candidate)).isFile()) throw Error();
    await access(candidate, constants.X_OK);
    shell = candidate;
  } catch {
    throw Error(
      "Оболочка аккаунта недоступна или не поддерживается. Требуется zsh или bash.",
    );
  }
  // Desktop may be launched by non-interactive tooling with colors disabled.
  // The terminal is interactive: drop that ambient flag before applying explicit
  // project settings. Shell startup files may still choose their own color policy.
  const inherited = { ...(system.inherited ?? process.env) };
  delete inherited.NO_COLOR;
  const merged = childEnvironment(
    inherited,
    Object.fromEntries(initial.env.map((row) => [row.key, row.value])),
    Object.fromEntries(
      parseTerminalPresetEnv(system.presetEnv ?? []).map((row) => [
        row.key,
        row.value,
      ]),
    ),
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (value === undefined || isBlockedTerminalChildEnvKey(name)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0"))
      throw Error("Недопустимое окружение терминала. Значения скрыты.");
    Object.defineProperty(env, name, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  Object.assign(env, {
    SHELL: shell,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "GogaDesktop",
  });
  const verifyRoot = async () => {
    const fresh = await resolveOwned();
    const current = await directoryIdentity(fresh.root);
    if (pin !== current)
      throw Error("Рабочая папка терминала изменилась. Обновите сессию.");
  };
  await verifyRoot();
  const prompt =
    path.basename(shell) === "zsh"
      ? await prepareTopicPrompt(
          initial.root,
          owner.data.kind === "topic" ? owner.data.topic : undefined,
          env,
        )
      : undefined;
  if (prompt) env.ZDOTDIR = prompt.directory;
  return {
    context: owner.data,
    cwd: initial.root,
    shell,
    args: ["-l", "-i"],
    env,
    verifyRoot,
    ...(prompt
      ? {
          dispose: prompt.dispose,
          activity: prompt.activity,
          presetShellHooks: prompt.presetShellHooks,
        }
      : {}),
  };
}

async function directoryIdentity(root: string): Promise<string> {
  try {
    if (
      !path.isAbsolute(root) ||
      path.normalize(root) !== root ||
      (await realpath(root)) !== root
    )
      throw Error();
    const info = await lstat(root, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
    return `${root}:${info.dev}:${info.ino}`;
  } catch {
    throw Error(
      "Рабочая папка терминала недоступна или заменена. Основная папка не будет использована вместо копии.",
    );
  }
}
