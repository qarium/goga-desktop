import path from "node:path";
import { validateYaml } from "./yaml-validation";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  realpath,
  open,
  opendir,
  rename,
  unlink,
  link,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isMap, parseAllDocuments } from "yaml";
import {
  isProjectDockerfilePath,
  isProjectWorkflowName,
  projectWorkflowAliasKey,
  isProjectToolName,
  isProjectToolPath,
} from "../shared/project-documents";
import type {
  ProjectDocument,
  ProjectDocumentTarget,
  ProjectTool,
  ProjectToolEntry,
  ProjectWorkflow,
  ProjectPipeline,
  ProjectProfile,
} from "../shared/project-documents";

import type { DeletionResult, TrashItem } from "../shared/document-deletion";
import { isPersonalProfileName } from "../shared/document-deletion";
type SourceDocumentTarget = ProjectDocumentTarget;

const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_ENTRIES = 2048;
const yamlName = /\.ya?ml$/;
const absent = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";
const changed = () =>
  new Error("Файл или его каталог изменён извне. Откройте документ заново.");
class NotEditable extends Error {}
interface DirectoryIdentity {
  path: string;
  info: Stats;
}
interface ReadResult {
  document: ProjectDocument;
  info?: Stats;
  directories: DirectoryIdentity[];
}
// Shared across HostService instances; key by directory dev/inode, not caller spelling.
// Flat source documents use the registered root, even before their parent directories exist.
// Case/Unicode aliases share the queue even across atomic leaf replacement. This
// deliberately serializes different documents in the same directory too; different
// directories remain independent. Leaf inode is not stable enough for a mutex key.
const saves = new Map<string, Promise<unknown>>();

type FlatDocumentKind = "workflow" | "pipeline" | "profile";
type FlatDocumentTarget = Extract<
  SourceDocumentTarget,
  { kind: FlatDocumentKind }
>;
function isFlatDocument(
  target: SourceDocumentTarget,
): target is FlatDocumentTarget {
  return (
    target.kind === "workflow" ||
    target.kind === "pipeline" ||
    target.kind === "profile"
  );
}
const flatDirectory = (kind: FlatDocumentKind) => `.goga/${kind}s`;

function relativePath(target: SourceDocumentTarget): string {
  if (!target || typeof target !== "object")
    throw new Error("Недопустимый документ проекта");
  if (target.kind === "dockerfile") {
    if (!isProjectDockerfilePath(target.path))
      throw new Error("Недопустимый путь Dockerfile");
    return target.path;
  }
  if (target.kind === "config") return ".goga/config.yml";
  if (isFlatDocument(target)) {
    if (
      !(target.kind === "profile"
        ? isPersonalProfileName(target.name)
        : isProjectWorkflowName(target.name))
    )
      throw new Error(
        `Недопустимое имя ${target.kind === "profile" ? "профиля" : target.kind === "pipeline" ? "конвейера" : "рабочего процесса"}`,
      );
    return `${flatDirectory(target.kind)}/${target.name}.yml`;
  }
  if (
    target.kind !== "tool" ||
    !isProjectToolName(target.tool) ||
    !isProjectToolPath(target.path)
  )
    throw new Error("Недопустимый путь документа инструмента");
  if (!yamlName.test(target.path))
    throw new NotEditable("Редактируются только .yaml и .yml файлы");
  return `.goga/tools/${target.tool}/${target.path}`;
}
const sameIdentity = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: Stats, b: Stats) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs &&
  a.mode === b.mode &&
  a.nlink === b.nlink;

