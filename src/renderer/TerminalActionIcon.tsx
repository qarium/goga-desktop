export function TerminalActionIcon({
  kind,
}: {
  kind:
    | "plus"
    | "close"
    | "more"
    | "refresh"
    | "rename"
    | "left"
    | "right"
    | "chevron"
    | "common"
    | "topic"
    | "folder";
}) {
  if (kind === "refresh")
    return (
      <span className="terminal-refresh-icon" aria-hidden="true">
        ↻
      </span>
    );
  const paths = {
    chevron: "m6 9 6 6 6-6",
    common: "M3 4h18v16H3Z M3 9h18 M9 9v11",
    topic:
      "M6 3v12a6 6 0 0 0 12 0V9 M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4 M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
    folder: "M3 6h7l2 3h9v11H3Z",
    plus: "M12 5v14M5 12h14",
    close: "M6 6l12 12M18 6 6 18",
    rename: "m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5",
    left: "M19 12H5m6-6-6 6 6 6",
    right: "M5 12h14m-6-6 6 6-6 6",
  };
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "more" ? (
        <>
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </>
      ) : (
        <path d={paths[kind]} />
      )}
    </svg>
  );
}
