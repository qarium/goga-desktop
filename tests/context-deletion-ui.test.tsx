// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render as renderUI,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { ContextDeletionAction } from "../src/renderer/ContextDeletionAction";
import { ContextDeletionProvider } from "../src/renderer/ContextDeletionController";
const render = (ui: React.ReactElement) =>
  renderUI(
    <ContextDeletionProvider
      value={async (owner, plan, allowAhead) =>
        window.goga.deleteContext({
          projectId: owner.projectId,
          token: plan.token,
          ...(allowAhead ? { allowAhead: true as const } : {}),
        })
      }
    >
      {ui}
    </ContextDeletionProvider>,
  );
const owner = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
afterEach(cleanup);
it("requires ahead consent and cancellation performs no deletion", async () => {
  const plan = {
    token: "ahead",
    contextId: owner.contextId,
    stage: "prepared",
    details: [],
    requiresAheadConfirmation: true,
    aheadCount: 2,
  };
  window.goga = { prepareContextDeletion: vi.fn(async () => plan) } as any;
  const execute = vi.fn(async () => ({
    projectId: "p",
    status: "success" as const,
    message: "Done",
  }));
  const cancel = vi.fn();
  render(
    <ContextDeletionProvider value={execute}>
      <ContextDeletionAction
        owner={owner}
        current
        active={false}
        onDeleted={() => {}}
        onCancel={cancel}
      />
    </ContextDeletionProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Удалить топик и копию…" }),
  );
  const confirm = await screen.findByRole("button", {
    name: "Подтвердить удаление",
  });
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Продолжить удаление…" }));
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить удаление" }));
  await waitFor(() => expect(execute).toHaveBeenCalledWith(owner, plan, true));
});
it("keeps active contexts blocked even when selected", () => {
  window.goga = { prepareContextDeletion: vi.fn() } as any;
  render(
    <ContextDeletionAction owner={owner} current active onDeleted={() => {}} />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Удалить топик и копию…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(window.goga.prepareContextDeletion).not.toHaveBeenCalled();
});
it("allows the selected topic and confirms clone plus topic removal with a frozen token", async () => {
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
  ).toBe(false);
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
it("requires branch selection and a fresh preview before confirming deletion", async () => {
  const prepare = vi
    .fn()
    .mockResolvedValueOnce({
      token: "",
      contextId: owner.contextId,
      stage: "choose-branch",
      details: [],
      switchBranches: ["main", "release"],
    })
    .mockResolvedValueOnce({
      token: "confirmed",
      contextId: owner.contextId,
      stage: "prepared",
      details: ["Переключение на main"],
      switchBranch: "main",
    });
  const execute = vi.fn();
  window.goga = {
    prepareContextDeletion: prepare,
    deleteContext: execute,
  } as any;
  render(
    <ContextDeletionAction
      owner={owner}
      current
      active={false}
      onDeleted={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Удалить топик и копию…" }),
  );
  const select = await screen.findByRole("combobox", {
    name: "Перейти в ветку",
  });
  expect(execute).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: "main" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Проверить выбранную ветку" }),
  );
  await waitFor(() => expect(prepare).toHaveBeenLastCalledWith(owner, "main"));
  expect(await screen.findByText("Переключение на main")).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();
});
