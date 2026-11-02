import { z } from "zod";
import { topicContextRefSchema } from "./worktrees";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value),
  );
const cleanLabel = (value: string, max: number) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, max);
const label = (max: number) =>
  z.string().transform((value) => cleanLabel(value, max));

/** The history stores this display label; matching must use the same normalization. */
export const notificationPipelineLabel = (run: {
  pipeline: string;
  pipelineName?: string;
}) => cleanLabel(run.pipelineName || run.pipeline, 1024);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const NotificationKindSchema = z.enum([
  "question",
  "approval",
  "stage-failed",
  "paused",
  "assistant-decision",
  "run-finished",
  "run-failed",
  "process-exited",
]);
const inputShape = {
  id: identifier,
  runId: identifier,
  projectId: identifier,
  context: topicContextRefSchema.optional(),
  pipeline: label(1024),
  topic: label(1024),
  branch: label(256),
  stageId: identifier.optional(),
  kind: NotificationKindSchema,
  occurredAt: z.string().datetime(),
};
const sameOwner = (value: {
  projectId: string;
  topic: string;
  branch: string;
  context?: { projectId: string; topic: string; branch: string };
}) =>
  !value.context ||
  (value.projectId === value.context.projectId &&
    value.topic === value.context.topic &&
    value.branch === value.context.branch);

/** Deliberately strict: question bodies, agent messages, paths and raw AFM payloads are not history. */
export const NotificationInputSchema = z
  .object(inputShape)
  .strict()
  .refine(sameOwner);
export const NotificationRecordSchema = z
  .object({
    ...inputShape,
    sequence: sequence.positive(),
    readAt: z.string().datetime().nullable(),
  })
  .strict()
  .refine(sameOwner);
export const NotificationPageRequestSchema = z
  .object({
    beforeSequence: sequence.optional(),
    limit: z.number().int().min(1).max(50).default(50),
  })
  .strict();
export const NotificationSnapshotSchema = z
  .object({
    revision: sequence,
    records: z.array(NotificationRecordSchema).max(50),
    throughSequence: sequence,
    hasMore: z.boolean(),
    unreadCount: sequence,
    byProject: z.record(identifier, sequence),
    unreadRunIds: z.array(identifier),
    systemEnabled: z.boolean(),
    error: z.string().max(1024).optional(),
  })
  .strict();

export type NotificationKind = z.infer<typeof NotificationKindSchema>;
export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;
export type NotificationInput = Omit<NotificationRecord, "sequence" | "readAt">;
export type NotificationSnapshot = z.infer<typeof NotificationSnapshotSchema>;
export type NotificationPageRequest = z.input<
  typeof NotificationPageRequestSchema
>;
