import path from "node:path";
import { constants } from "node:fs";
import { access, open, realpath, readdir, stat } from "node:fs/promises";
import { parseDocument } from "yaml";
import { digest, optionalText, noSymlinks } from "./settings";
import {
  validateBuildOptions,
  type BuildPlanErrorCode,
  type BuildOptions,
  type BuildPlanDocument,
  type BuildFileList,
} from "../shared/build";
function planFailure(code: BuildPlanErrorCode): Error {
  return Error(`[build-plan:${code}]`);
}
function fileFailure(error: unknown): Error {
  if (error instanceof Error && /^\[build-plan:[a-z]+\]$/.test(error.message))
    return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return planFailure(
    code === "ENOENT" || code === "ENOTDIR"
      ? "missing"
      : code === "EACCES" || code === "EPERM"
        ? "denied"
        : "read",
  );
}
const LIMIT = 1024 * 1024;
/** Validate lexical input independently of canonical containment/existence. */
export async function buildPath(root: string, input: string) {
  if (
    typeof input !== "string" ||
    input.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(input) ||
    input.split(/[\\/]/).includes("..")
  )
    throw planFailure("invalid");
  const canonicalRoot = await realpath(root);
  const lexical = path.resolve(canonicalRoot, input || ".");
  const inside = (p: string) =>
    p === canonicalRoot || p.startsWith(canonicalRoot + path.sep);
  if (!inside(lexical)) throw planFailure("outside");
  let canonical: string;
  try {
    canonical = await realpath(lexical);
  } catch (error) {
    throw fileFailure(error);
  }
  if (!inside(canonical)) throw planFailure("outside");
  await noSymlinks(canonical);
  return {
    root: canonicalRoot,
    absolute: canonical,
    relative: path.relative(canonicalRoot, canonical).split(path.sep).join("/"),
  };
}
export async function readBuildPlan(
  root: string,
  input: string,
): Promise<BuildPlanDocument> {
  try {
    const p = await buildPath(root, input);
    const handle = await open(
      p.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if ((before.mode & 0o444) === 0) throw planFailure("denied");
      if (!before.isFile() || before.size > LIMIT) throw planFailure("format");
      await access(p.absolute, constants.R_OK);
      const bytes = Buffer.alloc(LIMIT + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > LIMIT) throw planFailure("format");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        );
      } catch {
        throw planFailure("format");
      }
      if (text.includes("\0")) throw planFailure("format");
      const after = await handle.stat();
      const actual = await buildPath(root, input);
      const onDisk = await stat(actual.absolute);
      if (
        actual.absolute !== p.absolute ||
        before.ino !== onDisk.ino ||
        before.dev !== onDisk.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      )
        throw planFailure("changed");
      return {
        path: p.relative,
        text,
        version: digest(JSON.stringify([p.absolute, text])),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw fileFailure(error);
  }
}
export async function listBuildFiles(
  root: string,
  input = "",
): Promise<BuildFileList> {
  const p = await buildPath(root, input);
  if (!(await stat(p.absolute)).isDirectory()) throw Error("Выберите папку");
  const names = await readdir(p.absolute, { withFileTypes: true });
  if (names.length > 5000) throw Error("В папке слишком много файлов");
  const entries: BuildFileList["entries"] = [];
  for (const e of names) {
    try {
      const entry = await buildPath(p.root, path.join(p.relative, e.name));
      const info = await stat(entry.absolute);
      if (info.isDirectory() || info.isFile())
        entries.push({
          name: e.name,
          path: entry.relative,
          directory: info.isDirectory(),
        });
    } catch {
      /* Inaccessible and escaping entries are not browseable. */
    }
  }
  const after = await buildPath(root, input);
  if (after.absolute !== p.absolute) throw Error("Папка изменилась");
  return {
    directory: p.relative,
    entries: entries.sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    ),
  };
}
export function buildCapabilities(help: string): string[] {
  return [
    ...new Set((help.match(/--[a-z][a-z-]*/g) ?? []).map((s) => s.slice(2))),
  ]
    .filter((s) => s !== "dry-run")
    .sort();
}
export function buildArgs(
  plan: string,
  options: BuildOptions,
  capabilities: string[],
): string[] {
  validateBuildOptions(options);
  const args = ["build", plan.startsWith("-") ? "./" + plan : plan];
  const add = (flag: string, value?: string) => {
    if (!capabilities.includes(flag))
      throw Error(
        `Выбранная версия Goga не поддерживает --${flag}. Параметр не был проигнорирован.`,
      );
    args.push("--" + flag);
    if (value !== undefined) args.push(value);
  };
  for (const [key, flag] of [
    ["workflow", "workflow"],
    ["profile", "profile"],
    ["sessionTimeout", "session-timeout"],
    ["idleTimeout", "idle-timeout"],
    ["wait", "wait"],
    ["maxIterations", "max-iterations"],
    ["reviewPatience", "review-patience"],
    ["baseRef", "base-ref"],
  ] as const) {
    const v = options[key];
    if (v !== undefined && v !== "") add(flag, String(v));
  }
  for (const e of options.env ?? []) add("env", `${e.key}=${e.value}`);
  for (const h of options.addHost ?? []) add("add-host", `${h.host}:${h.ip}`);
  if (options.proxy !== undefined) add("proxy", options.proxy);
  if (options.clean) add("clean");
  if (options.update) add("update");
  if (options.skipReview !== undefined)
    add(options.skipReview ? "skip-review" : "no-skip-review");
  if (options.skipManifestCheck) add("skip-manifest-check");
  return args;
}
function yaml(text: string): any {
  const doc = parseDocument(text);
  if (doc.errors.length) throw Error("Некорректная конфигурация сборки");
  return doc.toJS({ maxAliasCount: 100 }) ?? {};
}
/** The selected CLI owns config amendments. Workflow overlays never change review.skip.
 * CLI config prints Python bools or null, with a single option header.
 * Fail closed on unsupported CLI, diagnostics on stdout or unexpected types.
 */
