// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TopicContextPicker } from "../src/renderer/TopicContextPicker";
import type { Project } from "../src/shared/types";
import type { TopicBoardSnapshot } from "../src/shared/topics";
import type { WorktreeRecord } from "../src/shared/worktrees";
import type { RunWithContext } from "../src/renderer/topic-context";

const project: Project = { id: "p", name: "Project", path: "/fixture/project" };
const row = (topic: string) => ({
  topic,
  branch: `feature/${topic}`,
  current: topic === "alpha",
  remote: false,
  statuses: [],
  todo: null,
  divergence: null,
});
const board: TopicBoardSnapshot = {
  projectId: "p",
  year: "2026",
  revision: "board-v",
  currentBranch: "feature/alpha",
  currentTopic: row("alpha"),
  baseRef: "main",
  branches: ["main", "feature/alpha", "feature/beta"],
  dirty: false,
  active: false,
  entries: ["alpha", "beta", "gamma"].map((topic) => ({
    ...row(topic),
    hosts: [],
  })),
  records: [row("alpha"), row("beta"), row("gamma")],
  remoteEntries: [],
  remoteRecords: [],
};
function record(
  topic: string,
  overrides: Partial<WorktreeRecord> = {},
): WorktreeRecord {
  return {
    ...row(topic),
    projectId: "p",
    year: "2026",
    contextId: `ctx-${({ alpha: "a", beta: "b", gamma: "c" }[topic] ?? "d").repeat(64)}`,
    revision: "202649d6-9194-4ec2-96c5-f814f2fa4586",
    repositoryKey: "a".repeat(64),
    projectPath: project.path,
    gitCommonDir: "/fixture/project/.git",
    path: `/fixture/copies/${topic}`,
    ownership: "managed",
    storageKind: "clone",
    state: "ready",
    ...overrides,
  };
}
const alpha = record("alpha"),
  beta = record("beta"),
  gamma = record("gamma");
