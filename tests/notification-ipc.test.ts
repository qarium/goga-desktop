import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { NotificationCenter } from "../src/host/notifications/store";
import { NotificationMonitor } from "../src/main/notification-monitor";
import { NotificationDelivery } from "../src/main/notification-delivery";
import {
  NotificationNavigation,
  installNotificationViewLifecycle,
  notificationWindowForeground,
  registerNotificationIPC,
} from "../src/main/notification-ipc";
const run: any = {
  id: "r",
  projectId: "p",
  pipeline: "editor",
  topic: "slug",
  branch: "feat",
  status: "running",
  url: "http://127.0.0.1:4999",
  startedAt: "2026-11-01T12:00:00.000Z",
};
const record: any = {
  id: "n",
  sequence: 1,
  runId: "r",
  projectId: "p",
  pipeline: "editor",
  topic: "slug",
  branch: "feat",
  stageId: "worker",
  kind: "question",
  occurredAt: run.startedAt,
  readAt: null,
};
function setup() {
  const center: any = {
    find: () => ({ ...record }),
    snapshot: () => ({ revision: 1 }),
    markRead: vi.fn(async () => ({ revision: 2 })),
    markAllRead: vi.fn(),
    setSystemEnabled: vi.fn(),
  };
  const d = {
    center,
    runs: () => [run],
    isSelected: vi.fn(() => true),
    focusStage: vi.fn(async () => true),
  };
  return { center, d, nav: new NotificationNavigation(d) };
}
it("only marks the captured event after selecting the exact stage", async () => {
  const { nav, center, d } = setup();
  const t = nav.prepare("n");
  expect(center.markRead).not.toHaveBeenCalled();
  await nav.complete(t.ticket);
  expect(d.focusStage).toHaveBeenCalledWith("r", "worker");
  expect(center.markRead).toHaveBeenCalledWith("n", 1);
  await expect(nav.complete(t.ticket)).rejects.toThrow();
});
it("keeps unread on failed selection or lost owner", async () => {
  const { nav, center, d } = setup();
  const t = nav.prepare("n");
  d.focusStage.mockResolvedValue(false);
  await expect(nav.complete(t.ticket)).rejects.toThrow(/стади/);
  expect(center.markRead).not.toHaveBeenCalled();
  const t2 = nav.prepare("n");
  d.isSelected.mockReturnValue(false);
  await expect(nav.complete(t2.ticket)).rejects.toThrow();
  expect(center.markRead).not.toHaveBeenCalled();
});
it("does not consume a newer version after a slow stage navigation", async () => {
  const { nav, center, d } = setup();
  const t = nav.prepare("n");
  d.focusStage.mockImplementation(async () => {
    center.find = () => ({ ...record, sequence: 2 });
    return true;
  });
  await nav.complete(t.ticket);
  expect(center.markRead).not.toHaveBeenCalled();
});
it("denies non-shell senders and validates ids and sequence bounds", async () => {
  const { center, nav } = setup();
  const handlers = new Map<string, Function>();
  registerNotificationIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      center,
      navigation: nav,
      window: { webContents: { id: 1 } },
      shellURL: "file:///shell",
    } as any,
  );
  const e = {
    sender: { id: 1 },
    senderFrame: { parent: null, url: "file:///shell" },
  };
  expect(() =>
    handlers.get("goga:mark-notification-read")!(
      { ...e, sender: { id: 2 } },
      "n",
    ),
  ).toThrow(/запрещ/);
  expect(() =>
    handlers.get("goga:mark-all-notifications-read")!(e, -1),
  ).toThrow();
  expect(() =>
    handlers.get("goga:prepare-notification-open")!(e, { id: "n" }),
  ).toThrow();
  await handlers.get("goga:mark-notification-read")!(e, "n");
  expect(center.markRead).toHaveBeenCalledWith("n");
});
it("a new navigation cancels and fences an older pending stage selection", async () => {
  const { center, d } = setup();
  let release!: (value: boolean) => void;
  const cancelStage = vi.fn();
  const nav = new NotificationNavigation({ ...d, cancelStage });
  d.focusStage.mockImplementation(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const first = nav.prepare("n");
  const pending = nav.complete(first.ticket);
  const rejected = expect(pending).rejects.toThrow(/отмен/);
  nav.prepare("n");
  release(true);
  await rejected;
  expect(cancelStage).toHaveBeenCalledTimes(2);
  expect(center.markRead).not.toHaveBeenCalled();
});
it("returns the same health-enriched snapshot from reads and every snapshot mutation", async () => {
  const { center } = setup();
  const handlers = new Map<string, Function>();
  const healthyState = {
    revision: 2,
    error: "Обновление уведомлений временно недоступно. История сохранена.",
  };
  const getSnapshot = vi.fn(() => healthyState);
  registerNotificationIPC(
    { handle: (key: string, fn: Function) => handlers.set(key, fn) } as any,
    {
      center,
      navigation: { complete: vi.fn(async () => ({ revision: 2 })) },
      window: { webContents: { id: 1 } },
      shellURL: "file:///shell",
      getSnapshot,
    } as any,
  );
  const e = {
    sender: { id: 1 },
    senderFrame: { parent: null, url: "file:///shell" },
  };
  for (const [operation, args] of [
    ["notifications", [{}]],
    ["mark-notification-read", ["n", 1]],
    ["mark-all-notifications-read", [1]],
    ["set-system-notifications", [true]],
    ["complete-notification-open", ["00000000-0000-4000-8000-000000000001"]],
  ] as const) {
    expect(await handlers.get(`goga:${operation}`)!(e, ...args)).toEqual(
      healthyState,
    );
  }
  expect(getSnapshot).toHaveBeenCalledTimes(5);
});

function viewingSetup() {
  const rows = [
    { ...record },
    { ...record, id: "other", runId: "other", sequence: 2 },
  ];
  let focused = false;
  let current = { ...run };
  const center: any = {
    snapshot: () => ({ throughSequence: 2 }),
    markMatchingRead: vi.fn(async (_sequence, match) => {
      for (const row of rows) if (match(row)) row.readAt = "read";
    }),
  };
  const isSelected = vi.fn(() => true);
  const nav = new NotificationNavigation({
    center,
    runs: () => [current],
    isSelected,
    focusStage: vi.fn(),
    isForeground: () => focused,
  });
  return {
    nav,
    rows,
    center,
    isSelected,
    focus: (value: boolean) => {
      focused = value;
    },
    changeRun: (value: any) => {
      current = value;
    },
  };
}
it("reads only the viewed run backlog on foreground return and recognizes its live arrivals", async () => {
  const f = viewingSetup();
  await f.nav.setViewedRun("r");
  expect(f.center.markMatchingRead).not.toHaveBeenCalled();
  expect(f.nav.isViewingRecord(record)).toBe(false);
  f.focus(true);
  await f.nav.readViewed();
  expect(f.center.markMatchingRead).toHaveBeenCalledWith(
    2,
    expect.any(Function),
  );
  expect(f.rows[0].readAt).toBe("read");
  expect(f.rows[1].readAt).toBeNull();
  expect(f.nav.isViewingRecord(record)).toBe(true);
  f.focus(false);
  expect(f.nav.isViewingRecord(record)).toBe(false);
});
it("does not treat a selected but hidden or unloaded native run as viewed", async () => {
  const f = viewingSetup();
  f.focus(true);
  f.isSelected.mockReturnValue(false);
  await f.nav.setViewedRun("r");
  expect(f.center.markMatchingRead).not.toHaveBeenCalled();
  expect(f.nav.isViewingRecord(record)).toBe(false);
  expect(f.rows[0].readAt).toBeNull();
});
it("allows mounted terminal history without a native dashboard but never a changed owner", async () => {
  const f = viewingSetup();
  f.focus(true);
  f.changeRun({ ...run, status: "exited", url: null });
  f.isSelected.mockReturnValue(false);
  await f.nav.setViewedRun("r");
  expect(f.rows[0].readAt).toBe("read");
  f.changeRun({ ...run, startedAt: "2026-11-02T12:00:00.000Z" });
  expect(f.nav.isViewingRecord(record)).toBe(false);
  for (const change of [
    { projectId: "foreign" },
    { branch: "foreign" },
    { topic: "foreign" },
    { pipeline: "foreign" },
  ])
    expect(f.nav.isViewingRecord({ ...record, ...change })).toBe(false);
});
it("revokes pending backlog reads after view changes instead of consuming late events", async () => {
  const f = viewingSetup();
  f.focus(true);
  let execute!: () => void;
  f.center.markMatchingRead.mockImplementation(
    (_sequence: number, matches: any) =>
      new Promise<void>((done) => {
        execute = () => {
          for (const row of f.rows) if (matches(row)) row.readAt = "read";
          done();
        };
      }),
  );
  const pending = f.nav.setViewedRun("r");
  await f.nav.setViewedRun(null);
  execute();
  await pending;
  expect(f.rows.every((r) => r.readAt === null)).toBe(true);
});

it("native focus reads the open run; shell reload/crash revokes viewing and cleanup removes listeners", async () => {
  const f = viewingSetup();
  const win = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(),
  });
  const dispose = installNotificationViewLifecycle(win as any, f.nav);
  await f.nav.setViewedRun("r");
  f.focus(true);
  win.emit("focus");
  await vi.waitFor(() => expect(f.rows[0].readAt).toBe("read"));
  for (const event of ["did-start-loading", "render-process-gone"]) {
    await f.nav.setViewedRun("r");
    expect(f.nav.isViewingRecord(record)).toBe(true);
    win.webContents.emit(event);
    expect(f.nav.isViewingRecord(record)).toBe(false);
  }
  dispose();
  expect(win.listenerCount("focus")).toBe(0);
  expect(win.webContents.listenerCount("did-start-loading")).toBe(0);
  expect(win.webContents.listenerCount("render-process-gone")).toBe(0);
});

