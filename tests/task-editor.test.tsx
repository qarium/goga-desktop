import { selectCatalog } from "./helpers/select-catalog";
import "./helpers/overview-browser-fixture";
// @vitest-environment jsdom
import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  executionButton,
} from "./helpers/prototype-context-fixture";
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
import { App } from "../src/renderer/App";
import { createDraftStore, useTaskDraft } from "../src/renderer/task-drafts";
import { renderHook } from "@testing-library/react";
const p = { id: "editor", name: "Editor project", path: "/fixture/editor" };
const topics = ["main", "other"].map((branch) => ({
  branch,
  topic: branch,
  current: branch === "main",
  remote: false,
  todo: "summary only",
  statuses: [],
}));
const data = {
  pipelines: [{ id: "build", name: "Build", description: "", project: true }],
  topics,
  branches: ["main", "other"],
  currentBranch: "main",
  baseRef: "main",
  workflows: [],
  profiles: [],
};
const doc = (text = "full\noriginal\n", exists = true) => ({
  text,
  exists,
  version: "version-1",
  path: ".goga/history/2026/main/todo.md",
});
let api: any;
beforeEach(() => {
  // jsdom does not implement native dialogs; real focus trapping is smoke-tested in Electron.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    discover: vi.fn(async () => data),
    checkoutBranch: vi.fn(async () => "main"),
    preview: vi.fn(async () => ({
      token: "preview",
      stages: [{ id: "build", title: "Build" }],
      workflow: null,
      profile: null,
    })),
    readTopicTask: vi.fn(async () => doc()),
    launch: vi.fn(async () => ({
      id: "run",
      projectId: p.id,
      status: "starting",
    })),
    listProjects: vi.fn(async () => [p]),
    runs: vi.fn(async () => []),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  installPrototypeContextFixture(api, [
    { ...p, topic: "main", branch: "main" },
    { ...p, id: "second", topic: "main", branch: "main" },
  ]);
  window.goga = api;
});
afterEach(cleanup);
const form = () =>
  render(<LaunchForm project={p} onCancel={() => {}} onLaunched={() => {}} />);
const edit = () =>
  screen
    .getAllByLabelText("Что нужно сделать?")
    .find(
      (e) => !e.closest('[role="tabpanel"][hidden]'),
    )! as HTMLTextAreaElement;
