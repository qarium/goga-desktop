import type { ScopeRef } from "../shared/context";
import { contextKey } from "./topic-context";
import type { HistoryScrollPositions } from "./HistoryScrollPane";
export const specificationOwnerKey = (scope: ScopeRef): string =>
  typeof scope === "string"
    ? JSON.stringify(["primary", scope])
    : JSON.stringify(["topic", contextKey(scope)]);
export interface SpecificationViewState {
  selected: string | null;
  initialized: boolean;
  query: string;
  expanded: Set<string>;
  treePositions: HistoryScrollPositions;
  documentPositions: HistoryScrollPositions;
}
const initial = (): SpecificationViewState => ({
  selected: null,
  initialized: false,
  query: "",
  expanded: new Set(),
  treePositions: new Map(),
  documentPositions: new Map(),
});
/** Session-only reading state. No file contents, request versions or editor drafts. */
export function createSpecificationsState() {
  const values = new Map<
    string,
    { projectId: string; value: SpecificationViewState }
  >();
  return {
    get(scope: ScopeRef): SpecificationViewState {
      const key = specificationOwnerKey(scope);
      let entry = values.get(key);
      if (!entry) {
        entry = {
          projectId: typeof scope === "string" ? scope : scope.projectId,
          value: initial(),
        };
        values.set(key, entry);
      }
      return entry.value;
    },
    set(scope: ScopeRef, value: SpecificationViewState) {
      values.set(specificationOwnerKey(scope), {
        projectId: typeof scope === "string" ? scope : scope.projectId,
        value,
      });
    },
    retainProjects(projectIds: string[]) {
      const retained = new Set(projectIds);
      for (const [key, entry] of values)
        if (!retained.has(entry.projectId)) values.delete(key);
    },
  };
}
export type SpecificationsStateStore = ReturnType<
  typeof createSpecificationsState
>;
