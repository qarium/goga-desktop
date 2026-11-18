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
  waitFor,
} from "@testing-library/react";
import { TopicsRemovalDialog } from "../src/renderer/TopicsRemovalDialog";
import {
  TopicRemovalProvider,
  TopicRemovalPopup,
  useTopicRemovalController,
} from "../src/renderer/TopicRemovalController";
import { topicsBoardV4 } from "./fixtures/topics-board-v4";
let api: any;
const plan = {
  token: "t",
  projectId: "p",
  year: "2026",
  action: "delete" as const,
  details: ["delete alpha"],
  expiresAt: Date.now() + 120000,
};
const contextId = "ctx-" + "a".repeat(64);
const owner: any = {
  projectId: "p",
  year: "2026",
  topic: "alpha",
  branch: "alpha",
  contextId,
  revision: "00000000-0000-4000-8000-000000000001",
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    readTopicBoard: vi.fn(async () => topicsBoardV4()),
    prepareTopicRemoval: vi.fn(async () => plan),
    executeTopicRemoval: vi.fn(async () => ({
      projectId: "p",
      topics: { status: "success", message: "Топики удалены" },
      copies: [],
      cleanup: [],
    })),
  };
  window.goga = api;
});
afterEach(cleanup);
function Fixture({
  executor = vi.fn(async () => ({
    projectId: "p",
    status: "success",
    message: "Copy",
    cloneRemoved: true,
  })),
}: {
  executor?: any;
}) {
  const controller = useTopicRemovalController(executor, vi.fn());
  return (
    <TopicRemovalProvider value={controller.execute}>
      <TopicsRemovalDialog
        project={{ id: "p", name: "Project", path: "/fixture" }}
        year="2026"
        action="delete"
        topics={["alpha", "alpha"]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />
      <TopicRemovalPopup controller={controller} />
    </TopicRemovalProvider>
  );
}
it("prepares unique selected topics without reloading the full board and waits for explicit confirmation", async () => {
  render(<Fixture />);
  await screen.findByText("delete alpha");
  expect(api.prepareTopicRemoval).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "delete",
      topics: ["alpha"],
    }),
  );
  expect(api.readTopicBoard).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      /незакоммиченные изменения.*игнорируемые файлы.*непереданные коммиты/i,
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(api.executeTopicRemoval).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByText("Топики удалены");
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});
it("never invokes copy executor on failed Goga and gives no automatic CLI retry", async () => {
  const executor = vi.fn();
  api.executeTopicRemoval.mockResolvedValue({
    projectId: "p",
    topics: { status: "partial", message: "Нужна проверка" },
    copies: [],
    cleanup: [],
  });
  render(<Fixture executor={executor} />);
  await screen.findByText("delete alpha");
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByText("Нужна проверка");
  expect(executor).not.toHaveBeenCalled();
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});
it("honours an older cleanup plan which explicitly requires per-copy ahead consent", async () => {
  const executor = vi.fn(async () => ({
    status: "success",
    message: "Copy removed",
    cloneRemoved: true,
  }));
  api.executeTopicRemoval.mockResolvedValue({
    projectId: "p",
    topics: { status: "success", message: "Топики удалены" },
    copies: [],
    cleanup: [
      {
        owner,
        plan: {
          token: "c",
          contextId,
          purpose: "clone-after-topic",
          stage: "prepared",
          details: [],
          aheadCount: 2,
          requiresAheadConfirmation: true,
        },
      },
    ],
  });
  render(<Fixture executor={executor} />);
  await screen.findByText("delete alpha");
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByRole("checkbox", {
    name: /Подтверждаю удаление непереданных коммитов alpha/,
  });
  expect(executor).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: /Подтверждаю удаление непереданных коммитов alpha/,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Удалить копию alpha" }));
  await waitFor(() =>
    expect(executor).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ purpose: "clone-after-topic" }),
      true,
    ),
  );
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});
it("refreshes only copy cleanup after failure and never repeats the native removal", async () => {
  const executor = vi
    .fn()
    .mockResolvedValueOnce({
      status: "failed",
      message: "Trash denied",
      cloneRemoved: false,
      stage: "prepared",
    })
    .mockResolvedValueOnce({
      status: "success",
      message: "Fresh copy removed",
      cloneRemoved: true,
      stage: "completed",
    });
  api.listTopicContexts = vi.fn(async () => [owner]);
  api.prepareTopicCloneCleanup = vi.fn(async () => ({
    token: "fresh-copy",
    contextId,
    purpose: "clone-after-topic",
    stage: "prepared",
    details: ["Fresh copy check"],
    requiresAheadConfirmation: false,
  }));
  api.executeTopicRemoval.mockResolvedValue({
    projectId: "p",
    topics: { status: "success", message: "Топики удалены" },
    copies: [],
    cleanup: [
      {
        owner,
        plan: {
          token: "stale-copy",
          contextId,
          purpose: "clone-after-topic",
          stage: "prepared",
          details: [],
        },
      },
    ],
  });
  render(<Fixture executor={executor} />);
  await screen.findByText("delete alpha");
  fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
  await screen.findByText("Trash denied");
  expect(screen.getByText("Копия осталась на диске")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Проверить копию alpha" }),
  );
  await screen.findByText("Fresh copy check");
  fireEvent.click(screen.getByRole("button", { name: "Удалить копию alpha" }));
  await screen.findByText("Fresh copy removed");
  expect(executor).toHaveBeenLastCalledWith(
    owner,
    expect.objectContaining({ token: "fresh-copy" }),
    false,
  );
  expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
});

