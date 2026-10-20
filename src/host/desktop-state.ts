import { isStartupTimeoutMinutes } from "../shared/startup-timeout";
import { assertEnvironmentTransport } from "../shared/environment-transport";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink, link } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Project } from "../shared/types";
import { profileName } from "./parsers";
import { noSymlinks } from "./settings";

export interface ProjectEnvironmentEntry {
  key: string;
  value: string;
  secret: boolean;
  runtime: boolean;
}
export interface ProjectSettings {
  executable: string;
  profile: string;
  startupTimeoutMinutes?: number;
  env: ProjectEnvironmentEntry[];
}
export interface ProjectSettingsDocument {
  value: ProjectSettings;
  version: string;
}

const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULTS: ProjectSettings = { executable: "goga", profile: "", env: [] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
class StateError extends Error {}
const invalid = () => new StateError("Недопустимые настройки проекта.");
const corrupt = () =>
  new StateError("Состояние Desktop повреждено или несовместимо.");
const conflict = () =>
  new StateError("Настройки изменены извне. Откройте их заново.");
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";

/** Return only validated primitives; never include caller-supplied data in errors. */
export function validateProjectSettings(value: unknown): ProjectSettings {
  if (!object(value)) throw invalid();
  const { executable, profile, env, startupTimeoutMinutes } = value;
  if (
    typeof executable !== "string" ||
    !executable ||
    Buffer.byteLength(executable) > 4096 ||
    /[\x00-\x1f\x7f]/.test(executable) ||
    (!path.isAbsolute(executable) &&
      !/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/.test(executable)) ||
    typeof profile !== "string" ||
    !Array.isArray(env) ||
    env.length > 256
  )
    throw invalid();
  if (profile) {
    try {
      profileName(profile);
    } catch {
      throw invalid();
    }
  }
  const keys = new Set<string>();
  const result: ProjectSettings = { executable, profile, env: [] };
  // Legacy documents keep their original shape; consumers apply the default.
  if (startupTimeoutMinutes !== undefined) {
    if (!isStartupTimeoutMinutes(startupTimeoutMinutes)) throw invalid();
    result.startupTimeoutMinutes = startupTimeoutMinutes;
  }
  for (const row of env) {
    if (!object(row)) throw invalid();
    const { key, value: entry, secret = false, runtime = false } = row;
    if (
      typeof key !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
      keys.has(key) ||
      /^(?:HOME|NODE_OPTIONS|PYTHONPATH|PYTHONHOME|NO_COLOR)$/.test(key) ||
      /^(?:GOGA_|AFM_|ELECTRON_|GIT_)/.test(key) ||
      typeof entry !== "string" ||
      /[\0\r\n]/.test(entry) ||
      Buffer.byteLength(entry) > 65536 ||
      typeof secret !== "boolean" ||
      typeof runtime !== "boolean"
    )
      throw invalid();
    keys.add(key);
    result.env.push({ key, value: entry, secret, runtime });
  }
  assertEnvironmentTransport(result.env);
  if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024) throw invalid();
  return result;
}

function validateProjects(value: unknown): Project[] {
  if (!Array.isArray(value) || value.length > 10000) throw corrupt();
  const ids = new Set<string>(),
    paths = new Set<string>();
  return value.map((row) => {
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 256 ||
      /[\x00-\x1f\x7f]/.test(row.id) ||
      typeof row.name !== "string" ||
      !row.name ||
      row.name.length > 1024 ||
      typeof row.path !== "string" ||
      !path.isAbsolute(row.path) ||
      /[\x00-\x1f\x7f]/.test(row.path) ||
      row.path.length > 4096 ||
      ids.has(row.id) ||
      paths.has(path.resolve(row.path))
    )
      throw corrupt();
    ids.add(row.id);
    paths.add(path.resolve(row.path));
    return { id: row.id, name: row.name, path: path.resolve(row.path) };
  });
}
function parse(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    typeof value.revision !== "string" ||
    !/^[a-f0-9-]{36}$/.test(value.revision)
  )
    throw corrupt();
  return value;
}

/**
 * Private Desktop-only state. All cooperating instances use one exclusive lock.
 * A crashed writer leaves a lock: fail closed rather than guessing that it is stale.
 * The filesystem owner can still replace ancestors concurrently; Node has no
 * portable dirfd/openat API to eliminate that adversarial same-user race entirely.
 */
export class DesktopStateStore {
  private root: string;
  constructor(
    private home: string,
    private legacyDataDir: string,
  ) {
    if (!path.isAbsolute(home) || !path.isAbsolute(legacyDataDir))
      throw corrupt();
    this.root = path.join(home, ".goga", "desktop");
  }

  private async directory(dir: string, privateDirectory = true) {
    await noSymlinks(dir);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    await noSymlinks(dir);
    const file = await open(
      dir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (
        !info.isDirectory() ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw corrupt();
      if (privateDirectory) await file.chmod(0o700);
    } finally {
      await file.close();
    }
  }

  private async readText(
    file: string,
    privateState = true,
  ): Promise<string | undefined> {
    await noSymlinks(file);
    let handle;
    try {
      handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if (absent(e)) return undefined;
      throw e;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > MAX_FILE_BYTES ||
        (privateState &&
          (info.nlink !== 1 ||
            (info.mode & 0o077) !== 0 ||
            (process.getuid && info.uid !== process.getuid())))
      )
        throw corrupt();
      const text = await handle.readFile("utf8");
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw corrupt();
      return text;
    } finally {
      await handle.close();
    }
  }

