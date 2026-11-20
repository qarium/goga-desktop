import { t as msg } from "../../shared/i18n";
import { useLocale } from "../useLocale";
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
  useLocale();
  const text = useSyncExternalStore(store.subscribeBuffer, () =>
    store.readBuffer(target),
  );
  return (
    <TopicModal
      title={msg("shell.unsavedFile2")}
      closeLabel={msg("shell.closeView")}
      onClose={onClose}
    >
      <p className="context-path">{target.relativePath}</p>
      {text === null ? (
        <p role="status">{msg("shell.thisBufferWasClosedOrItsChangesWereSaved")}</p>
      ) : (
        <>
          <p className="hint">{msg("shell.thePreviousWorkspaceIsUnavailableOrHasChangedYouCan")}</p>
          <textarea
            style={{ width: "100%", minHeight: "12rem" }}
            aria-label={msg("shell.unsavedText")}
            value={text}
            readOnly
            spellCheck={false}
          />
        </>
      )}
    </TopicModal>
  );
}