function run(
  id: string,
  context?: WorktreeRecord,
  overrides: Partial<RunWithContext> = {},
): RunWithContext {
  return {
    id,
    projectId: "p",
    pipeline: "develop",
    topic: context?.topic ?? "beta",
    branch: context?.branch ?? "feature/beta",
    status: "running",
    startedAt: "2026-10-19T12:00:00Z",
    workflow: null,
    profile: null,
    context,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let api: {
  ensureTopicContext: ReturnType<typeof vi.fn>;
  resolveTopicContext: ReturnType<typeof vi.fn>;
  checkTopicContextReadiness: ReturnType<typeof vi.fn>;
  cancelRead: ReturnType<typeof vi.fn>;
  launch: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  api = {
    ensureTopicContext: vi.fn(async (identity) => record(identity.topic)),
    resolveTopicContext: vi.fn(async (ref) => record(ref.topic, ref)),
    checkTopicContextReadiness: vi.fn(async (ref) => record(ref.topic, ref)),
    cancelRead: vi.fn(async () => {}),
    launch: vi.fn(),
  };
  window.goga = api as unknown as typeof window.goga;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function mount(
  props: Partial<React.ComponentProps<typeof TopicContextPicker>> = {},
) {
  const onSelect = vi.fn(),
    onClear = vi.fn(),
    onOpenCard = vi.fn();
  const view = render(
    <TopicContextPicker
      project={project}
      board={board}
      selected={beta}
      knownContexts={[]}
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
function choose(topic: string) {
  fireEvent.click(screen.getByRole("row", { name: new RegExp(`^${topic} `) }));
}

describe("compact context picker", () => {
  it("separates viewing the selected card from changing context", () => {
    const { onOpenCard, onSelect } = mount();
    expect(screen.getByText("Топик:")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Открыть карточку топика beta" }),
    );
    expect(onOpenCard).toHaveBeenCalledExactlyOnceWith(
      { topic: "beta", branch: "feature/beta", remote: false },
      "2026",
    );
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(screen.queryByRole("grid")).toBeNull();
    open();
    expect(
      screen
        .getByRole("button", { name: "Выбрать другой топик" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("places the current match first, searches names/branches and marks current activity without guessing legacy", () => {
    mount({
      runs: [
        run("active", beta, { status: "starting" }),
        run("legacy"),
        run(
          "other",
          record("beta", { projectId: "other", contextId: "other-context" }),
          { projectId: "other" },
        ),
      ],
    });
    open();
    const options = screen.getAllByRole("row");
    expect(options).toHaveLength(4);
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(within(options[0]).getByText("beta")).toBeTruthy();
    expect(within(options[0]).getByText("Текущий")).toBeTruthy();
    expect(within(options[0]).getByText("● Конвейер")).toBeTruthy();
    expect(options[0].getAttribute("aria-label")).toContain("Активных: 1");
    fireEvent.change(screen.getByRole("combobox", { name: "Найти топик" }), {
      target: { value: "FEATURE/ALP" },
    });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(
      within(screen.getByRole("row", { name: /^alpha / })).getByText("alpha"),
    ).toBeTruthy();
    expect(screen.queryByText("● Конвейер")).toBeNull();
  });
  it("does not merge equal topic names from different years or leak other projects", () => {
    mount({
      knownContexts: [
        alpha,
        beta,
        record("alpha", { year: "2025", contextId: "old-alpha" }),
        record("foreign", { projectId: "q" }),
      ],
    });
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Найти топик" }), {
      target: { value: "alpha" },
    });
    const options = screen.getAllByRole("row");
    expect(options).toHaveLength(3);
    expect(screen.getByText(/· 2025/)).toBeTruthy();
    expect(screen.queryByText("foreign")).toBeNull();
  });
  it.each([["selected ready clone", beta]] as const)(
    "keeps the current marker in the name/status cell for %s",
    (_, selected) => {
      mount({ selected });
      open();
      const current = screen.getAllByRole("row")[0];
      const [nameCell, actionCell] = within(current).getAllByRole("gridcell");
      const marker = within(current).getByText("Текущий");
      expect(marker.closest(".topic-context-lines")).toBe(nameCell);
      expect(within(actionCell).queryByText("Текущий")).toBeNull();
      expect(
        within(nameCell).getByText(selected ? "Готова" : "Нет копии"),
      ).toBeTruthy();
      expect(current.getAttribute("aria-label")).toContain("Текущий");
      expect(current.getAttribute("aria-selected")).toBe("true");
    },
  );
  it("retains the useful explicit transition for an unprepared current primary", async () => {
    const view = mount({ selected: null });
    open();
    const transition = screen.getByRole("row", { name: /^alpha / });
    expect(transition.getAttribute("aria-selected")).toBe("false");
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    fireEvent.click(transition);
    await waitFor(() =>
      expect(view.onSelect).toHaveBeenCalledExactlyOnceWith(alpha),
    );
    expect(api.ensureTopicContext).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      year: "2026",
      topic: "alpha",
      branch: "feature/alpha",
    });
    expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
    expect(api.resolveTopicContext).not.toHaveBeenCalled();
  });
  it("keeps long topic identity and exact activity in the name cell without moving action controls", () => {
    const topic = "очень-длинное-название-топика-для-проверки-переноса-строк";
    const current = record(topic);
    mount({
      selected: current,
      knownContexts: [
        current,
        record(topic, { year: "2025", contextId: "old-long-owner" }),
      ],
      runs: [run("one", current), run("two", current)],
    });
    open();
    const row = screen.getAllByRole("row")[0];
    const [nameCell, actionCell] = within(row).getAllByRole("gridcell");
    expect(nameCell.querySelector("strong")?.textContent).toBe(
      `${topic} · 2026`,
    );
    expect(within(nameCell).getByText(`feature/${topic}`)).toBeTruthy();
    expect(within(nameCell).getByText("● Конвейер · ещё 1")).toBeTruthy();
    expect(within(nameCell).getByText("Текущий")).toBeTruthy();
    expect(row.getAttribute("aria-label")).toContain("Активных: 2");
    expect(within(actionCell).getAllByRole("button")).toHaveLength(1);
    expect(
      within(actionCell).getByRole("button", {
        name: `Синхронизировать коммиты · ${topic}/2026/feature/${topic}`,
      }),
    ).toBeTruthy();
  });
  it("declares a stable gutter and one equal-height action line regardless of current selection", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(
      "src/renderer/TopicContextPicker.css",
      "utf8",
    );
    document.head.append(style);
    try {
      mount();
      open();
      const rows = screen.getAllByRole("row");
      const gutters = rows.map((row) => {
        const computed = getComputedStyle(row);
        expect(computed.alignItems).toBe("start");
        return (
          computed.paddingInline ||
          `${computed.paddingLeft} ${computed.paddingRight}`
        );
      });
      expect(
        gutters.every(
          (gutter) => JSON.stringify(gutter) === JSON.stringify(gutters[0]),
        ),
      ).toBe(true);
      for (const row of rows) {
        const actions = row.querySelector(".topic-context-option-actions");
        if (!actions) {
          expect(row.textContent).toContain("Без топика");
          continue;
        }
        const computed = getComputedStyle(actions);
        expect(computed.gridTemplateAreas).toBe('"sync" "status"');
        expect(computed.alignItems).toBe("center");
        expect(computed.flexShrink).toBe("0");
        expect(computed.gridTemplateColumns).toBe("minmax(0, 1fr)");
        expect(computed.width).toBe("max-content");
        expect(computed.minWidth).toBe("32px");
        expect(computed.maxWidth).toBe("48%");
        const status = actions.querySelector(".topic-quick-sync-status")!;
        expect(getComputedStyle(status).whiteSpace).toBe("nowrap");
        expect(getComputedStyle(status).overflow).toBe("hidden");
        expect(getComputedStyle(status).textOverflow).toBe("ellipsis");
        for (const button of within(actions as HTMLElement).getAllByRole(
          "button",
        )) {
          const buttonStyle = getComputedStyle(button);
          expect(buttonStyle.height).toBe("32px");
          expect(buttonStyle.lineHeight).toBe("18px");
        }
        const sync = within(actions as HTMLElement).getByRole("button", {
          name: /^Синхронизировать коммиты/,
        });
        expect(getComputedStyle(sync).gridArea).toBe("sync");
      }
      expect(
        within(rows[0]).queryByRole("button", { name: "Перейти в beta" }),
      ).toBeNull();
      expect(
        getComputedStyle(rows[0].querySelector(".topic-context-lines")!)
          .overflowWrap,
      ).toBe("anywhere");
    } finally {
      style.remove();
    }
  });
  it("only publishes a new selected context after host preparation succeeds", async () => {
    const flight = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockReturnValue(flight.promise);
    const { onSelect } = mount();
    open();
    choose("alpha");
    expect(api.ensureTopicContext).toHaveBeenCalledExactlyOnceWith({
      projectId: "p",
      year: "2026",
      topic: "alpha",
      branch: "feature/alpha",
    });
    expect(screen.getByText("Подготавливаем рабочую копию…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Открыть карточку топика beta" }),
    ).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => flight.resolve(alpha));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(alpha);
    expect(screen.queryByRole("grid")).toBeNull();
    expect(api.launch).not.toHaveBeenCalled();
  });
  it("deduplicates a double click while the same identity is physically pending", async () => {
    const flight = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockReturnValue(flight.promise);
    const { onSelect } = mount();
    open();
    choose("alpha");
    choose("alpha");
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    await act(async () => flight.resolve(alpha));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(alpha);
  });
  it("keeping the already selected context invalidates an earlier pending choice", async () => {
    const flight = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockReturnValue(flight.promise);
    const { onSelect } = mount();
    open();
    choose("alpha");
    choose("beta");
    await act(async () => flight.resolve(alpha));
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  });
  it("marks explicit Without topic first when no managed context is selected", () => {
    mount({
      selected: null,
      board: {
        ...board,
        entries: [...board.entries].reverse(),
        records: [...board.records].reverse(),
      },
    });
    open();
    const first = screen.getAllByRole("row")[0];
    expect(within(first).getByText("Без топика")).toBeTruthy();
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(within(first).getByText("Текущий")).toBeTruthy();
  });
  it("ignores slow A after explicit B and never cancels a Git metadata write", async () => {
    const a = deferred<WorktreeRecord>(),
      g = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockImplementation((identity) =>
      identity.topic === "alpha" ? a.promise : g.promise,
    );
    const { onSelect } = mount();
    open();
    choose("alpha");
    choose("gamma");
    await act(async () => g.resolve(gamma));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(gamma);
    await act(async () => a.resolve(alpha));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(api.cancelRead).not.toHaveBeenCalled();
  });
  it("preserves the previous context on an error and retries only explicitly", async () => {
    api.ensureTopicContext.mockRejectedValueOnce(
      Error("Ветка занята внешней рабочей копией."),
    );
    const { onSelect } = mount();
    open();
    choose("alpha");
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Ветка занята внешней рабочей копией."),
    );
    expect(
      screen.getByRole("button", { name: "Открыть карточку топика beta" }),
    ).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(alpha),
    );
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(2);
  });
  it("rejects a non-ready or mismatched host response without publishing a context", async () => {
    api.ensureTopicContext.mockResolvedValueOnce(
      record("alpha", { state: "conflict", reason: "branch" }),
    );
    api.resolveTopicContext.mockResolvedValueOnce(gamma);
    const { onSelect } = mount();
    open();
    choose("alpha");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(api.resolveTopicContext).toHaveBeenCalledExactlyOnceWith({
        projectId: alpha.projectId,
        year: alpha.year,
        topic: alpha.topic,
        branch: alpha.branch,
        contextId: alpha.contextId,
        revision: alpha.revision,
      }),
    );
    expect(
      await screen.findByText(
        /Ответ проверки не соответствует подготовленной рабочей копии/,
      ),
    ).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  });
  it("times out UI only, ignores a late result and never auto-retries the write", async () => {
    vi.useFakeTimers();
    const flight = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockReturnValue(flight.promise);
    const { onSelect } = mount();
    open();
    choose("alpha");
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(screen.queryByText("Подготавливаем рабочую копию…")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Результат подготовки ещё может завершиться",
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "повтор сначала проверит копию",
    );
    expect(onSelect).not.toHaveBeenCalled();
    await act(async () => flight.resolve(alpha));
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    expect(api.cancelRead).not.toHaveBeenCalled();
  });
  it("an explicit retry of a still-pending identity waits on the existing write", async () => {
    vi.useFakeTimers();
    const flight = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockReturnValue(flight.promise);
    const { onSelect } = mount();
    open();
    choose("alpha");
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
    await act(async () => flight.resolve(alpha));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(alpha);
  });
  it("can return to the primary project without creating a copy or applying an older result", async () => {
    const flight = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockReturnValue(flight.promise);
    const { onClear, onSelect } = mount();
    open();
    choose("alpha");
    fireEvent.click(screen.getByRole("row", { name: /^Без топика / }));
    expect(onClear).toHaveBeenCalledTimes(1);
    await act(async () => flight.resolve(alpha));
    expect(onSelect).not.toHaveBeenCalled();
    expect(api.cancelRead).not.toHaveBeenCalled();
  });
  it("provides keyboard search/options, Escape focus restoration and outside dismissal", async () => {
    const user = userEvent.setup();
    mount();
    const trigger = screen.getByRole("button", {
      name: "Выбрать другой топик",
    });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const search = screen.getByRole("combobox", { name: "Найти топик" });
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute("aria-activedescendant")).toBe(
      screen.getAllByRole("row")[0].id,
    );
    await user.keyboard("{End}{ArrowUp}{Enter}");
    await waitFor(() =>
      expect(api.ensureTopicContext).toHaveBeenCalledWith({
        projectId: "p",
        year: "2026",
        topic: "gamma",
        branch: "feature/gamma",
      }),
    );
    open();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("grid")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    open();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("grid")).toBeNull();
  });
  it("keeps the popup keyboard order and closes when Tab leaves it", async () => {
    const user = userEvent.setup();
    render(
      <>
        <TopicContextPicker
          project={project}
          board={board}
          selected={beta}
          onSelect={vi.fn()}
          onClear={vi.fn()}
          onOpenCard={vi.fn()}
        />
        <button>После селектора</button>
      </>,
    );
    open();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "После селектора" }),
    );
    expect(screen.queryByRole("grid")).toBeNull();
  });
  it("bounds the scrollable option list to 300px", () => {
    const css = readFileSync("src/renderer/TopicContextPicker.css", "utf8");
    expect(css).toMatch(
      /\.topic-context-options\s*\{[^}]*max-height:\s*300px;[^}]*overflow-y:\s*auto;/,
    );
  });
  it("uses compact plain activity and separate non-shrinking transition actions", () => {
    const css = readFileSync("src/renderer/TopicContextPicker.css", "utf8");
    expect(css).toMatch(
      /\.topic-context-option-actions\s*\{[^}]*flex-shrink:\s*0;/,
    );
    expect(css).toMatch(/\.topic-context-activity\s*\{[^}]*font-size:\s*12px;/);
    expect(css).not.toMatch(
      /\.topic-context-current,\s*\.topic-context-activity\s*\{[^}]*border:/,
    );
  });
  it("does not allow opening or preparation while disabled", () => {
    mount({ disabled: true });
    const trigger = screen.getByRole("button", {
      name: "Выбрать другой топик",
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("grid")).toBeNull();
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
  });
  it("keeps quick creation disabled when the host callback is unavailable", () => {
    mount();
    open();
    fireEvent.change(screen.getByRole("combobox", { name: "Найти топик" }), {
      target: { value: "new-topic" },
    });
    expect(screen.getByText("Совпадений нет.")).toBeTruthy();
    const create = screen.getByRole("button", {
      name: "Создать «new-topic» и подготовить конвейер",
    });
    expect(create.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByText(/Создание топика недоступно в этой версии хоста/),
    ).toBeTruthy();
    fireEvent.click(create);
    expect(api.ensureTopicContext).not.toHaveBeenCalled();
    expect(api.launch).not.toHaveBeenCalled();
  });
  it("ignores a result after a project change or unmount", async () => {
    const flight = deferred<WorktreeRecord>();
    api.ensureTopicContext.mockReturnValue(flight.promise);
    const props = {
      board,
      knownContexts: [alpha, beta],
      selected: beta,
      onSelect: vi.fn(),
      onClear: vi.fn(),
      onOpenCard: vi.fn(),
    };
    api.resolveTopicContext.mockReturnValue(flight.promise);
    const view = render(<TopicContextPicker project={project} {...props} />);
    open();
    choose("alpha");
    view.rerender(
      <TopicContextPicker
        project={{ ...project, id: "q" }}
        {...props}
        selected={null}
        board={null}
      />,
    );
    await act(async () => flight.resolve(alpha));
    expect(props.onSelect).not.toHaveBeenCalled();
    view.unmount();
    expect(api.cancelRead).not.toHaveBeenCalled();
  });
});
it("does not require task metadata merely to switch to a physically ready owner", async () => {
  api.checkTopicContextReadiness.mockRejectedValue(
    Error("Описание задачи не сохранено в Git."),
  );
  const f = mount({ knownContexts: [alpha, beta] });
  open();
  fireEvent.click(screen.getByRole("row", { name: /^alpha / }));
  await waitFor(() => expect(f.onSelect).toHaveBeenCalledWith(alpha));
  expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
});

