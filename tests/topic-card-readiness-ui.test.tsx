// @vitest-environment jsdom
import React from "react";
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
import { App } from "../src/renderer/App";
import { TopicCard } from "../src/renderer/TopicCard";
import { topicError } from "../src/renderer/TopicsCommon";
import { contextRef, contextRequestKey } from "../src/renderer/topic-context";
import { createTopicsStore, topicDraftKey } from "../src/renderer/topics-model";
import type { WorktreeRecord } from "../src/shared/worktrees";
import type { TopicBoardSnapshot, TopicDetails } from "../src/shared/topics";

const project = { id: "p", name: "Fixture", path: "/fixture/primary" };
const year = String(new Date().getFullYear());
const target = { topic: "feature-test", branch: "feature-test", remote: false };
const owner: WorktreeRecord = {
  projectId: project.id,
  year,
  ...target,
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "b".repeat(64),
  projectPath: project.path,
  gitCommonDir: "/fixture/clones/feature-test/.git",
  path: "/fixture/clones/feature-test",
  ownership: "managed",
  state: "ready",
  storageKind: "clone",
};
const otherOwner: WorktreeRecord = {
  ...owner,
  topic: "other",
  branch: "other",
  contextId: "ctx-" + "c".repeat(64),
  path: "/fixture/clones/other",
  gitCommonDir: "/fixture/clones/other/.git",
};
const row = {
  ...target,
  current: true,
  statuses: ["planned"],
  todo: null,
  divergence: null,
  hosts: [target.branch],
};
const board: TopicBoardSnapshot = {
  projectId: project.id,
  year,
  revision: "board-v",
  currentBranch: target.branch,
  currentTopic: target,
  baseRef: "main",
  branches: ["main", target.branch, "other"],
  dirty: false,
  active: false,
  entries: [row],
  records: [row],
  remoteEntries: [],
  remoteRecords: [],
};
const reason =
  "Данные выбранного топика есть в основной папке, но ещё не закоммичены. Сначала сохраните их в коммит.";
const wrapped = (channel = "read-request", text = reason) =>
  `Error invoking remote method 'goga:${channel}': Error: ${text}`;
const details = (text = "Clone-owned task", ref = owner): TopicDetails => ({
  projectId: project.id,
  year,
  target: { topic: ref.topic, branch: ref.branch, remote: false },
  text,
  exists: true,
  version: "task-v",
  editable: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [project]),
    runs: vi.fn(async () => []),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    listTopicContexts: vi.fn(async () => [owner, otherOwner]),
    readTopicBoard: vi.fn(async () => board),
    readTopicDetails: vi.fn(async () => {
      throw Error(wrapped());
    }),
    topicSyncStatus: vi.fn(async (ref) => ({
      ...ref,
      status: "new",
      waitingRunIds: [],
      reasons: [],
      updatedAt: "now",
    })),
    syncContext: vi.fn(async (ref) => ({
      ...ref,
      status: "synced",
      waitingRunIds: [],
      reasons: ["manual"],
      updatedAt: "now",
    })),
    prepareContextApply: vi.fn(async (ref) => ({
      ...ref,
      token: "apply-token",
      sourceOid: "clone-commit",
      targetOid: "base-commit",
      targetBranch: "main",
      files: ["owned.txt"],
      canApply: true,
    })),
    applyContext: vi.fn(),
    contextDeletionRecovery: vi.fn(async () => null),
    prepareContextDeletion: vi.fn(async (ref) => ({
      ...ref,
      token: "delete-token",
      stage: "prepared",
      details: ["Only this owned clone"],
    })),
    deleteContext: vi.fn(),
    prepareTopicOperation: vi.fn(),
    executeTopicOperation: vi.fn(),
    ensureTopicContext: vi.fn(),
    resolveTopicContext: vi.fn(async (ref) =>
      ref.contextId === owner.contextId ? owner : otherOwner,
    ),
    refreshTopicContext: vi.fn(),
    createTopicContext: vi.fn(),
    checkTopicContextReadiness: vi.fn(),
    launch: vi.fn(),
    launchBuild: vi.fn(),
    cancelRead: vi.fn(async () => {}),
  };
  // Exercise the real renderer read coordinator and IPC envelope, not mocked components.
  api.readRequest = vi.fn(async (_id, method, args) => api[method](...args));
  window.goga = api;
});
afterEach(cleanup);
const props = () => ({
  project,
  year,
  target,
  board,
  store: createTopicsStore(),
  context: { kind: "current" as const },
  owner,
  contextRequired: true,
  selectedContextId: owner.contextId,
  minimal: true,
  onClose: vi.fn(),
  onChanged: vi.fn(),
  onPrepare: vi.fn(),
});
function expectNoPreparation() {
  for (const method of [
    "ensureTopicContext",
    "resolveTopicContext",
    "refreshTopicContext",
    "createTopicContext",
    "checkTopicContextReadiness",
    "launch",
    "launchBuild",
  ])
    expect(api[method], method).not.toHaveBeenCalled();
}
function expectOwnedReads(ref = owner) {
  expect(api.readTopicDetails).toHaveBeenCalledWith(contextRef(ref), year, {
    topic: ref.topic,
    branch: ref.branch,
    remote: false,
  });
  expect(api.readTopicBoard).toHaveBeenCalledWith(contextRef(ref), year);
  for (const [scope] of api.readTopicDetails.mock.calls)
    expect(scope).toEqual(contextRef(ref));
  expectNoPreparation();
}

