// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import {
  ContextDeletionPopup,
  useContextDeletionController,
} from "../src/renderer/ContextDeletionController";
afterEach(cleanup);
const owner: any = { projectId: "p", contextId: "a", topic: "alpha" };
const preview = { token: "t", contextId: "a", stage: "prepared", details: [] };
it("keeps post-trash errors outside the closed card and retries the same operation", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const finish = vi
    .fn()
    .mockRejectedValueOnce(new Error("Goga unavailable"))
    .mockResolvedValue({
      status: "success",
      cloneRemoved: true,
      message: "Deleted",
    });
  window.goga = {
    deleteContext: vi.fn(async () => ({
      status: "success",
      cloneRemoved: true,
    })),
    finishContextDeletion: finish,
  } as any;
  const leave = vi.fn(async () => {}),
    changed = vi.fn();
  let controller!: ReturnType<typeof useContextDeletionController>;
  function Harness() {
    controller = useContextDeletionController(leave, changed);
    return <ContextDeletionPopup controller={controller} />;
  }
  render(<Harness />);
  await act(async () => {
    await expect(controller.execute(owner, preview, false)).rejects.toThrow(
      "Goga unavailable",
    );
  });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Goga unavailable",
  );
  expect(leave).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("status", { name: "Удаляем топик" })).toBeNull();
  (window.goga.deleteContext as any).mockRejectedValueOnce(
    new Error("Journal unavailable"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Продолжить удаление" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe("Journal unavailable"),
  );
  expect(finish).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Продолжить удаление" }));
  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
  expect(finish.mock.calls).toEqual([
    [{ projectId: "p", token: "t" }],
    [{ projectId: "p", token: "t" }],
  ]);
  expect(screen.queryByRole("dialog")).toBeNull();
});