export function buildReviewDefault(output: string): boolean {
  const match = output
    .trim()
    .match(/^# build\.review\.skip\r?\n(null|true|false)$/i);
  if (!match)
    throw Error(
      "Goga вернула некорректное значение настройки ревью. Проверьте версию и конфигурацию или выберите режим явно.",
    );
  return match[1].toLowerCase() === "true";
}

export async function buildHomeEnvironment(
  home: string,
): Promise<Record<string, string>> {
  const value =
    yaml((await optionalText(path.join(home, ".goga/config.yml"))) ?? "{}")
      .env ?? {};
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some((v) => typeof v !== "string")
  )
    throw Error("Некорректное домашнее окружение Goga");
  return value;
}

/** Known configuration values are private redaction inputs, never Run metadata. */
export async function buildConfigurationSecrets(
  root: string,
  home: string,
): Promise<string[]> {
  const secrets: string[] = [];
  for (const base of [root, home]) {
    const file = path.join(base, ".goga/config.yml");
    const exists = await stat(file).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw Error("Не удалось безопасно прочитать конфигурацию сборки");
      },
    );
    if (!exists) continue;
    let config: any;
    try {
      config = yaml((await readBuildPlan(base, ".goga/config.yml")).text);
    } catch {
      throw Error("Не удалось безопасно прочитать конфигурацию сборки");
    }
    const envs =
      base === home
        ? [config.env]
        : [
            config.build?.env,
            config.build?.review?.env,
            config.build?.review?.additional?.env,
          ];
    for (const env of envs) {
      if (env && typeof env === "object" && !Array.isArray(env))
        for (const value of Object.values(env))
          if (typeof value === "string" && value) secrets.push(value);
    }
    if (base === root && typeof config.build?.proxy === "string")
      secrets.push(config.build.proxy);
  }
  for (const value of [...secrets]) {
    try {
      const url = new URL(value);
      for (const credential of [url.username, url.password])
        if (credential) {
          secrets.push(credential);
          try {
            secrets.push(decodeURIComponent(credential));
          } catch {
            /* Retain encoded credential. */
          }
        }
    } catch {
      /* Most environment values are not URLs. */
    }
  }
  return [...new Set(secrets)].filter(Boolean);
}
