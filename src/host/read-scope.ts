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
