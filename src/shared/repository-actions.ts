import { t as tr } from "./i18n";
import type { GitUpdateHandoffCandidate } from "./git-update-handoff";
import { z } from "zod";
import { topicContextRefSchema } from "./worktrees";
import {
  topicBranchSchema,
  topicSlugSchema,
  topicYearSchema,
} from "./topics-schema";

export const topicPropagationSchema = z
  .object({
    year: topicYearSchema,
    topic: topicSlugSchema,
    branch: topicBranchSchema,
    baseRef: topicBranchSchema,
  })
  .strict();

export const repositoryActionSchema = z.enum([
  "sync",
  "publish",
  "update-base",
  "update-remote",
  "propagate",
]);
export const repositoryActionRequestSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    context: topicContextRefSchema.optional(),
    action: repositoryActionSchema,
    propagation: topicPropagationSchema.optional(),
  })
  .strict()
  .refine(
    (value) => !value.context || value.context.projectId === value.projectId,
    {
      error: () => tr("host.theContextBelongsToAnotherProject"),
    },
  )
  .refine(
    (value) =>
      !["propagate", "update-remote"].includes(value.action) ||
      !!value.context ||
      (value.action === "propagate" && !!value.propagation),
    {
      error: () => tr("host.thisActionRequiresASelectedTopicContext"),
    },
  )
  .refine((value) => !value.propagation || value.action === "propagate", {
    error: () => tr("host.selectingAPublicationBranchIsOnlyAvailableForPropagation"),
  })
  .refine(
    (value) =>
      !value.propagation ||
      !value.context ||
      ["year", "topic", "branch"].every(
        (key) =>
          value.propagation![key as "year" | "topic" | "branch"] ===
          value.context![key as "year" | "topic" | "branch"],
      ),
    {
      error: () => tr("host.theContextDoesNotMatchTheSelectedTopic"),
    },
  );
export type RepositoryAction = z.infer<typeof repositoryActionSchema>;
export type RepositoryActionRequest = z.infer<
  typeof repositoryActionRequestSchema
>;
export interface RepositoryActionResult {
  handoff?: GitUpdateHandoffCandidate;
  projectId: string;
  contextId?: string;
  action: RepositoryAction;
  status: "success" | "error";
  log: string;
  error?: string;
}
