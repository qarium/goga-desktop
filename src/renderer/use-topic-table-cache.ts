import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Project } from "../shared/types";
import type { TopicsStore } from "./topics-model";
import { TopicTableCache } from "./topic-table-cache";

export function useTopicTableYear(store: TopicsStore, projectId: string) {
  return useSyncExternalStore(
    store.subscribeYears,
    () => store.years.get(projectId) ?? String(new Date().getFullYear()),
  );
}

/** The shell owns reads; opening or parking the table only changes who sees them. */
export function useActiveProjectTopicTable(
  store: TopicsStore,
  project: Project | undefined,
  enabled: boolean,
  revision: string,
) {
  const [cache] = useState(() => new TopicTableCache());
  const projectId = project?.id ?? "";
  const path = project?.path ?? "";
  const year = useTopicTableYear(store, projectId);
  const scope = useMemo(
    () => (enabled && projectId && path ? { projectId, path, year } : null),
    [enabled, projectId, path, year],
  );

  useEffect(() => {
    if (!scope) return;
    const sync = () =>
      cache.activate(document.visibilityState === "hidden" ? null : scope);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      document.removeEventListener("visibilitychange", sync);
      cache.activate(null);
    };
  }, [cache, scope]);

  // A change within the same project/year (e.g. topic creation or deletion)
  // invalidates its table, even if a read began before that change.
  const previous = useRef({ scope, revision });
  useEffect(() => {
    if (
      scope &&
      previous.current.scope === scope &&
      previous.current.revision !== revision
    )
      cache.invalidate(scope);
    previous.current = { scope, revision };
  }, [cache, scope, revision]);
  return cache;
}
