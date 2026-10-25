import {
  TerminalStartupError,
  type TerminalStartupPhase,
} from "./terminal-errors";
import { z } from "zod";
import type { TerminalLaunch } from "./terminal-environment";
import type { TerminalPty } from "./terminal-sessions";
import {
  TerminalProcessController,
  TerminalStopError,
  type TerminalProcessControl,
  type TerminalProcessIdentity,
  type TerminalSignal,
} from "./terminal-processes";
import { TERMINAL_SOURCE_BYTES } from "../shared/terminal-screen";

type Subscription = { dispose(): void };
type Exit = { exitCode: number; signal?: number };
export interface NativeTerminal {
  readonly pid: number;
  write(text: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  onData(fn: (text: string) => void): Subscription;
  onExit(fn: (event: Exit) => void): Subscription;
  /** Verified legacy node-pty 1.1 error event; not exposed to the renderer. */
  on(event: "error", listener: (error: unknown) => void): unknown;
}
export interface NativeTerminalDriver {
  spawn(
    shell: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      encoding: "utf8";
      handleFlowControl: false;
      name: string;
    },
  ): NativeTerminal;
}
export interface TerminalInspector {
  prepare?(budgetMs?: number): Promise<void>;
  check?(): void;
  birth(pid: number, timeoutMs?: number): unknown;
  root(pid: number, timeoutMs?: number): unknown;
  snapshot(pid: number): unknown;
}
export interface TerminalNativeSystem {
  parentPid?: number;
  uid?: number;
  platform?: string;
  now?: () => number;
  waitSync?: (ms: number) => void;
  sleep?: (ms: number) => Promise<void>;
  signal?: (pid: number, signal: TerminalSignal) => void;
}
const pidSchema = z.number().int().min(2).max(2147483647);
const birthSchema = z
  .object({
    pid: pidSchema,
    ppid: pidSchema,
    uid: z.number().int().min(0).max(4294967295),
    startSec: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    startUsec: z.number().int().min(0).max(999999),
  })
  .strict();
type Birth = z.infer<typeof birthSchema>;
const rootSchema = birthSchema
  .extend({
    pgid: pidSchema,
    sid: pidSchema,
    tty: z.number().int().min(0).max(4294967295),
    status: z.number().int().min(1).max(5),
  })
  .strict();
const sameBirth = (a: Birth, b: Birth) =>
  (["pid", "ppid", "uid", "startSec", "startUsec"] as const).every(
    (k) => a[k] === b[k],
  );
const failure = () =>
  Error(
    "Системный адаптер терминала недоступен. Процесс сохранён до подтверждённого завершения.",
  );

/** No PID, environment or native kill method escapes the host-facing PTY wrapper.
 * Native dependency loading/packaging is supplied by main, never by renderer input. */
