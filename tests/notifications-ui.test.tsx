// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { NotificationBell } from "../src/renderer/notifications/Notifications";
import { useNotifications } from "../src/renderer/notifications/useNotifications";
import { App } from "../src/renderer/App";
vi.mock("../src/renderer/overview/ProjectOverview", () => ({
  ProjectOverview: () => <p>Обзор проекта</p>,
}));
vi.mock("../src/renderer/TopicContextPicker", () => ({
  TopicCreationFeedback: () => null,
  TopicContextPicker: ({ onTransitionIntent, onSelect }: any) => (
    <button
      onClick={() => {
        onTransitionIntent?.();
        onSelect({
          projectId: "p",
          year: "2026",
          topic: "beta",
          branch: "beta",
          contextId: `ctx-${"a".repeat(64)}`,
          revision: "00000000-0000-4000-8000-000000000001",
          repositoryKey: "b".repeat(64),
          projectPath: "/synthetic",
          gitCommonDir: "/synthetic/.git",
          path: "/synthetic/beta",
          ownership: "managed",
          storageKind: "clone",
          state: "ready",
        });
      }}
    >
      Выбрать контекст beta
    </button>
  ),
}));
afterEach(cleanup);
const event = (id = "n1", sequence = 1) => ({
  id,
  sequence,
  runId: "r",
  projectId: "p",
  pipeline: "editor",
  topic: "slug",
  branch: "feature",
  stageId: "worker",
  kind: "question",
  occurredAt: "2026-11-01T12:00:00.000Z",
  readAt: null,
});
const snapshot = (records = [event()]) => ({
  revision: 1,
  records,
  throughSequence: records.at(0)?.sequence ?? 0,
  hasMore: false,
  unreadCount: records.filter((e) => !e.readAt).length,
  byProject: { p: records.filter((e) => !e.readAt).length },
  unreadRunIds: records.some((e) => !e.readAt) ? ["r"] : [],
  systemEnabled: false,
});
function setup() {
  let changed: (v: any) => void = () => {};
  const api = {
    notifications: vi.fn(async () => snapshot()),
    onNotifications: vi.fn((cb) => {
      changed = cb;
      return () => {};
    }),
    markNotificationRead: vi.fn(async () => ({
      ...snapshot([{ ...event(), readAt: "2026-11-01T13:00:00.000Z" } as any]),
      revision: 2,
    })),
    markAllNotificationsRead: vi.fn(async () => ({
      ...snapshot([]),
      revision: 2,
    })),
    setSystemNotifications: vi.fn(async () => ({
      ...snapshot(),
      revision: 2,
      systemEnabled: true,
    })),
  };
  window.goga = api as any;
  const open = vi.fn(async () => {});
  function Harness() {
    const state = useNotifications();
    return (
      <NotificationBell
        controller={state}
        projects={[{ id: "p", name: "Goga", path: "/synthetic" }]}
        onOpen={open}
      />
    );
  }
  render(<Harness />);
  return { api, open, publish: (v: any) => act(() => changed(v)) };
}
it("uses one compact header action, no project filter and no implicit read", async () => {
  const { api } = setup();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /Уведомления: 1/ })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: /Уведомления: 1/ }));
  const all = screen.getByRole("button", { name: "Отметить все прочитанными" });
  expect(all.closest("header")).toBeTruthy();
  expect(all.textContent).toBe("");
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByText("Все проекты")).toBeNull();
  expect(api.markNotificationRead).not.toHaveBeenCalled();
  expect(api.markAllNotificationsRead).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть уведомления" }));
  expect(api.markNotificationRead).not.toHaveBeenCalled();
});
it("marks exactly the received sequence, retains newer arrivals and offers explicit system opt-in", async () => {
  const { api, publish } = setup();
  await screen.findByRole("button", { name: /Уведомления: 1/ });
  fireEvent.click(screen.getByRole("button", { name: /Уведомления: 1/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Отметить все прочитанными" }),
  );
  await waitFor(() =>
    expect(api.markAllNotificationsRead).toHaveBeenCalledWith(1),
  );
  publish({ ...snapshot([event("n2", 2)]), revision: 3 });
  expect(screen.getByText("Непрочитанных: 1")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Системные уведомления" }),
  );
  await waitFor(() =>
    expect(api.setSystemNotifications).toHaveBeenCalledWith(true),
  );
  expect(screen.getByText("Непрочитанных: 1")).toBeTruthy();
});
it("opening an event delegates navigation without marking it in renderer", async () => {
  const { api, open } = setup();
  await screen.findByRole("button", { name: /Уведомления: 1/ });
  fireEvent.click(screen.getByRole("button", { name: /Уведомления: 1/ }));
  fireEvent.click(
    screen.getByRole("button", {
      name: /Открыть уведомление: Нужен ваш ответ/,
    }),
  );
  await waitFor(() => expect(open).toHaveBeenCalledWith("n1"));
  expect(api.markNotificationRead).not.toHaveBeenCalled();
});
it("App routes notification to its run, exposes project badge and waits for mounted view before completion", async () => {
  const r: any = {
    id: "r",
    projectId: "p",
    pipeline: "editor",
    topic: "",
    branch: "main",
    status: "exited",
    startedAt: "2026-11-01T12:00:00.000Z",
    workflow: null,
    profile: null,
    output: { text: "Saved run output", truncated: false },
  };
  const api: any = {
    listProjects: async () => [{ id: "p", name: "Goga", path: "/synthetic" }],
    runs: async () => [r],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    notifications: async () => snapshot(),
    onNotifications: () => () => {},
    prepareNotificationOpen: vi.fn(async () => ({ ticket: "t", run: r })),
    completeNotificationOpen: vi.fn(async () => snapshot()),
    readGitSummary: async () => ({ branch: "main", changed: 0 }),
  };
  window.goga = api;
  render(<App />);
  await screen.findByRole("button", { name: "Уведомления проекта Goga: 1" });
  fireEvent.click(
    screen.getByRole("button", { name: "Уведомления проекта Goga: 1" }),
  );
  expect(api.completeNotificationOpen).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", {
      name: /Открыть уведомление: Нужен ваш ответ/,
    }),
  );
  await screen.findByText("Saved run output");
  await waitFor(() =>
    expect(api.completeNotificationOpen).toHaveBeenCalledWith("t"),
  );
  expect(api.prepareNotificationOpen).toHaveBeenCalledWith("n1");
});
it("does not mark a terminal notification before its delayed run history is mounted", async () => {
  let resolveRuns!: (value: any[]) => void;
  const r: any = {
    id: "r",
    projectId: "p",
    pipeline: "editor",
    topic: "",
    branch: "main",
    status: "exited",
    startedAt: "2026-11-01T12:00:00.000Z",
    workflow: null,
    profile: null,
    output: { text: "Delayed saved output", truncated: false },
  };
  const api: any = {
    listProjects: async () => [{ id: "p", name: "Goga", path: "/synthetic" }],
    runs: () =>
      new Promise<any[]>((resolve) => {
        resolveRuns = resolve;
      }),
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    notifications: async () => snapshot(),
    onNotifications: () => () => {},
    prepareNotificationOpen: vi.fn(async () => ({ ticket: "delayed", run: r })),
    completeNotificationOpen: vi.fn(async () => snapshot()),
    readGitSummary: async () => ({ branch: "main", changed: 0 }),
  };
  window.goga = api;
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Уведомления: 1/ }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: /Открыть уведомление: Нужен ваш ответ/,
    }),
  );
  await waitFor(() => expect(api.prepareNotificationOpen).toHaveBeenCalled());
  // Flush the guarded navigation while the Host run list is still pending.
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByText("Delayed saved output")).toBeNull();
  expect(api.completeNotificationOpen).not.toHaveBeenCalled();
  await act(async () => {
    resolveRuns([r]);
  });
  await screen.findByText("Delayed saved output");
  await waitFor(() =>
    expect(api.completeNotificationOpen).toHaveBeenCalledWith("delayed"),
  );
});
it("ignores a late notification preparation after a new topic selection intent", async () => {
  let resolve!: (value: any) => void;
  const r: any = {
    id: "r",
    projectId: "p",
    pipeline: "editor",
    topic: "",
    branch: "main",
    status: "exited",
    startedAt: "2026-11-01T12:00:00.000Z",
    workflow: null,
    profile: null,
    output: { text: "Stale notification output", truncated: false },
  };
  const api: any = {
    listProjects: async () => [{ id: "p", name: "Goga", path: "/synthetic" }],
    runs: async () => [r],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    notifications: async () => snapshot(),
    onNotifications: () => () => {},
    prepareNotificationOpen: vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    ),
    completeNotificationOpen: vi.fn(async () => snapshot()),
    readGitSummary: async () => ({ branch: "main", changed: 0 }),
  };
  window.goga = api;
  render(<App />);
  fireEvent.click(
    await screen.findByRole("button", { name: /Уведомления: 1/ }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: /Открыть уведомление: Нужен ваш ответ/,
    }),
  );
  await waitFor(() => expect(api.prepareNotificationOpen).toHaveBeenCalled());
  fireEvent.click(
    screen.getByRole("button", { name: "Выбрать контекст beta" }),
  );
  await act(async () => {
    resolve({ ticket: "late", run: r });
  });
  expect(api.completeNotificationOpen).not.toHaveBeenCalled();
  expect(screen.queryByText("Stale notification output")).toBeNull();
});