it("always offers an explicit Without topic row and never infers primary native selection", () => {
  const f = mount({ selected: null, board: null, knownContexts: [] });
  open();
  const primary = screen.getByRole("row", { name: /^Без топика / });
  expect(primary.getAttribute("aria-selected")).toBe("true");
  expect(
    screen.queryByRole("button", { name: "Основная папка проекта" }),
  ).toBeNull();
  expect(screen.queryByRole("button", { name: /^Перейти/ })).toBeNull();
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "not-found" },
  });
  expect(screen.getByRole("row", { name: /^Без топика / })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Home" });
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
  expect(f.onClear).toHaveBeenCalledTimes(1);
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  expect(api.resolveTopicContext).not.toHaveBeenCalled();
});
it("has no duplicate transition buttons and keeps topic names brighter than branch helpers", () => {
  mount();
  open();
  expect(screen.queryByRole("button", { name: /^Перейти/ })).toBeNull();
  const css = readFileSync("src/renderer/TopicContextPicker.css", "utf8");
  expect(css).toMatch(
    /\.topic-context-lines strong\s*\{[^}]*color:\s*var\(--text\)/,
  );
  expect(css).toMatch(/\.topic-context-readiness\s*\{[^}]*border:/);
});

it("uses short readiness badges while retaining the full explanation for assistive users", () => {
  mount();
  open();
  const ready = screen.getByRole("row", { name: /^beta / });
  expect(within(ready).getByText("Готова").getAttribute("title")).toBe(
    "Рабочая копия",
  );
  const absent = screen.getByRole("row", { name: /^alpha / });
  expect(within(absent).getByText("Нет копии").getAttribute("title")).toBe(
    "Копия подготовится при переходе",
  );
  expect(absent.getAttribute("aria-label")).toContain(
    "Копия подготовится при переходе",
  );
});

