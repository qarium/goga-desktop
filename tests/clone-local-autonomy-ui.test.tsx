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
import { LaunchForm } from "../src/renderer/LaunchForm";
import { createDraftStore } from "../src/renderer/task-drafts";
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
    readTopicTable: vi.fn(async () => board),
    readTopicOverview: vi.fn(async () => {
      throw Error(wrapped());
    }),
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

const absence =
  "В этой копии данные топика ещё не созданы. Введите задачу и сохраните её здесь; основная папка не изменится.";
const missingDetails = () => ({
  ...details(""),
  exists: false,
  catalogState: "missing-local-metadata" as const,
});
const missingBoard = {
  ...board,
  entries: [],
  records: [],
  currentTopic: null,
  dirty: true,
};
function localMissing() {
  api.readTopicDetails.mockResolvedValue(missingDetails());
  api.readTopicBoard.mockResolvedValue(missingBoard);
  api.prepareTopicOperation.mockImplementation(async (request: any) => ({
    ...request,
    token: "save-token",
    title: "Создать локальную задачу?",
    details: ["Только эта копия"],
    expiresAt: Date.now() + 60000,
  }));
  api.executeTopicOperation.mockImplementation(async () => {
    api.readTopicDetails.mockResolvedValue(details("Explicit local task"));
    return { projectId: project.id, status: "success", message: "Сохранено" };
  });
}
it("renders explicit missing metadata without writes, requires nonblank input and retains confirmed versioned local save", async () => {
  localMissing();
  render(<TopicCard {...props()} />);
  await screen.findByText(absence);
  const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Задача топика",
  });
  const save = () =>
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Создать задачу в этой копии…",
    });
  expect(editor.value).toBe("");
  expect(save().disabled).toBe(true);
  expect(screen.queryByText("Задача не задана")).toBeNull();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: "  \n " } });
  expect(save().disabled).toBe(true);
  fireEvent.change(editor, { target: { value: "Explicit local task" } });
  expect(save().disabled).toBe(false);
  fireEvent.click(save());
  await screen.findByText("Создать локальную задачу?");
  expect(api.prepareTopicOperation).toHaveBeenCalledExactlyOnceWith({
    projectId: project.id,
    context: contextRef(owner),
    year,
    expectedRevision: "board-v",
    action: "save-task",
    target,
    task: "Explicit local task",
    taskVersion: "task-v",
  });
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(editor.isConnected).toBe(false);
  expect(screen.getByLabelText("Задача топика")).toHaveProperty(
    "value",
    "Explicit local task",
  );
  fireEvent.click(save());
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить" }));
  await screen.findByRole("button", { name: "Сохранить задачу…" });
  expect(api.executeTopicOperation).toHaveBeenCalledExactlyOnceWith(
    "save-token",
  );
  expect(screen.queryByText(absence)).toBeNull();
  expectNoPreparation();
});
it.each(["current-header", "selector", "board"])(
  "opens missing local data via %s without repair or mutation",
  async (entry) => {
    localMissing();
    api.readTopicOverview.mockResolvedValue(missingDetails());
    // The display table has the identity; the exact owner has no local task.
    // Legacy TopicCard editor coverage above remains separate from this read-only UI.
    api.readTopicBoard.mockImplementation(async (scope: any) =>
      typeof scope === "string" ? board : missingBoard,
    );
    render(<App />);
    await screen.findByLabelText("Исполняемый файл");
    if (entry === "selector" || entry === "current-header") {
      fireEvent.click(
        await screen.findByRole("button", { name: "Выбрать другой топик" }),
      );
      fireEvent.click(
        await screen.findByRole("row", { name: /^feature-test / }),
      );
      await screen.findByRole("button", {
        name: "Открыть карточку топика feature-test",
      });
      fireEvent.click(screen.getByRole("button", { name: "Запуски" }));
      await screen.findByRole("region", { name: "Запуски выбранного топика" });
      api.resolveTopicContext.mockClear();
    }
    const boardReads = api.readTopicBoard.mock.calls.length;
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
    await screen.findByText("Задача не задана");
    expect(screen.queryByRole("textbox", { name: "Задача топика" })).toBeNull();
    expect(api.readTopicOverview).toHaveBeenCalledExactlyOnceWith(
      contextRef(owner),
      year,
      target,
    );
    expect(api.readTopicDetails).not.toHaveBeenCalled();
    expect(api.readTopicBoard.mock.calls.length).toBe(boardReads);
    expectNoPreparation();
    expect(api.syncContext).not.toHaveBeenCalled();
    expect(api.applyContext).not.toHaveBeenCalled();
    expect(api.deleteContext).not.toHaveBeenCalled();
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
  },
);
function setupForm() {
  api.discover = vi.fn(async () => ({
    pipelines: [
      { id: "verify", name: "Verify", description: "", project: true },
    ],
    topics: [],
    branches: [owner.branch],
    currentBranch: owner.branch,
    workflows: [],
    profiles: [],
  }));
  api.preview = vi.fn(async () => ({
    token: "preview-v",
    stages: [{ id: "one", title: "One" }],
    workflow: null,
    profile: null,
  }));
  api.readTopicTask = vi.fn(async () => ({
    path: "todo.md",
    text: "",
    exists: false,
    version: "missing-v",
    catalogState: "missing-local-metadata",
  }));
  api.checkoutBranch = vi.fn(async () => owner.branch);
  api.launch.mockResolvedValue({ id: "run" });
  return {
    project,
    owner: contextRef(owner),
    draftStore: createDraftStore(),
    onLaunched: vi.fn(),
    onCancel: vi.fn(),
  };
}
const formAbsence =
  "В этой копии данные топика ещё не созданы. Введите непустую задачу; она сохранится здесь только при запуске.";
