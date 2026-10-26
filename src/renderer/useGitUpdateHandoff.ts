import { useEffect, useRef, useState } from "react";
import type { ScopeRef } from "../shared/context";
import type { GitUpdateHandoffCandidate } from "../shared/git-update-handoff";
import { documentScopeId } from "./settings-documents";
import { dismissActiveTopicPopup } from "./TopicPickerPopup";
import { topicError } from "./TopicsCommon";
/** The shell owns confirmation, never the native popup's presentation document. */
export function useGitUpdateHandoff(options: {
  scope: ScopeRef | null;
  onChanged(scope: ScopeRef): void;
  onError(message: string): void;
}) {
  const key = options.scope === null ? null : documentScopeId(options.scope);
  const lifetime = useRef({ key, epoch: 0, alive: true, opening: false });
  if (lifetime.current.key !== key) {
    lifetime.current.key = key;
    lifetime.current.epoch++;
    lifetime.current.opening = false;
  }
  const callbacks = useRef(options);
  callbacks.current = options;
  const [entry, setEntry] = useState<{
    epoch: number;
    candidate: GitUpdateHandoffCandidate;
  } | null>(null);
  useEffect(() => {
    lifetime.current.alive = true;
    return () => {
      lifetime.current.alive = false;
      lifetime.current.epoch++;
    };
  }, []);
  const active = entry?.epoch === lifetime.current.epoch ? entry : null;
  function close() {
    lifetime.current.epoch++;
    lifetime.current.opening = false;
    setEntry(null);
  }
  async function open(candidate: GitUpdateHandoffCandidate) {
    const state = lifetime.current;
    if (!state.alive || state.opening || active) return;
    const epoch = ++state.epoch;
    state.opening = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        dismissActiveTopicPopup(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error(
                  "Не удалось закрыть меню за 5 секунд. Закройте меню и попробуйте снова.",
                ),
              ),
            5000,
          );
        }),
      ]);
      if (state.alive && state.epoch === epoch) setEntry({ epoch, candidate });
    } catch (error) {
      if (state.alive && state.epoch === epoch)
        callbacks.current.onError(topicError(error));
    } finally {
      clearTimeout(timer);
      if (state.epoch === epoch) state.opening = false;
    }
  }
  function changed(scope: ScopeRef) {
    const state = lifetime.current;
    if (
      !active ||
      !state.alive ||
      active.epoch !== state.epoch ||
      documentScopeId(scope) !== documentScopeId(active.candidate.scope)
    )
      return;
    // Refresh/navigation is allowed only for the still-selected exact owner.
    // An A → B → A selector round trip does not revive A's old callback.
    if (state.key !== documentScopeId(scope)) return;
    close();
    callbacks.current.onChanged(scope);
  }
  return { candidate: active?.candidate ?? null, open, close, changed };
}