/** Never create directories. Snapshot every ancestor, including those above the registered root. */
async function directories(
  root: string,
  relative: string,
  allowMissing = false,
): Promise<{ identities: DirectoryIdentity[]; missing: boolean }> {
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw new Error("Путь проекта изменился. Добавьте проект заново.");
  const result: DirectoryIdentity[] = [];
  const destination = path.join(root, relative);
  let cursor = path.parse(destination).root;
  for (const part of destination.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    let info: Stats;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (allowMissing && absent(error) && cursor.startsWith(root + path.sep))
        return { identities: result, missing: true };
      throw error;
    }
    if (info.isSymbolicLink())
      throw new Error("Символические ссылки не разрешены");
    if (!info.isDirectory())
      throw new Error("Ожидался обычный каталог проекта");
    result.push({ path: cursor, info });
  }
  if ((await realpath(root)) !== root) throw changed();
  return { identities: result, missing: false };
}
async function verifyDirectories(identities: DirectoryIdentity[]) {
  for (const entry of identities) {
    const current = await lstat(entry.path);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameIdentity(current, entry.info)
    )
      throw changed();
  }
}
function editable(info: Stats) {
  if (info.isSymbolicLink())
    throw new NotEditable("Символические ссылки не разрешены");
  if (!info.isFile())
    throw new NotEditable("Редактируются только обычные файлы");
  if (info.nlink !== 1)
    throw new NotEditable("Файлы с жёсткими ссылками не разрешены");
  if (info.size > MAX_BYTES)
    throw new NotEditable("Файл превышает лимит 1 МиБ");
}
function decode(bytes: Uint8Array, rawSource = false) {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new NotEditable("Файл не является корректным UTF-8");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
    throw new NotEditable("Бинарные данные не редактируются");
  if (rawSource && /[\x80-\x9f]/.test(text))
    throw new NotEditable("Недопустимые управляющие символы C1 в исходнике");
  return text;
}
function version(bytes: Buffer, info: Stats, ancestors: DirectoryIdentity[]) {
  // Covers exact bytes AND file identity: replacing a file with identical bytes is a conflict too.
  return createHash("sha256")
    .update(bytes)
    .update(
      JSON.stringify([
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
        info.mode,
        info.nlink,
        ancestors.map(({ info }) => [info.dev, info.ino]),
      ]),
    )
    .digest("hex");
}
async function read(
  root: string,
  relative: string,
  allowMissing: boolean,
  rawSource = false,
): Promise<ReadResult> {
  const parent = await directories(root, path.dirname(relative), allowMissing);
  const missing = (): ReadResult => ({
    document: {
      text: "",
      version: "missing",
      relativePath: relative,
      exists: false,
    },
    directories: parent.identities,
  });
  if (parent.missing) {
    await verifyDirectories(parent.identities);
    return missing();
  }
  const file = path.join(root, relative);
  let initial: Stats;
  try {
    initial = await lstat(file);
  } catch (error) {
    if (allowMissing && absent(error)) {
      await verifyDirectories(parent.identities);
      return missing();
    }
    throw error;
  }
  editable(initial);
  // NONBLOCK prevents hanging if a regular file is replaced with a FIFO before open.
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const actual = await handle.stat();
    editable(actual);
    if (!sameFile(initial, actual)) throw changed();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const next = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (!next.bytesRead) break;
      length += next.bytesRead;
    }
    const after = await handle.stat();
    await verifyDirectories(parent.identities);
    const current = await lstat(file);
    if (
      !sameFile(actual, after) ||
      !sameFile(actual, current) ||
      current.isSymbolicLink()
    )
      throw changed();
    if (length > MAX_BYTES) throw new NotEditable("Файл превышает лимит 1 МиБ");
    const contents = bytes.subarray(0, length);
    return {
      document: {
        text: decode(contents, rawSource),
        version: version(contents, actual, parent.identities),
        relativePath: relative,
        exists: true,
      },
      info: actual,
      directories: parent.identities,
    };
  } finally {
    await handle.close();
  }
}
export function saveProjectDocument(
  root: string,
  target: ProjectDocumentTarget,
  text: string,
  version: string,
  beforeMutation?: () => Promise<void>,
) {
  return saveSourceDocument(root, target, text, version, beforeMutation);
}
export function savePersonalProfile(
  root: string,
  name: string,
  text: string,
  version: string,
) {
  return saveSourceDocument(root, { kind: "profile", name }, text, version);
}
export async function readPersonalProfile(
  root: string,
  name: string,
): Promise<ProjectDocument> {
  const target = { kind: "profile", name } as const;
  const relative = relativePath(target);
  return flatOperation(root, async () => {
    await assertFlatSpelling(root, "profile", name);
    return (await read(root, relative, true)).document;
  });
}

