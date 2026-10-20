import { retainedButton } from "./loading-test-helpers";
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { createDraftStore } from "../src/renderer/task-drafts";
const project = { id: "reset", name: "Reset", path: "/fixture/reset" };
const topics = ["main", "other"].map((branch) => ({
  branch,
  topic: `${branch}-id`,
  current: branch === "main",
  remote: false,
  todo: "summary",
  statuses: [],
}));
const data = {
  pipelines: ["first", "second"].map((id) => ({
    id,
    name: id,
    description: "",
    project: true,
  })),
  topics,
  branches: ["main", "other"],
  currentBranch: "main",
  baseRef: "main",
  workflows: ["custom"],
  profiles: [{ name: "custom", source: "project" as const }],
};
const doc = (text = "original", exists = true, version = "v1") => ({
  text,
  exists,
  version,
  path: ".goga/history/main-id/todo.md",
});
const preview = {
  token: "initial",
  stages: [
    { id: "one", title: "One" },
    { id: "two", title: "Two" },
  ],
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
    readTopicTask: vi.fn(async () => doc()),
    checkoutBranch: vi.fn(async () => "main"),
    launch: vi.fn(async () => ({ id: "run" })),
  };
  window.goga = api;
});
afterEach(cleanup);
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const stage = (id: string) =>
  screen.getByRole("checkbox", { name: new RegExp(id) }) as HTMLInputElement;
const edit = () =>
  screen.getByRole("textbox", {
    name: "Что нужно сделать?",
  }) as HTMLTextAreaElement;
const change = (name: string, value: string) =>
  fireEvent.change(field(name), { target: { value } });
const reset = () => fireEvent.click(retainedButton("Сбросить"));
const confirm = () =>
  fireEvent.click(screen.getByRole("button", { name: "Сбросить изменения" }));