function viewedRunApp(status = "running") {
  const run: any = {
    id: "r",
    projectId: "p",
    pipeline: "editor",
    topic: "",
    branch: "main",
    status,
    startedAt: "2026-11-01T12:00:00.000Z",
    workflow: null,
    profile: null,
    ...(status === "running"
      ? { url: "http://127.0.0.1:4999", dashboardOpened: true }
      : {}),
    output: { text: "Viewed run output", truncated: false },
  };
  const api: any = {
    listProjects: async () => [{ id: "p", name: "Goga", path: "/synthetic" }],
    runs: async () => [run],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    setNotificationView: vi.fn(async () => {}),
    notifications: async () => snapshot(),
    onNotifications: () => () => {},
    readGitSummary: async () => ({ branch: "main", changed: 0 }),
  };
  window.goga = api;
  return api;
}
it.each(["running", "exited"])(
  "acknowledges viewed %s only after the run screen selection is confirmed",
  async (status) => {
    const api = viewedRunApp(status);
    let release!: () => void;
    api.selectRun.mockImplementation(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: /editor/ }));
    await waitFor(() =>
      expect(api.selectRun).toHaveBeenLastCalledWith(
        status === "running" ? "r" : null,
      ),
    );
    expect(api.setNotificationView).not.toHaveBeenCalledWith("r");
    await act(async () => release());
    await waitFor(() =>
      expect(api.setNotificationView).toHaveBeenLastCalledWith("r"),
    );
  },
);
it("does not restore a stale viewed-run acknowledgement after navigating away", async () => {
  const api = viewedRunApp();
  let release!: () => void;
  api.selectRun.mockImplementation((id: string | null) =>
    id
      ? new Promise<void>((done) => {
          release = done;
        })
      : Promise.resolve(),
  );
  render(<App />);
  fireEvent.click(await screen.findByRole("tab", { name: /editor/ }));
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith("r"));
  fireEvent.click(screen.getByRole("button", { name: "Обзор" }));
  await act(async () => release());
  expect(api.setNotificationView).not.toHaveBeenCalledWith("r");
  expect(api.setNotificationView).toHaveBeenLastCalledWith(null);
});
it("revokes viewing while the notification list covers the run and restores it on close", async () => {
  const api = viewedRunApp();
  render(<App />);
  fireEvent.click(await screen.findByRole("tab", { name: /editor/ }));
  await waitFor(() =>
    expect(api.setNotificationView).toHaveBeenLastCalledWith("r"),
  );
  fireEvent.click(screen.getByRole("button", { name: /Уведомления: 1/ }));
  await screen.findByRole("region", { name: "Список уведомлений" });
  await waitFor(() =>
    expect(api.setNotificationView).toHaveBeenLastCalledWith(null),
  );
  fireEvent.click(screen.getByRole("button", { name: "Закрыть уведомления" }));
  await waitFor(() =>
    expect(api.setNotificationView).toHaveBeenLastCalledWith("r"),
  );
});
it("never acknowledges a run whose native selection failed", async () => {
  const api = viewedRunApp();
  api.selectRun.mockImplementation(async (id: string | null) => {
    if (id) throw Error("Synthetic native failure");
  });
  const proto = HTMLDialogElement.prototype;
  Object.defineProperty(proto, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(proto, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
  try {
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: /editor/ }));
    await screen.findByRole("dialog");
    expect(api.setNotificationView).not.toHaveBeenCalledWith("r");
  } finally {
    cleanup();
    delete (proto as any).showModal;
    delete (proto as any).close;
  }
});

it("reacknowledges the same active run when its native dashboard finishes loading", async () => {
  const api = viewedRunApp();
  const initial = (await api.runs())[0];
  api.runs = async () => [{ ...initial, dashboardOpened: undefined }];
  let changed!: (runs: any[]) => void;
  api.onRuns = (cb: typeof changed) => {
    changed = cb;
    return () => {};
  };
  render(<App />);
  fireEvent.click(await screen.findByRole("tab", { name: /editor/ }));
  await waitFor(() =>
    expect(api.setNotificationView).toHaveBeenLastCalledWith("r"),
  );
  const previous = api.setNotificationView.mock.calls.filter(
    ([id]: any[]) => id === "r",
  ).length;
  act(() => changed([{ ...initial, dashboardOpened: true }]));
  await waitFor(() =>
    expect(
      api.setNotificationView.mock.calls.filter(([id]: any[]) => id === "r")
        .length,
    ).toBe(previous + 1),
  );
});
