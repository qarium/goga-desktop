// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopicCard } from "../src/renderer/TopicCard";
import { TopicSyncActions } from "../src/renderer/TopicSyncActions";
import { TopicContextPicker } from "../src/renderer/TopicContextPicker";
import { createTopicsStore } from "../src/renderer/topics-model";
import { contextRef } from "../src/renderer/topic-context";
import type { WorktreeRecord } from "../src/shared/worktrees";
import type { TopicBoardSnapshot } from "../src/shared/topics";
import type { ContextSyncState } from "../src/shared/context-sync";
const project = { id: "p", name: "Fixture", path: "/fixture" };
const row = (topic: string) => ({
  topic,
  branch: topic,
  current: topic === "a",
  remote: false,
  statuses: [],
  todo: null,
  divergence: null,
  hosts: [],
});
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "board",
  currentBranch: "a",
  currentTopic: row("a"),
  baseRef: "main",
  branches: ["a", "b", "main"],
  dirty: false,
  active: false,
  entries: [row("a"), row("b"), row("unknown")],
  records: [],
  remoteEntries: [],
  remoteRecords: [],
};
const copy = (
  topic = "a",
  overrides: Partial<WorktreeRecord> = {},
): WorktreeRecord => ({
  projectId: "p",
  year: "2026",
  topic,
  branch: topic,
  contextId: "ctx-" + topic.repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "a".repeat(64),
  projectPath: "/fixture",
  gitCommonDir: `/fixture/${topic}/.git`,
  path: `/fixture/${topic}`,
  ownership: "managed",
  storageKind: "clone",
  state: "ready",
  ...overrides,
});
const a = copy(),
  b = copy("b");
