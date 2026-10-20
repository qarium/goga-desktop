import type { Pipeline } from "./types";
import {
  isProjectWorkflowName,
  projectWorkflowAliasKey,
  type ProjectWorkflow,
} from "./project-documents";

/** Collision policy only; never rewrite pipeline IDs or validate YAML content. */
export function availableWorkflowPipelines(
  pipelines: Pipeline[],
  files: ProjectWorkflow[],
  drafts: string[] = [],
): Pipeline[] {
  const occupied = new Set([
    ...files.map((file) =>
      projectWorkflowAliasKey(file.path.split("/").pop()!),
    ),
    ...drafts.map((name) => projectWorkflowAliasKey(name + ".yml")),
  ]);
  const unique = new Map<string, Pipeline>();
  const aliases = new Map<string, Set<string>>();
  for (const pipeline of pipelines) {
    if (!isProjectWorkflowName(pipeline.id)) continue;
    if (!unique.has(pipeline.id)) unique.set(pipeline.id, pipeline);
    const key = projectWorkflowAliasKey(pipeline.id + ".yml");
    const ids = aliases.get(key) ?? new Set<string>();
    ids.add(pipeline.id);
    aliases.set(key, ids);
  }
  return [...unique.values()].filter((pipeline) => {
    const key = projectWorkflowAliasKey(pipeline.id + ".yml");
    return !occupied.has(key) && aliases.get(key)!.size === 1;
  });
}
