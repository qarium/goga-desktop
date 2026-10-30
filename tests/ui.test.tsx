import { openCatalog, selectCatalog } from "./helpers/select-catalog";
import "./helpers/overview-browser-fixture";
// @vitest-environment jsdom
import {
  installPrototypeContextFixture,
  openPrototypeLaunch,
  openCurrentLaunch,
  executionButton,
} from "./helpers/prototype-context-fixture";
import React from "react";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
import { LaunchForm } from "../src/renderer/LaunchForm";
import { Settings } from "../src/renderer/Settings";
const project = {
  id: "p",
  name: "Actual project",
  path: "/tmp/actual-project",
};
const discovery = {
  pipelines: [
    {
      id: "tool:deploy",
      name: "Authored title",
      description: "Authored description",
      project: true,
    },
  ],
  topics: [
    {
      topic: "feature",
      branch: "feat/a",
      current: true,
      remote: false,
      todo: "old",
      statuses: [],
    },
  ],
  branches: ["main", "feat/a"],
  currentBranch: "feat/a",
  baseRef: "main",
  workflows: ["quality"],
  profiles: [{ name: "fast", source: "project" }],
};
const result = {
  token: "current-token",
  stages: [
    { id: "build", title: "Build it" },
    { id: "verify", title: "Verify it" },
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
    listProjects: vi.fn(async () => []),
    chooseProject: vi.fn(async () => project),
    discover: vi.fn(async () => discovery),
    readTopicTask: vi.fn(async () => ({
      text: "old",
      exists: true,
      version: "v",
      path: "fixture/todo.md",
    })),
    checkoutBranch: vi.fn(async () => discovery.currentBranch),
    preview: vi.fn(async () => result),
    launch: vi.fn(),
    runs: vi.fn(async () => []),
    onRuns: vi.fn(() => () => {}),
    onFocusRun: vi.fn(() => () => {}),
    onViewError: vi.fn(() => () => {}),
    selectRun: vi.fn(async () => {}),
    stopRun: vi.fn(),
    listSettings: vi.fn(async () => ({ profiles: ["personal"] })),
    readSettings: vi.fn(async () => ({
      text: "# Secret file\nenv: {}\n",
      version: "v",
    })),
    saveSettings: vi.fn(),
  };
  api.readProjectSettings ??= vi.fn(async () => ({
    value: { executable: "goga", profile: "", env: [] },
    version: "fixture-home",
    profiles: [],
  }));
  installPrototypeContextFixture(api, [
    { ...project, topic: "feature", branch: "feat/a" },
  ]);
  window.goga = api;
});
afterEach(cleanup);
describe("Desktop shell", () => {
  it("starts without fake projects and selects only a native-picked project", async () => {
    render(<App />);
    expect(await screen.findByText("Добавьте локальный проект")).toBeTruthy();
    expect(
      (screen.getByLabelText("Рабочая область") as HTMLSelectElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Добавить проект" }));
    expect(
      await screen.findByRole("heading", { name: "Actual project" }),
    ).toBeTruthy();
    expect(api.chooseProject).toHaveBeenCalledTimes(1);
  });
  it("keeps skipped cards and gates launch until the matching Goga preview arrives", async () => {
    render(
      <LaunchForm
        project={project}
        onLaunched={() => {}}
        onCancel={() => {}}
      />,
    );
    const checkbox = await screen.findByRole("checkbox", { name: /verify/ });
    let resolve: (v: any) => void = () => {};
    api.preview.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    fireEvent.click(checkbox);
    expect(screen.queryByRole("button", { name: "Запустить" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /verify/ })).toBeNull();
    expect(checkbox.isConnected).toBe(true);
    resolve({ ...result, stages: [result.stages[0]] });
    await waitFor(() =>
      expect(api.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ skips: ["verify"] }),
      ),
    );
    await waitFor(() =>
      expect((executionButton() as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(executionButton());
    await waitFor(() =>
      expect(api.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          previewToken: "current-token",
          skips: ["verify"],
        }),
      ),
    );
  });
  it("ignores a late preview response after changing workflow", async () => {
    let old: (v: any) => void = () => {};
    api.preview.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    );
    render(
      <LaunchForm
        project={project}
        onLaunched={() => {}}
        onCancel={() => {}}
      />,
    );
    await screen.findByLabelText("Рабочий процесс");
    await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(1));
    api.preview.mockResolvedValue({
      ...result,
      workflow: "quality",
      stages: [{ id: "quality-check", title: "Quality" }],
    });
    selectCatalog(screen.getByLabelText("Рабочий процесс"), "file:quality");
    await screen.findByRole("checkbox", { name: /quality-check/ });
    old(result);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("checkbox", { name: /build/ })).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: /quality-check/ }),
    ).toBeTruthy();
  });
  it("shows exactly two topic modes and one source selector for new work", async () => {
    render(
      <LaunchForm
        project={project}
        onLaunched={() => {}}
        onCancel={() => {}}
      />,
    );
    const mode = await screen.findByRole("radio", { name: "Создать новый" });
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    fireEvent.click(mode);
    expect(screen.getAllByLabelText("Исходная ветка")).toHaveLength(1);
    openCatalog(screen.getByRole("combobox", { name: "Исходная ветка" }));
    expect(screen.getAllByRole("option", { name: /текущая/ })[0]).toBeTruthy();
  });
  it("resets destructive confirmations and skip cards after confirmed form reset", async () => {
    api.discover.mockResolvedValue({
      ...discovery,
      topics: [
        ...discovery.topics,
        {
          ...discovery.topics[0],
          branch: "feat/b",
          topic: "B",
          current: false,
        },
      ],
    });
    render(
      <LaunchForm
        project={project}
        onLaunched={() => {}}
        onCancel={() => {}}
      />,
    );
    await screen.findByRole("checkbox", { name: /verify/ });
    fireEvent.click(screen.getByRole("combobox", { name: "Топик проекта" }));
    fireEvent.click(screen.getByRole("option", { name: /B.*feat\/b/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("Что нужно сделать?")).toHaveProperty(
        "value",
        "old",
      ),
    );
    fireEvent.change(screen.getByLabelText("Что нужно сделать?"), {
      target: { value: "TASK FOR B" },
    });
    api.preview.mockResolvedValue({ ...result, stages: [result.stages[0]] });
    fireEvent.click(screen.getByRole("checkbox", { name: /verify/ }));
    await waitFor(() =>
      expect(api.preview).toHaveBeenLastCalledWith(
        expect.objectContaining({ skips: ["verify"] }),
      ),
    );
    api.preview.mockResolvedValue({
      ...result,
      stages: [...result.stages, { id: "new-stage", title: "New" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    fireEvent.click(screen.getByRole("button", { name: "Сбросить изменения" }));
    await screen.findByRole("checkbox", { name: /new-stage/ });
    expect(
      screen.queryByRole("checkbox", { name: /Подтверждаю.*запуск/ }),
    ).toBeNull();
    expect(screen.queryByText(/Разрешаю заменить/)).toBeNull();
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ skips: [] }),
    );
  });
  it("does not read personal secrets until explicitly revealed", async () => {
    render(<Settings />);
    await screen.findByText("Общие настройки");
    expect(api.readSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Открыть редактор" }));
    await waitFor(() =>
      expect(
        document
          .querySelector(".yaml-code-editor")
          ?.shadowRoot?.querySelector('[aria-label="YAML"]'),
      ).toBeTruthy(),
    );
    expect(api.readSettings).toHaveBeenCalledWith("config", undefined);
  });
});

it.each([false, true])(
  "clean defaults off, changes no preview, and is passed only on explicit launch (%s)",
  async (selected) => {
    const onLaunched = vi.fn();
    render(
      <LaunchForm
        project={project}
        onLaunched={onLaunched}
        onCancel={() => {}}
      />,
    );
    const clean = (await screen.findByRole("checkbox", {
      name: "Начать с чистого состояния",
    })) as HTMLInputElement;
    await screen.findByRole("checkbox", { name: /verify/ });
    expect(clean.checked).toBe(false);
    expect(
      screen.getByText(
        /Сохранённое состояние этого конвейера будет удалено перед запуском/,
      ),
    ).toBeTruthy();
    const previews = api.preview.mock.calls.length;
    if (selected) fireEvent.click(clean);
    expect(api.preview).toHaveBeenCalledTimes(previews);
    expect(api.launch).not.toHaveBeenCalled();
    fireEvent.click(executionButton());
    await waitFor(() =>
      expect(api.launch).toHaveBeenCalledWith(
        expect.objectContaining({
          clean: selected,
          previewToken: "current-token",
          pipeline: "tool:deploy",
          topic: { mode: "existing", branch: "feat/a", topic: "feature" },
        }),
      ),
    );
    await waitFor(() => expect(clean.checked).toBe(false));
    expect(api.preview.mock.calls.every(([r]: any[]) => !("clean" in r))).toBe(
      true,
    );
  },
);
it("clean consent resets on project change and form remount", async () => {
  const props = { project, onLaunched: () => {}, onCancel: () => {} };
  const view = render(<LaunchForm {...props} />);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Начать с чистого состояния" }),
  );
  view.rerender(
    <LaunchForm {...props} project={{ ...project, id: "other" }} />,
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Начать с чистого состояния",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Начать с чистого состояния" }),
  );
  view.unmount();
  render(<LaunchForm {...props} />);
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: "Начать с чистого состояния",
      })) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(api.launch).not.toHaveBeenCalled();
});

