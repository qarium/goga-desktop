import { z } from "zod";
import { topicContextRefSchema } from "./worktrees";

/** The user explicitly files an external panel under a host-validated selection.
 * AFM does not attest to a project, a working copy, or ownership of a process. */
export const dashboardOwnerSchema = z
  .object({
    projectId: z.string().min(1).max(256),
    context: topicContextRefSchema.optional(),
  })
  .strict()
  .refine(
    (owner) => !owner.context || owner.context.projectId === owner.projectId,
  );
export type DashboardOwner = z.infer<typeof dashboardOwnerSchema>;

export function sameDashboardOwner(
  a: DashboardOwner,
  b: DashboardOwner,
): boolean {
  const x = a.context,
    y = b.context;
  return (
    a.projectId === b.projectId &&
    ((!x && !y) ||
      (!!x &&
        !!y &&
        x.contextId === y.contextId &&
        x.projectId === y.projectId &&
        x.year === y.year &&
        x.topic === y.topic &&
        x.branch === y.branch))
  );
}

/** Observation only. Deliberately not a Run, a launch request, or a process handle. */
export interface AttachedDashboard {
  id: string;
  owner: DashboardOwner;
  url: string;
  runId: string;
  name: string;
  description?: string;
  startedAt?: string;
  status?: string;
}
