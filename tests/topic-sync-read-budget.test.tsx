// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TopicContextPicker } from "../src/renderer/TopicContextPicker";
import { TopicSyncActions } from "../src/renderer/TopicSyncActions";
import { contextRef } from "../src/renderer/topic-context";
import { readRequest } from "../src/renderer/read-request";
import type { TopicBoardSnapshot } from "../src/shared/topics";
import type { TopicContextRef, WorktreeRecord } from "../src/shared/worktrees";
import type { ContextSyncState } from "../src/shared/context-sync";
const project = { id: "p", name: "Fixture", path: "/fixture" };
const copies: WorktreeRecord[] = Array.from({ length: 70 }, (_, index) => ({
  projectId: "p",
  year: "2026",
  topic: `topic-${index}`,
  branch: `branch-${index}`,
  contextId: "ctx-" + index.toString(16).padStart(64, "0"),
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "a".repeat(64),
  path: `/fixture/${index}`,
  gitCommonDir: `/fixture/${index}/.git`,
  projectPath: "/fixture",
  state: "ready",
  ownership: "managed",
  storageKind: "clone",
}));
const rows = copies.map((copy) => ({
  topic: copy.topic,
  branch: copy.branch,
  remote: false,
  current: copy === copies[0],
  statuses: [],
  hosts: [],
  todo: null,
  divergence: null,
}));
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "board",
  currentBranch: rows[0].branch,
  currentTopic: rows[0],
  baseRef: "main",
  branches: [],
  dirty: false,
  active: false,
  entries: rows,
  records: [],
  remoteEntries: [],
  remoteRecords: [],
};
const state = (
  ref: TopicContextRef,
  next: Partial<ContextSyncState> = {},
): ContextSyncState => ({
  projectId: ref.projectId,
  contextId: ref.contextId,
  revision: ref.revision,
  status: "new",
  waitingRunIds: [],
  reasons: [],
  updatedAt: "now",
  ...next,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let api: any,
  physical: {
    ref: TopicContextRef;
    response: ReturnType<typeof deferred<ContextSyncState>>;
  }[];
beforeEach(() => {
  vi.useFakeTimers();
  physical = [];
  api = {
    topicSyncStatus: vi.fn((ref: TopicContextRef) => {
      const response = deferred<ContextSyncState>();
      physical.push({ ref, response });
      return response.promise;
    }),
    syncTopicContext: vi.fn(async (ref: TopicContextRef) =>
      state(ref, { status: "synced" }),
    ),
    retryContextSync: vi.fn(async (ref: TopicContextRef) =>
      state(ref, { status: "synced" }),
    ),
    discover: vi.fn(async () => ({ topics: [] })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const props = {
  project,
  board,
  selected: null,
  knownContexts: copies,
  onSelect: vi.fn(),
  onClear: vi.fn(),
  onOpenCard: vi.fn(),
};
function mount() {
  const view = render(<TopicContextPicker {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  return view;
}
const syncName = (index: number) =>
  `Синхронизировать коммиты · topic-${index}/2026/branch-${index}`;
it("bounds 70 healthy deferred row status reads to four without starving unrelated discovery", async () => {
  mount();
  await act(async () => {});
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(4);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
  await act(async () => {
    await readRequest("discover", "p");
  });
  expect(api.discover).toHaveBeenCalledExactlyOnceWith("p");
  await act(async () => physical[0].response.resolve(state(physical[0].ref)));
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(5);
  expect(physical[4].ref).toEqual(contextRef(copies[4]));
});
it("drops closed queued reads and does not poll while no surface observes the owners", async () => {
  mount();
  await act(async () => {});
  expect(physical).toHaveLength(4);
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
  await act(async () => {
    for (const call of physical) call.response.resolve(state(call.ref));
  });
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(4);
});
it("drops unmounted queued reads without releasing still-pending dispatched jobs early", async () => {
  const view = mount();
  await act(async () => {});
  view.unmount();
  mount();
  await act(async () => {});
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(4);
  await act(async () => physical[0].response.resolve(state(physical[0].ref)));
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(5);
  expect(physical[4].ref).toEqual(contextRef(copies[0]));
});
it("skips an obsolete queued revision and dispatches its fresh exact ref only on a later slot", async () => {
  const view = mount();
  await act(async () => {});
  const fresh = {
    ...copies[4],
    revision: "00000000-0000-4000-8000-000000000002",
  };
  view.rerender(
    <TopicContextPicker
      {...props}
      knownContexts={copies.map((copy, index) => (index === 4 ? fresh : copy))}
    />,
  );
  await act(async () => {});
  await act(async () => physical[0].response.resolve(state(physical[0].ref)));
  expect(physical[4].ref).toEqual(contextRef(copies[5]));
  let done = 1;
  while (done < physical.length) {
    const calls = physical.slice(done);
    done = physical.length;
    await act(async () => {
      for (const call of calls) call.response.resolve(state(call.ref));
    });
  }
  const reads = physical.filter(
    (call) => call.ref.contextId === fresh.contextId,
  );
  expect(reads.map((call) => call.ref)).toEqual([contextRef(fresh)]);
  expect(screen.queryAllByRole("alert")).toHaveLength(0);
});
it("keeps a manual sync independent of a full read queue and coalesces card/picker writes", async () => {
  const view = mount();
  await act(async () => {});
  view.rerender(
    <>
      <TopicContextPicker {...props} />
      <TopicSyncActions owner={contextRef(copies[69])} onChanged={vi.fn()} />
    </>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: syncName(69) }));
  fireEvent.click(screen.getByRole("button", { name: "Синхронизировать" }));
  await act(async () => {});
  expect(api.syncTopicContext).toHaveBeenCalledExactlyOnceWith(
    contextRef(copies[69]),
  );
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(4);
  expect(screen.getAllByText("Синхронизировано")).toHaveLength(2);
});
it("deduplicates a manual retry while its host-truth reconciliation waits for a read slot", async () => {
  api.syncTopicContext.mockRejectedValueOnce(Error("Transport failed"));
  mount();
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: syncName(69) }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: syncName(69) }));
  fireEvent.click(screen.getByRole("button", { name: syncName(69) }));
  await act(async () => {});
  expect(api.syncTopicContext).toHaveBeenCalledTimes(1);
  expect(api.retryContextSync).not.toHaveBeenCalled();
  expect(api.topicSyncStatus).toHaveBeenCalledTimes(4);
  api.topicSyncStatus.mockImplementation(async (ref: TopicContextRef) =>
    state(
      ref,
      ref.contextId === copies[69].contextId
        ? { status: "error", error: "Recorded import failure" }
        : {},
    ),
  );
  await act(async () => physical[0].response.resolve(state(physical[0].ref)));
  expect(api.retryContextSync).toHaveBeenCalledExactlyOnceWith(
    contextRef(copies[69]),
  );
  expect(api.syncTopicContext).toHaveBeenCalledTimes(1);
});

it.each(["error", "new"] as const)(
  "preserves explicit retry through popup close while only its %s host-truth read continues",
  async (persistedStatus) => {
    api.syncTopicContext.mockRejectedValueOnce(Error("Transport failed"));
    mount();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: syncName(69) }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: syncName(69) }));
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: "Выбрать другой топик" }),
    );
    await act(async () => {});
    api.topicSyncStatus.mockResolvedValue(
      state(contextRef(copies[69]), {
        status: persistedStatus,
        ...(persistedStatus === "error"
          ? { error: "Recorded import failure" }
          : {}),
      }),
    );
    await act(async () => physical[0].response.resolve(state(physical[0].ref)));
    expect(api.topicSyncStatus).toHaveBeenCalledTimes(5);
    expect(api.topicSyncStatus).toHaveBeenLastCalledWith(
      contextRef(copies[69]),
    );
    if (persistedStatus === "error") {
      expect(api.retryContextSync).toHaveBeenCalledExactlyOnceWith(
        contextRef(copies[69]),
      );
      expect(api.syncTopicContext).toHaveBeenCalledTimes(1);
    } else {
      expect(api.syncTopicContext).toHaveBeenCalledTimes(2);
      expect(api.syncTopicContext).toHaveBeenLastCalledWith(
        contextRef(copies[69]),
      );
      expect(api.retryContextSync).not.toHaveBeenCalled();
    }
    expect(screen.queryByRole("grid")).toBeNull();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onClear).not.toHaveBeenCalled();
    expect(props.onOpenCard).not.toHaveBeenCalled();
  },
);
