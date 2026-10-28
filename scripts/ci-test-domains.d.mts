export function domainGroups(
  files: readonly string[],
  manifest: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]>;
export function selectDomainShard(
  files: readonly string[],
  manifest: Readonly<Record<string, readonly string[]>>,
  domain: string,
  index: number,
  count: number,
  weights: Readonly<Record<string, number>>,
): string[];
