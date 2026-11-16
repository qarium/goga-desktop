import { useEffect, useMemo } from "react";
import type { DesktopAPI } from "../shared/bridge";
import {
  READ_BUDGETS,
  ReadCoordinator,
  type ReadMethod,
} from "../shared/read-deadlines";
type ReadArgs<M extends ReadMethod> = Parameters<DesktopAPI[M]>;
type ReadResult<M extends ReadMethod> = Awaited<ReturnType<DesktopAPI[M]>>;
const coordinators = new WeakMap<object, ReadCoordinator>();
function trackedRequest<M extends ReadMethod>(
  signal: AbortSignal | undefined,
  method: M,
  args: ReadArgs<M>,
  onSettled?: () => void,
): Promise<ReadResult<M>> {
  const api = window.goga;
  let coordinator = coordinators.get(api);
  if (!coordinator) {
    coordinator = new ReadCoordinator();
    coordinators.set(api, coordinator);
  }
  const id = crypto.randomUUID();
  let invoked = false;
  const result = coordinator.run(
    JSON.stringify([method, args]),
    READ_BUDGETS[method],
    () => {
      invoked = true;
      try {
        const physical = api.readRequest
          ? (api.readRequest(id, method, args) as Promise<ReadResult<M>>)
          : (api[method] as (...args: ReadArgs<M>) => Promise<ReadResult<M>>)(
              ...args,
            );
        return onSettled
          ? Promise.resolve(physical).finally(onSettled)
          : physical;
      } catch (error) {
        onSettled?.();
        throw error;
      }
    },
    () => {
      void api.cancelRead?.(id).catch(() => {});
    },
    signal,
  );
  // Admission can reject without ever invoking the physical transport.
  if (!invoked) onSettled?.();
  return result;
}
function request<M extends ReadMethod>(
  signal: AbortSignal | undefined,
  method: M,
  ...args: ReadArgs<M>
) {
  return trackedRequest(signal, method, args);
}
/** A bounded background queue needs to distinguish "caller cancelled" from
 * "transport acknowledged cancellation". Existing caller deadlines are unchanged. */
export function readWithSettlement<M extends ReadMethod>(
  signal: AbortSignal,
  method: M,
  ...args: ReadArgs<M>
) {
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const result = trackedRequest(signal, method, args, finish);
  return { result, settled };
}
export function readWithSignal<M extends ReadMethod>(
  signal: AbortSignal,
  method: M,
  ...args: ReadArgs<M>
) {
  return request(signal, method, ...args);
}
export function readRequest<M extends ReadMethod>(
  method: M,
  ...args: ReadArgs<M>
) {
  return request(undefined, method, ...args);
}
/** A scope cancels only its reads on context switch/unmount, never writes or launches. */
export function useReadScope(key: string) {
  const scope = useMemo(() => ({ controller: new AbortController() }), [key]);
  useEffect(() => {
    if (scope.controller.signal.aborted)
      scope.controller = new AbortController();
    return () => scope.controller.abort();
  }, [scope]);
  return useMemo(
    () =>
      <M extends ReadMethod>(method: M, ...args: ReadArgs<M>) =>
        request(scope.controller.signal, method, ...args),
    [scope],
  );
}
