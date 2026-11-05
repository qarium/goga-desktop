/** Presentation metadata never participates in command arguments or admission. */
export const PIPELINE_DISPLAY_LIMITS = {
  name: 1024,
  description: 16000,
} as const;

export function pipelineDisplayMetadata(input: {
  pipelineName?: unknown;
  pipelineDescription?: unknown;
}): { pipelineName?: string; pipelineDescription?: string } {
  const clean = (value: string, max: number) =>
    value.replace(/\0/g, "").slice(0, max);
  return {
    ...(typeof input.pipelineName === "string"
      ? {
          pipelineName: clean(input.pipelineName, PIPELINE_DISPLAY_LIMITS.name),
        }
      : {}),
    ...(typeof input.pipelineDescription === "string"
      ? {
          pipelineDescription: clean(
            input.pipelineDescription,
            PIPELINE_DISPLAY_LIMITS.description,
          ),
        }
      : {}),
  };
}
