import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  historyEntrySchema,
  type HistoryPrunePreview,
  type HistoryPruneResult,
} from "../shared/history";
import { noSymlinks } from "./settings";
import { assertReadActive } from "./read-scope";
import { CommandExitError } from "./process";
import { sanitizeRepositoryLog } from "./repository-actions";

const stale = () =>
  Error(
    "Предпросмотр очистки устарел. Откройте его заново и проверьте список.",
  );
interface Pending {
  projectId: string;
  year: string;
  root: string;
  version: string;
  stamp: string;
  entries: string[];
  created: number;
}
export interface PruneAccess {
  root: string;
  version: string;
  secrets: string[];
  verify(): Promise<void>;
  command(args: string[]): Promise<{ stdout: string; stderr: string }>;
}
/** Metadata only; never read document content. Reject links before delegating deletion to CLI. */
async function inventory(root: string, year: string) {
  const hash = createHash("sha256");
  const base = path.join(root, ".goga", "history", year);
  await noSymlinks(base);
  for (const p of [
    root,
    path.join(root, ".goga"),
    path.join(root, ".goga/history"),
  ]) {
    const s = await lstat(p);
    if (!s.isDirectory() || s.isSymbolicLink())
      throw Error("Каталог истории недоступен для безопасной очистки.");
    hash.update(JSON.stringify([p, s.dev, s.ino]));
  }
  let count = 0;
  const walk = async (p: string, depth: number): Promise<void> => {
    assertReadActive();
    if (++count > 20000 || depth > 20)
      throw Error(
        "История слишком велика для безопасного предпросмотра очистки.",
      );
    const s = await lstat(p);
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory()))
      throw Error(
        "В истории обнаружена ссылка или специальный файл. Очистка отменена.",
      );
    hash.update(
      JSON.stringify([p, s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs]),
    );
    if (s.isDirectory())
      for (const child of (await readdir(p)).sort())
        await walk(path.join(p, child), depth + 1);
  };
  await walk(base, 0);
  const entries = (await readdir(base, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  return { stamp: hash.digest("hex"), entries };
}
function parseCandidates(stdout: string, available: string[]) {
  if (!stdout.trim()) return [];
  const entries = stdout.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (
    entries.length > 2048 ||
    new Set(entries).size !== entries.length ||
    entries.some(
      (e) => !historyEntrySchema.safeParse(e).success || !available.includes(e),
    )
  )
    throw Error(
      "Goga вернула неожиданный список очистки. Удаление не выполнено.",
    );
  return entries.sort();
}
export class HistoryPruner {
  private tickets = new Map<string, Pending>();
  take(token: string) {
    const p = this.tickets.get(token);
    this.tickets.delete(token);
    return p;
  }
  private current(p: Pending) {
    return Date.now() >= p.created && Date.now() - p.created <= 300000;
  }
  private issue(p: Pending) {
    for (const [token, item] of this.tickets)
      if (!this.current(item)) this.tickets.delete(token);
    while (this.tickets.size >= 64)
      this.tickets.delete(this.tickets.keys().next().value!);
    const token = randomUUID();
    this.tickets.set(token, p);
    return token;
  }
  async run(
    projectId: string,
    year: string,
    access: PruneAccess,
    pending?: Pending,
  ): Promise<HistoryPrunePreview | HistoryPruneResult> {
    const lines: string[] = [];
    let changed = false;
    const command = async (dry: boolean) => {
      await access.verify();
      const args = [
        "history",
        "--year",
        year,
        "prune",
        ...(dry ? ["--dry-run"] : []),
      ];
      lines.push(`$ goga ${args.join(" ")}`);
      if (!dry) changed = true; // CLI can partially delete even if it fails.
      try {
        const r = await access.command(args);
        lines.push(r.stdout, r.stderr);
        return r.stdout;
      } catch (e) {
        if (e instanceof CommandExitError) lines.push(e.stdout, e.stderr);
        throw e;
      }
    };
    const log = () => sanitizeRepositoryLog(lines.join("\n"), access.secrets);
    try {
      await access.verify();
      if (
        pending &&
        (!this.current(pending) ||
          pending.projectId !== projectId ||
          pending.year !== year ||
          pending.root !== access.root ||
          pending.version !== access.version)
      )
        throw stale();
      const before = await inventory(access.root, year);
      if (pending && pending.stamp !== before.stamp) throw stale();
      const entries = parseCandidates(await command(true), before.entries);
      const after = await inventory(access.root, year);
      if (before.stamp !== after.stamp) throw stale();
      await access.verify();
      if (!pending) {
        assertReadActive();
        return {
          status: "ready",
          projectId,
          year,
          entries,
          log: log(),
          ...(entries.length
            ? {
                token: this.issue({
                  projectId,
                  year,
                  root: access.root,
                  version: access.version,
                  stamp: after.stamp,
                  entries,
                  created: Date.now(),
                }),
              }
            : {}),
        };
      }
      if (
        !this.current(pending) ||
        JSON.stringify(entries) !== JSON.stringify(pending.entries)
      )
        throw stale();
      await command(false);
      // Check what actually remains, not merely the CLI exit code.
      const remaining = await inventory(access.root, year);
      if (entries.some((e) => remaining.entries.includes(e)))
        throw Error(
          "Goga завершила очистку, но некоторые записи остались. Проверьте каталог и журнал.",
        );
      return { status: "ok", changed, log: log() };
    } catch (error) {
      const message = sanitizeRepositoryLog(
        error instanceof Error
          ? error.message
          : "Не удалось выполнить очистку.",
        access.secrets,
      );
      lines.push(`Ошибка: ${message}`);
      return pending
        ? { status: "error", changed, error: message, log: log() }
        : {
            status: "error",
            projectId,
            year,
            entries: [],
            error: message,
            log: log(),
          };
    }
  }
}
