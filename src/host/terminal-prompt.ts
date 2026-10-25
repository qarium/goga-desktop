import { mkdtemp, writeFile } from "node:fs/promises";
import { rmSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import type { TerminalLaunch } from "./terminal-environment";
import { tmpdir } from "node:os";
import path from "node:path";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
/** A private startup shim, never a user rc edit or an output-stream rewrite.
 * Restore ZDOTDIR before sourcing the original zshenv so subsequent rc files,
 * history and nested shells keep the user's normal startup behavior. */
export async function prepareTopicPrompt(
  root: string,
  topic: string | undefined,
  env: Record<string, string>,
): Promise<{
  directory: string;
  dispose(): void;
  activity: NonNullable<TerminalLaunch["activity"]>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "goga-terminal-prompt-"));
  const dispose = () => {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      /* Cleanup must not prevent releasing the terminal lease. */
    }
  };
  const stateFile = path.join(directory, "activity");
  let invalidationFailed = false;
  const activity = {
    idle: (pid: number) => {
      try {
        if (invalidationFailed) return false;
        const info = lstatSync(stateFile);
        return (
          info.isFile() &&
          !info.isSymbolicLink() &&
          info.size < 64 &&
          readFileSync(stateFile, "utf8") === `${pid}:idle\n`
        );
      } catch {
        return false;
      }
    },
    input: (_data: string) => {
      // Invalidate before PTY write: a queued exec/builtin must not inherit old idle evidence.
      try {
        writeFileSync(stateFile, "busy\n", { mode: 0o600 });
      } catch {
        invalidationFailed = true;
      }
    },
  };
  const original = Object.hasOwn(env, "ZDOTDIR") ? env.ZDOTDIR : undefined;
  const startup = original ?? env.HOME;
  const script = `# Goga Desktop: local prompt-only integration.
${original === undefined ? "unset ZDOTDIR" : `export ZDOTDIR=${quote(original)}`}
${startup ? `if [[ -r ${quote(path.join(startup, ".zshenv"))} ]]; then source ${quote(path.join(startup, ".zshenv"))}; fi` : ""}
typeset -g _goga_desktop_prompt_root=${quote(root)}
typeset -g _goga_desktop_prompt_topic=${quote(topic ?? "")}
typeset -g _goga_desktop_prompt_last=''
typeset -gi _goga_desktop_prompt_slot=0
_goga_desktop_prompt() {
  # Custom themes and prompt command substitution are not ours to replace.
  if [[ -o promptsubst ]]; then
    [[ -n $_goga_desktop_prompt_last && $PROMPT == $_goga_desktop_prompt_last ]] && PROMPT='%n@%m %1~ %# '
    return 0
  fi
  [[ $PROMPT == '%n@%m %1~ %# ' || ( -n $_goga_desktop_prompt_last && $PROMPT == $_goga_desktop_prompt_last ) ]] || return 0
  if [[ $PWD == $_goga_desktop_prompt_root ]]; then
    # psvar is expanded as prompt data, not shell source (even if options change).
    if (( _goga_desktop_prompt_slot == 0 )) || [[ $psvar[_goga_desktop_prompt_slot] != $_goga_desktop_prompt_topic ]]; then
      _goga_desktop_prompt_slot=$(( $#psvar + 1 ))
    fi
    psvar[_goga_desktop_prompt_slot]=$_goga_desktop_prompt_topic
    PROMPT="%n@%m %"$_goga_desktop_prompt_slot"v %# "
  else
    PROMPT='%n@%m %1~ %# '
  fi
  _goga_desktop_prompt_last=$PROMPT
}
typeset -ga precmd_functions
${topic === undefined ? "" : "precmd_functions+=(_goga_desktop_prompt)"}
# Prompt readiness is distinct from the process inventory: exec and builtins can
# run in the root PID. No output markers or user rc files are modified.
_goga_desktop_idle() {
  # vared/select/continuation editors also call line-init, but are not a command prompt.
  if [[ $CONTEXT == start ]]; then
    builtin print -r -- "$$:idle" > ${quote(stateFile)}
  else
    _goga_desktop_busy
  fi
}
_goga_desktop_busy() { builtin print -r -- "$$:busy" > ${quote(stateFile)} }
typeset -ga preexec_functions
preexec_functions+=(_goga_desktop_busy)
zmodload zsh/zle
autoload -Uz add-zle-hook-widget
add-zle-hook-widget line-init _goga_desktop_idle
add-zle-hook-widget line-finish _goga_desktop_busy
`;
  try {
    await writeFile(path.join(directory, ".zshenv"), script, { mode: 0o600 });
    return { directory, dispose, activity };
  } catch (error) {
    dispose();
    throw error;
  }
}
