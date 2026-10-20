import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !/[\x00-\x1f\x7f]/.test(v));
export const topicContextIdentitySchema = z
  .object({
    projectId: text(256),
    year: z.string().regex(/^\d{4}$/),
    topic: text(1024),
    branch: text(256).refine(
      (v) => !v.startsWith("-") && !/[\x00-\x20\x7f]/.test(v),
    ),
  })
  .strict();
export const topicContextRefSchema = topicContextIdentitySchema
  .extend({
    contextId: z.string().regex(/^ctx-[a-f0-9]{64}$/),
    revision: z.string().uuid(),
  })
  .strict();
export const topicContextReadinessSchema = z.union([
  topicContextRefSchema,
  topicContextIdentitySchema,
]);
export type TopicContextIdentity = z.infer<typeof topicContextIdentitySchema>;
export type TopicContextRef = z.infer<typeof topicContextRefSchema>;

/** Host-owned paths must never be accepted from a renderer as execution cwd. */
export const worktreeRecordSchema = topicContextRefSchema
  .extend({
    storageKind: z.enum(["clone", "linked"]).optional(),
    sourceCommonDir: text(4096).optional(),
    compatibility: z.literal("legacy-linked").optional(),
    repositoryKey: z.string().regex(/^[a-f0-9]{64}$/),
    projectPath: text(4096),
    gitCommonDir: text(4096),
    path: text(4096),
    ownership: z.enum(["managed", "primary", "external"]),
    state: z.enum(["ready", "missing", "conflict", "deleting"]),
    preparation: z.enum(["pending", "ambiguous"]).optional(),
    deletedAt: z.string().datetime().optional(),
    reason: z
      .enum([
        "missing",
        "path",
        "repository",
        "branch",
        "registration",
        "ambiguous-add",
        "ownership",
        "legacy-linked",
      ])
      .optional(),
  })
  .strict();
export type WorktreeRecord = z.infer<typeof worktreeRecordSchema>;
export interface WorktreeRegistry {
  revision: string;
  records: WorktreeRecord[];
}

/** Extract a narrow reference from a host-owned record, without exposing paths. */
export function worktreeContextRef(record: WorktreeRecord): TopicContextRef {
  return topicContextRefSchema.parse({
    projectId: record.projectId,
    year: record.year,
    topic: record.topic,
    branch: record.branch,
    contextId: record.contextId,
    revision: record.revision,
  });
}