async function loaded() {
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  await waitFor(() => expect(edit().value).toBe("full\noriginal\n"));
}
function selectOther() {
  fireEvent.click(screen.getByRole("combobox", { name: "Топик проекта" }));
  fireEvent.click(screen.getByRole("option", { name: /other/ }));
}
it("loads full task, no writes while typing, explicit versioned save+launch", async () => {
  form();
  await loaded();
  expect(api.readTopicTask).toHaveBeenCalledWith({
    projectId: p.id,
    branch: "main",
    topic: "main",
  });
  fireEvent.change(edit(), { target: { value: "edited\nexact" } });
  expect(api.launch).not.toHaveBeenCalled();
  expect(screen.queryByText(/Разрешаю заменить/)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "edited\nexact",
        taskVersion: "version-1",
        confirmEmptyTask: false,
      }),
    ),
  );
});
it("unchanged launch carries original text and snapshot", async () => {
  form();
  await loaded();
  fireEvent.click(executionButton());
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "full\noriginal\n",
        taskVersion: "version-1",
      }),
    ),
  );
});
it("retains drafts across topic switches and ignores late reads from previous topic", async () => {
  let late: any;
  api.readTopicTask.mockImplementationOnce(
    () => new Promise((r) => (late = r)),
  );
  const view = form();
  await waitFor(() => expect(api.readTopicTask).toHaveBeenCalled());
  expect(screen.queryByRole("combobox", { name: "Топик проекта" })).toBeNull();
  expect(edit().disabled).toBe(true);
  view.rerender(
    <LaunchForm
      project={p}
      onCancel={() => {}}
      onLaunched={() => {}}
      preparedTopic={{
        target: { topic: "other", branch: "other", remote: false },
        nonce: 1,
      }}
    />,
  );
  await loaded();
  fireEvent.change(edit(), { target: { value: "other draft" } });
  await act(async () => late(doc("wrong late")));
  expect(edit().value).toBe("other draft");
  fireEvent.click(screen.getByRole("combobox", { name: "Топик проекта" }));
  fireEvent.click(screen.getByRole("option", { name: /main/ }));
  await waitFor(() => expect(edit().value).toBe("wrong late"));
  selectOther();
  expect(edit().value).toBe("other draft");
});
it("survives cancel, settings and project navigation in App-owned memory", async () => {
  render(<App />);
  await openPrototypeLaunch();
  await loaded();
  fireEvent.change(edit(), { target: { value: "unsaved memory" } });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть форму" }));
  await openPrototypeLaunch();
  await waitFor(() => expect(edit().value).toBe("unsaved memory"));
  expect(api.launch).not.toHaveBeenCalled();
});
it("shows missing, empty and failure honestly; read failure cannot launch", async () => {
  api.readTopicTask.mockResolvedValueOnce(doc("", false));
  const f = form();
  await screen.findByText(/Файл задачи отсутствует/);
  expect(edit().value).toBe("");
  f.unmount();
  api.readTopicTask.mockResolvedValueOnce(doc("", true));
  const g = form();
  await screen.findByText(/Файл задачи пуст/);
  g.unmount();
  api.readTopicTask.mockRejectedValueOnce(new Error("denied read"));
  form();
  await screen.findByText(/denied read/);
  expect(edit().disabled).toBe(true);
  expect((executionButton() as HTMLButtonElement).disabled).toBe(true);
});
it("requires explicit confirmation to save empty text", async () => {
  form();
  await loaded();
  fireEvent.change(edit(), { target: { value: "" } });
  const save = screen.getByRole("button", {
    name: "Сохранить и запустить",
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Подтверждаю сохранение пустой задачи",
    }),
  );
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({ task: "", confirmEmptyTask: true }),
    ),
  );
});
it("preserves conflicting draft and requires confirmation before reread", async () => {
  api.launch.mockRejectedValueOnce(
    new Error("Задача изменилась вне приложения"),
  );
  form();
  await loaded();
  fireEvent.change(edit(), { target: { value: "my conflicting text" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  await screen.findByText("Задача изменилась вне приложения");
  expect(edit().value).toBe("my conflicting text");
  api.readTopicTask.mockResolvedValueOnce(doc("external"));
  fireEvent.click(screen.getByRole("button", { name: "Перечитать задачу" }));
  expect(edit().value).toBe("my conflicting text");
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: "Перечитать и сбросить" }),
  );
  await waitFor(() => expect(edit().value).toBe("external"));
  expect(document.querySelectorAll("textarea")).toHaveLength(1);
});
it("renders unified radio topic block and renamed workspace", async () => {
  const shell = render(<App />);
  expect(await screen.findByText("Мой компьютер")).toBeTruthy();
  shell.unmount();
  form();
  await loaded();
  expect(screen.getByRole("radio", { name: "Существующий" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Топик" })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  expect(screen.getByLabelText("Имя нового топика")).toBeTruthy();
  expect(screen.getByLabelText("Исходная ветка")).toBeTruthy();
  expect(screen.getByText(/Создадим.*при запуске/)).toBeTruthy();
  expect(api.launch).not.toHaveBeenCalled();
});
it("restores standalone selected topic and independent drafts after changing projects", async () => {
  const second = { ...p, id: "second", name: "Second project" };
  api.listProjects.mockResolvedValue([p, second]);
  render(<TopicFormHarness projects={[p, second]} />);
  fireEvent.click(screen.getByRole("button", { name: "Открыть форму" }));
  await loaded();
  selectOther();
  await loaded();
  fireEvent.change(edit(), { target: { value: "other on first project" } });
  fireEvent.click(screen.getByRole("button", { name: /Second project/ }));
  fireEvent.click(screen.getByRole("button", { name: "Открыть форму" }));
  await loaded();
  fireEvent.change(edit(), { target: { value: "second project draft" } });
  fireEvent.click(screen.getByRole("button", { name: /Editor project/ }));
  fireEvent.click(screen.getByRole("button", { name: "Открыть форму" }));
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  await waitFor(() => expect(edit().value).toBe("other on first project"));
  expect(
    screen.getByRole("combobox", { name: "Топик проекта" }).textContent,
  ).toContain("other");
  expect(api.launch).not.toHaveBeenCalled();
});
it("standalone new-topic draft including name and source survives cancellation without creation", async () => {
  render(<TopicFormHarness projects={[p]} />);
  fireEvent.click(screen.getByRole("button", { name: "Открыть форму" }));
  await loaded();
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  fireEvent.change(screen.getByLabelText("Имя нового топика"), {
    target: { value: "new/work" },
  });
  selectCatalog(screen.getByLabelText("Исходная ветка"), "other");
  fireEvent.change(edit(), { target: { value: "new unsaved task" } });
  fireEvent.click(screen.getByRole("button", { name: "Закрыть форму" }));
  fireEvent.click(screen.getByRole("button", { name: "Открыть форму" }));
  await waitFor(() => expect(edit().value).toBe("new unsaved task"));
  expect(
    (screen.getByLabelText("Имя нового топика") as HTMLInputElement).value,
  ).toBe("new/work");
  expect(
    (screen.getByLabelText("Исходная ветка") as HTMLButtonElement).value,
  ).toBe("other");
  expect(api.launch).not.toHaveBeenCalled();
});
it("returning to a still-pending read receives its completion and cannot edit during loading", async () => {
  let late: any;
  api.readTopicTask.mockImplementationOnce(
    () => new Promise((r) => (late = r)),
  );
  const view = form();
  await waitFor(() => expect(api.readTopicTask).toHaveBeenCalled());
  expect(screen.queryByRole("combobox", { name: "Топик проекта" })).toBeNull();
  view.rerender(
    <LaunchForm
      project={p}
      onCancel={() => {}}
      onLaunched={() => {}}
      preparedTopic={{
        target: { topic: "other", branch: "other", remote: false },
        nonce: 1,
      }}
    />,
  );
  await loaded();
  fireEvent.click(screen.getByRole("combobox", { name: "Топик проекта" }));
  fireEvent.click(screen.getByRole("option", { name: /main/ }));
  expect(edit().disabled).toBe(true);
  await act(async () => late(doc("delayed main")));
  expect(edit().value).toBe("delayed main");
  expect(edit().disabled).toBe(false);
});
it("late launch completion cannot erase newer text or close a reopened editor", async () => {
  let finish: any;
  api.launch.mockImplementationOnce(() => new Promise((r) => (finish = r)));
  render(<App />);
  await openPrototypeLaunch();
  await loaded();
  fireEvent.change(edit(), { target: { value: "submitted" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Сохранить и запустить" }),
  );
  await waitFor(() => expect(api.launch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await openPrototypeLaunch();
  await waitFor(() => expect(edit().value).toBe("submitted"));
  fireEvent.change(edit(), { target: { value: "newer draft" } });
  await act(async () =>
    finish({ id: "late", projectId: p.id, status: "exited" }),
  );
  expect(edit().value).toBe("newer draft");
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await openPrototypeLaunch();
  await waitFor(() => expect(edit().value).toBe("newer draft"));
});
it("late launch of a reused unedited draft cannot strand the reopened editor", async () => {
  let finish: any;
  api.launch.mockImplementationOnce(() => new Promise((r) => (finish = r)));
  render(<App />);
  await openPrototypeLaunch();
  await loaded();
  fireEvent.click(executionButton());
  await waitFor(() => expect(api.launch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await openPrototypeLaunch();
  await loaded();
  await act(async () =>
    finish({ id: "late", projectId: p.id, status: "exited" }),
  );
  expect(edit().disabled).toBe(false);
  expect(edit().value).toBe("full\noriginal\n");
});

const reread = () =>
  fireEvent.click(screen.getByRole("button", { name: "Перечитать задачу" }));
const confirmReread = () =>
  fireEvent.click(
    screen.getByRole("button", { name: "Перечитать и сбросить" }),
  );
it("clean reread is direct and repeated dirty rereads leave exactly one editor", async () => {
  form();
  await loaded();
  api.readTopicTask.mockResolvedValue(doc("fresh"));
  reread();
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(edit().value).toBe("fresh"));
  for (let i = 0; i < 3; i++) {
    fireEvent.change(edit(), { target: { value: `draft ${i}` } });
    reread();
    expect(edit().value).toBe(`draft ${i}`);
    confirmReread();
    await waitFor(() => expect(edit().value).toBe("fresh"));
    expect(document.querySelectorAll("textarea")).toHaveLength(1);
  }
});
it.each(["cancel", "escape", "close"])(
  "dirty reread %s preserves text and snapshot without reading",
  async (action) => {
    const store = createDraftStore();
    render(
      <LaunchForm
        project={p}
        draftStore={store}
        onCancel={() => {}}
        onLaunched={() => {}}
      />,
    );
    await loaded();
    fireEvent.change(edit(), { target: { value: "keep this" } });
    const original = [...store.tasks.values()][0];
    reread();
    const dialog = screen.getByRole("dialog", { name: "Перечитать задачу?" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Отмена" }),
    );
    if (action === "escape")
      fireEvent(dialog, new Event("cancel", { cancelable: true }));
    else
      fireEvent.click(
        screen.getByRole("button", {
          name: action === "close" ? "Закрыть подтверждение" : "Отмена",
        }),
      );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(edit().value).toBe("keep this");
    expect([...store.tasks.values()][0]).toBe(original);
    expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  },
);
it("failed confirmed reread keeps the editable text and original version", async () => {
  const store = createDraftStore();
  render(
    <LaunchForm
      project={p}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await loaded();
  fireEvent.change(edit(), { target: { value: "recoverable" } });
  const original = [...store.tasks.values()][0].document;
  api.readTopicTask.mockRejectedValueOnce(new Error("reload denied"));
  reread();
  confirmReread();
  await screen.findByText(/reload denied/);
  expect(edit().value).toBe("recoverable");
  expect(edit().disabled).toBe(false);
  expect([...store.tasks.values()][0].document).toBe(original);
  fireEvent.change(edit(), { target: { value: "still editable" } });
  expect(edit().value).toBe("still editable");
});
it("confirmed reload is single-flight even with synchronous double clicks", async () => {
  let finish: any;
  form();
  await loaded();
  fireEvent.change(edit(), { target: { value: "dirty" } });
  api.readTopicTask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  reread();
  const confirm = screen.getByRole("button", { name: "Перечитать и сбросить" });
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  expect(api.readTopicTask).toHaveBeenCalledTimes(2);
  expect(edit().value).toBe("dirty");
  await act(async () => finish(doc("fresh")));
  expect(edit().value).toBe("fresh");
});
it("switching topic cancels pending reload and restores the previous snapshot", async () => {
  let finish: any;
  const view = form();
  await loaded();
  fireEvent.change(edit(), { target: { value: "main draft" } });
  api.readTopicTask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  reread();
  confirmReread();
  view.rerender(
    <LaunchForm
      project={p}
      onCancel={() => {}}
      onLaunched={() => {}}
      preparedTopic={{
        target: { topic: "other", branch: "other", remote: false },
        nonce: 1,
      }}
    />,
  );
  await loaded();
  fireEvent.click(screen.getByRole("combobox", { name: "Топик проекта" }));
  fireEvent.click(screen.getByRole("option", { name: /main/ }));
  expect(edit().value).toBe("main draft");
  expect(edit().disabled).toBe(false);
  await act(async () => finish(doc("stale reload")));
  expect(edit().value).toBe("main draft");
});
it.each(["close", "project"])(
  "%s cancels pending reload so a reopened form is usable and rejects late completion",
  async (action) => {
    let finish: any;
    const second = { ...p, id: "second", name: "Second project" };
    api.listProjects.mockResolvedValue([p, second]);
    render(<App />);
    await openPrototypeLaunch();
    await loaded();
    fireEvent.change(edit(), { target: { value: "kept draft" } });
    api.readTopicTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    reread();
    confirmReread();
    if (action === "close")
      fireEvent.click(screen.getByRole("button", { name: "Закрыть форму" }));
    else {
      fireEvent.click(screen.getByRole("button", { name: /Second project/ }));
      fireEvent.click(screen.getByRole("button", { name: /Editor project/ }));
    }
    await openPrototypeLaunch();
    await waitFor(() => expect(edit().disabled).toBe(false));
    expect(edit().value).toBe("kept draft");
    await act(async () => finish(doc("late stale reload")));
    expect(edit().value).toBe("kept draft");
  },
);
it("confirmation is invalidated by another topic or newer text", async () => {
  form();
  await loaded();
  fireEvent.change(edit(), { target: { value: "draft" } });
  reread();
  fireEvent.change(edit(), { target: { value: "newer draft" } });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  reread();
  selectOther();
  await loaded();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.readTopicTask).toHaveBeenCalledTimes(2);
});
it("reload validates captured identity and guards newer store entries", async () => {
  let finish: any;
  const store = createDraftStore();
  const request = { projectId: p.id, branch: "main", topic: "main" };
  const hook = renderHook(() => useTaskDraft(store, "main", request, false));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  const staleReload = hook.result.current.reload;
  act(() => hook.result.current.edit("newer text"));
  await act(async () => {
    await staleReload();
  });
  expect(api.readTopicTask).toHaveBeenCalledTimes(1);
  api.readTopicTask.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => {
    void hook.result.current.reload();
    void hook.result.current.reload();
  });
  expect(api.readTopicTask).toHaveBeenCalledTimes(2);
  const newer = {
    ...store.tasks.get("main")!,
    text: "newer entry",
    status: "ready" as const,
  };
  act(() => {
    store.tasks.set("main", newer);
    store.listeners.forEach((fn) => fn());
  });
  await act(async () => finish(doc("late")));
  expect(store.tasks.get("main")).toBe(newer);
});

function TopicFormHarness({ projects }: { projects: (typeof p)[] }) {
  const [selected, setSelected] = React.useState(projects[0].id);
  const [open, setOpen] = React.useState(false);
  const drafts = React.useRef(createDraftStore());
  return (
    <>
      {projects.map((project) => (
        <button key={project.id} onClick={() => setSelected(project.id)}>
          {project.name}
        </button>
      ))}
      <button onClick={() => setOpen(true)}>Открыть форму</button>
      {projects.map((project) => (
        <div
          key={project.id}
          role="tabpanel"
          hidden={!open || selected !== project.id}
        >
          <LaunchForm
            project={project}
            draftStore={drafts.current}
            suspended={!open || selected !== project.id}
            onCancel={() => setOpen(false)}
            onLaunched={() => {}}
          />
        </div>
      ))}
    </>
  );
}

/** Model Electron's real read-request envelope while retaining actual renderer routing. */
function useTaskReadIPCEnvelope() {
  api.readRequest = vi.fn(
    async (_id: string, method: string, args: unknown[]) => {
      try {
        return await api[method](...args);
      } catch (error) {
        if (method !== "readTopicTask") throw error;
        throw Error(
          `Error invoking remote method 'goga:read-request': Error: ${(error as Error).message}`,
        );
      }
    },
  );
}
const taskReadReason =
  "Описание задачи выбранного топика не сохранено в Git. Сохраните необходимые данные задачи коммитом. Подробность: Error: исходный текст сохранён.";
const exactTaskOwner = {
  projectId: p.id,
  year: "2026",
  topic: "main",
  branch: "main",
  contextId: `ctx-${"1".padStart(64, "0")}`,
  revision: "00000000-0000-4000-8000-000000000001",
};
it("normalizes initial task failure on direct exact-owner form opening through readRequest", async () => {
  useTaskReadIPCEnvelope();
  api.readTopicTask.mockRejectedValueOnce(Error(taskReadReason));
  render(<App />);
  await openPrototypeLaunch();
  expect((await screen.findByRole("alert")).textContent).toBe(taskReadReason);
  expect(api.checkTopicContextReadiness).not.toHaveBeenCalled();
  expect(api.readRequest).toHaveBeenCalledWith(
    expect.any(String),
    "readTopicTask",
    [
      {
        projectId: p.id,
        context: exactTaskOwner,
        branch: "main",
        topic: "main",
      },
    ],
  );
  expect(api.launch).not.toHaveBeenCalled();
  expect((executionButton() as HTMLButtonElement).disabled).toBe(true);
});
it("normalizes failed defensive reread without losing editable draft or original snapshot", async () => {
  useTaskReadIPCEnvelope();
  const store = createDraftStore();
  render(
    <LaunchForm
      project={p}
      owner={exactTaskOwner}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await loaded();
  fireEvent.change(edit(), { target: { value: "keep exact draft" } });
  const original = [...store.tasks.values()][0].document;
  api.readTopicTask.mockRejectedValueOnce(Error(taskReadReason));
  reread();
  confirmReread();
  expect((await screen.findByRole("alert")).textContent).toBe(
    `Не удалось прочитать задачу: ${taskReadReason}`,
  );
  expect(edit().value).toBe("keep exact draft");
  expect(edit().disabled).toBe(false);
  expect([...store.tasks.values()][0].document).toBe(original);
  expect(api.launch).not.toHaveBeenCalled();
});
it("normalizes task-read failure during reset without partially resetting the draft", async () => {
  useTaskReadIPCEnvelope();
  const store = createDraftStore();
  render(
    <LaunchForm
      project={p}
      owner={exactTaskOwner}
      draftStore={store}
      onCancel={() => {}}
      onLaunched={() => {}}
    />,
  );
  await loaded();
  fireEvent.change(edit(), { target: { value: "retain on failed reset" } });
  const original = [...store.tasks.values()][0];
  api.readTopicTask.mockRejectedValueOnce(Error(taskReadReason));
  fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
  fireEvent.click(screen.getByRole("button", { name: "Сбросить изменения" }));
  expect((await screen.findByRole("alert")).textContent).toBe(taskReadReason);
  expect(edit().value).toBe("retain on failed reset");
  expect([...store.tasks.values()][0]).toBe(original);
  expect(api.launch).not.toHaveBeenCalled();
});
