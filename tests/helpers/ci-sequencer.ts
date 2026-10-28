import { BaseSequencer, type TestSpecification } from "vitest/node";
import path from "node:path";
import domains from "../../scripts/ci-test-domains.json";
import { selectDomainShard } from "../../scripts/ci-test-domains.mjs";
import armWeights from "../../scripts/ci-test-weights-arm64.json";
import weights from "../../scripts/ci-test-weights.json";
import { balanceTestFiles } from "../../scripts/ci-test-shards.mjs";

/** Domain ownership is checked against all discovered specs before partitioning.
 * Manual Intel and local full runs retain complete-suite weighted sharding. */
export class CiSequencer extends BaseSequencer {
  async sort(
    specifications: TestSpecification[],
  ): Promise<TestSpecification[]> {
    if (!process.env.GOGA_CI_DOMAIN) return super.sort(specifications);
    // File size is not the cost of native Git/Host scenarios. Start measured
    // long files first so they cannot become a serial tail after workers idle.
    const key = (spec: TestSpecification) =>
      path
        .relative(this.ctx.config.root, spec.moduleId)
        .split(path.sep)
        .join("/");
    const weight = (spec: TestSpecification) =>
      (armWeights as Record<string, number>)[key(spec)] ?? 1;
    return [...specifications].sort(
      (a, b) =>
        weight(b) - weight(a) ||
        (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0),
    );
  }

  async shard(
    specifications: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) {
      if (process.env.GOGA_CI_DOMAIN)
        throw Error("CI domain requires an explicit shard");
      return specifications;
    }
    const entries = new Map(
      specifications.map((spec) => [
        path
          .relative(this.ctx.config.root, spec.moduleId)
          .split(path.sep)
          .join("/"),
        spec,
      ]),
    );
    if (entries.size !== specifications.length)
      throw Error("Duplicate test specification");
    const domain = process.env.GOGA_CI_DOMAIN;
    const selected = domain
      ? selectDomainShard(
          [...entries.keys()],
          domains,
          domain,
          shard.index,
          shard.count,
          armWeights,
        )
      : balanceTestFiles([...entries.keys()], shard.count, weights)[
          shard.index - 1
        ];
    if (!selected) throw Error("Invalid shard index");
    return selected.map((file: string) => entries.get(file)!);
  }
}
