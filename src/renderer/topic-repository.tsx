import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { GitBranch } from "lucide-react";
import { gitSummaryCacheFor } from "./git-summary-cache";

export type TopicRepositoryState = "checking" | "missing" | "available";

/** Catalogs belong to the original project, never to the currently selected clone.
 * Observe the same validated summary as the Git bar; do not start a second poller.
 * Only the host's explicit missing marker disables topics (an unborn branch,
 * a failed Git read or a legacy bridge are not evidence that Git is absent). */
export function useTopicRepository(
  projectId: string | null,
): TopicRepositoryState {
  const cache = gitSummaryCacheFor(window.goga);
  const scope =
    typeof window.goga.readGitSummary === "function" ? projectId : null;
  const subscribe = useCallback(
    (listener: () => void) =>
      scope ? cache.subscribe(scope, listener) : () => {},
    [cache, scope],
  );
  const state = useSyncExternalStore(subscribe, (): TopicRepositoryState => {
    if (!scope) return "available";
    const { lastGood, error } = cache.getSnapshot(scope);
    if (error) return "available";
    if (!lastGood) return "checking";
    return lastGood.repository === "missing" ? "missing" : "available";
  });
  // Subscribe before ensure: the cache intentionally does not read for an unobserved owner.
  useEffect(() => {
    if (!scope) return;
    void cache.ensure(scope, "visible");
    const recheckMissing = () => {
      if (
        document.visibilityState !== "hidden" &&
        cache.getSnapshot(scope).lastGood?.repository === "missing"
      )
        void cache.ensure(scope, "manual");
    };
    // With a clone selected, its Git bar polls the clone, not this primary folder.
    window.addEventListener("focus", recheckMissing);
    return () => window.removeEventListener("focus", recheckMissing);
  }, [cache, scope]);
  return state;
}

export function TopicRepositoryNotice({ popup = false }: { popup?: boolean }) {
  const note = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (popup) note.current?.focus({ preventScroll: true });
  }, [popup]);
  return (
    <div
      className="topic-repository-notice"
      role="note"
      ref={note}
      tabIndex={popup ? -1 : undefined}
    >
      <GitBranch size={20} aria-hidden="true" />
      <div>
        <strong>Топики доступны только в Git-репозитории</strong>
        <p>
          Инициализируйте Git в исходной папке проекта, чтобы работать с
          топиками. Файлы проекта доступны и без Git.
        </p>
      </div>
    </div>
  );
}