export async function readProjectDocument(
  root: string,
  target: ProjectDocumentTarget,
): Promise<ProjectDocument> {
  const relative = relativePath(target);
  const action = async () => {
    if (isFlatDocument(target))
      await assertFlatSpelling(root, target.kind, target.name);
    return (
      await read(root, relative, target.kind !== "tool", isFlatDocument(target))
    ).document;
  };
  return isFlatDocument(target) ? flatOperation(root, action) : action();
}
function validateText(
  text: unknown,
  target: SourceDocumentTarget,
): asserts text is string {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > MAX_BYTES ||
    Buffer.from(text).toString("utf8") !== text
  )
    throw new Error("Нужен UTF-8 документ не более 1 МиБ");
  decode(Buffer.from(text), isFlatDocument(target));
  // Goga owns workflow rendering and pipeline header/body semantics. Never parse
  // or normalize either raw source format in Desktop.
  if (target.kind === "profile") {
    validateYaml(text, "profile");
    return;
  }
  if (isFlatDocument(target) || target.kind === "dockerfile") return;
  const docs = parseAllDocuments(text, { uniqueKeys: true });
  if (docs.some((doc) => doc.errors.length))
    throw new Error("Некорректный синтаксис YAML");
  if (
    target.kind === "config" &&
    (docs.length !== 1 || !isMap(docs[0].contents))
  )
    throw new Error("Конфигурация проекта должна содержать YAML mapping");
}

/**
 * Atomic same-directory replacement, with optimistic version + identity checks.
 * Node has no portable openat/renameat or compare-and-swap rename API: a hostile
 * same-user process can still swap ancestors or the leaf between the final check
 * and a path-based syscall. These checks narrow that race; they do not eliminate it.
 */
async function saveSourceDocument(
  root: string,
  target: SourceDocumentTarget,
  text: string,
  expectedVersion: string,
  beforeMutation?: () => Promise<void>,
): Promise<ProjectDocument> {
  const relative = relativePath(target),
    file = path.join(root, relative);
  // Resolve an existing parent before queueing, then recheck every ancestor inside
  // the action so replacing the queued directory never silently retargets a save.
  const queuedParent = await directories(
    root,
    isFlatDocument(target) || target.kind === "dockerfile"
      ? ""
      : path.dirname(relative),
  );
  const parentIdentity = queuedParent.identities.at(-1)!.info;
  const queueKey = `${parentIdentity.dev}:${parentIdentity.ino}`;
  const action = async () => {
    await verifyDirectories(queuedParent.identities);
    validateText(text, target);
    if (typeof expectedVersion !== "string" || !expectedVersion)
      throw changed();
    if (isFlatDocument(target))
      await assertFlatSpelling(root, target.kind, target.name, {
        creating: expectedVersion === "missing",
      });
    const initial = await read(
      root,
      relative,
      target.kind !== "tool",
      isFlatDocument(target),
    );
    if (initial.document.version !== expectedVersion) throw changed();
    await beforeMutation?.();
    if (target.kind === "dockerfile")
      await createSourceDirectories(
        root,
        path.dirname(relative),
        initial.directories,
      );
    // Flat source directories may be created ONLY by an explicit, validated save.
    if (isFlatDocument(target))
      await createFlatDirectories(root, target.kind, initial.directories);
    // Configuration creation still requires an existing .goga; tools cannot be created.
    const parent = await directories(root, path.dirname(relative));
    await verifyDirectories(initial.directories);
    const tmp = path.join(
      path.dirname(file),
      `.goga-document-${randomUUID()}.tmp`,
    );
    let temporary: Stats | undefined;
    try {
      const handle = await open(
        tmp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        initial.info ? initial.info.mode & 0o777 : 0o600,
      );
      try {
        temporary = await handle.stat();
        await verifyDirectories(parent.identities);
        await handle.writeFile(text, "utf8");
        await handle.sync();
        temporary = await handle.stat();
      } finally {
        await handle.close();
      }
      await verifyDirectories(initial.directories);
      await verifyDirectories(parent.identities);
      if (isFlatDocument(target))
        await assertFlatSpelling(root, target.kind, target.name, {
          creating: !initial.document.exists,
          stagingName: path.basename(tmp),
        });
      await beforeMutation?.();
      const current = await read(
        root,
        relative,
        target.kind !== "tool",
        isFlatDocument(target),
      );
      if (current.document.version !== expectedVersion) throw changed();
      const staged = await lstat(tmp);
      if (!staged.isFile() || !sameFile(staged, temporary!)) throw changed();
      await verifyDirectories(parent.identities);
      if (initial.document.exists) {
        const leaf = await lstat(file);
        if (!sameFile(leaf, current.info!) || leaf.isSymbolicLink())
          throw changed();
        await rename(tmp, file);
      } else {
        // link is an atomic no-clobber create; unlike rename, it never overwrites a new external file.
        await link(tmp, file);
        await unlink(tmp);
      }
      await verifyDirectories(parent.identities);
      const saved = await read(root, relative, false, isFlatDocument(target));
      if (
        saved.document.text !== text ||
        !sameIdentity(saved.info!, temporary!)
      )
        throw changed();
      return saved.document;
    } finally {
      // Do not unlink through replaced ancestors or delete another process's replacement.
      await verifyDirectories(parent.identities);
      let remaining: Stats | undefined;
      try {
        remaining = await lstat(tmp);
      } catch (error) {
        if (!absent(error)) throw error;
      }
      if (remaining && temporary && sameIdentity(remaining, temporary))
        await unlink(tmp);
    }
  };
  return serialize(queueKey, action);
}

