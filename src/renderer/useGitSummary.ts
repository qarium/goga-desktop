import { useCallback, useEffect, useSyncExternalStore, useRef } from "react";
import type { ScopeRef } from "../shared/context";
import { documentScopeId } from "./settings-documents";
import { gitSummaryCacheFor } from "./git-summary-cache";

const noop = () => {};
/** The workspace header still polls; Home is event-driven and shares the exact-owner cache. */
export function useGitSummary(
  scope: ScopeRef,
  enabled: boolean,
  revision: number,
) {
  const key = documentScopeId(scope),
    cache = gitSummaryCacheFor(window.goga);
  const subscribe = useCallback(
    (fn: () => void) => (enabled ? cache.subscribe(scope, fn) : noop),
    [cache, key, enabled],
  );
  const state = useSyncExternalStore(subscribe, () => cache.getSnapshot(scope));
  const last = useRef<{
    key: string;
    revision: number;
    cache: typeof cache;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true,
      flight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (
      last.current?.cache === cache &&
      last.current.key === key &&
      last.current.revision !== revision
    )
      cache.invalidate(scope);
    last.current = { key, revision, cache };
    const visible = () => document.visibilityState !== "hidden";
    async function poll() {
      clearTimeout(timer);
      if (!alive || !visible() || flight) return;
      flight = true;
      try {
        await cache.ensure(scope, "active-poll");
      } finally {
        flight = false;
        if (alive && visible()) timer = setTimeout(poll, 3000);
      }
    }
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [cache, key, enabled, revision]);
  return {
    owner: key,
    value: state.error ? null : (state.lastGood ?? null),
    error: !!state.error,
  };
}
