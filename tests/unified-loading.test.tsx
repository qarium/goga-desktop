// @vitest-environment jsdom
import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  act,
  waitFor,
} from "@testing-library/react";
import { BuildForm } from "../src/renderer/BuildForm";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { TopicsWorkspace } from "../src/renderer/TopicsWorkspace";
import { createTopicsStore } from "../src/renderer/topics-model";
import { ProjectFlatDocuments } from "../src/renderer/ProjectFlatDocuments";
import { SettingsDocument } from "../src/renderer/SettingsDocument";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
const project = { id: "p", name: "Fixture", path: "/fixture" };
const board: any = {
  projectId: "p",
  year: "2026",
  revision: "v",
  currentBranch: "main",
  currentTopic: null,
  baseRef: "main",
  branches: ["main"],
  dirty: false,
  active: false,
  entries: [],
  records: [],
  remoteEntries: [],
  remoteRecords: [],
};
const context: any = {
  revision: "v",
  branch: "main",
  capabilities: ["workflow", "profile"],
  defaults: { skipReview: false, profile: "" },
  branches: ["main"],
  workflows: [],
  profiles: [],
  historyPlan: { path: "plan.md" },
};
const catalog: any = {
  pipelines: [{ id: "one", name: "One", project: true }],
  topics: [
    {
      topic: "main",
      branch: "main",
      current: true,
      remote: false,
      statuses: [],
      todo: "summary",
    },
  ],
  branches: ["main"],
  currentBranch: "main",
  baseRef: "main",
  workflows: [],
  profiles: [],
};
const preview = {
  token: "v",
  stages: [{ id: "one", title: "One" }],
  workflow: null,
  profile: null,
};
function deferred() {
  let resolve!: (v?: any) => void, reject!: (e: any) => void;
  const promise = new Promise<any>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async (d: ReturnType<typeof deferred>, value: any) =>
  act(async () => d.resolve(value));
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    buildContext: vi.fn(async () => context),
    readBuildPlan: vi.fn(async (_id, path) => ({
      path,
      text: "# Plan",
      version: "v",
    })),
    discover: vi.fn(async () => catalog),
    preview: vi.fn(async () => preview),
    readTopicTask: vi.fn(async () => ({
      text: "task",
      exists: true,
      version: "v",
      path: "todo.md",
    })),
    checkoutBranch: vi.fn(async () => "main"),
    readTopicBoard: vi.fn(async () => board),
  };
  window.goga = api;
});
afterEach(cleanup);
const build = (props = {}) => (
  <BuildForm
    project={project}
    onCancel={() => {}}
    onLaunched={() => {}}
    {...props}
  />
);
const launch = (props = {}) => (
  <LaunchForm
    project={project}
    onCancel={() => {}}
    onLaunched={() => {}}
    {...props}
  />
);
const loading = () =>
  expect(
    screen.getAllByRole("status").some((e) => e.closest(".loading-state")),
  ).toBe(true);
