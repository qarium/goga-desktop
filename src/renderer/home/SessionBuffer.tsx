import { useSyncExternalStore } from "react";
import { TopicModal } from "../TopicsCommon";
import type { DocumentTarget, HomeSessions } from "./session-summary";

export function SessionBuffer({
  store,
  target,
  onClose,
}: {
  store: HomeSessions;
  target: DocumentTarget;
  onClose: () => void;
}) {
  const text = useSyncExternalStore(store.subscribeBuffer, () =>
    store.readBuffer(target),
  );
  return (
    <TopicModal
      title="Несохранённый файл"
      closeLabel="Закрыть просмотр"
      onClose={onClose}
    >
      <p className="context-path">{target.relativePath}</p>
      {text === null ? (
        <p role="status">Этот буфер уже закрыт или изменения сохранены.</p>
      ) : (
        <>
          <p className="hint">
            Прежняя рабочая область недоступна или изменилась. Это текст из
            памяти редактора; его можно выделить и скопировать. Запись на диск
            не выполняется.
          </p>
          <textarea
            style={{ width: "100%", minHeight: "12rem" }}
            aria-label="Несохранённый текст"
            value={text}
            readOnly
            spellCheck={false}
          />
        </>
      )}
    </TopicModal>
  );
}
