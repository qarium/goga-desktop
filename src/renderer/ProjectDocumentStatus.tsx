import { Check, CircleAlert, FileText, Pencil } from "lucide-react";
import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import type { DocumentSaveStatus } from "./useDocumentSaveStatus";

// Only the destination is shared. Status and timers still belong to the
// selected document; keystrokes do not have to publish state to the app shell.
export const ProjectDocumentStatusOutlet = createContext<HTMLDivElement | null>(
  null,
);

export function ProjectDocumentStatus({
  status,
  expanded,
}: {
  status: DocumentSaveStatus;
  expanded: boolean;
}) {
  const outlet = useContext(ProjectDocumentStatusOutlet);
  if (!status.text || (!expanded && !outlet)) return null;

  const Icon =
    status.tone === "success"
      ? Check
      : status.tone === "dirty"
        ? Pencil
        : status.tone === "neutral"
          ? FileText
          : CircleAlert;
  const badge = (
    <span
      className="document-save-feedback"
      role="status"
      aria-atomic="true"
      aria-description={status.detail}
      title={status.detail ?? status.text}
      data-tone={status.tone}
    >
      {status.showSaving ? (
        <span aria-hidden="true" className="loading-spinner" />
      ) : (
        <Icon size={14} aria-hidden="true" />
      )}
      <span>{status.text}</span>
    </span>
  );
  return outlet && !expanded ? createPortal(badge, outlet) : badge;
}
