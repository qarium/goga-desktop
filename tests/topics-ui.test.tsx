// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
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
import type { TopicBoardSnapshot } from "../src/shared/topics";
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
const mount = () =>
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onOpenTopic={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
it("shows approved defaults/order and live name search without apply", async () => {
  mount();
  await screen.findByRole("button", { name: "Открыть топик feature-a" });
  expect(
    screen
      .getAllByRole("switch")
      .map((e) => [e.textContent, e.getAttribute("aria-checked")]),
  ).toEqual([
    ["Описания задач", "true"],
    ["Состояния по веткам", "false"],
    ["Только удалённые ветки", "false"],
    ["Только с активными запусками", "false"],
  ]);
  fireEvent.change(screen.getByPlaceholderText("Часть имени топика"), {
    target: { value: "FEATURE-B" },
  });
  expect(
    screen.queryByRole("button", { name: "Открыть топик feature-a" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Открыть топик feature-b" }),
  ).toBeTruthy();
  expect(screen.queryByText("Применить")).toBeNull();
});
it("option search alone does not filter board; cancel does not select", async () => {
  mount();
  await screen.findByRole("button", { name: "Открыть топик feature-a" });
  fireEvent.click(screen.getByRole("button", { name: /Топики · Все/ }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Найти топик" }), {
    target: { value: "feature-b" },
  });
  expect(
    screen.getByRole("button", { name: "Открыть топик feature-a" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(
    screen.getByRole("button", { name: "Открыть топик feature-a" }),
  ).toBeTruthy();
});
it("per-host rows and where expansion preserve branch-specific state", async () => {
  mount();
  await screen.findByRole("button", { name: "Открыть топик feature-a" });
  fireEvent.click(screen.getByRole("switch", { name: "Состояния по веткам" }));
  expect(
    screen.getAllByRole("button", { name: "Открыть топик feature-a" }),
  ).toHaveLength(2);
  expect(screen.getAllByText("done").length).toBeGreaterThan(0);
});
it.each([
  [true, false],
  [false, false],
  [false, true],
  [true, true],
])(
  "create options %s/%s stay independent, require confirmation, preserve unicode",
  async (pub, sw) => {
    mount();
    await screen.findByRole("button", { name: "Создать топик" });
    fireEvent.click(screen.getByRole("button", { name: "Создать топик" }));
    const dialog = screen.getByRole("dialog", { name: "Создать топик" });
    expect(
      within(dialog)
        .getByRole("switch", { name: "Опубликовать" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(dialog)
        .getByRole("switch", { name: "Переключиться на новый топик" })
        .getAttribute("aria-checked"),
    ).toBe("false");
    if (!pub)
      fireEvent.click(
        within(dialog).getByRole("switch", { name: "Опубликовать" }),
      );
    if (sw)
      fireEvent.click(
        within(dialog).getByRole("switch", {
          name: "Переключиться на новый топик",
        }),
      );
    fireEvent.change(within(dialog).getByLabelText("Имя ветки / топика"), {
      target: { value: "feature/new" },
    });
    fireEvent.change(within(dialog).getByLabelText("Задача"), {
      target: { value: 'Привет "мир"\nВторая строка 🐈' },
    });
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(api.prepareTopicOperation).toHaveBeenCalled());
    expect(api.prepareTopicOperation.mock.calls[0][0]).toMatchObject({
      action: "create",
      publish: pub,
      switch: sw,
      task: 'Привет "мир"\nВторая строка 🐈',
    });
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
  },
);
it("historical task uses immutable snapshot and never reads live task", async () => {
  render(
    <TopicCard
      project={project}
      year="2026"
      target={a}
      board={board}
      store={createTopicsStore()}
      context={{
        kind: "run",
        run: {
          topic: "feature-a",
          branch: "feature/a",
          taskSnapshot: {
            text: "Historical",
            year: "2026",
            topic: "feature-a",
            branch: "feature/a",
          },
        } as any,
      }}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  expect(await screen.findByText("Historical")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Задача топика" })).toBeNull();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
});
it("old run without snapshot says missing, never substitutes live task", () => {
  render(
    <TopicCard
      project={project}
      year="2026"
      target={a}
      board={board}
      store={createTopicsStore()}
      context={{
        kind: "run",
        run: { topic: "feature-a", branch: "feature/a" } as any,
      }}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  expect(
    screen.getByText(/Снимок задачи для этого запуска отсутствует/),
  ).toBeTruthy();
  expect(api.readTopicDetails).not.toHaveBeenCalled();
});
it("card draft survives close, prepare does not execute or discard it", async () => {
  const store = createTopicsStore(),
    prepare = vi.fn();
  const props = {
    project,
    year: "2026",
    target: a,
    board,
    store,
    context: { kind: "topic" as const },
    onClose: vi.fn(),
    onChanged: vi.fn(),
    onPrepare: prepare,
  };
  const first = render(<TopicCard {...props} />);
  const input = await screen.findByRole("textbox", { name: "Задача топика" });
  fireEvent.change(input, { target: { value: "Unsaved 🐈" } });
  fireEvent.click(screen.getByRole("button", { name: "Подготовить запуск" }));
  expect(prepare).toHaveBeenCalledWith(
    { topic: a.topic, branch: a.branch, remote: a.remote },
    "2026",
    "Unsaved 🐈",
  );
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
  first.unmount();
  render(<TopicCard {...props} />);
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "Задача топика",
      })) as HTMLTextAreaElement
    ).value,
  ).toBe("Unsaved 🐈");
});
it("requires explicit execution, consumes once and preserves a draft after failure", async () => {
  const store = createTopicsStore();
  api.executeTopicOperation.mockRejectedValue(
    new Error("Подтверждение устарело"),
  );
  render(
    <TopicCard
      project={project}
      year="2026"
      target={a}
      board={board}
      store={store}
      context={{ kind: "topic" }}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  fireEvent.change(
    await screen.findByRole("textbox", { name: "Задача топика" }),
    { target: { value: "Saved only with consent" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить задачу…" }));
  const confirm = await screen.findByRole("button", { name: "Подтвердить" });
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Подтверждение устарело",
  );
  expect(api.executeTopicOperation).toHaveBeenCalledTimes(1);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Задача топика",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Saved only with consent");
});
it("bulk delete previews the concrete selected topic list and cancel does nothing", async () => {
  mount();
  await screen.findByRole("button", { name: "Открыть топик feature-b" });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Выбрать топик feature-b в feature/b",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить выбранные…" }));
  await screen.findByRole("button", { name: "Удалить без корзины" });
  expect(api.prepareTopicOperation.mock.calls[0][0]).toMatchObject({
    action: "delete",
    topics: ["feature-b"],
  });
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});
it("partial create outcome remains visible after board refresh and retains its draft", async () => {
  const store = createTopicsStore();
  api.executeTopicOperation.mockResolvedValue({
    projectId: "p",
    status: "partial",
    message: "Опубликовано, но переключение не удалось",
  });
  render(
    <TopicsWorkspace
      project={project}
      store={store}
      onOpenTopic={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Создать топик" }));
  fireEvent.change(screen.getByLabelText("Имя ветки / топика"), {
    target: { value: "feature/partial" },
  });
  fireEvent.change(screen.getByLabelText("Задача"), {
    target: { value: "Keep this draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
  fireEvent.click(await screen.findByRole("button", { name: "Подтвердить" }));
  expect(
    await screen.findByText("Опубликовано, но переключение не удалось"),
  ).toBeTruthy();
  await waitFor(() => expect(api.readTopicBoard).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText("Задача") as HTMLTextAreaElement).value).toBe(
    "Keep this draft",
  );
});
it("ignores a late board read for the previous year", async () => {
  let finish: (value: TopicBoardSnapshot) => void = () => {};
  api.readTopicBoard
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ...board, year: "2025", entries: [], records: [] });
  mount();
  fireEvent.change(screen.getByLabelText("Год"), { target: { value: "2025" } });
  await screen.findByText("За этот год топиков пока нет.");
  finish(board);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    screen.queryByRole("button", { name: "Открыть топик feature-a" }),
  ).toBeNull();
});
it("active project remains readable with disabled mutation controls", async () => {
  api.readTopicBoard.mockResolvedValue({ ...board, active: true });
  mount();
  await screen.findByRole("button", { name: "Открыть топик feature-a" });
  expect(
    (screen.getByRole("button", { name: "Создать топик" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Статусы · Все/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: "tool.ready" }));
  fireEvent.click(screen.getByRole("button", { name: "Применить" }));
  expect(
    screen.queryByRole("button", { name: "Открыть топик feature-a" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Открыть топик feature-b" }),
  ).toBeTruthy();
});

it("brings partial outcomes into view rather than hiding them below a long form", () => {
  const previous = HTMLElement.prototype.scrollIntoView;
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    render(
      <TopicFeedback
        operation={
          {
            error: "",
            result: {
              projectId: "p",
              status: "partial",
              message: "Publication done, switching failed",
            },
          } as any
        }
      />,
    );
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
  } finally {
    HTMLElement.prototype.scrollIntoView = previous;
  }
});

const mountCard = (snapshot = board, target = a) =>
  render(
    <TopicCard
      project={project}
      year="2026"
      target={{ ...target, hosts: [target.branch] } as any}
      board={snapshot}
      store={createTopicsStore()}
      context={{ kind: "topic" }}
      onClose={vi.fn()}
      onChanged={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
it.each(["publish", "propagate"])(
  "allows commit-only %s with a dirty tree and sends a strict target",
  async (action) => {
    const snapshot = { ...board, dirty: true };
    api.readTopicBoard.mockResolvedValue(snapshot);
    mountCard(snapshot);
    await screen.findByRole("textbox", { name: "Задача топика" });
    const button = screen.getByRole("button", {
      name: action === "publish" ? "Опубликовать…" : "Перенести в базу…",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(
      (
        screen.getByRole("button", {
          name: "Обновить из базы…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Вы уже в этом топике.")).toBeTruthy();
    expect(screen.getByText("Текущий топик удалить нельзя.")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(api.prepareTopicOperation).toHaveBeenCalled());
    expect(api.prepareTopicOperation.mock.calls[0][0].target).toEqual({
      topic: a.topic,
      branch: a.branch,
      remote: false,
    });
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
  },
);
it.each(["draft", "active", "load-error"])(
  "keeps publication and propagation blocked for %s",
  async (reason) => {
    const snapshot = { ...board, active: reason === "active" };
    api.readTopicBoard.mockResolvedValue(snapshot);
    if (reason === "load-error")
      api.readTopicDetails.mockRejectedValue(new Error("Ошибка загрузки"));
    mountCard(snapshot);
    await waitFor(() =>
      expect(screen.queryByText("Загружаем топик…")).toBeNull(),
    );
    if (reason === "draft")
      fireEvent.change(screen.getByRole("textbox", { name: "Задача топика" }), {
        target: { value: "Keep unsaved text" },
      });
    for (const name of ["Опубликовать…", "Перенести в базу…"]) {
      const button = screen.queryByRole("button", {
        name,
      }) as HTMLButtonElement | null;
      if (reason === "load-error") expect(button).toBeNull();
      else expect(button?.disabled).toBe(true);
    }
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
  },
);
it("explains why propagation into the checked-out base is unavailable", async () => {
  mountCard();
  await screen.findByRole("textbox", { name: "Задача топика" });
  fireEvent.change(screen.getByLabelText("Базовая ветка"), {
    target: { value: a.branch },
  });
  expect(
    (
      screen.getByRole("button", {
        name: "Перенести в базу…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getAllByText(/Базовая ветка сейчас текущая/).length,
  ).toBeGreaterThan(0);
});

it.each([false, true])(
  "dirty current tree does not block deletion of another topic (remote=%s)",
  async (remote) => {
    const target = {
      ...b,
      remote,
      branch: remote ? "origin/feature/b" : b.branch,
    };
    const snapshot = { ...board, dirty: true };
    api.readTopicBoard.mockResolvedValue(snapshot);
    mountCard(snapshot, target);
    await screen.findByRole("textbox", { name: "Задача топика" });
    const button = screen.getByRole("button", {
      name: "Удалить топик…",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Удалить без корзины" });
    expect(api.prepareTopicOperation.mock.calls[0][0]).toMatchObject({
      action: "delete",
      target: { topic: b.topic, branch: target.branch, remote },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(api.executeTopicOperation).not.toHaveBeenCalled();
  },
);
it("dirty tree permits update of another local topic, but not switching", async () => {
  const snapshot = { ...board, dirty: true };
  api.readTopicBoard.mockResolvedValue(snapshot);
  mountCard(snapshot, b);
  await screen.findByRole("textbox", { name: "Задача топика" });
  expect(
    (
      screen.getByRole("button", {
        name: "Обновить из базы…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole("button", {
        name: "Переключиться на топик…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
it("remote twin of current topic cannot be deleted even with a dirty tree", async () => {
  const snapshot = { ...board, dirty: true };
  api.readTopicBoard.mockResolvedValue(snapshot);
  mountCard(snapshot, { ...a, remote: true, branch: "origin/feature/a" });
  await screen.findByRole("textbox", { name: "Задача топика" });
  expect(
    (
      screen.getByRole("button", {
        name: "Удалить топик…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText("Текущий топик удалить нельзя.")).toBeTruthy();
});
it.each(["draft", "active"])(
  "other-topic update and deletion retain %s protection",
  async (reason) => {
    const snapshot = { ...board, dirty: true, active: reason === "active" };
    api.readTopicBoard.mockResolvedValue(snapshot);
    mountCard(snapshot, b);
    await waitFor(() =>
      expect(screen.queryByText("Загружаем топик…")).toBeNull(),
    );
    if (reason === "draft")
      fireEvent.change(screen.getByRole("textbox", { name: "Задача топика" }), {
        target: { value: "Unsaved task" },
      });
    for (const name of ["Обновить из базы…", "Удалить топик…"])
      expect(
        (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
      ).toBe(true);
  },
);
it("bulk deletion of other topics ignores unrelated dirt but still rejects current selection", async () => {
  api.readTopicBoard.mockResolvedValue({ ...board, dirty: true });
  mount();
  await screen.findByRole("button", { name: "Открыть топик feature-b" });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Выбрать топик feature-b в feature/b",
    }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Удалить выбранные…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Выбрать топик feature-a в feature/a",
    }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Удалить выбранные…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(api.executeTopicOperation).not.toHaveBeenCalled();
});

it.each(["Обновить из базы…", "Перенести в базу…"])(
  "shows the approved compact reason block for %s without changing its guard",
  async (name) => {
    const target = { ...b, branch: "origin/feature/b", remote: true };
    mountCard(board, target);
    const button = (await screen.findByRole("button", {
      name,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const id = button.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const reason = document.getElementById(id!)!;
    expect(reason.classList.contains("topic-action-reason")).toBe(true);
    expect(reason.textContent).toBe(
      "Для этого действия выберите локальную ветку топика.",
    );
    expect(
      reason.querySelector('svg[aria-hidden="true"][focusable="false"]'),
    ).not.toBeNull();
    expect(reason.getAttribute("role")).not.toBe("alert");
    expect(reason.parentElement).toBe(button.parentElement);
    fireEvent.click(button);
    expect(api.prepareTopicOperation).not.toHaveBeenCalled();
  },
);
it("removes the reason and accessible description when the base no longer blocks propagation", async () => {
  mountCard();
  const input = await screen.findByLabelText("Базовая ветка");
  const button = screen.getByRole("button", {
    name: "Перенести в базу…",
  }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: board.currentBranch } });
  expect(button.disabled).toBe(true);
  const id = button.getAttribute("aria-describedby")!;
  expect(document.getElementById(id)).not.toBeNull();
  fireEvent.change(input, { target: { value: "main" } });
  expect(button.disabled).toBe(false);
  expect(button.hasAttribute("aria-describedby")).toBe(false);
  expect(document.getElementById(id)).toBeNull();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
});
it("does not introduce a propagation prohibition from the board marker", async () => {
  const snapshot: TopicBoardSnapshot = {
    ...board,
    entries: board.entries.map((r) => ({ ...r, divergence: "propagated" })),
    records: board.records.map((r) => ({ ...r, divergence: "propagated" })),
  };
  api.readTopicBoard.mockResolvedValue(snapshot);
  mountCard(snapshot, b);
  const button = (await screen.findByRole("button", {
    name: "Перенести в базу…",
  })) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(button.hasAttribute("aria-describedby")).toBe(false);
  expect(
    button.parentElement?.querySelector(".topic-action-reason"),
  ).toBeNull();
  expect(api.prepareTopicOperation).not.toHaveBeenCalled();
});
