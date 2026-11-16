import { AttachedDashboards } from "./attached-dashboards";
import {
  sameDashboardOwner,
  type AttachedDashboard,
  type DashboardOwner,
} from "../shared/attached-dashboard";
import type { ScopeRef } from "../shared/context";
import type { HostService } from "../host/service";
import type { DashboardViews } from "./views";
import {
  allowedDashboardURL,
  dashboardRecoveryAllowed,
} from "../shared/dashboard-connection";

const ownerOf = (scope: ScopeRef): DashboardOwner =>
  typeof scope === "string"
    ? { projectId: scope }
    : { projectId: scope.projectId, context: scope };
export type ConnectedPanel =
  | { kind: "managed"; id: string }
  | { kind: "attached"; panel: AttachedDashboard };
type AttachFlight = {
  key: string;
  owner: DashboardOwner;
  controller: AbortController;
  tentative?: AttachedDashboard;
};

/** External pages are presentation only: never register a child, process lease,
 * notification owner, launch blocker or recovery record in HostService. */
export class WindowDashboards {
  readonly registry = new AttachedDashboards();
  private published = new Map<string, AttachedDashboard>();
  private flight: AttachFlight | null = null;
  // The native view returns a boolean. Retain only the registry's bounded,
  // user-facing pin diagnosis, scoped to this exact local registration.
  private pinErrors = new Map<string, Error>();
  private disposed = false;
  constructor(
    private host: HostService,
    private views: DashboardViews,
    private changed: (rows: AttachedDashboard[]) => void,
  ) {}
  list() {
    return [...this.published.values()];
  }
  private publish() {
    if (!this.disposed) this.changed(this.list());
  }
  reconcile(runs:readonly {id:string}[] = this.host.runCatalog()) {
    this.views.reconcile([
      ...runs.map((r) => r.id),
      ...this.registry.all().map((r) => r.id),
    ]);
  }
  async opened(id: string, url: string) {
    const row = this.registry.all().find((r) => r.id === id);
    if (!row || row.url !== new URL(url).origin) return false;
    await this.verify(row);
    return !this.disposed && !!this.registry.get(row.owner, id);
  }
  private async verify(row: AttachedDashboard) {
    try {
      return await this.registry.revalidate(
        row.owner,
        row.id,
        this.flight?.tentative?.id === row.id
          ? this.flight.controller.signal
          : undefined,
      );
    } catch (error) {
      if (error instanceof Error && this.registry.get(row.owner, row.id))
        this.pinErrors.set(row.id, error);
      throw error;
    }
  }
  private releaseTentative(flight: AttachFlight) {
    const row = flight.tentative;
    if (!row) return;
    flight.tentative = undefined;
    this.views.remove(row.id);
    this.registry.detach(row.owner, row.id);
    this.pinErrors.delete(row.id);
  }
  async connect(
    scope: ScopeRef,
    url: string,
    key: string,
  ): Promise<ConnectedPanel> {
    if (this.flight || this.disposed)
      throw Error("Подключение уже выполняется или окно закрыто.");
    const owner = ownerOf(scope);
    const controller = new AbortController(),
      flight: AttachFlight = { key, owner, controller };
    this.flight = flight;
    let result: ConnectedPanel | undefined;
    const check = () => {
      if (controller.signal.aborted || this.disposed)
        throw Error("Подключение отменено.");
    };
    try {
      await this.host.withDemonstrationOwner(scope, async () => {
        check();
        const row = await this.registry.attach(owner, url, controller.signal);
        const existing = this.published.has(row.id);
        if (!existing) flight.tentative = row;
        this.pinErrors.delete(row.id);
        check();
        // An existing observation can never become a process-control capability.
        if (existing) {
          this.published.set(row.id, row);
          this.publish();
          result = { kind: "attached", panel: row };
          return;
        }
        const managed = this.host
          .runCatalog()
          .find(
            (r) =>
              r.kind !== "build" &&
              r.status === "running" &&
              dashboardRecoveryAllowed(r) &&
              !!r.url &&
              allowedDashboardURL(r.url) &&
              new URL(r.url).origin === row.url &&
              r.dashboardReconnect &&
              r.dashboardRunId === row.runId,
          );
        if (managed) {
          if (
            !sameDashboardOwner(owner, {
              projectId: managed.projectId,
              context: managed.context,
            })
          )
            throw Error(
              "Этот управляемый запуск открыт в другой рабочей области.",
            );
          this.registry.detach(owner, row.id);
          flight.tentative = undefined;
          result = { kind: "managed", id: managed.id };
          return;
        }
        this.reconcile();
        if (!(await this.views.restore(row.id, row.url)))
          throw (
            this.pinErrors.get(row.id) ??
            Error(
              "Не удалось открыть подтверждённую панель. Проверьте, что конвейер всё ещё работает.",
            )
          );
        check();
        const loaded = this.registry.get(owner, row.id);
        if (!loaded) throw Error("Панель была отключена.");
        this.published.set(row.id, loaded);
        flight.tentative = undefined;
        this.publish();
        result = { kind: "attached", panel: loaded };
      });
      if (!result) throw Error("Не удалось подтвердить подключение.");
      return result;
    } catch (e) {
      this.releaseTentative(flight);
      check();
      throw e;
    } finally {
      if (this.flight?.controller === controller) this.flight = null;
    }
  }
  cancel(key: string) {
    const flight = this.flight;
    if (!flight || flight.key !== key) return;
    this.flight = null;
    flight.controller.abort();
    this.releaseTentative(flight);
  }
  require(scope: ScopeRef, id: string) {
    const row = this.registry.get(ownerOf(scope), id);
    if (!row || !this.published.has(id))
      throw Error("Панель не подключена к этой рабочей области.");
    return row;
  }
  select(scope: ScopeRef, id: string) {
    this.require(scope, id);
    this.views.select(id);
  }
  detach(scope: ScopeRef, id: string) {
    const row = this.require(scope, id);
    this.views.remove(id);
    this.registry.detach(row.owner, id);
    this.published.delete(id);
    this.pinErrors.delete(id);
    this.publish();
  }
  forgetProject(id: string) {
    if (this.flight?.owner.projectId === id) this.cancel(this.flight.key);
    for (const row of this.list())
      if (row.owner.projectId === id)
        this.detach(row.owner.context ?? id, row.id);
  }
  async refresh(scope: ScopeRef, id: string, recover: boolean) {
    const row = this.require(scope, id);
    if (!this.views.isTarget(id)) throw Error("Эта панель сейчас не выбрана.");
    this.pinErrors.delete(id);
    const check = async () => {
      await this.verify(row);
      return this.published.has(id);
    };
    const ok =
      recover && this.views.needsRestore(id)
        ? (await check()) &&
          this.views.isTarget(id) &&
          (await this.views.restore(id, row.url))
        : await this.views.refresh(id, check);
    if (!ok)
      throw (
        this.pinErrors.get(id) ??
        Error(
          "Не удалось обновить панель этого запуска. Процесс не перезапускался.",
        )
      );
    if (this.published.has(id)) {
      const next = this.registry.get(row.owner, id);
      if (next) {
        this.published.set(id, next);
        this.publish();
      }
    }
  }
  dispose() {
    this.disposed = true;
    if (this.flight) this.cancel(this.flight.key);
    this.registry.dispose();
    this.published.clear();
    this.pinErrors.clear();
  }
}