it.each(["close", "cancel", "escape"] as const)(
  "dismisses a pending preview with %s, cancelling only that read",
  async (how) => {
    let settle!: (p: typeof plan) => void;
    api.cancelRead = vi.fn(async () => {});
    api.readRequest = vi.fn(async (_id, method) =>
      method === "readTopicBoard"
        ? topicsBoardV4()
        : new Promise<typeof plan>((r) => {
            settle = r;
          }),
    );
    const busy = vi.fn();
    function Preview() {
      const [show, setShow] = React.useState(true);
      return (
        show && (
          <TopicsRemovalDialog
            project={{ id: "p", name: "p", path: "/fixture" }}
            year="2026"
            action="delete"
            topics={["alpha"]}
            onBusy={busy}
            onClose={() => setShow(false)}
            onChanged={vi.fn()}
          />
        )
      );
    }
    render(<Preview />);
    await waitFor(() => expect(settle).toBeTypeOf("function"));
    const id = api.readRequest.mock.calls.find(
      (c: string[]) => c[1] === "prepareTopicRemoval",
    )[0];
    if (how === "escape")
      fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", { cancelable: true }),
      );
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: how === "cancel" ? "Отмена" : "Закрыть карточку",
        }),
      );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(busy).not.toHaveBeenCalledWith(true);
    expect(api.cancelRead).toHaveBeenCalledWith(id);
    await act(async () => {
      settle(plan);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.executeTopicRemoval).not.toHaveBeenCalled();
  },
);
it("starts a fresh preview on scope change even if the old read is still outstanding", async () => {
  let first!: (p: typeof plan) => void;
  api.prepareTopicRemoval.mockImplementationOnce(
    () =>
      new Promise((r) => {
        first = r;
      }),
  );
  api.prepareTopicRemoval.mockResolvedValue({
    ...plan,
    year: "2027",
    details: ["Новая проверка"],
  });
  const props = {
    project: { id: "p", name: "p", path: "/fixture" },
    action: "delete" as const,
    topics: ["alpha"],
    onClose: vi.fn(),
    onChanged: vi.fn(),
  };
  const view = render(<TopicsRemovalDialog {...props} year="2026" />);
  await waitFor(() => expect(first).toBeTypeOf("function"));
  view.rerender(<TopicsRemovalDialog {...props} year="2027" />);
  await screen.findByText("Новая проверка");
  await act(async () => {
    first(plan);
  });
  expect(screen.queryByText("delete alpha")).toBeNull();
  expect(screen.getByText("Новая проверка")).toBeTruthy();
});

