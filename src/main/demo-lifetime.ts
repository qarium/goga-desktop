import type { PreparedShutdown } from "../host/shutdown";
import type { DemoShow } from "../shared/demonstrations";
/** Only track operations that can change the inventory. A slow document or a
 * disconnected viewer must not hold the exit confirmation open. */
export class DemoLifetime {
  private frozen = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(
    private readonly shows: () => Pick<DemoShow, "showId" | "label">[],
    private readonly stopShow: (id: string) => Promise<void>,
  ) {}
  async admit<T>(action: () => Promise<T>): Promise<T> {
    if (this.frozen) throw Error("Приложение готовится к выходу.");
    const flight = action();
    this.pending.add(flight);
    try {
      return await flight;
    } finally {
      this.pending.delete(flight);
    }
  }
  async prepare(): Promise<PreparedShutdown> {
    if (this.frozen) throw Error("Подготовка к выходу уже выполняется.");
    this.frozen = true;
    try {
      await Promise.allSettled([...this.pending]);
      const items = this.shows().map((s) => ({
        id: s.showId,
        label: "Демонстрация · " + s.label,
      }));
      const planned = new Set(items.map((x) => x.id));
      const validate = () => {
        if (!this.frozen || this.shows().some((s) => !planned.has(s.showId)))
          throw Error("Состав показов изменился.");
      };
      return {
        items,
        requiresConfirmation: items.length > 0,
        validate,
        remaining: () => this.shows().map((s) => s.showId),
        stop: async () => {
          validate();
          for (const id of planned) {
            if (this.shows().some((s) => s.showId === id))
              await this.stopShow(id);
          }
        },
        release: () => {
          this.frozen = false;
        },
      };
    } catch (e) {
      this.frozen = false;
      throw e;
    }
  }
}
