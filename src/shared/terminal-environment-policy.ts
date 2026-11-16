/** Existing Desktop per-project setting policy (including keys only inherited by child processes). */
export function isReservedProjectEnvKey(key: string): boolean {
  return (
    /^(?:HOME|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|NO_COLOR)$/.test(key) ||
    /^(?:GOGA_|AFM_|ELECTRON_|GIT_)/.test(key)
  );
}
// Sanitize only the child copy. Shell startup files remain the user's responsibility.
export function isBlockedTerminalChildEnvKey(key: string) {
  return (
    /^(?:ELECTRON_|DYLD_|BASH_FUNC_|GIT_CONFIG(?:_|$))/.test(key) ||
    [
      "NODE_OPTIONS",
      "NODE_PATH",
      "NODE_REPL_EXTERNAL_MODULE",
      "NODE_CHANNEL_FD",
      "NODE_CHANNEL_SERIALIZATION_MODE",
      "NODE_UNIQUE_ID",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "BASH_ENV",
      "ENV",
      "PWD",
      "OLDPWD",
    ].includes(key)
  );
}
