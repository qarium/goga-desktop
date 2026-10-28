import { BaseSequencer, type TestSpecification } from "vitest/node";
import path from "node:path";
import weights from "../../scripts/ci-test-weights.json";
import { balanceTestFiles } from "../../scripts/ci-test-shards.mjs";

/** Balance all four complete CI shards instead of concentrating long Git
 * lifecycles in one job. Normal unsharded runs keep Vitest's default ordering. */
export class CiSequencer extends BaseSequencer {
  async shard(
    specifications: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return specifications;
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
    const groups = balanceTestFiles([...entries.keys()], shard.count, weights);
    const selected = groups[shard.index - 1];
    if (!selected) throw Error("Invalid shard index");
    return selected.map((file: string) => entries.get(file)!);
  }
}
