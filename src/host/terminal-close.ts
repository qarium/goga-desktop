import { randomUUID } from "node:crypto";
import { TerminalStopError } from "./terminal-processes";
import type { ScopeRef } from "../shared/context";
import type { TerminalTab } from "../shared/terminal";
import type {
  TerminalSessionRef,
  TerminalSessionView,
} from "./terminal-sessions";
import type {
  TerminalProcessControl,
  TerminalProcessPlan,
} from "./terminal-processes";
export type TerminalCloseRequest =
  | { kind: "tab"; tab: TerminalTab }
  | { kind: "refresh"; ref: TerminalSessionRef; scope: ScopeRef }
  | { kind: "exit"; deferDisposal?: true };
export interface TerminalCloseTarget {
  view: TerminalSessionView;
  control?: TerminalProcessControl;
}
export interface TerminalClosePreview {
  token: string;
  kind: TerminalCloseRequest["kind"];
  requiresConfirmation: boolean;
  sessions: (TerminalSessionView & { jobCount: number })[];
}
export interface TerminalCloseResult {
  status: "success" | "failed" | "partial";
  completed: TerminalSessionRef[];
  remaining: TerminalSessionRef[];
  message?: string;
  session?: TerminalSessionView;
}
export interface TerminalCloseHost {
  targets(request: TerminalCloseRequest): TerminalCloseTarget[];
  report(request: TerminalCloseRequest): TerminalSessionView[];
  freeze(request: TerminalCloseRequest): () => void;
  stop(ref: TerminalSessionRef, plan: TerminalProcessPlan): Promise<void>;
  complete(
    request: TerminalCloseRequest,
  ): Promise<TerminalSessionView | undefined>;
}
interface Ticket {
  request: TerminalCloseRequest;
  expires: number;
  required: boolean;
  targets: { view: TerminalSessionView; plan?: TerminalProcessPlan }[];
}
const ref = (view: TerminalSessionView): TerminalSessionRef => ({
  sessionId: view.sessionId,
  generation: view.generation,
});
const key = (view: TerminalSessionView) =>
  JSON.stringify([view.sessionId, view.generation]);
/** Host-memory tickets only. No process identities or authority are accepted back from the renderer. */
export class TerminalCloseCoordinator {
  private tickets = new Map<string, Ticket>();
  constructor(
    private host: TerminalCloseHost,
    private now: () => number = () => performance.now(),
  ) {}
  prepare(input: TerminalCloseRequest): TerminalClosePreview {
    const request = structuredClone(input);
    const targets = this.host.targets(request).map((target) => {
      if (target.view.state === "starting" || target.view.state === "stopping")
        throw Error("Дождитесь завершения текущей операции терминала.");
      if (target.view.state !== "exited" && !target.control)
        throw Error("Принадлежность процессов терминала не подтверждена.");
      return {
        view: structuredClone(target.view),
        plan:
          target.view.state === "exited"
            ? undefined
            : target.control!.prepare(),
      };
    });
    const required = targets.some((t) => (t.plan?.jobs.length ?? 0) > 0);
    for (const [id, ticket] of this.tickets)
      if (ticket.expires <= this.now()) this.tickets.delete(id);
    if (this.tickets.size >= 128)
      this.tickets.delete(this.tickets.keys().next().value!);
    const token = randomUUID();
    this.tickets.set(token, {
      request,
      expires: this.now() + 60000,
      targets,
      required,
    });
    return {
      token,
      kind: request.kind,
      requiresConfirmation: required,
      sessions: targets.map((t) => ({
        ...structuredClone(t.view),
        jobCount: t.plan?.jobs.length ?? 0,
      })),
    };
  }
  cancel(token: string): void {
    if (!this.tickets.delete(token))
      throw Error("Подтверждение отсутствует или уже использовано.");
  }
  /** Read-only revalidation for unified shutdown before any other participant stops. */
  validate(token: string): void {
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.expires <= this.now())
      throw Error("Подтверждение отсутствует или устарело.");
    this.validateTicket(ticket);
  }
  private validateTicket(ticket: Ticket): TerminalCloseTarget[] {
    const current = this.host.targets(ticket.request);
    if (
      current.length !== ticket.targets.length ||
      current.some(
        (t) => !ticket.targets.some((p) => key(p.view) === key(t.view)),
      )
    )
      throw new TerminalStopError("stale");
    // Preflight ALL contexts before touching the first one. Stop() rechecks again before each signal.
    for (const target of current) {
      if (target.view.state === "exited") continue;
      const planned = ticket.targets.find(
        (p) => key(p.view) === key(target.view),
      )!;
      if (!planned.plan || !target.control || target.view.state !== "running")
        throw new TerminalStopError("stale");
      target.control.validate(planned.plan);
    }
    return current;
  }
  async confirm(
    token: string,
    confirmed: boolean,
  ): Promise<TerminalCloseResult> {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    if (
      !ticket ||
      ticket.expires <= this.now() ||
      (ticket.required && confirmed !== true)
    )
      throw Error("Подтверждение отсутствует, устарело или не получено.");
    let unfreeze: (() => void) | undefined;
    const stopped = new Map<string, TerminalSessionRef>();
    try {
      unfreeze = this.host.freeze(ticket.request);
      const current = this.validateTicket(ticket);
      for (const target of current) {
        if (target.view.state !== "exited") {
          const plan = ticket.targets.find(
            (p) => key(p.view) === key(target.view),
          )!.plan!;
          await this.host.stop(ref(target.view), plan);
        }
        stopped.set(key(target.view), ref(target.view));
      }
      const session = await this.host.complete(ticket.request);
      return {
        status: "success",
        completed: ticket.targets.map((t) => ref(t.view)),
        remaining: [],
        ...(session ? { session } : {}),
      };
    } catch (error) {
      let current: TerminalSessionView[] = [];
      try {
        current = this.host.report(ticket.request);
      } catch {
        /* Unknown state stays unresolved. */
      }
      for (const view of current)
        if (
          view.state === "exited" &&
          ticket.targets.some((t) => key(t.view) === key(view))
        )
          stopped.set(key(view), ref(view));
      const completed = [...stopped.values()];
      const unresolved = new Map(
        current
          .filter((v) => v.state !== "exited")
          .map((v) => [key(v), ref(v)]),
      );
      for (const t of ticket.targets)
        if (
          !stopped.has(key(t.view)) &&
          !current.some((v) => key(v) === key(t.view))
        )
          unresolved.set(key(t.view), ref(t.view));
      const remaining = [...unresolved.values()];
      return {
        status:
          completed.length ||
          (error instanceof TerminalStopError && error.actions.length)
            ? "partial"
            : "failed",
        completed,
        remaining,
        message:
          error instanceof TerminalStopError
            ? error.message
            : "Операция терминала не завершена. Вкладки сохранены; завершённые команды не запускаются повторно.",
      };
    } finally {
      unfreeze?.();
    }
  }
}
