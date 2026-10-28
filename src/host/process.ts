import { AsyncLocalStorage } from "node:async_hooks";
import { childEnvironment } from "./process-environment";
import { readSignal, assertReadActive, withReadScope } from "./read-scope";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { DashboardParser } from "./parsers";
// A prepared ref lock must outlive every command launched by its verifier,
// including commands on another runner. Cancellation also fences late awaits.
interface PreparedCommands {
  controller: AbortController;
  pending: Set<Promise<unknown>>;
  unsettled: boolean;
}
const preparedCommands = new AsyncLocalStorage<PreparedCommands>();
function trackPrepared<T>(promise: Promise<T>): Promise<T> {
  const scope = preparedCommands.getStore();
  if (!scope) return promise;
  const tracked = promise.then(
    (value) => {
      scope.pending.delete(tracked);
      return value;
    },
    (error) => {
      scope.pending.delete(tracked);
      if (error instanceof ByteCommandError && !error.processSettled)
        scope.unsettled = true;
      throw error;
    },
  );
  scope.pending.add(tracked);
  return tracked;
}
export interface ByteCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Buffer;
  maxOutputBytes?: number;
  /** Host-only update-ref --stdin prepare gate, never a generic stdin callback. */
  verifyPrepared?: (assertActive: () => void) => Promise<void>;
}
export interface ByteCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processSettled: true;
}
export type ByteCommandFailure =
  | "spawn"
  | "timeout"
  | "output-limit"
  | "aborted"
  | "shutdown"
  | "descendants"
  | "process-unsettled"
  | "protocol"
  | "verification";
/** Transport failure, never evidence that Git rolled back or made no writes. */
export class ByteCommandError extends Error {
  constructor(
    readonly reason: ByteCommandFailure,
    readonly processSettled: boolean,
    readonly stdout: Buffer,
    readonly stderr: Buffer,
    readonly exitCode: number | null = null,
    readonly signal: NodeJS.Signals | null = null,
  ) {
    super(
      `Не удалось завершить команду (${reason}). Результат операции требует проверки.`,
    );
    this.name = "ByteCommandError";
  }
}
export interface Runner {
  /** Host-only bounded binary transport; absence fails closed, no text fallback. */
  commandBytes?(command: ByteCommand): Promise<ByteCommandResult>;
  command(
    exe: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
    stdin?: string,
  ): Promise<{
    stdout: string;
    stderr: string;
  }>;
  /** Host-only two-phase ref publication; absence must fail closed. */
  gitRefTransaction?(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    prepareInput: string,
    verifyPrepared: (assertPreparedActive: () => void) => Promise<void>,
  ): Promise<{ stdout: string; stderr: string }>;
  start(
    exe: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ): ChildProcessWithoutNullStreams;
  kill(child: ChildProcessWithoutNullStreams): void | Promise<void>;
  dispose?(): Promise<void>;
}
/** Positive lifecycle cancellation, never evidence of a physical Git conflict. */
export class RunnerShutdownError extends Error {
  readonly code = "RUNNER_SHUTDOWN";
  constructor(readonly phase: "closing" | "interrupted") {
    super(
      phase === "closing"
        ? "Приложение завершает работу; команда не запущена."
        : "Команда прервана при завершении работы приложения.",
    );
    this.name = "RunnerShutdownError";
  }
}
/** Structured process outcome; public message stays sanitized and unchanged. */
export class CommandExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    /** Host-only diagnostics: sanitize before including in an operation result. */
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(message);
  }
}
/** A ref update is uncertain after commit was sent, even without an ACK. */
export class GitRefTransactionError extends Error {
  constructor(
    message: string,
    readonly commitSent: boolean,
    readonly stdout = "",
    readonly stderr = "",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitRefTransactionError";
  }
}
export class NodeRunner implements Runner {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private closing = false;
  private preparedStops = new Map<
    ChildProcessWithoutNullStreams,
    () => Promise<void>
  >();
  private disposal?: Promise<void>;
  private pendingCommands = new Map<
    ChildProcessWithoutNullStreams,
    () => void
  >();
  constructor(
    private timeoutMs = 120000,
    private env: NodeJS.ProcessEnv = {},
  ) {}
  start(
    exe: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = {},
    stdin?: string | Buffer,
    keepStdin = false,
  ) {
    if (this.closing) throw new RunnerShutdownError("closing");
    const child = spawn(exe, args, {
      cwd,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnvironment(process.env, this.env, { ...env, NO_COLOR: "1" }),
    });
    this.children.add(child);
    child.once("close", () => {
      if (!this.groupExists(child.pid)) this.children.delete(child);
    });
    child.stdin.on("error", () => {});
    if (keepStdin) {
      if (stdin) child.stdin.write(stdin);
    } else child.stdin.end(stdin);
    return child;
  }
  private groupExists(pid: number | undefined): boolean {
    if (!pid) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  async kill(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (!child.pid) return;
    const signal = (value: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH")
          throw new Error("Не удалось остановить группу процессов Goga");
      }
    };
    const waitGone = async (ms: number) => {
      const deadline = Date.now() + ms;
      while (this.groupExists(child.pid) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      return !this.groupExists(child.pid);
    };
    signal("SIGTERM");
    if (!(await waitGone(10000))) {
      signal("SIGKILL");
      if (!(await waitGone(2000)))
        throw new Error(
          "Группа процессов Goga ещё работает; повторите остановку.",
        );
    }
    this.children.delete(child);
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    const children = [...this.children];
    for (const child of children) this.pendingCommands.get(child)?.();
    const attempt = Promise.resolve().then(async () => {
      // A failed child must not reopen admissions while other stop attempts still run.
      const results = await Promise.allSettled(
        children.map(
          (child) => this.preparedStops.get(child)?.() ?? this.kill(child),
        ),
      );
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        this.closing = false;
        throw failure.reason;
      }
    });
    this.disposal = attempt;
    void attempt.then(
      () => {
        if (this.disposal === attempt) this.disposal = undefined;
      },
      () => {
        if (this.disposal === attempt) this.disposal = undefined;
      },
    );
    return attempt;
  }