it("keeps footer actions separate from scrollable selected topics and warning details", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/renderer/Topics.css", "utf8");
  document.head.append(style);
  try {
    render(<Fixture />);
    await screen.findByText("delete alpha");
    const dialog = screen.getByRole("dialog");
    const body = screen
      .getByText("delete alpha")
      .closest(".topic-removal-body");
    expect(body).not.toBeNull();
    const actions = screen.getByRole("button", {
      name: "Отмена",
    }).parentElement!;
    expect(body!.contains(actions)).toBe(false);
    expect(getComputedStyle(body!).overflowY).toBe("auto");
    expect(parseFloat(getComputedStyle(body!).gap)).toBeGreaterThanOrEqual(12);
    expect(parseFloat(getComputedStyle(actions).gap)).toBeGreaterThanOrEqual(8);
    expect(getComputedStyle(dialog).display).toBe("grid");
  } finally {
    style.remove();
  }
});

it.each([
  ["global", "success"],
  ["local", "success"],
  ["global", "error"],
  ["local", "error"],
] as const)(
  "replaces confirmation with exactly one %s operation modal through %s and dismissal",
  async (placement, outcome) => {
    let finish!: (value: any) => void;
    let fail!: (error: Error) => void;
    api.executeTopicRemoval.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    function Handoff() {
      const [show, setShow] = React.useState(true);
      const controller = useTopicRemovalController(null, vi.fn());
      const confirmation = show && (
        <TopicsRemovalDialog
          project={{ id: "p", name: "Project", path: "/fixture" }}
          year="2026"
          action="delete"
          topics={["alpha"]}
          onClose={() => setShow(false)}
          onChanged={vi.fn()}
        />
      );
      return placement === "global" ? (
        <TopicRemovalProvider value={controller.execute}>
          {confirmation}
          <TopicRemovalPopup controller={controller} />
        </TopicRemovalProvider>
      ) : (
        confirmation
      );
    }
    render(<Handoff />);
    await screen.findByText("delete alpha");
    fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
    await screen.findByText("Выполняем команду Goga…");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByText("delete alpha")).toBeNull();
    expect(screen.queryByText(/Выбрано топиков:/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "К топикам" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () => {
      if (outcome === "error") fail(new Error("Удаление не удалось"));
      else
        finish({
          projectId: "p",
          topics: { status: "success", message: "Топики удалены" },
          copies: [],
          cleanup: [],
        });
    });
    await screen.findByText(
      outcome === "error" ? /Удаление не удалось/ : "Топики удалены",
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.click(
      screen.getByRole("button", {
        name: outcome === "error" ? "Закрыть результат удаления" : "К топикам",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.executeTopicRemoval).toHaveBeenCalledTimes(1);
  },
);

it("spaces operation progress and anchored footer separately", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/renderer/Topics.css", "utf8");
  document.head.append(style);
  try {
    api.executeTopicRemoval.mockImplementation(() => new Promise(() => {}));
    render(<Fixture />);
    await screen.findByText("delete alpha");
    fireEvent.click(screen.getByRole("button", { name: "Удалить топики" }));
    const progress = await screen.findByText("Выполняем команду Goga…");
    const body = progress.closest(".topic-removal-body");
    expect(body).not.toBeNull();
    const footer = screen.getByRole("button", {
      name: "К топикам",
    }).parentElement!;
    expect(body!.contains(footer)).toBe(false);
    expect(getComputedStyle(body!).overflowY).toBe("auto");
    expect(
      parseFloat(getComputedStyle(footer).paddingTop),
    ).toBeGreaterThanOrEqual(12);
    expect(
      parseFloat(getComputedStyle(progress.closest("dialog")!).gap),
    ).toBeGreaterThanOrEqual(12);
  } finally {
    style.remove();
  }
});
