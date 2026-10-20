import { topicContextRefSchema, type TopicContextRef } from "./worktrees";
export interface BuildOptions {
  workflow?: string;
  /** Undefined inherits the project selection; empty string selects automatic. */
  profile?: string;
  sessionTimeout?: string;
  idleTimeout?: string;
  wait?: string;
  maxIterations?: number;
  reviewPatience?: number;
  baseRef?: string;
  env?: { key: string; value: string }[];
  addHost?: { host: string; ip: string }[];
  proxy?: string;
  clean?: boolean;
  update?: boolean;
  skipReview?: boolean;
  skipManifestCheck?: boolean;
}
export type BuildContextSelection = Pick<
  BuildOptions,
  "workflow" | "profile" | "env"
>;
export interface BuildContext {
  revision: string;
  branch: string;
  capabilities: string[];
  defaults: { skipReview: boolean; profile: string; reviewError?: string };
  branches: string[];
  workflows: string[];
  profiles: { name: string; source: "home" | "project" }[];
  historyPlan: { path: string; error?: string };
}
export interface BuildPlanDocument {
  path: string;
  text: string;
  version: string;
}
export interface BuildFileEntry {
  name: string;
  path: string;
  directory: boolean;
}
export interface BuildFileList {
  directory: string;
  entries: BuildFileEntry[];
}
export interface BuildRequest {
  repeat?: { sourceRunId: string; acknowledged: true };
  context?: TopicContextRef;
  projectId: string;
  expectedBranch: string;
  contextRevision: string;
  planPath: string;
  planVersion: string;
  options: BuildOptions;
  confirmClean: boolean;
}
/** No raw argv, environment values, or proxy credentials cross the boundary. */
export interface BuildSummary {
  planPath: string;
  planVersion: string;
  clean: boolean;
  update: boolean;
  skipReview?: boolean;
  skipManifestCheck: boolean;
}

import { z } from "zod";
import { assertEnvironmentTransport } from "./environment-transport";
const name = z
  .string()
  .max(180)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const duration = z
  .string()
  .max(100)
  .regex(/^(?:0|(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+)$/);
const plain = z
  .string()
  .max(4096)
  .refine((v) => !/[\x00-\x1f\x7f]/.test(v));
function address(v: string): boolean {
  if (v === "host-gateway") return true;
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(v))
    return v.split(".").every((n) => Number(n) <= 255);
  try {
    return v.includes(":") && new URL(`http://[${v}]/`).hostname !== "";
  } catch {
    return false;
  }
}
export const buildOptionsSchema = z
  .object({
    workflow: name.or(z.literal("")).optional(),
    profile: name.or(z.literal("")).optional(),
    sessionTimeout: duration.optional(),
    idleTimeout: duration.optional(),
    wait: duration.optional(),
    maxIterations: z.number().int().min(1).max(2147483647).optional(),
    reviewPatience: z.number().int().min(0).max(2147483647).optional(),
    baseRef: plain
      .min(1)
      .refine((v) => !v.startsWith("-") && !/\s/.test(v))
      .optional(),
    env: z
      .array(
        z
          .object({
            key: z
              .string()
              .max(128)
              .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            value: z.string().max(65536),
          })
          .strict(),
      )
      .max(256)
      .optional(),
    addHost: z
      .array(
        z
          .object({
            host: z
              .string()
              .max(253)
              .regex(
                /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/,
              ),
            ip: z.string().max(100).refine(address),
          })
          .strict(),
      )
      .max(256)
      .optional(),
    proxy: plain
      .min(1)
      .refine((v) => {
        try {
          return ["http:", "https:"].includes(new URL(v).protocol);
        } catch {
          return false;
        }
      })
      .optional(),
    clean: z.boolean().optional(),
    update: z.boolean().optional(),
    skipReview: z.boolean().optional(),
    skipManifestCheck: z.boolean().optional(),
  })
  .strict();
export const buildSelectionSchema = buildOptionsSchema.pick({
  workflow: true,
  profile: true,
  env: true,
});
export const buildRequestSchema = z
  .object({
    repeat: z
      .object({
        sourceRunId: z.string().min(1).max(256),
        acknowledged: z.literal(true),
      })
      .strict()
      .optional(),
    context: topicContextRefSchema.optional(),
    projectId: z.string().min(1).max(256),
    expectedBranch: plain.min(1).max(256),
    contextRevision: z.string().regex(/^[a-f0-9]{64}$/),
    planPath: plain.min(1),
    planVersion: z.string().regex(/^[a-f0-9]{64}$/),
    options: buildOptionsSchema,
    confirmClean: z.boolean(),
  })
  .strict();
export function validateBuildOptions(options: BuildOptions): void {
  if (!buildOptionsSchema.safeParse(options).success)
    throw new Error(
      "Некорректные параметры сборки. Проверьте время, числа, окружение, адреса и имена.",
    );
  assertEnvironmentTransport(
    (options.env ?? []).map((e) => ({ ...e, runtime: true })),
  );
}

/** Stable, non-secret errors survive Electron's remote-error wrapping. */
export const buildPlanMessages = {
  missing: "Файл плана не найден. Выберите другой файл.",
  denied:
    "Нет доступа к файлу плана. Проверьте права или выберите другой файл.",
  outside: "План находится за пределами проекта. Выберите файл внутри проекта.",
  invalid: "Недопустимый путь плана. Выберите файл внутри проекта.",
  format: "План должен быть обычным текстовым UTF-8 файлом размером до 1 МиБ.",
  changed: "План изменился во время чтения. Откройте его заново.",
  read: "Не удалось прочитать план. Проверьте файл или выберите другой.",
  history:
    "Не удалось получить путь плана из Goga. Проверьте исполняемый файл и конфигурацию или выберите файл вручную.",
} as const;
export type BuildPlanErrorCode = keyof typeof buildPlanMessages;
export function buildPlanProblem(error: unknown, history = false) {
  const raw = error instanceof Error ? error.message : "";
  const match = raw.match(/(?:^|Error: )\[build-plan:([a-z]+)\]$/);
  const code: BuildPlanErrorCode =
    match && Object.hasOwn(buildPlanMessages, match[1])
      ? (match[1] as BuildPlanErrorCode)
      : "read";
  return {
    code,
    message:
      code === "missing" && history
        ? "План для текущего топика ещё не создан. Выберите другой файл."
        : buildPlanMessages[code],
  };
}
