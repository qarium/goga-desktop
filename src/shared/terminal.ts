import { z } from "zod";
import { topicContextRefSchema } from "./worktrees";

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v));
const id = text(256);
const recordKey = id.refine(
  (v) => !["__proto__", "constructor", "prototype"].includes(v),
);
export const terminalContextSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("primary"), projectId: id }).strict(),
  topicContextRefSchema
    .omit({ revision: true })
    .extend({ kind: z.literal("topic") })
    .strict(),
]);
export type TerminalContext = z.infer<typeof terminalContextSchema>;

/** Stable identity only; freshness revisions must never replace a live session. */
export function terminalContextKey(context: TerminalContext): string {
  return JSON.stringify(
    context.kind === "primary"
      ? ["primary", context.projectId]
      : [
          "topic",
          context.projectId,
          context.year,
          context.topic,
          context.branch,
          context.contextId,
        ],
  );
}
export function terminalContextFromKey(key: string): TerminalContext {
  if (key.length > 8192) throw Error("Недопустимый контекст терминала.");
  try {
    const a: unknown = JSON.parse(key);
    if (!Array.isArray(a)) throw Error();
    const value =
      a.length === 2 && a[0] === "primary"
        ? { kind: a[0], projectId: a[1] }
        : a.length === 6 && a[0] === "topic"
          ? {
              kind: a[0],
              projectId: a[1],
              year: a[2],
              topic: a[3],
              branch: a[4],
              contextId: a[5],
            }
          : undefined;
    const context = terminalContextSchema.parse(value);
    if (terminalContextKey(context) !== key) throw Error();
    return context;
  } catch {
    throw Error("Недопустимый контекст терминала.");
  }
}
export const terminalTabScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("common") }).strict(),
  z
    .object({ kind: z.literal("context"), context: terminalContextSchema })
    .strict(),
]);
export type TerminalTabScope = z.infer<typeof terminalTabScopeSchema>;
export const terminalTabSchema = z
  .object({
    id,
    projectId: id,
    name: text(120),
    scope: terminalTabScopeSchema,
  })
  .strict()
  .refine(
    (t) =>
      t.scope.kind === "common" || t.scope.context.projectId === t.projectId,
  );
export type TerminalTab = z.infer<typeof terminalTabSchema>;

/** Visibility is shared with validation; it is not host authorization to spawn. */
export function terminalTabMatches(
  tab: TerminalTab,
  context: TerminalContext,
): boolean {
  return (
    tab.projectId === context.projectId &&
    (tab.scope.kind === "common" ||
      terminalContextKey(tab.scope.context) === terminalContextKey(context))
  );
}
export const terminalProjectTabsSchema = z
  .object({
    initialized: z.boolean(),
    tabs: z.array(terminalTabSchema).max(10000),
    selectedByContext: z.record(z.string().max(8192), id),
  })
  .strict()
  .superRefine((p, ctx) => {
    const fail = () =>
      ctx.addIssue({
        code: "custom",
        message: "Недопустимый список вкладок терминала.",
      });
    if (new Set(p.tabs.map((t) => t.id)).size !== p.tabs.length) fail();
    if (
      !p.initialized &&
      (p.tabs.length || Object.keys(p.selectedByContext).length)
    )
      fail();
    if (Object.keys(p.selectedByContext).length > 10000) fail();
    for (const [key, selectedId] of Object.entries(p.selectedByContext)) {
      try {
        const context = terminalContextFromKey(key),
          selected = p.tabs.find((t) => t.id === selectedId);
        if (!selected || !terminalTabMatches(selected, context)) fail();
      } catch {
        fail();
      }
    }
  });
export type TerminalProjectTabs = z.infer<typeof terminalProjectTabsSchema>;
export const terminalRegistrySchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().uuid(),
    projects: z.record(recordKey, terminalProjectTabsSchema),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (Object.keys(r.projects).length > 10000)
      ctx.addIssue({
        code: "custom",
        message: "Слишком много проектов терминала.",
      });
    for (const [projectId, p] of Object.entries(r.projects)) {
      if (
        p.tabs.some((t) => t.projectId !== projectId) ||
        Object.keys(p.selectedByContext).some((k) => {
          try {
            return terminalContextFromKey(k).projectId !== projectId;
          } catch {
            return true;
          }
        })
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Владелец вкладки терминала не совпадает с проектом.",
        });
      }
    }
  });
export type TerminalRegistry = z.infer<typeof terminalRegistrySchema>;
export const terminalSessionRefSchema = z
  .object({ sessionId: id, generation: z.string().uuid() })
  .strict();
export type TerminalSessionRef = z.infer<typeof terminalSessionRefSchema>;
export const terminalInputSchema = terminalSessionRefSchema
  .extend({
    text: z
      .string()
      .max(65536)
      .refine((v) => new TextEncoder().encode(v).byteLength <= 65536),
  })
  .strict();
export const terminalResizeSchema = terminalSessionRefSchema
  .extend({
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();
