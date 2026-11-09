import { z } from "zod";
import type { LaunchRequest } from "./types";

const name = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (value) =>
      !value.startsWith("-") &&
      !/[\/\\\x00-\x20]/.test(value) &&
      !value.includes(".."),
  );
/** Durable choices only: no raw request, task, stale tokens or environment. */
export const pipelineRepeatSnapshotSchema = z
  .object({
    version: z.literal(1),
    workflow: z
      .string()
      .refine(
        (value) =>
          name.safeParse(value.startsWith("file:") ? value.slice(5) : value)
            .success,
      ),
    profile: z
      .string()
      .max(180)
      .regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*)?$/),
    profileMode: z.enum(["project", "auto"]).optional(),
    skips: z.array(name).max(1000),
    clean: z.boolean(),
    update: z.boolean(),
  })
  .strict()
  .refine((value) => value.profileMode !== "auto" || value.profile === "");

export type PipelineRepeatSnapshot = z.infer<
  typeof pipelineRepeatSnapshotSchema
>;
export function capturePipelineRepeat(
  request: Pick<
    LaunchRequest,
    "workflow" | "profile" | "profileMode" | "skips" | "clean" | "update"
  >,
): PipelineRepeatSnapshot {
  return pipelineRepeatSnapshotSchema.parse({
    version: 1,
    workflow: request.workflow,
    profile: request.profile,
    ...(request.profileMode ? { profileMode: request.profileMode } : {}),
    skips: request.skips,
    clean: request.clean,
    update: request.update === true,
  });
}