async function serialize<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = saves.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  saves.set(key, next);
  try {
    return await next;
  } finally {
    if (saves.get(key) === next) saves.delete(key);
  }
}

/** Stable root identity also serializes operations while the flat source directory is absent. */
async function flatOperation<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  const guard = await directories(root, "");
  const info = guard.identities.at(-1)!.info;
  return serialize(`${info.dev}:${info.ino}`, async () => {
    await verifyDirectories(guard.identities);
    return action();
  });
}

async function createFlatDirectories(
  root: string,
  kind: FlatDocumentKind,
  initial: DirectoryIdentity[],
) {
  await verifyDirectories(initial);
  for (const relative of [".goga", flatDirectory(kind)]) {
    const guard = await directories(root, relative, true);
    if (!guard.missing) continue;
    await verifyDirectories(guard.identities);
    try {
      await mkdir(path.join(root, relative));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Never recurse through an unchecked newly created/external ancestor.
    await verifyDirectories(guard.identities);
    await directories(root, relative);
  }
}

async function flatEntries(
  root: string,
  kind: FlatDocumentKind,
  stagingName?: string,
): Promise<string[]> {
  const guard = await directories(root, flatDirectory(kind), true);
  if (guard.missing) {
    await verifyDirectories(guard.identities);
    return [];
  }
  const names: string[] = [];
  const directory = await opendir(path.join(root, flatDirectory(kind)), {
    bufferSize: 32,
  });
  for await (const entry of directory) {
    // Only the current save's exact generated basename is excluded. Never ignore
    // a pattern: external lookalike files must still count against the limit.
    if (entry.name === stagingName) continue;
    if (names.length >= MAX_ENTRIES)
      throw new Error(`Превышен лимит числа ${kind} (2048)`);
    names.push(entry.name);
  }
  await verifyDirectories(guard.identities);
  return names.sort();
}
async function assertFlatSpelling(
  root: string,
  kind: FlatDocumentKind,
  name: string,
  options: { creating?: boolean; stagingName?: string } = {},
) {
  const filename = name + ".yml";
  const entries = await flatEntries(root, kind, options.stagingName);
  const collision = () =>
    new NotEditable(
      `Имя ${kind} конфликтует с существующим именем по регистру или Unicode`,
    );
  if (
    entries.some(
      (entry) =>
        entry !== filename &&
        projectWorkflowAliasKey(entry) === projectWorkflowAliasKey(filename),
    )
  )
    throw collision();
  if (!entries.includes(filename)) {
    if (options.creating && entries.length >= MAX_ENTRIES)
      throw new Error(`Превышен лимит числа ${kind} (2048)`);
    // Filesystem case-folding may differ from Unicode comparison above.
    // Never address an existing leaf via another spelling.
    try {
      await lstat(path.join(root, flatDirectory(kind), filename));
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    throw collision();
  }
}

export function listProjectWorkflows(root: string): Promise<ProjectWorkflow[]> {
  return listFlatDocuments(root, "workflow");
}
export function listProjectPipelines(root: string): Promise<ProjectPipeline[]> {
  return listFlatDocuments(root, "pipeline");
}
export function listProjectProfiles(root: string): Promise<ProjectProfile[]> {
  return listFlatDocuments(root, "profile");
}
async function listFlatDocuments(
  root: string,
  kind: FlatDocumentKind,
): Promise<ProjectWorkflow[]> {
  return flatOperation(root, async () => {
    const guard = await directories(root, flatDirectory(kind), true);
    const names = await flatEntries(root, kind);
    const aliases = new Map<string, number>();
    for (const name of names)
      aliases.set(
        projectWorkflowAliasKey(name),
        (aliases.get(projectWorkflowAliasKey(name)) ?? 0) + 1,
      );
    const result: ProjectWorkflow[] = [];
    for (const filename of names) {
      const name = filename.endsWith(".yml") ? filename.slice(0, -4) : filename;
      const relative = `${flatDirectory(kind)}/${filename}`;
      let reason: string | undefined;
      try {
        if (!filename.endsWith(".yml"))
          throw new NotEditable("Поддерживаются только файлы .yml");
        if (
          !(kind === "profile"
            ? isPersonalProfileName(name)
            : isProjectWorkflowName(name))
        )
          throw new NotEditable(`Недопустимое имя ${kind}`);
        if (aliases.get(projectWorkflowAliasKey(filename))! > 1)
          throw new NotEditable("Конфликт имён по регистру или Unicode");
        await read(root, relative, false, true);
      } catch (error) {
        if (!(error instanceof NotEditable)) throw error;
        reason = error.message;
      }
      result.push({
        name,
        path: relative,
        editable: !reason,
        ...(reason ? { reason } : {}),
      });
    }
    await verifyDirectories(guard.identities);
    return result;
  });
}

export async function listProjectTools(root: string): Promise<ProjectTool[]> {
  const catalog = await directories(root, ".goga/tools", true);
  if (catalog.missing) {
    await verifyDirectories(catalog.identities);
    return [];
  }
  let count = 0;
  const list = async (relative: string) => {
    const guard = await directories(root, relative);
    const names: string[] = [];
    const directory = await opendir(path.join(root, relative), {
      bufferSize: 32,
    });
    for await (const entry of directory) {
      if (++count > MAX_ENTRIES)
        throw new Error(
          "Превышен лимит числа записей каталога инструментов (2048)",
        );
      names.push(entry.name);
    }
    await verifyDirectories(guard.identities);
    return names.sort();
  };
  const result: ProjectTool[] = [];
  for (const name of await list(".goga/tools")) {
    if (!isProjectToolName(name)) continue;
    const base = `.goga/tools/${name}`;
    const info = await lstat(path.join(root, base));
    if (info.isSymbolicLink())
      throw new Error(
        "Символические ссылки в каталоге инструментов не разрешены",
      );
    if (!info.isDirectory()) continue;
    const entries: ProjectToolEntry[] = [];
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH)
        throw new Error("Превышен лимит глубины каталога инструментов (16)");
      for (const item of await list(relative ? `${base}/${relative}` : base)) {
        const entryPath = relative ? `${relative}/${item}` : item;
        const itemRelative = `${base}/${entryPath}`;
        const info = await lstat(path.join(root, itemRelative));
        if (!isProjectToolPath(entryPath)) {
          entries.push({
            path: entryPath,
            kind: info.isDirectory() ? "directory" : "file",
            editable: false,
            reason: "Недопустимое имя или путь",
          });
        } else if (info.isDirectory()) {
          entries.push({ path: entryPath, kind: "directory", editable: false });
          await walk(entryPath, depth + 1);
        } else {
          let reason: string | undefined;
          try {
            editable(info);
            if (!yamlName.test(item))
              throw new NotEditable("Редактируются только .yaml и .yml файлы");
            await read(root, itemRelative, false);
          } catch (error) {
            if (!(error instanceof NotEditable)) throw error;
            reason = error.message;
          }
          entries.push({
            path: entryPath,
            kind: "file",
            editable: !reason,
            ...(reason ? { reason } : {}),
          });
        }
      }
    };
    await walk("", 0);
    result.push({ name, entries });
  }
  await verifyDirectories(catalog.identities);
  return result;
}

