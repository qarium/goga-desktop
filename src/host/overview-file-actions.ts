import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  opendir,
  mkdir,
  rename,
  link,
  unlink,
  rmdir,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import type { ScopeRef } from "../shared/context";
import {
  isOverviewPath,
  type OverviewFileActionRequest,
  type OverviewFileActionPreview,
  type OverviewFileActionResult,
} from "../shared/project-overview";
import type { TrashItem } from "../shared/document-deletion";
import { projectWorkflowAliasKey } from "../shared/project-documents";
import {
  sourceDirectories,
  verifySourceDirectories,
} from "./project-documents";
import { assertReadActive } from "./read-scope";
const changed = () =>
  Error(
    "Файл или каталог изменился. Обновите список и подтвердите действие заново.",
  );
const absent = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const revision = (s: Stats) =>
  [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(":");
const valid = (p: string) => {
  if (!isOverviewPath(p)) throw changed();
};
async function missing(p: string) {
  try {
    await lstat(p);
    return false;
  } catch (e) {
    if (absent(e)) return true;
    throw e;
  }
}
/** Exact spelling rejects case/Unicode aliases and does not follow links. */
async function spelling(root: string, relative: string) {
  let cursor = root;
  for (const part of relative.split("/")) {
    const names: string[] = [];
    const dir = await opendir(cursor);
    for await (const entry of dir) {
      if (names.length >= 10000) throw changed();
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
async function fingerprint(
  root: string,
  relative: string,
  descendants: boolean,
) {
  let count = 0;
  const hash = createHash("sha256");
  const visit = async (p: string, depth: number): Promise<void> => {
    assertReadActive();
    valid(p);
    if (++count > 10000 || depth > 32) throw changed();
    const info = await lstat(path.join(root, p));
    if (
      info.isSymbolicLink() ||
      (!info.isFile() && !info.isDirectory()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw changed();
    hash.update(JSON.stringify([p, revision(info)]));
    if (descendants && info.isDirectory()) {
      const children: string[] = [];
      const dir = await opendir(path.join(root, p));
      for await (const entry of dir) {
        if (children.length >= 10000) throw changed();
        children.push(entry.name);
      }
      for (const name of children.sort())
        await visit(p + "/" + name, depth + 1);
    }
    if (revision(await lstat(path.join(root, p))) !== revision(info))
      throw changed();
  };
  await visit(relative, 0);
  return hash.digest("hex");
}
export async function checkedOverviewEntry(
  root: string,
  relative: string,
  descendants = false,
) {
  valid(relative);
  const parents = await sourceDirectories(
    root,
    path.dirname(relative) === "." ? "" : path.dirname(relative),
  );
  await verifySourceDirectories(parents.identities);
  await spelling(root, relative);
  const info = await lstat(path.join(root, relative));
  if (
    info.isSymbolicLink() ||
    (!info.isFile() && !info.isDirectory()) ||
    (info.isFile() && info.nlink !== 1)
  )
    throw changed();
  const version = await fingerprint(root, relative, descendants);
  await verifySourceDirectories(parents.identities);
  return {
    relative,
    info,
    parents: parents.identities,
    verify: async () => {
      await verifySourceDirectories(parents.identities);
      await spelling(root, relative);
      if ((await fingerprint(root, relative, descendants)) !== version)
        throw changed();
      await verifySourceDirectories(parents.identities);
    },
  };
}
export interface PreparedOverviewFileAction {
  request: OverviewFileActionRequest;
  paths: string[];
  perform: (
    guard: () => Promise<void>,
    trash?: TrashItem,
  ) => Promise<OverviewFileActionResult>;
}
const result = (
  status: OverviewFileActionResult["status"],
  completedPaths: string[],
): OverviewFileActionResult => ({
  status,
  completedPaths,
  message:
    status === "done"
      ? "Действие выполнено."
      : status === "partial"
        ? "Выполнена только часть действия. Остальные файлы сохранены; обновите список."
        : status === "uncertain"
          ? "Результат не подтверждён. Проверьте каталог и Корзину; автоматического повтора не будет."
          : "Действие не выполнено. Обновите список и подтвердите его заново.",
});
export async function prepareOverviewAction(
  root: string,
  request: OverviewFileActionRequest,
): Promise<PreparedOverviewFileAction> {
  const paths =
    request.kind === "trash"
      ? [...new Set(request.paths)].filter(
          (p) =>
            !request.paths.some(
              (other) => other !== p && p.startsWith(other + "/"),
            ),
        )
      : [request.path];
  const entries = await Promise.all(
    paths.map((p) => checkedOverviewEntry(root, p, true)),
  );
  if (request.kind === "rename") {
    valid(request.destination);
    if (
      path.dirname(request.path) !== path.dirname(request.destination) ||
      request.path === request.destination
    )
      throw changed();
    if (!(await missing(path.join(root, request.destination))))
      throw Error("Файл или папка с таким именем уже существует.");
  }
  for (const entry of entries) await entry.verify();
  return {
    request,
    paths,
    perform: async (guard, trash) => {
      const completed: string[] = [];
      for (const entry of entries) {
        try {
          await guard();
          await entry.verify();
          await guard();
        } catch {
          return result(completed.length ? "partial" : "not-done", completed);
        }
        const source = path.join(root, entry.relative);
        if (request.kind === "trash") {
          if (!trash)
            return result(completed.length ? "partial" : "not-done", completed);
          let resolved = false;
          // Electron Trash is path-based: final identity checks narrow but cannot
          // remove races with arbitrary external filesystem writers. Never retry.
          try {
            await trash(source);
            resolved = true;
          } catch {
            /* inspect outcome */
          }
          try {
            await verifySourceDirectories(entry.parents);
            if (await missing(source)) {
              await verifySourceDirectories(entry.parents);
              if (!resolved) return result("uncertain", completed);
              completed.push(entry.relative);
            } else {
              await entry.verify();
              return result(
                completed.length ? "partial" : "not-done",
                completed,
              );
            }
          } catch {
            return result("uncertain", completed);
          }
        } else {
          const destination = path.join(root, request.destination);
          let reservation: Stats | undefined,
            linked = false,
            attempted = false;
          try {
            if (entry.info.isDirectory()) {
              // Exclusive reservation never replaces an existing destination. A
              // directory rename cannot replace a file/link or nonempty folder.
              await mkdir(destination);
              reservation = await lstat(destination);
              if (!reservation.isDirectory() || reservation.isSymbolicLink())
                throw changed();
              await guard();
              await entry.verify();
              if (!same(reservation, await lstat(destination))) throw changed();
              // Node has no directory compare-and-swap: a hostile replacement
              // with another EMPTY directory after this check can be replaced.
              // A nonempty replacement is never overwritten; no isolation from
              // arbitrary external writers is claimed (same limit as OS Trash).
              attempted = true;
              await rename(source, destination);
            } else {
              // link is atomically no-clobber (including dangling symlinks).
              await link(source, destination);
              linked = true;
              const target = await lstat(destination);
              if (!same(entry.info, target)) throw changed();
              await guard();
              await verifySourceDirectories(entry.parents);
              if (!same(entry.info, await lstat(source))) throw changed();
              attempted = true;
              await unlink(source);
            }
            await verifySourceDirectories(entry.parents);
            if (
              !(await missing(source)) ||
              !same(entry.info, await lstat(destination))
            )
              throw changed();
            completed.push(entry.relative);
          } catch {
            // Never recursively remove or retry. Remove only our still-identical,
            // empty reservation. External data makes rmdir fail harmlessly.
            if (reservation) {
              try {
                await verifySourceDirectories(entry.parents);
                if (same(reservation, await lstat(destination)))
                  await rmdir(destination);
              } catch {
                /* preserve external data */
              }
            }
            if (linked) return result("uncertain", completed);
            if (attempted) {
              try {
                await entry.verify();
              } catch {
                return result("uncertain", completed);
              }
            }
            return result("not-done", completed);
          }
        }
      }
      try {
        await guard();
      } catch {
        return result("uncertain", completed);
      }
      return result("done", completed);
    },
  };
}
interface PendingOverviewFileAction {
  scope: ScopeRef;
  root: string;
  settingsVersion: string;
  prepared: PreparedOverviewFileAction;
  created: number;
}
/** Same bounded, five-minute, one-shot capability policy as document deletion. */
export class OverviewFileActionTickets {
  private pending = new Map<string, PendingOverviewFileAction>();
  isCurrent(item: PendingOverviewFileAction) {
    const age = Date.now() - item.created;
    return age >= 0 && age <= 300000;
  }
  private prune() {
    for (const [token, item] of this.pending)
      if (!this.isCurrent(item)) this.pending.delete(token);
  }
  issue(
    item: Omit<PendingOverviewFileAction, "created">,
  ): OverviewFileActionPreview {
    this.prune();
    while (this.pending.size >= 128)
      this.pending.delete(this.pending.keys().next().value!);
    const token = randomUUID();
    this.pending.set(token, {
      ...item,
      scope: structuredClone(item.scope),
      created: Date.now(),
    });
    return {
      token,
      kind: item.prepared.request.kind,
      paths: [...item.prepared.paths],
      ...(item.prepared.request.kind === "rename"
        ? { destination: item.prepared.request.destination }
        : {}),
    };
  }
  take(token: string) {
    const item = this.pending.get(token);
    this.pending.delete(token);
    this.prune();
    return item && this.isCurrent(item) ? item : undefined;
  }
}