it.each(["read-request", "read-topic-details", "read-topic-board"])(
  "shows the host reason, not the known %s transport wrapper or a successful empty task",
  async (channel) => {
    if (channel === "read-topic-board") {
      api.readTopicDetails.mockResolvedValue(details());
      api.readTopicBoard.mockRejectedValue(Error(wrapped(channel)));
    } else api.readTopicDetails.mockRejectedValue(Error(wrapped(channel)));
    render(<TopicCard {...props()} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Не удалось загрузить топик" + reason);
    expect(screen.queryByRole("textbox", { name: "Задача топика" })).toBeNull();
    expect(screen.queryByText("Задача не задана")).toBeNull();
    expect(screen.queryByText("Clone-owned task")).toBeNull();
    expectOwnedReads();
  },
);
it.each([
  reason,
  "Error: meaningful domain reason",
  "Prefix " + wrapped(),
  "Error invoking remote method 'other:read-request': Error: denied",
  "Error invoking remote method 'goga:unrelated-method': Error: denied",
  "Read error contains 'goga:read-request' without a transport prefix",
])("preserves arbitrary meaningful error text: %s", (text) => {
  expect(topicError(Error(text))).toBe(text);
  expect(topicError(text)).toBe(text);
});
it("strips one known envelope without an Error prefix while preserving nested meaningful text", () => {
  const text = "Error invoking remote method 'goga:read-request': " + reason;
  expect(topicError(Error(text))).toBe(reason);
  const inner =
    "Error invoking remote method 'other:read-request': Error: meaningful";
  expect(topicError(Error(wrapped("read-request", inner)))).toBe(inner);
});
it("moves loading -> reason -> retry loading -> clone-owned task without preparing or empty success", async () => {
  const first = deferred<TopicDetails>(),
    retry = deferred<TopicDetails>();
  api.readTopicDetails
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise);
  const card = props();
  render(<TopicCard {...card} />);
  expect(screen.getByText("Загружаем топик…")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Задача топика" })).toBeNull();
  await act(async () => first.reject(Error(wrapped())));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Не удалось загрузить топик" + reason,
  );
  expect(card.store.tasks.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  expect(screen.getByText("Загружаем топик…")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => retry.resolve(details()));
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Задача топика",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("Clone-owned task");
  expect(api.readTopicDetails).toHaveBeenCalledTimes(2);
  expectOwnedReads();
});
it("retains a dirty owner draft across card failure and successful retry without weakening publication guards", async () => {
  const card = props();
  const key = JSON.stringify([
    topicDraftKey(project.id, year, target),
    contextRequestKey(owner),
  ]);
  const draft = {
    text: "Unsaved exact-owner draft",
    original: "Prior clone task",
    version: "old-v",
  };
  card.store.tasks.set(key, draft);
  render(<TopicCard {...card} />);
  await screen.findByRole("alert");
  expect(
    screen.getByText("Несохранённый черновик остаётся в памяти."),
  ).toBeTruthy();
  expect(card.store.tasks.get(key)).toBe(draft);
  api.readTopicDetails.mockResolvedValue(details());
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Задача топика",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe(draft.text);
  expect(card.store.tasks.get(key)).toBe(draft);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Опубликовать…" })
      .disabled,
  ).toBe(true);
  expectNoPreparation();
});
it.each(["resolve", "reject"] as const)(
  "ignores a stale owner's late %s after exact-owner replacement",
  async (settlement) => {
    const old = deferred<TopicDetails>();
    api.readTopicDetails
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(details("Other clone task", otherOwner));
    const card = props();
    const view = render(<TopicCard {...card} />);
    view.rerender(
      <TopicCard
        {...card}
        owner={otherOwner}
        target={{
          topic: otherOwner.topic,
          branch: otherOwner.branch,
          remote: false,
        }}
        selectedContextId={otherOwner.contextId}
      />,
    );
    expect(
      (
        (await screen.findByRole("textbox", {
          name: "Задача топика",
        })) as HTMLTextAreaElement
      ).value,
    ).toBe("Other clone task");
    await act(async () =>
      settlement === "resolve"
        ? old.resolve(details("STALE TASK"))
        : old.reject(Error(wrapped("read-request", "STALE ERROR"))),
    );
    expect(screen.queryByText(/STALE/)).toBeNull();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Задача топика",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Other clone task");
    expect(api.cancelRead).toHaveBeenCalled();
    expect([...card.store.tasks.values()].map((item) => item.text)).toEqual([
      "Other clone task",
    ]);
    expect(api.readTopicDetails.mock.calls.map(([ref]: any[]) => ref)).toEqual([
      contextRef(owner),
      contextRef(otherOwner),
    ]);
    expectNoPreparation();
  },
);
it.each(["current", "active", "noncurrent"])(
  "keeps independent safe actions and the %s deletion guard on a failed card",
  async (mode) => {
    const activeRun: any = {
      id: "active",
      projectId: project.id,
      topic: owner.topic,
      branch: owner.branch,
      context: contextRef(owner),
      status: "running",
    };
    render(
      <TopicCard
        {...props()}
        selectedContextId={
          mode === "current" ? owner.contextId : otherOwner.contextId
        }
        runs={mode === "active" ? [activeRun] : []}
      />,
    );
    await screen.findByRole("alert");
    await screen.findByText("Ещё не синхронизировано");
    const sync = screen.getByRole<HTMLButtonElement>("button", {
      name: "Синхронизировать",
    });
    const apply = screen.getByRole<HTMLButtonElement>("button", {
      name: "Применить в базу…",
    });
    expect(sync.disabled).toBe(false);
    expect(apply.disabled).toBe(false);
    fireEvent.click(apply);
    await screen.findByRole("region", {
      name: "Подтверждение применения в базу",
    });
    expect(api.prepareContextApply).toHaveBeenCalledExactlyOnceWith(
      contextRef(owner),
    );
    expect(api.applyContext).not.toHaveBeenCalled();
    const deletion = await screen.findByRole<HTMLButtonElement>("button", {
      name: "Удалить топик и копию…",
    });
    expect(deletion.disabled).toBe(mode !== "noncurrent");
    fireEvent.click(deletion);
    if (mode === "noncurrent") {
      await screen.findByRole("region", {
        name: "Подтверждение удаления топика и копии",
      });
      expect(api.prepareContextDeletion).toHaveBeenCalledExactlyOnceWith(
        contextRef(owner),
      );
    } else {
      expect(api.prepareContextDeletion).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          mode === "current"
            ? "Текущий топик удалить нельзя. Сначала выберите другой."
            : "Недоступно во время активного запуска в этой рабочей копии.",
        ),
      ).toBeTruthy();
    }
    expect(api.deleteContext).not.toHaveBeenCalled();
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
    expectNoPreparation();
  },
);
it("keeps host sync-waiting and blocked apply preview guards despite the independent card failure", async () => {
  api.topicSyncStatus.mockResolvedValue({
    ...contextRef(owner),
    status: "waiting",
    waitingRunIds: ["run"],
    reasons: [],
    updatedAt: "now",
  });
  api.prepareContextApply.mockResolvedValue({
    ...contextRef(owner),
    token: "blocked",
    sourceOid: "source",
    targetOid: "base",
    targetBranch: "main",
    files: [],
    canApply: false,
    reason: "Активная операция блокирует применение.",
  });
  render(<TopicCard {...props()} />);
  await screen.findByRole("alert");
  await screen.findByText("Ожидает завершения запуска");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Синхронизировать" })
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Применить в базу…" }));
  await screen.findByText("Активная операция блокирует применение.");
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Подтвердить применение",
    }).disabled,
  ).toBe(true);
  expect(api.syncContext).not.toHaveBeenCalled();
  expect(api.applyContext).not.toHaveBeenCalled();
});
it.each(["current-header", "selector", "board"])(
  "opens the failed clone card from %s with exact owner and no repair",
  async (entry) => {
    render(<App />);
    await screen.findByLabelText("Исполняемый файл");
    await waitFor(() => expect(api.listTopicContexts).toHaveBeenCalled());
    if (entry === "selector" || entry === "current-header") {
      fireEvent.click(
        screen.getByRole("button", { name: "Выбрать другой топик" }),
      );
      fireEvent.click(screen.getByRole("row", { name: /^feature-test / }));
      await screen.findByRole("region", { name: "Запуски выбранного топика" });
      // Explicit selector transition validates its owner once; opening the card does not.
      expect(api.resolveTopicContext).toHaveBeenCalledExactlyOnceWith(
        contextRef(owner),
      );
      api.resolveTopicContext.mockClear();
    }
    if (entry === "board") {
      fireEvent.click(screen.getByRole("button", { name: "Топики" }));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Открыть топик feature-test",
        }),
      );
    } else
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Открыть карточку топика feature-test",
        }),
      );
    const dialog = await screen.findByRole("dialog", { name: "feature-test" });
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Не удалось загрузить топик" + reason,
    );
    expect(
      within(dialog).queryByRole("textbox", { name: "Задача топика" }),
    ).toBeNull();
    expectOwnedReads();
    expect(api.readRequest).toHaveBeenCalledWith(
      expect.any(String),
      "readTopicDetails",
      [contextRef(owner), year, target],
    );
    expect(api.syncContext).not.toHaveBeenCalled();
    expect(api.applyContext).not.toHaveBeenCalled();
    expect(api.deleteContext).not.toHaveBeenCalled();
  },
);