  commandBytes(command: ByteCommand): Promise<ByteCommandResult> {
    return trackPrepared(this.runCommandBytes(command));
  }
  private async runCommandBytes(
    command: ByteCommand,
  ): Promise<ByteCommandResult> {
    assertReadActive();
    if (this.closing) throw new RunnerShutdownError("closing");
    const limit = command.maxOutputBytes ?? 8 * 1024 * 1024;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32 * 1024 * 1024 ||
      !command.executable ||
      command.executable.includes("\0") ||
      !command.args.every(
        (arg) => typeof arg === "string" && !arg.includes("\0"),
      )
    )
      throw Error("Недопустимые параметры команды.");
    const prepared = command.verifyPrepared;
    if (prepared) {
      const input =
        /^start\n(?:update HEAD ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64})|verify HEAD ([a-f0-9]{40}|[a-f0-9]{64}))\nprepare\n$/.exec(
          command.stdin?.toString("utf8") ?? "",
        );
      if (
        command.args.at(-1) !== "--stdin" ||
        !command.args.includes("update-ref") ||
        !input ||
        (input[1] && input[1].length !== input[2].length)
      )
        throw Error("Недопустимая подготовленная транзакция Git.");
    }
    const verificationScope: PreparedCommands = {
      controller: new AbortController(),
      pending: new Set(),
      unsettled: false,
    };
    const drainVerification = async () => {
      verificationScope.controller.abort();
      await Promise.allSettled([...verificationScope.pending]);
    };
    const signal = readSignal(),
      deadline = Date.now() + this.timeoutMs;
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [],
        err: Buffer[] = [];
      let size = 0,
        finishing = false,
        interrupted = false,
        verifying = false,
        commitSent = false,
        verificationFailed = false;
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.start(
          command.executable,
          [...command.args],
          command.cwd,
          command.env,
          command.stdin,
          !!prepared,
        );
      } catch (error) {
        reject(
          error instanceof RunnerShutdownError
            ? error
            : new ByteCommandError(
                "spawn",
                true,
                Buffer.alloc(0),
                Buffer.alloc(0),
              ),
        );
        return;
      }
      const detach = () => {
        this.pendingCommands.delete(child);
        this.preparedStops.delete(child);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      let failing: Promise<boolean> | undefined;
      const failure = (reason: ByteCommandFailure): Promise<boolean> => {
        if (failing) return failing;
        if (finishing) return Promise.resolve(!verificationScope.unsettled);
        finishing = true;
        failing = (async () => {
          await drainVerification();
          let settled = !verificationScope.unsettled;
          try {
            // Same managed group and shutdown protocol as all other host commands.
            await this.kill(child);
          } catch {
            reason = "process-unsettled";
            settled = false;
          }
          detach();
          reject(
            new ByteCommandError(
              reason,
              settled,
              Buffer.concat(out),
              Buffer.concat(err),
              child.exitCode,
              child.signalCode,
            ),
          );
          return settled;
        })();
        return failing;
      };
      if (prepared)
        this.preparedStops.set(child, async () => {
          if (!(await failure("shutdown")))
            throw Error(
              "Не удалось подтвердить остановку подготовленной транзакции.",
            );
        });
      const abort = () => {
        void failure("aborted");
      };
      const timer = setTimeout(() => {
        void failure("timeout");
      }, this.timeoutMs);
      this.pendingCommands.set(child, () => {
        if (
          !finishing &&
          child.pid &&
          child.signalCode === null &&
          (child.exitCode === null || child.exitCode === 0)
        )
          interrupted = true;
      });
      signal?.addEventListener("abort", abort, { once: true });
      const receive = (target: Buffer[], chunk: Buffer) => {
        if (finishing) return;
        size += chunk.length;
        if (size > limit) {
          void failure("output-limit");
          return;
        }
        target.push(Buffer.from(chunk));
      };
      const assertActive = () => {
        if (
          finishing ||
          interrupted ||
          signal?.aborted ||
          Date.now() >= deadline ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          throw Error("Подготовленная транзакция Git уже не активна.");
      };
      child.stdout.on("data", (chunk: Buffer) => {
        receive(out, chunk);
        if (!prepared || verifying || finishing) return;
        const reply = Buffer.concat(out).toString("utf8"),
          expected = "start: ok\nprepare: ok\n";
        if (!expected.startsWith(reply)) {
          void failure("protocol");
          return;
        }
        if (reply !== expected) return;
        verifying = true;
        void Promise.resolve()
          .then(() => {
            assertActive();
            return preparedCommands.run(verificationScope, () =>
              withReadScope(verificationScope.controller.signal, () =>
                prepared(assertActive),
              ),
            );
          })
          .then(
            () => {
              if (finishing) return;
              try {
                assertActive();
                if (
                  verificationScope.pending.size ||
                  verificationScope.unsettled
                )
                  throw Error("Проверка оставила незавершённые команды.");
                verificationScope.controller.abort();
                commitSent = true;
                child.stdin.end("commit\n");
              } catch {
                void failure("aborted");
              }
            },
            async (error) => {
              if (error instanceof ByteCommandError && !error.processSettled)
                verificationScope.unsettled = true;
              if (finishing) return;
              verificationFailed = true;
              await drainVerification();
              if (!finishing) child.stdin.end("abort\n");
            },
          );
      });
      child.stderr.on("data", (chunk: Buffer) => receive(err, chunk));
      child.once("error", () => {
        void failure("spawn");
      });
      child.once("close", (exitCode, exitSignal) => {
        if (finishing) return;
        if (interrupted) {
          void failure("shutdown");
          return;
        }
        // A zero exit is not completion if a descendant still owns the group.
        if (this.groupExists(child.pid)) {
          void failure("descendants");
          return;
        }
        // A ref process can disappear while its verifier still has children.
        if (prepared && verifying && !commitSent && !verificationFailed) {
          void failure("protocol");
          return;
        }
        if (verificationScope.pending.size) {
          void failure("verification");
          return;
        }
        verificationScope.controller.abort();
        finishing = true;
        detach();
        if (
          prepared &&
          (verificationFailed ||
            (exitCode === 0 &&
              (!commitSent ||
                Buffer.concat(out).toString("utf8") !==
                  "start: ok\nprepare: ok\ncommit: ok\n")))
        ) {
          reject(
            new ByteCommandError(
              verificationFailed ? "verification" : "protocol",
              !verificationScope.unsettled,
              Buffer.concat(out),
              Buffer.concat(err),
              exitCode,
              exitSignal,
            ),
          );
          return;
        }
        resolve({
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err),
          exitCode,
          signal: exitSignal,
          processSettled: true,
        });
      });
      if (signal?.aborted) abort();
    });
  }

  gitRefTransaction(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv | undefined,
    prepareInput: string,
    verifyPrepared: (assertPreparedActive: () => void) => Promise<void>,
  ): Promise<{ stdout: string; stderr: string }> {
    assertReadActive();
    if (this.closing) throw new RunnerShutdownError("closing");
    // This capability cannot send an arbitrary interactive program or commands.
    const input =
      /^start\n(update HEAD ([a-f0-9]{40}|[a-f0-9]{64}) ([a-f0-9]{40}|[a-f0-9]{64})|verify HEAD ([a-f0-9]{40}|[a-f0-9]{64}))\nprepare\n$/.exec(
        prepareInput,
      );
    if (
      !input ||
      (input[2] && input[2].length !== input[3].length) ||
      args.at(-1) !== "--stdin" ||
      !args.includes("update-ref")
    )
      throw Error("Недопустимая транзакция ссылок Git.");
    const signal = readSignal(),
      deadline = Date.now() + this.timeoutMs;
    return new Promise((resolve, reject) => {
      let stdout = "",
        stderr = "",
        done = false,
        verifying = false,
        commitSent = false,
        interrupted = false,
        verificationError: unknown;
      const child = spawn("git", args, {
        cwd,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnvironment(process.env, this.env, { ...env, NO_COLOR: "1" }),
      });
      this.children.add(child);
      child.once("close", () => {
        if (!this.groupExists(child.pid)) this.children.delete(child);
      });
      const detach = () => {
        this.pendingCommands.delete(child);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const failure = (cause: unknown) =>
        new GitRefTransactionError(
          cause instanceof Error ? cause.message : String(cause),
          commitSent,
          stdout,
          stderr,
          cause,
        );
      const fail = (cause: unknown) => {
        if (done) return;
        done = true;
        detach();
        const error = failure(
          interrupted ? new RunnerShutdownError("interrupted") : cause,
        );
        void this.kill(child).then(
          () => reject(error),
          (stopError) => reject(failure(stopError)),
        );
      };
      const abort = () => fail(Error("Транзакция Git отменена."));
      const timer = setTimeout(
        () => fail(Error("Транзакция Git не ответила вовремя.")),
        this.timeoutMs,
      );
      this.pendingCommands.set(child, () => {
        if (!done) interrupted = true;
      });
      signal?.addEventListener("abort", abort, { once: true });
      child.stdin.on("error", (error) => fail(error));
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.length > 8 * 1024 * 1024) {
          fail(Error("Ответ транзакции Git слишком большой."));
          return;
        }
        if (!verifying && stdout.includes("prepare: ok\n")) {
          verifying = true;
          if (stdout !== "start: ok\nprepare: ok\n") {
            fail(Error("Неожиданный протокол транзакции Git."));
            return;
          }
          void Promise.resolve()
            .then(() =>
              verifyPrepared(() => {
                if (
                  done ||
                  interrupted ||
                  signal?.aborted ||
                  Date.now() >= deadline
                )
                  throw Error("Подготовленная транзакция Git уже не активна.");
              }),
            )
            .then(
              () => {
                if (done || interrupted) return;
                if (Date.now() >= deadline || signal?.aborted) {
                  fail(Error("Транзакция Git не ответила вовремя."));
                  return;
                }
                // Mark before writing: a lost acknowledgement is never proof that
                // refs stayed unchanged. Host journal is durable before this point.
                commitSent = true;
                child.stdin.end("commit\n");
              },
              (error) => {
                if (done || interrupted) return;
                verificationError = error;
                child.stdin.end("abort\n");
              },
            );
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        if (stderr.length > 1024 * 1024)
          fail(Error("Ошибка транзакции Git слишком большая."));
      });
      child.on("error", (error) => fail(error));
      child.on("close", (code) => {
        if (done) return;
        done = true;
        detach();
        if (interrupted)
          reject(failure(new RunnerShutdownError("interrupted")));
        else if (verificationError) reject(failure(verificationError));
        else if (code !== 0)
          reject(
            failure(
              new CommandExitError(
                "Транзакция Git завершилась с ошибкой.",
                code,
                stdout,
                stderr,
              ),
            ),
          );
        else if (
          !commitSent ||
          stdout !== "start: ok\nprepare: ok\ncommit: ok\n"
        )
          reject(
            failure(Error("Git не подтвердил завершение транзакции ссылок.")),
          );
        else resolve({ stdout, stderr });
      });
      if (signal?.aborted) abort();
      if (!done) child.stdin.write(prepareInput);
    });
  }

  command(
    exe: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
    stdin?: string,
  ): Promise<{
    stdout: string;
    stderr: string;
  }> {
    return trackPrepared(this.runCommand(exe, args, cwd, env, stdin));
  }
  private runCommand(
    exe: string,
    args: string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
    stdin?: string,
  ): Promise<{ stdout: string; stderr: string }> {
    assertReadActive();
    const scope = preparedCommands.getStore();
    const signal = readSignal();
    return new Promise((resolve, reject) => {
      let out = "",
        err = "",
        done = false;
      const child = this.start(exe, args, cwd, env, stdin);
      let interrupted = false;
      this.pendingCommands.set(child, () => {
        // Only this still-pending command is targeted by dispose. An already
        // observed nonzero exit or spawn failure remains a genuine failure.
        if (
          !done &&
          child.pid &&
          child.signalCode === null &&
          (child.exitCode === null || child.exitCode === 0)
        )
          interrupted = true;
      });
      const fail = (message: string) => {
        if (done) return;
        done = true;
        this.pendingCommands.delete(child);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        const error = interrupted
          ? new RunnerShutdownError("interrupted")
          : new Error(message);
        void this.kill(child).then(
          () => reject(error),
          (failure) => {
            if (scope) scope.unsettled = true;
            reject(failure);
          },
        );
      };
      const abort = () =>
        fail("Чтение отменено; остановлена только его команда.");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(
        () => fail("Команда не ответила вовремя. Проверьте Goga / Docker."),
        this.timeoutMs,
      );
      if (signal?.aborted) abort();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        out += chunk;
        if (out.length > 8 * 1024 * 1024) fail("Ответ команды слишком большой");
      });
      child.stderr.on("data", (chunk) => {
        err += chunk;
        if (err.length > 1024 * 1024) err = err.slice(-1024 * 1024);
      });
      child.on("error", () =>
        fail(
          `Не удалось запустить ${exe.includes("git") ? "Git" : "Goga"}. Проверьте установку и PATH.`,
        ),
      );
      child.on("close", (code) => {
        if (done) return;
        if (scope && this.groupExists(child.pid)) {
          fail("Проверка оставила работающую группу процессов.");
          return;
        }
        done = true;
        this.pendingCommands.delete(child);
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (interrupted) reject(new RunnerShutdownError("interrupted"));
        else if (code !== 0)
          reject(
            new CommandExitError(
              /No such option:\s*--profile\b/.test(err)
                ? "Установленная версия Goga не поддерживает --profile. Обновите Goga; профиль не был проигнорирован."
                : `Команда завершилась с кодом ${code ?? "signal"}. Проверьте Goga, Docker и конфигурацию проекта.`,
              code,
              out,
              err,
            ),
          );
        else resolve({ stdout: out, stderr: err });
      });
    });
  }
}
function probe(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get(`${origin}/api/status`, { timeout: 1000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        finish(false);
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (s) => {
        body += s;
        if (body.length > 4 * 1024 * 1024) {
          res.destroy();
          finish(false);
        }
      });
      res.on("end", () => {
        try {
          const d = JSON.parse(body);
          finish(typeof d?.flow_name === "string" && Array.isArray(d?.stages));
        } catch {
          finish(false);
        }
      });
      res.on("error", () => finish(false));
    });
    req.on("timeout", () => {
      req.destroy();
      finish(false);
    });
    req.on("error", () => finish(false));
  });
}
export function watchDashboard(
  child: ChildProcessWithoutNullStreams,
  callbacks: {
    timeoutMs?: number | null;
    onReady: (url: string) => void;
    onFinish: (code: number | null) => void;
    onFailure: (error: Error) => void;
  },
): () => void {
  const parser = new DashboardParser();
  const decoders = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  let cancelled = false,
    ready = false,
    probing = false;
  const candidates = new Set<string>();
  const cancel = () => {
    cancelled = true;
    clearTimeout(timeout);
    clearInterval(interval);
  };
  const fail = (message: string) => {
    if (cancelled) return;
    cancel();
    callbacks.onFailure(new Error(message));
  };
  const check = async () => {
    if (cancelled || ready || probing) return;
    probing = true;
    for (const url of candidates) {
      if (await probe(url)) {
        if (!cancelled) {
          ready = true;
          clearTimeout(timeout);
          clearInterval(interval);
          callbacks.onReady(url);
        }
        break;
      }
    }
    probing = false;
  };
  const interval = setInterval(() => void check(), 250);
  const timeout =
    callbacks.timeoutMs === null
      ? undefined
      : setTimeout(
          () =>
            fail(
              "Панель конвейера не стала доступна вовремя (120 с). Проверьте Docker и pipeline.",
            ),
          callbacks.timeoutMs ?? 120000,
        );
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].on("data", (chunk) => {
      if (cancelled || ready) return;
      for (const url of parser.push(
        stream,
        decoders[stream].write(Buffer.from(chunk)),
      )) {
        if (candidates.size < 8) candidates.add(url);
      }
      void check();
    });
    child[stream].on("end", () => {
      for (const url of parser.push(stream, decoders[stream].end() + "\n"))
        if (candidates.size < 8) candidates.add(url);
      void check();
    });
  }
  child.on("error", () =>
    fail("Не удалось запустить Goga. Проверьте установку и PATH."),
  );
  child.on("close", (code) => {
    if (cancelled) return;
    if (!ready) {
      fail(
        `Goga завершилась до готовности панели конвейера (код ${code ?? "signal"}). Проверьте Docker и конфигурацию.`,
      );
      return;
    }
    cancel();
    callbacks.onFinish(code);
  });
  return cancel;
}