function select(branch: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Топик проекта" }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(branch) }));
}
async function setup(store = createDraftStore()) {
  const view = render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await waitFor(() => expect(edit().value).toBe("original"));
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1));
  return { view, store };
}
async function dirty() {
  change("Рабочий процесс", "none");
  change("Профиль", "custom");
  change("Конвейер", "second");
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  fireEvent.change(edit(), { target: { value: "draft" } });
  await waitFor(() => expect(screen.queryByText("проверяем…")).toBeNull());
  fireEvent.click(screen.getByRole("checkbox", { name: /Начать с чистого/ }));
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
it("clean reset reads fresh full document and reuses exactly one prepared preview", async () => {
  const { store } = await setup();
  api.readTopicTask.mockResolvedValue(doc("external\nfull", true, "v2"));
  api.preview.mockResolvedValue({ ...preview, token: "prepared" });
  reset();
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(edit().value).toBe("external\nfull"));
  expect(api.discover).toHaveBeenCalledTimes(2);
  expect(api.preview).toHaveBeenCalledTimes(2);
  expect([...store.tasks.values()][0].document?.version).toBe("v2");
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        previewToken: "prepared",
        taskVersion: "v2",
        clean: false,
      }),
    ),
  );
});
it("dirty reset atomically applies all defaults only after preview and keeps selected exact topic on reorder", async () => {
  await setup();
  select("other");
  await waitFor(() => expect(edit().disabled).toBe(false));
  await dirty();
  const pending = deferred<any>();
  api.discover.mockResolvedValue({
    ...data,
    topics: [topics[1], topics[0]],
    pipelines: [data.pipelines[1], data.pipelines[0]],
  });
  api.readTopicTask.mockResolvedValue(doc("other external", true, "v2"));
  api.preview.mockReturnValueOnce(pending.promise);
  reset();
  confirm();
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith({
      projectId: project.id,
      pipeline: "second",
      workflow: "auto",
      profile: "",
      skips: [],
    }),
  );
  expect(edit().value).toBe("draft");
  expect(field("Рабочий процесс").value).toBe("none");
  expect(field("Профиль").value).toBe("custom");
  expect(field("Начать с чистого состояния").checked).toBe(true);
  await act(async () => pending.resolve({ ...preview, token: "prepared" }));
  expect(edit().value).toBe("other external");
  expect(field("Рабочий процесс").value).toBe("auto");
  expect(field("Профиль").value).toBe("");
  expect(field("Конвейер").value).toBe("second");
  expect(field("Начать с чистого состояния").checked).toBe(false);
  expect(
    screen.getByRole("combobox", { name: "Топик проекта" }).textContent,
  ).toContain("other");
  expect(api.readTopicTask).toHaveBeenLastCalledWith({
    projectId: project.id,
    branch: "other",
    topic: "other-id",
  });
  expect(api.checkoutBranch).not.toHaveBeenCalled();
  expect(api.launch).not.toHaveBeenCalled();
});
it.each(["cancel", "escape", "close"])(
  "%s defaults to Cancel, retains full snapshot and does no work",
  async (action) => {
    const { store } = await setup();
    await dirty();
    const original = [...store.tasks.values()][0];
    const calls = api.preview.mock.calls.length;
    reset();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Отмена" }),
    );
    if (action === "escape")
      fireEvent(
        screen.getByRole("dialog"),
        new Event("cancel", { cancelable: true }),
      );
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "close" ? "Закрыть подтверждение" : "Отмена",
        }),
      );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect([...store.tasks.values()][0]).toBe(original);
    expect(edit().value).toBe("draft");
    expect(field("Конвейер").value).toBe("second");
    expect(field("Рабочий процесс").value).toBe("none");
    expect(field("Начать с чистого состояния").checked).toBe(true);
    expect(api.discover).toHaveBeenCalledTimes(1);
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    expect(api.preview).toHaveBeenCalledTimes(calls);
  },
);
it("parameter-only changes require the single reset confirmation", async () => {
  await setup();
  change("Рабочий процесс", "none");
  reset();
  expect(screen.getByRole("dialog", { name: "Сбросить форму?" })).toBeTruthy();
  expect(api.discover).toHaveBeenCalledTimes(1);
});
it.each(["discover", "readTopicTask", "preview"])(
  "%s failure preserves entered state/version and supports retry",
  async (method) => {
    const { store } = await setup();
    await dirty();
    const original = [...store.tasks.values()][0];
    api[method].mockRejectedValueOnce(new Error(`${method} denied`));
    reset();
    confirm();
    await screen.findByText(`${method} denied`);
    expect([...store.tasks.values()][0]).toBe(original);
    expect(edit().value).toBe("draft");
    expect(field("Рабочий процесс").value).toBe("none");
    expect(field("Конвейер").value).toBe("second");
    expect(field("Начать с чистого состояния").checked).toBe(true);
    api.readTopicTask.mockResolvedValue(doc("retry"));
    reset();
    confirm();
    await waitFor(() => expect(edit().value).toBe("retry"));
  },
);
it.each([false, true])(
  "successful exists=%s is distinguished from read error",
  async (exists) => {
    await setup();
    api.readTopicTask.mockResolvedValue(doc("", exists, "v2"));
    reset();
    await screen.findByText(
      exists ? /Файл задачи пуст/ : /Файл задачи отсутствует/,
    );
    expect(edit().value).toBe("");
    expect(edit().disabled).toBe(false);
  },
);
it.each(["missing", "ambiguous"])(
  "%s exact topic never silently substitutes another",
  async (mode) => {
    await setup();
    api.discover.mockResolvedValue({
      ...data,
      topics:
        mode === "missing"
          ? [{ ...topics[0], topic: "changed-id" }, topics[1]]
          : [topics[0], { ...topics[0] }],
    });
    reset();
    await screen.findByRole("alert");
    expect(edit().value).toBe("original");
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
    expect(api.preview).toHaveBeenCalledTimes(1);
  },
);
it("new mode resets task/name/baseRef without reading or creating and persists current draft only", async () => {
  const { store, view } = await setup();
  fireEvent.change(edit(), { target: { value: "existing draft" } });
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  change("Имя нового топика", "feature");
  change("Исходная ветка", "other");
  fireEvent.change(edit(), { target: { value: "new draft" } });
  reset();
  confirm();
  await waitFor(() => expect(field("Имя нового топика").value).toBe(""));
  expect(edit().value).toBe("");
  expect(field("Исходная ветка").value).toBe("HEAD");
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  expect(api.launch).not.toHaveBeenCalled();
  expect(api.checkoutBranch).not.toHaveBeenCalled();
  view.unmount();
  render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await screen.findByRole("textbox", { name: "Имя нового топика" });
  expect(edit().value).toBe("");
  fireEvent.click(screen.getByRole("radio", { name: "Существующий" }));
  expect(edit().value).toBe("existing draft");
});
it.each(["edit", "parameters", "topic", "unmount", "newer-store"])(
  "late reset cannot overwrite %s",
  async (action) => {
    const { store, view } = await setup();
    const pending = deferred<any>();
    api.readTopicTask.mockReturnValueOnce(pending.promise);
    reset();
    await waitFor(() => expect(api.readTopicTask).toHaveBeenCalledTimes(2));
    if (action === "edit")
      fireEvent.change(edit(), { target: { value: "newer text" } });
    if (action === "parameters") change("Рабочий процесс", "none");
    if (action === "topic") {
      select("other");
      await waitFor(() => expect(edit().disabled).toBe(false));
    }
    if (action === "unmount") view.unmount();
    if (action === "newer-store") {
      const [key, draft] = [...store.tasks.entries()][0];
      act(() => {
        store.tasks.set(key, { ...draft, text: "newer text" });
        store.listeners.forEach((fn) => fn());
      });
    }
    await act(async () => pending.resolve(doc("stale")));
    expect([...store.tasks.values()].some((d) => d.text === "stale")).toBe(
      false,
    );
    if (action === "edit" || action === "newer-store")
      expect(edit().value).toBe("newer text");
    if (action === "parameters")
      expect(field("Рабочий процесс").value).toBe("none");
  },
);
it("double invocation starts only one transaction and launch is unavailable during preparation", async () => {
  await setup();
  const pending = deferred<any>();
  api.discover.mockReturnValueOnce(pending.promise);
  const button = retainedButton("Сбросить");
  act(() => {
    fireEvent.click(button);
    fireEvent.click(button);
  });
  expect(api.discover).toHaveBeenCalledTimes(2);
  expect(
    (screen.getByRole("button", { name: "Запустить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => pending.resolve(data));
});
it("pending narrow reread and pending launch exclude reset", async () => {
  await setup();
  const pending = deferred<any>();
  api.readTopicTask.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Перечитать задачу" }));
  reset();
  expect(api.discover).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(doc()));
  const run = deferred<any>();
  api.launch.mockReturnValueOnce(run.promise);
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  reset();
  expect(api.discover).toHaveBeenCalledTimes(1);
  await act(async () => run.resolve({ id: "run" }));
});
it("initial discovery failure can recover through reset", async () => {
  api.discover.mockRejectedValueOnce(new Error("offline"));
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  await screen.findByText("offline");
  reset();
  await waitFor(() => expect(edit().value).toBe("original"));
  expect(api.discover).toHaveBeenCalledTimes(2);
  expect(api.preview).toHaveBeenCalledTimes(1);
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
});
it.each(["reread", "launch"])(
  "synchronous %s then reset cannot start overlapping work",
  async (action) => {
    await setup();
    const pending = deferred<any>();
    if (action === "reread")
      api.readTopicTask.mockReturnValueOnce(pending.promise);
    else {
      api.checkoutBranch.mockReturnValueOnce(pending.promise);
    }
    const first = screen.getByRole("button", {
      name: action === "reread" ? "Перечитать задачу" : "Запустить",
    });
    const second = retainedButton("Сбросить");
    act(() => {
      fireEvent.click(first);
      fireEvent.click(second);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.discover).toHaveBeenCalledTimes(1);
    await act(async () =>
      pending.resolve(action === "reread" ? doc() : "main"),
    );
  },
);
it("initial discovery in progress cannot overlap reset", async () => {
  const pending = deferred<any>();
  api.discover.mockReturnValueOnce(pending.promise);
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  reset();
  expect(api.discover).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(data));
});
it("reset selected exact topic ID survives reopen when two IDs share a branch", async () => {
  const two = { ...topics[0], topic: "second-id" };
  api.discover.mockResolvedValue({ ...data, topics: [topics[0], two] });
  const { store, view } = await setup();
  // Settle the selected task in act before clicking Reset: a mounted textarea
  // from the previous render is not proof that the new snapshot has settled.
  const selectedTask = deferred<ReturnType<typeof doc>>();
  api.readTopicTask.mockReturnValueOnce(selectedTask.promise);
  select("second-id");
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  await act(async () => selectedTask.resolve(doc()));
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  api.readTopicTask.mockResolvedValue(doc("fresh second"));
  fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
  await waitFor(() => expect(edit().value).toBe("fresh second"));
  view.unmount();
  render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await waitFor(() => expect(edit().value).toBe("fresh second"));
  expect(
    screen.getByRole("combobox", { name: "Топик проекта" }).textContent,
  ).toContain("second-id");
});
it("all stage cards, empty-task and launch consents reset together", async () => {
  await setup();
  fireEvent.click(stage("one"));
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  fireEvent.change(edit(), { target: { value: "" } });
  fireEvent.click(field("Подтверждаю сохранение пустой задачи"));
  reset();
  confirm();
  await waitFor(() => expect(edit().value).toBe("original"));
  expect(stage("one").checked).toBe(true);
  expect(stage("two").checked).toBe(true);
  expect(
    screen.queryByRole("checkbox", { name: /Подтверждаю.*запуск/ }),
  ).toBeNull();
  fireEvent.change(edit(), { target: { value: "" } });
  expect(field("Подтверждаю сохранение пустой задачи").checked).toBe(false);
});
it("prepared preview wins over older pending ordinary preview and is not fetched twice", async () => {
  await setup();
  const old = deferred<any>();
  api.preview.mockReturnValueOnce(old.promise);
  change("Рабочий процесс", "none");
  api.preview.mockResolvedValue({
    ...preview,
    token: "prepared",
    stages: [{ id: "fresh", title: "Fresh" }],
  });
  reset();
  confirm();
  await waitFor(() => expect(field("Рабочий процесс").value).toBe("auto"));
  expect(api.preview).toHaveBeenCalledTimes(3);
  await act(async () =>
    old.resolve({
      ...preview,
      token: "stale",
      stages: [{ id: "old", title: "Old" }],
    }),
  );
  expect(stage("fresh").checked).toBe(true);
  expect(screen.queryByText("old")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Запустить" }));
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({ previewToken: "prepared" }),
    ),
  );
});
it.each(["task", "parameters", "topic"])(
  "confirmation expires on newer %s before consent",
  async (action) => {
    await setup();
    await screen.findByRole("textbox", { name: "Что нужно сделать?" });
    fireEvent.change(edit(), { target: { value: "draft" } });
    reset();
    if (action === "task")
      fireEvent.change(edit(), { target: { value: "newer" } });
    if (action === "parameters") change("Рабочий процесс", "none");
    if (action === "topic") select("other");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.discover).toHaveBeenCalledTimes(1);
  },
);
it("unmount/remount rejects late reset, retains other drafts, and successful reset does not resurrect", async () => {
  const { view, store } = await setup();
  const unrelated = { text: "unrelated", status: "ready" as const, error: "" };
  store.tasks.set("unrelated", unrelated);
  store.forms.set("another-project", {
    mode: "new",
    branch: "",
    name: "retained",
    baseRef: "other",
  });
  const otherForm = store.forms.get("another-project");
  const pending = deferred<any>();
  api.readTopicTask.mockReturnValueOnce(pending.promise);
  reset();
  await waitFor(() => expect(api.readTopicTask).toHaveBeenCalledTimes(2));
  view.unmount();
  const reopened = render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await waitFor(() => expect(edit().value).toBe("original"));
  fireEvent.change(edit(), { target: { value: "newer" } });
  await act(async () => pending.resolve(doc("stale")));
  expect(edit().value).toBe("newer");
  api.readTopicTask.mockResolvedValue(doc("fresh"));
  reset();
  confirm();
  await waitFor(() => expect(edit().value).toBe("fresh"));
  reopened.unmount();
  render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await waitFor(() => expect(edit().value).toBe("fresh"));
  expect(store.tasks.get("unrelated")).toBe(unrelated);
  expect(store.forms.get("another-project")).toBe(otherForm);
});
it("reset after failed initial discovery confirms cached dirty task before any work", async () => {
  const store = createDraftStore();
  const key = JSON.stringify([project.id, "existing", "other", "other-id"]);
  const cached = {
    text: "cached unsaved",
    document: doc(),
    status: "ready" as const,
    error: "",
  };
  store.tasks.set(key, cached);
  store.forms.set(project.id, {
    mode: "existing",
    branch: "other",
    name: "",
    baseRef: "HEAD",
  });
  api.discover.mockRejectedValueOnce(new Error("offline"));
  render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await screen.findByText("offline");
  reset();
  expect(screen.getByRole("dialog", { name: "Сбросить форму?" })).toBeTruthy();
  expect(api.discover).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(store.tasks.get(key)).toBe(cached);
  api.readTopicTask.mockResolvedValue(doc("fresh other"));
  reset();
  confirm();
  await waitFor(() => expect(edit().value).toBe("fresh other"));
  expect(api.readTopicTask).toHaveBeenLastCalledWith({
    projectId: project.id,
    branch: "other",
    topic: "other-id",
  });
});
it("failed initial discovery never loses a remembered missing branch", async () => {
  const store = createDraftStore();
  store.forms.set(project.id, {
    mode: "existing",
    branch: "missing",
    name: "",
    baseRef: "HEAD",
  });
  api.discover.mockRejectedValueOnce(new Error("offline"));
  render(
    <LaunchForm
      project={project}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await screen.findByText("offline");
  reset();
  await screen.findByText(/Выбранный топик отсутствует/);
  expect(api.readTopicTask).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
  expect(store.forms.get(project.id)?.branch).toBe("missing");
});
it("reset existing context preserves dormant new-topic name/base/task", async () => {
  await setup();
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  change("Имя нового топика", "keep-name");
  change("Исходная ветка", "other");
  fireEvent.change(edit(), { target: { value: "keep-task" } });
  fireEvent.click(screen.getByRole("radio", { name: "Существующий" }));
  api.readTopicTask.mockResolvedValue(doc("fresh"));
  reset();
  await waitFor(() => expect(edit().value).toBe("fresh"));
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  expect(field("Имя нового топика").value).toBe("keep-name");
  expect(field("Исходная ветка").value).toBe("other");
  expect(edit().value).toBe("keep-task");
});
it("a parameter edit batched with late read completion cannot be overwritten", async () => {
  await setup();
  const pending = deferred<any>();
  api.readTopicTask.mockReturnValueOnce(pending.promise);
  reset();
  await waitFor(() => expect(api.readTopicTask).toHaveBeenCalledTimes(2));
  await act(async () => {
    change("Рабочий процесс", "none");
    pending.resolve(doc("stale"));
  });
  expect(field("Рабочий процесс").value).toBe("none");
  expect(edit().value).toBe("original");
});
it("same-batch edit away and back still revokes reset consent", async () => {
  await setup();
  const pending = deferred<any>();
  api.readTopicTask.mockReturnValueOnce(pending.promise);
  reset();
  await waitFor(() => expect(api.readTopicTask).toHaveBeenCalledTimes(2));
  await act(async () => {
    change("Рабочий процесс", "none");
    change("Рабочий процесс", "auto");
    pending.resolve(doc("stale"));
  });
  expect(edit().value).toBe("original");
});
