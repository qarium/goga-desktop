const labels: Record<string, string> = {
  base: "Совпадает с базой",
  "up-to-date": "База актуальна",
  propagated: "Перенесён в базу",
  "need-update": "Требует обновления",
};

/** Display the native value without assigning meaning to future codes. */
export function TopicDivergence({ divergence }: { divergence: string | null }) {
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