/** Host-only captured capability; never sent across IPC. */
export interface GuardedDocumentDeletion {
  relativePath: string;
  version: string;
  perform: (trash: TrashItem) => Promise<DeletionResult>;
}
const notTrashed = (): DeletionResult => ({
  status: "not-trashed",
  message:
    "Файл не перемещён в Корзину. Он мог измениться извне; обновите список и откройте документ заново.",
});
const uncertainTrash = (): DeletionResult => ({
  status: "uncertain",
  message:
    "Не удалось подтвердить перемещение в Корзину. Исходный файл отсутствует, изменён или недоступен для проверки. Проверьте Корзину и каталог; текст редактора сохранён.",
});

/** Check the exact spelling and Unicode/case aliases of every component under the trusted root. */
async function assertSourceSpelling(root: string, relative: string) {
  let cursor = root;
  for (const part of relative.split("/")) {
    const names: string[] = [];
    const directory = await opendir(cursor, { bufferSize: 32 });
    for await (const entry of directory) {
      if (names.length >= MAX_ENTRIES) throw changed();
      names.push(entry.name);
    }
    if (
      !names.includes(part) ||
      names.some(
        (n) =>
          n !== part &&
          projectWorkflowAliasKey(n) === projectWorkflowAliasKey(part),
      )
    )
      throw changed();
    cursor = path.join(cursor, part);
  }
}

