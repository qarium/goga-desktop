// @vitest-environment jsdom
import "./helpers/overview-browser-fixture";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
import type { NotificationSnapshot } from "../src/shared/notifications";
import { openFirstProject } from "./helpers/open-first-project";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("shows authoritative per-run unread counts after the title, preserves status, and removes zero without an extra action", async () => {
  const runs = ["refinement", "editor"].map((pipeline, index) => ({
    id: `r${index + 1}`,
    projectId: "p",
    pipeline,
    topic: "",
    branch: "main",
    status: "running",
    url: `http://127.0.0.1:4999/${index}`,
    dashboardOpened: true,
    startedAt: "2026-11-17T12:00:00.000Z",
    workflow: null,
    profile: null,
    output: { text: "Synthetic output", truncated: false },
  }));
  let revision = 0;
  const snapshot = (byRun: Record<string, number>): NotificationSnapshot => ({
    revision: ++revision,
    records: [],
    throughSequence: 200,
    hasMore: true,
    unreadCount: Object.values(byRun).reduce((sum, count) => sum + count, 0),
    byProject: {
      p: Object.values(byRun).reduce((sum, count) => sum + count, 0),
    },
    byRun,
    unreadRunIds: Object.keys(byRun),
    systemEnabled: false,
  });
  let receive!: (value: NotificationSnapshot) => void,
    focus!: (id: string) => void;
  const read = vi.fn(),
    readAll = vi.fn(),
    setView = vi.fn(async () => {});
  window.goga = {
    listProjects: async () => [
      { id: "p", name: "Synthetic", path: "/fixture/p" },
    ],
    runs: async () => runs,
    onRuns: () => () => {},
    onViewError: () => () => {},
    onFocusRun: (fn: typeof focus) => {
      focus = fn;
      return () => {};
    },
    selectRun: vi.fn(async () => {}),
    setNotificationView: setView,
    notifications: async () => snapshot({ r1: 3, r2: 105 }),
    onNotifications: (fn: typeof receive) => {
      receive = fn;
      return () => {};
    },
    markNotificationRead: read,
    markAllNotificationsRead: readAll,
  } as any;
  render(<App />);
  await openFirstProject();
  act(() => focus("r1"));
  act(() => focus("r2"));
  const first = await screen.findByRole("tab", { name: /^refinement ·/ });
  const second = screen.getByRole("tab", { name: /^editor ·/ });
  await waitFor(() =>
    expect(first.querySelector(".run-notification-count")?.textContent).toBe(
      "3",
    ),
  );
  const badge = within(first).getByLabelText("Непрочитанных уведомлений: 3");
  expect(badge.previousElementSibling?.firstChild?.textContent).toBe("refinement");
  expect(badge.previousElementSibling?.querySelector("small")?.textContent).toBe("Без топика");
  expect(second.querySelector(".run-notification-count")?.textContent).toBe(
    "99+",
  );
  expect(
    within(second).getByLabelText("Непрочитанных уведомлений: 105"),
  ).toBeTruthy();
  expect(first.querySelectorAll(".status-dot.running")).toHaveLength(1);
  expect(first.querySelector(".run-unread-marker")).toBeNull();
  expect(first.getAttribute("aria-describedby")).toBe(badge.id);
  fireEvent.click(first);
  await waitFor(() => expect(setView).toHaveBeenLastCalledWith("r1"));
  // Reading is still owned by the host, not by a local click handler. The
  // authoritative update may arrive while an old history page is displayed.
  act(() => receive(snapshot({ r2: 2 })));
  await waitFor(() =>
    expect(first.querySelector(".run-notification-count")).toBeNull(),
  );
  expect(first.getAttribute("aria-describedby")).toBeNull();
  expect(first.querySelector(".status-dot.running")).toBeTruthy();
  expect(second.querySelector(".run-notification-count")?.textContent).toBe(
    "2",
  );
  expect(read).not.toHaveBeenCalled();
  expect(readAll).not.toHaveBeenCalled();
});
