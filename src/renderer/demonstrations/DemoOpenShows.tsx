import { HintButton } from "../ActionHint";
import { t } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DemoShow } from "../../shared/demonstrations";
import { DemoConfirm } from "./DemoConfirm";
import { demoError } from "./directory";

type StopShow = (showId: string) => Promise<void>;

// A row is keyed by the host's show instance. If its owner disappears or is
// replaced, the row and its confirmation disappear together.
function OpenShow({
  showId,
  label,
  stop,
}: {
  showId: string;
  label: string;
  stop: StopShow;
}) {
  useLocale();
  const [confirm, setConfirm] = useState(false),
    [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function finish() {
    if (!confirm || inFlight.current) return;
    inFlight.current = true;
    setClosing(true);
    setConfirm(false);
    setError("");
    try {
      await stop(showId);
      // Leave this row disabled until the parent receives the updated inventory.
    } catch (e) {
      inFlight.current = false;
      setClosing(false);
      setError(demoError(e));
    }
  }
  const title = t("general.endShowNamed", {name: label});
  return (
    <li>
      <span>{label}</span>{" "}
      <HintButton
        type="button"
        className="close-tab"
        aria-label={title}
        hint={title}
        disabled={closing}
        aria-busy={closing}
        onClick={() => {
          setError("");
          setConfirm(true);
        }}
      >
        ×
      </HintButton>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirm &&
        createPortal(
          <DemoConfirm
            q={{
              action: "stop",
              title: t("general.endDemonstration2"),
              submit: t("general.endDemonstration3"),
              detail:
                t("general.endShowDetail", {name:label}),
            }}
            cancel={() => setConfirm(false)}
            submit={() => void finish()}
          />,
          document.body,
        )}
    </li>
  );
}

export function DemoOpenShows({
  shows,
  stop,
}: {
  shows: DemoShow[];
  stop: StopShow;
}) {
  useLocale();
  if (!shows.length) return null;
  // Two revisions of the same checkout can have identical human-readable names.
  // Preserve inventory order; disambiguate only colliding labels, not with URLs.
  const counts = new Map<string, number>(),
    seen = new Map<string, number>();
  for (const { label } of shows)
    counts.set(label, (counts.get(label) ?? 0) + 1);
  return (
    <details>
      <summary>{t("general.openShowsSummary",{count:shows.length})}</summary>
      {[...counts.values()].some((n) => n > 1) && (
        <small>{t("general.demonstrationsWithTheSameNameAreNumberedInThe")}</small>
      )}
      <ul>
        {shows.map(({ showId, label }) => {
          const n = (seen.get(label) ?? 0) + 1;
          seen.set(label, n);
          return (
            <OpenShow
              key={showId}
              showId={showId}
              label={counts.get(label)! > 1 ? label + " · №" + n : label}
              stop={stop}
            />
          );
        })}
      </ul>
    </details>
  );
}
