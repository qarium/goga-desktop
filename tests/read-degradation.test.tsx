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
import { readRequest } from "../src/renderer/read-request";
import { READ_BUDGETS, type ReadMethod } from "../src/shared/read-deadlines";
import { ProjectSettings } from "../src/renderer/ProjectSettings";
import { Settings } from "../src/renderer/Settings";
import { ProjectDocuments } from "../src/renderer/ProjectDocuments";
import { TopicCard } from "../src/renderer/TopicCard";
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
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

const advance = async (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const noLoader = () =>
  expect(document.querySelector(".loading-state")).toBeNull();
it.each(["buildContext", "readBuildPlan"])(
  "Build %s never-response ends and retries without a missing-plan lie",
  async (method) => {
    vi.useFakeTimers();
    api[method].mockReturnValueOnce(new Promise(() => {}));
    render(build());
    await advance(200);
    await advance(method === "buildContext" ? 300001 : 30001);
    noLoader();
    expect(
      screen.queryByText("План не найден. Выберите файл плана"),
    ).toBeNull();
    if (method === "buildContext")
      fireEvent.click(
        screen.getByRole("button", { name: "Повторить загрузку" }),
      );
    else
      fireEvent.click(screen.getByRole("button", { name: "Обновить данные" }));
    await advance(200);
    noLoader();
    expect(screen.getByRole("textbox", { name: "План сборки" })).toBeTruthy();
  },
);
it.each(["discover", "preview", "readTopicTask"])(
  "Launch %s times out and a fresh retry reaches the full form",
  async (method) => {
    vi.useFakeTimers();
    const old = deferred();
    api[method].mockReturnValueOnce(old.promise);
    render(launch());
    await advance(1);
    await advance(300001);
    noLoader();
    expect(screen.getByRole("alert").textContent).toContain(
      "Превышено время ожидания",
    );
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
    await advance(1);
    noLoader();
    const task = screen.getByRole("textbox", {
      name: "Что нужно сделать?",
    }) as HTMLTextAreaElement;
    expect(task.value).toBe("task");
    await flush(
      old,
      method === "discover"
        ? { ...catalog, pipelines: [] }
        : method === "preview"
          ? { ...preview, stages: [] }
          : { text: "stale", exists: true, version: "stale" },
    );
    expect(task.value).toBe("task");
    noLoader();
  },
);
it("Topics timeout preserves filters, allows retry, and rejects old late errors", async () => {
  vi.useFakeTimers();
  render(
    <TopicsWorkspace
      project={project}
      store={createTopicsStore()}
      onOpenTopic={() => {}}
      onChanged={() => {}}
    />,
  );
  await advance(1);
  const input = screen.getByRole("searchbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "draft filter" } });
  const old = deferred();
  api.readTopicBoard.mockReturnValueOnce(old.promise);
  fireEvent.click(screen.getByRole("button", { name: "Обновить список" }));
  await advance(300001);
  noLoader();
  expect(screen.getByRole("alert").textContent).toContain(
    "Превышено время ожидания",
  );
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await advance(1);
  expect(screen.getByRole("searchbox")).toBe(input);
  expect(input.value).toBe("draft filter");
  await act(async () => old.reject(Error("late error")));
  expect(screen.queryByText("late error")).toBeNull();
});
it.each(["workflow", "pipeline", "profile"] as const)(
  "%s catalog no-response is error, not empty success; retry recovers",
  async (kind) => {
    vi.useFakeTimers();
    const method =
      kind === "workflow"
        ? "listProjectWorkflows"
        : kind === "pipeline"
          ? "listProjectPipelines"
          : "listProjectProfiles";
    api[method] = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue([]);
    render(
      <ProjectFlatDocuments
        kind={kind}
        project={project}
        store={createSettingsDocuments()}
      />,
    );
    await advance(30001);
    noLoader();
    expect(screen.getByRole("alert").textContent).toContain(
      "Превышено время ожидания",
    );
    expect(
      screen.queryByRole("heading", { name: /В проекте пока нет/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
    await advance(1);
    expect(
      screen.getByRole("heading", { name: /В проекте пока нет/ }),
    ).toBeTruthy();
  },
);
it.each(["project", "home"])(
  "%s document no-response clears busy and can be read again",
  async (scope) => {
    vi.useFakeTimers();
    const store = createSettingsDocuments(),
      source: any =
        scope === "project"
          ? { scope, projectId: "p", target: { kind: "config" } }
          : { scope, kind: "config" };
    const method = scope === "project" ? "readProjectDocument" : "readSettings";
    api[method] = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ text: "fresh", version: "v" });
    void store.open(source);
    await advance(30001);
    expect(store.get(source).busy).toBe(false);
    expect(store.get(source).error).toContain("Превышено время ожидания");
    await act(async () => store.open(source));
    expect(store.get(source).text).toBe("fresh");
    expect(store.get(source).error).toBe("");
  },
);
it("pre-delete read timeout clears preparing/busy without deleting anything", async () => {
  vi.useFakeTimers();
  const store = createSettingsDocuments(),
    source: any = { scope: "home", kind: "profile", name: "one" };
  api.prepareDocumentDeletion = vi
    .fn()
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValue({ token: "fresh" });
  void store.prepareDeletion(source);
  await advance(300001);
  expect(store.get(source).busy).toBe(false);
  expect(store.get(source).error).toContain("Превышено время ожидания");
  await act(async () => store.prepareDeletion(source));
  expect(store.get(source).deletion?.ticket.token).toBe("fresh");
});

it.each(Object.entries(READ_BUDGETS))(
  "read policy %s settles a completely silent transport and can retry",
  async (method, budget) => {
    vi.useFakeTimers();
    api[method] = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue("fresh");
    let error = "";
    void (readRequest as any)(method).catch((e: Error) => (error = e.message));
    await advance(budget + 1);
    expect(error).toContain("Превышено время ожидания");
    expect(await (readRequest as any)(method)).toBe("fresh");
  },
);
it("Home settings no-response ends with retry rather than a permanent loader", async () => {
  vi.useFakeTimers();
  api.readProjectSettings = vi
    .fn()
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValue({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    });
  render(
    <ProjectSettings
      project={project}
      guard={{ current: null }}
      onBusy={() => {}}
      onSaved={() => {}}
      onBack={() => {}}
    />,
  );
  await advance(30001);
  noLoader();
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await advance(1);
  expect(
    screen.getByRole("textbox", { name: "Исполняемый файл" }),
  ).toBeTruthy();
});
it("global profiles do not wait forever or block the config tab", async () => {
  vi.useFakeTimers();
  api.listSettings = vi
    .fn()
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValue({ profiles: [] });
  render(<Settings />);
  fireEvent.click(screen.getByRole("button", { name: "Профили" }));
  await advance(30001);
  noLoader();
  expect(screen.getByRole("alert").textContent).toContain(
    "Превышено время ожидания",
  );
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await advance(1);
  expect(screen.getByRole("button", { name: "＋ Новый профиль" })).toBeTruthy();
});
it("tools catalog times out with retry and no false empty success", async () => {
  vi.useFakeTimers();
  api.listProjectTools = vi
    .fn()
    .mockReturnValueOnce(new Promise(() => {}))
    .mockResolvedValue([]);
  render(
    <ProjectDocuments
      project={project}
      tab="tools"
      store={createSettingsDocuments()}
    />,
  );
  await advance(30001);
  noLoader();
  expect(screen.getByRole("alert").textContent).toContain(
    "Превышено время ожидания",
  );
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await advance(1);
  noLoader();
});
it("topic card stops waiting on a silent details read and keeps safe close/retry", async () => {
  vi.useFakeTimers();
  api.readTopicDetails = vi.fn().mockReturnValueOnce(new Promise(() => {}));
  render(
    <TopicCard
      project={project}
      year="2026"
      target={{ topic: "main", branch: "main", remote: false }}
      board={board}
      context={{ kind: "current" }}
      store={createTopicsStore()}
      onClose={() => {}}
      onChanged={() => {}}
      onPrepare={() => {}}
    />,
  );
  await advance(300001);
  noLoader();
  expect(screen.getByRole("alert").textContent).toContain(
    "Превышено время ожидания",
  );
  expect(screen.getByRole("button", { name: "Закрыть карточку" })).toBeTruthy();
});
it("retry after a failed dependency replaces the still-pending task read instead of waiting on it", async () => {
  vi.useFakeTimers();
  const old = deferred();
  api.preview.mockRejectedValueOnce(Error("preview failed early"));
  api.readTopicTask.mockReturnValueOnce(old.promise);
  render(launch());
  await advance(1);
  noLoader();
  expect(screen.getByRole("alert").textContent).toBe("preview failed early");
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await advance(1);
  noLoader();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Что нужно сделать?",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("task");
  await flush(old, { text: "stale", exists: true, version: "stale" });
  expect(screen.queryByDisplayValue("stale")).toBeNull();
});
