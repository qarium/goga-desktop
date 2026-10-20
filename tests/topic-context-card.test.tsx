// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { TopicsWorkspace } from "../src/renderer/TopicsWorkspace";
import { TopicFeedback } from "../src/renderer/TopicsCommon";
import { TopicCard } from "../src/renderer/TopicCard";
import { createTopicsStore } from "../src/renderer/topics-model";
import type {
  TopicBoardSnapshot,
  TopicOperationRequest,
} from "../src/shared/topics";
const project = { id: "p", name: "Project", path: "/fixture" };
const row = (topic: string, branch: string, statuses: string[]) => ({
  topic,
  branch,
  statuses,
  current: branch === "feature/a",
  remote: false,
  todo: branch,
  divergence: null,
});
const a = row("feature-a", "feature/a", ["planned"]),
  h = row("feature-a", "main", ["done"]),
  b = row("feature-b", "feature/b", ["tool.ready"]);
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "rev",
  currentBranch: "feature/a",
  currentTopic: a,
  baseRef: "main",
  branches: ["main", "feature/a"],
  dirty: false,
  active: false,
  entries: [
    { ...a, hosts: ["feature/a", "main"] },
    { ...b, hosts: ["feature/b"] },
  ],
  records: [a, h, b],
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
    readTopicBoard: vi.fn(async () => board),
    readTopicDetails: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      target: a,
      text: "Original task",
      exists: true,
      version: "task-v",
      editable: true,
    })),
    prepareTopicOperation: vi.fn(async (req) => ({
      token: "token",
      projectId: "p",
      year: "2026",
      action: req.action,
      title: "Подтвердите действие",
      details: ["origin/feature/new"],
      expiresAt: Date.now() + 60000,
    })),
    executeTopicOperation: vi.fn(async () => ({
      projectId: "p",
      status: "success",
      message: "Готово",
    })),
  };
  window.goga = api;
});
afterEach(cleanup);

