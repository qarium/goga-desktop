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
      message: "Контекст относится к другому проекту.",
    },
  )
  .refine(
    (value) =>
      !["propagate", "update-remote"].includes(value.action) ||
      !!value.context ||
      (value.action === "propagate" && !!value.propagation),
    {
      message: "Действие доступно только в выбранном контексте топика.",
    },
  )
  .refine((value) => !value.propagation || value.action === "propagate", {
    message: "Выбор ветки публикации доступен только для propagate.",
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
      message: "Контекст не совпадает с выбранным топиком.",
    },
  );
export type RepositoryAction = z.infer<typeof repositoryActionSchema>;
export type RepositoryActionRequest = z.infer<
  typeof repositoryActionRequestSchema
>;
export interface RepositoryActionResult {
  projectId: string;
  contextId?: string;
  action: RepositoryAction;
  status: "success" | "error";
  log: string;
  error?: string;
}
