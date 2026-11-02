import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { NotificationCenter } from "../host/notifications/store";
import {
  NotificationPageRequestSchema,
  notificationPipelineLabel,
  type NotificationSnapshot,
  type NotificationInput,
} from "../shared/notifications";
import type { Run } from "../shared/types";
import { IPC_SCOPES } from "../shared/operation-scopes";
import { validShellSender } from "./security";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
function owner(run: Run) {
  return JSON.stringify([
    run.id,
    run.projectId,
    run.pipeline,
    run.startedAt,
    run.context
      ? [
          run.context.projectId,
          run.context.year,
          run.context.topic,
          run.context.branch,
          run.context.contextId,
          run.context.revision,
        ]
      : null,
    run.topic,
    run.branch,
  ]);
}
function matchesRun(n: NotificationInput, r: Run) {
  const a = n.context,
    b = r.context;
  return (
    n.runId === r.id &&
    n.projectId === r.projectId &&
    n.pipeline === notificationPipelineLabel(r) &&
    n.topic === r.topic &&
    n.branch === r.branch &&
    ((!a && !b) ||
      (!!a &&
        !!b &&
        a.projectId === b.projectId &&
        a.contextId === b.contextId &&
        a.revision === b.revision &&
        a.year === b.year &&
        a.topic === b.topic &&
        a.branch === b.branch))
  );
}

export class NotificationNavigation {
  private generation = 0;
  private viewedRun: { id: string; owner: string } | null = null;
  private tickets = new Map<
    string,
    {
      id: string;
      runId: string;
      owner: string;
      sequence: number;
      expires: number;
      generation: number;
    }
  >();
  constructor(
    private d: {
      center: NotificationCenter;
      runs: () => Run[];
      isSelected: (runId: string) => boolean;
      focusStage: (runId: string, stageId: string) => Promise<boolean>;
      cancelStage?: () => void;
      isForeground?: () => boolean;
    },
  ) {}
  async setViewedRun(id: string | null): Promise<void> {
    const run = id === null ? null : this.d.runs().find((r) => r.id === id);
    if (id !== null && !run) throw Error("Неизвестный запуск");
    this.viewedRun = run ? { id: run.id, owner: owner(run) } : null;
    await this.readViewed();
  }
  isViewing(id: string) {
    const run = this.d.runs().find((r) => r.id === id);
    if (
      !this.d.isForeground?.() ||
      !run ||
      this.viewedRun?.id !== id ||
      this.viewedRun.owner !== owner(run) ||
      run.recovery
    )
      return false;
    if (["exited", "failed", "stopped"].includes(run.status)) return true;
    return (
      run.status === "running" &&
      !!run.url &&
      run.dashboardOpened !== false &&
      this.d.isSelected(id)
    );
  }
  isViewingRecord(record: NotificationInput) {
    const run = this.d.runs().find((r) => r.id === record.runId);
    return !!run && this.isViewing(run.id) && matchesRun(record, run);
  }
  async readViewed(): Promise<void> {
    const viewed = this.viewedRun;
    if (!viewed || !this.isViewing(viewed.id)) return;
    const bound = this.d.center.snapshot().throughSequence;
    await this.d.center.markMatchingRead(
      bound,
      (record) => this.viewedRun === viewed && this.isViewingRecord(record),
    );
  }

