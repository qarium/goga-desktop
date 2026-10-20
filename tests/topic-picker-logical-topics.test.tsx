// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopicContextPicker } from "../src/renderer/TopicContextPicker";
import type { Project } from "../src/shared/types";
import type { TopicBoardSnapshot } from "../src/shared/topics";
import type { WorktreeRecord } from "../src/shared/worktrees";
import type { RunWithContext } from "../src/renderer/topic-context";

const project: Project = { id: "p", name: "Fixture", path: "/fixture/project" };
const own = (topic: string, branch = `own/${topic}`) => ({
  topic,
  branch,
  current: topic === "backoff",
  remote: false,
  hosts: [],
  statuses: [],
  todo: null,
  divergence: null,
});
const board: TopicBoardSnapshot = {
  projectId: project.id,
  year: "2026",
  revision: "board-r",
  currentBranch: "own/backoff",
  currentTopic: own("backoff"),
  baseRef: "main",
  branches: ["main"],
  dirty: false,
  active: false,
  entries: [own("backoff"), own("other")],
  records: [
    own("backoff"),
    ...["main", "staging", "release", "somewhere", "other"].map((branch) =>
      own("backoff", branch),
    ),
  ],
  remoteEntries: [],
  remoteRecords: [],
};
const copy = (overrides: Partial<WorktreeRecord> = {}): WorktreeRecord => ({
  projectId: project.id,
  year: "2026",
  topic: "backoff",
  branch: "own/backoff",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "202649d6-9194-4ec2-96c5-f814f2fa4586",
  repositoryKey: "a".repeat(64),
  projectPath: project.path,
  gitCommonDir: "/fixture/copy/.git",
  path: "/fixture/copy",
  ownership: "managed",
  storageKind: "clone",
  state: "ready",
  ...overrides,
});
const run = (
  id: string,
  context: WorktreeRecord,
  overrides: Partial<RunWithContext> = {},
): RunWithContext => ({
  id,
  context,
  projectId: context.projectId,
  topic: context.topic,
  branch: context.branch,
  pipeline: "develop",
  status: "starting",
  startedAt: "2026-10-20T12:00:00Z",
  workflow: null,
  profile: null,
  ...overrides,
});
let ensure: ReturnType<typeof vi.fn>;
let resolve: ReturnType<typeof vi.fn>;
beforeEach(() => {
  ensure = vi.fn(async (identity) => copy(identity));
  resolve = vi.fn(async (ref) => copy(ref));
  window.goga = {
    ensureTopicContext: ensure,
    resolveTopicContext: resolve,
  } as unknown as typeof window.goga;
});
afterEach(cleanup);
function mount(
  props: Partial<React.ComponentProps<typeof TopicContextPicker>> = {},
) {
  const onSelect = vi.fn();
  const view = render(
    <TopicContextPicker
      project={project}
      board={board}
      selected={null}
      onSelect={onSelect}
      onClear={vi.fn()}
      onOpenCard={vi.fn()}
      {...props}
    />,
  );
  return { ...view, onSelect };
}
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "Выбрать другой топик" }));
const optionsFor = (topic: string) =>
  screen.getAllByRole("row", { name: new RegExp(`^${topic} `) });

