import { z } from "zod";

// Presentation geometry only; this never selects a run or grants dashboard IPC.
const coordinate = z.number().int().min(0).max(100_000);
export const dashboardViewportSchema = z
  .object({
    x: coordinate,
    y: coordinate,
    width: coordinate,
    height: coordinate,
  })
  .strict();
export type DashboardViewport = z.infer<typeof dashboardViewportSchema>;
