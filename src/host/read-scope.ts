import { AsyncLocalStorage } from "node:async_hooks";
import { readCancelledMessage } from "../shared/read-deadlines";
const reads = new AsyncLocalStorage<AbortSignal>();
export const readSignal = () => reads.getStore();
export function withReadScope<T>(signal: AbortSignal, fn: () => T): T {
  return reads.run(signal, fn);
}
export function assertReadActive() {
  if (readSignal()?.aborted) throw Error(readCancelledMessage);
}

// Narrow request-local policy for History, not a global change to clone workflows.
// It must cover ownership resolution as well as the final artifact reader: both
// can invoke Git object reads that would otherwise lazily fetch promisor data.
const offlineGitReads = new AsyncLocalStorage<boolean>();
export const isOfflineGitRead = () => offlineGitReads.getStore() === true;
export function withOfflineGitReadScope<T>(fn: () => T): T {
  return offlineGitReads.run(true, fn);
}
