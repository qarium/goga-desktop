// @vitest-environment jsdom
import React, { createRef } from "react";
import userEvent from "@testing-library/user-event";
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
import {
  RepositoryActions,
  RepositoryOperationPopup,
} from "../src/renderer/RepositoryActions";
import { TopicQuickSync } from "../src/renderer/TopicQuickSync";
import { TopicContextPicker } from "../src/renderer/TopicContextPicker";
import type { WorktreeRecord } from "../src/shared/worktrees";
const project = { id: "p", name: "Project", path: "/fixture/project" };
const owner = {
  projectId: "p",
  topic: "alpha",
  branch: "feature/alpha",
  year: "2026",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "b".repeat(64),
  projectPath: project.path,
  path: "/fixture/clone",
  gitCommonDir: "/fixture/clone/.git",
  storageKind: "clone",
  ownership: "managed",
  state: "ready",
} as WorktreeRecord;
let api: any;
beforeEach(() => {
  api = {
    runRepositoryAction: vi.fn(async (r: any) => ({
      projectId: r.projectId,
      contextId: r.context?.contextId,
      action: r.action,
      status: "success",
      log: "done",
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
it.each([false, true])(
  "waits for the native selector close acknowledgement (already closing: %s)",
  async (alreadyClosing) => {
    let finish!: (v: any) => void, release!: () => void;
    api.runRepositoryAction.mockImplementation(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const frames = [
      document.createElement("iframe"),
      document.createElement("iframe"),
    ];
    frames.forEach((f) => document.body.append(f));
    let active = false,
      opens = 0;
    Object.assign(api, {
      setTopicPopupBounds: vi.fn(async () => {}),
      closeTopicPopup: vi.fn(
        () =>
          new Promise<void>((r) => {
            release = () => {
              active = false;
              r();
            };
          }),
      ),
      onTopicPopupClosed: () => () => {},
    });
    const opener = vi.spyOn(window, "open").mockImplementation(() => {
      if (active) return null;
      active = true;
      return frames[opens++].contentWindow;
    });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const anchor = createRef<HTMLDivElement>();
    const view = render(
      <>
        <div ref={anchor}>
          <RepositoryActions project={project} selected={owner} />
        </div>
        <TopicContextPicker
          project={project}
          board={null}
          selected={owner}
          onSelect={vi.fn()}
          onClear={vi.fn()}
          onOpenCard={vi.fn()}
        />
        <RepositoryOperationPopup anchor={anchor} />
      </>,
    );
    try {
      fireEvent.click(screen.getByLabelText("Опубликовать топик"));
      fireEvent.click(screen.getByLabelText("Выбрать другой топик"));
      expect(opens).toBe(1);
      if (alreadyClosing)
        fireEvent.click(screen.getByLabelText("Выбрать другой топик"));
      await act(async () =>
        finish({
          projectId: "p",
          contextId: owner.contextId,
          action: "publish",
          status: "error",
          log: "partial operation",
          error: "Remote failed",
        }),
      );
      expect(api.closeTopicPopup).toHaveBeenCalled();
      expect(opener).toHaveBeenCalledTimes(1);
      await act(async () => release());
      expect(opens).toBe(2);
      expect(
        within(frames[1].contentDocument!.body).getByRole("dialog").textContent,
      ).toContain("partial operation");
    } finally {
      view.unmount();
      release?.();
      opener.mockRestore();
      frames.forEach((f) => f.remove());
      vi.unstubAllGlobals();
    }
  },
);
function mount(selected: WorktreeRecord | null = owner) {
  const anchor = createRef<HTMLDivElement>();
  return render(
    <>
      <div ref={anchor}>
        <RepositoryActions project={project} selected={selected} />
      </div>
      <RepositoryOperationPopup anchor={anchor} />
    </>,
  );
}
it("shows four topic actions in order and only sync/publish for primary", () => {
  const view = mount();
  expect(
    screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
  ).toEqual([
    "Синхронизировать топик",
    "Опубликовать топик",
    "Обновить из base",
    "Перенести топик в base и опубликовать",
  ]);
  expect(
    [
      ...screen
        .getByLabelText("Синхронизировать топик")
        .querySelectorAll("svg path"),
    ].map((path) => path.getAttribute("d")),
  ).toEqual([
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ]);
  view.unmount();
  mount(null);
  expect(
    screen.getAllByRole("button").map((b) => b.getAttribute("aria-label")),
  ).toEqual(["Синхронизировать текущую ветку", "Опубликовать текущую ветку"]);
});
it("uses GitMerge and leaves selector rows sync-only", () => {
  const view = mount();
  const icon = screen
    .getByLabelText("Перенести топик в base и опубликовать")
    .querySelector("svg")!;
  expect(
    [...icon.querySelectorAll("circle")].map((c) => [
      c.getAttribute("cx"),
      c.getAttribute("cy"),
      c.getAttribute("r"),
    ]),
  ).toEqual([
    ["18", "18", "3"],
    ["6", "6", "3"],
  ]);
  expect(
    [...icon.querySelectorAll("path")].map((p) => p.getAttribute("d")),
  ).toEqual(["M6 21V9a9 9 0 0 0 9 9"]);
  view.unmount();
  render(<RepositoryActions project={project} selected={owner} onlySync />);
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: /Синхронизировать коммиты/ }),
  ).toBeTruthy();
});
it("propagates the captured topic once and keeps its error after switching to primary", async () => {
  let finish!: (value: any) => void;
  api.runRepositoryAction.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const anchor = createRef<HTMLDivElement>();
  const content = (selected: WorktreeRecord | null) => (
    <>
      <div ref={anchor}>
        <RepositoryActions project={project} selected={selected} />
      </div>
      <RepositoryOperationPopup anchor={anchor} />
    </>
  );
  const view = render(content(owner));
  const button = screen.getByLabelText("Перенести топик в base и опубликовать");
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.runRepositoryAction).toHaveBeenCalledTimes(1);
  expect(api.runRepositoryAction.mock.calls[0][0]).toEqual({
    projectId: project.id,
    context: {
      projectId: owner.projectId,
      topic: owner.topic,
      year: owner.year,
      branch: owner.branch,
      contextId: owner.contextId,
      revision: owner.revision,
    },
    action: "propagate",
  });
  expect(
    screen
      .getAllByRole("button")
      .every((b) => (b as HTMLButtonElement).disabled),
  ).toBe(true);
  view.rerender(content(null));
  expect(
    screen.queryByLabelText("Перенести топик в base и опубликовать"),
  ).toBeNull();
  await act(async () =>
    finish({
      projectId: project.id,
      contextId: owner.contextId,
      action: "propagate",
      status: "error",
      log: "Sync completed\nPropagate failed",
      error: "Origin rejected",
    }),
  );
  const popup = screen.getByRole("dialog", { name: "Ошибка операции" });
  expect(popup.textContent).toContain("alpha");
  expect(popup.textContent).toContain("Sync completed");
  expect(within(popup).getByRole("alert").textContent).toBe("Origin rejected");
  expect(within(popup).getAllByRole("button")).toHaveLength(1);
  fireEvent.click(within(popup).getByLabelText("Закрыть попап"));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("dispatches captured owner without confirmation and deduplicates rapid clicks", async () => {
  let finish!: (v: any) => void;
  api.runRepositoryAction.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  mount();
  const publish = screen.getByLabelText("Опубликовать топик");
  fireEvent.click(publish);
  fireEvent.click(publish);
  expect(api.runRepositoryAction).toHaveBeenCalledTimes(1);
  expect(api.runRepositoryAction.mock.calls[0][0]).toMatchObject({
    projectId: "p",
    context: { contextId: owner.contextId, revision: owner.revision },
    action: "publish",
  });
  expect(
    screen
      .getAllByRole("button")
      .every((b) => (b as HTMLButtonElement).disabled),
  ).toBe(true);
  await act(async () =>
    finish({
      projectId: "p",
      contextId: owner.contextId,
      action: "publish",
      status: "success",
      log: "done",
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("shows only operation log, error and close; never colors action icons or offers retry", async () => {
  api.runRepositoryAction.mockImplementation(async (r: any) => ({
    projectId: "p",
    contextId: owner.contextId,
    action: r.action,
    status: "error",
    log: "Local push completed\nRemote push failed",
    error: "Нет соединения",
  }));
  mount();
  fireEvent.click(screen.getByLabelText("Опубликовать топик"));
  const popup = await screen.findByRole("dialog", { name: "Ошибка операции" });
  expect(within(popup).getByText(/Local push completed/)).toBeTruthy();
  expect(within(popup).getByRole("alert").textContent).toBe("Нет соединения");
  expect(within(popup).getAllByRole("button")).toHaveLength(1);
  expect(screen.getByLabelText("Опубликовать топик").className).not.toMatch(
    /error|danger/,
  );
  fireEvent.click(within(popup).getByLabelText("Закрыть попап"));
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("retains row sync owner when selector unmounts and selection changes before failure", async () => {
  let finish!: (v: any) => void;
  api.runRepositoryAction.mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const anchor = createRef<HTMLDivElement>();
  const close = vi.fn();
  const view = render(
    <>
      <div ref={anchor} />
      <TopicQuickSync identity={owner} record={owner} onStarted={close} />
      <RepositoryOperationPopup anchor={anchor} />
    </>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Синхронизировать коммиты/ }),
  );
  expect(close).toHaveBeenCalledOnce();
  view.rerender(
    <>
      <div ref={anchor} />
      <RepositoryActions project={project} selected={null} />
      <RepositoryOperationPopup anchor={anchor} />
    </>,
  );
  await act(async () =>
    finish({
      projectId: "p",
      contextId: owner.contextId,
      action: "sync",
      status: "error",
      log: "clone push failed",
      error: "Rejected",
    }),
  );
  const popup = screen.getByRole("dialog");
  expect(popup.textContent).toContain("alpha");
  expect(popup.textContent).toContain("feature/alpha");
  expect(popup.textContent).not.toContain("Без топика");
});
it("rejects foreign replies instead of presenting their log as this owner's error", async () => {
  api.runRepositoryAction.mockResolvedValue({
    projectId: "other",
    action: "publish",
    status: "error",
    log: "foreign log",
    error: "foreign error",
  });
  mount();
  fireEvent.click(screen.getByLabelText("Опубликовать топик"));
  const popup = await screen.findByRole("dialog");
  expect(popup.textContent).not.toContain("foreign log");
  expect(popup.textContent).toMatch(/другому/);
});
it("disabled when host API missing or selected copy unavailable, never falls back to primary", () => {
  delete api.runRepositoryAction;
  const v = mount();
  expect(
    screen
      .getAllByRole("button")
      .every((b) => (b as HTMLButtonElement).disabled),
  ).toBe(true);
  v.unmount();
  api.runRepositoryAction = vi.fn();
  mount({ ...owner, state: "missing" });
  expect(
    screen
      .getAllByRole("button")
      .every((b) => (b as HTMLButtonElement).disabled),
  ).toBe(true);
});
it("renders the log in the native overlay, not underneath the pipeline; Escape closes it", async () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const close = vi.fn(async () => {});
  Object.assign(api, {
    setTopicPopupBounds: vi.fn(async () => {}),
    closeTopicPopup: close,
    onTopicPopupClosed: () => () => {},
  });
  const open = vi.spyOn(window, "open").mockReturnValue(frame.contentWindow);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  api.runRepositoryAction.mockImplementation(async (r: any) => ({
    projectId: "p",
    contextId: owner.contextId,
    action: r.action,
    status: "error",
    log: "<script>not markup</script>",
    error: "Rejected",
  }));
  const view = mount();
  try {
    fireEvent.click(screen.getByLabelText("Опубликовать топик"));
    const local = within(frame.contentDocument!.body);
    const popup = await local.findByRole("dialog");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(popup.querySelector("script")).toBeNull();
    expect(popup.querySelector("pre")!.textContent).toBe(
      "<script>not markup</script>",
    );
    expect(frame.contentDocument!.title).toBe("Ошибка операции");
    fireEvent.keyDown(local.getByLabelText("Закрыть попап"), { key: "Escape" });
    expect(close).toHaveBeenCalled();
  } finally {
    view.unmount();
    open.mockRestore();
    frame.remove();
    vi.unstubAllGlobals();
  }
});

it("preserves the second queued error while the first native popup closes", async () => {
  const frames = [
    document.createElement("iframe"),
    document.createElement("iframe"),
  ];
  frames.forEach((f) => document.body.append(f));
  let release!: () => void;
  let opens = 0;
  Object.assign(api, {
    setTopicPopupBounds: vi.fn(async () => {}),
    closeTopicPopup: vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    ),
    onTopicPopupClosed: () => () => {},
  });
  api.runRepositoryAction.mockImplementation(async (r: any) => ({
    ...r,
    contextId: r.context?.contextId,
    status: "error",
    log: r.context ? "first error" : "second error",
    error: "failed",
  }));
  const opener = vi
    .spyOn(window, "open")
    .mockImplementation(() => frames[opens++].contentWindow);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const anchor = createRef<HTMLDivElement>();
  const view = render(
    <>
      <div ref={anchor}>
        <RepositoryActions project={project} selected={owner} />
        <RepositoryActions project={project} selected={null} />
      </div>
      <RepositoryOperationPopup anchor={anchor} />
    </>,
  );
  try {
    await act(async () =>
      fireEvent.click(screen.getByLabelText("Опубликовать топик")),
    );
    await act(async () =>
      fireEvent.click(screen.getByLabelText("Опубликовать текущую ветку")),
    );
    expect(opens).toBe(1);
    fireEvent.click(
      within(frames[0].contentDocument!.body).getByLabelText("Закрыть попап"),
    );
    expect(opens).toBe(1);
    await act(async () => release());
    expect(opens).toBe(2);
    expect(
      within(frames[1].contentDocument!.body).getByRole("dialog").textContent,
    ).toContain("second error");
  } finally {
    view.unmount();
    release?.();
    opener.mockRestore();
    frames.forEach((f) => f.remove());
    vi.unstubAllGlobals();
  }
});

it.each([
  [
    "Перенести топик в base и опубликовать",
    "Синхронизировать копию; перенести топик в base и опубликовать base в origin",
  ],
  ["Синхронизировать топик", "Коммиты: копия → исходный проект"],
  ["Опубликовать топик", "Коммиты: копия → исходный проект → origin"],
  [
    "Обновить из base",
    "Обновить base из remote; получить в копию и выполнить goga topics update",
  ],
])(
  "shows an explicit hover/focus tooltip for %s and dismisses it on leave/Escape/blur",
  async (label, description) => {
    const open = vi.spyOn(window, "open");
    try {
      mount();
      const button = screen.getByRole("button", { name: label });
      expect(button.hasAttribute("title")).toBe(false);
      fireEvent.mouseEnter(button);
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.textContent).toContain(description);
      expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
      fireEvent.mouseLeave(button);
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
      fireEvent.focus(button);
      expect(screen.getByRole("tooltip")).toBeTruthy();
      fireEvent.keyDown(button, { key: "Escape" });
      expect(screen.queryByRole("tooltip")).toBeNull();
      fireEvent.blur(button);
      fireEvent.focus(button);
      expect(screen.getByRole("tooltip")).toBeTruthy();
      fireEvent.blur(button);
      expect(screen.queryByRole("tooltip")).toBeNull();
      expect(open).not.toHaveBeenCalled();
      expect(api.runRepositoryAction).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  },
);
it("keeps disabled action reasons available to pointer and keyboard without dispatch", async () => {
  api.runRepositoryAction = undefined;
  mount();
  const button = screen.getByRole("button", {
    name: "Синхронизировать топик",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  const anchor = button.parentElement!;
  expect(anchor.tabIndex).toBe(0);
  fireEvent.mouseEnter(anchor);
  expect(screen.getByRole("tooltip").textContent).toContain(
    "Действие недоступно в этой версии хоста",
  );
  fireEvent.mouseLeave(anchor);
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  fireEvent.focus(anchor);
  expect(anchor.getAttribute("aria-describedby")).toBe(
    screen.getByRole("tooltip").id,
  );
  fireEvent.keyDown(anchor, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();
});
it("portals into the selector owner document above the icon with viewport clamping", () => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const local = frame.contentDocument!;
  const view = render(
    <RepositoryActions project={project} selected={owner} onlySync />,
    { container: local.body.appendChild(local.createElement("div")) },
  );
  try {
    const button = within(local.body).getByRole("button");
    vi.spyOn(button.parentElement!, "getBoundingClientRect").mockReturnValue({
      left: -20,
      right: 16,
      top: 140,
      bottom: 176,
      width: 36,
      height: 36,
      x: -20,
      y: 140,
      toJSON() {},
    });
    fireEvent.focus(button);
    const tooltip = within(local.body).getByRole("tooltip");
    expect(tooltip.parentElement).toBe(local.body);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(tooltip.style.position).toBe("fixed");
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(tooltip.style.top)).toBeLessThan(140);
    expect(Number.parseFloat(tooltip.style.maxWidth)).toBeLessThanOrEqual(
      frame.contentWindow!.innerWidth - 16,
    );
    fireEvent.keyDown(local, { key: "Escape" });
    expect(within(local.body).queryByRole("tooltip")).toBeNull();
  } finally {
    view.unmount();
    frame.remove();
  }
});

it("measures the visible tooltip height before placing it above the header", () => {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const height =
        this.getAttribute("role") === "tooltip"
          ? Math.min(44, Number.parseFloat(this.style.maxHeight))
          : 36;
      return {
        x: 500,
        y: 120,
        left: 500,
        right: 536,
        top: 120,
        bottom: 120 + height,
        width: this.getAttribute("role") === "tooltip" ? 300 : 36,
        height,
        toJSON() {},
      };
    });
  try {
    mount();
    fireEvent.focus(
      screen.getByRole("button", { name: "Синхронизировать топик" }),
    );
    const tooltip = screen.getByRole("tooltip");
    expect(Number.parseFloat(tooltip.style.top) + 44).toBeLessThanOrEqual(112);
  } finally {
    rect.mockRestore();
  }
});

it("keeps overflowed reasons fully accessible by pointer and keyboard above a short header", async () => {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const isTooltip = this.getAttribute("role") === "tooltip";
      const height = isTooltip
        ? Math.min(160, Number.parseFloat(this.style.maxHeight))
        : 36;
      return {
        x: 20,
        y: 56,
        left: 20,
        right: 56,
        top: 56,
        bottom: 56 + height,
        width: isTooltip ? 300 : 36,
        height,
        toJSON() {},
      };
    });
  const scrollHeight = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(160);
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(40);
  try {
    mount({ ...owner, storageKind: "linked" });
    const button = screen.getByRole("button", {
      name: "Синхронизировать топик",
    });
    const anchor = button.parentElement!;
    fireEvent.focus(anchor);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.scrollHeight).toBeGreaterThan(tooltip.clientHeight);
    expect(
      Number.parseFloat(tooltip.style.top) + tooltip.clientHeight,
    ).toBeLessThanOrEqual(48);
    expect(tooltip.tabIndex).toBe(0);
    expect(tooltip.style.overflowY).toBe("auto");
    expect(tooltip.style.pointerEvents).toBe("auto");
    expect(tooltip.textContent).toContain(
      "Рабочая копия прежнего формата. Для переноса нужен подтверждённый автономный клон.",
    );
    fireEvent.keyDown(anchor, { key: "Tab" });
    expect(document.activeElement).toBe(tooltip);
    fireEvent.mouseLeave(anchor);
    fireEvent.mouseEnter(tooltip);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    fireEvent.scroll(tooltip, { target: { scrollTop: 120 } });
    expect(tooltip.scrollTop).toBe(120);
    fireEvent.keyDown(tooltip, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(anchor);
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    fireEvent.keyDown(anchor, { key: "Tab" });
    fireEvent.keyDown(tooltip, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(document.activeElement).toBe(anchor);
    expect(api.runRepositoryAction).not.toHaveBeenCalled();
  } finally {
    rect.mockRestore();
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
});
it("shows a compact row title without repeating a long owner identity", () => {
  const selected = {
    ...owner,
    topic: "long-topic-".repeat(20),
    branch: "feature/" + "long-branch-".repeat(20),
  };
  render(<RepositoryActions project={project} selected={selected} onlySync />);
  const button = screen.getByRole("button", {
    name: `Синхронизировать коммиты · ${selected.topic}/${selected.year}/${selected.branch}`,
  });
  fireEvent.focus(button);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.querySelector("strong")!.textContent).toBe("Синхронизировать");
  expect(tooltip.textContent).not.toContain(selected.topic);
  expect(Number.parseFloat(tooltip.style.maxWidth)).toBe(640);
});

it("resumes logical forward tab order after an overflow tooltip portal", async () => {
  const scrollHeight = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockReturnValue(160);
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockReturnValue(40);
  try {
    render(
      <>
        <RepositoryActions project={project} selected={owner} />
        <button>Следующий раздел</button>
      </>,
    );
    const user = userEvent.setup();
    const sync = screen.getByRole("button", { name: "Синхронизировать топик" });
    act(() => sync.focus());
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tooltip"));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Опубликовать топик" }),
    );
  } finally {
    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  }
});
