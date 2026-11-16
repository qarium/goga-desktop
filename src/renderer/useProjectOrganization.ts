import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { Project } from "../shared/types";
import {
  createOrganizationStore,
  organizationKey,
} from "./project-organization-preferences";
export function useProjectOrganization(
  projects: readonly Pick<Project, "id">[],
  catalogReady: boolean,
) {
  const [store] = useState(() =>
    createOrganizationStore(() => window.localStorage),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useLayoutEffect(() => {
    store.setCatalog(
      projects.map((p) => p.id),
      catalogReady,
    );
  }, [store, projects, catalogReady]);
  useEffect(() => {
    function changed(e: StorageEvent) {
      if (e.key === organizationKey || e.key === null) store.reload();
    }
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [store]);
  return {
    ...snapshot,
    ready: catalogReady,
    dispatch: store.dispatch,
    retry: store.retry,
    recover: store.recover,
  };
}
export type ProjectOrganizationController = ReturnType<
  typeof useProjectOrganization
>;
