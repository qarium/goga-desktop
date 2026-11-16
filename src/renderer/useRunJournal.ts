import { useCallback, useEffect, useState } from "react";
import type { Run, RunJournalSlice, RunOutput } from "../shared/types";
import { useViewActive } from "./RetainedViews";

/** Returns null for an inconsistent continuation; caller can always repair via a full bounded snapshot. */
function apply(
  current: RunJournalSlice | null,
  next: RunJournalSlice,
  id: string,
): RunJournalSlice | null {
  if (
    next.id !== id ||
    next.start < 0 ||
    next.from < next.start ||
    next.from > next.end ||
    next.text.length !== next.end - next.from ||
    (current && next.sequence < current.sequence)
  )
    return null;
  if (next.from === next.start) return next;
  if (!current || next.start < current.start || next.from !== current.end)
    return null;
  return {
    ...next,
    from: next.start,
    text: current.text.slice(next.start - current.start) + next.text,
  };
}

export function useRunJournal(run: Run) {
  const active = useViewActive();
  const [state, setState] = useState<{
    id: string;
    value?: RunOutput;
    error?: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const read = window.goga?.readRunJournal,
    listen = window.goga?.onRunOutputChanged;
  useEffect(() => {
    if (!active || !read || !listen) return;
    let alive = true,
      pending = false,
      wanted = 0,
      current: RunJournalSlice | null = null;
    async function pull() {
      if (!alive || pending) return;
      pending = true;
      try {
        do {
          // Register first, then snapshot. New signals while a request is in flight
          // cause one follow-up read; inactive views do not read or retain listeners.
          const page = await read!(run.id, current?.end);
          if (!alive) return;
          let value = apply(current, page, run.id);
          if (!value && current) {
            const full = await read!(run.id);
            if (!alive) return;
            value = apply(null, full, run.id);
          }
          if (
            !value ||
            (current &&
              wanted > current.sequence &&
              value.sequence <= current.sequence)
          )
            throw Error("Inconsistent journal sequence");
          current = value;
          setState({ id: run.id, value });
        } while (alive && wanted > current.sequence);
      } catch {
        if (alive)
          setState((prev) => ({
            id: run.id,
            value: prev?.id === run.id ? prev.value : undefined,
            error: true,
          }));
      } finally {
        pending = false;
      }
    }
    const off = listen(({ id, sequence }) => {
      if (id !== run.id || sequence <= (current?.sequence ?? -1)) return;
      wanted = Math.max(wanted, sequence);
      void pull();
    });
    void pull();
    return () => {
      alive = false;
      off();
    };
  }, [active, run.id, run.status, attempt, read, listen]);
  const own = state?.id === run.id ? state : null;
  return {
    output: (read && listen ? own?.value : undefined) ?? run.output,
    loading: !!(
      active &&
      read &&
      listen &&
      !own?.value &&
      !own?.error &&
      !run.output
    ),
    error: !!(read && listen && own?.error),
    retry,
  };
}
