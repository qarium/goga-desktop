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
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("revokes the viewed run before a delayed native detach; receiving an event on Home never reads it", async () => {
  const snapshot = (count: number): NotificationSnapshot => ({
    revision: count + 1,
    records: [],
    throughSequence: count,
    hasMore: false,
    unreadCount: count,
    byProject: { p: count },
    unreadRunIds: count ? ["r"] : [],
    systemEnabled: false,
  });
  const run = {
    id: "r",
    projectId: "p",
    pipeline: "editor",
    topic: "",
    branch: "main",
    status: "running",
    workflow: null,
    profile: null,
    startedAt: "2026-11-01T12:00:00.000Z",
    url: "http://127.0.0.1:4999",
    dashboardOpened: true,
    output: { text: "", truncated: false },
  };
  let receive!: (s: NotificationSnapshot) => void,
    release!: () => void,
    hold = false;
  const setView = vi.fn(async (_id: string | null) => {}),
    markRead = vi.fn(),
    complete = vi.fn(),
    markAll = vi.fn();
  const select = vi.fn((id: string | null) =>
    !id && hold
      ? new Promise<void>((r) => {
          release = r;
        })
      : Promise.resolve(),
  );
  window.goga = {
    listProjects: async () => [
      { id: "p", name: "Synthetic", path: "/fixture/p" },
    ],
    runs: async () => [run],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: select,
    setNotificationView: setView,
    notifications: async () => snapshot(0),
    onNotifications: (fn: typeof receive) => {
      receive = fn;
      return () => {};
    },
    markNotificationRead: markRead,
    markAllNotificationsRead: markAll,
    completeNotificationOpen: complete,
  } as any;
  const { container } = render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "editor" }));
  await waitFor(() => expect(setView).toHaveBeenLastCalledWith("r"));
  hold = true;
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "Главная",
    }),
  );
  await screen.findByRole("heading", { name: "Главная" });
  expect(select).toHaveBeenLastCalledWith(null);
  expect(setView).toHaveBeenLastCalledWith(null);
  const calls = setView.mock.calls.length;
  act(() => receive(snapshot(1)));
  await waitFor(() =>
    expect(
      container.querySelector("[data-project-unread='p']")?.textContent,
    ).toBe("1"),
  );
  await act(async () => release());
  expect(setView.mock.calls.slice(calls)).not.toContainEqual(["r"]);
  expect(markRead).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
  expect(markAll).not.toHaveBeenCalled();
});
