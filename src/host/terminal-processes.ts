import { TerminalInspectorError } from "./terminal-errors";
import { z } from "zod";
/** Identity comes from the host OS inspector, never shell titles or renderer input. */
export interface TerminalProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  uid: number;
  tty: number;
  status: number;
  startSec: number;
  startUsec: number;
}
export interface TerminalProcessSnapshot {
  ok: boolean;
  stable: boolean;
  uncertain: number;
  root: TerminalProcessIdentity;
  members: TerminalProcessIdentity[];
}
export interface TerminalProcessPlan {
  anchor: TerminalProcessIdentity;
  jobs: TerminalProcessIdentity[];
}
export type TerminalSignal = "SIGTERM" | "SIGHUP";
export interface TerminalSignalAction {
  pid: number;
  signal: TerminalSignal;
}
export interface TerminalProcessAdapter {
  read(): unknown;
  signal(pid: number, signal: TerminalSignal): void;
  exited(): boolean;
  /** Monotonic milliseconds; wall-clock changes must not extend the deadline. */
  now(): number;
  sleep(ms: number): Promise<void>;
}
export interface TerminalProcessControl {
  prepare(): TerminalProcessPlan;
  validate(plan: TerminalProcessPlan): void;
  /** Called only after the checked SIGHUP, never before job termination. */
  stop(plan: TerminalProcessPlan, afterHangup?: () => void): Promise<void>;
}
const messages: Record<string, string> = {
  uncertain:
    "Принадлежность процессов терминалу не подтверждена. Сигналы не отправлены неопределённым процессам.",
  stopped:
    "В терминале есть приостановленный процесс. Автоматическое продолжение и принудительное завершение запрещены.",
  stale: "Состав процессов изменился. Требуется новое подтверждение.",
  timeout:
    "Процессы терминала не завершились за 5 секунд. Принудительное завершение не выполнялось.",
  signal: "Не удалось подтвердить отправку сигнала процессу терминала.",
};
export class TerminalStopError extends Error {
  constructor(
    public readonly code: string,
    public readonly actions: readonly TerminalSignalAction[] = [],
  ) {
    super(messages[code] ?? "Остановка терминала не подтверждена.");
  }
}
const positive = z.number().int().min(2).max(2147483647);
const identitySchema = z
  .object({
    pid: positive,
    ppid: z.number().int().min(0).max(2147483647),
    pgid: positive,
    sid: positive,
    uid: z.number().int().min(0).max(4294967295),
    tty: z.number().int().min(0).max(4294967294),
    status: z.number().int().min(1).max(5),
    startSec: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startUsec: z.number().int().min(0).max(999999),
  })
  .strict();
const snapshotSchema = z
  .object({
    ok: z.literal(true),
    stable: z.literal(true),
    uncertain: z.number().int().min(0),
    root: identitySchema,
    members: z.array(identitySchema).min(1).max(65536),
  })
  .strict();
const planSchema = z
  .object({ anchor: identitySchema, jobs: z.array(identitySchema).max(65535) })
  .strict();
const same = (a: TerminalProcessIdentity, b: TerminalProcessIdentity) =>
  (
    ["pid", "pgid", "sid", "uid", "tty", "startSec", "startUsec"] as const
  ).every((k) => a[k] === b[k]);
/** Synchronous snapshots immediately precede each individual PID signal. This is not an OS-atomic killtree. */
export class TerminalProcessController implements TerminalProcessControl {
  private anchor: TerminalProcessIdentity;
  constructor(
    anchor: TerminalProcessIdentity,
    private adapter: TerminalProcessAdapter,
  ) {
    const parsed = identitySchema.safeParse(anchor);
    if (!parsed.success || parsed.data.pid !== parsed.data.sid)
      throw new TerminalStopError("uncertain");
    this.anchor = parsed.data;
  }
  private read(allowUncertain = false) {
    let raw: unknown;
    try {
      raw = this.adapter.read();
    } catch (error) {
      if (error instanceof TerminalInspectorError) throw error;
      throw new TerminalStopError("uncertain");
    }
    const parsed = snapshotSchema.safeParse(raw);
    if (!parsed.success) throw new TerminalStopError("uncertain");
    const s = parsed.data;
    if (
      !same(s.root, this.anchor) ||
      new Set(s.members.map((p) => p.pid)).size !== s.members.length ||
      !s.members.some((p) => same(p, this.anchor)) ||
      s.members.some(
        (p) =>
          p.uid !== this.anchor.uid ||
          p.sid !== this.anchor.sid ||
          p.tty !== this.anchor.tty,
      )
    )
      throw new TerminalStopError("uncertain");
    if (s.root.status === 4 || s.members.some((p) => p.status === 4))
      throw new TerminalStopError("stopped");
    if (s.root.status === 5) throw new TerminalStopError("uncertain");
    if (s.uncertain && !allowUncertain)
      throw new TerminalStopError("uncertain");
    return {
      jobs: s.members.filter(
        (p) => p.pid !== this.anchor.pid && p.status !== 5,
      ),
      uncertain: s.uncertain,
    };
  }
  prepare(): TerminalProcessPlan {
    return { anchor: { ...this.anchor }, jobs: this.read().jobs };
  }
  private current(plan: TerminalProcessPlan, allowUncertain = false) {
    const parsed = planSchema.safeParse(plan);
    if (!parsed.success || !same(parsed.data.anchor, this.anchor))
      throw new TerminalStopError("stale");
    const current = this.read(allowUncertain);
    if (current.jobs.some((p) => !parsed.data.jobs.some((j) => same(j, p))))
      throw new TerminalStopError("stale");
    return current;
  }
  validate(plan: TerminalProcessPlan): void {
    this.current(plan);
  }
  async stop(
    input: TerminalProcessPlan,
    afterHangup?: () => void,
  ): Promise<void> {
    const actions: TerminalSignalAction[] = [];
    const deadline = this.adapter.now() + 5000;
    const timeRemaining = () => Math.max(0, deadline - this.adapter.now());
    const ensureTime = () => {
      if (!timeRemaining()) throw new TerminalStopError("timeout");
    };
    const send = (pid: number, signal: TerminalSignal) => {
      ensureTime();
      try {
        this.adapter.signal(pid, signal);
      } catch {
        throw new TerminalStopError("signal");
      }
      actions.push({ pid, signal });
    };
    try {
      const plan = structuredClone(input);
      const jobs = this.current(plan).jobs;
      for (const job of jobs) {
        const current = this.current(plan);
        if (current.jobs.some((p) => same(p, job))) send(job.pid, "SIGTERM");
      }
      while (true) {
        const current = this.current(plan, actions.length > 0);
        if (!current.uncertain && !current.jobs.length) break;
        ensureTime();
        await this.adapter.sleep(Math.min(30, timeRemaining()));
      }
      // One final inventory immediately before HUP: new work is never silently included.
      if (this.current(plan).jobs.length) throw new TerminalStopError("stale");
      send(this.anchor.pid, "SIGHUP");
      afterHangup?.();
      while (!this.adapter.exited()) {
        ensureTime();
        await this.adapter.sleep(Math.min(30, timeRemaining()));
      }
    } catch (error) {
      throw new TerminalStopError(
        error instanceof TerminalStopError ? error.code : "uncertain",
        actions,
      );
    }
  }
}
