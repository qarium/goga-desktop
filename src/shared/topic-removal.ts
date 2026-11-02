import { z } from "zod";
import {
  topicBranchSchema,
  topicSlugSchema,
  topicYearSchema,
} from "./topics-schema";
import { topicContextRefSchema, type TopicContextRef } from "./worktrees";
import type { ContextDeletionPreview } from "./context-deletion";
const common = {
  projectId: z.string().min(1).max(256),
  year: topicYearSchema,
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
};
export const topicRemovalRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("delete"),
      topics: z.array(topicSlugSchema).min(1).max(1000),
    })
    .strict(),
  z
    .object({
      ...common,
      action: z.literal("clear"),
      baseRef: topicBranchSchema,
    })
    .strict(),
]);
export type TopicRemovalRequest = z.infer<typeof topicRemovalRequestSchema>;
export const topicRemovalTokenSchema = z
  .object({ projectId: common.projectId, token: z.string().uuid() })
  .strict();
export const topicCloneCleanupRequestSchema = z
  .object({
    owner: topicContextRefSchema,
    operationToken: z.string().uuid().optional(),
  })
  .strict();
export type TopicCloneCleanupRequest = z.infer<
  typeof topicCloneCleanupRequestSchema
>;
export interface TopicRemovalPreview {
  token: string;
  projectId: string;
  year: string;
  action: "delete" | "clear";
  details: string[];
  expiresAt: number;
  blocked?: Array<{ topic: string; reason: string }>;
}
export interface TopicCloneCleanupResult {
  contextId: string;
  topic: string;
  status: "removed" | "kept" | "needs-confirmation" | "uncertain";
  reason?: string;
}
export interface TopicRemovalResult {
  projectId: string;
  topics: { status: "success" | "partial" | "failed"; message: string };
  copies: TopicCloneCleanupResult[];
  cleanup: Array<{ owner: TopicContextRef; plan: ContextDeletionPreview }>;
}
