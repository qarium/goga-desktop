import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
const indexScope = new AsyncLocalStorage<string>();
const privateWriteScope = new AsyncLocalStorage<boolean>();
/** Explicit commit-only capability: use the validated alternate index and its
 * repository's object store under an immutable, filter-free private config.
 * A normal read must still ignore an inherited trusted index. */
export const withPrivateGitIndexWrite = <T>(action: () => T): T =>
  privateWriteScope.run(true, action);
export const isPrivateGitIndexWrite = () =>
  privateWriteScope.getStore() === true;
/** Host-only capability. The action creates this private path after validating its root;
 * no IPC/renderer environment or index path is accepted here. Never use the real lock
 * as an index: Git replaces its index inode, which would drop the lock prematurely. */
export function withTrustedGitIndex<T>(filename: string, action: () => T): T {
  if (
    !path.isAbsolute(filename) ||
    path.resolve(filename) !== filename ||
    !/\/\.git\/goga-(?:commit|merge|abort)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/index$/.test(
      filename,
    )
  )
    throw new Error("Недопустимый служебный индекс Git.");
  return indexScope.run(filename, action);
}
export const trustedGitIndex = () => indexScope.getStore();
