import {
  buildOptionsSchema,
  validateBuildOptions,
  type BuildOptions,
} from "../shared/build";
import {
  buildRepeatSnapshotSchema,
  type BuildRepeatSnapshot,
} from "../shared/build-repeat";
import type { TopicContextRef } from "../shared/worktrees";

/** Raw values exist only in the caller's transient request, never this projection. */
export function createBuildRepeatSnapshot(
  options: BuildOptions,
  metadata: { sourceRunId?: string; owner?: TopicContextRef } = {},
): BuildRepeatSnapshot {
  validateBuildOptions(options);
  const parsed = buildOptionsSchema.parse(options);
  const { env, proxy, ...safe } = parsed;
  return buildRepeatSnapshotSchema.parse({
    options: safe,
    requiredEnvKeys: [...new Set((env ?? []).map((entry) => entry.key))],
    requiresProxy: proxy !== undefined,
    ...metadata,
  });
}
