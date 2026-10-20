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
function request<M extends ReadMethod>(
  signal: AbortSignal | undefined,
  method: M,
  ...args: ReadArgs<M>
): Promise<ReadResult<M>> {
  const api = window.goga;
  let coordinator = coordinators.get(api);
  if (!coordinator) {
    coordinator = new ReadCoordinator();
    coordinators.set(api, coordinator);
  }
  const id = crypto.randomUUID();
  return coordinator.run(
    JSON.stringify([method, args]),
    READ_BUDGETS[method],
    () =>
      api.readRequest
        ? (api.readRequest(id, method, args) as Promise<ReadResult<M>>)
        : (api[method] as (...args: ReadArgs<M>) => Promise<ReadResult<M>>)(
            ...args,
          ),
    () => {
      void api.cancelRead?.(id).catch(() => {});
    },
    signal,
  );
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
