import { AsyncLocalStorage } from "node:async_hooks";

export type NativeGitPolicy =
  "local-read" | "local-write" | "remote" | "rebase-plan";
const scope = new AsyncLocalStorage<NativeGitPolicy>();
export const withNativeGitPolicy = <T>(
  policy: NativeGitPolicy,
  action: () => T,
): T => scope.run(policy, action);

/** Per-child baseline. Stronger enclosing read/index capabilities apply last.
 * Ordinary Goga commands and terminals are unaffected.
 * Effective Git configuration must be captured/validated by the owning handler;
 * it is passed as fixed -c values, never inherited config redirection. */
export function applyNativeGitEnvironment(env: NodeJS.ProcessEnv): void {
  const policy = scope.getStore();
  if (!policy) return;
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_") &&
      !/^GIT_(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$/.test(key)
    )
      delete env[key];
  }
  delete env.SSH_ASKPASS;
  env.SSH_ASKPASS_REQUIRE = "never";
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: policy === "remote" ? "https:ssh:file" : "",
    GIT_EDITOR: "/usr/bin/true",
    GIT_SEQUENCE_EDITOR:
      policy === "rebase-plan" ? "/bin/cat" : "/usr/bin/false",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
    GIT_TRACE2_PERF: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  });
}

const read = [
  "status",
  "diff",
  "ls-files",
  "ls-tree",
  "for-each-ref",
  "rev-parse",
  "cat-file",
  "log",
  "show",
  "rev-list",
  "merge-base",
  "check-ref-format",
  "var",
  "--version",
] as const;
const write = [
  "init",
  "commit",
  "restore",
  "add",
  "rm",
  "branch",
  "switch",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "update-index",
  "update-ref",
  "read-tree",
  "write-tree",
  "merge-tree",
  "hash-object",
] as const;
export type NativeGitRequest =
  | { policy: "rebase-plan"; command: "rebase"; args?: never; stdin?: never }
  | {
      policy: "local-read";
      command: (typeof read)[number];
      args?: readonly string[];
      stdin?: Buffer;
    }
  | {
      policy: "local-write";
      command: (typeof write)[number];
      verifyPrepared?: (assertActive: () => void) => Promise<void>;
      args?: readonly string[];
      stdin?: Buffer;
    }
  | {
      policy: "remote";
      command: "fetch";
      args?: readonly string[];
      stdin?: Buffer;
    };

/** Host-only argv construction, NOT authorization to mutate a repository.
 * Operation handlers still bind owner/token/config, and supply fixed command
 * options with separately validated literal paths/refs. Never expose via IPC. */
export function nativeGitArguments(
  request: NativeGitRequest,
  configuration: readonly (readonly [string, string])[] = [],
): string[] {
  const commands: readonly string[] =
    request.policy === "local-read"
      ? read
      : request.policy === "local-write"
        ? write
        : request.policy === "remote"
          ? ["fetch"]
          : request.policy === "rebase-plan"
            ? ["rebase"]
            : [];
  if (
    !commands.includes(request.command) ||
    ("verifyPrepared" in request &&
      request.verifyPrepared !== undefined &&
      (request.policy !== "local-write" ||
        request.command !== "update-ref" ||
        typeof request.verifyPrepared !== "function")) ||
    (request.policy === "rebase-plan" &&
      (request.args !== undefined || request.stdin !== undefined)) ||
    (request.args ?? []).some(
      (arg) => typeof arg !== "string" || arg.includes("\0"),
    )
  )
    throw Error("Недопустимая команда Git.");
  const config: string[] = [];
  for (const [key, value] of configuration) {
    if (
      !/^[A-Za-z][A-Za-z0-9-]*\.[^\0\r\n=]+$/.test(key) ||
      value.includes("\0")
    )
      throw Error("Недопустимая конфигурация Git.");
    // Admission captured the fully expanded effective configuration. Replaying
    // include directives has no original config-file location for relative paths
    // and can re-read a different file. Keep the flattened values, not directives.
    if (/^(?:include|includeif)\./i.test(key)) continue;
    config.push("-c", `${key}=${value}`);
  }
  return [
    "--no-pager",
    "--no-replace-objects",
    "--literal-pathspecs",
    ...config,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
    "-c",
    "core.editor=/usr/bin/true",
    "-c",
    request.policy === "rebase-plan"
      ? "sequence.editor=/bin/cat"
      : "sequence.editor=/usr/bin/false",
    ...(request.policy === "rebase-plan"
      ? [
          "-c",
          "core.commentChar=#",
          "-c",
          "core.commentString=#",
          "-c",
          "rebase.abbreviateCommands=false",
        ]
      : []),
    ...(request.policy === "remote" ? [] : ["-c", "protocol.allow=never"]),
    request.command,
    ...(request.policy === "rebase-plan"
      ? ["--edit-todo"]
      : (request.args ?? [])),
  ];
}
