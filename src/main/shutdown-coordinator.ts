import { TerminalInspectorError } from "../host/terminal-errors";
import { TerminalStopError } from "../host/terminal-processes";
import type {
  PreparedShutdown,
  ShutdownItem,
  ShutdownParticipant,
} from "../host/shutdown";
export interface ShutdownResult {
  status: "success" | "cancelled" | "failed" | "partial";
  completed: string[];
  remaining: string[];
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
      confirm(items: ShutdownItem[]): Promise<boolean>;
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
    let phase = "Подготовка к выходу";
    const snapshot = () => {
      let inventoryComplete =
        prepared.length === this.dependencies.participants.length;
      const remaining = new Set<string>(),
        all = new Set<string>();
      for (const participant of prepared) {
        for (const item of participant.items) all.add(item.id);
        try {
          for (const id of participant.remaining()) remaining.add(id);
        } catch {
          inventoryComplete = false;
          for (const item of participant.items) remaining.add(item.id);
        }
      }
      return {
        inventoryComplete,
        completed: [...all].filter((id) => !remaining.has(id)),
        remaining: [...remaining],
      };
    };
    try {
      for (const participant of this.dependencies.participants)
        prepared.push(await participant.prepare());
      phase = "Подтверждение выхода";
      if (
        prepared.some((p) => p.requiresConfirmation) &&
        !(await this.dependencies.confirm(prepared.flatMap((p) => p.items)))
      )
        return { status: "cancelled", ...snapshot() };
      // Validate ALL previews before the first participant can signal anything.
      phase = "Проверка процессов перед завершением";
      for (const participant of prepared) participant.validate();
      phase = "Завершение процессов";
      for (const participant of prepared) {
        await participant.stop();
        if (participant.remaining().length) throw Error("Shutdown incomplete");
      }
      // A participant may have changed while another was stopping. Never quit on
      // a successful stop Promise alone; require an observed empty live inventory.
      for (const participant of prepared)
        if (participant.remaining().length) throw Error("Shutdown incomplete");
      phase = "Сохранение состояния и закрытие приложения";
      await this.dependencies.finalize();
      this.completed = { status: "success", ...snapshot() };
      return this.completed;
    } catch (error) {
      const state = snapshot();
      return {
        status: state.completed.length ? "partial" : "failed",
        ...state,
        message:
          "Выход не завершён. Приложение остаётся открытым; уже завершённые процессы не запускаются повторно." +
          `\nЭтап: ${phase}.` +
          (error instanceof TerminalStopError ||
          error instanceof TerminalInspectorError
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