it("uses one durable read state for foreground arrivals, focus-return backlog, UI and Dock", async () => {
  const root = await mkdtemp("/private/tmp/goga-notifications-viewed-");
  try {
    const center = new NotificationCenter(root);
    await center.initialize();
    let focused = false;
    const nav = new NotificationNavigation({
      center,
      runs: () => [run],
      isSelected: () => true,
      focusStage: vi.fn(),
      isForeground: () => focused,
    });
    const badge = vi.fn(),
      create = vi.fn();
    const delivery = new NotificationDelivery({
      create,
      badge,
      open: vi.fn(),
      isViewing: (id) => nav.isViewing(id),
      find: (id) => center.find(id),
      onError: vi.fn(),
    });
    const counts: number[] = [];
    center.onChanged((s, added) => {
      counts.push(s.unreadCount);
      delivery.update(s, added);
    });
    const { sequence: _sequence, readAt: _readAt, ...input } = record;
    await nav.setViewedRun("r");
    await center.add(input, () => nav.isViewingRecord(input));
    await center.add(
      { ...input, id: "foreign", runId: "foreign" },
      () => false,
    );
    expect(counts).toEqual([1, 2]);
    focused = true;
    const win = Object.assign(new EventEmitter(), {
      webContents: new EventEmitter(),
    });
    const dispose = installNotificationViewLifecycle(win as any, nav);
    win.emit("focus");
    await vi.waitFor(() => expect(center.snapshot().unreadCount).toBe(1));
    const live = { ...input, id: "new-in-foreground" };
    const added = await center.add(live, () => nav.isViewingRecord(live));
    expect(added?.readAt).not.toBeNull();
    expect(counts).toEqual([1, 2, 1, 1]);
    expect(badge.mock.calls.map(([count]) => count)).toEqual([
      "1",
      "2",
      "1",
      "1",
    ]);
    expect(create).not.toHaveBeenCalled();
    expect(center.find("foreign")?.readAt).toBeNull();
    dispose();
    delivery.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("matches exact topic context and revision for automatic viewing", async () => {
  const f = viewingSetup();
  f.focus(true);
  const context = {
    projectId: "p",
    year: "2026",
    topic: "slug",
    branch: "feat",
    contextId: `ctx-${"a".repeat(64)}`,
    revision: "00000000-0000-4000-8000-000000000001",
  };
  f.changeRun({ ...run, context });
  await f.nav.setViewedRun("r");
  expect(f.nav.isViewingRecord({ ...record, context })).toBe(true);
  for (const change of [
    { contextId: `ctx-${"b".repeat(64)}` },
    { revision: "00000000-0000-4000-8000-000000000002" },
    { year: "2025" },
  ])
    expect(
      f.nav.isViewingRecord({ ...record, context: { ...context, ...change } }),
    ).toBe(false);
  expect(f.nav.isViewingRecord(record)).toBe(false);
});

it("requires a focused visible non-minimized window with a live loaded shell", () => {
  const win = {
    isDestroyed: vi.fn(() => false),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    isFocused: vi.fn(() => true),
    webContents: {
      isDestroyed: vi.fn(() => false),
      isLoadingMainFrame: vi.fn(() => false),
    },
  };
  expect(notificationWindowForeground(win as any)).toBe(true);
  for (const [method, blocked] of [
    [win.isDestroyed, true],
    [win.isVisible, false],
    [win.isMinimized, true],
    [win.isFocused, false],
    [win.webContents.isDestroyed, true],
    [win.webContents.isLoadingMainFrame, true],
  ] as const) {
    const previous = method();
    method.mockReturnValue(blocked);
    expect(notificationWindowForeground(win as any)).toBe(false);
    method.mockReturnValue(previous);
  }
});

it.each([
  [true, "Review"],
  [false, "Review"],
  [true, "Re\u202eview"],
  [false, "Re\u202eview"],
] as const)(
  "reads monitor events with a display pipeline name (foreground=%s, name=%s)",
  async (initiallyFocused, pipelineName) => {
    const root = await mkdtemp("/private/tmp/goga-notifications-named-run-");
    let monitor: NotificationMonitor | undefined;
    try {
      const center = new NotificationCenter(root);
      await center.initialize();
      const current = {
        ...run,
        pipeline: "pipeline.yml",
        pipelineName,
        dashboardOpened: true,
      };
      let focused = initiallyFocused;
      const nav = new NotificationNavigation({
        center,
        runs: () => [current],
        isSelected: () => true,
        focusStage: vi.fn(),
        isForeground: () => focused,
      });
      await nav.setViewedRun(current.id);
      monitor = new NotificationMonitor({
        add: (input) => center.add(input, () => nav.isViewingRecord(input)),
        fetch: vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                run_id: "synthetic-afm",
                run_status: "running",
                stages: [
                  {
                    id: "worker",
                    status: "awaiting_user_input",
                    updated_at: run.startedAt,
                  },
                ],
              }),
            ),
        ),
        socket: () => ({ close() {} }) as unknown as WebSocket,
      });
      monitor.reconcile([current]);
      await vi.waitFor(() => expect(center.snapshot().records).toHaveLength(1));
      expect(center.snapshot().records[0].pipeline).toBe("Review");
      expect(center.snapshot().unreadCount).toBe(initiallyFocused ? 0 : 1);
      focused = true;
      await nav.readViewed();
      expect(center.snapshot().unreadCount).toBe(0);
    } finally {
      monitor?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('reads foreground arrivals for the verified same run after Desktop reconnects',async()=>{
  const f=viewingSetup();f.focus(true);
  f.changeRun({...run,recovery:'confirmed',dashboardRecoveryVersion:1,dashboardReconnect:true,dashboardRunId:'afm-1'});
  await f.nav.setViewedRun('r');
  expect(f.rows[0].readAt).toBe('read');expect(f.nav.isViewingRecord(record)).toBe(true);
  f.changeRun({...run,recovery:'confirmed'});
  expect(f.nav.isViewingRecord(record)).toBe(false);
});
