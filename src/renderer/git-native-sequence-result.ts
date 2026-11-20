import { t as msg } from "../shared/i18n";
import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import { documentScopeId } from "./settings-documents";
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const recoveryPath = z
  .string()
  .startsWith("/")
  .refine((v) => !v.includes("\0"));
export const nativeResultSchema = z
  .object({
    operationId: z.string().uuid(),
    outcome: z.enum([
      "completed",
      "conflicts",
      "stopped",
      "rejected",
      "uncertain",
    ]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    beforeHead: oid.nullable(),
    afterHead: oid.nullable(),
    conflicts: z.array(z.string().min(1)),
    verifiedUnrelatedData: z.boolean(),
    processSettled: z.boolean(),
    recovery: z.enum(["removed", "retained", "unknown"]),
    recoveryPath: recoveryPath.optional(),
  })
  .strict();
const schema = z.object({
  scope: scopeRefSchema,
  operation: z.enum(["merge", "rebase", "cherry-pick", "revert"]),
  action: z.enum(["continue", "abort"]),
  status: z.enum(["success", "conflict", "error", "uncertain"]),
  changed: z.boolean(),
  lockRetained: z.boolean(),
  retainedLocks: z.array(z.string()),
  uncheckedLocks: z.array(z.string()),
  message: z.string(),
  log: z.string(),
  native: nativeResultSchema,
});
export function verifiedNativeSequenceResult(
  value: unknown,
  submitted: {
    scope: ScopeRef;
    operation: string;
    action: string;
    head: string;
    original: string;
  },
) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return false;
  const v = parsed.data,
    n = v.native;
  if (
    documentScopeId(v.scope) !== documentScopeId(submitted.scope) ||
    v.operation !== submitted.operation ||
    v.action !== submitted.action ||
    !v.changed ||
    v.lockRetained ||
    v.retainedLocks.length ||
    v.uncheckedLocks.length ||
    !n.processSettled ||
    !n.verifiedUnrelatedData ||
    n.signal !== null ||
    // The journal retains the original recovery baseline across all stops.
    n.beforeHead !== submitted.original ||
    !n.afterHead
  )
    return false;
  if (v.status === "success")
    return (
      n.outcome === "completed" &&
      n.exitCode === 0 &&
      !n.conflicts.length &&
      n.recovery === "removed" &&
      n.recoveryPath === undefined &&
      (v.action !== "abort" || n.afterHead === submitted.original)
    );
  return (
    v.status === "conflict" &&
    v.action === "continue" &&
    n.outcome === "conflicts" &&
    n.exitCode === 1 &&
    n.conflicts.length > 0 &&
    n.recovery === "retained" &&
    !!n.recoveryPath
  );
}
export function nativeSequenceDiagnostics(
  value: unknown,
  verified: boolean,
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    return msg("git.nativeGitResponseUnverifiedCheckTheStateThereIsNo");
  const v = parsed.data,
    n = v.native;
  return [
    verified
      ? v.status === "conflict"
        ? msg("git.gitStoppedAtTheNextConflictTheOperationIsNot")
        : msg("git.nativeGitResultVerified")
      : msg("git.resultUnconfirmedThereIsNoAutomaticRetry"),
    v.message,
    v.log,
    msg("git.processExitedUnrelatedFilesPreserved", { value1: String(n.processSettled ? msg("git.yes") : msg("git.unconfirmed")), value2: String(n.verifiedUnrelatedData ? msg("git.verified") : msg("git.unconfirmed2")) }),
    n.recovery === "removed"
      ? msg("git.theSafetySnapshotWasRemovedAfterVerifyingTheResult")
      : n.recovery === "retained" && n.recoveryPath
        ? msg("git.recoveryFiles", { recoveryPath: String(n.recoveryPath) })
        : msg("git.recoveryStateIsUnconfirmed"),
    ...v.retainedLocks.map((p) => msg("git.retainedLock", { p: String(p) })),
    ...v.uncheckedLocks.map((p) => msg("git.unverifiedLock", { p: String(p) })),
    msg("git.gitMaintainsItsLogNormallyNoPushOrAutomaticGoga"),
  ]
    .filter(Boolean)
    .join("\n\n");
}