it("scrolls keyboard selection in the native portal's document", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const child = frame.contentWindow!;
  Object.assign(api, {
    setTopicPopupBounds: vi.fn(async () => {}),
    closeTopicPopup: vi.fn(async () => {}),
    onTopicPopupClosed: vi.fn(() => () => {}),
  });
  const opener = vi.spyOn(window, "open").mockReturnValue(child);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const view = mount();
  try {
    open();
    const local = within(child.document.body);
    const search = await local.findByRole("combobox");
    const list = local.getByRole("grid");
    const last = local.getAllByRole("row").at(-1)!;
    Object.defineProperty(list, "clientHeight", { value: 100 });
    Object.defineProperty(last, "offsetTop", { value: 300 });
    Object.defineProperty(last, "offsetHeight", { value: 20 });
    fireEvent.keyDown(search, { key: "End" });
    await waitFor(() => expect(list.scrollTop).toBe(220));
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(window.goga.closeTopicPopup).toHaveBeenCalled());
  } finally {
    view.unmount();
    frame.remove();
    opener.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("does not steal focus back from an outside control when the native layer closes", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const outside = document.createElement("button");
  outside.textContent = "Outside menu";
  document.body.append(outside);
  let dismiss!: (id: string) => void;
  const bounds = vi.fn(async () => {});
  Object.assign(api, {
    setTopicPopupBounds: bounds,
    closeTopicPopup: vi.fn(async () => {}),
    onTopicPopupClosed: (fn: typeof dismiss) => {
      dismiss = fn;
      return () => {};
    },
  });
  const opener = vi.spyOn(window, "open").mockReturnValue(frame.contentWindow);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const view = mount();
  try {
    open();
    await waitFor(() => expect(bounds).toHaveBeenCalled());
    outside.focus();
    act(() => dismiss((bounds.mock.calls[0] as unknown as [string])[0]));
    expect(document.activeElement).toBe(outside);
    expect(
      screen
        .getByRole("button", { name: "Выбрать другой топик" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  } finally {
    view.unmount();
    frame.remove();
    outside.remove();
    opener.mockRestore();
    vi.unstubAllGlobals();
  }
});
