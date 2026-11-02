import "./TopicContextPicker.css";

/** Shared compact header feedback; reuse creation's responsive/reduced-motion
 * styling so all context operations stay consistent. Owns no async state. */
export function ContextOperationProgress({
  label,
  message,
}: {
  label: string;
  message: string;
}) {
  return (
    <div
      className="topic-context-creation-feedback"
      role="status"
      aria-label={label}
      aria-live="polite"
      aria-atomic="true"
      title={label}
    >
      <span className="topic-context-creation-spinner" aria-hidden="true" />
      <span className="topic-context-creation-message">{message}</span>
    </div>
  );
}
