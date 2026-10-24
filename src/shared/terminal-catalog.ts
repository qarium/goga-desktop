import { z } from "zod";
import { scopeRefSchema } from "./context";
import {
  terminalTabSchema,
  type TerminalContext,
  type TerminalTab,
} from "./terminal";
const base = z
  .object({ scope: scopeRefSchema, revision: z.string().uuid() })
  .strict();
const target = base.extend({ tabId: terminalTabSchema.shape.id }).strict();
export const terminalCatalogChangeSchema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("initialize") }).strict(),
  base
    .extend({ kind: z.literal("create"), area: z.enum(["common", "context"]) })
    .strict(),
  target
    .extend({ kind: z.literal("rename"), name: terminalTabSchema.shape.name })
    .strict(),
  target.extend({ kind: z.literal("select") }).strict(),
  target
    .extend({
      kind: z.literal("reorder"),
      targetTabId: terminalTabSchema.shape.id,
    })
    .strict(),
  target
    .extend({ kind: z.literal("move"), direction: z.enum(["left", "right"]) })
    .strict(),
]);
export type TerminalCatalogChange = z.infer<typeof terminalCatalogChangeSchema>;
/** Only the selected owner's visible tabs, never the registry of other projects. */
export interface TerminalCatalogSnapshot {
  revision: string;
  context: TerminalContext;
  initialized: boolean;
  tabs: TerminalTab[];
  selectedId: string | null;
}

/** Only selection persistence may retry this CAS conflict after a fresh read. */
export const TERMINAL_SELECTION_STALE = "TERMINAL_SELECTION_REVISION_CHANGED";
