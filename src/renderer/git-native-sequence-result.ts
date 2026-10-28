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
    return "Ответ штатной операции Git не подтверждён. Проверьте состояние; автоматического повтора нет.";
  const v = parsed.data,
    n = v.native;
  return [
    verified
      ? v.status === "conflict"
        ? "Git остановился на следующем конфликте; операция ещё не завершена."
        : "Результат штатной операции Git проверен."
      : "Результат не подтверждён. Автоматического повтора нет.",
    v.message,
    v.log,
    `Процесс завершён: ${n.processSettled ? "да" : "не подтверждено"}. Сохранность несвязанных файлов: ${n.verifiedUnrelatedData ? "проверена" : "не подтверждена"}.`,
    n.recovery === "removed"
      ? "Защитный снимок удалён после проверки результата."
      : n.recovery === "retained" && n.recoveryPath
        ? `Материалы восстановления: ${n.recoveryPath}`
        : "Состояние материалов восстановления не подтверждено.",
    ...v.retainedLocks.map((p) => `Сохранена блокировка: ${p}`),
    ...v.uncheckedLocks.map((p) => `Не проверена блокировка: ${p}`),
    "Git ведёт свой журнал штатно. Публикация и автоматический повтор Goga не выполнялись.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