  prepare(notificationId: string) {
    for (const [key, t] of this.tickets)
      if (t.expires <= Date.now()) this.tickets.delete(key);
    if (this.tickets.size >= 64)
      throw Error("Завершите предыдущий переход к уведомлению.");
    const n = this.d.center.find(notificationId),
      r = n && this.d.runs().find((r) => r.id === n.runId);
    if (!n || !r)
      throw Error(
        "Запуск уже закрыт. Уведомление можно отметить прочитанным отдельно.",
      );
    if (
      r.projectId !== n.projectId ||
      r.topic !== n.topic ||
      r.branch !== n.branch ||
      r.context?.contextId !== n.context?.contextId ||
      r.context?.revision !== n.context?.revision
    )
      throw Error(
        "Контекст запуска изменился. Уведомление не отмечено прочитанным.",
      );
    const ticket = randomUUID();
    this.d.cancelStage?.();
    this.generation++;
    this.tickets.clear();
    this.tickets.set(ticket, {
      id: n.id,
      runId: r.id,
      owner: owner(r),
      sequence: n.sequence,
      expires: Date.now() + 60000,
      generation: this.generation,
    });
    return { ticket, run: r, stageId: n.stageId };
  }
  async complete(ticket: string) {
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!t || t.expires <= Date.now() || t.generation !== this.generation)
      throw Error("Переход к уведомлению отменён. Откройте его снова.");
    const getRun = () => this.d.runs().find((r) => r.id === t.runId);
    let r = getRun();
    const n = this.d.center.find(t.id);
    if (!n || !r || owner(r) !== t.owner)
      throw Error("Запуск или его контекст уже недоступен.");
    const live = () =>
      !!r &&
      r.status === "running" &&
      !!r.url &&
      !r.recovery &&
      r.dashboardOpened !== false;
    if (live()) {
      if (!this.d.isSelected(r.id))
        throw Error("Нужный запуск не открыт. Уведомление не прочитано.");
      if (n.stageId && !(await this.d.focusStage(r.id, n.stageId)))
        throw Error(
          "Не удалось открыть стадию. Уведомление не отмечено прочитанным.",
        );
      r = getRun();
      if (!r || owner(r) !== t.owner || (live() && !this.d.isSelected(r.id)))
        throw Error("Переход к уведомлению отменён.");
    }
    if (t.generation !== this.generation)
      throw Error("Переход к уведомлению отменён.");
    if (this.d.center.find(t.id)?.sequence !== t.sequence)
      return this.d.center.snapshot();
    return this.d.center.markRead(t.id, t.sequence);
  }
}
export function notificationWindowForeground(
  win: Pick<
    BrowserWindow,
    "isDestroyed" | "isVisible" | "isMinimized" | "isFocused" | "webContents"
  >,
) {
  return (
    !win.isDestroyed() &&
    win.isVisible() &&
    !win.isMinimized() &&
    win.isFocused() &&
    !win.webContents.isDestroyed() &&
    !win.webContents.isLoadingMainFrame()
  );
}

/** Actual window focus acknowledges the already mounted screen. A shell reload
 * or crash must revoke it, even when no renderer cleanup can be delivered. */
export function installNotificationViewLifecycle(
  win: Pick<BrowserWindow, "on" | "removeListener" | "webContents">,
  navigation: NotificationNavigation,
) {
  const read = () => {
    void navigation.readViewed().catch(() => {});
  };
  const clear = () => {
    void navigation.setViewedRun(null).catch(() => {});
  };
  win.on("focus", read);
  win.webContents.on("did-start-loading", clear);
  win.webContents.on("render-process-gone", clear);
  return () => {
    win.removeListener("focus", read);
    win.webContents.removeListener("did-start-loading", clear);
    win.webContents.removeListener("render-process-gone", clear);
    clear();
  };
}

export function registerNotificationIPC(
  ipc: Pick<IpcMain, "handle">,
  d: {
    center: NotificationCenter;
    navigation: NotificationNavigation;
    window: Pick<BrowserWindow, "webContents">;
    shellURL: string;
    getSnapshot?: (
      limit: number,
      beforeSequence?: number,
    ) => NotificationSnapshot;
  },
) {
  // Mutation replies and broadcasts must carry the same transport/delivery
  // health. A raw reply at the same revision would erase a current warning.
  const updatedSnapshot = async (mutation: Promise<unknown>) => {
    await mutation;
    return d.getSnapshot ? d.getSnapshot(50) : d.center.snapshot();
  };
  const handle = (name: string, fn: (...args: any[]) => unknown) => {
    if (!Object.hasOwn(IPC_SCOPES, name))
      throw Error("IPC operation has no explicit scope classification");
    ipc.handle(`goga:${name}`, (e: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (
        !validShellSender(
          e.sender.id,
          d.window.webContents.id,
          e.senderFrame?.url ?? "",
          d.shellURL,
          e.senderFrame?.parent === null,
        )
      )
        throw Error("IPC: доступ запрещён");
      return fn(...args);
    });
  };
  handle("notifications", (value) => {
    const p = NotificationPageRequestSchema.parse(value ?? {});
    return d.getSnapshot
      ? d.getSnapshot(p.limit, p.beforeSequence)
      : d.center.snapshot(p.limit, p.beforeSequence);
  });
  handle("mark-notification-read", (value, expected) =>
    updatedSnapshot(
      expected === undefined
        ? d.center.markRead(id.parse(value))
        : d.center.markRead(id.parse(value), sequence.parse(expected)),
    ),
  );
  handle("set-notification-view", (value) =>
    d.navigation.setViewedRun(id.nullable().parse(value)),
  );
  handle("mark-all-notifications-read", (value) =>
    updatedSnapshot(d.center.markAllRead(sequence.parse(value))),
  );
  handle("set-system-notifications", (value) =>
    updatedSnapshot(d.center.setSystemEnabled(z.boolean().parse(value))),
  );
  handle("prepare-notification-open", (value) =>
    d.navigation.prepare(id.parse(value)),
  );
  handle("complete-notification-open", (value) =>
    updatedSnapshot(d.navigation.complete(z.string().uuid().parse(value))),
  );
}
