import type { DesktopAPI } from "../../shared/bridge";
import {
  ReadCoordinator,
  READ_BUDGETS,
  type ReadMethod,
} from "../../shared/read-deadlines";
import { readWithSignal } from "../read-request";
/** Per-owner cancellation uses the existing bounded read-request transport. Writes never cancel. */
export function createOverviewTransport(api: DesktopAPI) {
  const controllers = new Map<string, AbortController>();
  const fallback = new ReadCoordinator();
  const cancel = (key: string) => {
    controllers.get(key)?.abort();
    controllers.delete(key);
  };
  async function read<M extends ReadMethod>(
    key: string,
    method: M,
    ...args: Parameters<DesktopAPI[M]>
  ): Promise<Awaited<ReturnType<DesktopAPI[M]>>> {
    cancel(key);
    const controller = new AbortController();
    controllers.set(key, controller);
    try {
      if (api === window.goga)
        return await readWithSignal(controller.signal, method, ...args);
      const id = crypto.randomUUID();
      return (await fallback.run(
        key,
        READ_BUDGETS[method],
        () =>
          api.readRequest
            ? api.readRequest(id, method, args)
            : (api[method] as (...args: unknown[]) => Promise<unknown>)(
                ...args,
              ),
        () => {
          void api.cancelRead?.(id).catch(() => {});
        },
        controller.signal,
      )) as Awaited<ReturnType<DesktopAPI[M]>>;
    } finally {
      if (controllers.get(key) === controller) controllers.delete(key);
    }
  }
  return {
    api: {
      ...api,
      listOverviewDirectory: (scope, p) =>
        read("dir:" + p, "listOverviewDirectory", scope, p),
      searchOverviewFiles: (scope, p, q) =>
        read("search", "searchOverviewFiles", scope, p, q),
      readOverviewFile: (scope, p) =>
        read("file:" + p, "readOverviewFile", scope, p),
      readOverviewSchema: (scope) =>
        read("schema", "readOverviewSchema", scope),
      readOverviewContract: (scope, p) =>
        read("contract", "readOverviewContract", scope, p),
    } as DesktopAPI,
    cancel,
    dispose: () => {
      for (const c of controllers.values()) c.abort();
      controllers.clear();
    },
  };
}
