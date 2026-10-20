import { runRecoveryMetadataSchema } from "./run-recovery";
import { buildRepeatSnapshotSchema } from "../shared/build-repeat";
import { constants } from "node:fs";
import { mkdir, open, link, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Run } from "../shared/types";
import { topicContextRefSchema } from "../shared/worktrees";
import { noSymlinks } from "./settings";
import { acquireOwnedLock } from "./owned-lock";
const invalid = () =>
  Error("Журнал запусков Desktop повреждён или несовместим.");
const conflict = () =>
  Error("Журнал запусков изменён. Обновите данные перед сохранением.");
const ownerChanged = () =>
  Error(
    "Владелец или контекст сохранённого запуска изменён; запись запрещена.",
  );
const absolute = (value: string) =>
  path.isAbsolute(value) &&
  path.resolve(value) === value &&
  !/[\x00-\x1f\x7f]/.test(value);
const text = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine((v) => !v.includes("\0"));
const contextSchema = topicContextRefSchema.extend({
  path: text(4096, 1).refine(absolute).optional(),
  repositoryKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
const buildSchema = z.object({
  planPath: text(4096, 1),
  planVersion: z.string().regex(/^[a-f0-9]{64}$/),
  clean: z.boolean(),
  update: z.boolean(),
  skipReview: z.boolean().optional(),
  skipManifestCheck: z.boolean(),
});
const taskSchema = z.object({
  text: text(100000),
  year: z.string().regex(/^\d{4}$/),
  topic: text(1024, 1),
  branch: text(256, 1),
});
const runSchema = z.object({
  buildRepeat: buildRepeatSnapshotSchema.optional(),
  process: runRecoveryMetadataSchema.optional(),
  id: text(256, 1),
  projectId: text(256, 1),
  pipeline: text(1024),
  topic: text(1024),
  branch: text(256),
  context: contextSchema.optional(),
  kind: z.enum(["pipeline", "build"]).optional(),
  build: buildSchema.optional(),
  taskSnapshot: taskSchema.optional(),
  pipelineName: text(1024).optional(),
  pipelineDescription: text(16000).optional(),
  status: z.enum(["starting", "running", "exited", "failed", "stopped"]),
  workflow: text(1024).nullable(),
  profile: text(1024).nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  startupTimeoutMs: z.number().int().nonnegative().optional(),
  update: z.boolean().optional(),
  dashboardOpened: z.boolean().optional(),
  recovery: z.enum(["unverified", "confirmed"]).optional(),
  syncPending: z.boolean().optional(),
});
const strictRunSchema = runSchema
  .extend({
    context: contextSchema.strict().optional(),
    build: buildSchema.strict().optional(),
    taskSnapshot: taskSchema.strict().optional(),
  })
  .strict();
type Snapshot = z.infer<typeof runSchema>;
const documentSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.string().uuid(),
    runs: z.array(strictRunSchema).max(100000),
    bindings: z
      .array(
        z
          .object({
            id: text(256, 1),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            processHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            terminal: z.enum(["exited", "failed", "stopped"]).optional(),
          })
          .strict(),
      )
      .max(100000),
  })
  .strict();
type Document = z.infer<typeof documentSchema>;
const MAX_BYTES = 16 * 1024 * 1024;
const tails = new Map<string, Promise<void>>();
function identity(run: Snapshot) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        run.id,
        run.projectId,
        run.context ?? null,
        run.kind ?? null,
        run.pipeline,
        run.pipelineName ?? null,
        run.pipelineDescription ?? null,
        run.topic,
        run.branch,
        run.workflow,
        run.profile,
        run.startedAt,
        run.build ?? null,
        run.taskSnapshot ?? null,
        run.startupTimeoutMs ?? null,
        run.update ?? null,
        ...(run.buildRepeat ? [run.buildRepeat] : []),
      ]),
    )
    .digest("hex");
}
function validateRuns(runs: Snapshot[]) {
  const ids = new Set<string>();
  for (const run of runs) {
    if (ids.has(run.id)) throw invalid();
    ids.add(run.id);
    if (run.process && run.process.runId !== run.id) throw ownerChanged();
    if (
      run.buildRepeat &&
      ((run.buildRepeat.sourceRunId &&
        run.buildRepeat.sourceRunId !== run.id) ||
        (run.buildRepeat.owner &&
          JSON.stringify(run.buildRepeat.owner) !==
            JSON.stringify(
              run.context && {
                projectId: run.context.projectId,
                year: run.context.year,
                topic: run.context.topic,
                branch: run.context.branch,
                contextId: run.context.contextId,
                revision: run.context.revision,
              },
            )))
    )
      throw ownerChanged();
    if (
      run.context &&
      (run.context.projectId !== run.projectId ||
        run.context.topic !== run.topic ||
        run.context.branch !== run.branch)
    )
      throw ownerChanged();
    if (
      run.context &&
      run.taskSnapshot &&
      (run.taskSnapshot.year !== run.context.year ||
        run.taskSnapshot.topic !== run.context.topic ||
        run.taskSnapshot.branch !== run.context.branch)
    )
      throw ownerChanged();
  }
}

