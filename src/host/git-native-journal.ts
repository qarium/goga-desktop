import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { gitFilePathSchema } from "../shared/git-workspace";
import type {
  NativeGitOperation,
  NativeGitOperationResult,
} from "../shared/git-native-operation";
import { ByteCommandError, type ByteCommandResult } from "./process";
import { acquireOwnedLock } from "./owned-lock";
import { atomicWrite, noSymlinks } from "./settings";
import {
  assertNativeGitState,
  assertNoNativeGitLocks,
  nativeGitOwnerKey,
  nativeGitRepositoryKey,
  nativeGitPhysicalIdentity,
  validateNativeGitState,
  type NativeGitState,
  type NativeGitOwner,
} from "./git-native-state";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const operationSchema = z.enum([
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "commit",
  "discard",
  "resolve",
  "branch",
  "switch",
  "fetch",
  "pull",
]);
const resultSchema = z
  .object({
    operationId: z.string().uuid(),
    outcome: z.enum([
      "completed",
      "conflicts",
      "stopped",
      "rejected",
      "uncertain",
    ]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    beforeHead: z.string().nullable(),
    afterHead: z.string().nullable(),
    conflicts: z.array(z.string()).max(4096),
    verifiedUnrelatedData: z.boolean(),
    processSettled: z.boolean(),
    recovery: z.enum(["retained", "removed", "unknown"]),
    recoveryPath: z.string().optional(),
  })
  .strict()
  .nullable();
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    operation: operationSchema,
    intentFingerprint: hash,
    intentDetails: z.string().max(65536).optional(),
    attemptFingerprint: hash,
    repositoryKey: hash,
    ownerKey: hash,
    baselineRevision: hash,
    state: z.enum([
      "prepared",
      "running",
      "conflicts",
      "stopped",
      "completed",
      "rejected",
      "uncertain",
    ]),
    controlFingerprint: hash,
    recovery: z.unknown(),
    checkpoint: z.unknown(),
    attemptRecovery: z.unknown(),
    result: resultSchema,
    // Original stopped outcome survives an uncertain child resolution.
    resolutionParentResult: resultSchema.optional(),
    resolvedModes: z
      .array(
        z
          .object({
            path: gitFilePathSchema,
            mode: z.number().int().min(0).max(0o777),
          })
          .strict(),
      )
      .max(4096)
      .optional(),
  })
  .strict();
type RecordValue = Omit<
  z.infer<typeof recordSchema>,
  "recovery" | "checkpoint" | "attemptRecovery"
> & {
  recovery: NativeGitState | null;
  checkpoint: NativeGitState | null;
  attemptRecovery: NativeGitState | null;
};
type Binding = Pick<
  NativeGitState,
  "root" | "physicalRoot" | "physicalGit" | "owner"
>;
export interface NativeGitVerification {
  outcome: "completed" | "conflicts" | "stopped" | "rejected";
  afterHead: string | null;
  conflicts: string[];
  verifiedUnrelatedData: boolean;
}
interface Options {
  directory: string;
  now?: () => number;
}
const blocked = () =>
  Error(
    "Журнал Git требует проверки: операция не завершена или её владелец изменился. Автоматическое повторение запрещено.",
  );
/** Only host preflight code may issue this after every started probe has settled.
 * It never stands for a failed/unknown worktree-mutating Git command. */
export class NativeGitPreflightRejection extends Error {}
const MAX_RECORD = 144 * 1024 * 1024;
const TTL = 5 * 60 * 1000;

/** Host-only journal/confirmation primitive. Not an IPC or Git admission API.
 * The caller must hold the existing project/clone mutation guard for execute.
 * One repo-wide lease covers ALL owners and kinds (not one lock per branch).
 * Recovery is user data only: it is never installed as Git control metadata. */
