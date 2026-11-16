import { z } from "zod";
import type { Project } from "./types";

const controls = /[\x00-\x1f\x7f]/;
export const projectCreationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const projectFolderName = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value === value.trim() &&
      !controls.test(value) &&
      !/[\\/:]/.test(value) &&
      !value.startsWith("-") &&
      value !== "." &&
      value !== "..",
    "Укажите имя новой папки без разделителей пути.",
  );

export function validRepositoryAddress(value: string): boolean {
  if (!value || value.length > 4096 || /\s|[\x00-\x1f\x7f?#\\]/.test(value))
    return false;
  if (/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+:[^/:][^:]*$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "ssh:") &&
      !!url.hostname &&
      url.pathname.length > 1 &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol !== "https:" || !url.username) &&
      (!url.username || /^[a-zA-Z0-9._-]+$/.test(url.username))
    );
  } catch {
    return false;
  }
}
export const repositoryAddressSchema = z
  .string()
  .refine(
    validRepositoryAddress,
    "Укажите HTTPS- или SSH-адрес без пароля, токена и параметров.",
  );
const common = {
  id: projectCreationIdSchema,
  parent: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) => value.startsWith("/") && !controls.test(value),
      "Выберите родительскую папку.",
    ),
  name: projectFolderName,
};
export const projectCreationRequestSchema = z.discriminatedUnion("mode", [
  z.object({ ...common, mode: z.literal("empty"), git: z.boolean() }).strict(),
  z
    .object({
      ...common,
      mode: z.literal("clone"),
      repository: repositoryAddressSchema,
    })
    .strict(),
]);
export type ProjectCreationRequest = z.infer<
  typeof projectCreationRequestSchema
>;
export type ProjectCreationStage =
  "checking" | "creating" | "git" | "cloning" | "registering" | "cancelling";
export interface ProjectCreationProgress {
  id: string;
  stage: ProjectCreationStage;
  canCancel: boolean;
}
export type ProjectCreationResult =
  | { status: "success"; project: Project; warning?: string }
  | { status: "cancelled"; retainedPath?: string }
  | {
      status: "error";
      message: string;
      retainedPath?: string;
      field?: "name" | "parent" | "repository";
    };

export function repositoryFolderName(value: string): string {
  const name =
    value
      .trim()
      .split(/[?#]/)[0]
      .replace(/\/+$/, "")
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, "") ?? "";
  return projectFolderName.safeParse(name).success ? name : "";
}