  private async locked<T>(
    action: () => Promise<T>,
    saving = false,
  ): Promise<T> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const lock = path.join(this.root, ".write.lock");
    try {
      await this.directory(path.join(this.home, ".goga"), false);
      await this.directory(this.root);
      for (let attempt = 0; attempt < 100; attempt++) {
        await noSymlinks(lock);
        try {
          handle = await open(
            lock,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW,
            0o600,
          );
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          if (attempt === 99)
            throw new StateError(
              "Хранилище Desktop занято другим экземпляром. Повторите позже.",
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      return await action();
    } catch (e) {
      if (e instanceof StateError) throw e;
      throw new StateError(
        saving
          ? "Не удалось сохранить настройки Desktop."
          : "Не удалось прочитать состояние Desktop.",
      );
    } finally {
      if (handle) {
        // Never remove a lock that was replaced while our handle was open.
        const owned = await handle.stat().catch(() => undefined);
        const current = await lstat(lock).catch(() => undefined);
        if (
          owned &&
          current &&
          owned.ino === current.ino &&
          owned.dev === current.dev
        )
          await unlink(lock).catch(() => {});
        await handle.close().catch(() => {});
      }
    }
  }

  private async write(
    file: string,
    value: unknown,
    expected: string | undefined,
  ) {
    const text = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw corrupt();
    await noSymlinks(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const output = await open(
        temp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await output.writeFile(text, "utf8");
        await output.sync();
      } finally {
        await output.close();
      }
      // Detect edits by external tools, even when they preserve the JSON revision.
      if ((await this.readText(file)) !== expected) throw conflict();
      await noSymlinks(file);
      if (expected === undefined) {
        // link is an atomic no-replace install; unlike rename it cannot clobber
        // an unexpected file created since the preceding missing-file check.
        try {
          await link(temp, file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "EEXIST") throw conflict();
          throw e;
        }
      } else await rename(temp, file);
      return text;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }

  private async registry(): Promise<{ projects: Project[]; raw: string }> {
    const file = path.join(this.root, "projects.json");
    const raw = await this.readText(file);
    if (raw !== undefined)
      return { projects: validateProjects(parse(raw).projects), raw };
    const legacy = await this.readText(
      path.join(this.legacyDataDir, "projects.json"),
      false,
    );
    let rows: unknown = [];
    if (legacy !== undefined) {
      try {
        rows = JSON.parse(legacy);
      } catch {
        throw corrupt();
      }
    }
    const projects = validateProjects(rows);
    return {
      projects,
      raw: await this.write(
        file,
        { schemaVersion: 1, revision: randomUUID(), projects },
        undefined,
      ),
    };
  }

  async listProjects(): Promise<Project[]> {
    return this.locked(async () => (await this.registry()).projects);
  }

  async addProject(project: Project): Promise<Project> {
    const candidate = validateProjects([project])[0];
    return this.locked(async () => {
      const { projects, raw } = await this.registry();
      const byId = projects.find((row) => row.id === candidate.id);
      if (byId && byId.path !== candidate.path) throw conflict();
      const existing = projects.find((row) => row.path === candidate.path);
      if (existing) return existing;
      projects.push(candidate);
      await this.write(
        path.join(this.root, "projects.json"),
        { schemaVersion: 1, revision: randomUUID(), projects },
        raw,
      );
      return candidate;
    }, true);
  }

  private async settings(projectId: string) {
    if (
      typeof projectId !== "string" ||
      !(await this.registry()).projects.some((p) => p.id === projectId)
    )
      throw new StateError("Неизвестный проект.");
    const directory = path.join(this.root, "settings");
    await this.directory(directory);
    const file = path.join(directory, `${hash(projectId)}.json`);
    let raw = await this.readText(file);
    if (raw === undefined)
      raw = await this.write(
        file,
        {
          schemaVersion: 1,
          revision: randomUUID(),
          projectId,
          value: DEFAULTS,
        },
        undefined,
      );
    const disk = parse(raw);
    if (disk.projectId !== projectId) throw corrupt();
    const value = validateProjectSettings(disk.value);
    return { file, raw, document: { value, version: hash(raw) } };
  }

  async read(projectId: string): Promise<ProjectSettingsDocument> {
    return this.locked(async () => (await this.settings(projectId)).document);
  }

  async save(
    projectId: string,
    value: unknown,
    expectedVersion: string,
  ): Promise<ProjectSettingsDocument> {
    // Validate/copy before awaiting the lock, so callers cannot mutate a queued save.
    const validated = validateProjectSettings(value);
    return this.locked(async () => {
      const current = await this.settings(projectId);
      if (
        typeof expectedVersion !== "string" ||
        current.document.version !== expectedVersion
      )
        throw conflict();
      const raw = await this.write(
        current.file,
        {
          schemaVersion: 1,
          revision: randomUUID(),
          projectId,
          value: validated,
        },
        current.raw,
      );
      return { value: validated, version: hash(raw) };
    }, true);
  }
}
