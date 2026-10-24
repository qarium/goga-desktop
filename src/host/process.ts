import { childEnvironment } from "./process-environment";
import { readSignal, assertReadActive } from "./read-scope";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { DashboardParser } from "./parsers";
export interface Runner {
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
export class NodeRunner implements Runner {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private closing = false;
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
    stdin?: string,
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
    child.stdin.end(stdin);
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
        children.map((child) => this.kill(child)),
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
    assertReadActive();
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
        void this.kill(child).then(() => reject(error), reject);
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
