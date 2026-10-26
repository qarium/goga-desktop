import { AsyncLocalStorage } from "node:async_hooks";

/** Host-only capability: private Git metadata must never re-read ambient config.
 * Capture keeps native system/global config but ignores GIT_CONFIG, which would
 * otherwise redirect only `git config` and disagree with native status/diff. */
const reads = new AsyncLocalStorage<
  "capture" | "private" | "private-native-attributes"
>();
export const isPrivateGitRead = () =>
  reads.getStore() === "private" ||
  reads.getStore() === "private-native-attributes";
export const usesNativeGitAttributes = () =>
  reads.getStore() === "private-native-attributes";
export const isGitPolicyCapture = () => reads.getStore() === "capture";
export function withPrivateGitReadScope<T>(
  fn: () => T,
  options: { nativeAttributes?: boolean } = {},
): T {
  return reads.run(
    options.nativeAttributes ? "private-native-attributes" : "private",
    fn,
  );
}
export function withGitPolicyCaptureScope<T>(fn: () => T): T {
  return reads.run("capture", fn);
}

// Native abort uses frozen effective config but retains normal checkout
// attributes and its private index. This is not the read-only/filter-free mode.
const frozenConfig = new AsyncLocalStorage<boolean>();
export const isFrozenGitConfig = () => frozenConfig.getStore() === true;
export const withFrozenGitConfigScope = <T>(fn: () => T): T =>
  frozenConfig.run(true, fn);
