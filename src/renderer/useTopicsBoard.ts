import { useEffect, useState } from "react";
import type { TopicBoardSnapshot } from "../shared/topics";
import {
  defaultBoardPreferences,
  topicSelectionKey,
  type TopicsBoardPreferences,
} from "./topics-board-model";
import {
  boardPreferencesKey,
  readBoardPreferences,
  writeBoardPreferences,
} from "./topics-board-preferences";
function load(projectId: string) {
  try {
    return readBoardPreferences(window.localStorage, projectId);
  } catch {
    return {
      value: defaultBoardPreferences(),
      error: "Не удалось прочитать настройки доски.",
    };
  }
}
export function useTopicsBoard(
  projectId: string,
  year: string,
  board: TopicBoardSnapshot | null,
) {
  const [saved, setSaved] = useState(() => ({ projectId, ...load(projectId) }));
  const [version, setVersion] = useState(0);
  const owner = JSON.stringify([projectId, year]);
  const [selection, setSelection] = useState({
    owner,
    keys: new Set<string>(),
  });
  const selected =
    selection.owner === owner ? selection.keys : new Set<string>();
  useEffect(() => {
    setSelection({ owner, keys: new Set() });
  }, [owner]);
  useEffect(() => {
    setSaved({ projectId, ...load(projectId) });
    const receive = (event: StorageEvent) => {
      if (event.key !== null && event.key !== boardPreferencesKey(projectId))
        return;
      const incoming = readBoardPreferences(
        { getItem: () => event.newValue, setItem: () => {} },
        projectId,
      );
      setSaved({ projectId, ...incoming });
      setVersion((n) => n + 1);
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, [projectId]);
  useEffect(() => {
    if (!board || board.projectId !== projectId || board.year !== year) return;
    const known = new Set(
      board.entries.map((r) => topicSelectionKey(projectId, year, r.topic)),
    );
    setSelection((s) =>
      s.owner !== owner
        ? s
        : { owner, keys: new Set([...s.keys].filter((k) => known.has(k))) },
    );
  }, [board, projectId, year, owner]);
  return {
    preferences:
      saved.projectId === projectId ? saved.value : defaultBoardPreferences(),
    error: saved.projectId === projectId ? saved.error : undefined,
    selected,
    version,
    onSelection: (keys: Set<string>) =>
      setSelection({ owner, keys: new Set(keys) }),
    onPreferences: (value: TopicsBoardPreferences) => {
      let result: { error?: string };
      try {
        result = writeBoardPreferences(window.localStorage, projectId, value);
      } catch {
        result = { error: "Настройки доски не сохранены." };
      }
      setSaved({ projectId, value, ...result });
    },
  };
}