/** No directory creation, no parsing or renderer exposure of hidden contents. */
export async function prepareSourceDeletion(
  root: string,
  target: SourceDocumentTarget,
  expectedVersion?: string,
): Promise<GuardedDocumentDeletion> {
  if (target.kind === "config" || target.kind === "dockerfile")
    throw new Error("Конфигурацию удалять нельзя");
  const relative = relativePath(target);
  const queued = await directories(
    root,
    isFlatDocument(target) ? "" : path.dirname(relative),
  );
  const info = queued.identities.at(-1)!.info,
    key = `${info.dev}:${info.ino}`;
  return serialize(key, async () => {
    await verifyDirectories(queued.identities);
    // Flat sources queue on the root; validate the full parent chain before
    // spelling checks enumerate any source directory (never follow existing links).
    const parent = await directories(root, path.dirname(relative));
    await verifyDirectories(parent.identities);
    await assertSourceSpelling(root, relative);
    const initial = await read(root, relative, false, isFlatDocument(target));
    await verifyDirectories(parent.identities);
    if (
      expectedVersion !== undefined &&
      initial.document.version !== expectedVersion
    )
      throw changed();
    await assertSourceSpelling(root, relative);
    await verifyDirectories(initial.directories);
    return {
      relativePath: relative,
      version: initial.document.version,
      perform: (trash) =>
        serialize(key, async () => {
          try {
            await verifyDirectories(queued.identities);
            await verifyDirectories(initial.directories);
            await assertSourceSpelling(root, relative);
            const current = await read(
              root,
              relative,
              false,
              isFlatDocument(target),
            );
            if (current.document.version !== initial.document.version)
              throw changed();
            await assertSourceSpelling(root, relative);
            await verifyDirectories(initial.directories);
            const leaf = await lstat(path.join(root, relative));
            if (!sameFile(leaf, current.info!) || leaf.isSymbolicLink())
              throw changed();
          } catch {
            return notTrashed();
          }
          // Electron's path-based OS trash API has no portable compare-and-swap.
          // This final check narrows, but cannot remove, hostile external TOCTOU races.
          let resolved = false;
          try {
            await trash(path.join(root, relative));
            resolved = true;
          } catch {
            /* inspect, never infer rollback */
          }
          try {
            await verifyDirectories(initial.directories);
            try {
              await lstat(path.join(root, relative));
            } catch (error) {
              if (!absent(error)) throw error;
              // Parent identity is checked again after probing absence.
              await verifyDirectories(initial.directories);
              return resolved ? { status: "trashed" } : uncertainTrash();
            }
            await assertSourceSpelling(root, relative);
            const after = await read(
              root,
              relative,
              false,
              isFlatDocument(target),
            );
            return after.document.version === initial.document.version
              ? notTrashed()
              : uncertainTrash();
          } catch {
            return uncertainTrash();
          }
        }),
    };
  });
}

async function createSourceDirectories(
  root: string,
  relative: string,
  initial: DirectoryIdentity[],
) {
  await verifyDirectories(initial);
  let prefix = "";
  for (const part of relative.split("/").filter((part) => part !== ".")) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const guard = await directories(root, prefix, true);
    if (!guard.missing) continue;
    await verifyDirectories(guard.identities);
    try {
      await mkdir(path.join(root, prefix));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await verifyDirectories(guard.identities);
    await directories(root, prefix);
  }
}