async function tabsFixture() {
  const list = ["a", "b", "c"].map((id) => ({
    id,
    projectId: "p",
    pipeline: id,
    topic: "topic",
    branch: "main",
    status: "stopped",
    workflow: null,
    profile: null,
    startedAt: "now",
  }));
  api.listProjects.mockResolvedValue([project]);
  api.runs.mockResolvedValue(list);
  let publish!: (r: any[]) => void;
  api.onRuns.mockImplementation((cb: any) => {
    publish = cb;
    return () => {};
  });
  api.closeRun = vi.fn(async (id: string) => {
    publish(list.filter((r) => r.id !== id));
    return true;
  });
  let focusRun!: (id: string) => void;
  api.onFocusRun.mockImplementation((cb: typeof focusRun) => {
    focusRun = cb;
    return () => {};
  });
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  await screen.findByRole("heading", { name: "Проект" });
  act(() => {
    for (const item of list) focusRun(item.id);
  });
  act(() => focusRun("a"));
  await screen.findByRole("tab", { name: /^a ·/ });
  return { list, publish };
}
it("close buttons are separate accessible controls, select neighbour then empty state", async () => {
  const { list, publish } = await tabsFixture();
  fireEvent.click(screen.getByRole("tab", { name: /^b ·/ }));
  const close = screen.getByRole("button", {
    name: "Закрыть вкладку b · topic",
  });
  expect(close.closest("[role=tab]")).toBeNull();
  fireEvent.click(close);
  await waitFor(() =>
    expect(screen.queryByRole("tab", { name: /^b ·/ })).toBeNull(),
  );
  expect(
    screen.getByRole("tab", { name: /^c ·/ }).getAttribute("aria-selected"),
  ).toBe("true");
  api.closeRun.mockImplementation(async () => {
    publish([]);
    return true;
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть вкладку c · topic" }),
  );
  expect(await screen.findByRole("heading", { name: "Проект" })).toBeTruthy();
});
it("closing a nonselected tab preserves selection and an in-progress launch form", async () => {
  const { list, publish } = await tabsFixture();
  fireEvent.click(screen.getByRole("tab", { name: /^a ·/ }));
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть вкладку c · topic" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("tab", { name: /^c ·/ })).toBeNull(),
  );
  expect(
    screen.getByRole("tab", { name: /^a ·/ }).getAttribute("aria-selected"),
  ).toBe("true");
  await openCurrentLaunch();
  const draftEditor = (await screen.findByRole("textbox", {
    name: /Что нужно сделать/,
  })) as HTMLTextAreaElement;
  await waitFor(() => expect(draftEditor.disabled).toBe(false));
  fireEvent.change(draftEditor, { target: { value: "keep my draft" } });
  api.closeRun.mockImplementation(async () => {
    publish([list[0]]);
    return true;
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть вкладку b · topic" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("tab", { name: /^b ·/ })).toBeNull(),
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: /Что нужно сделать/,
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("keep my draft");
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Начать с чистого состояния",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
});
it("cancel/failure keep tab and pending clicks do not issue duplicate requests", async () => {
  await tabsFixture();
  let resolve!: (v: boolean) => void;
  api.closeRun.mockImplementation(() => new Promise((r) => (resolve = r)));
  const close = screen.getByRole("button", {
    name: "Закрыть вкладку a · topic",
  });
  fireEvent.click(close);
  fireEvent.click(close);
  expect(api.closeRun).toHaveBeenCalledTimes(1);
  resolve(false);
  await waitFor(() =>
    expect((close as HTMLButtonElement).disabled).toBe(false),
  );
  expect(screen.getByRole("tab", { name: /^a ·/ })).toBeTruthy();
  api.closeRun.mockRejectedValueOnce(Error("Stop failed"));
  fireEvent.click(close);

  expect(await screen.findByText("Stop failed")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /^a ·/ })).toBeTruthy();
});

