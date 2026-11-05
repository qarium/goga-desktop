import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  rename,
  unlink,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import {
  isOverviewPath,
  type OverviewPasteResult,
  type OverviewPasteConflict,
  type OverviewPasteDecision,
  overviewPasteDecisionsSchema,
} from "../shared/project-overview";
import { projectWorkflowAliasKey } from "../shared/project-documents";
import {
  sourceDirectories,
  verifySourceDirectories,
} from "./project-documents";

const MAX_ENTRIES = 10000,
  MAX_DEPTH = 32,
  MAX_BYTES = 256 * 1024 * 1024,
  CHUNK = 64 * 1024;
type Directories = Awaited<ReturnType<typeof sourceDirectories>>["identities"];
interface Node {
  source: string;
  destination: string;
  info: Stats;
  ancestors: Directories;
  children: Node[];
  target?: Stats;
  blocked: boolean;
}
const changed = () =>
  Error(
    "Файл или каталог изменился во время копирования. Обновите дерево и проверьте результат.",
  );
const limit = () =>
  Error(
    "Превышен предел копирования: 10 000 элементов, глубина 32 и общий размер 256 МиБ.",
  );
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const version = (s: Stats) =>
  [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(":");
// Directory contents may change independently (e.g. an active pipeline). Only
// actual file targets are version-locked; merged directory ancestry is identity-locked.
const sameTarget = (expected: Stats, actual: Stats) =>
  expected.isDirectory()
    ? same(expected, actual)
    : version(expected) === version(actual);
const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent + path.sep);
function sourcePath(p: string) {
  if (
    typeof p !== "string" ||
    !path.isAbsolute(p) ||
    path.resolve(p) !== p ||
    p.length > 4096 ||
    /[\x00-\x1f\x7f-\x9f]/.test(p) ||
    p.split(path.sep).some((n) => n.toLowerCase() === ".git")
  )
    throw Error("Недопустимый файл в буфере обмена.");
}
async function assertSource(node: Node) {
  await verifySourceDirectories(node.ancestors);
  if (version(await lstat(node.source)) !== version(node.info)) throw changed();
}
async function missing(p: string) {
  try {
    await lstat(p);
    return false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}
class UncertainCopy extends Error {}
const result = (
  status: OverviewPasteResult["status"],
  completedPaths: string[],
  touchedPaths: string[],
  reason = "",
): OverviewPasteResult => ({
  status,
  completedPaths,
  touchedPaths,
  message:
    status === "done"
      ? "Файлы скопированы."
      : status === "uncertain"
        ? "Результат копирования не подтверждён. Проверьте дерево; автоматического повтора и удаления не будет." +
          (reason ? " " + reason : "")
        : status === "partial"
          ? "Копирование прервано. Часть файлов или папок уже создана; они оставлены для проверки. " +
            reason
          : "Файлы не скопированы. " + reason,
});
export interface PreparedOverviewPaste {
  conflicts: OverviewPasteConflict[];
  perform(
    decisions: OverviewPasteDecision[],
    guard?: () => Promise<void>,
  ): Promise<OverviewPasteResult>;
}
/** Bounded, captured copy of explicit native clipboard selections.
 * Path/descriptor checks narrow races, but Node cannot provide atomic isolation
 * against arbitrary external ancestor replacements. No rollback or auto-retry. */
export async function prepareOverviewPaste(
  root: string,
  sources: readonly string[],
  destination: string,
  prepareGuard: () => Promise<void> = async () => {},
  allowConflicts = true,
): Promise<PreparedOverviewPaste> {
  if (!isOverviewPath(destination, true))
    throw Error("Недопустимая папка назначения.");
  if (!Array.isArray(sources) || !sources.length || sources.length > 128)
    throw Error(
      "В буфере нет файлов для вставки (не более 128 выбранных объектов).",
    );
  sources.forEach(sourcePath);
  const selected = [...new Set(sources)].filter(
    (p) => !sources.some((parent) => parent !== p && inside(p, parent)),
  );
  const target = await sourceDirectories(root, destination);
  const destinationRoot = path.join(root, destination);
  const destinationPhysical = await realpath(destinationRoot);
  if (destinationPhysical !== destinationRoot) throw changed();
  const verifyTargetRoot = async () => {
    await verifySourceDirectories(target.identities);
    if (!same(target.identities.at(-1)!.info, await lstat(destinationRoot)))
      throw changed();
  };
  await prepareGuard();
  const conflicts: OverviewPasteConflict[] = [];
  const directoryNames = new Map<string, string[]>();
  const targetInfo = async (relative: string, parents: Directories) => {
    await verifySourceDirectories(parents);
    const absolute = path.join(root, relative),
      parent = path.dirname(absolute);
    let names = directoryNames.get(parent);
    if (!names) {
      names = [];
      const directory = await opendir(parent);
      for await (const entry of directory) {
        if (names.length >= MAX_ENTRIES) throw limit();
        names.push(entry.name);
      }
      directoryNames.set(parent, names);
    }
    const name = path.basename(absolute),
      alias = projectWorkflowAliasKey(name);
    if (names.some((n) => n !== name && projectWorkflowAliasKey(n) === alias))
      throw changed();
    try {
      return await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  let count = 0,
    bytes = 0;
  const plan = async (
    source: string,
    relative: string,
    ancestors: Directories,
    depth: number,
    targetParents: Directories | undefined,
    blocked = false,
  ): Promise<Node> => {
    if (++count > MAX_ENTRIES || depth > MAX_DEPTH) throw limit();
    if (!isOverviewPath(relative))
      throw Error(
        "Копирование служебных Git-путей и неподдерживаемых имён запрещено.",
      );
    await verifySourceDirectories(ancestors);
    const info = await lstat(source);
    if (
      info.isSymbolicLink() ||
      (!info.isDirectory() && !info.isFile()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw Error(
        "Копируются только обычные файлы и папки, без символических/жёстких ссылок и специальных файлов.",
      );
    if (info.isFile() && (bytes += info.size) > MAX_BYTES) throw limit();
    const existing = targetParents
      ? await targetInfo(relative, targetParents)
      : undefined;
    if (
      existing &&
      (existing.isSymbolicLink() ||
        (!existing.isDirectory() && !existing.isFile()) ||
        (existing.isFile() && existing.nlink !== 1))
    )
      throw changed();
    if (existing && same(existing, info))
      throw Error("Нельзя вставить файл или папку в самих себя.");
    if (existing && !allowConflicts)
      throw Error(
        `Файл или папка «${path.basename(relative)}» уже существует. Вставка не заменяет файлы и не объединяет папки.`,
      );
    const collision =
      !!existing && !(info.isDirectory() && existing.isDirectory());
    if (collision)
      conflicts.push({
        path: relative,
        replaceable: info.isFile() && existing!.isFile(),
      });
    const node: Node = {
      source,
      destination: relative,
      info,
      ancestors,
      children: [],
      target: existing,
      blocked,
    };
    if (info.isDirectory()) {
      if (inside(destinationPhysical, await realpath(source)))
        throw Error(
          "Нельзя вставить папку в саму себя или в её вложенную папку.",
        );
      const names: string[] = [],
        aliases = new Set<string>();
      const directory = await opendir(source);
      for await (const entry of directory) {
        if (names.length >= MAX_ENTRIES) throw limit();
        const alias = projectWorkflowAliasKey(entry.name);
        if (aliases.has(alias))
          throw Error("Имена файлов неоднозначны для папки назначения.");
        aliases.add(alias);
        names.push(entry.name);
      }
      const parents = [...ancestors, { path: source, info }];
      for (const name of names.sort())
        node.children.push(
          await plan(
            path.join(source, name),
            relative + "/" + name,
            parents,
            depth + 1,
            existing?.isDirectory() && !collision
              ? [
                  ...targetParents!,
                  { path: path.join(root, relative), info: existing },
                ]
              : undefined,
            blocked || collision,
          ),
        );
    }
    await assertSource(node);
    return node;
  };
  const nodes: Node[] = [],
    topNames = new Set<string>();
  // Validate every selected tree and collision before reserving any destination.
  for (const source of selected) {
    const parents = await sourceDirectories(
      path.parse(source).root,
      path.dirname(source).slice(path.parse(source).root.length),
    );
    const name = path.basename(source),
      alias = projectWorkflowAliasKey(name);
    if (topNames.has(alias))
      throw Error("В буфере несколько файлов с одинаковым именем.");
    topNames.add(alias);
    const relative = destination ? destination + "/" + name : name;
    nodes.push(
      await plan(source, relative, parents.identities, 0, target.identities),
    );
  }
  await verifySourceDirectories(target.identities);
  // Capture all relevant source/target versions before yielding a confirmation.
  // Existing directory identities remain guarded after our own child writes.
  const verifyPlan = async (node: Node): Promise<void> => {
    await assertSource(node);
    if (!node.blocked) {
      const absolute = path.join(root, node.destination);
      if (node.target) {
        if (!sameTarget(node.target, await lstat(absolute))) throw changed();
      } else if (!(await missing(absolute))) throw changed();
    }
    for (const child of node.children) await verifyPlan(child);
  };
  for (const node of nodes) await verifyPlan(node);
  await verifyTargetRoot();
  return {
    conflicts,
    perform: async (rawDecisions, performGuard = async () => {}) => {
      const decisions = overviewPasteDecisionsSchema.parse(rawDecisions);
      const actions = new Map(
        decisions.map((item) => [item.path, item.action]),
      );
      if (
        actions.size !== decisions.length ||
        actions.size !== conflicts.length ||
        conflicts.some(
          (item) =>
            !actions.has(item.path) ||
            (!item.replaceable && actions.get(item.path) === "replace"),
        )
      )
        throw Error("Для каждого совпадения нужно выбрать замену или пропуск.");
      const guard = async () => {
        await performGuard();
        await verifyTargetRoot();
      };
      const completed: string[] = [],
        touched: string[] = [];
      let mutated = false;
      const copyNode = async (
        node: Node,
        ancestors: Directories,
        top: string,
      ): Promise<void> => {
        if (actions.get(node.destination) === "skip") return;
        await guard();
        await assertSource(node);
        await verifySourceDirectories(ancestors);
        const absolute = path.join(root, node.destination);
        directoryNames.delete(path.dirname(absolute));
        const current = await targetInfo(node.destination, ancestors);
        if (
          node.target
            ? !current || !sameTarget(node.target, current)
            : !!current
        )
          throw changed();
        let source: FileHandle | undefined, output: FileHandle | undefined;
        let reserved: Stats | undefined;
        let staged: string | undefined;
        let published = false;
        try {
          if (node.info.isDirectory()) {
            if (node.target?.isDirectory()) {
              reserved = await lstat(absolute);
              if (!same(node.target, reserved)) throw changed();
            } else {
              await mkdir(absolute, { mode: 0o700 }); // exclusive reservation
              mutated = true;
              if (!touched.includes(top)) touched.push(top);
              reserved = await lstat(absolute);
            }
            if (!reserved.isDirectory() || reserved.isSymbolicLink())
              throw new UncertainCopy();
            await guard();
            await verifySourceDirectories(ancestors);
            const parents = [...ancestors, { path: absolute, info: reserved }];
            for (const child of node.children)
              await copyNode(child, parents, top);
            await assertSource(node);
            await verifySourceDirectories(parents);
            output = await open(
              absolute,
              constants.O_RDONLY |
                constants.O_DIRECTORY |
                constants.O_NOFOLLOW |
                constants.O_NONBLOCK,
            );
            const opened = await output.stat();
            if (!same(reserved, opened)) throw new UncertainCopy();
            await verifySourceDirectories(ancestors);
            if (!node.target) await output.chmod(node.info.mode & 0o777);
            const after = await lstat(absolute);
            if (
              after.dev !== reserved.dev ||
              after.ino !== reserved.ino ||
              !after.isDirectory()
            )
              throw new UncertainCopy();
          } else {
            source = await open(
              node.source,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            if (version(await source.stat()) !== version(node.info))
              throw changed();
            await verifySourceDirectories(node.ancestors);
            await verifySourceDirectories(ancestors);
            if (
              node.target &&
              version(await lstat(absolute)) !== version(node.target)
            )
              throw changed();
            const outputPath = node.target
              ? path.join(path.dirname(absolute), ".goga-paste-" + randomUUID())
              : absolute;
            if (node.target) staged = outputPath;
            output = await open(
              outputPath,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                constants.O_NOFOLLOW,
              0o600,
            );
            if (!staged) {
              mutated = true;
              if (!touched.includes(top)) touched.push(top);
            }
            reserved = await output.stat();
            if (
              !reserved.isFile() ||
              reserved.nlink !== 1 ||
              !same(reserved, await lstat(staged ?? absolute))
            )
              throw new UncertainCopy();
            const buffer = Buffer.alloc(
              Math.min(CHUNK, Math.max(1, node.info.size)),
            );
            let offset = 0;
            while (offset < node.info.size) {
              await guard();
              await verifySourceDirectories(node.ancestors);
              await verifySourceDirectories(ancestors);
              if (!same(reserved, await lstat(staged ?? absolute)))
                throw new UncertainCopy();
              const { bytesRead } = await source.read(
                buffer,
                0,
                Math.min(buffer.length, node.info.size - offset),
                offset,
              );
              if (!bytesRead) throw changed();
              let written = 0;
              while (written < bytesRead) {
                const n = await output.write(
                  buffer,
                  written,
                  bytesRead - written,
                  offset + written,
                );
                if (!n.bytesWritten) throw Error("Не удалось записать файл.");
                written += n.bytesWritten;
              }
              offset += bytesRead;
            }
            if (version(await source.stat()) !== version(node.info))
              throw changed();
            await assertSource(node);
            await output.chmod(node.info.mode & 0o777);
            const final = await output.stat(),
              leaf = await lstat(staged ?? absolute);
            if (
              final.dev !== reserved.dev ||
              final.ino !== reserved.ino ||
              final.size !== node.info.size ||
              final.nlink !== 1 ||
              !same(final, leaf)
            )
              throw new UncertainCopy();
            await verifySourceDirectories(ancestors);
            if (staged) {
              reserved = final;
              // Never truncate/unlink a destination: publish only complete staged
              // bytes after a fresh target version check. Node's rename has no CAS;
              // this narrows, but cannot eliminate arbitrary external-writer races.
              await output.sync();
              await guard();
              await assertSource(node);
              await verifySourceDirectories(ancestors);
              if (version(await lstat(absolute)) !== version(node.target!))
                throw changed();
              if (version(reserved) !== version(await lstat(staged)))
                throw new UncertainCopy();
              mutated = true;
              if (!touched.includes(top)) touched.push(top);
              try {
                await rename(staged, absolute);
              } catch {
                throw new UncertainCopy();
              }
              published = true;
              if (!same(reserved, await lstat(absolute)))
                throw new UncertainCopy();
              await verifySourceDirectories(ancestors);
            }
          }
        } finally {
          // Descriptors are closed only; partial data is never recursively removed.
          const closed = await Promise.allSettled([
            source?.close(),
            output?.close(),
          ]);
          // Only our still-identical staging file can be removed; never foreign data.
          if (staged && !published && output) {
            let cleaned = false;
            try {
              await verifySourceDirectories(ancestors);
              if (
                reserved &&
                version(reserved) === version(await lstat(staged))
              ) {
                await unlink(staged);
                cleaned = true;
              }
            } catch {
              // An absent ancestor is not proof that our stage was removed.
              // Preserve the unknown outcome and its relative evidence.
            }
            if (!cleaned) {
              if (!touched.includes(top)) touched.push(top);
              throw new UncertainCopy(
                `Промежуточный файл «${path.relative(root, staged).split(path.sep).join("/")}» оставлен для проверки.`,
              );
            }
          }
          if (closed.some((value) => value.status === "rejected"))
            throw new UncertainCopy();
        }
      };
      try {
        await guard();
        await verifyTargetRoot();
        for (const node of nodes) await verifyPlan(node);
        await verifySourceDirectories(target.identities);
        for (const node of nodes) {
          if (actions.get(node.destination) === "skip") continue;
          await copyNode(node, target.identities, node.destination);
          completed.push(node.destination);
        }
        await guard();
        await verifySourceDirectories(target.identities);
        return result("done", completed, touched);
      } catch (error) {
        return result(
          error instanceof UncertainCopy
            ? "uncertain"
            : mutated
              ? "partial"
              : "not-done",
          completed,
          touched,
          error instanceof Error ? error.message : "",
        );
      }
    },
  };
}
/** Compatibility endpoint remains strictly no-clobber and never merges. */
export async function copyOverviewEntries(
  root: string,
  sources: readonly string[],
  destination: string,
  guard: () => Promise<void> = async () => {},
): Promise<OverviewPasteResult> {
  const prepared = await prepareOverviewPaste(
    root,
    sources,
    destination,
    guard,
    false,
  );
  return prepared.perform([], guard);
}
