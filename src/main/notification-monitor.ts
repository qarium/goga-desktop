import {dashboardRecoveryAllowed} from "../shared/dashboard-connection";
import { createHash } from "node:crypto";
import {
  NotificationInputSchema,
  notificationPipelineLabel,
  type NotificationInput,
  type NotificationKind,
} from "../shared/notifications";
import type { Run } from "../shared/types";
import { topicContextRefSchema } from "../shared/worktrees";
import { allowedDashboardURL } from "./security";

const POLL_MS = 3000,
  DEADLINE_MS = 5000,
  MAX_BODY = 2 * 1024 * 1024,
  MAX_WS = 64 * 1024;
const terminalSeverity: Partial<Record<NotificationKind, number>> = {
  "process-exited": 1,
  "run-finished": 2,
  "run-failed": 3,
};
const significant = new Set([
  "stage_status_changed",
  "approved",
  "revised",
  "retry_scheduled",
  "retry_exhausted",
  "manual_retry",
  "ask_user",
  "user_answered",
  "agent_completed",
  "dialog_question",
  "dialog_answer",
  "agent_note",
  "run_finished",
  "run_failed",
]);
type Options = {
  add: (input: NotificationInput) => Promise<unknown>;
  onError?: (runId: string, message: string | null) => void;
  fetch?: typeof globalThis.fetch;
  socket?: (url: string) => WebSocket;
};
type Metadata = Pick<
  NotificationInput,
  "runId" | "projectId" | "context" | "pipeline" | "topic" | "branch"
>;
type PendingTerminal = {
  input: NotificationInput;
  key: string;
  attempts: number;
  hostEnded: boolean;
  retry?: ReturnType<typeof setTimeout>;
};
type Observer = {
  run: Run;
  key: string;
  url: string;
  stopped: boolean;
  pin?: string | null;
  seen: Set<string>;
  poll?: ReturnType<typeof setInterval>;
  wake?: ReturnType<typeof setTimeout>;
  reconnect?: ReturnType<typeof setTimeout>;
  attempts: number;
  socket?: WebSocket;
  flight?: AbortController;
};
const hash = (values: unknown[]) =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");
const label = (value: string, max: number) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .slice(0, max);
const identifier = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function datetime(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts) return;
  const [, y, m, d, hh, mm, ss] = parts,
    year = Number(y),
    month = Number(m),
    day = Number(d);
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const time = Date.parse(value);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1] ||
    Number(hh) > 23 ||
    Number(mm) > 59 ||
    Number(ss) > 59 ||
    !Number.isFinite(time)
  )
    return;
  return new Date(time).toISOString();
}
function metadata(run: Run): Metadata {
  const result: Metadata = {
    runId: run.id,
    projectId: run.projectId,
    pipeline: notificationPipelineLabel(run),
    topic: label(run.topic, 1024),
    branch: label(run.branch, 256),
  };
  if (run.context) {
    const { projectId, year, topic, branch, contextId, revision } = run.context;
    const parsed = topicContextRefSchema.safeParse({
      projectId,
      year,
      topic,
      branch,
      contextId,
      revision,
    });
    if (
      parsed.success &&
      projectId === result.projectId &&
      topic === result.topic &&
      branch === result.branch
    )
      result.context = parsed.data;
  }
  return result;
}
const ownerKey = (run: Run) => JSON.stringify(metadata(run));
const pipeline = (run: Run) => run.kind !== "build" && dashboardRecoveryAllowed(run);
const active = (run: Run) =>
  run.status === "starting" || run.status === "running";
function attention(
  stage: Record<string, unknown>,
): NotificationKind | undefined {
  switch (stage.status) {
    case "awaiting_user_input":
      return "question";
    case "awaiting_approval":
      return "approval";
    case "failed":
    case "hook_failed":
      return "stage-failed";
    case "paused":
      return "paused";
    case "awaiting_assistants":
      return stage.awaiting_assistants_blocked === true
        ? "assistant-decision"
        : undefined;
  }
}

/** A read-only observer: snapshots are authoritative; WS messages merely wake polling. */
export class NotificationMonitor {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly observers = new Map<string, Observer>();
  private readonly terminals = new Map<string, PendingTerminal>();
  private previous = new Map<string, Run>();
  private disposed = false;