it("tab arrows/home/end remain keyboard accessible", async () => {
  await tabsFixture();
  const a = screen.getByRole("tab", { name: /^a ·/ });
  a.focus();
  fireEvent.keyDown(a, { key: "ArrowRight" });
  expect(
    screen.getByRole("tab", { name: /^b ·/ }).getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.keyDown(screen.getByRole("tab", { name: /^b ·/ }), { key: "End" });
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: /^c ·/ }),
  );
  fireEvent.keyDown(screen.getByRole("tab", { name: /^c ·/ }), { key: "Home" });
  expect(document.activeElement).toBe(a);
});

it("returns keyboard focus to the selected neighbour after closing a focused control", async () => {
  await tabsFixture();
  fireEvent.click(screen.getByRole("tab", { name: /^b ·/ }));
  const close = screen.getByRole("button", {
    name: "Закрыть вкладку b · topic",
  });
  close.focus();
  fireEvent.click(close);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: /^c ·/ }),
    ),
  );
});

it("restores focus after an asynchronous close even if disabling the close button blurs it", async () => {
  const { list, publish } = await tabsFixture();
  let resolve!: (v: boolean) => void;
  api.closeRun.mockImplementation(() => new Promise((r) => (resolve = r)));
  fireEvent.click(screen.getByRole("tab", { name: /^b ·/ }));
  const close = screen.getByRole("button", {
    name: "Закрыть вкладку b · topic",
  });
  close.focus();
  fireEvent.click(close);
  expect((close as HTMLButtonElement).disabled).toBe(true);
  document.body.tabIndex = -1;
  document.body.focus(); // Model Chromium blurring a newly disabled control.
  expect(document.activeElement).toBe(document.body);
  await act(async () => {
    publish(list.filter((r) => r.id !== "b"));
    resolve(true);
  });
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: /^c ·/ }),
  );
});

