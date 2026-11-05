import { TerminalInspectorError } from "../host/terminal-errors";
import { TerminalStopError } from "../host/terminal-processes";
import { ShutdownKeepError } from "../host/shutdown";
import type {
  PreparedShutdown,
  ShutdownItem,
  ShutdownParticipant,
} from "../host/shutdown";
export interface ShutdownResult {
  status: "success" | "cancelled" | "failed" | "partial";
  completed: string[];
  remaining: string[];
  retained?: string[];
  message?: string;
  inventoryComplete?: boolean;
}
/** One confirmation across pipeline/build/terminal, no policy-changing signals.
 * Each participant retains its own ownership checks and termination deadline.
 * Install before exposing startup controls. finalize owns resource disposal/quit.
 */
export class ShutdownCoordinator {
  private flight?: Promise<ShutdownResult>;
  private completed?: ShutdownResult;
  constructor(
    private dependencies: {
      participants: ShutdownParticipant[];
      confirm(items: ShutdownItem[]): Promise<boolean | "keep">;
      finalize(): Promise<void>;
    },
  ) {}
  close(): Promise<ShutdownResult> {
    if (this.completed) return Promise.resolve(this.completed);
    if (this.flight) return this.flight;
    const flight = Promise.resolve().then(() => this.execute());
    this.flight = flight;
    void flight.then(() => {
      if (this.flight === flight) this.flight = undefined;
    });
    return flight;
  }
  private async execute(): Promise<ShutdownResult> {
    const prepared: PreparedShutdown[] = [];
    const itemIds = new Map<PreparedShutdown, Set<string>>();
    const keepAttempted = new Set<PreparedShutdown>();
    let keep = false;
    const retainedIds = (participant: PreparedShutdown) => {
      if (!keepAttempted.has(participant)) return new Set<string>();
      const ids = participant.retained!();
      if (
        !Array.isArray(ids) ||
        ids.some((id) => !itemIds.get(participant)!.has(id))
      )
        throw new ShutdownKeepError("changed");
      return new Set(ids);
    };
    const verify = (participant: PreparedShutdown) => {
      const retained = retainedIds(participant);
      if (participant.remaining().some((id) => !retained.has(id)))
        throw keep
          ? new ShutdownKeepError("incomplete")
          : Error("Shutdown incomplete");
    };
    let phase = "Подготовка к выходу";
    const snapshot = () => {
      let inventoryComplete =
        prepared.length === this.dependencies.participants.length;
      const remaining = new Set<string>(),
        retained = new Set<string>(),
        all = new Set<string>();
      for (const participant of prepared) {
        const ids = itemIds.get(participant)!;
        for (const id of ids) all.add(id);
        try {
          const kept = retainedIds(participant);
          const live = participant.remaining();
          for (const id of kept) retained.add(id);
          for (const id of live) if (!kept.has(id)) remaining.add(id);
        } catch {
          inventoryComplete = false;
          for (const id of ids) remaining.add(id);
        }
      }
      return {
        inventoryComplete,
        completed: [...all].filter(
          (id) => !remaining.has(id) && !retained.has(id),
        ),
        remaining: [...remaining],
        ...(keep ? { retained: [...retained] } : {}),
      };
    };
    try {
      for (const participant of this.dependencies.participants) {
        const lease = await participant.prepare();
        prepared.push(lease);
        itemIds.set(lease, new Set(lease.items.map((item) => item.id)));
      }
      phase = "Подтверждение выхода";
      if (prepared.some((p) => p.requiresConfirmation)) {
        const answer = await this.dependencies.confirm(
          prepared.flatMap((p) => p.items),
        );
        if (!answer) return { status: "cancelled", ...snapshot() };
        keep = answer === "keep";
      }
      // Validate ALL previews before the first participant can signal anything.
      phase = "Проверка процессов перед завершением";
      for (const participant of prepared) participant.validate();
      for (const participant of prepared) {
        const capability = [
          participant.validateKeep,
          participant.keep,
          participant.retained,
        ];
        if (
          capability.some((method) => method !== undefined) &&
          !capability.every((method) => typeof method === "function")
        )
          throw new ShutdownKeepError("incomplete");
      }
      if (keep) {
        phase = "Проверка возможности сохранения процессов";
        for (const participant of prepared)
          if (participant.keep) await participant.validateKeep!();
      }
      phase = "Завершение процессов";
      // Keep mode must stop ordinary terminals before the first detach. The
      // boolean stop mode retains the original participant order unchanged.
      for (const participant of prepared) {
        if (keep && participant.keep) continue;
        await participant.stop();
        verify(participant);
      }
      if (keep) {
        phase = "Сохранение запущенных процессов";
        for (const participant of prepared) {
          if (!participant.keep) continue;
          keepAttempted.add(participant);
          await participant.keep();
          verify(participant);
        }
      }
      // A participant may have changed while another was stopping. Never quit on
      // a successful stop Promise alone; require an observed empty live inventory.
      for (const participant of prepared) verify(participant);
      const keptState = keep ? snapshot() : undefined;
      if (
        keptState &&
        (!keptState.inventoryComplete || keptState.remaining.length)
      )
        throw new ShutdownKeepError("incomplete");
      phase = "Сохранение состояния и закрытие приложения";
      await this.dependencies.finalize();
      this.completed = { status: "success", ...(keptState ?? snapshot()) };
      return this.completed;
    } catch (error) {
      const state = snapshot();
      return {
        status:
          state.completed.length || state.retained?.length
            ? "partial"
            : "failed",
        ...state,
        message:
          "Выход не завершён. Приложение остаётся открытым; уже завершённые процессы не запускаются повторно." +
          `\nЭтап: ${phase}.` +
          (error instanceof TerminalStopError ||
          error instanceof TerminalInspectorError ||
          error instanceof ShutdownKeepError
            ? `\n${error.message}`
            : ""),
      };
    } finally {
      for (const participant of prepared.reverse()) {
        try {
          participant.release();
        } catch {
          /* Never mask the actual stop result. */
        }
      }
    }
  }
}