it("Build waits for context AND dependent plan; missing is finished rather than endless loading", async () => {
  const c = deferred(),
    p = deferred();
  api.buildContext.mockReturnValue(c.promise);
  api.readBuildPlan.mockReturnValue(p.promise);
  render(build());
  loading();
  expect(screen.queryByRole("textbox", { name: "План сборки" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Закрыть форму сборки" }),
  ).toBeTruthy();
  await waitFor(() => expect(api.buildContext).toHaveBeenCalled());
  await flush(c, context);
  loading();
  expect(screen.queryByRole("combobox", { name: "Профиль" })).toBeNull();
  await act(async () => p.reject(Error("[build-plan:missing]")));
  expect(
    await screen.findByText("План не найден. Выберите файл плана"),
  ).toBeTruthy();
  expect(document.querySelector(".loading-state")).toBeNull();
});
it("Build refresh keeps the same inputs and values; errors finish and retry", async () => {
  render(build());
  await screen.findByText("План доступен");
  const input = screen.getByLabelText("План сборки");
  fireEvent.change(input, { target: { value: "custom.md" } });
  await screen.findByText("План доступен");
  const c = deferred();
  api.buildContext.mockReturnValueOnce(c.promise);
  fireEvent.click(screen.getByRole("button", { name: "Обновить данные" }));
  loading();
  expect(screen.queryByRole("textbox", { name: "План сборки" })).toBeNull();
  await waitFor(() => expect(api.buildContext).toHaveBeenCalledTimes(2));
  await act(async () => c.reject(Error("CLI unavailable")));
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await screen.findByText("План доступен");
  expect(screen.getByLabelText("План сборки")).toBe(input);
  expect((input as HTMLInputElement).value).toBe("custom.md");
});
it("Launch waits for catalog, preview and task in either completion order", async () => {
  const d = deferred(),
    p = deferred(),
    t = deferred();
  api.discover.mockReturnValue(d.promise);
  api.preview.mockReturnValue(p.promise);
  api.readTopicTask.mockReturnValue(t.promise);
  render(launch());
  loading();
  await flush(d, catalog);
  loading();
  expect(screen.queryByRole("combobox", { name: "Конвейер" })).toBeNull();
  await flush(p, preview);
  loading();
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  await flush(t, {
    text: "whole task",
    exists: true,
    version: "v",
    path: "todo.md",
  });
  expect(
    await screen.findByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeTruthy();
  expect(screen.getByDisplayValue("whole task")).toBeTruthy();
  expect(document.querySelector(".loading-state")).toBeNull();
});
it("Launch catalog error is finished and retries without reset action", async () => {
  api.discover.mockRejectedValueOnce(Error("catalog failed"));
  render(launch());
  await screen.findByRole("alert");
  expect(document.querySelector(".loading-state")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  expect(
    await screen.findByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeTruthy();
});
it("Launch task error and preview error end loading and permit retry", async () => {
  api.preview.mockRejectedValueOnce(Error("preview failed"));
  api.readTopicTask.mockRejectedValueOnce(Error("task failed"));
  render(launch());
  await screen.findByText("task failed");
  expect(document.querySelector(".loading-state")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await screen.findByRole("button", { name: "Перечитать задачу" });
  fireEvent.click(screen.getByRole("button", { name: "Перечитать задачу" }));
  await screen.findByDisplayValue("task");
  expect(document.querySelector(".loading-state")).toBeNull();
});
it("Topics hides filters/table/warnings as one boundary and keeps filters after refresh", async () => {
  const d = deferred();
  api.readTopicBoard.mockReturnValueOnce(d.promise);
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onOpenTopic={() => {}}
      onChanged={() => {}}
    />,
  );
  loading();
  expect(screen.queryByRole("searchbox")).toBeNull();
  await flush(d, board);
  const input = await screen.findByRole("searchbox");
  fireEvent.change(input, { target: { value: "retained" } });
  const next = deferred();
  api.readTopicBoard.mockReturnValueOnce(next.promise);
  fireEvent.click(screen.getByRole("button", { name: "Обновить список" }));
  loading();
  expect(screen.queryByRole("searchbox")).toBeNull();
  await flush(next, board);
  expect(screen.getByRole("searchbox")).toBe(input);
  expect((input as HTMLInputElement).value).toBe("retained");
});
it.each(["workflow", "pipeline", "profile"] as const)(
  "%s catalog has one boundary, empty completion and retry",
  async (kind) => {
    const d = deferred();
    const fn =
      kind === "workflow"
        ? "listProjectWorkflows"
        : kind === "pipeline"
          ? "listProjectPipelines"
          : "listProjectProfiles";
    api[fn] = vi.fn(() => d.promise);
    render(
      <ProjectFlatDocuments
        kind={kind}
        project={project}
        store={createSettingsDocuments()}
      />,
    );
    loading();
    expect(screen.queryByRole("button", { name: /Создать/ })).toBeNull();
    await act(async () => d.reject(Error("catalog unavailable")));
    expect(document.querySelector(".loading-state")).toBeNull();
    api[fn].mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
    expect(
      await screen.findByRole("heading", { name: /В проекте пока нет/ }),
    ).toBeTruthy();
  },
);
it("YAML explicit read uses shared loader without loading unopened files", async () => {
  const d = deferred();
  api.readProjectDocument = vi.fn(() => d.promise);
  const store = createSettingsDocuments();
  render(
    <SettingsDocument
      store={store}
      source={{ scope: "project", projectId: "p", target: { kind: "config" } }}
      path=".goga/config.yml"
      title="Config"
      description="Description"
    />,
  );
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
  loading();
  expect(screen.queryByRole("button", { name: /Читаем/ })).toBeNull();
  await act(async () => d.reject(Error("denied")));
  expect(document.querySelector(".loading-state")).toBeNull();
  expect(
    await screen.findByRole("button", { name: "Повторить загрузку" }),
  ).toBeTruthy();
});

it("a failed preview exposes selection while a pending task remains disabled and retryable", async () => {
  api.preview.mockRejectedValueOnce(Error("preview unavailable"));
  api.readTopicTask.mockReturnValueOnce(new Promise(() => {}));
  render(launch());
  await screen.findByRole("alert");
  expect(document.querySelector(".loading-state")).toBeNull();
  expect(screen.getByRole("combobox", { name: "Конвейер" })).toBeTruthy();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Что нужно сделать?",
      }) as HTMLTextAreaElement
    ).disabled,
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Повторить загрузку" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await screen.findByDisplayValue("task");
  expect(api.readTopicTask).toHaveBeenCalledTimes(2);
});
it("an empty pipeline catalog finishes without waiting for an irrelevant task", async () => {
  api.discover.mockResolvedValue({ ...catalog, pipelines: [] });
  api.readTopicTask.mockReturnValue(new Promise(() => {}));
  render(launch());
  await screen.findByText("Goga не вернула доступных конвейеров.");
  expect(document.querySelector(".loading-state")).toBeNull();
});

it("Build never reveals a late context/plan after a revision changes", async () => {
  const old = deferred(),
    fresh = deferred(),
    plan = deferred();
  api.buildContext
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  api.readBuildPlan.mockReturnValueOnce(plan.promise);
  const view = render(build({ revision: "old" }));
  await waitFor(() => expect(api.buildContext).toHaveBeenCalledTimes(1));
  view.rerender(build({ revision: "fresh" }));
  await waitFor(() => expect(api.buildContext).toHaveBeenCalledTimes(2));
  await flush(old, { ...context, historyPlan: { path: "stale.md" } });
  loading();
  expect(api.readBuildPlan).not.toHaveBeenCalled();
  await flush(fresh, { ...context, historyPlan: { path: "fresh.md" } });
  await waitFor(() =>
    expect(api.readBuildPlan).toHaveBeenCalledWith("p", "fresh.md"),
  );
  loading();
  expect(screen.queryByRole("textbox", { name: "План сборки" })).toBeNull();
  await flush(plan, { path: "fresh.md", text: "fresh", version: "fresh" });
  expect(
    (
      (await screen.findByRole("textbox", {
        name: "План сборки",
      })) as HTMLInputElement
    ).value,
  ).toBe("fresh.md");
});
it("Topics ignores an old project's late reply, including warnings", async () => {
  const old = deferred(),
    fresh = deferred();
  api.readTopicBoard
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const store = createTopicsStore();
  const props = { store, onOpenTopic: () => {}, onChanged: () => {} };
  const view = render(<TopicsWorkspace key="p" project={project} {...props} />);
  view.rerender(
    <TopicsWorkspace key="q" project={{ ...project, id: "q" }} {...props} />,
  );
  await flush(old, { ...board, dirty: true, currentBranch: "stale" });
  loading();
  expect(screen.queryByRole("searchbox")).toBeNull();
  await flush(fresh, { ...board, projectId: "q" });
  await screen.findByRole("searchbox");
  expect(screen.queryByText(/stale/)).toBeNull();
  expect(document.querySelector(".loading-state")).toBeNull();
});
it("Launch refresh preserves the mounted task and draft through dependent preview", async () => {
  const view = render(launch({ settingsRevision: "old" }));
  const input = await screen.findByRole("textbox", {
    name: "Что нужно сделать?",
  });
  fireEvent.change(input, { target: { value: "unsaved draft" } });
  const d = deferred(),
    p = deferred();
  api.discover.mockReturnValueOnce(d.promise);
  api.preview.mockReturnValueOnce(p.promise);
  view.rerender(launch({ settingsRevision: "fresh" }));
  loading();
  expect(
    screen.queryByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBeNull();
  expect(input.isConnected).toBe(true);
  await flush(d, catalog);
  loading();
  await flush(p, preview);
  expect(
    await screen.findByRole("textbox", { name: "Что нужно сделать?" }),
  ).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe("unsaved draft");
});
it("closing a pending Build does not resurrect it on a late reply", async () => {
  const d = deferred();
  api.buildContext.mockReturnValueOnce(d.promise);
  const view = render(build());
  await waitFor(() => expect(api.buildContext).toHaveBeenCalled());
  view.unmount();
  await flush(d, context);
  expect(screen.queryByRole("status")).toBeNull();
  expect(api.readBuildPlan).not.toHaveBeenCalled();
});

it("retry recovers a failed settings refresh that superseded unfinished initial discovery", async () => {
  api.discover
    .mockReturnValueOnce(new Promise(() => {}))
    .mockRejectedValueOnce(Error("refresh failed"));
  const view = render(launch({ settingsRevision: "old" }));
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(1));
  view.rerender(launch({ settingsRevision: "new" }));
  await screen.findByRole("alert");
  expect(document.querySelector(".loading-state")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Повторить обновление каталога" }),
  );
  await screen.findByRole("textbox", { name: "Что нужно сделать?" });
  expect(document.querySelector(".loading-state")).toBeNull();
});
