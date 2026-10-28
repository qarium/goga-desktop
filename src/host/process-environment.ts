import { isOfflineGitRead } from "./read-scope";
import { applyNativeGitEnvironment } from "./git-native-policy";
import path from "node:path";
import {
  trustedGitIndex,
  isPrivateGitIndexWrite,
  nativeGitIndex,
  nativeGitObjects,
} from "./git-index-scope";
import {
  isPrivateGitRead,
  isFrozenGitConfig,
  isGitPolicyCapture,
  usesNativeGitAttributes,
} from "./git-private-read-scope";
/** Per-child policy only. Never changes process.env or a user's Git configuration. */
export const gitRedirectKeys = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;
const configInjection = (key: string) =>
  key === "GIT_CONFIG_COUNT" ||
  key === "GIT_CONFIG_PARAMETERS" ||
  /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key);
export function childEnvironment(
  inherited: NodeJS.ProcessEnv,
  defaults: NodeJS.ProcessEnv = {},
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const ambient = { ...inherited };
  for (const key of Object.keys(ambient))
    if (configInjection(key)) delete ambient[key];
  const result = { ...ambient, ...defaults, ...overrides };
  for (const key of Object.keys(result))
    if (configInjection(key)) delete result[key];
  for (const key of gitRedirectKeys) delete result[key];
  // Native defaults must not weaken enclosing offline/private/index scopes.
  applyNativeGitEnvironment(result);
  const index = trustedGitIndex();
  const nativeIndex = nativeGitIndex();
  if (nativeIndex) {
    if (index || isPrivateGitRead())
      throw new Error("Несовместимые области индекса Git.");
    result.GIT_INDEX_FILE = nativeIndex;
    if (nativeGitObjects()) result.GIT_OBJECT_DIRECTORY = nativeGitObjects();
  }
  if (index && !isPrivateGitRead()) result.GIT_INDEX_FILE = index;
  if (index && isPrivateGitRead() && isPrivateGitIndexWrite()) {
    result.GIT_INDEX_FILE = index;
    result.GIT_OBJECT_DIRECTORY = path.join(
      path.dirname(path.dirname(index)),
      "objects",
    );
  }
  if (isPrivateGitRead() || isGitPolicyCapture() || isFrozenGitConfig())
    delete result.GIT_CONFIG;
  if (isFrozenGitConfig()) {
    result.GIT_CONFIG_GLOBAL = "/dev/null";
    result.GIT_CONFIG_SYSTEM = "/dev/null";
    result.GIT_CONFIG_NOSYSTEM = "1";
  }
  if (isPrivateGitRead()) {
    // Applied last: callbacks/defaults cannot reintroduce a live filter policy
    // while status/diff run against the private immutable metadata snapshot.
    result.GIT_CONFIG_GLOBAL = "/dev/null";
    result.GIT_CONFIG_SYSTEM = "/dev/null";
    result.GIT_CONFIG_NOSYSTEM = "1";
    if (!usesNativeGitAttributes()) result.GIT_ATTR_NOSYSTEM = "1";
    result.GIT_ATTR_GLOBAL = "/dev/null";
    result.GIT_ATTR_SYSTEM = "/dev/null";
    delete result.GIT_ATTR_SOURCE;
    delete result.GIT_NAMESPACE;
    delete result.GIT_REPLACE_REF_BASE;
  }
  if (isOfflineGitRead() || isPrivateGitRead() || index) {
    // Apply after every inherited/default/explicit override. Resolver commands
    // use NodeRunner too; deny all transports for older Git without lazy-fetch
    // suppression. Do not alter process.env or any repository configuration.
    result.GIT_NO_LAZY_FETCH = "1";
    result.GIT_ALLOW_PROTOCOL = "";
  }
  if (
    isPrivateGitRead() ||
    isGitPolicyCapture() ||
    isOfflineGitRead() ||
    isFrozenGitConfig()
  ) {
    // Tracing is a write side effect even for config, rev-parse and status.
    // Purge every inherited/default/explicit trace destination, then override
    // Trace2's protected global/system config targets as well. Ordinary child
    // processes (including terminals) keep their requested diagnostics.
    for (const key of Object.keys(result))
      if (key.startsWith("GIT_TRACE")) delete result[key];
    result.GIT_TRACE2 = "0";
    result.GIT_TRACE2_EVENT = "0";
    result.GIT_TRACE2_PERF = "0";
  }
  return result;
}
export function assertContextEnvironment(
  rows: readonly { key: string; value: string }[],
) {
  if (
    rows.some(
      ({ key }) =>
        (gitRedirectKeys as readonly string[]).includes(key) ||
        configInjection(key),
    )
  )
    throw new Error(
      "Переменные перенаправления Git недопустимы для контекста топика.",
    );
}
