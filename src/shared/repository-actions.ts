import { z } from "zod";
import { topicContextRefSchema } from "./worktrees";

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
      !["propagate", "update-remote"].includes(value.action) || !!value.context,
    {
      message: "Действие доступно только в выбранном контексте топика.",
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
