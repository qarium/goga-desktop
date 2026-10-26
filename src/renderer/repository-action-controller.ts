import { useSyncExternalStore } from "react";
import type { ScopeRef } from "../shared/context";
import type { DesktopAPI } from "../shared/bridge";
import type {
  RepositoryActionRequest,
  RepositoryActionResult,
} from "../shared/repository-actions";

export interface RepositoryActionFailure {
  label: string;
  scope: ScopeRef;
  result: RepositoryActionResult;
}
interface Snapshot {
  revision: number;
  busy: ReadonlySet<string>;
  failures: RepositoryActionFailure[];
}
export function repositoryActionKey(
  request: Pick<RepositoryActionRequest, "projectId" | "context">,
) {
  return JSON.stringify([request.projectId, request.context ?? null]);
}
/** Writes outlive their buttons. The captured owner, never the current selector,
 * labels the completion; closing the selector cannot swallow an operation error. */
class RepositoryActionController {
  private state: Snapshot = { busy: new Set(), failures: [], revision: 0 };
  private listeners = new Set<() => void>();
  constructor(private api: DesktopAPI) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(next: Snapshot) {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
  close = () =>
    this.update({ ...this.state, failures: this.state.failures.slice(1) });
  run = async (input: RepositoryActionRequest, label: string) => {
    const request = structuredClone(input);
    const key = repositoryActionKey(request);
    if (this.state.busy.has(key)) return;
    this.update({ ...this.state, busy: new Set([...this.state.busy, key]) });
    try {
      const result = await this.api.runRepositoryAction(request);
      if (window.goga !== this.api) return;
      if (
        !result ||
        result.projectId !== request.projectId ||
        result.contextId !== request.context?.contextId ||
        result.action !== request.action ||
        !["success", "error"].includes(result.status) ||
        typeof result.log !== "string"
      )
        throw Error(
          "Ответ операции относится к другому проекту или контексту.",
        );
      if (result.status === "error")
        this.update({
          ...this.state,
          failures: [
            ...this.state.failures,
            { label, scope: request.context ?? request.projectId, result },
          ],
        });
    } catch (e) {
      if (window.goga !== this.api) return;
      const error = (e instanceof Error ? e.message : String(e)).replace(
        /^Error invoking remote method 'goga:run-repository-action': (?:Error: )?/,
        "",
      );
      this.update({
        ...this.state,
        failures: [
          ...this.state.failures,
          {
            label,
            scope: request.context ?? request.projectId,
            result: {
              projectId: request.projectId,
              contextId: request.context?.contextId,
              action: request.action,
              status: "error",
              log: "Не удалось завершить запрос операции.",
              error,
            },
          },
        ],
      });
    } finally {
      const busy = new Set(this.state.busy);
      busy.delete(key);
      this.update({ ...this.state, busy, revision: this.state.revision + 1 });
    }
  };
}
const controllers = new WeakMap<DesktopAPI, RepositoryActionController>();
export function useRepositoryActionController() {
  const api = window.goga;
  let controller = controllers.get(api);
  if (!controller) {
    controller = new RepositoryActionController(api);
    controllers.set(api, controller);
  }
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  return { ...state, run: controller.run, close: controller.close };
}
