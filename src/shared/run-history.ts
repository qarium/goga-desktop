import { z } from "zod";
import { scopeRefSchema } from "./context";

const runId = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const clearRunHistoryRequestSchema = z
  .object({
    scope: scopeRefSchema,
    kind: z.enum(["pipeline", "build"]),
    runIds: z
      .array(runId)
      .min(1)
      .max(100000)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type ClearRunHistoryRequest = z.infer<
  typeof clearRunHistoryRequestSchema
>;
export interface ClearRunHistoryResult {
  removedRunIds: string[];
  retained: {
    id: string;
    reason: "active" | "pending-sync" | "unverified" | "busy";
  }[];
}
