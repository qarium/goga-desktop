// @vitest-environment jsdom
import "./helpers/overview-browser-fixture";
import React from "react";
import { EditorView } from "@codemirror/view";
import { openCurrentLaunch } from "./helpers/prototype-context-fixture";
import { it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import { App } from "../src/renderer/App";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});
const project = { id: "p", name: "Synthetic", path: "/fixture/p" };
const ref = {
  projectId: "p",
  year: "2026",
  topic: "design",
  branch: "design",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const row = {
  ...ref,
  projectPath: project.path,
  gitCommonDir: "/git",
  path: "/fixture/clone",
  repositoryKey: "b".repeat(64),
  state: "ready",
  ownership: "managed",
  storageKind: "clone",
};
it.each([
  { closeFirst: false, fail: false },
  { closeFirst: true, fail: false },
  { closeFirst: true, fail: true },
])(
  "a group dialog supersedes a pending Home shortcut, even after dismissal ($closeFirst, rejected $fail)",
  async ({ closeFirst, fail }) => {
    let finish!: (v: typeof row) => void, reject!: (error: Error) => void;
    const pending = new Promise<typeof row>((yes, no) => {
      finish = yes;
      reject = no;
    });
    const resolveTopicContext = vi.fn(() => pending),
      listTopicContexts = vi.fn(async () => []);
    localStorage.setItem(
      "goga.desktop.homeVisits.v1",
      JSON.stringify({
        schemaVersion: 1,
        visits: [
          {
            projectId: "p",
            visitedAt: 1,
            target: { kind: "changes", owner: { kind: "topic", ref } },
          },
        ],
      }),
    );
    window.goga = {
      listProjects: async () => [project],
      runs: async () => [],
      onRuns: () => () => {},
      onFocusRun: () => () => {},
      onViewError: () => () => {},
      selectRun: async () => {},
      resolveTopicContext,
      listTopicContexts,
    } as any;
    render(<App />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Продолжить Synthetic · design · Изменения",
      }),
    );
    expect(resolveTopicContext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Создать группу" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Создать группу",
    });
    if (closeFirst)
      fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    await act(async () => {
      if (fail) reject(Error("Не удалось проверить рабочую копию"));
      else finish(row);
    });
    expect(screen.queryByRole("heading", { name: "Главная" })).not.toBeNull();
    expect(
      screen.queryByRole("dialog", { name: "Создать группу" }) !== null,
    ).toBe(!closeFirst);
    expect(screen.queryByText(/Не удалось проверить рабочую копию/)).toBeNull();
    expect(listTopicContexts).not.toHaveBeenCalled();
  },
);

async function withDirtyOverview() {
  const paths = ["a.txt", "b.txt"];
  const disk = new Map(paths.map((path) => [path, "disk:" + path]));
  const api = {
    listProjects: async () => [project],
    runs: async () => [],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    readOverviewSchema: async () => [],
    listOverviewDirectory: async () => ({
      entries: [],
      truncated: false,
      path: "",
    }),
    searchOverviewFiles: async () => ({
      entries: paths.map((path) => ({ path, name: path, kind: "file" })),
      truncated: false,
    }),
    readOverviewFile: async (_owner: string, path: string) => ({
      relativePath: path,
      exists: true,
      text: disk.get(path),
      version: disk.get(path),
    }),
    saveOverviewFile: vi.fn(
      async (_owner: string, path: string, text: string) => {
        disk.set(path, text);
        return { relativePath: path, exists: true, text, version: text };
      },
    ),
    discover: vi.fn(async () => ({
      pipelines: [],
      topics: [],
      currentBranch: "main",
      branches: ["main"],
      workflows: [],
      profiles: [],
    })),
    readTopicCatalog: vi.fn(async () => ({
      projectId: project.id,
      year: "2026",
      entries: [{ topic: "design", branch: "design", remote: false }],
      currentTopic: null,
    })),
    readTopicBoard: vi.fn(async () => ({
      projectId: project.id,
      year: "2026",
      baseRef: "main",
      entries: [],
    })),
    createTopicContext: vi.fn(async ({ branch }: { branch: string }) => ({
      ...row,
      topic: branch,
      branch,
    })),
    ensureTopicContext: vi.fn(async () => row),
    resolveTopicContext: vi.fn(async (target: typeof ref) => ({
      ...row,
      ...target,
    })),
    readTopicTask: vi.fn(async () => ({
      text: "",
      exists: false,
      version: "missing",
      path: "task.md",
    })),
    listTopicContexts: vi.fn(async () => []),
  };
  window.goga = api as never;
  render(<App />);
  fireEvent.click(
    await within(screen.getByRole("complementary")).findByRole("button", {
      name: "Synthetic",
    }),
  );
  const search = await screen.findByRole("textbox", { name: "Поиск файлов" });
  fireEvent.change(search, { target: { value: ".txt" } });
  const buffer = () => {
    const content = document
      .querySelector(".yaml-code-editor")
      ?.shadowRoot?.querySelector<HTMLElement>(".cm-content");
    return content ? EditorView.findFromDOM(content) : null;
  };
  for (const path of paths) {
    fireEvent.click(
      await screen.findByRole("button", {
        name: (name) => name.startsWith(path),
      }),
    );
    const v = await waitFor(() => {
      const editor = buffer();
      expect(editor?.state.doc.toString()).toBe(disk.get(path));
      return editor!;
    });
    act(() =>
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: "draft:" + path },
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  return { api, disk, buffer };
}

it("asks before preparing a run with multiple dirty Overview files, keeps skipped drafts, and saves them all on the next launch", async () => {
  const { api, disk, buffer } = await withDirtyOverview();
  await openCurrentLaunch();
  const reminder = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  for (const path of ["a.txt", "b.txt"])
    expect(reminder.textContent).toContain(path);
  expect(api.discover).not.toHaveBeenCalled();
  fireEvent.click(
    within(reminder).getByRole("button", { name: "Без сохранения" }),
  );
  await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(1));
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
  expect(disk.get("a.txt")).toBe("disk:a.txt");
  fireEvent.click(screen.getByRole("button", { name: "Обзор" }));
  await waitFor(() =>
    expect(buffer()?.state.doc.toString()).toBe("draft:b.txt"),
  );
  await openCurrentLaunch();
  const next = await screen.findByRole("dialog", { name: "Сохранить правки?" });
  fireEvent.click(
    within(next).getByRole("button", { name: "Сохранить и продолжить" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "Сохранить правки?" }),
    ).toBeNull(),
  );
  expect(api.saveOverviewFile.mock.calls).toEqual([
    ["p", "a.txt", "draft:a.txt", "disk:a.txt"],
    ["p", "b.txt", "draft:b.txt", "disk:b.txt"],
  ]);
  expect(disk.get("b.txt")).toBe("draft:b.txt");
});

