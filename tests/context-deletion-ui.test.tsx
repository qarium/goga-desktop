// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { ContextDeletionAction } from "../src/renderer/ContextDeletionAction";
const owner = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
afterEach(cleanup);
it("blocks the selected topic and confirms clone plus topic removal with a frozen token", async () => {
  const api: any = {
    prepareContextDeletion: vi.fn(async () => ({
      token: "delete-a",
      contextId: owner.contextId,
      stage: "prepared",
      details: ["Удалить топик a", "Удалить автономный клон"],
    })),
    deleteContext: vi.fn(async () => ({
      status: "partial",
      message: "Осталась запись восстановления",
      stage: "clone-trashed",
    })),
  };
  window.goga = api;
  const view = render(
    <ContextDeletionAction
      owner={owner}
      current
      active={false}
      onDeleted={() => {}}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Удалить топик и копию…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  view.rerender(
    <ContextDeletionAction
      owner={owner}
      current={false}
      active={false}
      onDeleted={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Удалить топик и копию…" }),
  );
  await screen.findByText("Удалить автономный клон");
  expect(api.deleteContext).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить удаление" }));
  await waitFor(() =>
    expect(api.deleteContext).toHaveBeenCalledWith({
      projectId: "p",
      token: "delete-a",
    }),
  );
  expect(
    await screen.findByText(/Осталась запись восстановления/),
  ).toBeTruthy();
  expect(screen.queryByText("Топик и копия удалены")).toBeNull();
});
it("keeps a partial deletion token for explicitly confirmed retry instead of preparing a new deletion", async () => {
  const api: any = {
    contextDeletionRecovery: vi.fn(async () => null),
    prepareContextDeletion: vi.fn(async () => ({
      token: "same-token",
      contextId: owner.contextId,
      stage: "prepared",
      details: ["Clone and topic"],
    })),
    deleteContext: vi
      .fn()
      .mockResolvedValueOnce({
        status: "partial",
        message: "Retry required",
        stage: "clone-trashed",
      })
      .mockResolvedValueOnce({ status: "success", message: "Deleted" }),
  };
  window.goga = api;
  const onDeleted = vi.fn();
  render(
    <ContextDeletionAction
      owner={owner}
      current={false}
      active={false}
      onDeleted={onDeleted}
    />,
  );
  await waitFor(() =>
    expect(api.contextDeletionRecovery).toHaveBeenCalledWith(owner),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Удалить топик и копию…" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Подтвердить удаление" }),
  );
  await screen.findByText(/Retry required/);
  fireEvent.click(screen.getByRole("button", { name: "Повторить удаление" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  expect(api.prepareContextDeletion).toHaveBeenCalledTimes(1);
  expect(api.deleteContext.mock.calls).toEqual([
    [{ projectId: "p", token: "same-token" }],
    [{ projectId: "p", token: "same-token" }],
  ]);
});
it("restores the unfinished deletion journal after remount and retries its immutable token", async () => {
  const api: any = {
    contextDeletionRecovery: vi.fn(async () => ({
      token: "journal-token",
      contextId: owner.contextId,
      stage: "clone-trashed",
      details: ["Восстановление незавершённого удаления"],
    })),
    prepareContextDeletion: vi.fn(),
    deleteContext: vi.fn(async () => ({
      status: "success",
      message: "Deleted",
    })),
  };
  window.goga = api;
  render(
    <ContextDeletionAction
      owner={owner}
      current={false}
      active={false}
      onDeleted={() => {}}
    />,
  );
  await screen.findByText("Восстановление незавершённого удаления");
  expect(api.deleteContext).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Повторить удаление" }));
  await waitFor(() =>
    expect(api.deleteContext).toHaveBeenCalledWith({
      projectId: "p",
      token: "journal-token",
    }),
  );
  expect(api.prepareContextDeletion).not.toHaveBeenCalled();
});
