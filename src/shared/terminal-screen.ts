import { z } from "zod";
import { terminalSessionRefSchema } from "./terminal";

export const TERMINAL_FRAME_BYTES = 16384;
export const TERMINAL_SOURCE_BYTES = 65536;
export const terminalGrantSchema = terminalSessionRefSchema
  .extend({ capability: z.string().uuid() })
  .strict();
export type TerminalGrant = z.infer<typeof terminalGrantSchema>;
export const terminalAckSchema = terminalGrantSchema
  .extend({ sequence: z.number().int().positive().safe() })
  .strict();
export type TerminalAck = z.infer<typeof terminalAckSchema>;
export const terminalFrameSchema = terminalAckSchema
  .extend({
    text: z
      .string()
      .min(1)
      .max(TERMINAL_FRAME_BYTES)
      .refine(
        (s) => new TextEncoder().encode(s).byteLength <= TERMINAL_FRAME_BYTES,
      ),
  })
  .strict();
export type TerminalFrame = z.infer<typeof terminalFrameSchema>;
export const terminalScreenInputSchema = terminalGrantSchema
  .extend({
    text: z
      .string()
      .min(1)
      .max(TERMINAL_SOURCE_BYTES)
      .refine(
        (s) => new TextEncoder().encode(s).byteLength <= TERMINAL_SOURCE_BYTES,
      ),
  })
  .strict();
export const terminalScreenResizeSchema = terminalGrantSchema
  .extend({
    cols: z.number().int().min(2).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();
export function sameTerminalGrant(a: TerminalGrant, b: TerminalGrant): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.generation === b.generation &&
    a.capability === b.capability
  );
}
export const terminalScreenCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant"), grant: terminalGrantSchema }).strict(),
  z
    .object({
      kind: z.literal("select"),
      focus: z.boolean().optional(),
      interactive: z.boolean().optional(),
      grant: terminalGrantSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("exited"), grant: terminalGrantSchema }).strict(),
  z.object({ kind: z.literal("lost"), grant: terminalGrantSchema }).strict(),
  z.object({ kind: z.literal("remove"), grant: terminalGrantSchema }).strict(),
]);
export type TerminalScreenCommand = z.infer<typeof terminalScreenCommandSchema>;
export const terminalScreenLinkSchema = terminalGrantSchema
  .extend({
    url: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => {
        if (
          /[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
            value,
          )
        )
          return false;
        try {
          const url = new URL(value);
          return (
            (url.protocol === "https:" || url.protocol === "http:") &&
            !!url.hostname &&
            !url.username &&
            !url.password
          );
        } catch {
          return false;
        }
      }),
  })
  .strict();
export interface TerminalScreenBridge {
  ready(): void;
  link(value: TerminalGrant & { url: string }): void;
  input(value: TerminalGrant & { text: string }): void;
  resize(value: TerminalGrant & { cols: number; rows: number }): void;
  ack(value: TerminalAck): void;
  fault(value: TerminalGrant): void;
  onFrame(listener: (value: unknown) => void): () => void;
  onCommand(listener: (value: unknown) => void): () => void;
}
