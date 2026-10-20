import {
  readPersonalProfile,
  savePersonalProfile,
  prepareSourceDeletion,
  type GuardedDocumentDeletion,
} from "./project-documents";
import type { DeletionResult, TrashItem } from "../shared/document-deletion";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  open,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { validateYaml } from "./yaml-validation";
export { validateYaml } from "./yaml-validation";
import type {
  SettingsKind,
  SettingsDocument,
  SettingsMetadata,
} from "../shared/types";
import { profileName } from "./parsers";
export const digest = (v: string) =>
  createHash("sha256").update(v).digest("hex");
export async function noSymlinks(target: string) {
  const resolved = path.resolve(target);
  let cursor = path.parse(resolved).root;
  for (const part of resolved.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error("Символические ссылки не разрешены");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
export async function atomicWrite(target: string, text: string) {
  await noSymlinks(target);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await noSymlinks(target);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    const f = await open(tmp, "wx", 0o600);
    try {
      await f.writeFile(text, "utf8");
      await f.sync();
    } finally {
      await f.close();
    }
    await noSymlinks(target);
    await rename(tmp, target);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
export async function optionalText(p: string) {
  try {
    return await readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
export class SettingsStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private home: string) {}
  private file(kind: SettingsKind, name?: string) {
    if (kind !== "config" && kind !== "profile")
      throw new Error("Неизвестный вид настроек");
    if (kind === "profile") {
      profileName(name);
      return path.join(this.home, ".goga", "profiles", `${name}.yml`);
    }
    return path.join(this.home, ".goga/config.yml");
  }
  async listSettings(): Promise<SettingsMetadata> {
    const root = path.join(this.home, ".goga");
    await noSymlinks(root);
    await noSymlinks(path.join(root, "profiles"));
    let names: string[] = [];
    try {
      names = (await readdir(path.join(root, "profiles")))
        .filter((x) => x.endsWith(".yml"))
        .map((x) => x.slice(0, -4))
        .sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await noSymlinks(path.join(root, "config.yml"));
    return {
      configExists: await lstat(path.join(root, "config.yml")).then(
        (s) => s.isFile(),
        (e) => {
          if (e.code === "ENOENT") return false;
          throw e;
        },
      ),
      profiles: names,
    };
  }
  async readSettings(
    kind: SettingsKind,
    name?: string,
  ): Promise<SettingsDocument> {
    const p = this.file(kind, name);
    if (kind === "profile") {
      const doc = await readPersonalProfile(this.home, name!);
      return { text: doc.exists ? doc.text : "{}\n", version: doc.version };
    }
    await noSymlinks(p);
    const text = await optionalText(p);
    return {
      text: text ?? "{}\n",
      version: text === undefined ? "missing" : digest(text),
    };
  }
  async saveSettings(
    kind: SettingsKind,
    name: string | undefined,
    text: string,
    version: string,
  ): Promise<SettingsDocument> {
    const action = async () => {
      const p = this.file(kind, name);
      validateYaml(text, kind);
      const prev = await this.readSettings(kind, name);
      if (prev.version !== version)
        throw new Error("Файл изменён извне. Откройте его заново.");
      if (kind === "profile")
        await savePersonalProfile(this.home, name!, text, version);
      else await atomicWrite(p, text);
      return this.readSettings(kind, name);
    };
    return this.serialized(action);
  }
  async prepareProfileDeletion(
    name: string,
    version?: string,
  ): Promise<GuardedDocumentDeletion> {
    this.file("profile", name);
    const guarded = await this.serialized(() =>
      prepareSourceDeletion(this.home, { kind: "profile", name }, version),
    );
    return {
      ...guarded,
      perform: (trash: TrashItem): Promise<DeletionResult> =>
        this.serialized(() => guarded.perform(trash)),
    };
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action);
    this.tail = next.catch(() => {});
    return next;
  }
}
