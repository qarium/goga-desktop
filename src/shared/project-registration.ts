import { z } from "zod";

/** Exact registry binding; removing a project never grants filesystem authority. */
export const projectRemovalRequestSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !/[\x00-\x1f\x7f]/.test(value)),
  })
  .strict();
export type ProjectRemovalRequest = z.infer<typeof projectRemovalRequestSchema>;
