import { z } from "zod";
import type { ProjectDocument } from "./project-documents";
export const isOverviewPath = (v: unknown, root = false): v is string =>
  typeof v === "string" &&
  v.length <= 4096 &&
  ((root && v === "") ||
    (!!v &&
      !/[\\\x00-\x1f\x7f-\x9f]/.test(v) &&
      !v.startsWith("/") &&
      !/^[A-Za-z]:/.test(v) &&
      v
        .split("/")
        .every(
          (p) => !!p && p !== "." && p !== ".." && p.toLowerCase() !== ".git",
        )));
export const overviewPathSchema = z.string().refine((v) => isOverviewPath(v));
export const overviewDirectorySchema = z
  .string()
  .refine((v) => isOverviewPath(v, true));
export const overviewTextSchema = z.string().max(1024 * 1024);
export const overviewVersionSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{64}|missing)$/);
export const overviewKindSchema = z.enum(["file", "directory"]);
export interface OverviewEntry {
  path: string;
  name: string;
  kind: "file" | "directory" | "unsupported";
  reason?: string;
}
export interface OverviewDirectory {
  path: string;
  entries: OverviewEntry[];
  truncated: boolean;
}
export type OverviewFile = ProjectDocument;

export const overviewFileActionRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("trash"),
      paths: z.array(overviewPathSchema).min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rename"),
      path: overviewPathSchema,
      destination: overviewPathSchema,
    })
    .strict(),
]);
export const overviewFileActionTokenSchema = z.string().uuid();
export type OverviewFileActionRequest = z.infer<
  typeof overviewFileActionRequestSchema
>;
export interface OverviewFileActionPreview {
  token: string;
  kind: "trash" | "rename";
  paths: string[];
  destination?: string;
}
export interface OverviewFileActionResult {
  status: "done" | "partial" | "not-done" | "uncertain";
  completedPaths: string[];
  message: string;
}
