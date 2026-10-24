import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
import {
  terminalCatalogChangeSchema,
  type TerminalCatalogSnapshot,
} from "./terminal-catalog";
import {
  terminalSessionRefSchema,
  terminalTabSchema,
  type TerminalContext,
  type TerminalSessionRef,
} from "./terminal";
const target = z
  .object({
    scope: scopeRefSchema,
    revision: z.string().uuid(),
    tabId: terminalTabSchema.shape.id,
  })
  .strict();
export const terminalSurfaceBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(32768),
    y: z.number().int().min(0).max(32768),
    width: z.number().int().min(1).max(32768),
    height: z.number().int().min(1).max(32768),
  })
  .strict();
export const terminalControlRequestSchema = z.discriminatedUnion("kind", [
  ...terminalCatalogChangeSchema.options,
  z.object({ kind: z.literal("read"), scope: scopeRefSchema }).strict(),
  target.extend({ kind: z.literal("open") }).strict(),
  target
    .extend({
      kind: z.literal("show"),
      ref: terminalSessionRefSchema,
      bounds: terminalSurfaceBoundsSchema,
    })
    .strict(),
  target
    .extend({
      kind: z.literal("preview"),
      ref: terminalSessionRefSchema,
      bounds: terminalSurfaceBoundsSchema,
    })
    .strict(),
  target
    .extend({
      kind: z.literal("activate"),
      ref: terminalSessionRefSchema,
      bounds: terminalSurfaceBoundsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("hide") }).strict(),
  target.extend({ kind: z.literal("prepare-close") }).strict(),
  target
    .extend({
      kind: z.literal("prepare-refresh"),
      ref: terminalSessionRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirm"),
      token: z.string().uuid(),
      confirmed: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("cancel"), token: z.string().uuid() }).strict(),
]);
export type TerminalControlRequest = z.infer<
  typeof terminalControlRequestSchema
>;
export type TerminalSurfaceBounds = z.infer<typeof terminalSurfaceBoundsSchema>;
export interface TerminalSessionInfo extends TerminalSessionRef {
  tabId: string;
  context: TerminalContext;
  state: "starting" | "running" | "stopping" | "exited";
  exitCode?: number;
  screen?: "lost";
}
export interface TerminalWorkspaceSnapshot extends TerminalCatalogSnapshot {
  sessions: TerminalSessionInfo[];
}
export interface TerminalConfirmation {
  token: string;
  kind: "tab" | "refresh" | "exit";
  requiresConfirmation: boolean;
  sessions: (TerminalSessionInfo & { jobCount: number })[];
}
export interface TerminalCompletion {
  status: "success" | "failed" | "partial";
  completed: TerminalSessionRef[];
  remaining: TerminalSessionRef[];
  message?: string;
  session?: TerminalSessionInfo;
}
export interface TerminalControlResponses {
  read: TerminalWorkspaceSnapshot;
  initialize: TerminalCatalogSnapshot;
  create: TerminalCatalogSnapshot;
  rename: TerminalCatalogSnapshot;
  select: TerminalCatalogSnapshot;
  move: TerminalCatalogSnapshot;
  reorder: TerminalCatalogSnapshot;
  open: TerminalSessionInfo;
  show: null;
  preview: null;
  activate: boolean;
  hide: null;
  "prepare-close": TerminalConfirmation;
  "prepare-refresh": TerminalConfirmation;
  confirm: TerminalCompletion;
  cancel: null;
}
export interface TerminalAPI {
  onChanged(
    callback: (change?: { selectionScope: ScopeRef }) => void,
  ): () => void;
  request<T extends TerminalControlRequest>(
    request: T,
  ): Promise<TerminalControlResponses[T["kind"]]>;
}

export const terminalControlEnvelopeSchema = z
  .object({
    documentId: z.string().uuid(),
    request: terminalControlRequestSchema,
  })
  .strict();

export const terminalChangedSchema = z
  .object({
    documentId: z.string().uuid(),
    selectionScope: scopeRefSchema.optional(),
  })
  .strict();
