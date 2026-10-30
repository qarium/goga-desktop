import { selectCatalog } from "./helpers/select-catalog";
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { createDraftStore } from "../src/renderer/task-drafts";
const project = { id: "p", name: "Project", path: "/fixture/p" };
const data = {
  pipelines: [{ id: "build", name: "Build", description: "", project: true }],
  topics: ["main", "other"].map((branch) => ({
    branch,
    topic: branch,
    current: branch === "main",
    remote: false,
    todo: "",
    statuses: [],
  })),
  branches: ["main", "other"],
  currentBranch: "main",
  workflows: [],
  profiles: [],
};
const preview = {
  token: "token",
  stages: [{ id: "one", title: "One" }],
  workflow: null,
  profile: null,
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
    discover: vi.fn(async () => data),
    preview: vi.fn(async () => preview),
    checkoutBranch: vi.fn(async () => "main"),
    readTopicTask: vi.fn(async () => ({
      text: "saved task",
      exists: true,
      version: "v1",
      path: "todo.md",
    })),
    launch: vi.fn(async () => ({ id: "run" })),
  };
  window.goga = api;
});
afterEach(cleanup);
async function setup() {
  const store = createDraftStore();
  const view = render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Запустить" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  return { store, view };
}
const chooseOther = () => {
  fireEvent.click(screen.getByRole("combobox", { name: "Топик проекта" }));
  fireEvent.click(screen.getByRole("option", { name: /other/ }));
};
async function newBranch() {
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  fireEvent.change(screen.getByLabelText("Имя нового топика"), {
    target: { value: "feature/exact" },
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Запустить" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
}
async function update() {
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Варианты запуска" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Варианты запуска" }));
  fireEvent.click(
    await screen.findByRole("menuitem", {
      name: /запустить с обновлением образа/i,
    }),
  );
}
it("current branch launches ordinarily without checkbox or modal; update is one-shot and not clean", async () => {
  api.launch.mockRejectedValue(new Error("controlled launch failure"));
  await setup();
  expect(
    screen.queryByRole("checkbox", { name: /Подтверждаю.*запуск/ }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    update: false,
    clean: false,
    confirmBranchSwitch: false,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  await update();
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(2));
  expect(api.launch.mock.calls[1][0]).toMatchObject({
    update: true,
    clean: false,
  });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Запустить" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(3));
  expect(api.launch.mock.calls[2][0].update).toBe(false);
  expect(api.preview.mock.calls.every(([r]: any[]) => !("update" in r))).toBe(
    true,
  );
});
it("arrow only opens a keyboard menu, Escape returns focus without launch", async () => {
  await setup();
  const arrow = screen.getByRole("button", { name: "Варианты запуска" });
  arrow.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(await screen.findByRole("menuitem")).toBe(document.activeElement);
  expect(api.launch).not.toHaveBeenCalled();
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(arrow);
});
it("new branch consent shows exact branch/base and update, cancel has no side effects", async () => {
  await setup();
  await newBranch();
  await update();
  const dialog = await screen.findByRole("dialog", {
    name: "Создать ветку и запустить конвейер?",
  });
  expect(dialog.textContent).toContain("feature/exact");
  expect(dialog.textContent).toContain("main");
  expect(dialog.textContent).toMatch(/обновит образ/);
  expect(screen.getByRole("button", { name: "Отмена" })).toBe(
    document.activeElement,
  );
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.checkoutBranch).not.toHaveBeenCalled();
  fireEvent(dialog, new Event("cancel", { cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Имя нового топика")).toHaveProperty(
    "value",
    "feature/exact",
  );
});
it("other branch dirty task waits for consent and sends exact immutable task/update once", async () => {
  await setup();
  chooseOther();
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  await waitFor(() => expect(task).toHaveProperty("value", "saved task"));
  fireEvent.change(task, { target: { value: "dirty task" } });
  await update();
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toMatch(/Переключиться.*other/);
  expect(dialog.textContent).toMatch(/сохранен|сохранён/);
  expect(api.launch).not.toHaveBeenCalled();
  const yes = screen.getByRole("button", { name: "Переключиться и запустить" });
  fireEvent.click(yes);
  fireEvent.click(yes);
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    topic: { mode: "existing", branch: "other", topic: "other" },
    task: "dirty task",
    taskVersion: "v1",
    update: true,
    confirmBranchSwitch: true,
  });
});
it("stale modal cannot be revived after task edit and reverting text", async () => {
  await setup();
  chooseOther();
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Запустить" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  const old = await screen.findByRole("button", {
    name: "Переключиться и запустить",
  });
  const task = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  fireEvent.change(task, { target: { value: "changed" } });
  fireEvent.change(task, { target: { value: "saved task" } });
  fireEvent.click(old);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
});
it("context change while checking checkout prevents launch and preserves draft", async () => {
  const { view } = await setup();
  let resolve!: (b: string) => void;
  api.checkoutBranch.mockImplementationOnce(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  view.rerender(
    <LaunchForm
      project={project}
      settingsRevision="changed"
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await act(async () => resolve("main"));
  expect(api.launch).not.toHaveBeenCalled();
});
it("new branch approval captures base, task and ordinary mode only once", async () => {
  await setup();
  await newBranch();
  selectCatalog(screen.getByLabelText("Исходная ветка"), "other");
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "new task" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  expect(api.checkoutBranch).not.toHaveBeenCalled();
  const yes = await screen.findByRole("button", {
    name: "Создать и запустить",
  });
  fireEvent.click(yes);
  fireEvent.click(yes);
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    topic: { mode: "new", name: "feature/exact", baseRef: "other" },
    task: "new task",
    update: false,
    confirmBranchSwitch: true,
  });
});
it("cancel discards update intent and preserves dirty task and clean selection", async () => {
  await setup();
  chooseOther();
  await waitFor(() =>
    expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
      "value",
      "saved task",
    ),
  );
  fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
    target: { value: "dirty task" },
  });
  fireEvent.click(screen.getByLabelText("Начать с чистого состояния"));
  expect(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  ).toBeTruthy();
  await update();
  expect(screen.getByRole("dialog").textContent).toContain("сохранена");
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(api.checkoutBranch).not.toHaveBeenCalled();
  expect(api.launch).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
    "value",
    "dirty task",
  );
  expect(screen.getByLabelText("Начать с чистого состояния")).toHaveProperty(
    "checked",
    true,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  expect(screen.getByRole("dialog").textContent).not.toContain("обновит образ");
  fireEvent.click(
    screen.getByRole("button", { name: "Переключиться и запустить" }),
  );
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    update: false,
    clean: true,
    task: "dirty task",
  });
});
it("menu supports Enter/Space activation, Tab and outside dismissal", async () => {
  await setup();
  await newBranch();
  const arrow = screen.getByRole("button", { name: "Варианты запуска" });
  arrow.focus();
  await userEvent.keyboard("{Enter}");
  expect(await screen.findByRole("menuitem")).toBe(document.activeElement);
  await userEvent.keyboard("{Tab}");
  expect(screen.queryByRole("menu")).toBeNull();
  arrow.focus();
  await userEvent.keyboard(" ");
  expect(await screen.findByRole("menuitem")).toBe(document.activeElement);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  arrow.focus();
  await userEvent.keyboard("{Enter}{Enter}");
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(api.launch).not.toHaveBeenCalled();
});
it.each(["clean", "branch", "settings"])(
  "stale %s consent never survives A→B→A",
  async (kind) => {
    const { view, store } = await setup();
    await newBranch();
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    const old = await screen.findByRole("button", {
      name: "Создать и запустить",
    });
    if (kind === "clean") {
      fireEvent.click(screen.getByLabelText("Начать с чистого состояния"));
      fireEvent.click(screen.getByLabelText("Начать с чистого состояния"));
    }
    if (kind === "branch") {
      selectCatalog(screen.getByLabelText("Исходная ветка"), "other");
      selectCatalog(screen.getByLabelText("Исходная ветка"), "HEAD");
    }
    if (kind === "settings")
      for (const revision of ["new", undefined])
        view.rerender(
          <LaunchForm
            project={project}
            draftStore={store}
            settingsRevision={revision}
            onCancel={() => {}}
            onLaunched={() => {}}
          />,
        );
    fireEvent.click(old);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.launch).not.toHaveBeenCalled();
    expect(api.checkoutBranch).not.toHaveBeenCalled();
  },
);

it.each([
  { id: "bugfix", name: "bugfix", project: false },
  { id: "development", name: "Разработка из YAML", project: true },
  { id: "patch", name: "", project: false },
])(
  "pipeline label uses only id for $id regardless of YAML name",
  async (pipeline) => {
    api.discover.mockResolvedValue({
      ...data,
      pipelines: [
        data.pipelines[0],
        { ...pipeline, description: "Description remains unchanged" },
      ],
    });
    await setup();
    const select = screen.getByRole("combobox", {
      name: "Конвейер",
    }) as HTMLButtonElement;
    fireEvent.click(select);
    const option = screen
      .getAllByRole("option")
      .find((option) => (option as HTMLButtonElement).value === pipeline.id)!;
    expect(option.textContent).toBe(
      pipeline.id + (pipeline.project ? " · проектный" : ""),
    );
    fireEvent.click(option);
    await waitFor(() =>
      expect(api.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ pipeline: pipeline.id }),
      ),
    );
    expect(select.value).toBe(pipeline.id);
    expect(screen.getByText("Description remains unchanged")).toBeTruthy();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Запустить" })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
    await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
    expect(api.launch.mock.calls[0][0].pipeline).toBe(pipeline.id);
  },
);
