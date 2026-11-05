/** A selection is scoped to the currently visible ordered rows, not editor tabs. */
export function selectOverviewRows(
  visible: readonly string[],
  selected: readonly string[],
  anchor: string | null,
  path: string,
  modifiers: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
): { paths: string[]; anchor: string } {
  const additive = modifiers.metaKey || modifiers.ctrlKey;
  const visiblePaths = new Set(visible);
  const current = new Set(selected.filter((p) => visiblePaths.has(p)));
  if (modifiers.shiftKey && anchor && visible.includes(anchor)) {
    const a = visible.indexOf(anchor),
      b = visible.indexOf(path);
    const range = visible.slice(Math.min(a, b), Math.max(a, b) + 1);
    if (!additive) current.clear();
    range.forEach((p) => current.add(p));
    return { paths: visible.filter((p) => current.has(p)), anchor };
  }
  if (additive) {
    if (current.has(path)) current.delete(path);
    else current.add(path);
  } else {
    current.clear();
    current.add(path);
  }
  return { paths: visible.filter((p) => current.has(p)), anchor: path };
}