/** Durable allowlisted history only. No process is inferred, reattached or killed. */
export class ContextRunsStore {
  readonly root: string;
  private readonly file: string;
  private readonly lock: string;
  private known = false;
  private knownRaw: string | undefined;
  private readonly directories = new Map<
    string,
    { dev: number; ino: number }
  >();
  constructor(private readonly home: string) {
    if (!absolute(home)) throw invalid();
    this.root = path.join(home, ".goga/desktop");
    this.file = path.join(this.root, "context-runs.json");
    this.lock = path.join(this.root, ".context-runs.lock");
  }
  private async directory(
    target: string,
    create: boolean,
    privateDirectory: boolean,
  ) {
    await noSymlinks(target);
    if (create)
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    const handle = await open(
      target,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat(),
        old = this.directories.get(target);
      if (
        !info.isDirectory() ||
        (process.getuid && info.uid !== process.getuid()) ||
        (old && (info.ino !== old.ino || info.dev !== old.dev))
      )
        throw invalid();
      this.directories.set(target, { dev: info.dev, ino: info.ino });
      if (privateDirectory) await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  private async assertRoot() {
    await this.directory(this.home, false, false);
    await this.directory(path.join(this.home, ".goga"), true, false);
    await this.directory(this.root, true, true);
  }
  private async locked<T>(action: () => Promise<T>): Promise<T> {
    const previous = tails.get(this.lock) ?? Promise.resolve();
    const work = previous.then(async () => {
      await this.assertRoot();
      const lock = await acquireOwnedLock(this.lock);
      try {
        await this.assertRoot();
        return await action();
      } finally {
        await lock.release();
      }
    });
    const tail = work.then(
      () => {},
      () => {},
    );
    tails.set(this.lock, tail);
    return work.finally(() => {
      if (tails.get(this.lock) === tail) tails.delete(this.lock);
    });
  }
  private async readText(): Promise<string | undefined> {
    await noSymlinks(this.file);
    let handle;
    try {
      handle = await open(
        this.file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.known && this.knownRaw !== undefined) throw invalid();
        return undefined;
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > MAX_BYTES ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw invalid();
      const raw = await handle.readFile("utf8");
      if (Buffer.byteLength(raw) > MAX_BYTES) throw invalid();
      return raw;
    } finally {
      await handle.close();
    }
  }
  private parse(raw: string | undefined): Document {
    if (raw === undefined)
      return {
        schemaVersion: 1,
        revision: randomUUID(),
        runs: [],
        bindings: [],
      };
    try {
      const value = documentSchema.parse(JSON.parse(raw));
      validateRuns(value.runs);
      const bindings = new Map<string, string>();
      for (const binding of value.bindings) {
        if (bindings.has(binding.id)) throw invalid();
        bindings.set(binding.id, binding.hash);
      }
      for (const run of value.runs)
        if (bindings.get(run.id) !== identity(run)) throw invalid();
      return value;
    } catch {
      throw invalid();
    }
  }
  private async install(value: Document, expected: string | undefined) {
    const raw = JSON.stringify(value, null, 2) + "\n";
    if (Buffer.byteLength(raw) > MAX_BYTES) throw invalid();
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(
        temp,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(raw);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.assertRoot();
      if ((await this.readText()) !== expected) throw conflict();
      await noSymlinks(this.file);
      if (expected === undefined) {
        try {
          await link(temp, this.file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST")
            throw conflict();
          throw error;
        }
      } else await rename(temp, this.file);
      // Remove the temporary hardlink before another read checks nlink == 1.
      await unlink(temp).catch(() => {});
      const directory = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.known = true;
      this.knownRaw = raw;
    } finally {
      await unlink(temp).catch(() => {});
    }
  }
  load(): Promise<Run[]> {
    return this.locked(async () => {
      const raw = await this.readText(),
        value = this.parse(raw);
      this.known = true;
      this.knownRaw = raw;
      return value.runs.map((run) =>
        run.status === "starting" || run.status === "running"
          ? { ...run, recovery: "unverified" as const }
          : run,
      );
    });
  }
  async save(input: Run[]): Promise<void> {
    // Capture nested values before awaiting any lock or filesystem work.
    let runs: Snapshot[];
    try {
      runs = z.array(runSchema).max(100000).parse(input);
    } catch {
      throw invalid();
    }
    validateRuns(runs);
    return this.locked(async () => {
      const raw = await this.readText();
      if (this.known && raw !== this.knownRaw) throw conflict();
      const value = this.parse(raw);
      const bindings = new Map(
        value.bindings.map((binding) => [binding.id, binding]),
      );
      for (const run of runs) {
        const hash = identity(run),
          old = bindings.get(run.id);
        if (old && old.hash !== hash) throw ownerChanged();
        const processHash = run.process
          ? createHash("sha256")
              .update(JSON.stringify(run.process))
              .digest("hex")
          : undefined;
        if (old?.processHash && old.processHash !== processHash)
          throw ownerChanged();
        if (old?.terminal && run.status !== old.terminal)
          throw Error(
            "Завершённое состояние запуска изменено; устаревшая запись запрещена.",
          );
        const terminal =
          run.status === "exited" ||
          run.status === "failed" ||
          run.status === "stopped"
            ? run.status
            : undefined;
        bindings.set(run.id, {
          id: run.id,
          hash,
          ...(processHash ? { processHash } : {}),
          ...(terminal ? { terminal } : {}),
        });
      }
      await this.install(
        {
          schemaVersion: 1,
          revision: randomUUID(),
          runs,
          bindings: [...bindings.values()],
        },
        raw,
      );
    });
  }
}