  constructor(private readonly options: Options) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.socketFactory = options.socket ?? ((url) => new WebSocket(url));
  }

  reconcile(runs: Run[]): void {
    if (this.disposed) return;
    const current = new Map(
      runs.map((run) => [
        run.id,
        { ...run, context: run.context && { ...run.context } },
      ]),
    );
    for (const [id, pending] of this.terminals) {
      const run = current.get(id);
      if (
        !run ||
        !pipeline(run) ||
        (active(run) && pending.hostEnded) ||
        pending.key !== this.key(run)
      )
        this.cancelTerminal(pending);
      else if (!active(run)) pending.hostEnded = true;
    }
    for (const [id, observer] of this.observers) {
      const run = current.get(id);
      if (!run || !this.eligible(run) || observer.key !== this.key(run)) {
        this.stop(observer);
        this.observers.delete(id);
      } else observer.run = run;
    }
    for (const run of current.values()) {
      const before = this.previous.get(run.id);
      if (
        before &&
        active(before) &&
        pipeline(before) &&
        pipeline(run) &&
        ownerKey(before) === ownerKey(run) &&
        (run.status === "failed" || run.status === "exited")
      ) {
        this.startTerminal(run, {
          ...metadata(run),
          id: hash([run.id, "terminal"]),
          kind:
            run.status === "failed" || run.error
              ? "run-failed"
              : "process-exited",
          occurredAt: datetime(run.endedAt) ?? new Date().toISOString(),
        });
      }
      if (!this.eligible(run) || this.observers.has(run.id)) continue;
      const observer: Observer = {
        run,
        key: this.key(run),
        url: new URL(run.url!).origin,
        pin: run.dashboardRunId,
        seen: new Set(),
        stopped: false,
        attempts: 0,
      };
      this.observers.set(run.id, observer);
      observer.poll = setInterval(() => {
        void this.refresh(observer);
      }, POLL_MS);
      this.connect(observer);
      void this.refresh(observer);
    }
    this.previous = current;
  }

  dispose(): void {
    this.disposed = true;
    for (const observer of this.observers.values()) this.stop(observer);
    this.observers.clear();
    for (const pending of this.terminals.values()) this.cancelTerminal(pending);
    this.previous.clear();
  }

  private eligible(run: Run): boolean {
    return (
      pipeline(run) &&
      run.status === "running" &&
      run.dashboardOpened !== false &&
      typeof run.url === "string" &&
      allowedDashboardURL(run.url)
    );
  }
  private key(run: Run): string {
    return JSON.stringify([run.url, ownerKey(run), run.dashboardRunId ?? null]);
  }
  private live(observer: Observer): boolean {
    return (
      !this.disposed &&
      !observer.stopped &&
      this.observers.get(observer.run.id) === observer
    );
  }
  private error(runId: string, message: string | null): void {
    try {
      this.options.onError?.(runId, message);
    } catch {
      /* A status listener cannot stop a pipeline. */
    }
  }
  private stop(observer: Observer): void {
    observer.stopped = true;
    clearInterval(observer.poll);
    clearTimeout(observer.wake);
    clearTimeout(observer.reconnect);
    observer.flight?.abort();
    if (observer.socket) {
      observer.socket.onopen =
        observer.socket.onmessage =
        observer.socket.onclose =
        observer.socket.onerror =
          null;
      try {
        observer.socket.close();
      } catch {
        /* Best-effort cleanup, no process ownership. */
      }
    }
    if (this.observers.get(observer.run.id) === observer)
      this.error(observer.run.id, null);
  }

  private startTerminal(run: Run, input: NotificationInput): boolean {
    if (!NotificationInputSchema.safeParse(input).success) return false;
    const existing = this.terminals.get(run.id);
    if (existing) {
      if (
        (terminalSeverity[input.kind] ?? 0) >
        (terminalSeverity[existing.input.kind] ?? 0)
      )
        existing.input = input;
      return true;
    }
    const pending: PendingTerminal = {
      input,
      key: this.key(run),
      attempts: 0,
      hostEnded: !active(run),
    };
    this.terminals.set(run.id, pending);
    void this.retryTerminal(pending);
    return true;
  }

  private cancelTerminal(pending: PendingTerminal): void {
    if (this.terminals.get(pending.input.runId) !== pending) return;
    clearTimeout(pending.retry);
    this.terminals.delete(pending.input.runId);
    this.error(pending.input.runId, null);
  }

  private async retryTerminal(pending: PendingTerminal): Promise<void> {
    const valid = () =>
      !this.disposed && this.terminals.get(pending.input.runId) === pending;
    if (!valid()) return;
    const attempted = pending.input;
    const saved = await this.emit(attempted, valid);
    if (!valid()) return;
    if (saved && pending.input === attempted) this.cancelTerminal(pending);
    else {
      const delay = saved
        ? 0
        : Math.min(30000, 1000 * 2 ** Math.min(pending.attempts++, 5));
      pending.retry = setTimeout(() => {
        pending.retry = undefined;
        void this.retryTerminal(pending);
      }, delay);
    }
  }

  private async emit(
    input: NotificationInput,
    valid: () => boolean,
  ): Promise<boolean> {
    const parsed = NotificationInputSchema.safeParse(input);
    if (!parsed.success || !valid()) return false;
    try {
      await this.options.add(parsed.data);
      return true;
    } catch {
      if (valid()) this.error(input.runId, "Не удалось сохранить уведомление.");
      return false;
    }
  }

  private async refresh(observer: Observer): Promise<void> {
    if (!this.live(observer) || observer.flight) return;
    const controller = new AbortController();
    observer.flight = controller;
    const valid = () => this.live(observer) && !controller.signal.aborted;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        controller.abort();
        reject(new Error("deadline"));
      }, DEADLINE_MS);
    });
    try {
      const body = await Promise.race([
        this.fetcher(`${observer.url}/api/status`, {
          method: "GET",
          redirect: "error",
          credentials: "omit",
          signal: controller.signal,
        }).then((value) => this.read(value)),
        timeout,
      ]);
      if (!valid()) return;
      if (
        !object(body) ||
        !Array.isArray(body.stages) ||
        (body.run_id !== undefined && !identifier(body.run_id))
      )
        throw new Error("shape");
      const runId = typeof body.run_id === "string" ? body.run_id : null;
      if (observer.pin !== undefined && observer.pin !== runId) {
        this.stop(observer);
        this.error(
          observer.run.id,
          "Источник запуска изменился. Наблюдение остановлено; данные доступны только для чтения.",
        );
        return;
      }
      observer.pin = runId;
      this.error(observer.run.id, null);
      for (const value of body.stages) {
        if (!valid()) return;
        if (!object(value)) continue;
        const kind = attention(value),
          occurredAt = datetime(value.updated_at);
        if (!kind || !identifier(value.id) || !occurredAt) continue;
        const input: NotificationInput = {
          ...metadata(observer.run),
          id: hash([observer.run.id, runId ?? "", value.id, kind, occurredAt]),
          stageId: value.id,
          kind,
          occurredAt,
        };
        if (!observer.seen.has(input.id) && (await this.emit(input, valid))) {
          observer.seen.add(input.id);
          if (observer.seen.size > 4096)
            observer.seen.delete(observer.seen.values().next().value!);
        }
      }
      if (!valid()) return;
      const failed =
        body.run_status === "failed" ||
        body.run_status === "interrupted" ||
        (body.run_status === "finished" &&
          body.stages.some(
            (value) =>
              object(value) &&
              (value.status === "failed" || value.status === "hook_failed"),
          ));
      const finished =
        body.run_status === "finished" &&
        body.stages.length > 0 &&
        body.stages.every(
          (value) =>
            object(value) && identifier(value.id) && value.status === "done",
        );
      const kind = failed
        ? "run-failed"
        : finished && !observer.run.error
          ? "run-finished"
          : undefined;
      const updates = body.stages.flatMap((value) =>
        object(value) && datetime(value.updated_at)
          ? [datetime(value.updated_at)!]
          : [],
      );
      const occurredAt =
        datetime(body.ended_at) ??
        updates.sort().at(-1) ??
        new Date().toISOString();
      if (kind) {
        const seenKey = `terminal:${kind}`;
        if (
          !observer.seen.has(seenKey) &&
          this.startTerminal(observer.run, {
            ...metadata(observer.run),
            id: hash([observer.run.id, "terminal"]),
            kind,
            occurredAt,
          })
        )
          observer.seen.add(seenKey);
      }
    } catch {
      if (this.live(observer))
        this.error(
          observer.run.id,
          "Не удалось обновить состояние уведомлений.",
        );
    } finally {
      clearTimeout(deadline);
      if (observer.flight === controller) observer.flight = undefined;
    }
  }

  private async read(response: Response): Promise<unknown> {
    if (
      !response.ok ||
      response.redirected ||
      Number(response.headers.get("content-length")) > MAX_BODY ||
      !response.body
    )
      throw new Error("response");
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let size = 0,
      text = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) throw new Error("limit");
        text += decoder.decode(value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  private connect(observer: Observer): void {
    if (!this.live(observer)) return;
    let socket: WebSocket | undefined;
    const retry = () => {
      if (
        !this.live(observer) ||
        observer.reconnect ||
        (socket && observer.socket !== socket)
      )
        return;
      if (socket) {
        observer.socket = undefined;
        socket.onopen =
          socket.onmessage =
          socket.onclose =
          socket.onerror =
            null;
        try {
          socket.close();
        } catch {
          /* Already disconnected. */
        }
      }
      const delay = Math.min(
        30000,
        1000 * 2 ** Math.min(observer.attempts++, 5),
      );
      observer.reconnect = setTimeout(() => {
        observer.reconnect = undefined;
        this.connect(observer);
      }, delay);
    };
    try {
      socket = this.socketFactory(
        `${observer.url.replace(/^http:/, "ws:")}/ws`,
      );
      observer.socket = socket;
      socket.onopen = () => {
        if (this.live(observer)) observer.attempts = 0;
      };
      socket.onclose = socket.onerror = retry;
      socket.onmessage = (event) => {
        if (
          !this.live(observer) ||
          observer.socket !== socket ||
          observer.flight ||
          observer.wake ||
          typeof event.data !== "string" ||
          event.data.length > MAX_WS ||
          Buffer.byteLength(event.data, "utf8") > MAX_WS
        )
          return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (
            !object(message) ||
            typeof message.type !== "string" ||
            !significant.has(message.type)
          )
            return;
          observer.wake = setTimeout(() => {
            observer.wake = undefined;
            void this.refresh(observer);
          }, 100);
        } catch {
          /* Malformed/informational WS messages are not an event source. */
        }
      };
    } catch {
      retry();
    }
  }
}
