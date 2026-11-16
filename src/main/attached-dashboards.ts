import { randomUUID } from "node:crypto";
import {
  dashboardOwnerSchema,
  sameDashboardOwner,
  type AttachedDashboard,
  type DashboardOwner,
} from "../shared/attached-dashboard";
import {
  allowedDashboardURL,
  readDashboardStatus,
} from "../shared/dashboard-connection";

const unavailable = () => Error("Подключённая панель недоступна.");
const wrongOwner = () =>
  Error("Адрес панели уже подключён в другом контексте.");
const replaced = () =>
  Error(
    "Порт теперь принадлежит другому запуску. Закройте прежнюю вкладку и подключите нужный запуск явно.",
  );

function explicitOrigin(input: string): string {
  if (typeof input !== "string" || input.length > 160)
    throw Error("Введите локальный dashboard URL с портом.");
  const value = input.trim().replace(/^(?:➜\s*)?dashboard:\s*/i, "");
  if (!allowedDashboardURL(value))
    throw Error(
      "Введите адрес вида http://localhost:52456 без пути и параметров.",
    );
  return new URL(value).origin;
}

/** One trusted shell/window; no persistence, process APIs, port discovery or cross-project fallback. */
export class AttachedDashboards {
  private readonly entries = new Map<string, AttachedDashboard>(); // canonical origin
  private readonly pending = new Set<{
    url: string;
    owner: DashboardOwner;
    controller: AbortController;
  }>();
  private disposed = false;

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  all(): AttachedDashboard[] {
    return structuredClone([...this.entries.values()]);
  }

  list(owner: DashboardOwner): AttachedDashboard[] {
    return this.all().filter((item) => sameDashboardOwner(item.owner, owner));
  }

  private find(owner: DashboardOwner, id: string) {
    for (const item of this.entries.values())
      if (item.id === id && sameDashboardOwner(owner, item.owner)) return item;
  }

  get(owner: DashboardOwner, id: string): AttachedDashboard | undefined {
    const item = this.find(owner, id);
    return item && structuredClone(item);
  }

  async attach(
    owner: DashboardOwner,
    input: string,
    signal?: AbortSignal,
  ): Promise<AttachedDashboard> {
    return this.observe(
      dashboardOwnerSchema.parse(owner),
      explicitOrigin(input),
      undefined,
      signal,
    );
  }

  async revalidate(
    owner: DashboardOwner,
    id: string,
    signal?: AbortSignal,
  ): Promise<AttachedDashboard> {
    const checked = dashboardOwnerSchema.parse(owner);
    const item = this.find(checked, id);
    if (!item) throw unavailable();
    // Neither the origin nor the expected AFM ID comes from the refresh request.
    return this.observe(checked, item.url, id, signal);
  }

  private async observe(
    owner: DashboardOwner,
    url: string,
    expectedId: string | undefined,
    signal?: AbortSignal,
  ): Promise<AttachedDashboard> {
    if (this.disposed || signal?.aborted) throw unavailable();
    const previous = this.entries.get(url);
    if (previous && !sameDashboardOwner(previous.owner, owner))
      throw wrongOwner();
    for (const other of this.pending)
      if (other.url === url && !sameDashboardOwner(other.owner, owner))
        throw wrongOwner();
    const request = { url, owner, controller: new AbortController() };
    this.pending.add(request);
    const cancel = signal
      ? AbortSignal.any([request.controller.signal, signal])
      : request.controller.signal;
    try {
      const { terminal, ...metadata } = await readDashboardStatus(
        url,
        cancel,
        this.fetcher,
      );
      if (cancel.aborted || this.disposed) throw unavailable();
      const current = this.entries.get(url);
      if (expectedId && current?.id !== expectedId) throw unavailable();
      if (current && current.runId !== metadata.runId) throw replaced();
      if (!expectedId && terminal)
        throw Error(
          "Этот конвейер уже завершён. Укажите адрес работающего запуска.",
        );
      const item = {
        id: current?.id ?? "attached:" + randomUUID(),
        owner,
        url,
        ...metadata,
      };
      this.entries.set(url, item);
      return structuredClone(item);
    } finally {
      this.pending.delete(request);
    }
  }

  detach(owner: DashboardOwner, id: string): void {
    const item = this.find(owner, id);
    if (!item) return;
    this.entries.delete(item.url);
    for (const other of this.pending)
      if (other.url === item.url) other.controller.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    for (const other of this.pending) other.controller.abort();
    this.pending.clear();
  }
}
