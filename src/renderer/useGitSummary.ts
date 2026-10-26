import { useEffect, useState } from "react";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import type { GitWorkspaceSummary } from "../shared/git-workspace";
import { documentScopeId } from "./settings-documents";
import { readWithSignal } from "./read-request";

const summarySchema = z
  .object({
    scope: scopeRefSchema,
    branch: z.string().nullable(),
    changedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    conflicts: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.conflicts <= value.changedFiles);
const INTERVAL = 3000;
/** Display-only reads never replace editor snapshots or confirmation revisions. */
export function useGitSummary(
  scope: ScopeRef,
  enabled: boolean,
  revision: number,
) {
  const owner = documentScopeId(scope);
  const [state, setState] = useState<{
    owner: string;
    value: GitWorkspaceSummary | null;
    error: boolean;
  }>({ owner, value: null, error: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true,
      flight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const visible = () => document.visibilityState !== "hidden";
    const poll = async () => {
      if (!alive || !visible() || flight) return;
      clearTimeout(timer);
      flight = true;
      controller = new AbortController();
      try {
        const value = summarySchema.parse(
          await readWithSignal(controller.signal, "readGitSummary", scope),
        );
        if (documentScopeId(value.scope) !== owner)
          throw Error("Wrong summary owner");
        if (alive && !controller.signal.aborted)
          setState({ owner, value, error: false });
      } catch {
        if (alive && !controller.signal.aborted)
          setState({ owner, value: null, error: true });
      } finally {
        flight = false;
        if (alive && visible()) timer = setTimeout(() => void poll(), INTERVAL);
      }
    };
    const resume = () => {
      if (visible()) void poll();
      else clearTimeout(timer);
    };
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
    // Scope's complete serialized identity includes freshness; object identity does not.
  }, [owner, enabled, revision]);
  return state.owner === owner ? state : { owner, value: null, error: false };
}