describe("approved unique logical topic picker", () => {
  it("lists a canonical logical topic once despite five placements and duplicate source entries", async () => {
    const { onSelect } = mount({
      board: { ...board, entries: [...board.entries, own("backoff")] },
    });
    open();
    expect(optionsFor("backoff")).toHaveLength(1);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(
      within(optionsFor("backoff")[0]).getByText("own/backoff"),
    ).toBeTruthy();
    expect(screen.queryByText("2026")).toBeNull();
    expect(ensure).not.toHaveBeenCalled();
    fireEvent.click(optionsFor("other")[0]);
    await act(async () => {});
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      year: "2026",
      topic: "other",
      branch: "own/other",
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(
      copy({ topic: "other", branch: "own/other" }),
    );
  });

  it("keeps an actual current primary target even when it is absent from entries and never guesses a branch from the slug", async () => {
    mount({
      board: {
        ...board,
        entries: [own("other")],
        currentTopic: own("backoff", "refs/real-owner"),
      },
    });
    open();
    const first = optionsFor("backoff")[0];
    expect(within(first).getByText("backoff")).toBeTruthy();
    expect(within(first).getByText("refs/real-owner")).toBeTruthy();
    expect(ensure).not.toHaveBeenCalled();
    fireEvent.click(first);
    await act(async () => {});
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      year: "2026",
      topic: "backoff",
      branch: "refs/real-owner",
    });
  });

  it("offers an explicit keyboard preparation for an unprepared current primary without doing work during rendering or card viewing", async () => {
    const user = userEvent.setup();
    const { onSelect } = mount();
    expect(screen.getByRole("button", { name: "Без топика" })).toBeTruthy();
    open();
    const first = optionsFor("backoff")[0];
    expect(first.getAttribute("aria-selected")).toBe("false");
    expect(within(first).getByText("Нет копии")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Перейти/ })).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "backoff" },
    });
    expect(ensure).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      year: "2026",
      topic: "backoff",
      branch: "own/backoff",
    });
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("shows ready, missing and legacy copy status while only the actual selected owner has no transition", () => {
    const selected = copy();
    mount({
      selected,
      knownContexts: [
        selected,
        copy({
          topic: "other",
          branch: "own/other",
          contextId: "missing-owner",
          state: "missing",
        }),
        copy({
          topic: "legacy",
          branch: "own/legacy",
          contextId: "legacy-owner",
          storageKind: "linked",
          compatibility: "legacy-linked",
        }),
      ],
    });
    open();
    const first = screen.getAllByRole("row")[0];
    expect(within(first).getByText("Готова")).toBeTruthy();
    expect(
      within(first).queryByRole("button", { name: "Перейти в backoff" }),
    ).toBeNull();
    expect(
      within(first).getByRole("button", { name: /^Синхронизировать коммиты/ }),
    ).toBeTruthy();
    expect(within(optionsFor("other")[0]).getByText("Недоступна")).toBeTruthy();
    expect(
      within(optionsFor("other")[0]).queryByRole("button", {
        name: /^Перейти/,
      }),
    ).toBeNull();
    expect(
      within(optionsFor("legacy")[0]).getByText("Старый формат"),
    ).toBeTruthy();
  });

  it("preserves same-name years and distinct host owner ids without resurrecting deleted owners", () => {
    const selected = copy({ contextId: "selected-owner" });
    mount({
      selected,
      knownContexts: [
        selected,
        selected,
        copy({ contextId: "another-owner" }),
        copy({ contextId: "older-owner", year: "2025" }),
        copy({ contextId: "deleted-owner", deletedAt: "2026-10-19T10:00:00Z" }),
        copy({ projectId: "q", contextId: "foreign-owner" }),
      ],
    });
    open();
    const rows = optionsFor("backoff");
    expect(rows).toHaveLength(3);
    expect(
      rows.filter((row) => row.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    expect(within(rows[0]).getByText("Текущий")).toBeTruthy();
    expect(within(rows[0]).getByText(/2026/)).toBeTruthy();
    expect(rows.some((row) => row.textContent?.includes("2025"))).toBe(true);
    expect(
      rows.map((row) => row.getAttribute("aria-label")).join(" "),
    ).not.toContain("deleted-owner");
    expect(rows[0].getAttribute("aria-label")).toContain("selected-owner");
    expect(rows[1].getAttribute("aria-label")).toContain("another-owner");
  });

  it("does not arbitrarily mark an ambiguous primary owner, but marks the exact explicitly selected second owner", () => {
    const a = copy(),
      b = copy({ contextId: "second-owner" }),
      old = copy({ year: "2025", contextId: "old-owner" });
    const props = { knownContexts: [a, b, old], selected: null };
    const view = mount(props);
    open();
    let rows = optionsFor("backoff");
    expect(rows).toHaveLength(3);
    expect(
      rows.every((row) => row.getAttribute("aria-selected") === "false"),
    ).toBe(true);
    expect(
      within(screen.getByRole("row", { name: /^Без топика / })).getByText(
        "Текущий",
      ),
    ).toBeTruthy();
    expect(within(rows[0]).getByText(/Копия 1/)).toBeTruthy();
    expect(within(rows[1]).getByText(/Копия 2/)).toBeTruthy();
    expect(rows[2].textContent).toContain("2025");
    expect(
      rows
        .slice(0, 2)
        .every(
          (row) =>
            within(row).queryByRole("button", { name: /^Перейти/ }) === null,
        ),
    ).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    view.rerender(
      <TopicContextPicker
        project={project}
        board={board}
        knownContexts={props.knownContexts}
        selected={b}
        onSelect={view.onSelect}
        onClear={vi.fn()}
        onOpenCard={vi.fn()}
      />,
    );
    open();
    rows = optionsFor("backoff");
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute("aria-label")).toContain("second-owner");
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(within(rows[0]).getByText("Текущий")).toBeTruthy();
    expect(
      rows
        .slice(1)
        .every((row) => row.getAttribute("aria-selected") === "false"),
    ).toBe(true);
    expect(screen.getAllByText("Текущий")).toHaveLength(1);
  });

  it.each(["missing", "ready"] as const)(
    "uses refreshed inventory over selected %s history and explicitly resolves the fresh revision",
    async (staleState) => {
      const stale = copy({ state: staleState }),
        fresh = copy({ revision: "300649d6-9194-4ec2-96c5-f814f2fa4586" });
      resolve.mockResolvedValue(fresh);
      const view = mount({ selected: stale, knownContexts: [stale] });
      open();
      view.rerender(
        <TopicContextPicker
          project={project}
          board={board}
          selected={stale}
          knownContexts={[fresh]}
          onSelect={view.onSelect}
          onClear={vi.fn()}
          onOpenCard={vi.fn()}
        />,
      );
      const row = optionsFor("backoff")[0];
      expect(within(row).getByText("Готова")).toBeTruthy();
      expect(view.onSelect).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      fireEvent.click(row);
      await act(async () => {});
      expect(resolve).toHaveBeenCalledExactlyOnceWith({
        projectId: fresh.projectId,
        year: fresh.year,
        topic: fresh.topic,
        branch: fresh.branch,
        contextId: fresh.contextId,
        revision: fresh.revision,
      });
      expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(fresh);
      expect(ensure).not.toHaveBeenCalled();
    },
  );

  it("attributes activity to the exact actual record owner, never to matching placement/topic/branch or legacy runs", () => {
    const owner = copy(),
      otherOwner = copy({ contextId: "other-owner" });
    mount({
      knownContexts: [owner, otherOwner],
      runs: [
        run("actual", owner, { pipelineName: "Разработка" }),
        run("other", otherOwner, { kind: "build" }),
        run("old", copy({ year: "2025" })),
        run("placement", copy({ branch: "staging" })),
        run("foreign", copy({ projectId: "q" })),
        run("legacy", owner, { context: undefined }),
      ],
    });
    open();
    const rows = optionsFor("backoff");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("● Конвейер «Разработка»")).toBeTruthy();
    expect(within(rows[0]).queryByText("● Сборка")).toBeNull();
    expect(within(rows[1]).getByText("● Сборка")).toBeTruthy();
    expect(
      rows.every((row) =>
        row.getAttribute("aria-label")?.includes("Активных: 1"),
      ),
    ).toBe(true);
  });

  it.each([
    { state: "missing" as const, reason: "missing" as const },
    {
      storageKind: "linked" as const,
      compatibility: "legacy-linked" as const,
      state: "conflict" as const,
      reason: "legacy-linked" as const,
    },
    { storageKind: "linked" as const, compatibility: "legacy-linked" as const },
  ])(
    "opens a host-issued unavailable/legacy owner as read-only history without historical runs or ensure: %o",
    (overrides) => {
      const owner = copy(overrides);
      const { onSelect } = mount({ knownContexts: [owner], runs: [] });
      open();
      fireEvent.click(optionsFor("backoff")[0]);
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(owner);
      expect(ensure).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(onSelect.mock.calls[0][0].state).toBe(owner.state);
      expect(onSelect.mock.calls[0][0].storageKind).toBe(owner.storageKind);
    },
  );

  it("resolves the exact explicit ready owner ref even when another owner shares its full logical tuple", async () => {
    const a = copy(),
      b = copy({ contextId: "ctx-" + "b".repeat(64) });
    resolve.mockResolvedValue(b);
    const { onSelect } = mount({ knownContexts: [a, b] });
    open();
    fireEvent.click(optionsFor("backoff")[1]);
    await act(async () => {});
    expect(resolve).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      year: "2026",
      topic: "backoff",
      branch: "own/backoff",
      contextId: b.contextId,
      revision: b.revision,
    });
    expect(ensure).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(b);
  });

  it.each([
    { projectId: "q" },
    { year: "2025" },
    { topic: "different" },
    { branch: "placement" },
    { contextId: "other-owner" },
    { revision: "new-host-revision" },
    { state: "missing" as const },
    { deletedAt: "2026-10-19T10:00:00Z" },
  ])(
    "does not publish a changed ready-owner ref/state returned by resolve: %o",
    async (overrides) => {
      const owner = copy();
      resolve.mockResolvedValue(copy(overrides));
      const { onSelect } = mount({ knownContexts: [owner] });
      open();
      fireEvent.click(optionsFor("backoff")[0]);
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(resolve).toHaveBeenCalledOnce();
      expect(ensure).not.toHaveBeenCalled();
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it("ignores late ready-owner resolution after explicit read-only selection of a missing owner", async () => {
    const a = copy(),
      b = copy({
        topic: "other",
        branch: "own/other",
        contextId: "missing-owner",
        state: "missing",
      });
    let finish!: (record: WorktreeRecord) => void;
    resolve.mockReturnValue(
      new Promise<WorktreeRecord>((done) => {
        finish = done;
      }),
    );
    const { onSelect } = mount({ knownContexts: [a, b] });
    open();
    fireEvent.click(optionsFor("backoff")[0]);
    fireEvent.click(optionsFor("other")[0]);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(b);
    await act(async () => finish(a));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("keeps late A from replacing explicit ready B while both exact reads are pending", async () => {
    const a = copy(),
      b = copy({
        topic: "other",
        branch: "own/other",
        contextId: "ctx-" + "b".repeat(64),
      });
    let finishA!: (record: WorktreeRecord) => void,
      finishB!: (record: WorktreeRecord) => void;
    resolve.mockImplementation(
      (ref) =>
        new Promise<WorktreeRecord>((done) => {
          if (ref.contextId === a.contextId) finishA = done;
          else finishB = done;
        }),
    );
    const { onSelect } = mount({ knownContexts: [a, b] });
    open();
    fireEvent.click(optionsFor("backoff")[0]);
    fireEvent.click(optionsFor("other")[0]);
    await act(async () => finishB(b));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(b);
    await act(async () => finishA(a));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("fails safely instead of ensuring a known ready owner if exact resolver is unavailable", async () => {
    delete (window.goga as Partial<typeof window.goga>).resolveTopicContext;
    const { onSelect } = mount({ knownContexts: [copy()] });
    open();
    fireEvent.click(optionsFor("backoff")[0]);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("проверка"),
    );
    expect(ensure).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("rejects a different owner returned for an explicit known-owner transition", async () => {
    const owner = copy({ contextId: "wanted-owner" });
    resolve.mockResolvedValue(copy({ contextId: "other-owner" }));
    const { onSelect } = mount({ knownContexts: [owner] });
    open();
    fireEvent.click(optionsFor("backoff")[0]);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("не соответствует"),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});