export class TerminalNativeAdapter {
  private owned = new WeakMap<TerminalPty, ManagedTerminal>();
  constructor(
    private driver: NativeTerminalDriver,
    private inspector: TerminalInspector,
    private system: TerminalNativeSystem = {},
  ) {}
  prepare = async (): Promise<void> => {
    try {
      if ((this.system.platform ?? process.platform) !== "darwin")
        throw Error();
      await this.inspector.prepare?.();
    } catch {
      throw new TerminalStartupError("native-preflight", false);
    }
  };
  spawn = (launch: TerminalLaunch): TerminalPty => {
    if ((this.system.platform ?? process.platform) !== "darwin")
      throw new TerminalStartupError("native-preflight", false);
    let native: NativeTerminal;
    let phase: TerminalStartupPhase = "native-preflight";
    try {
      this.inspector.check?.();
      phase = "native-spawn";
      native = this.driver.spawn(launch.shell, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        cols: 80,
        rows: 24,
        name: "xterm-256color",
        encoding: "utf8",
        handleFlowControl: false,
      });
    } catch {
      throw new TerminalStartupError(phase, false);
    }
    // Once a child exists, never throw it away if inspection/setup fails.
    const managed = new ManagedTerminal(native, this.inspector, this.system);
    this.owned.set(managed.api, managed);
    return managed.api;
  };
  processes = (pty: TerminalPty): TerminalProcessControl => {
    const managed = this.owned.get(pty);
    if (!managed) throw new TerminalStopError("uncertain");
    return managed.control;
  };
}
class ManagedTerminal {
  readonly api: TerminalPty;
  readonly control: TerminalProcessControl;
  private birth?: Birth;
  private controller?: TerminalProcessController;
  private poisoned = false;
  private failed = false;
  private startupPhase: TerminalStartupPhase = "native-attach";
  private paused = false;
  private draining = false;
  private pumping = false;
  private pending: string[] = [];
  private bytes = 0;
  private exit?: Exit;
  private exitDelivered = false;
  private data = new Set<(text: string) => void>();
  private exits = new Set<(event: Exit) => void>();
  private faults = new Set<() => void>();
  private subscriptions: Subscription[] = [];
  private now: () => number;
  private wait: (ms: number) => void;
  constructor(
    private native: NativeTerminal,
    private inspector: TerminalInspector,
    private system: TerminalNativeSystem,
  ) {
    this.now = system.now ?? (() => performance.now());
    this.wait =
      system.waitSync ??
      ((ms) => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      });
    this.api = {
      assertReady: () => {
        if (this.failed)
          throw new TerminalStartupError(this.startupPhase, true);
      },
      pause: () => this.pause(),
      resume: () => this.resume(),
      write: (text) => {
        if (this.failed || this.exit) throw failure();
        native.write(text);
      },
      resize: (cols, rows) => {
        if (this.failed || this.exit) throw failure();
        native.resize(cols, rows);
      },
      onData: (fn) => {
        this.data.add(fn);
        this.pump();
        return {
          dispose: () => {
            this.data.delete(fn);
          },
        };
      },
      onExit: (fn) => {
        this.exits.add(fn);
        if (this.exitDelivered)
          queueMicrotask(() => {
            if (this.exits.has(fn)) fn({ ...this.exit! });
          });
        return {
          dispose: () => {
            this.exits.delete(fn);
          },
        };
      },
      onFault: (fn) => {
        this.faults.add(fn);
        if (this.failed) fn();
        return {
          dispose: () => {
            this.faults.delete(fn);
          },
        };
      },
    };
    this.control = {
      prepare: () => this.getController().prepare(),
      validate: (plan) => this.getController().validate(plan),
      stop: async (plan, afterHangup) => {
        try {
          await this.getController().stop(plan, () => {
            // Startup/I/O failure may precede surface binding. The owned native
            // transport still has to observe EOF, but its unusable output is not replayed.
            if (this.failed && !this.exitDelivered) {
              this.draining = true;
              this.pending = [];
              this.bytes = 0;
              this.resume();
            }
            afterHangup?.();
          });
        } finally {
          if (this.draining) {
            this.draining = false;
            if (!this.exitDelivered) this.pause();
          }
        }
      },
    };
    try {
      this.subscriptions.push(
        native.onExit((event) => {
          if (this.exit) return;
          this.exit = { ...event };
          this.pump();
        }),
      );
      // Keep an error sink for the native object's entire lifetime: node-pty can
      // finish closing and emit an error in the same callback as the exit event.
      native.on("error", () => this.fault());
      this.subscriptions.push(native.onData((text) => this.receive(text)));
      this.startupPhase = "native-birth";
      const deadline = this.now() + 500;
      const remaining = () => Math.max(1, Math.ceil(deadline - this.now()));
      const birth = birthSchema.parse(inspector.birth(native.pid, remaining()));
      if (
        birth.pid !== native.pid ||
        birth.ppid !== (system.parentPid ?? process.pid) ||
        birth.uid !== (system.uid ?? process.getuid?.())
      )
        throw Error();
      this.birth = birth;
      this.startupPhase = "native-handshake";
      while (true) {
        if (this.now() >= deadline) throw Error();
        const captured = this.capture(remaining(), true);
        if (this.now() > deadline) throw Error();
        if (captured) break;
        this.wait(Math.min(5, deadline - this.now()));
      }
      this.startupPhase = "native-io";
    } catch {
      this.fault();
    }
  }
  private capture(timeoutMs?: number, starting = false): boolean {
    if (!this.birth || this.poisoned) throw new TerminalStopError("uncertain");
    const sample = this.inspector.root(this.birth.pid, timeoutMs);
    // A native TTY/session transition can make the double-read unstable.
    // Only startup may retry this explicit response, within its original deadline.
    if (
      starting &&
      sample &&
      typeof sample === "object" &&
      Object.keys(sample).length === 1 &&
      (sample as { ok?: unknown }).ok === false
    )
      return false;
    const result = rootSchema.safeParse(sample);
    if (!result.success) throw new TerminalStopError("uncertain");
    const root = result.data;
    if (!sameBirth(this.birth, root)) {
      this.poisoned = true;
      throw new TerminalStopError("uncertain");
    }
    if (
      root.tty === 4294967295 ||
      root.sid !== root.pid ||
      root.pgid !== root.pid
    )
      return false;
    if (root.status === 4 || root.status === 5)
      throw new TerminalStopError("uncertain");
    this.controller = new TerminalProcessController(
      root as TerminalProcessIdentity,
      {
        read: () => this.inspector.snapshot(this.birth!.pid),
        signal: (pid, signal) =>
          (this.system.signal ?? ((pid, signal) => process.kill(pid, signal)))(
            pid,
            signal,
          ),
        now: this.now,
        sleep:
          this.system.sleep ??
          ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        exited: () => this.exitDelivered,
      },
    );
    return true;
  }
  private getController() {
    if (!this.controller && !this.capture())
      throw new TerminalStopError("uncertain");
    return this.controller!;
  }
  private fault() {
    if (this.failed || this.exitDelivered) return;
    this.failed = true;
    this.pending = [];
    this.bytes = 0;
    try {
      this.pause();
    } catch {
      /* Keep the child and its exit listener even on native I/O failure. */
    }
    for (const fn of [...this.faults])
      try {
        fn();
      } catch {
        /* Ownership is independent of the subscriber. */
      }
  }
  private receive(text: string) {
    if (this.exit) return;
    if (this.draining) return;
    if (this.failed) return;
    // Node's UTF-8 decoder can append up to one split code point to a 64 KiB read.
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > TERMINAL_SOURCE_BYTES + 4
    ) {
      this.fault();
      return;
    }
    let part = "",
      bytes = 0;
    for (const char of text) {
      const length = Buffer.byteLength(char);
      if (bytes + length > TERMINAL_SOURCE_BYTES) {
        this.enqueue(part);
        part = "";
        bytes = 0;
      }
      part += char;
      bytes += length;
    }
    if (part) this.enqueue(part);
  }
  private enqueue(text: string) {
    if (this.failed || this.draining) return;
    const bytes = Buffer.byteLength(text);
    if (this.bytes + bytes > TERMINAL_SOURCE_BYTES) {
      this.fault();
      return;
    }
    this.pending.push(text);
    this.bytes += bytes;
    this.pump();
  }
  private pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (
        !this.paused &&
        !this.failed &&
        this.pending.length &&
        this.data.size
      ) {
        const text = this.pending.shift()!;
        this.bytes -= Buffer.byteLength(text);
        for (const fn of [...this.data]) {
          try {
            fn(text);
          } catch {
            this.fault();
            break;
          }
        }
      }
      if (
        this.exit &&
        !this.exitDelivered &&
        (this.draining || this.failed || !this.pending.length)
      ) {
        this.exitDelivered = true;
        for (const subscription of this.subscriptions.splice(0))
          subscription.dispose();
        for (const fn of [...this.exits])
          try {
            fn({ ...this.exit });
          } catch {
            /* Exit is already observed. */
          }
      }
    } finally {
      this.pumping = false;
    }
  }
  private pause() {
    if (this.exitDelivered) return;
    this.paused = true;
    this.native.pause();
  }
  private resume() {
    if (this.exitDelivered) return;
    this.paused = false;
    this.pump();
    if (!this.paused && !this.exitDelivered) this.native.resume();
  }
}
