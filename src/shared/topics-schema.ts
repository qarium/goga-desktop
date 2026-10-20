import { topicContextRefSchema } from "./worktrees";
import { z } from "zod";
export const topicYearSchema = z.string().regex(/^\d{4}$/);
export const topicBranchSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((v) => !v.startsWith("-") && !/[\x00-\x20\x7f]/.test(v));
export const topicSlugSchema = z
  .string()
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const topicTargetSchema = z
  .object({
    topic: topicSlugSchema,
    branch: topicBranchSchema,
    remote: z.boolean(),
  })
  .strict();
const record = z
  .object({
    topic: topicSlugSchema,
    branch: topicBranchSchema,
    statuses: z.array(z.string().max(256)).max(1000),
    current: z.boolean(),
    remote: z.boolean(),
    todo: z.string().nullable(),
    divergence: z.string().nullable(),
  })
  .strict();
export const topicRecordsSchema = z.array(record).max(100000);
export const topicEntriesSchema = z
  .array(record.extend({ hosts: z.array(topicBranchSchema).max(10000) }))
  .max(100000);
export const topicOperationSchema = z
  .object({
    context: topicContextRefSchema.optional(),
    projectId: z.string().min(1).max(256),
    year: topicYearSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
    action: z.enum([
      "create",
      "switch",
      "save-task",
      "update",
      "publish",
      "propagate",
      "delete",
    ]),
    target: topicTargetSchema.optional(),
    topics: z.array(topicSlugSchema).min(1).max(1000).optional(),
    branch: topicBranchSchema.optional(),
    baseRef: topicBranchSchema.optional(),
    task: z.string().max(100000).optional(),
    taskVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    publish: z.boolean().optional(),
    switch: z.boolean().optional(),
    commit: z
      .string()
      .min(1)
      .max(10000)
      .refine((v) => !v.includes("\0"))
      .optional(),
  })
  .strict();
export const topicTokenSchema = z.string().uuid();
