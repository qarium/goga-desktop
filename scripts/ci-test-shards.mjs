/** Deterministic longest-first scheduling. Weights estimate elapsed fixture work,
 * never decide coverage: unknown/new files are included with weight 1. */
export function balanceTestFiles(files, count, weights) {
  if (!Number.isInteger(count) || count < 1) throw Error("Invalid shard count");
  if (new Set(files).size !== files.length) throw Error("Duplicate test file");
  const weight = (file) => {
    const value = Object.hasOwn(weights, file) ? weights[file] : 1;
    if (!Number.isFinite(value) || value <= 0)
      throw Error("Invalid test weight");
    return value;
  };
  const groups = Array.from({ length: count }, () => ({
    weight: 0,
    files: [],
  }));
  for (const file of [...files].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const group = groups.reduce((best, item) =>
      item.weight < best.weight ? item : best,
    );
    group.files.push(file);
    group.weight += weight(file);
  }
  return groups.map(({ files }) => files);
}
