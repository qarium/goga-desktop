// @vitest-environment jsdom
import { installHistoryWorker } from "./helpers/history-worker";
import { openPrototypeLaunch } from "./helpers/prototype-context-fixture";
import {
  worktreeContextRef,
  type WorktreeRecord,
} from "../src/shared/worktrees";
import { TopicCard } from "../src/renderer/TopicCard";
import { createTopicsStore } from "../src/renderer/topics-model";
import React from "react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  cleanup,
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import type { TopicTarget } from "../src/shared/topics";
import { topicTargetSchema } from "../src/shared/topics-schema";
import { App } from "../src/renderer/App";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { createDraftStore } from "../src/renderer/task-drafts";
const p = { id: "p", name: "Project", path: "/fixture" };
const a = {
  topic: "feature-a",
  branch: "feature/a",
  remote: false,
  current: true,
  statuses: ["todo"],
  todo: "A",
  divergence: null,
};
const b = {
  ...a,
  topic: "feature-b",
  branch: "feature/b",
  current: false,
  todo: "B",
};
const board = {
  projectId: "p",
  year: "2026",
  revision: "v",
  currentBranch: a.branch,
  currentTopic: a,
  baseRef: "main",
  branches: ["main", a.branch, b.branch],
  dirty: false,
  active: false,
  entries: [
    { ...a, hosts: [a.branch] },
    { ...b, hosts: [b.branch] },
  ],
  records: [a, b],
  remoteEntries: [],
  remoteRecords: [],
};
const ownerA: WorktreeRecord = {
  projectId: "p",
  year: "2026",
  topic: a.topic,
  branch: a.branch,
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "c".repeat(64),
  projectPath: p.path,
  gitCommonDir: `${p.path}/.git`,
  path: "/fixture-copies/a",
  ownership: "managed",
  state: "ready",
  storageKind: "clone",
};
const ownerB: WorktreeRecord = {
  ...ownerA,
  topic: b.topic,
  branch: b.branch,
  contextId: `ctx-${"b".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000002",
  path: "/fixture-copies/b",
};
let focusRun!: (id: string) => void;
let api: any;
beforeEach(() => {
  installHistoryWorker();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [p]),
    runs: vi.fn(async () => []),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: (cb: typeof focusRun) => {
      focusRun = cb;
      return () => {};
    },
    onViewError: () => () => {},
    readTopicBoard: vi.fn(async (scope: string | { projectId: string }) => ({
      ...board,
      projectId: typeof scope === "string" ? scope : scope.projectId,
    })),
    listTopicContexts: vi.fn(async (id: string) =>
      id === "p" ? [ownerA, ownerB] : [],
    ),
    ensureTopicContext: vi.fn(async (identity) => {
      const record = [ownerA, ownerB].find(
        (owner) =>
          owner.projectId === identity.projectId &&
          owner.topic === identity.topic &&
          owner.branch === identity.branch,
      );
      if (!record) throw Error("Unknown fixture context");
      expect(identity).toEqual({
        projectId: "p",
        year: "2026",
        topic: record.topic,
        branch: record.branch,
      });
      return record;
    }),
    resolveTopicContext: vi.fn(async (ref) => {
      const record = [ownerA, ownerB].find(
        (owner) => owner.contextId === ref.contextId,
      );
      if (!record) throw Error("Unknown fixture owner");
      expect(ref).toEqual(worktreeContextRef(record));
      return record;
    }),
    checkTopicContextReadiness: vi.fn(async (ref) => ({
      ...([ownerA, ownerB].find((owner) => owner.contextId === ref.contextId) ??
        ownerA),
      ...ref,
    })),
    selectTopicContext: vi.fn(async () => {}),
    topicSyncStatus: vi.fn(async (ref) => {
      const record = [ownerA, ownerB].find(
        (owner) => owner.contextId === ref.contextId,
      );
      if (!record) throw Error("Unknown fixture sync owner");
      expect(ref).toEqual(worktreeContextRef(record));
      return {
        projectId: ref.projectId,
        contextId: ref.contextId,
        revision: ref.revision,
        status: "synced",
        waitingRunIds: [],
        reasons: [],
        updatedAt: "2026-10-19T00:00:00Z",
      };
    }),
    contextDeletionRecovery: vi.fn(async () => null),
    readTopicDetails: vi.fn(async (_p, _y, t) => ({
      projectId: "p",
      year: "2026",
      target: t,
      text: "Original",
      version: "v",
      exists: true,
      editable: t.topic === a.topic,
    })),
    discover: vi.fn(async () => ({
      pipelines: [
        { id: "one", name: "One", description: "", project: true },
        { id: "two", name: "Two", description: "", project: true },
      ],
      topics: [a, b],
      branches: board.branches,
      currentBranch: a.branch,
      baseRef: "main",
      workflows: [],
      profiles: [],
    })),
    preview: vi.fn(async () => ({
      token: "preview",
      stages: [{ id: "build", title: "Build" }],
      workflow: null,
      profile: null,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "Original",
      version: "tv",
      exists: true,
      path: "todo.md",
    })),
    launch: vi.fn(),
    checkoutBranch: vi.fn(),
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  api.readTopicTable = api.readTopicBoard;
  api.readTopicOverview = api.readTopicDetails;
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("navigates board/card back to launch without losing task or pipeline or running/checkout", async () => {
  render(<App />);
  await screen.findByRole("heading", { name: "Project" });
  await openPrototypeLaunch();
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  await waitFor(() =>
    expect((task as HTMLTextAreaElement).value).toBe("Original"),
  );
  fireEvent.change(task, { target: { value: "Unsaved launch" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Конвейер" }), {
    target: { value: "two" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть топик feature-a" }),
  );
  expect(
    screen.queryByRole("button", { name: "Подготовить запуск" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть карточку" }));
  await openPrototypeLaunch();
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Что нужно сделать?",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("Unsaved launch");
  expect(
    (screen.getByRole("combobox", { name: "Конвейер" }) as HTMLSelectElement)
      .value,
  ).toBe("two");
  expect(api.discover).toHaveBeenLastCalledWith(worktreeContextRef(ownerA));
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.checkoutBranch).not.toHaveBeenCalled();
});
it("prepares requested local target and refuses to replace its dirty launch draft", async () => {
  const store = createDraftStore();
  store.tasks.set(JSON.stringify([p.id, "existing", b.branch, b.topic]), {
    text: "Kept draft",
    document: {
      text: "Original",
      version: "tv",
      exists: true,
      path: "todo.md",
    },
    status: "ready",
    error: "",
  });
  render(
    <LaunchForm
      project={p}
      draftStore={store}
      preparedTopic={{ target: b, text: "Card text", nonce: 1 }}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Что нужно сделать?",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Kept draft"),
  );
  expect(api.checkoutBranch).not.toHaveBeenCalled();
  expect(api.launch).not.toHaveBeenCalled();
});
it("run link reads its snapshot even when current project topic differs; hides native view", async () => {
  const run = {
    id: "run",
    projectId: "p",
    pipeline: "one",
    topic: b.topic,
    branch: b.branch,
    status: "running",
    url: "http://localhost:1000",
    dashboardOpened: true,
    startedAt: "2026-10-19T00:00:00Z",
    workflow: null,
    profile: null,
    taskSnapshot: {
      text: "Snapshot B",
      year: "2026",
      topic: b.topic,
      branch: b.branch,
    },
  };
  api.runs.mockResolvedValue([run]);
  render(<App />);
  await screen.findByRole("heading", { name: "Project" });
  act(() => focusRun("run"));
  await screen.findByRole("tab", { name: /one · feature-b/ });
  fireEvent.click(
    screen.getByRole("button", { name: "Топик запуска feature-b" }),
  );
  expect(await screen.findByText("Snapshot B")).toBeTruthy();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
  await waitFor(() => expect(api.selectRun).toHaveBeenLastCalledWith(null));
  expect(
    within(screen.getByRole("dialog")).getByText(/Топик этого запуска/),
  ).toBeTruthy();
});
it("retains a manually selected owner and its independent draft across project navigation", async () => {
  api.listProjects.mockResolvedValue([
    p,
    { ...p, id: "other", name: "Other project" },
  ]);
  render(<App />);
  await screen.findByRole("heading", { name: "Project" });
  await openPrototypeLaunch();
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
    {
      target: { value: "Owner A draft" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  fireEvent.click(await screen.findByRole("row", { name: /^feature-b / }));
  await screen.findByRole("button", {
    name: "Открыть карточку топика feature-b",
  });
  await openPrototypeLaunch();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Что нужно сделать?",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Original"),
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Что нужно сделать?" }),
    {
      target: { value: "Owner B draft" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: /Other project/ }));
  fireEvent.click(screen.getByRole("button", { name: "Project" }));
  await openPrototypeLaunch();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Что нужно сделать?",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Owner B draft"),
  );
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика feature-b" }),
  ).toBeTruthy();
  expect(api.discover).toHaveBeenLastCalledWith(worktreeContextRef(ownerB));
  expect(api.resolveTopicContext).toHaveBeenCalledWith(
    worktreeContextRef(ownerB),
  );
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.checkoutBranch).not.toHaveBeenCalled();
});

it("refresh updates the native board without changing explicit Without topic selection", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "Без топика" });
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  await screen.findByRole("button", { name: "Открыть топик feature-b" });
  api.readTopicBoard.mockResolvedValue({
    ...board,
    currentTopic: b,
    currentBranch: b.branch,
  });
  fireEvent.click(screen.getByRole("button", { name: "Обновить список" }));
  await waitFor(() =>
    expect(api.readTopicBoard.mock.calls.length).toBeGreaterThan(2),
  );
  expect(screen.getByRole("button", { name: "Без топика" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Открыть карточку топика feature-b" }),
  ).toBeNull();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
});

it("standalone preparation popup edits the same memory task without saving a project file", async () => {
  render(<StandalonePreparationPopup />);
  await waitFor(() =>
    expect(
      (
        screen.getByRole("textbox", {
          name: "Что нужно сделать?",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("Original"),
  );
  fireEvent.click(screen.getByRole("button", { name: /Выбрано для запуска:/ }));
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Задача подготовки запуска" }),
    { target: { value: "Edited in shared card" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Закрыть карточку" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Что нужно сделать?",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Edited in shared card");
  expect(api.launch).not.toHaveBeenCalled();
});
it("standalone cannot open a preparation card with an unresolved task editor callback", async () => {
  let resolve!: (doc: any) => void;
  const pendingTask = new Promise((r) => {
    resolve = r;
  });
  api.readTopicTask.mockReturnValue(pendingTask);
  render(<StandalonePreparationPopup />);
  await waitFor(() => expect(api.readTopicTask).toHaveBeenCalled());
  expect(
    screen.queryByRole("button", { name: /Выбрано для запуска:/ }),
  ).toBeNull();
  const link = screen
    .getAllByRole("button", { hidden: true })
    .find((e) => e.textContent?.includes("Выбрано для запуска:"))!;
  expect((link as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(link);
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(async () => {
    resolve({ text: "Loaded", version: "v", exists: true, path: "todo.md" });
  });
  await waitFor(() => expect((link as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(link);
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Задача подготовки запуска" }),
    { target: { value: "Kept after async read" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Закрыть карточку" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Что нужно сделать?",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Kept after async read");
});

it.each(["local"])(
  "opens %s board card through strict production target validation",
  async (mode) => {
    const remote = { ...b, branch: "origin/feature/b", remote: true };
    const snapshot =
      mode === "remote"
        ? {
            ...board,
            entries: [{ ...a, hosts: [a.branch] }],
            records: [a],
            remoteEntries: [{ ...remote, hosts: [remote.branch] }],
            remoteRecords: [remote],
          }
        : board;
    api.readTopicBoard.mockResolvedValue(snapshot);
    api.readTopicDetails.mockImplementation(
      async (
        _p: string,
        _y: string,
        target: { topic: string; branch: string; remote: boolean },
      ) => ({
        projectId: "p",
        year: "2026",
        target: topicTargetSchema.parse(target),
        text: "Validated full task",
        version: "a".repeat(64),
        exists: true,
        editable: !target.remote,
      }),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Топики" }));
    if (mode === "remote")
      fireEvent.click(
        await screen.findByRole("switch", { name: "Только удалённые ветки" }),
      );
    await screen.findByRole("button", { name: "Открыть топик feature-b" });
    if (mode === "per-host")
      fireEvent.click(
        screen.getByRole("switch", { name: "Состояния по веткам" }),
      );
    fireEvent.click(
      screen.getByRole("button", { name: "Открыть топик feature-b" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "feature-b" });
    await waitFor(() =>
      expect(within(dialog).queryByText("Загружаем топик…")).toBeNull(),
    );
    expect(within(dialog).queryByRole("alert")?.textContent ?? "").toBe("");
    expect(api.readTopicDetails).toHaveBeenCalledWith(
      mode === "remote" ? "p" : worktreeContextRef(ownerB),
      "2026",
      {
        topic: "feature-b",
        branch: mode === "remote" ? remote.branch : b.branch,
        remote: mode === "remote",
      },
    );
    expect(await within(dialog).findByText("Validated full task")).toBeTruthy();
  },
);

function StandalonePreparationPopup() {
  const [popup, setPopup] = React.useState<{
    target: TopicTarget;
    text: string;
    newTopic: boolean;
    edit: (text: string) => void;
  } | null>(null);
  const store = React.useRef(createTopicsStore());
  return (
    <>
      <LaunchForm
        project={p}
        suspended={Boolean(popup)}
        onCancel={() => {}}
        onLaunched={() => {}}
        onOpenTopic={(target, text, newTopic, edit) =>
          setPopup({ target, text, newTopic, edit })
        }
      />
      {popup && (
        <TopicCard
          project={p}
          year="2026"
          target={popup.target}
          board={board}
          store={store.current}
          context={{
            kind: "preparation",
            text: popup.text,
            newTopic: popup.newTopic,
            edit: popup.edit,
          }}
          onClose={() => setPopup(null)}
          onChanged={() => {}}
          onPrepare={() => {}}
        />
      )}
    </>
  );
}

it("switches from a table row through the existing context validation and pins it when returning", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Топики" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Переключиться на топик feature-b",
    }),
  );
  await screen.findByRole("button", {
    name: "Открыть карточку топика feature-b",
  });
  expect(api.resolveTopicContext).toHaveBeenCalledWith(
    worktreeContextRef(ownerB),
  );
  expect(api.checkoutBranch).not.toHaveBeenCalled();
  expect(api.launch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  const row = screen
    .getByRole("button", { name: "Открыть топик feature-b" })
    .closest("tr")!;
  expect(row.getAttribute("aria-current")).toBe("true");
  expect(row.parentElement?.firstElementChild).toBe(row);
});

it("exposes Artifacts only from the header selector, never from the topics table", async () => {
  api.listHistoryArtifacts = vi.fn(async () => []);
  render(<App />);
  await screen.findByRole("heading", { name: "Project" });
  const picker = await screen.findByRole("button", {
    name: "Выбрать другой топик",
  });
  await waitFor(() =>
    expect((picker as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("row", { name: /^feature-b / }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Открыть карточку топика feature-b",
    }),
  );
  fireEvent.click(await screen.findByRole("tab", { name: "Артефакты" }));
  await screen.findByText("Артефактов пока нет");
  expect(api.listHistoryArtifacts).toHaveBeenCalledWith(
    worktreeContextRef(ownerB),
    "2026",
    "feature-b",
    topicTargetSchema.parse({
      topic: b.topic,
      branch: b.branch,
      remote: false,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Закрыть карточку" }));
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Открыть топик feature-b" }),
  );
  expect(screen.queryByRole("tab", { name: "Артефакты" })).toBeNull();
});