const mountMinimal = (snapshot = board, target = b) =>
  render(
    <TopicCard
      project={project}
      year="2026"
      target={target}
      board={snapshot}
      store={createTopicsStore()}
      context={{ kind: "topic" }}
      minimal
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
it("minimal card has four topic actions and no run navigation or checkout action", async () => {
  mountMinimal();
  await screen.findByLabelText("Задача топика");
  expect(
    screen.queryByRole("button", { name: "Подготовить запуск" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Переключиться на топик/ }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Открыть запуск|Перейти/ }),
  ).toBeNull();
  expect(
    document.querySelectorAll(".topic-operation-grid button"),
  ).toHaveLength(4);
  expect(document.querySelector(".topic-common-reasons")).toBeNull();
});
it("minimal active card shares one visible reason across all guarded actions", async () => {
  const snapshot = { ...board, active: true };
  api.readTopicBoard.mockResolvedValue(snapshot);
  mountMinimal(snapshot);
  await screen.findByText("Original task");
  const common = document.querySelector(".topic-common-reasons");
  expect(common).not.toBeNull();
  expect(
    common!.textContent?.match(/Недоступно во время активного запуска/g),
  ).toHaveLength(1);
  for (const b of document.querySelectorAll<HTMLButtonElement>(
    ".topic-operation-grid button",
  )) {
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-describedby")).toBe(common!.id);
  }
  expect(
    document.querySelectorAll(".topic-operation-grid .topic-action-reason"),
  ).toHaveLength(0);
  expect(screen.queryByText(/сборка выполняется/i)).toBeNull();
});
it("minimal card preserves action-specific reasons in one block and clears on valid base", async () => {
  mountMinimal();
  await screen.findByLabelText("Базовая ветка");
  fireEvent.change(screen.getByLabelText("Базовая ветка"), {
    target: { value: board.currentBranch },
  });
  const common = document.querySelector(".topic-common-reasons");
  expect(common).not.toBeNull();
  expect(common!.textContent).toContain("Базовая ветка сейчас текущая");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Опубликовать…" })
      .disabled,
  ).toBe(false);
  for (const name of ["Обновить из базы…", "Перенести в базу…"]) {
    const b = screen.getByRole<HTMLButtonElement>("button", { name });
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-describedby")).toBe(common!.id);
  }
  fireEvent.change(screen.getByLabelText("Базовая ветка"), {
    target: { value: "main" },
  });
  expect(document.querySelector(".topic-common-reasons")).toBeNull();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
});
it("clone card reads local owner details and board, presents metadata before sync, and does not promise publication on apply", async () => {
  const owner: any = {
    projectId: "p",
    year: "2026",
    topic: b.topic,
    branch: b.branch,
    contextId: "ctx-" + "b".repeat(64),
    revision: "00000000-0000-4000-8000-000000000001",
    repositoryKey: "a".repeat(64),
    projectPath: "/fixture",
    gitCommonDir: "/clones/b/.git",
    path: "/clones/b",
    ownership: "managed",
    state: "ready",
    storageKind: "clone",
  };
  api.topicSyncStatus = vi.fn(async () => ({
    ...owner,
    status: "new",
    waitingRunIds: [],
    reasons: [],
    updatedAt: "now",
  }));
  render(
    <TopicCard
      project={project}
      year="2026"
      target={b}
      board={board}
      store={createTopicsStore()}
      context={{ kind: "topic" }}
      owner={owner}
      minimal
      onClose={() => {}}
      onChanged={() => {}}
      onPrepare={() => {}}
    />,
  );
  await screen.findByLabelText("Задача топика");
  expect(api.readTopicDetails).toHaveBeenCalledWith(
    expect.objectContaining({ contextId: owner.contextId }),
    "2026",
    expect.objectContaining({ topic: b.topic }),
  );
  expect(api.readTopicBoard).toHaveBeenCalledWith(
    expect.objectContaining({ contextId: owner.contextId }),
    "2026",
  );
  const metadata = document.querySelector(".topic-card-context")!;
  const sync = screen.getByRole("region", { name: "Перенос изменений" });
  expect(
    metadata.compareDocumentPosition(sync) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    screen.queryByText(/Перенос в базу включает её публикацию/),
  ).toBeNull();
});
it("never falls back to primary while a required clone owner is unresolved, and only accepts refreshed host inventory", async () => {
  const owner: any = {
    projectId: "p",
    year: "2026",
    topic: b.topic,
    branch: b.branch,
    contextId: "ctx-" + "b".repeat(64),
    revision: "00000000-0000-4000-8000-000000000001",
    repositoryKey: "a".repeat(64),
    projectPath: "/fixture",
    gitCommonDir: "/clones/b/.git",
    path: "/clones/b",
    ownership: "managed",
    state: "ready",
    storageKind: "clone",
  };
  api.ensureTopicContext = vi.fn(async () => owner);
  api.topicSyncStatus = vi.fn(async () => ({
    ...owner,
    status: "new",
    waitingRunIds: [],
    reasons: [],
    updatedAt: "now",
  }));
  const onPrepared = vi.fn();
  const props = {
    project,
    year: "2026",
    target: b,
    board,
    store: createTopicsStore(),
    context: { kind: "topic" as const },
    contextRequired: true,
    minimal: true,
    onContextPrepared: onPrepared,
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onPrepare: vi.fn(),
  };
  const view = render(<TopicCard {...props} />);
  expect(
    screen.getByRole("region", { name: "Перенос изменений" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Подготовить автономный клон" }),
  ).toBeNull();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
  expect(api.readTopicBoard).not.toHaveBeenCalled();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  view.rerender(<TopicCard {...props} owner={owner} />);
  await screen.findByLabelText("Задача топика");
  expect(onPrepared).not.toHaveBeenCalled();
  expect(
    api.readTopicDetails.mock.calls.every(
      ([scope]: any[]) =>
        typeof scope === "object" && scope.contextId === owner.contextId,
    ),
  ).toBe(true);
  expect(
    api.readTopicBoard.mock.calls.every(
      ([scope]: any[]) =>
        typeof scope === "object" && scope.contextId === owner.contextId,
    ),
  ).toBe(true);
});
it("owner inventory failure keeps contextual card fail-closed without preparing, primary reads or actions", async () => {
  api.ensureTopicContext = vi.fn(async () => {
    throw Error("Inventory unavailable");
  });
  render(
    <TopicCard
      project={project}
      year="2026"
      target={b}
      board={board}
      store={createTopicsStore()}
      context={{ kind: "topic" }}
      contextRequired
      ownerReadState="error"
      ownerReadError="Inventory unavailable"
      minimal
      onClose={() => {}}
      onChanged={() => {}}
      onPrepare={() => {}}
    />,
  );
  await screen.findByText("Inventory unavailable");
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(
    screen.queryByText("Рабочая копия ещё не создана. Переносить пока нечего"),
  ).toBeNull();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
  expect(api.readTopicBoard).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Опубликовать…" })).toBeNull();
});
const cloneOwner: any = {
  projectId: "p",
  year: "2026",
  topic: b.topic,
  branch: b.branch,
  contextId: "ctx-" + "b".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  storageKind: "clone",
  ownership: "managed",
  state: "ready",
};
function mountClone(runs: any[] = []) {
  api.topicSyncStatus = vi.fn(async () => ({
    ...cloneOwner,
    status: "new",
    waitingRunIds: [],
    reasons: [],
    updatedAt: "now",
  }));
  return render(
    <TopicCard
      project={project}
      year="2026"
      target={b}
      board={board}
      store={createTopicsStore()}
      context={{ kind: "topic" }}
      owner={cloneOwner}
      runs={runs}
      minimal
      onClose={() => {}}
      onChanged={() => {}}
      onPrepare={() => {}}
    />,
  );
}
it.each([
  ["publish", "Опубликовать…"],
  ["update", "Обновить из базы…"],
  ["propagate", "Перенести в базу и опубликовать…"],
] as const)(
  "clone %s prepares exact context and upstream, waiting for confirmation",
  async (action, label) => {
    const endpoint =
      "https://[скрыто]@publish.example/org/repo.git → refs/heads/feature/b";
    api.prepareTopicOperation.mockImplementation(
      async (request: TopicOperationRequest) => ({
        token: "clone-token",
        projectId: "p",
        year: "2026",
        action: request.action,
        title: "Подтвердите публикацию",
        details: [endpoint],
        expiresAt: Date.now() + 60_000,
      }),
    );
    mountClone();
    await screen.findByLabelText("Задача топика");
    const toggle = screen.getByRole("switch", {
      name: "Опубликовать после обновления",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    if (action === "update") fireEvent.click(toggle);
    const button = screen.getByRole("button", {
      name: label,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(
      screen.getByRole("button", { name: "Применить в базу…" }),
    ).toBeTruthy();
    fireEvent.click(button);
    await screen.findByText(endpoint);
    const { storageKind, ownership, state, ...context } = cloneOwner;
    expect(api.prepareTopicOperation).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      context,
      year: "2026",
      expectedRevision: board.revision,
      action,
      target: { topic: b.topic, branch: b.branch, remote: false },
      ...(action !== "publish" ? { baseRef: "main" } : {}),
      ...(action === "update" ? { publish: true } : {}),
    });
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    await waitFor(() =>
      expect(api.executeTopicOperation).toHaveBeenCalledExactlyOnceWith(
        "clone-token",
      ),
    );
  },
);
it.each(["draft", "active"])(
  "clone publication retains the %s guard",
  async (reason) => {
    mountClone(
      reason === "active"
        ? [
            {
              id: "active",
              projectId: "p",
              topic: b.topic,
              branch: b.branch,
              context: cloneOwner,
              status: "running",
            },
          ]
        : [],
    );
    await screen.findByText("Original task");
    if (reason === "draft")
      fireEvent.change(screen.getByLabelText("Задача топика"), {
        target: { value: "Unsaved task" },
      });
    for (const label of [
      "Опубликовать…",
      "Обновить из базы…",
      "Перенести в базу и опубликовать…",
    ])
      expect(
        (screen.getByRole("button", { name: label }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    expect(
      (
        screen.getByRole("switch", {
          name: "Опубликовать после обновления",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
  },
);
it("shows actionable upstream errors without executing publication", async () => {
  api.prepareTopicOperation.mockRejectedValue(
    Error(
      "Не настроен настоящий upstream. Укажите внешний remote и повторите.",
    ),
  );
  mountClone();
  await screen.findByLabelText("Задача топика");
  fireEvent.click(screen.getByRole("button", { name: "Опубликовать…" }));
  expect(
    await screen.findByText(/Не настроен настоящий upstream/),
  ).toBeTruthy();
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});
