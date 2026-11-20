import { t } from "./i18n";
import {
  isReservedProjectEnvKey,
  isBlockedTerminalChildEnvKey,
} from "./terminal-environment-policy";
import { z } from "zod";
import { assertEnvironmentValue } from "./environment-transport";

/** No Docker transport or runtime toggles: these literal values go to a single PTY. */
export type TerminalPresetEnv = { key: string; value: string }[];
export interface TerminalPresetDraft {
  name: string;
  command: string;
  env: TerminalPresetEnv;
}
export interface TerminalPresetMenuItem {
  id: string;
  revision: string;
  name: string;
}
export interface TerminalPresetSummary extends TerminalPresetMenuItem {
  command: string;
  envCount: number;
}
export interface TerminalPresetDocument
  extends TerminalPresetMenuItem, TerminalPresetDraft {}
export const MAX_TERMINAL_PRESET_ENV_BYTES = 128 * 1024;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const rowSchema = z.object({ key: z.string(), value: z.string() }).strict();
const reserved = new Set([
  // Terminal identity and private first-prompt setup must not be replaced by an overlay.
  "SHELL",
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "PROMPT",
  "RPROMPT",
  "PS0",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "RPS1",
  "RPS2",
  "IFS",
  "BASHOPTS",
  "SHELLOPTS",
  "BASH_XTRACEFD",
  "__proto__",
  "constructor",
  "prototype",
]);
export function parseTerminalPresetEnv(input: unknown): TerminalPresetEnv {
  if (!Array.isArray(input) || input.length > 256)
    throw Error(t("hostTerminal.environmentCount"));
  let size = 0;
  const keys = new Set<string>();
  return Array.from(input, (row) => {
    const p = rowSchema.safeParse(row);
    if (!p.success) throw Error(t("hostTerminal.environmentFields"));
    const { key, value } = p.data;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
      throw Error(
        t("hostTerminal.environmentKey"),
      );
    if (
      isReservedProjectEnvKey(key) ||
      isBlockedTerminalChildEnvKey(key) ||
      reserved.has(key) ||
      key.startsWith("_goga_")
    )
      throw Error(t("hostTerminal.reservedVariable"));
    if (keys.has(key))
      throw Error(t("hostTerminal.duplicateVariable"));
    assertEnvironmentValue(value);
    size += bytes(key) + bytes(value) + 2;
    if (size > MAX_TERMINAL_PRESET_ENV_BYTES)
      throw Error(t("hostTerminal.environmentSize"));
    keys.add(key);
    return { key, value };
  });
}
export const terminalPresetNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => {
    try {
      assertEnvironmentValue(s);
      return !/[\x00-\x1f\x7f]/.test(s);
    } catch {
      return false;
    }
  });
export const parseTerminalPresetDraft = (
  input: unknown,
): TerminalPresetDraft => {
  const p = z
    .object({ name: z.string(), command: z.string(), env: z.unknown() })
    .strict()
    .safeParse(input);
  if (!p.success) throw Error(t("hostTerminal.invalidPresetDraft"));
  const name = terminalPresetNameSchema.safeParse(p.data.name);
  if (!name.success)
    throw Error(
      t("hostTerminal.tabNameLimit"),
    );
  const command = p.data.command;
  if (
    !command.trim() ||
    /[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(command) ||
    bytes(command) > 8192
  )
    throw Error(
      t("hostTerminal.oneCommand"),
    );
  try {
    assertEnvironmentValue(command);
  } catch {
    throw Error(t("hostTerminal.commandEncoding"));
  }
  return { name: name.data, command, env: parseTerminalPresetEnv(p.data.env) };
};
export const terminalPresetDraftSchema = z.unknown().transform((input, ctx) => {
  try {
    return parseTerminalPresetDraft(input);
  } catch (e) {
    ctx.addIssue({
      code: "custom",
      message: e instanceof Error ? e.message : t("hostTerminal.invalidPreset"),
    });
    return z.NEVER;
  }
});