export class NativeGitJournal {
  private readonly tokens = new Map<
    string,
    {
      operation: NativeGitOperation;
      intentFingerprint: string;
      intentDetails?: string;
      snapshot: NativeGitState;
      expires: number;
      followupRecord?: string;
      resolutionRecord?: string;
      resolutionPath?: string;
      resolutionAllowsModeChange?: boolean;
    }
  >();
  constructor(private readonly options: Options) {
    if (
      !path.isAbsolute(options.directory) ||
      path.resolve(options.directory) !== options.directory ||
      options.directory.includes("\0")
    )
      throw blocked();
  }
  private now() {
    return (this.options.now ?? (() => performance.now()))();
  }
  recordPath(snapshot: Pick<Binding, "root" | "physicalRoot" | "physicalGit">) {
    return path.join(
      this.options.directory,
      nativeGitRepositoryKey(snapshot) + ".json",
    );
  }
  private async assertNoPending(snapshot: Binding) {
    const file = this.recordPath(snapshot) + ".pending";
    await noSymlinks(file);
    const pending = await fs.lstat(file).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    // A dead PID proves neither completion nor the survival of the main record.
    // This durable fence is never reclaimed automatically, even after restart.
    if (pending) throw blocked();
  }
  prepare(
    operation: NativeGitOperation,
    snapshot: NativeGitState,
    intentFingerprint: string,
    intentDetails?: string,
  ) {
    if (
      intentDetails !== undefined &&
      (Buffer.byteLength(intentDetails) > 65536 ||
        digest(intentDetails) !== intentFingerprint)
    )
      throw blocked();
    hash.parse(intentFingerprint);
    operationSchema.parse(operation);
    const validated = validateNativeGitState(snapshot); // detached copy, not caller-owned mutable data
    const now = this.now();
    for (const [token, item] of this.tokens)
      if (now >= item.expires) this.tokens.delete(token);
    if (this.tokens.size >= 64) throw blocked();
    const token = randomUUID();
    this.tokens.set(token, {
      operation,
      intentFingerprint,
      ...(intentDetails === undefined ? {} : { intentDetails }),
      snapshot: validated,
      expires: now + TTL,
    });
    return token;
  }
  /** Explicit host-authorized followup, never adoption of a foreign operation.
   * This checks provenance only. The operation handler must ALSO prove which
   * index/worktree changes are permitted conflict resolutions before calling it. */
  async prepareFollowup(
    operation: NativeGitOperation,
    snapshot: NativeGitState,
    intentFingerprint: string,
  ) {
    validateNativeGitState(snapshot);
    await this.storage(snapshot, false);
    await this.assertNoPending(snapshot);
    const found = await this.read(snapshot);
    this.assertFollowup(found?.value, operation, snapshot);
    const token = this.prepare(operation, snapshot, intentFingerprint);
    this.tokens.get(token)!.followupRecord = digest(found!.raw);
    return token;
  }
  /** A file resolution is a child of the stopped operation, not its continuation.
   * Preserve its original intent/checkpoint/conflict set. External resolutions
   * receive only a resolve receipt and cannot acquire merge/rebase provenance. */
  async prepareResolution(
    snapshot: NativeGitState,
    intentFingerprint: string,
    resolutionPath: string,
    allowModeChange = false,
  ) {
    validateNativeGitState(snapshot);
    gitFilePathSchema.parse(resolutionPath);
    if (!snapshot.files.some((f) => f.path === resolutionPath)) throw blocked();
    let found: Awaited<ReturnType<NativeGitJournal["read"]>> = null;
    try {
      await this.storage(snapshot, false);
      await this.assertNoPending(snapshot);
      found = await this.read(snapshot, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (found && !["completed", "rejected"].includes(found.value.state))
      this.assertResolution(found.value, snapshot);
    else if (found?.value.recovery) throw blocked();
    if (
      found &&
      ["conflicts", "stopped"].includes(found.value.state) &&
      !found.value.result?.conflicts.includes(resolutionPath)
    )
      throw blocked();
    const token = this.prepare("resolve", snapshot, intentFingerprint);
    this.tokens.get(token)!.resolutionPath = resolutionPath;
    this.tokens.get(token)!.resolutionAllowsModeChange = allowModeChange;
    if (found && ["conflicts", "stopped"].includes(found.value.state))
      this.tokens.get(token)!.resolutionRecord = digest(found.raw);
    return token;
  }
  private assertResolution(record: RecordValue, snapshot: NativeGitState) {
    if (
      !["conflicts", "stopped"].includes(record.state) ||
      !record.recovery ||
      !record.checkpoint ||
      !record.result ||
      !["conflicts", "stopped"].includes(record.result.outcome) ||
      !record.result.processSettled ||
      !record.result.verifiedUnrelatedData ||
      record.resolutionParentResult ||
      record.controlFingerprint !== snapshot.controlFingerprint ||
      record.checkpoint.head !== snapshot.head ||
      record.checkpoint.headRef !== snapshot.headRef ||
      record.checkpoint.refs !== snapshot.refs ||
      nativeGitOwnerKey(record.recovery) !== nativeGitOwnerKey(snapshot)
    )
      throw blocked();
  }
  private assertFollowup(
    record: RecordValue | undefined,
    operation: NativeGitOperation,
    snapshot: NativeGitState,
  ) {
    if (
      !record ||
      !["conflicts", "stopped"].includes(record.state) ||
      record.operation !== operation ||
      !record.recovery ||
      !record.checkpoint ||
      !record.result ||
      !["conflicts", "stopped"].includes(record.result.outcome) ||
      !record.result.processSettled ||
      !record.result.verifiedUnrelatedData ||
      record.controlFingerprint !== snapshot.controlFingerprint ||
      record.recovery.policyFingerprint !== snapshot.policyFingerprint ||
      nativeGitOwnerKey(record.recovery) !== nativeGitOwnerKey(snapshot)
    )
      throw blocked();
  }
  private async storage(snapshot: Binding, create: boolean) {
    const directory = this.options.directory;
    if (
      directory === snapshot.root ||
      directory.startsWith(snapshot.root + path.sep)
    )
      throw blocked();
    await noSymlinks(directory);
    if (create) {
      // fsync(record) + fsync(directory) cannot make a NEW directory entry
      // durable in its parent. Persist every newly created ancestor as well.
      const missing: string[] = [];
      let cursor = directory;
      for (;;) {
        try {
          await fs.lstat(cursor);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missing.push(cursor);
          const parent = path.dirname(cursor);
          if (parent === cursor || missing.length > 64) throw blocked();
          cursor = parent;
        }
      }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      for (const p of new Set(missing.flatMap((p) => [p, path.dirname(p)]))) {
        await noSymlinks(p);
        const handle = await fs.open(
          p,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          if (!(await handle.stat()).isDirectory()) throw blocked();
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    const s = await fs.lstat(directory, { bigint: true });
    if (
      !s.isDirectory() ||
      (s.mode & 0o077n) !== 0n ||
      (process.getuid && s.uid !== BigInt(process.getuid()))
    )
      throw blocked();
    return [s.dev, s.ino, s.mode].join(":");
  }
  private parse(raw: string): RecordValue {
    const r = recordSchema.parse(JSON.parse(raw));
    if (
      r.intentDetails !== undefined &&
      (Buffer.byteLength(r.intentDetails) > 65536 ||
        digest(r.intentDetails) !== r.intentFingerprint)
    )
      throw blocked();
    const recovery =
      r.recovery === null ? null : validateNativeGitState(r.recovery);
    if (
      recovery &&
      (nativeGitRepositoryKey(recovery) !== r.repositoryKey ||
        nativeGitOwnerKey(recovery) !== r.ownerKey ||
        recovery.revision !== r.baselineRevision)
    )
      throw blocked();
    if (!recovery && !["completed", "rejected"].includes(r.state))
      throw blocked();
    if (r.result && r.result.operationId !== r.id) throw blocked();
    if (
      r.state === "completed" &&
      (!r.result ||
        r.result.outcome !== "completed" ||
        !r.result.processSettled ||
        !r.result.verifiedUnrelatedData ||
        r.result.exitCode !== 0 ||
        r.result.signal !== null ||
        r.result.conflicts.length)
    )
      throw blocked();
    if (
      r.state === "rejected" &&
      (!r.result ||
        r.result.outcome !== "rejected" ||
        !r.result.processSettled ||
        !r.result.verifiedUnrelatedData ||
        r.result.signal !== null ||
        r.result.conflicts.length)
    )
      throw blocked();
    const checkpoint =
      r.checkpoint === null ? null : validateNativeGitState(r.checkpoint);
    const attemptRecovery =
      r.attemptRecovery === null
        ? null
        : validateNativeGitState(r.attemptRecovery);
    for (const state of [checkpoint, attemptRecovery]) {
      if (
        state &&
        (nativeGitRepositoryKey(state) !== r.repositoryKey ||
          nativeGitOwnerKey(state) !== r.ownerKey)
      )
        throw blocked();
    }
    if (
      ["conflicts", "stopped"].includes(r.state) &&
      (!checkpoint || checkpoint.controlFingerprint !== r.controlFingerprint)
    )
      throw blocked();
    return { ...r, recovery, checkpoint, attemptRecovery };
  }
  private async read(
    snapshot: Binding,
    allowCompletedOwner = false,
  ): Promise<{ value: RecordValue; raw: string; identity: string } | null> {
    const filename = this.recordPath(snapshot);
    await noSymlinks(filename);
    let handle;
    try {
      handle = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(MAX_RECORD) ||
        (before.mode & 0o077n) !== 0n ||
        (process.getuid && before.uid !== BigInt(process.getuid()))
      )
        throw blocked();
      const buffer = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          offset,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      await noSymlinks(filename);
      const visible = await fs.lstat(filename, { bigint: true });
      const identity = (s: typeof before) =>
        [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(":");
      if (
        offset !== Number(before.size) ||
        identity(before) !== identity(after) ||
        identity(before) !== identity(visible)
      )
        throw blocked();
      const raw = buffer.subarray(0, offset).toString("utf8");
      const value = this.parse(raw);
      if (
        value.repositoryKey !== nativeGitRepositoryKey(snapshot) ||
        (value.ownerKey !== nativeGitOwnerKey(snapshot) &&
          !(
            allowCompletedOwner &&
            ["completed", "rejected"].includes(value.state) &&
            value.recovery === null
          ))
      )
        throw blocked();
      return { value, raw, identity: identity(before) };
    } finally {
      await handle.close();
    }
  }
  private async write(
    snapshot: NativeGitState,
    value: RecordValue,
    expected: Awaited<ReturnType<NativeGitJournal["read"]>>,
    directoryIdentity: string,
  ) {
    if ((await this.storage(snapshot, false)) !== directoryIdentity)
      throw blocked();
    const actual = await this.read(snapshot, true);
    if (
      actual?.identity !== expected?.identity ||
      actual?.raw !== expected?.raw
    )
      throw blocked();
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw) > MAX_RECORD) throw blocked();
    this.parse(raw);
    await atomicWrite(this.recordPath(snapshot), raw);
    if ((await this.storage(snapshot, false)) !== directoryIdentity)
      throw blocked();
    const parent = await fs.open(
      this.options.directory,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const written = await this.read(snapshot);
    if (!written || digest(written.raw) !== digest(raw)) throw blocked();
    return written;
  }
  /** Host-wide admission for mutation handlers not yet migrated. No Git command
   * or synthetic status is needed to refuse a known uncertain writer. A pending
   * conflict is not permission to continue it: that requires the sealed receipt. */
  async assertAdmission(root: string, owner: NativeGitOwner) {
    const binding = { root, owner, ...(await nativeGitPhysicalIdentity(root)) };
    try {
      await this.storage(binding, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await this.assertNoPending(binding);
    const found = await this.read(binding, true);
    if (
      found &&
      (["prepared", "running", "uncertain"].includes(found.value.state) ||
        (["completed", "rejected"].includes(found.value.state) &&
          found.value.recovery !== null))
    )
      throw blocked();
  }
  /** Read-only restart inspection: running is uncertain, never replayed.
   * A fresh physical owner/admission snapshot is required, not a branch label. */
  async inspect(snapshot: NativeGitState, allowCompletedOwner = false) {
    validateNativeGitState(snapshot);
    const physical = await nativeGitPhysicalIdentity(snapshot.root);
    if (
      physical.physicalRoot !== snapshot.physicalRoot ||
      physical.physicalGit !== snapshot.physicalGit
    )
      throw blocked();
    try {
      await this.storage(snapshot, false);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    const found = await this.read(snapshot, allowCompletedOwner);
    if (!found) {
      await this.assertNoPending(snapshot);
      return null;
    }
    return {
      ...found.value,
      state:
        found.value.state === "running"
          ? ("uncertain" as const)
          : found.value.state,
      stateMatches: found.value.baselineRevision === snapshot.revision,
      controlMatches:
        found.value.controlFingerprint === snapshot.controlFingerprint,
    };
  }
  async execute(options: {
    token: string;
    operation: NativeGitOperation;
    intentFingerprint: string;
    capture(): Promise<NativeGitState>;
    run(confirmed: NativeGitState): Promise<ByteCommandResult>;
    /** Journalled native inspection (e.g. public edit-todo) before the first seal.
     * A failed inspection retains the real primary command facts and recovery. */
    afterSettled?(command: ByteCommandResult): Promise<void>;
    /** Keep the durable fence and recovery until the outer host context releases
     * its leases. Failure before finalization stays blocked across restart. */
    deferRecoveryCleanup?(
      finish: () => Promise<NativeGitOperationResult>,
      result: NativeGitOperationResult,
    ): void;
    verify(
      before: NativeGitState,
      after: NativeGitState,
      command: ByteCommandResult,
    ): Promise<NativeGitVerification>;
  }): Promise<NativeGitOperationResult> {
    const pending = this.tokens.get(options.token);
    this.tokens.delete(options.token); // one use, including failed revalidation
    if (
      !pending ||
      pending.operation !== options.operation ||
      pending.intentFingerprint !== options.intentFingerprint ||
      this.now() >= pending.expires
    )
      throw blocked();
    const snapshot = pending.snapshot;
    assertNativeGitState(snapshot, await options.capture());
    const directoryIdentity = await this.storage(snapshot, true);
    await this.assertNoPending(snapshot);
    const lease = await acquireOwnedLock(this.recordPath(snapshot) + ".lock", {
      attempts: 1,
    });
    let released = false;
    const release = async () => {
      if (released) return;
      released = true; // Never retry an uncertain release or remove a foreign replacement.
      await lease.release();
      const remaining = await fs
        .lstat(this.recordPath(snapshot) + ".lock")
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (remaining) throw blocked();
    };
    try {
      let current = await this.read(snapshot, true);
      if (pending.resolutionRecord) {
        if (!current || digest(current.raw) !== pending.resolutionRecord)
          throw blocked();
        this.assertResolution(current.value, snapshot);
      } else if (pending.followupRecord) {
        this.assertFollowup(current?.value, pending.operation, snapshot);
        if (!current || digest(current.raw) !== pending.followupRecord)
          throw blocked();
      } else if (
        current &&
        (!["completed", "rejected"].includes(current.value.state) ||
          current.value.recovery !== null)
      )
        throw blocked();
      assertNativeGitState(snapshot, await options.capture());
      await assertNoNativeGitLocks(snapshot.root);
      if (this.now() >= pending.expires) throw blocked();
      const resolutionParent = pending.resolutionRecord
        ? current!.value
        : undefined;
      let record: RecordValue =
        pending.followupRecord || resolutionParent
          ? {
              ...current!.value,
              state: "prepared",
              result: null,
              attemptRecovery: snapshot,
              attemptFingerprint: pending.intentFingerprint,
              ...(resolutionParent
                ? { resolutionParentResult: resolutionParent.result }
                : { resolvedModes: undefined }),
            }
          : {
              schemaVersion: 1,
              id: randomUUID(),
              operation: pending.operation,
              intentFingerprint: pending.intentFingerprint,
              ...(pending.intentDetails === undefined
                ? {}
                : { intentDetails: pending.intentDetails }),
              attemptFingerprint: pending.intentFingerprint,
              repositoryKey: nativeGitRepositoryKey(snapshot),
              ownerKey: nativeGitOwnerKey(snapshot),
              baselineRevision: snapshot.revision,
              state: "prepared",
              controlFingerprint: snapshot.controlFingerprint,
              recovery: snapshot,
              checkpoint: null,
              attemptRecovery: null,
              result: null,
            };
      current = await this.write(snapshot, record, current, directoryIdentity);
      // Recovery is already durable. A crash here is NOT proof that Git ran.
      assertNativeGitState(snapshot, await options.capture());
      await assertNoNativeGitLocks(snapshot.root);
      if (this.now() >= pending.expires) throw blocked();
      // Separate atomic evidence that a native attempt may run. Losing the
      // main record must not look like a new repository after process restart.
      // Keep this fence on every uncertain/unobservable outcome; no PID-based
      // stale cleanup can grant fresh write authority.
      const fence = await acquireOwnedLock(
        this.recordPath(snapshot) + ".pending",
        {
          attempts: 1,
          reclaim: false,
        },
      );
      record = { ...record, state: "running" };
      current = await this.write(snapshot, record, current, directoryIdentity);
      const result: NativeGitOperationResult = {
        operationId: record.id,
        outcome: "uncertain",
        exitCode: null,
        signal: null,
        beforeHead: resolutionParent ? snapshot.head : record.recovery!.head,
        afterHead: null,
        conflicts: [],
        verifiedUnrelatedData: false,
        processSettled: false,
        recovery: "retained",
        recoveryPath: this.recordPath(snapshot),
      };
      let primaryReturned = false;
      let resolvedMode: number | null | undefined;
      try {
        const command = await options.run(snapshot); // exactly one attempt, only after durable running
        primaryReturned = true;
        result.exitCode = command.exitCode;
        result.signal = command.signal;
        result.processSettled = command.processSettled;
        if (command.processSettled) {
          await options.afterSettled?.(command);
          const after = await options.capture();
          if (
            nativeGitOwnerKey(after) !== nativeGitOwnerKey(snapshot) ||
            after.policyFingerprint !== snapshot.policyFingerprint
          )
            throw blocked();
          result.afterHead = after.head;
          const verified = await options.verify(snapshot, after, command);
          result.conflicts = [...verified.conflicts];
          result.verifiedUnrelatedData = verified.verifiedUnrelatedData;
          if (
            verified.afterHead !== after.head ||
            !verified.verifiedUnrelatedData
          )
            throw blocked();
          if (
            verified.outcome === "completed" &&
            (command.exitCode !== 0 ||
              command.signal !== null ||
              verified.conflicts.length)
          )
            throw blocked();
          if (
            verified.outcome === "conflicts" &&
            (command.exitCode !== 1 ||
              command.signal !== null ||
              !verified.conflicts.length)
          )
            throw blocked();
          if (
            verified.outcome === "stopped" &&
            (command.exitCode === null ||
              command.exitCode === 0 ||
              command.signal !== null ||
              after.head !== snapshot.head)
          )
            throw blocked();
          if (verified.outcome === "rejected") {
            // A failed command is not itself proof of rejection. In addition to
            // handler-specific effects, enforce unchanged owner/HEAD/index/refs
            // and protected bytes here. Native bookkeeping may have changed.
            if (
              command.exitCode === null ||
              command.exitCode === 0 ||
              command.signal !== null ||
              verified.conflicts.length ||
              after.head !== snapshot.head ||
              after.headRef !== snapshot.headRef ||
              after.index !== snapshot.index ||
              after.refs !== snapshot.refs ||
              JSON.stringify(after.files) !== JSON.stringify(snapshot.files)
            )
              throw blocked();
          }
          result.outcome = verified.outcome;
          if (resolutionParent && verified.outcome === "completed") {
            if (
              after.controlFingerprint !== snapshot.controlFingerprint ||
              after.head !== snapshot.head ||
              after.headRef !== snapshot.headRef ||
              after.refs !== snapshot.refs
            )
              throw blocked();
            resolvedMode = after.files.find(
              (f) => f.path === pending.resolutionPath,
            )?.mode;
            if (resolvedMode === undefined) throw blocked();
          }
          record.controlFingerprint = after.controlFingerprint;
          if (
            verified.outcome === "conflicts" ||
            verified.outcome === "stopped"
          )
            record.checkpoint = after;
        }
      } catch (error) {
        if (error instanceof ByteCommandError) {
          // Follow-up inspections have their own child processes. Their failure
          // cannot replace the native mutation's observed exit/signal, but an
          // unsettled inspector still prevents declaring the operation settled.
          if (!primaryReturned) {
            result.exitCode = error.exitCode;
            result.signal = error.signal;
          }
          result.processSettled =
            error.processSettled && (!primaryReturned || result.processSettled);
        }
        // A timeout/error is never retried, nor turned into successful rollback.
        result.outcome = "uncertain";
        if (error instanceof NativeGitPreflightRejection) {
          try {
            const after = await options.capture();
            assertNativeGitState(snapshot, after);
            Object.assign(result, {
              outcome: "rejected",
              afterHead: after.head,
              processSettled: true,
              verifiedUnrelatedData: true,
            });
          } catch {
            /* Changed or unobservable state stays uncertain with recovery. */
          }
        }
      }
      record = { ...record, state: result.outcome, result: { ...result } };
      try {
        current = await this.write(
          snapshot,
          record,
          current,
          directoryIdentity,
        );
      } catch {
        // The journal path may itself have lost its owner (for example an
        // ancestor was replaced). Attempt release once, without allowing a
        // second cleanup error to erase the native command's exit/signal facts.
        // Neither the record nor the retained lock is claimed safe to remove.
        try {
          await release();
        } catch {
          /* Unknown ownership stays uncertain; never retry or unlink blindly. */
        }
        return { ...result, outcome: "uncertain", recovery: "unknown" };
      }
      const finish = async (settled: NativeGitOperationResult) => {
        if (settled.outcome === "uncertain" || !settled.processSettled)
          return settled;
        try {
          await fence.release();
          await this.assertNoPending(snapshot);
          return settled;
        } catch {
          const failed = {
            ...result,
            outcome: "uncertain" as const,
            recovery: "unknown" as const,
          };
          // Keep/reinstate the original recovery when final fence cleanup fails.
          // Its removal is the very last successful side effect, after every
          // journal write, so losing a record earlier leaves the fence intact.
          try {
            current = await this.write(
              snapshot,
              { ...record, state: "uncertain", result: failed },
              current,
              directoryIdentity,
            );
          } catch {
            /* Unknown storage remains blocked by the retained fence. */
          }
          return failed;
        }
      };
      // A closed record WITH recovery blocks a second writer. Release our
      // lease before dropping that recovery; failed release must not erase it.
      try {
        await release();
      } catch {
        result.outcome = "uncertain";
        record = { ...record, state: "uncertain", result: { ...result } };
        try {
          await this.write(snapshot, record, current, directoryIdentity);
        } catch {
          return { ...result, recovery: "unknown" };
        }
        return result;
      }
      if (result.outcome === "completed" || result.outcome === "rejected") {
        // First persist verified completion WITH recovery. Only then atomically
        // drop our own payload. Failure never causes another Git execution.
        let finalized = false;
        const cleanup = async (): Promise<NativeGitOperationResult> => {
          if (finalized) throw blocked();
          finalized = true;
          const cleaned = {
            ...result,
            recovery: resolutionParent
              ? ("retained" as const)
              : ("removed" as const),
          };
          if (!resolutionParent) delete cleaned.recoveryPath;
          try {
            let restoredParent = resolutionParent;
            if (restoredParent && result.outcome === "completed") {
              const previousModes = restoredParent.resolvedModes ?? [];
              const checkpointMode = restoredParent.checkpoint!.files.find(
                (f) => f.path === pending.resolutionPath,
              )?.mode;
              const initialMode = snapshot.files.find(
                (f) => f.path === pending.resolutionPath,
              )?.mode;
              // Saving text must not adopt an earlier external chmod. Only an
              // explicit side choice, from unchanged/already-authorized rights,
              // can authorize the mode delta that this child actually made.
              const initialApproved =
                initialMode === checkpointMode ||
                previousModes.some(
                  (f) =>
                    f.path === pending.resolutionPath && f.mode === initialMode,
                );
              if (
                pending.resolutionAllowsModeChange &&
                initialApproved &&
                resolvedMode !== initialMode
              ) {
                const modes = previousModes.filter(
                  (f) => f.path !== pending.resolutionPath,
                );
                if (resolvedMode != null && resolvedMode !== checkpointMode)
                  modes.push({
                    path: pending.resolutionPath!,
                    mode: resolvedMode,
                  });
                restoredParent = { ...restoredParent, resolvedModes: modes };
              }
            }
            current = await this.write(
              snapshot,
              restoredParent ?? {
                ...record,
                recovery: null,
                checkpoint: null,
                attemptRecovery: null,
                result: cleaned,
              },
              current,
              directoryIdentity,
            );
            return await finish(cleaned);
          } catch {
            return { ...result, recovery: "unknown" };
          }
        };
        if (options.deferRecoveryCleanup) {
          options.deferRecoveryCleanup(cleanup, result);
          return result;
        }
        return await cleanup();
      }
      return await finish(result);
    } finally {
      // Unknown running process remains durably blocked by running/uncertain
      // journal, even after restart. All native writers must consult it.
      await release();
    }
  }
}