const status = (
  owner = a,
  next: Partial<ContextSyncState> = {},
): ContextSyncState => ({
  projectId: owner.projectId,
  contextId: owner.contextId,
  revision: owner.revision,
  status: "new",
  waitingRunIds: [],
  reasons: [],
  updatedAt: "2026-10-20T00:00:00Z",
  ...next,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
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
    ensureTopicContext: vi.fn(),
    resolveTopicContext: vi.fn(),
    restoreTopicContext: vi.fn(),
    readTopicBoard: vi.fn(async () => board),
    readTopicDetails: vi.fn(async () => ({
      projectId: "p",
      year: "2026",
      target: row("a"),
      text: "Task",
      editable: true,
      exists: true,
      version: "v",
    })),
    topicSyncStatus: vi.fn(async (ref: WorktreeRecord) => status(ref)),
    syncTopicContext: vi.fn(async (ref: WorktreeRecord) =>
      status(ref, { status: "synced" }),
    ),
    retryContextSync: vi.fn(async (ref: WorktreeRecord) =>
      status(ref, { status: "synced" }),
    ),
    prepareContextApply: vi.fn(async () => ({
      ...contextRef(a),
      token: "token-a",
      canApply: true,
      targetBranch: "main",
      sourceOid: "aaa",
      targetOid: "bbb",
      files: ["a.txt"],
    })),
    applyContext: vi.fn(async () => ({})),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const quickName = (topic = "a") =>
  `Синхронизировать коммиты · ${topic}/2026/${topic}`;
function picker(
  props: Partial<React.ComponentProps<typeof TopicContextPicker>> = {},
) {
  const onSelect = vi.fn(),
    onClear = vi.fn(),
    onOpenCard = vi.fn();
  const view = render(
    <TopicContextPicker
      project={project}
      board={board}
      selected={b}
      knownContexts={[a, b]}
      onSelect={onSelect}
      onClear={onClear}
      onOpenCard={onOpenCard}
      {...props}
    />,
  );
  return { ...view, onSelect, onClear, onOpenCard };
}
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
}
function card(props: Partial<React.ComponentProps<typeof TopicCard>> = {}) {
  return render(
    <TopicCard
      project={project}
      year="2026"
      target={row("a")}
      board={board}
      store={createTopicsStore()}
      context={{ kind: "topic" }}
      contextRequired
      minimal
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPrepare={vi.fn()}
      {...props}
    />,
  );
}
it("shows a disabled transfer section for a confirmed ownerless card without preparing or reading primary", () => {
  card();
  const transfer = screen.getByRole("region", { name: "Перенос изменений" });
  expect(
    within(transfer).getByText(
      "Рабочая копия ещё не создана. Переносить пока нечего",
    ),
  ).toBeTruthy();
  expect(
    within(transfer).getByRole<HTMLButtonElement>("button", {
      name: "Синхронизировать",
    }).disabled,
  ).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Подготовить автономный клон" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: "Опубликовать…" })).toBeNull();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
  expect(api.readTopicBoard).not.toHaveBeenCalled();
});
it.each([
  ["loading", "Проверяем наличие рабочей копии…"],
  [
    "error",
    "Не удалось проверить рабочую копию. Её отсутствие не подтверждено.",
  ],
] as const)(
  "never reports an absent clone when inventory is %s",
  (ownerReadState, text) => {
    card({
      ownerReadState,
      ownerReadError:
        ownerReadState === "error" ? "Inventory failed" : undefined,
    });
    expect(screen.getByText(text)).toBeTruthy();
    expect(
      screen.queryByText(
        "Рабочая копия ещё не создана. Переносить пока нечего",
      ),
    ).toBeNull();
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
  },
);
it.each([
  [
    copy("a", { state: "missing" }),
    "Рабочая копия недоступна. Её отсутствие не означает, что она не создавалась.",
  ],
  [
    copy("a", { storageKind: "linked", compatibility: "legacy-linked" }),
    "Рабочая копия прежнего формата. Для переноса нужен подтверждённый автономный клон.",
  ],
  [
    copy("a", { state: "conflict", reason: "repository" }),
    "Рабочая копия не прошла проверку. Перенос недоступен.",
  ],
])(
  "distinguishes a known unavailable owner without ensure: %j",
  (owner, text) => {
    card({ owner });
    const transfer = screen.getByRole("region", { name: "Перенос изменений" });
    expect(within(transfer).getByText(text)).toBeTruthy();
    expect(
      within(transfer).getByRole<HTMLButtonElement>("button", {
        name: "Синхронизировать",
      }).disabled,
    ).toBe(true);
    expect(api.topicSyncStatus).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
  },
);
it("syncs exact row A with selected B and keeps dropdown, context and draft unchanged", async () => {
  const view = picker();
  open();
  expect(
    screen.getAllByRole("button", { name: /^Синхронизировать коммиты/ }),
  ).toHaveLength(2);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  await screen.findByText("Синхронизировано");
  expect(api.syncTopicContext).toHaveBeenCalledExactlyOnceWith(contextRef(a));
  expect(view.onSelect).not.toHaveBeenCalled();
  expect(view.onClear).not.toHaveBeenCalled();
  expect(view.onOpenCard).not.toHaveBeenCalled();
  expect(screen.getByRole("region", { name: "Выбор топика" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Открыть карточку топика b" }),
  ).toBeTruthy();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
  expect(api.restoreTopicContext).not.toHaveBeenCalled();
});
it("queues an active row in host and shows waiting without changing selection", async () => {
  api.syncTopicContext.mockResolvedValue(
    status(a, { status: "waiting", waitingRunIds: ["running-a"] }),
  );
  const view = picker({
    runs: [
      {
        id: "running-a",
        projectId: "p",
        topic: "a",
        branch: "a",
        context: a,
        status: "running",
        pipeline: "develop",
        startedAt: "now",
        workflow: null,
        profile: null,
      },
    ],
  });
  open();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  await screen.findByText("Ожидает завершения запуска");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: quickName() })
      .disabled,
  ).toBe(true);
  expect(api.syncTopicContext).toHaveBeenCalledExactlyOnceWith(contextRef(a));
  expect(view.onSelect).not.toHaveBeenCalled();
});
it("deduplicates simultaneous card and picker sync and shares host response", async () => {
  const pending = deferred<ContextSyncState>();
  api.syncTopicContext.mockReturnValue(pending.promise);
  render(
    <>
      <TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />
      <TopicContextPicker
        project={project}
        board={board}
        selected={b}
        knownContexts={[a, b]}
        onSelect={vi.fn()}
        onClear={vi.fn()}
        onOpenCard={vi.fn()}
      />
    </>,
  );
  open();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
  await act(async () => {});
  expect(api.syncTopicContext).toHaveBeenCalledExactlyOnceWith(contextRef(a));
  await act(async () => pending.resolve(status(a, { status: "synced" })));
  expect(screen.getAllByText("Синхронизировано")).toHaveLength(2);
});
it("shows an import error accessibly and retries exact row without selection", async () => {
  api.syncTopicContext.mockResolvedValue(
    status(a, { status: "error", error: "Import failed" }),
  );
  const view = picker();
  open();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Import failed",
  );
  const retry = screen.getByRole<HTMLButtonElement>("button", {
    name: quickName(),
  });
  expect(retry.title).toContain("Повторить");
  fireEvent.click(retry);
  await screen.findByText("Синхронизировано");
  expect(api.retryContextSync).toHaveBeenCalledExactlyOnceWith(contextRef(a));
  expect(view.onSelect).not.toHaveBeenCalled();
});
it("refreshes persisted host status on reopen rather than retaining a local success", async () => {
  const view = picker();
  open();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  await screen.findByText("Синхронизировано");
  open();
  const nextRead = deferred<ContextSyncState>();
  api.topicSyncStatus.mockImplementation((ref: WorktreeRecord) =>
    ref.contextId === a.contextId
      ? nextRead.promise
      : Promise.resolve(status(b)),
  );
  open();
  expect(screen.queryByText("Синхронизировано")).toBeNull();
  await act(async () =>
    nextRead.resolve(status(a, { status: "error", error: "Durable error" })),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Durable error",
  );
  expect(
    api.topicSyncStatus.mock.calls.filter(
      ([ref]: [WorktreeRecord]) => ref.contextId === a.contextId,
    ),
  ).toHaveLength(2);
  expect(view.onSelect).not.toHaveBeenCalled();
});
it.each([
  { contextId: b.contextId },
  { revision: "00000000-0000-4000-8000-000000000002" },
  { projectId: "q" },
])("rejects stale or wrong-owner sync replies: %j", async (wrong) => {
  api.syncTopicContext.mockResolvedValue(
    status(a, { status: "synced", ...wrong }),
  );
  picker();
  open();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "другой рабочей копии",
  );
  expect(screen.queryByText("Синхронизировано")).toBeNull();
});
it.each([b, copy("a", { revision: "00000000-0000-4000-8000-000000000002" })])(
  "ignores late writes for old owner/revision when sync card receives another ref: %j",
  async (next) => {
    const pending = deferred<ContextSyncState>();
    api.syncTopicContext.mockReturnValue(pending.promise);
    const onChanged = vi.fn();
    const view = render(
      <TopicSyncActions owner={contextRef(a)} onChanged={onChanged} />,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
    view.rerender(
      <TopicSyncActions owner={contextRef(next)} onChanged={onChanged} />,
    );
    await act(async () => {});
    await act(async () => pending.resolve(status(a, { status: "synced" })));
    expect(screen.queryByText("Синхронизировано")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  },
);
it("does not let a slow pre-sync status read overwrite completed sync", async () => {
  const pending = deferred<ContextSyncState>();
  api.topicSyncStatus.mockReturnValue(pending.promise);
  render(<TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
  await screen.findByText("Синхронизировано");
  await act(async () =>
    pending.resolve(status(a, { status: "error", error: "Stale failure" })),
  );
  expect(screen.getByText("Синхронизировано")).toBeTruthy();
  expect(screen.queryByText("Stale failure")).toBeNull();
});
it.each([
  copy("a", { state: "missing" }),
  copy("a", { storageKind: "linked", compatibility: "legacy-linked" }),
  copy("a", { storageKind: undefined }),
  copy("a", { preparation: "pending" }),
  copy("a", { ownership: "external" }),
])(
  "disables ineligible quick sync honestly without ensure/restore: %j",
  (owner) => {
    picker({ knownContexts: [owner, b] });
    open();
    const button = screen.getByRole<HTMLButtonElement>("button", {
      name: quickName(),
    });
    expect(button.disabled).toBe(true);
    expect(button.title).not.toBe(quickName());
    fireEvent.click(button);
    expect(api.syncTopicContext).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.restoreTopicContext).not.toHaveBeenCalled();
  },
);
it("isolates quick-sync Enter/Space/arrows and keeps controls unnested and keyboard accessible", async () => {
  const user = userEvent.setup();
  const view = picker();
  open();
  await act(async () => {});
  const button = screen.getByRole<HTMLButtonElement>("button", {
    name: quickName(),
  });
  button.focus();
  await user.keyboard("{ArrowDown}{ArrowUp}{Enter}");
  await screen.findByText("Синхронизировано");
  expect(view.onSelect).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(screen.getByRole("grid")).toBeTruthy();
  expect(button.closest("button button, a button, button a")).toBeNull();
  await user.keyboard(" ");
  expect(api.syncTopicContext).toHaveBeenCalledTimes(2);
  expect(view.onSelect).not.toHaveBeenCalled();
});
it("keeps historical cards without new sync or preparation actions", () => {
  card({
    owner: a,
    context: {
      kind: "run",
      run: {
        id: "old",
        projectId: "p",
        topic: "a",
        branch: "a",
        pipeline: "develop",
        status: "exited",
        startedAt: "now",
        workflow: null,
        profile: null,
      },
    },
  });
  expect(
    screen.queryByRole("region", { name: "Перенос изменений" }),
  ).toBeNull();
  expect(api.topicSyncStatus).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
});
it("does not call status new authored commits or treat synced as applied", async () => {
  render(<TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />);
  await act(async () => {});
  expect(screen.queryByText("Новые коммиты")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
  await screen.findByText("Синхронизировано");
  expect(api.applyContext).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Применить в базу…" }));
  await screen.findByText("a.txt");
  expect(api.applyContext).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Подтвердить применение" }),
  );
  await act(async () => {});
  expect(api.applyContext).toHaveBeenCalledExactlyOnceWith({
    projectId: "p",
    token: "token-a",
    confirmed: true,
  });
});
it("ignores stale apply preview after switching owners rather than applying its token", async () => {
  const pending = deferred<any>();
  api.prepareContextApply.mockReturnValue(pending.promise);
  const view = render(
    <TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Применить в базу…" }));
  view.rerender(<TopicSyncActions owner={contextRef(b)} onChanged={vi.fn()} />);
  await act(async () => {});
  await act(async () =>
    pending.resolve({
      ...contextRef(a),
      token: "old-token",
      canApply: true,
      targetBranch: "main",
      sourceOid: "aaa",
      targetOid: "bbb",
      files: ["stale.txt"],
    }),
  );
  expect(screen.queryByText("stale.txt")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Подтвердить применение" }),
  ).toBeNull();
  expect(api.applyContext).not.toHaveBeenCalled();
});

it("does not wedge the shared flight when a host API throws synchronously, and retries from fresh host truth", async () => {
  api.syncTopicContext.mockImplementationOnce(() => {
    throw Error("Host busy before journal");
  });
  render(<TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Host busy before journal",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить синхронизацию" }),
  );
  await screen.findByText("Синхронизировано");
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(2);
  expect(api.syncTopicContext).toHaveBeenCalledTimes(2);
  expect(api.retryContextSync).not.toHaveBeenCalled();
});
it("uses retry only after a failed transport is confirmed as a persisted host error", async () => {
  api.syncTopicContext.mockRejectedValueOnce(Error("Transport interrupted"));
  render(<TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
  await screen.findByRole("alert");
  api.topicSyncStatus.mockResolvedValue(
    status(a, { status: "error", error: "Recorded import failure" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить синхронизацию" }),
  );
  await screen.findByText("Синхронизировано");
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(2);
  expect(api.retryContextSync).toHaveBeenCalledExactlyOnceWith(contextRef(a));
});
it("does not revive a stale apply preview after A to B to A navigation", async () => {
  const pending = deferred<any>();
  api.prepareContextApply.mockReturnValue(pending.promise);
  const view = render(
    <TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Применить в базу…" }));
  view.rerender(<TopicSyncActions owner={contextRef(b)} onChanged={vi.fn()} />);
  await act(async () => {});
  view.rerender(<TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />);
  await act(async () => {});
  await act(async () =>
    pending.resolve({
      ...contextRef(a),
      token: "old-token",
      canApply: true,
      targetBranch: "main",
      sourceOid: "aaa",
      targetOid: "bbb",
      files: ["stale.txt"],
    }),
  );
  expect(screen.queryByText("stale.txt")).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Применить в базу…" })
      .disabled,
  ).toBe(false);
  expect(api.applyContext).not.toHaveBeenCalled();
});

it("keeps the isolated sync icon in an accessible grid cell with status on its own compact row", async () => {
  picker();
  open();
  await act(async () => {});
  const grid = screen.getByRole("grid", { name: "Топики проекта" });
  const row = within(grid).getByRole("row", { name: /^a / });
  expect(within(row).getAllByRole("gridcell")).toHaveLength(2);
  expect(
    within(row)
      .getByRole("button", { name: quickName() })
      .closest('[role="option"], button button'),
  ).toBeNull();
  const css = readFileSync("src/renderer/TopicContextPicker.css", "utf8");
  expect(css).toContain('grid-template-areas: "sync" "status"');
  expect(
    grid.querySelector(".topic-context-option-actions .topic-context-current"),
  ).toBeNull();
});
it("ignores an old owner status read after ref revision changes", async () => {
  const slow = deferred<ContextSyncState>();
  const fresh = copy("a", { revision: "00000000-0000-4000-8000-000000000002" });
  api.topicSyncStatus.mockImplementation((ref: WorktreeRecord) =>
    ref.revision === a.revision ? slow.promise : Promise.resolve(status(fresh)),
  );
  const view = render(
    <TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />,
  );
  view.rerender(
    <TopicSyncActions owner={contextRef(fresh)} onChanged={vi.fn()} />,
  );
  await act(async () => {});
  await act(async () => slow.resolve(status(a, { status: "synced" })));
  expect(screen.queryByText("Синхронизировано")).toBeNull();
  expect(screen.getByText("Ещё не синхронизировано")).toBeTruthy();
});
it("coalesces a physically pending import through closing and reopening the picker", async () => {
  const pending = deferred<ContextSyncState>();
  api.syncTopicContext.mockReturnValue(pending.promise);
  picker();
  open();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  await act(async () => {});
  open();
  open();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: quickName() })
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  expect(api.syncTopicContext).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(status(a, { status: "synced" })));
  expect(screen.getByText("Синхронизировано")).toBeTruthy();
});

it("requires fresh apply preview after leaving a displayed confirmation and returning to the same owner", async () => {
  const view = render(
    <TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Применить в базу…" }));
  await screen.findByText("a.txt");
  view.rerender(<TopicSyncActions owner={contextRef(b)} onChanged={vi.fn()} />);
  await act(async () => {});
  view.rerender(<TopicSyncActions owner={contextRef(a)} onChanged={vi.fn()} />);
  await act(async () => {});
  expect(
    screen.queryByRole("button", { name: "Подтвердить применение" }),
  ).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Применить в базу…" })
      .disabled,
  ).toBe(false);
});
it("notifies transition intent before exact row resolution, not for viewing or quick-sync", async () => {
  const order: string[] = [],
    onTransitionIntent = vi.fn(() => order.push("intent"));
  api.resolveTopicContext.mockImplementation(async () => {
    order.push("resolve");
    return a;
  });
  picker({ onTransitionIntent });
  open();
  await act(async () => {});
  expect(onTransitionIntent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: quickName() }));
  await screen.findByText("Синхронизировано");
  expect(onTransitionIntent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("row", { name: /^a / }));
  await act(async () => {});
  expect(order).toEqual(["intent", "resolve"]);
  expect(onTransitionIntent).toHaveBeenCalledOnce();
});
it("keeps ownerless copy availability compact and both transfer actions disabled", () => {
  card();
  const transfer = screen.getByRole("region", { name: "Перенос изменений" });
  expect(
    within(transfer).getByRole<HTMLButtonElement>("button", {
      name: "Применить в базу…",
    }).disabled,
  ).toBe(true);
  expect(
    screen
      .getByRole("region", { name: "Контекст топика недоступен" })
      .classList.contains("topic-card-state"),
  ).toBe(false);
});
it("keeps idle sync detail out of row layout and queued state compact but fully accessible", async () => {
  api.syncTopicContext.mockResolvedValue(
    status(a, { status: "waiting", waitingRunIds: ["active"] }),
  );
  picker();
  open();
  await act(async () => {});
  const row = screen.getByRole("row", { name: /^a / });
  expect(
    within(row).getByText("Ещё не синхронизировано").closest(".sr-only"),
  ).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: quickName() }));
  expect(await within(row).findByText("В очереди")).toBeTruthy();
  expect(
    within(row).getByText("Ожидает завершения запуска").closest(".sr-only"),
  ).toBeTruthy();
});
