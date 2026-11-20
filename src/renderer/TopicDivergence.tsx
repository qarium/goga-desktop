import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
const labels: Record<string, string> = {
  get base() { return tr("topics.matchesBase"); },
  get "up-to-date"() { return tr("topics.baseUpToDate"); },
  get propagated() { return tr("topics.propagatedToBase"); },
  get "need-update"() { return tr("topics.updateNeeded"); },
};

/** Display the native value without assigning meaning to future codes. */
export function TopicDivergence({ divergence }: { divergence: string | null }) {
  useLocale();
  if (divergence === null) return <span className="hint">—</span>;
  const known = Object.hasOwn(labels, divergence);
  return (
    <span
      className={`topic-divergence${known ? ` topic-divergence-${divergence}` : ""}`}
      title={divergence}
    >
      {known ? labels[divergence] : divergence}
    </span>
  );
}