it("staying in Overview cancels quick topic creation before any write or launch preparation", async () => {
  const { api, buffer } = await withDirtyOverview();
  fireEvent.click(
    await screen.findByRole("button", { name: "Выбрать другой топик" }),
  );
  fireEvent.change(
    await screen.findByRole("combobox", { name: "Найти топик" }),
    { target: { value: "fresh" } },
  );
  const create = await screen.findByRole("button", {
    name: "Создать «fresh» и подготовить конвейер",
  });
  expect(create.hasAttribute("disabled")).toBe(false);
  fireEvent.click(create);
  const reminder = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  expect(api.createTopicContext).not.toHaveBeenCalled();
  fireEvent.click(within(reminder).getByRole("button", { name: "Остаться" }));
  expect(buffer()?.state.doc.toString()).toBe("draft:b.txt");
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
  expect(api.createTopicContext).not.toHaveBeenCalled();
  expect(api.discover).not.toHaveBeenCalled();
});

it("checks every Overview file before writing; an external change keeps the launch and opt-in pending", async () => {
  const { api, disk, buffer } = await withDirtyOverview();
  disk.set("a.txt", "someone else");
  await openCurrentLaunch();
  const reminder = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  fireEvent.click(
    within(reminder).getByRole("checkbox", { name: /Больше не спрашивать/ }),
  );
  fireEvent.click(
    within(reminder).getByRole("button", { name: "Сохранить и продолжить" }),
  );
  const conflict = await screen.findByRole("dialog", {
    name: "Переход приостановлен",
  });
  expect(within(conflict).getByRole("alert").textContent).toMatch(
    /изменился на диске/,
  );
  expect(api.discover).not.toHaveBeenCalled();
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
  fireEvent.click(within(conflict).getByRole("button", { name: "К файлу" }));
  await waitFor(() =>
    expect(buffer()?.state.doc.toString()).toBe("draft:a.txt"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  const again = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  expect(
    (within(again).getByRole("checkbox") as HTMLInputElement).checked,
  ).toBe(false);
  expect(disk.get("a.txt")).toBe("someone else");
});
it("asks before ensuring a local clone for a catalog-only topic", async () => {
  const { api } = await withDirtyOverview();
  fireEvent.click(
    await screen.findByRole("button", { name: "Выбрать другой топик" }),
  );
  fireEvent.click(await screen.findByRole("row", { name: /design/ }));
  const reminder = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  expect(api.ensureTopicContext).not.toHaveBeenCalled();
  fireEvent.click(
    within(reminder).getByRole("button", { name: "Без сохранения" }),
  );
  await waitFor(() => expect(api.ensureTopicContext).toHaveBeenCalledTimes(1));
  await screen.findByRole("button", { name: /Открыть карточку топика design/ });
  expect(
    screen.queryByRole("dialog", { name: "Сохранить правки?" }),
  ).toBeNull();
});
it("skips saving once for both quick creation and entering the resulting launch form", async () => {
  const { api } = await withDirtyOverview();
  fireEvent.click(
    await screen.findByRole("button", { name: "Выбрать другой топик" }),
  );
  fireEvent.change(
    await screen.findByRole("combobox", { name: "Найти топик" }),
    { target: { value: "fresh" } },
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Создать «fresh» и подготовить конвейер",
    }),
  );
  const reminder = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  fireEvent.click(
    within(reminder).getByRole("button", { name: "Без сохранения" }),
  );
  await waitFor(() => expect(api.createTopicContext).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(api.discover).toHaveBeenCalled());
  expect(
    screen.queryByRole("dialog", { name: "Сохранить правки?" }),
  ).toBeNull();
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
});

it("a delayed clone preparation does not reuse consent for newer Overview text", async () => {
  const { api, buffer } = await withDirtyOverview();
  let finish!: () => void;
  api.ensureTopicContext.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return row;
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Выбрать другой топик" }),
  );
  fireEvent.click(await screen.findByRole("row", { name: /design/ }));
  const first = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  fireEvent.click(
    within(first).getByRole("button", { name: "Без сохранения" }),
  );
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  const editor = buffer()!;
  act(() =>
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: "newer" },
    }),
  );
  await act(async () => {
    finish();
  });
  const second = await screen.findByRole("dialog", {
    name: "Сохранить правки?",
  });
  fireEvent.click(within(second).getByRole("button", { name: "Остаться" }));
  expect(api.ensureTopicContext).toHaveBeenCalledTimes(1);
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
  expect(buffer()?.state.doc.toString()).toBe("newer");
  expect(
    screen.queryByRole("button", { name: /Открыть карточку топика design/ }),
  ).toBeNull();
});
