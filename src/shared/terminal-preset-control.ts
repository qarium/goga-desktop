import { z } from "zod";
import {
  terminalPresetDraftSchema,
  type TerminalPresetDocument,
  type TerminalPresetSummary,
  type TerminalPresetMenuItem,
} from "./terminal-presets";

const uuid = z.string().uuid();
const request = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("menu") }).strict(),
    z.object({ kind: z.literal("list") }).strict(),
    z.object({ kind: z.literal("read"), id: uuid }).strict(),
    z
      .object({
        kind: z.literal("save"),
        id: uuid.optional(),
        revision: uuid.optional(),
        draft: terminalPresetDraftSchema,
      })
      .strict(),
    z.object({ kind: z.literal("remove"), id: uuid, revision: uuid }).strict(),
  ])
  .refine((v) => v.kind !== "save" || Boolean(v.id) === Boolean(v.revision));
export const terminalPresetEnvelopeSchema = z
  .object({ documentId: uuid, request })
  .strict();
export type TerminalPresetRequest = z.infer<typeof request>;
interface Responses {
  menu: TerminalPresetMenuItem[];
  list: TerminalPresetSummary[];
  read: TerminalPresetDocument;
  save: TerminalPresetDocument;
  remove: null;
}
export type TerminalPresetAPI = <R extends TerminalPresetRequest>(
  request: R,
) => Promise<Responses[R["kind"]]>;