it("opens a missing-catalog exact-owner form, explains local prerequisite and launches only an explicit nonblank task", async () => {
  const form = setupForm();
  render(<LaunchForm {...form} />);
  await screen.findByText(formAbsence);
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Запустить" })
      .disabled,
  ).toBe(true);
  expect(api.launch).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "  " },
  });
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Сохранить и запустить",
    }).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "Local pipeline task" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    context: contextRef(owner),
    task: "Local pipeline task",
    taskVersion: "missing-v",
    topic: { mode: "existing", topic: target.topic, branch: target.branch },
  });
});
it("accepts exact-owner prepared text with no catalog row rather than trapping preparation", async () => {
  const form = setupForm(),
    onPrepared = vi.fn();
  render(
    <LaunchForm
      {...form}
      preparedTopic={{ target, text: "Card draft", nonce: 1 }}
      onPrepared={onPrepared}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
      "value",
      "Card draft",
    ),
  );
  expect(onPrepared).toHaveBeenCalledExactlyOnceWith(1);
  expect(
    screen.queryByText(/Выбранный топик отсутствует в каталоге запуска/),
  ).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
});

it.each(["remote", "other", "unowned"])(
  "does not use the absent-row fallback for %s preparation",
  async (kind) => {
    const form = setupForm(),
      onPrepared = vi.fn();
    const selected =
      kind === "other"
        ? { topic: "other", branch: "other", remote: false }
        : { ...target, remote: kind === "remote" };
    render(
      <LaunchForm
        {...form}
        owner={kind === "unowned" ? undefined : form.owner}
        preparedTopic={{ target: selected, text: "Do not import", nonce: 1 }}
        onPrepared={onPrepared}
      />,
    );
    await screen.findByText(/Выбранный топик отсутствует в каталоге запуска/);
    expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
      "value",
      "",
    );
    expect(onPrepared).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  },
);
it("preserves dirty preparation text across card handoff, cancelled reset, and settings refresh with no catalog row", async () => {
  const form = setupForm(),
    onPrepared = vi.fn();
  const view = render(<LaunchForm {...form} settingsRevision="s1" />);
  await screen.findByText(formAbsence);
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "Existing local draft" },
  });
  view.rerender(
    <LaunchForm
      {...form}
      settingsRevision="s2"
      preparedTopic={{ target, text: "Other card draft", nonce: 2 }}
      onPrepared={onPrepared}
    />,
  );
  await waitFor(() => expect(onPrepared).toHaveBeenCalledWith(2));
  expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
    "value",
    "Existing local draft",
  );
  fireEvent.click(await screen.findByRole("button", { name: "Сбросить" }));
  fireEvent.click(await screen.findByRole("button", { name: "Отмена" }));
  expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
    "value",
    "Existing local draft",
  );
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  expect(api.launch).not.toHaveBeenCalled();
});
it("reset rereads missing-local metadata atomically for the exact owner and re-blocks empty launch", async () => {
  const form = setupForm();
  render(<LaunchForm {...form} />);
  await screen.findByText(formAbsence);
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "Local draft" },
  });
  fireEvent.click(await screen.findByRole("button", { name: "Сбросить" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Сбросить изменения" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
      "value",
      "",
    ),
  );
  expect(screen.getByText(formAbsence)).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Запустить" })
      .disabled,
  ).toBe(true);
  expect(api.readTopicTask).toHaveBeenCalledTimes(2);
  for (const [request] of api.readTopicTask.mock.calls)
    expect(request).toEqual({
      projectId: project.id,
      context: contextRef(owner),
      branch: owner.branch,
      topic: owner.topic,
    });
  expect(api.launch).not.toHaveBeenCalled();
});
it("failed reread retains the local draft, cancelling reread writes nothing, successful reread restores explicit absence", async () => {
  const form = setupForm();
  let retryDuringErrorCommit = false;
  render(
    <React.Profiler id="failed-reread-retry" onRender={() => {
      // Deliver one rapid retry after the error becomes visible, before passive
      // effects from that same draft update can invalidate a fresh confirmation.
      if (!retryDuringErrorCommit && screen.queryByText(/Local read failure/)) {
        const retry = screen.getByRole<HTMLButtonElement>("button", { name: "Перечитать задачу" });
        expect(retry.disabled).toBe(false);
        retryDuringErrorCommit = true;
        retry.click();
      }
    }}>
      <LaunchForm {...form} />
    </React.Profiler>,
  );
  await screen.findByText(formAbsence);
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "Local draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Перечитать задачу" }));
  fireEvent.click(await screen.findByRole("button", { name: "Отмена" }));
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  api.readTopicTask.mockRejectedValueOnce(Error("Local read failure"));
  fireEvent.click(screen.getByRole("button", { name: "Перечитать задачу" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Перечитать и сбросить" }),
  );
  await screen.findByText(/Local read failure/);
  expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
    "value",
    "Local draft",
  );
  expect(retryDuringErrorCommit).toBe(true);
  expect(api.readTopicTask).toHaveBeenCalledTimes(2);
  fireEvent.click(
    await screen.findByRole("button", { name: "Перечитать и сбросить" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
      "value",
      "",
    ),
  );
  expect(screen.getByText(formAbsence)).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Запустить" })
      .disabled,
  ).toBe(true);
  expect(api.launch).not.toHaveBeenCalled();
});
it.each(["resolve", "reject"] as const)(
  "late %s from a missing-data owner does not replace the new owner's task",
  async (settlement) => {
    localMissing();
    const old = deferred<TopicDetails>();
    api.readTopicDetails
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(details("New owner task", otherOwner));
    const card = props(),
      view = render(<TopicCard {...card} />);
    expect(
      screen.getByRole("status", { name: "Загружаем топик…" }),
    ).toBeTruthy();
    view.rerender(
      <TopicCard
        {...card}
        owner={otherOwner}
        target={{
          topic: otherOwner.topic,
          branch: otherOwner.branch,
          remote: false,
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Задача топика")).toHaveProperty(
        "value",
        "New owner task",
      ),
    );
    await act(async () =>
      settlement === "resolve"
        ? old.resolve(missingDetails())
        : old.reject(Error("Stale failure")),
    );
    expect(screen.getByLabelText("Задача топика")).toHaveProperty(
      "value",
      "New owner task",
    );
    expect(screen.queryByText(absence)).toBeNull();
    expect(screen.queryByText(/Stale failure/)).toBeNull();
    expect(api.cancelRead).toHaveBeenCalled();
  },
);
it("late task read preserves distinct owner drafts and never enables the wrong owner", async () => {
  const form = setupForm(),
    old = deferred<any>();
  api.readTopicTask.mockReturnValueOnce(old.promise).mockResolvedValue({
    text: "Other owner's task",
    exists: true,
    version: "other-v",
    path: "todo.md",
  });
  api.discover.mockImplementation(async (ref: any) => ({
    pipelines: [{ id: "verify", name: "Verify" }],
    topics: [],
    branches: [ref.branch],
    currentBranch: ref.branch,
    workflows: [],
    profiles: [],
  }));
  const view = render(<LaunchForm {...form} />);
  await waitFor(() => expect(api.readTopicTask).toHaveBeenCalledTimes(1));
  view.rerender(<LaunchForm {...form} owner={contextRef(otherOwner)} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
      "value",
      "Other owner's task",
    ),
  );
  await act(async () =>
    old.resolve({
      text: "",
      exists: false,
      version: "missing-v",
      path: "todo.md",
      catalogState: "missing-local-metadata",
    }),
  );
  expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
    "value",
    "Other owner's task",
  );
  expect(screen.queryByText(formAbsence)).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
});
it("missing card retry retains a stale-version local draft and the save host rejection without publication", async () => {
  localMissing();
  api.readTopicDetails.mockRejectedValueOnce(Error("Local failure"));
  const card = props();
  const key = JSON.stringify([
    topicDraftKey(project.id, year, target),
    contextRequestKey(owner),
  ]);
  card.store.tasks.set(key, {
    text: "Preserved draft",
    original: "",
    version: "old-v",
  });
  render(<TopicCard {...card} />);
  // LoadingBoundary keeps hidden content mounted. Wait for accessible controls,
  // not text that may render before the read's final loading-state update.
  const retry = await screen.findByRole("button", {
    name: "Повторить загрузку",
  });
  expect(screen.getByRole("alert").textContent).toContain("Local failure");
  fireEvent.click(retry);
  const task = await screen.findByRole("textbox", { name: "Задача топика" });
  expect(screen.getByText(absence)).toBeTruthy();
  expect(task).toHaveProperty("value", "Preserved draft");
  expect(screen.getByRole("alert").textContent).toContain(
    "Сохранённая задача изменилась",
  );
  api.prepareTopicOperation.mockRejectedValue(Error("Version changed"));
  fireEvent.click(
    screen.getByRole("button", { name: "Создать задачу в этой копии…" }),
  );
  await screen.findByText("Version changed");
  expect(api.prepareTopicOperation.mock.calls[0][0]).toMatchObject({
    taskVersion: "old-v",
    task: "Preserved draft",
    context: contextRef(owner),
  });
  expect(screen.getByLabelText("Задача топика")).toHaveProperty(
    "value",
    "Preserved draft",
  );
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Опубликовать…" })
      .disabled,
  ).toBe(true);
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});
it.each(["current", "active", "other"])(
  "missing card permits selected deletion but retains active guard: %s",
  async (mode) => {
    localMissing();
    render(
      <TopicCard
        {...props()}
        selectedContextId={
          mode === "current" ? owner.contextId : otherOwner.contextId
        }
        runs={
          mode === "active"
            ? [
                {
                  id: "r",
                  projectId: project.id,
                  topic: owner.topic,
                  branch: owner.branch,
                  context: contextRef(owner),
                  status: "running",
                } as any,
              ]
            : []
        }
      />,
    );
    await screen.findByText(absence);
    await screen.findByText("Ещё не синхронизировано");
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Синхронизировать",
      }).disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Применить в базу…",
      }).disabled,
    ).toBe(false);
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Удалить топик и копию…",
      }).disabled,
    ).toBe(mode === "active");
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Опубликовать…" })
        .disabled,
    ).toBe(true);
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
    expect(api.syncContext).not.toHaveBeenCalled();
    expect(api.applyContext).not.toHaveBeenCalled();
    expect(api.deleteContext).not.toHaveBeenCalled();
  },
);
