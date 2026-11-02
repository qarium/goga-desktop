// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { TopicsRemovalDialog } from "../src/renderer/TopicsRemovalDialog";
import {
  TopicRemovalProvider,
  TopicRemovalPopup,
  useTopicRemovalController,
} from "../src/renderer/TopicRemovalController";
import { topicsBoardV4 } from "./fixtures/topics-board-v4";
let api: any;
const plan = {
  token: "t",
  projectId: "p",
  year: "2026",
  action: "delete" as const,
  details: ["delete alpha"],
  expiresAt: Date.now() + 120000,
};
const contextId = "ctx-" + "a".repeat(64);
const owner: any = {
  projectId: "p",
  year: "2026",
  topic: "alpha",
  branch: "alpha",
  contextId,
  revision: "00000000-0000-4000-8000-000000000001",
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readTopicBoard: vi.fn(async () => topicsBoardV4()),
    prepareTopicRemoval: vi.fn(async () => plan),
    executeTopicRemoval: vi.fn(async () => ({
      projectId: "p",
      topics: { status: "success", message: "Топики удалены" },
      copies: [],
      cleanup: [],
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
function Fixture({
  executor = vi.fn(async () => ({
    projectId: "p",
    status: "success",
    message: "Copy",
    cloneRemoved: true,
  })),
}: {
  executor?: any;
}) {
  const controller = useTopicRemovalController(executor, vi.fn());
  return (
    <TopicRemovalProvider value={controller.execute}>
      <TopicsRemovalDialog
        project={{ id: "p", name: "Project", path: "/fixture" }}
        year="2026"
        action="delete"
        topics={["alpha", "alpha"]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
      <TopicRemovalPopup controller={controller} />
    </TopicRemovalProvider>
  );
}
it("prepares unique selected topics using fresh revision and waits for explicit confirmation", async () => {
  render(<Fixture />);
  await screen.findByText("delete alpha");
  expect(api.prepareTopicRemoval).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "delete",
      topics: ["alpha"],
      expectedRevision: "a".repeat(64),
    }),
  );
  expect(api.executeTopicRemoval).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Подтверждаю удаление/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByText("Топики удалены");
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});
it("never invokes copy executor on failed Goga and gives no automatic CLI retry", async () => {
  const executor = vi.fn();
  api.executeTopicRemoval.mockResolvedValue({
    projectId: "p",
    topics: { status: "partial", message: "Нужна проверка" },
    copies: [],
    cleanup: [],
  });
  render(<Fixture executor={executor} />);
  await screen.findByText("delete alpha");
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Подтверждаю удаление/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByText("Нужна проверка");
  expect(executor).not.toHaveBeenCalled();
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});
it("cleans confirmed copies after native success but waits for per-copy ahead consent", async () => {
  const executor = vi.fn(async () => ({
    status: "success",
    message: "Copy removed",
    cloneRemoved: true,
  }));
  api.executeTopicRemoval.mockResolvedValue({
    projectId: "p",
    topics: { status: "success", message: "Топики удалены" },
    copies: [],
    cleanup: [
      {
        owner,
        plan: {
          token: "c",
          contextId,
          purpose: "clone-after-topic",
          stage: "prepared",
          details: [],
          aheadCount: 2,
          requiresAheadConfirmation: true,
        },
      },
    ],
  });
  render(<Fixture executor={executor} />);
  await screen.findByText("delete alpha");
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Подтверждаю удаление/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByRole("checkbox", {
    name: /Подтверждаю удаление непереданных коммитов alpha/,
  });
  expect(executor).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /Подтверждаю удаление непереданных коммитов alpha/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить копию alpha" }));
  await waitFor(() =>
    expect(executor).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ purpose: "clone-after-topic" }),
      true,
    ),
  );
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});
it("refreshes only copy cleanup after failure and never repeats the native removal", async () => {
  const executor = vi
    .fn()
    .mockResolvedValueOnce({
      status: "failed",
      message: "Trash denied",
      cloneRemoved: false,
      stage: "prepared",
    })
    .mockResolvedValueOnce({
      status: "success",
      message: "Fresh copy removed",
      cloneRemoved: true,
      stage: "completed",
    });
  api.listTopicContexts = vi.fn(async () => [owner]);
  api.prepareTopicCloneCleanup = vi.fn(async () => ({
    token: "fresh-copy",
    contextId,
    purpose: "clone-after-topic",
    stage: "prepared",
    details: ["Fresh copy check"],
    requiresAheadConfirmation: false,
  }));
  api.executeTopicRemoval.mockResolvedValue({
    projectId: "p",
    topics: { status: "success", message: "Топики удалены" },
    copies: [],
    cleanup: [
      {
        owner,
        plan: {
          token: "stale-copy",
          contextId,
          purpose: "clone-after-topic",
          stage: "prepared",
          details: [],
        },
      },
    ],
  });
  render(<Fixture executor={executor} />);
  await screen.findByText("delete alpha");
  fireEvent.click(
    screen.getByRole("checkbox", { name: /Подтверждаю удаление/ }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByText("Trash denied");
  fireEvent.click(
    screen.getByRole("button", { name: "Проверить копию alpha" }),
  );
  await screen.findByText("Fresh copy check");
  fireEvent.click(screen.getByRole("button", { name: "Удалить копию alpha" }));
  await screen.findByText("Fresh copy removed");
  expect(executor).toHaveBeenLastCalledWith(
    owner,
    expect.objectContaining({ token: "fresh-copy" }),
    false,
  );
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});
