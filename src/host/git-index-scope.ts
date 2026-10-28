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

const nativeIndexScope = new AsyncLocalStorage<string>();
/** Only createNativeGitClient mints these private directories. This capability
 * selects an index for one native command, never for surrounding observations. */
export function withNativeGitIndex<T>(filename: string, action: () => T): T {
  if (
    !path.isAbsolute(filename) ||
    path.resolve(filename) !== filename ||
    !/\/goga-native-index-[A-Za-z0-9]+\/index$/.test(filename)
  )
    throw new Error("Недопустимый временный индекс штатного Git.");
  return nativeIndexScope.run(filename, action);
}
/** Narrow host-only capability used by the frozen native client's stat refresh.
 * No caller-supplied index filename: it always addresses this admitted root.
 * Git alone reads/writes the real index; no binary metadata is copied. */
export function withNativeGitIndexRefresh<T>(root: string, action: () => T): T {
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    root.includes("\0")
  )
    throw Error("Недопустимая рабочая папка штатного Git.");
  return nativeIndexScope.run(path.join(root, ".git/index"), action);
}
export const nativeGitIndex = () => nativeIndexScope.getStore();

const nativeObjectScope = new AsyncLocalStorage<string>();
/** The native client alone supplies the audited source object store while Git
 * owns a disposable, filter-free metadata directory. No renderer redirects. */
export function withNativeGitObjects<T>(directory: string, action: () => T): T {
  if (
    !nativeGitIndex() ||
    !path.isAbsolute(directory) ||
    path.resolve(directory) !== directory ||
    !directory.endsWith("/.git/objects")
  )
    throw Error("Недопустимое хранилище объектов штатного Git.");
  return nativeObjectScope.run(directory, action);
}
export const nativeGitObjects = () => nativeObjectScope.getStore();
