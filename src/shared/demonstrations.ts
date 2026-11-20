import { z } from "zod";
import { scopeRefSchema, type ScopeRef } from "./context";
export const DEMO_DEFAULT_PORT = 45123;
export const demoEngineSchema = z.enum(["embedded", "system"]);
export type DemoEngine = z.infer<typeof demoEngineSchema>;
export const DEMO_DEFAULT_ENGINE = "embedded" as const;
export const DEMO_EMBEDDED_START_ERROR =
  "[GOGA_DEMO_EMBEDDED_START] ";
export const demoPortSchema = z.number().int().min(1024).max(65535);
export const demoIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const demoPageRequestSchema = z
  .object({ showId: demoIdSchema, tabId: demoIdSchema })
  .strict();
export interface DemoStreamFrame {
  cursor: string;
  pixels: Uint8Array;
}
export const demoFrameRequestSchema = z
  .object({
    showId: demoIdSchema,
    tabId: demoIdSchema,
    after: demoIdSchema.nullable(),
  })
  .strict();
export function demoScopeKey(scope: ScopeRef): string {
  return JSON.stringify(
    typeof scope === "string"
      ? ["primary", scope]
      : [
          "topic",
          scope.projectId,
          scope.year,
          scope.topic,
          scope.branch,
          scope.contextId,
          scope.revision,
        ],
  );
}
const pos = z.number().min(0).max(1);
export const demoInputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("pointer"),
      phase: z.enum(["down", "move", "up", "cancel"]),
      gestureId: demoIdSchema,
      x: pos,
      y: pos,
      clickCount: z.number().int().min(1).max(3).optional(),
    })
    .strict(),
  z.object({ action: z.literal("click"), x: pos, y: pos }).strict(),
  z
    .object({
      action: z.literal("scroll"),
      x: pos,
      y: pos,
      deltaY: z.number().min(-2000).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("text"),
      text: z
        .string()
        .min(1)
        .max(2048)
        .regex(/^[^\x00-\x1f\x7f-\x9f]+$/u),
    })
    .strict(),
  z
    .object({
      action: z.literal("key"),
      key: z.enum([
        "Enter",
        "Backspace",
        "Tab",
        "Delete",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ]),
    })
    .strict(),
]);
const show = { showId: demoIdSchema };
export const demoCommandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("open"),
      scope: scopeRefSchema,
      engine: z.literal("system").optional(),
    })
    .strict(),
  z.object({ action: z.literal("engine"), engine: demoEngineSchema }).strict(),
  z.object({ action: z.literal("port"), port: demoPortSchema }).strict(),
  z
    .object({
      action: z.literal("navigate"),
      ...show,
      url: z.string().min(1).max(8192),
    })
    .strict(),
  z.object({ action: z.literal("reload"), ...show }).strict(),
  z.object({ action: z.literal("stop"), ...show }).strict(),
  z.object({ action: z.literal("tab-create"), ...show }).strict(),
  z
    .object({ action: z.literal("tab-select"), ...show, tabId: demoIdSchema })
    .strict(),
  z
    .object({ action: z.literal("tab-close"), ...show, tabId: demoIdSchema })
    .strict(),
  z
    .object({
      action: z.literal("input"),
      ...show,
      tabId: demoIdSchema.optional(),
      input: demoInputSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("handoff"),
      ...show,
      connectionId: demoIdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("switch-port"),
      ...show,
      fromShowId: demoIdSchema.nullable(),
    })
    .strict(),
]);
export type DemoCommand = z.infer<typeof demoCommandSchema>;
export type DemoInput = z.infer<typeof demoInputSchema>;
export interface DemoTab {
  tabId: string;
  title: string;
  url: string | null;
}
export interface DemoShow {
  engine: DemoEngine;
  showId: string;
  scope: ScopeRef;
  label: string;
  url: string | null;
  // Older shell/test snapshots may lack a catalog. A live host always supplies
  // one; missing data never enables commands against a guessed page.
  tabs?: DemoTab[];
  activeTabId?: string | null;
}
export interface DemoAccess {
  owner: string | null;
  phase: "off" | "waiting" | "connecting" | "connected";
  connectionId: string | null;
}
export interface DemoState {
  engine: DemoEngine;
  port: number;
  settingsError?: string;
  shows: DemoShow[];
  access: DemoAccess;
}
