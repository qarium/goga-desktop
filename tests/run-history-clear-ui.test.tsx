// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ContextRuns } from "../src/renderer/ContextRuns";
import type { RunWithContext } from "../src/renderer/topic-context";
import type { ClearRunHistoryResult } from "../src/shared/run-history";

const owner = {
  projectId: "p",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "123e4567-e89b-42d3-a456-426614174000",
  year: "2026",
  topic: "alpha",
  branch: "feature/alpha",
};
const run = (
  id: string,
  overrides: Partial<RunWithContext> = {},
): RunWithContext => ({
  id,
  projectId: "p",
  pipeline: id,
  topic: "alpha",
  branch: "feature/alpha",
  context: owner,
  status: "exited",
  startedAt: "2026-11-17T12:00:00Z",
  workflow: null,
  profile: null,
  ...overrides,
});
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);

it("places cleanup beside attach, confirms only eligible current-section IDs, and never includes later arrivals", async () => {
  const clear = vi.fn(async () => ({
    removedRunIds: ["done", "failed"],
    retained: [],
  }));
  const rows = [
    run("done"),
    run("failed", { status: "failed" }),
    run("active", { status: "running" }),
    run("pending", { syncPending: true }),
    run("unknown", { recovery: "unverified" }),
    run("build", { kind: "build" }),
    run("foreign", {
      context: { ...owner, contextId: `ctx-${"b".repeat(64)}` },
    }),
  ];
  const props = {
    runs: rows,
    context: owner,
    onOpen: vi.fn(),
    onAttach: vi.fn(),
    onClearHistory: clear,
  };
  const view = render(<ContextRuns {...props} />);
  const button = screen.getByRole("button", { name: "Очистить историю…" });
  expect(button.parentElement).toBe(
    screen.getByRole("button", { name: "Подключить конвейер" }).parentElement,
  );
  fireEvent.click(button);
  const dialog = screen.getByRole("dialog", {
    name: "Очистить историю конвейеров?",
  });
  expect(within(dialog).getByText("Записей к удалению: 2")).toBeTruthy();
  view.rerender(
    <ContextRuns {...props} runs={[...rows, run("newly-finished")]} />,
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Очистить историю" }),
  );
  await waitFor(() =>
    expect(clear).toHaveBeenCalledExactlyOnceWith({
      scope: owner,
      kind: "pipeline",
      runIds: ["done", "failed"],
    }),
  );
  expect(await screen.findByText("Удалено записей: 2.")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("uses the primary scope and build section, supports cancelling and disables empty cleanup", async () => {
  const clear = vi.fn(async () => ({ removedRunIds: ["build"], retained: [] }));
  render(
    <ContextRuns
      runs={[
        run("build", { context: undefined, topic: "", kind: "build" }),
        run("other-project", {
          context: undefined,
          projectId: "q",
          kind: "build",
        }),
      ]}
      context={null}
      primaryProjectId="p"
      onOpen={vi.fn()}
      onClearHistory={clear}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Очистить историю…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(clear).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Очистить историю",
    }),
  );
  await waitFor(() =>
    expect(clear).toHaveBeenCalledExactlyOnceWith({
      scope: "p",
      kind: "build",
      runIds: ["build"],
    }),
  );
});

it("uses local progress without a blocking modal and ignores late feedback after a section change", async () => {
  let finish!: (value: ClearRunHistoryResult) => void;
  const clear = vi.fn(
    () =>
      new Promise<ClearRunHistoryResult>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <ContextRuns
      runs={[run("done"), run("build", { kind: "build" })]}
      context={owner}
      onOpen={vi.fn()}
      onClearHistory={clear}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Очистить историю",
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Очищаем историю…")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Сборка" }));
  await act(async () => finish({ removedRunIds: ["done"], retained: [] }));
  expect(screen.queryByText("Удалено записей: 1.")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Сборка" }).getAttribute("aria-pressed"),
  ).toBe("true");
});

it("reports partial retention and readable save failures without clearing or stopping additional runs", async () => {
  const clear = vi
    .fn()
    .mockRejectedValueOnce(
      Error(
        "Error invoking remote method 'goga:clear-run-history': Error: Не удалось сохранить историю.",
      ),
    )
    .mockResolvedValue({
      removedRunIds: [],
      retained: [{ id: "done", reason: "pending-sync" }],
    });
  render(
    <ContextRuns
      runs={[run("done")]}
      context={owner}
      onOpen={vi.fn()}
      onClearHistory={clear}
    />,
  );
  const confirm = () => {
    fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Очистить историю",
      }),
    );
  };
  confirm();
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Не удалось сохранить историю.",
  );
  confirm();
  expect(await screen.findByText(/Сохранено записей: 1/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Открыть запуск done" }),
  ).toBeTruthy();
  expect(clear).toHaveBeenCalledTimes(2);
});
