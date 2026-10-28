import { balanceTestFiles } from "./ci-test-shards.mjs";

/** Ownership is explicit, not a test allowlist: discovery must match it exactly. */
export function domainGroups(files, manifest) {
  if (new Set(files).size !== files.length)
    throw Error("Duplicate discovered test");
  const discovered = new Set(files),
    owners = new Set(),
    groups = {};
  for (const [domain, entries] of Object.entries(manifest)) {
    if (
      !/^[a-z][a-z-]*$/.test(domain) ||
      !Array.isArray(entries) ||
      entries.length === 0
    )
      throw Error("Invalid or empty CI domain");
    groups[domain] = [];
    for (const file of entries) {
      if (owners.has(file)) throw Error(`Duplicate test ownership: ${file}`);
      if (!discovered.has(file)) throw Error(`Stale test ownership: ${file}`);
      owners.add(file);
      groups[domain].push(file);
    }
    groups[domain].sort();
  }
  for (const file of files)
    if (!owners.has(file))
      throw Error(`Unassigned test: ${file}; assign a CI domain`);
  return groups;
}
export function selectDomainShard(
  files,
  manifest,
  domain,
  index,
  count,
  weights,
) {
  const groups = domainGroups(files, manifest);
  if (!Object.hasOwn(groups, domain))
    throw Error(`Unknown CI domain: ${domain}`);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    index < 1 ||
    index > count ||
    count < 1 ||
    count > groups[domain].length
  )
    throw Error("Invalid or empty domain shard");
  return balanceTestFiles(groups[domain], count, weights)[index - 1];
}
