// @vitest-environment jsdom
import React, { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TopicOverview } from "../src/renderer/TopicOverview";
import { RepositoryOperationPopup } from "../src/renderer/RepositoryActions";
import { contextRef } from "../src/renderer/topic-context";

const project = { id: "p", name: "Project", path: "/fixture" };
const target = { topic: "alpha", branch: "alpha", remote: false };
const owner: any = {
  ...target,
  projectId: "p",
  year: "2026",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
  state: "ready",
  storageKind: "clone",
  ownership: "managed",
  path: "/fixture/clone",
};
const board: any = {
  projectId: "p",
  year: "2026",
  revision: "v",
  branches: ["main", "release", "alpha", "origin/release"],
  localBranches: ["main", "release", "alpha"],
  entries: [],
  records: [],
  remoteEntries: [],
  remoteRecords: [],
};
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readTopicOverview: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      target,
      exists: true,
      text: "Task",
      version: "v",
      editable: false,
    })),
    readTopicBoard: vi.fn(async () => board),
    runRepositoryAction: vi.fn(async (r) => ({
      projectId: r.projectId,
      contextId: r.context?.contextId,
      action: r.action,
      status: "success",
      log: "done",
    })),
    prepareTopicOperation: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
function mount(record: any = owner, extra: any = {}) {
  const anchor = createRef<HTMLDivElement>();
  const onChanged = vi.fn(),
    onClose = vi.fn();
  const view = render(
    <>
      <div ref={anchor} />
      <TopicOverview
        project={project}
        year="2026"
        target={target}
        board={board}
        owner={record}
        selectedContextId="a-different-header-context"
        onChanged={onChanged}
        onClose={onClose}
        {...extra}
      />
      <RepositoryOperationPopup anchor={anchor} />
    </>,
  );
  return { ...view, onChanged, onClose };
}
async function chooseDestination() {
  const select = screen.getByRole("combobox", { name: "В ветку" });
  fireEvent.focus(select);
  await waitFor(() =>
    expect(
      within(select).getByRole("option", { name: "release" }),
    ).toBeTruthy(),
  );
  fireEvent.change(select, { target: { value: "release" } });
  return select;
}
it.each([true, false])(
  "publishes exact card identity and independent destination (clone=%s)",
  async (clone) => {
    mount(clone ? owner : null);
    expect(api.readTopicBoard).not.toHaveBeenCalled();
    const destination = await chooseDestination();
    expect(api.readTopicBoard).toHaveBeenCalledExactlyOnceWith("p", "2026");
    expect(
      within(destination).queryByRole("option", { name: "origin/release" }),
    ).toBeNull();
    expect(
      within(destination).queryByRole("option", { name: "alpha" }),
    ).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Из ветки" }), {
      target: { value: "main" },
    });
    expect(api.runRepositoryAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Опубликовать" }));
    await waitFor(() =>
      expect(api.runRepositoryAction).toHaveBeenCalledExactlyOnceWith({
        projectId: "p",
        ...(clone ? { context: contextRef(owner) } : {}),
        action: "propagate",
        propagation: {
          year: "2026",
          topic: "alpha",
          branch: "alpha",
          baseRef: "release",
        },
      }),
    );
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  },
);
it("deduplicates clicks, blocks other card actions and displays log above the card with close only", async () => {
  let finish!: (v: any) => void;
  api.runRepositoryAction.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const { onClose } = mount();
  await chooseDestination();
  const publish = screen.getByRole("button", { name: "Опубликовать" });
  fireEvent.click(publish);
  fireEvent.click(publish);
  expect(api.runRepositoryAction).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Закрыть карточку" }),
  ).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Удалить топик…" })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () =>
    finish({
      projectId: "p",
      contextId: owner.contextId,
      action: "propagate",
      status: "error",
      log: "Sync completed\nPropagate failed",
      error: "Origin rejected",
    }),
  );
  const error = await screen.findByRole("dialog", { name: "Ошибка операции" });
  expect(error.tagName).toBe("DIALOG");
  expect(error).toHaveProperty("open", true);
  expect(within(error).getByLabelText("Лог операции").textContent).toContain(
    "Sync completed",
  );
  expect(within(error).getByRole("alert").textContent).toBe("Origin rejected");
  expect(within(error).getAllByRole("button")).toHaveLength(1);
  fireEvent.click(within(error).getByRole("button", { name: "Закрыть попап" }));
  expect(screen.queryByRole("dialog", { name: "Ошибка операции" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "alpha" })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
it("does not publish when ownership is unknown or the target is remote", () => {
  const view = mount(null, {
    ownerReadState: "error",
    ownerReadError: "Inventory unavailable",
  });
  expect(screen.getByRole("button", { name: "Опубликовать" })).toHaveProperty(
    "disabled",
    true,
  );
  view.unmount();
  mount(null, { target: { ...target, remote: true } });
  expect(screen.getByRole("button", { name: "Опубликовать" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.runRepositoryAction).not.toHaveBeenCalled();
});
it("settles a branch load error and allows another focus to retry", async () => {
  api.readTopicBoard.mockRejectedValueOnce(Error("Branches failed"));
  mount();
  const select = screen.getByRole("combobox", { name: "В ветку" });
  fireEvent.focus(select);
  await screen.findByText("Branches failed");
  expect(screen.getByRole("button", { name: "Опубликовать" })).toHaveProperty(
    "disabled",
    true,
  );
  await chooseDestination();
  expect(screen.getByRole("button", { name: "Опубликовать" })).toHaveProperty(
    "disabled",
    false,
  );
});
