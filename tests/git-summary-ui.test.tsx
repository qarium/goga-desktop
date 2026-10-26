// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { GitWorkspace } from "../src/renderer/GitWorkspace";
import { RetainedViews } from "../src/renderer/RetainedViews";
let api: any, portal: HTMLDivElement;
const summary = (scope = "p", changedFiles = 2) => ({
  scope,
  branch: "main",
  changedFiles,
  conflicts: 0,
});
const snapshot = {
  scope: "p",
  root: "/fixture",
  revision: "a".repeat(64),
  head: "b".repeat(40),
  branch: "main",
  upstream: null,
  ahead: 0,
  behind: 0,
  operation: "none",
  files: [],
};
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
};
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
const view = (scope = "p", open = false) => (
  <GitWorkspace
    scope={scope}
    open={open}
    bodyContainer={portal}
    onOpen={vi.fn()}
    onClose={vi.fn()}
    revision={0}
  />
);
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  portal = document.createElement("div");
  document.body.append(portal);
  api = {
    readGitSummary: vi.fn(async (scope: string) => summary(scope)),
    readGitWorkspace: vi.fn(async () => snapshot),
    readGitDiff: vi.fn(),
  };
  window.goga = api;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  portal.remove();
  vi.useRealTimers();
});
it("reads only display summary initially and refreshes badge without opening changes", async () => {
  render(view());
  await flush();
  expect(api.readGitSummary).toHaveBeenCalledTimes(1);
  expect(api.readGitWorkspace).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("2");
  api.readGitSummary.mockResolvedValue(summary("p", 3));
  await tick(3000);
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("3");
  expect(api.readGitWorkspace).not.toHaveBeenCalled();
});
it("does not re-read the editor snapshot on summary polling", async () => {
  render(view("p", true));
  await flush();
  expect(api.readGitWorkspace).toHaveBeenCalledTimes(1);
  await tick(9000);
  expect(api.readGitSummary).toHaveBeenCalledTimes(4);
  expect(api.readGitWorkspace).toHaveBeenCalledTimes(1);
});
it("never overlaps pending summary requests and finite errors are not a false zero or modal", async () => {
  api.readGitSummary.mockReturnValue(new Promise(() => {}));
  render(view());
  await flush();
  await tick(10000);
  expect(api.readGitSummary).toHaveBeenCalledTimes(1);
  await tick(20001);
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("—");
  expect(screen.queryByRole("dialog")).toBeNull();
  api.readGitSummary.mockResolvedValue(summary("p", 0));
  await tick(3000);
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("0");
});
it("ignores a late owner response and reads again when window returns", async () => {
  let old!: (value: any) => void;
  api.readGitSummary.mockImplementation((scope: string) =>
    scope === "p"
      ? new Promise((r) => (old = r))
      : Promise.resolve(summary(scope, 5)),
  );
  const mounted = render(view());
  await flush();
  mounted.rerender(view("q"));
  await flush();
  await act(async () => old(summary("p", 99)));
  await flush();
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("5");
  api.readGitSummary.mockResolvedValue(summary("q", 6));
  fireEvent(window, new Event("focus"));
  await flush();
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("6");
});
it("pauses hidden owners and hidden windows and restarts on visibility", async () => {
  const mounted = render(<RetainedViews activeKey="p">{view()}</RetainedViews>);
  await flush();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  fireEvent(document, new Event("visibilitychange"));
  await tick(9000);
  expect(api.readGitSummary).toHaveBeenCalledTimes(1);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  fireEvent(document, new Event("visibilitychange"));
  await flush();
  expect(api.readGitSummary).toHaveBeenCalledTimes(2);
  mounted.rerender(<RetainedViews activeKey={null}>{view()}</RetainedViews>);
  await tick(9000);
  expect(api.readGitSummary).toHaveBeenCalledTimes(2);
});
it("rejects wrong owners and invalid counts, then recovers without losing access", async () => {
  api.readGitSummary.mockResolvedValue(summary("wrong", 0));
  render(view());
  await flush();
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("—");
  api.readGitSummary.mockResolvedValue({ ...summary(), changedFiles: -1 });
  await tick(3000);
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("—");
  api.readGitSummary.mockResolvedValue({ ...summary(), conflicts: 1 });
  await tick(3000);
  expect(
    screen.getByRole("button", { name: /Изменения/ }).textContent,
  ).toContain("2");
  expect(
    screen
      .getByRole("button", { name: /Изменения/ })
      .getAttribute("aria-label"),
  ).toContain("конфликтов: 1");
});
it("does not reuse an old branch after an external checkout to detached HEAD", async () => {
  const mounted = render(view("p", true));
  await flush();
  expect(screen.getByLabelText("Ветка: main")).toBeTruthy();
  mounted.rerender(view());
  api.readGitSummary.mockResolvedValue({ ...summary(), branch: null });
  await tick(3000);
  expect(screen.queryByLabelText("Ветка: main")).toBeNull();
  expect(screen.getByLabelText("Ветка: HEAD (без ветки)")).toBeTruthy();
});
