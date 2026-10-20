import { z } from "zod";
import { buildOptionsSchema } from "./build";
import { topicContextRefSchema } from "./worktrees";

/** Durable repeat data is an allowlist, never a redacted raw request. */
export const buildRepeatOptionsSchema = buildOptionsSchema
  .omit({ env: true, proxy: true })
  .strict();
const requiredEnvKeysSchema = z
  .array(buildOptionsSchema.shape.env.unwrap().element.shape.key)
  .max(256)
  .refine((keys) => new Set(keys).size === keys.length);
const runIdSchema = z.string().min(1).max(256);
export const buildRepeatSnapshotSchema = z
  .object({
    options: buildRepeatOptionsSchema,
    requiredEnvKeys: requiredEnvKeysSchema,
    requiresProxy: z.boolean(),
    sourceRunId: runIdSchema.optional(),
    owner: topicContextRefSchema.optional(),
  })
  .strict();
export type BuildRepeatOptions = z.infer<typeof buildRepeatOptionsSchema>;
export type BuildRepeatSnapshot = z.infer<typeof buildRepeatSnapshotSchema>;

/** Preparation only; a current preflight and explicit form review are required. */
export const buildRepeatPreparationSchema = z
  .object({
    sourceRunId: runIdSchema,
    projectId: z.string().min(1).max(256),
    context: topicContextRefSchema.optional(),
    planPath: z
      .string()
      .min(1)
      .max(4096)
      .refine((path) => !/[\x00-\x1f\x7f]/.test(path)),
    options: buildRepeatOptionsSchema,
    requiredEnvKeys: requiredEnvKeysSchema,
    requiresProxy: z.boolean(),
    requiresReview: z.literal(true),
    legacyIncomplete: z.boolean().optional(),
  })
  .strict();
export type BuildRepeatPreparation = z.infer<
  typeof buildRepeatPreparationSchema
>;