it("does not steal focus moved by the user while close is pending", async () => {
  const { list, publish } = await tabsFixture();
  let resolve!: (v: boolean) => void;
  api.closeRun.mockImplementation(() => new Promise((r) => (resolve = r)));
  const close = screen.getByRole("button", {
    name: "Закрыть вкладку b · topic",
  });
  close.focus();
  fireEvent.click(close);
  const launch = screen.getByRole("button", { name: "Запустить" });
  launch.focus();
  await act(async () => {
    publish(list.filter((r) => r.id !== "b"));
    resolve(true);
  });
  expect(document.activeElement).toBe(launch);
});

it("shows package version and short copyright without obsolete shell labels", async () => {
  const { version } = await import("../package.json");
  render(<App />);
  expect(await screen.findByText(`v${version}`)).toBeTruthy();
  expect(screen.getByText("© Goga 2026")).toBeTruthy();
  expect(
    screen.queryByText(/Локальная разработка|Ваш код остаётся/),
  ).toBeNull();
});
it("uses actual checkout branch instead of a stale topic.current marker", async () => {
  api.discover.mockResolvedValue({ ...discovery, currentBranch: "main" });
  api.checkoutBranch = vi.fn(async () => "main");
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  expect(
    await screen.findByLabelText("Текущая ветка checkout: main"),
  ).toBeTruthy();
  expect(screen.getByText("Переключение: main → feat/a")).toBeTruthy();
  expect(
    screen.queryByRole("checkbox", { name: /Подтверждаю переключение/ }),
  ).toBeNull();
});
it("current topic launches without general checkbox or imaginary branch switching", async () => {
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  expect(await screen.findByText("Переключение не требуется")).toBeTruthy();
  await screen.findByRole("combobox", { name: "Топик проекта" });
  expect(
    screen.queryByRole("checkbox", { name: /Подтверждаю переключение/ }),
  ).toBeNull();
  await waitFor(() =>
    expect(executionButton()).toHaveProperty("disabled", false),
  );
  fireEvent.click(executionButton());
  await waitFor(() =>
    expect(api.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBranch: "feat/a",
        confirmBranchSwitch: false,
      }),
    ),
  );
});
it.each(["HEAD", "main", "feat/a"])(
  "new topic from %s still warns about a new branch and switch",
  async (base) => {
    render(
      <LaunchForm
        project={project}
        onCancel={() => {}}
        onLaunched={() => {}}
      />,
    );
    fireEvent.click(
      await screen.findByRole("radio", { name: "Создать новый" }),
    );
    fireEvent.change(screen.getByLabelText("Имя нового топика"), {
      target: { value: "new/work" },
    });
    selectCatalog(screen.getByLabelText("Исходная ветка"), base);
    expect(
      screen.getByText(
        `Создадим «new/work» от ${base === "HEAD" ? "feat/a" : base} и перейдём в ветку топика при запуске.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Переключение не требуется")).toBeNull();
  },
);
it("stale checkout before launch updates context and revokes consent without launching", async () => {
  api.checkoutBranch = vi.fn(async () => "main");
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  await screen.findByRole("checkbox", { name: /verify/ });
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Начать с чистого состояния" }),
  );
  fireEvent.click(executionButton());
  expect(
    await screen.findByLabelText("Текущая ветка checkout: main"),
  ).toBeTruthy();
  expect(api.launch).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("checkbox", { name: /Подтверждаю.*запуск/ }),
  ).toBeNull();
  await screen.findByRole("checkbox", { name: "Начать с чистого состояния" });
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Начать с чистого состояния",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
});

it("refreshes actual branch on window focus and revokes previous consent", async () => {
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  await screen.findByRole("checkbox", { name: /verify/ });
  api.checkoutBranch.mockResolvedValue("external");
  fireEvent.focus(window);
  expect(
    await screen.findByLabelText("Текущая ветка checkout: external"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("checkbox", { name: /Подтверждаю.*запуск/ }),
  ).toBeNull();
  expect(api.launch).not.toHaveBeenCalled();
});
it("selects topic matching checkout rather than first or stale current flag", async () => {
  api.discover.mockResolvedValue({
    ...discovery,
    currentBranch: "main",
    topics: [
      ...discovery.topics,
      { ...discovery.topics[0], topic: "main", branch: "main", current: false },
    ],
  });
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  expect(await screen.findByText("Переключение не требуется")).toBeTruthy();
  await screen.findByRole("combobox", { name: "Топик проекта" });
  expect(
    screen.getByRole("combobox", { name: "Топик проекта" }).textContent,
  ).toContain("main");
});

it("branch refresh resets skipped cards and shows all stages from the new checkout", async () => {
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  await screen.findByRole("checkbox", { name: /verify/ });
  api.preview.mockResolvedValue({ ...result, stages: [result.stages[1]] });
  fireEvent.click(screen.getByRole("checkbox", { name: /build/ }));
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({ skips: ["build"] }),
    ),
  );
  api.preview.mockResolvedValue({
    ...result,
    stages: [...result.stages, { id: "deploy", title: "New checkout stage" }],
  });
  api.checkoutBranch.mockResolvedValue("external");
  fireEvent.focus(window);
  expect(await screen.findByRole("checkbox", { name: /deploy/ })).toBeTruthy();
  expect(api.preview).toHaveBeenLastCalledWith(
    expect.objectContaining({ skips: [] }),
  );
  expect(
    (screen.getByRole("checkbox", { name: /build/ }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

it("does not invalidate fresh preview when the catch branch reread repeats the same new branch", async () => {
  let reread!: (value: string) => void;
  api.checkoutBranch
    .mockResolvedValueOnce("main")
    .mockImplementationOnce(() => new Promise((resolve) => (reread = resolve)));
  render(
    <LaunchForm project={project} onCancel={() => {}} onLaunched={() => {}} />,
  );
  await screen.findByRole("checkbox", { name: /verify/ });
  fireEvent.click(executionButton());
  await waitFor(() => expect(api.preview).toHaveBeenCalledTimes(2));
  await screen.findByText("Переключение: main → feat/a");
  await act(async () => reread("main"));
  await waitFor(() =>
    expect((executionButton() as HTMLButtonElement).disabled).toBe(false),
  );
});

it("localizes owned controls, shows pipeline id and preserves workflow names and descriptions", async () => {
  api.discover.mockResolvedValue({
    ...discovery,
    pipelines: [
      {
        id: "tool:pipeline",
        name: "Workflow Pipeline",
        description: "workflow пайплайн authored",
        project: true,
      },
    ],
    workflows: ["workflow-original"],
  });
  render(
    <LaunchForm project={project} onLaunched={() => {}} onCancel={() => {}} />,
  );
  const pipeline = await screen.findByRole("combobox", { name: "Конвейер" });
  expect(
    screen.getByRole("heading", { name: "Запустить конвейер" }),
  ).toBeTruthy();
  expect(screen.getByText("workflow пайплайн authored")).toBeTruthy();
  expect(pipeline.textContent).toContain("tool:pipeline · проектный");
  expect((pipeline as HTMLButtonElement).value).toBe("tool:pipeline");
  const workflow = screen.getByLabelText("Рабочий процесс");
  fireEvent.click(workflow);
  expect(
    screen.getByRole("option", { name: "workflow-original" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("option", { name: "Без рабочего процесса" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("option", { name: "workflow-original" }));
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pipeline: "tool:pipeline",
        workflow: "file:workflow-original",
      }),
    ),
  );
});

it("searches shared pipeline catalogs while keeping decorated labels separate from request values", async () => {
  api.discover.mockResolvedValue({
    ...discovery,
    projectSettings: { profile: "fast", env: [] },
    pipelines: [
      ...discovery.pipelines,
      { id: "tool:quality", name: "Quality", description: "", project: true },
    ],
  });
  render(
    <LaunchForm project={project} onLaunched={() => {}} onCancel={() => {}} />,
  );
  const pipeline = await screen.findByRole("combobox", { name: "Конвейер" });
  expect(pipeline.tagName).toBe("BUTTON");
  fireEvent.click(pipeline);
  fireEvent.change(screen.getByRole("searchbox", { name: "Поиск конвейера" }), {
    target: { value: "quality" },
  });
  fireEvent.click(
    screen.getByRole("option", { name: "tool:quality · проектный" }),
  );
  fireEvent.click(
    await screen.findByRole("combobox", { name: "Рабочий процесс" }),
  );
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Поиск рабочего процесса" }),
    { target: { value: "quality" } },
  );
  fireEvent.click(screen.getByRole("option", { name: "quality" }));
  fireEvent.click(await screen.findByRole("combobox", { name: "Профиль" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Поиск профиля" }), {
    target: { value: "личный" },
  });
  expect(screen.queryByRole("option")).toBeNull();
  fireEvent.change(screen.getByRole("searchbox", { name: "Поиск профиля" }), {
    target: { value: "проектный" },
  });
  fireEvent.click(screen.getByRole("option", { name: "fast · проектный" }));
  await waitFor(() =>
    expect(api.preview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pipeline: "tool:quality",
        workflow: "file:quality",
        profile: "fast",
      }),
    ),
  );
  fireEvent.click(screen.getByRole("radio", { name: "Создать новый" }));
  fireEvent.change(screen.getByLabelText("Имя нового топика"), {
    target: { value: "picker-topic" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Исходная ветка" }));
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Поиск исходной ветки" }),
    { target: { value: "базовая" } },
  );
  fireEvent.click(screen.getByRole("option", { name: "main — базовая" }));
  expect(
    (
      screen.getByRole("combobox", {
        name: "Исходная ветка",
      }) as HTMLButtonElement
    ).value,
  ).toBe("main");
  await waitFor(() =>
    expect((executionButton() as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(executionButton());
  expect(api.launch).not.toHaveBeenCalled();
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать и запустить" }),
  );
  await waitFor(() => expect(api.launch).toHaveBeenCalledTimes(1));
  expect(api.launch.mock.calls[0][0]).toMatchObject({
    pipeline: "tool:quality",
    workflow: "file:quality",
    profile: "fast",
    topic: { mode: "new", name: "picker-topic", baseRef: "main" },
  });
});

it.each([
  ["Конвейер", "tool:deploy"],
  ["Рабочий процесс", "auto"],
  ["Профиль", ""],
])(
  "reselecting the current %s preserves the ready launch preview",
  async (label, value) => {
    render(
      <LaunchForm
        project={project}
        onLaunched={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() =>
      expect((executionButton() as HTMLButtonElement).disabled).toBe(false),
    );
    const previews = api.preview.mock.calls.length;
    selectCatalog(screen.getByRole("combobox", { name: label }), value);
    expect((executionButton() as HTMLButtonElement).disabled).toBe(false);
    expect(api.preview).toHaveBeenCalledTimes(previews);
    fireEvent.click(executionButton());
    await waitFor(() =>
      expect(api.launch).toHaveBeenCalledWith(
        expect.objectContaining({ previewToken: "current-token" }),
      ),
    );
  },
);
