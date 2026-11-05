// @vitest-environment jsdom
import "./helpers/overview-browser-fixture";
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { ProjectDocuments } from "../src/renderer/ProjectDocuments";
import { RetainedViews } from "../src/renderer/RetainedViews";
import {
  createSettingsDocuments,
  documentKey,
  type DocumentSource,
} from "../src/renderer/settings-documents";
import type { TopicContextRef } from "../src/shared/worktrees";
import type { ProjectTool } from "../src/shared/project-documents";
const project = { id: "p", name: "Fixture", path: "/fixture/p" };
const catalog: ProjectTool[] = [
  {
    name: "review",
    entries: [
      { path: "env", kind: "directory", editable: false },
      { path: "env/old.yml", kind: "file", editable: true },
      { path: "Folder.yml", kind: "directory", editable: false },
      { path: "café.yml", kind: "file", editable: true },
      { path: "blocked", kind: "directory", editable: false, reason: "Ссылка" },
    ],
  },
  { name: "empty", entries: [] },
];
let store: ReturnType<typeof createSettingsDocuments>;
let api: any;
const source = (
  path = "new.yaml",
  tool = "review",
  context?: TopicContextRef,
): DocumentSource => ({
  scope: "project",
  projectId: context?.projectId ?? "p",
  ...(context ? { context } : {}),
  target: { kind: "tool", tool, path },
});
const owner = (patch: Partial<TopicContextRef> = {}): TopicContextRef => ({
  projectId: "p",
  year: "2026",
  topic: "same",
  branch: "main",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
  ...patch,
});
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const editor = () => {
  const element = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector('[role="textbox"]');
  return element ? EditorView.findFromDOM(element as HTMLElement)! : null;
};
async function create(path = "new.yaml") {
  click("Создать файл");
  fireEvent.change(screen.getByRole("textbox", { name: "Имя файла" }), {
    target: { value: path },
  });
  click("Создать черновик");
  await waitFor(() => expect(editor()).not.toBeNull());
}
async function mount(context?: TopicContextRef) {
  const view = render(
    <ProjectDocuments
      project={project}
      owner={context}
      tab="tools"
      store={store}
    />,
  );
  await screen.findByRole("combobox", { name: "Инструмент" });
  return view;
}
beforeEach(() => {
  store = createSettingsDocuments();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjectTools: vi.fn(async () => catalog),
    readProjectDocument: vi.fn(async (_scope: any, target: any) => ({
      text: "old: true\n",
      exists: true,
      version: "v1",
      relativePath: `.goga/tools/${target.tool}/${target.path}`,
    })),
    saveProjectDocument: vi.fn(
      async (_scope: any, target: any, text: string) => ({
        text,
        exists: true,
        version: "v2",
        relativePath: `.goga/tools/${target.tool}/${target.path}`,
      }),
    ),
    prepareDocumentDeletion: vi.fn(),
    deleteDocument: vi.fn(),
    readSettings: vi.fn(),
    saveSettings: vi.fn(),
  };
  window.goga = api;
});
afterEach(cleanup);
it.each(["review", "empty"])(
  "creates a blank memory-only YAML draft in %s and only Save writes exact source",
  async (tool) => {
    await mount();
    fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
      target: { value: tool },
    });
    await create();
    expect(editor()!.state.doc.toString()).toBe("");
    expect(store.get(source("new.yaml", tool))).toMatchObject({
      memoryOnly: true,
      text: "",
      document: {
        text: "",
        exists: false,
        version: "missing",
        relativePath: `.goga/tools/${tool}/new.yaml`,
      },
    });
    expect(
      screen
        .getByRole("button", { name: "Файл new.yaml" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
    const text = "\ufeff# exact\r\n- quoted: '🙂'\r\n";
    act(() => store.edit(source("new.yaml", tool), text));
    click("Сохранить");
    await waitFor(() =>
      expect(api.saveProjectDocument).toHaveBeenCalledWith(
        "p",
        { kind: "tool", tool, path: "new.yaml" },
        text,
        "missing",
      ),
    );
    await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
    expect(store.get(source("new.yaml", tool)).document?.text).toBe(text);
    expect(editor()).not.toBeNull();
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.readSettings).not.toHaveBeenCalled();
  },
);
it("creates inside an existing safe parent, expands its tree and keeps independent tool form/drafts through navigation", async () => {
  function Pane({ active }: { active: boolean }) {
    return (
      <RetainedViews activeKey={active ? "tools" : "other"}>
        {active ? (
          <ProjectDocuments project={project} tab="tools" store={store} />
        ) : (
          <p>Other page</p>
        )}
      </RetainedViews>
    );
  }
  const view = render(<Pane active />);
  await screen.findByRole("combobox", { name: "Инструмент" });
  await create("env/new.yml");
  expect(screen.getByRole("button", { name: "Файл env/new.yml" })).toBeTruthy();
  act(() => store.edit(source("env/new.yml"), "draft: yes\n"));
  click("Создать файл");
  fireEvent.change(screen.getByRole("textbox", { name: "Имя файла" }), {
    target: { value: "next.yml" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "empty" },
  });
  await create("empty.yml");
  act(() => store.edit(source("empty.yml", "empty"), "empty: yes\n"));
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "review" },
  });
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Имя файла" }).value,
  ).toBe("next.yml");
  expect(editor()!.state.doc.toString()).toBe("draft: yes\n");
  view.rerender(<Pane active={false} />);
  view.rerender(<Pane active />);
  await screen.findByRole("combobox", { name: "Инструмент" });
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Имя файла" }).value,
  ).toBe("next.yml");
  expect(editor()!.state.doc.toString()).toBe("draft: yes\n");
  expect(api.readProjectDocument).not.toHaveBeenCalled();
});
it.each([
  "",
  "../bad.yml",
  "a/../bad.yml",
  "/bad.yml",
  "a//bad.yml",
  "bad\\name.yml",
  "bad.txt",
  "bad.YML",
  "bad\u0000.yml",
  "missing/new.yml",
  "blocked/new.yml",
  "env/old.yml",
  "ENV/OLD.yml",
  "folder.yml",
  "cafe\u0301.yml",
])(
  "rejects unsafe, missing-parent or equivalent catalog collision %j without changing a selected draft",
  async (name) => {
    await mount();
    await create();
    act(() => store.edit(source(), "retained: true\n"));
    const before = store.get(source());
    click("Создать файл");
    fireEvent.change(screen.getByRole("textbox", { name: "Имя файла" }), {
      target: { value: name },
    });
    click("Создать черновик");
    expect(screen.getByRole("alert").textContent).toMatch(
      /имя|путь|папк|существ|расшир|каталог/i,
    );
    expect(store.get(source())).toBe(before);
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
  },
);
it("rejects normalized in-memory duplicates and missing selected tool without replacing drafts", async () => {
  await mount();
  await create();
  const before = store.get(source());
  click("Создать файл");
  fireEvent.change(screen.getByRole("textbox", { name: "Имя файла" }), {
    target: { value: "NEW.yaml" },
  });
  click("Создать черновик");
  expect(screen.getByRole("alert").textContent).toMatch(/существ/i);
  expect(store.get(source())).toBe(before);
  expect(() =>
    store.createToolFile("p", "absent", "file.yml", catalog),
  ).toThrow(/инструмент/i);
  expect(() => store.createToolFile("p", "", "file.yml", catalog)).toThrow(
    /инструмент/i,
  );
});
it("isolates exact context revision, project, tool and path draft ownership", async () => {
  const a = owner(),
    b = owner({ contextId: "ctx-" + "b".repeat(64) }),
    newer = owner({ revision: "00000000-0000-4000-8000-000000000002" }),
    other = owner({ projectId: "other" });
  for (const [index, context] of [a, b, newer, other].entries()) {
    store.createToolFile(context, "review", "new.yaml", catalog);
    store.edit(source("new.yaml", "review", context), `owner: ${index}\n`);
  }
  store.createToolFile(a, "empty", "new.yaml", catalog);
  expect(
    new Set(
      [a, b, newer, other].map((context) =>
        documentKey(source("new.yaml", "review", context)),
      ),
    ).size,
  ).toBe(4);
  for (const [index, context] of [a, b, newer, other].entries())
    expect(store.get(source("new.yaml", "review", context)).text).toBe(
      `owner: ${index}\n`,
    );
  expect(store.get(source("new.yaml", "empty", a)).text).toBe("");
  await mount(a);
  expect(editor()!.state.doc.toString()).toBe("owner: 0\n");
  expect(api.readProjectDocument).not.toHaveBeenCalled();
});
it("resets a draft to its blank baseline and deletes only the memory source without reopening on refresh or retained activation", async () => {
  await mount();
  await create();
  act(() => store.edit(source(), "draft: true\n"));
  click("Отменить изменения");
  expect(editor()!.state.doc.toString()).toBe("");
  click("Удалить черновик");
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", {
      name: "Удалить черновик",
    }),
  );
  await waitFor(() => expect(editor()).toBeNull());
  expect(screen.queryByRole("button", { name: "Файл new.yaml" })).toBeNull();
  expect(store.get(source()).document).toBeUndefined();
  await act(async () => store.refreshProject("p"));
  await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
  expect(editor()).toBeNull();
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  expect(api.prepareDocumentDeletion).not.toHaveBeenCalled();
  expect(api.deleteDocument).not.toHaveBeenCalled();
});
it.each(["Конфликт сохранения: файл изменился", "permission denied"])(
  "retains the selected memory draft after save failure %s",
  async (message) => {
    api.saveProjectDocument.mockRejectedValueOnce(new Error(message));
    await mount();
    await create();
    act(() => store.edit(source(), "keep: true\r\n"));
    click("Сохранить");
    await screen.findByRole("alert");
    expect(store.get(source())).toMatchObject({
      memoryOnly: true,
      text: "keep: true\r\n",
      document: { exists: false, version: "missing" },
    });
    expect(editor()!.state.doc.toString()).toBe("keep: true\r\n");
    expect(
      screen
        .getByRole("button", { name: "Файл new.yaml" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(api.listProjectTools).toHaveBeenCalledTimes(1);
  },
);
it("disables creation during catalog reload/error and does not offer tool creation for an empty catalog", async () => {
  await mount();
  click("Создать файл");
  fireEvent.change(screen.getByRole("textbox", { name: "Имя файла" }), {
    target: { value: "new.yaml" },
  });
  let reject!: (error: Error) => void;
  api.listProjectTools.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  act(() => {
    void store.refreshProject("p");
  });
  await waitFor(() =>
    expect(
      screen
        .getByText("Создать черновик", { selector: "button" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  await act(async () => reject(new Error("catalog failed")));
  expect(
    screen
      .getByText("Создать черновик", { selector: "button" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(store.get(source()).document).toBeUndefined();
  cleanup();
  api.listProjectTools.mockResolvedValue([]);
  render(<ProjectDocuments project={project} tab="tools" store={store} />);
  await screen.findByText("В проекте пока нет инструментов");
  expect(screen.queryByRole("button", { name: "Создать файл" })).toBeNull();
  expect(screen.getByText("В проекте пока нет инструментов")).toBeTruthy();
});
it("keeps an absent nested draft listed and selectable after its catalog parent disappears", async () => {
  await mount();
  await create("env/new.yml");
  act(() => store.edit(source("env/new.yml"), "retained: yes\n"));
  api.listProjectTools.mockResolvedValue([
    { name: "review", entries: [] },
    { name: "empty", entries: [] },
  ]);
  await act(async () => store.refreshProject("p"));
  await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("button", { name: "Файл env/new.yml" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "empty" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "review" },
  });
  click("Файл env/new.yml");
  expect(editor()!.state.doc.toString()).toBe("retained: yes\n");
  expect(api.readProjectDocument).not.toHaveBeenCalled();
});

it("preserves each owner's creation form and selected file across owner/revision changes", async () => {
  const a = owner(),
    b = owner({ contextId: "ctx-" + "b".repeat(64) }),
    newer = owner({ revision: "00000000-0000-4000-8000-000000000002" });
  const view = await mount(a);
  await create();
  act(() => store.edit(source("new.yaml", "review", a), "owner: a\n"));
  click("Создать файл");
  fireEvent.change(screen.getByRole("textbox", { name: "Имя файла" }), {
    target: { value: "next-a.yml" },
  });
  for (const context of [b, newer]) {
    view.rerender(
      <ProjectDocuments
        project={project}
        owner={context}
        tab="tools"
        store={store}
      />,
    );
    await screen.findByRole("combobox", { name: "Инструмент" });
    expect(editor()).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Имя файла" })).toBeNull();
    await create();
    act(() =>
      store.edit(
        source("new.yaml", "review", context),
        `owner: ${context.contextId}-${context.revision}\n`,
      ),
    );
  }
  view.rerender(
    <ProjectDocuments project={project} owner={a} tab="tools" store={store} />,
  );
  await screen.findByRole("combobox", { name: "Инструмент" });
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Имя файла" }).value,
  ).toBe("next-a.yml");
  expect(editor()!.state.doc.toString()).toBe("owner: a\n");
  expect(api.readProjectDocument).not.toHaveBeenCalled();
});
it("removes only the inactive exact tool/context draft and never resurrects it on activation", async () => {
  const a = owner(),
    b = owner({ contextId: "ctx-" + "b".repeat(64) });
  for (const context of [a, b])
    store.createToolFile(context, "review", "new.yaml", catalog);
  store.createToolFile(a, "empty", "new.yaml", catalog);
  function Pane({ active }: { active: boolean }) {
    return (
      <RetainedViews activeKey={active ? "tools" : "other"}>
        {active ? (
          <ProjectDocuments
            project={project}
            owner={a}
            tab="tools"
            store={store}
          />
        ) : (
          <p>Other</p>
        )}
      </RetainedViews>
    );
  }
  const view = render(<Pane active />);
  await screen.findByRole("combobox", { name: "Инструмент" });
  expect(editor()).not.toBeNull();
  view.rerender(<Pane active={false} />);
  await act(async () => {
    const target = source("new.yaml", "review", a);
    await store.prepareDeletion(target);
    expect(await store.delete(target, store.get(target).deletion!)).toBe(true);
    await store.refreshProject(a);
  });
  expect(store.get(source("new.yaml", "review", b)).memoryOnly).toBe(true);
  expect(store.get(source("new.yaml", "empty", a)).memoryOnly).toBe(true);
  view.rerender(<Pane active />);
  await screen.findByRole("combobox", { name: "Инструмент" });
  expect(editor()).toBeNull();
  expect(screen.queryByRole("button", { name: "Файл new.yaml" })).toBeNull();
  expect(api.readProjectDocument).not.toHaveBeenCalled();
  expect(api.prepareDocumentDeletion).not.toHaveBeenCalled();
  expect(api.deleteDocument).not.toHaveBeenCalled();
});
it("rejects a cached source's normalized spelling even if its file is absent from the current catalog", async () => {
  const target = source("Cached.yml");
  await store.open(target);
  store.edit(target, "keep: cached\n");
  const before = store.get(target);
  expect(() =>
    store.createToolFile("p", "review", "cached.yml", [
      { name: "review", entries: [] },
    ]),
  ).toThrow(/существ/i);
  expect(store.get(target)).toBe(before);
  expect(store.toolState("p", "review").drafts).toEqual([]);
  expect(api.readProjectDocument).toHaveBeenCalledTimes(1);
  expect(api.saveProjectDocument).not.toHaveBeenCalled();
});
it.each([
  ["memory", "tool-only"],
  ["memory", "all"],
  ["cached", "tool-only"],
  ["cached", "all"],
] as const)(
  "keeps the exact owner's %s tool source reachable after %s catalog loss from another empty tool",
  async (kind, loss) => {
    const context = owner();
    const foreign = owner({ contextId: "ctx-" + "b".repeat(64) });
    store.createToolFile(foreign, "foreign", "secret.yml", [
      { name: "foreign", entries: [] },
    ]);
    store.updateTool(context, "stale-empty", {
      creating: true,
      name: "not-a-tool.yml",
    });
    await mount(context);
    const path = kind === "memory" ? "new.yaml" : "env/old.yml";
    if (kind === "memory") await create(path);
    else {
      click("Папка env");
      click("Файл env/old.yml");
      await waitFor(() => expect(editor()).not.toBeNull());
    }
    act(() =>
      store.edit(source(path, "review", context), `retained: ${kind}\n`),
    );
    click("Создать файл");
    fireEvent.change(screen.getByRole("textbox", { name: "Имя файла" }), {
      target: { value: "next-review.yml" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
      target: { value: "empty" },
    });
    expect(editor()).toBeNull();
    api.listProjectTools.mockResolvedValue(
      loss === "all" ? [] : [{ name: "empty", entries: [] }],
    );
    await act(async () => store.refreshProject(context));
    await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
    const selector = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Инструмент",
    });
    expect(
      within(selector).getByRole("option", { name: "review" }),
    ).toBeTruthy();
    expect(
      within(selector).queryByRole("option", { name: "foreign" }),
    ).toBeNull();
    expect(
      within(selector).queryByRole("option", { name: "stale-empty" }),
    ).toBeNull();
    fireEvent.change(selector, { target: { value: "review" } });
    expect(editor()!.state.doc.toString()).toBe(`retained: ${kind}\n`);
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Имя файла" })
        .value,
    ).toBe("next-review.yml");
    expect(
      screen
        .getByRole("button", { name: "Создать файл" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Создать черновик" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(api.readProjectDocument).toHaveBeenCalledTimes(
      kind === "memory" ? 0 : 1,
    );
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
  },
);
it.each(["leaf", "ancestor"])(
  "keeps only exact loaded drafts navigable through a newly blocked catalog %s and retains them on Save conflict",
  async (blocked) => {
    const context = owner();
    const path = blocked === "leaf" ? "new.yaml" : "env/new.yaml";
    await mount(context);
    await create(path);
    act(() =>
      store.edit(source(path, "review", context), "important: draft\n"),
    );
    if (blocked === "ancestor") click("Папка env");
    await create("other.yaml");
    api.listProjectTools.mockResolvedValue([
      {
        name: "review",
        entries: [
          {
            path: blocked === "leaf" ? path : "env",
            kind: blocked === "leaf" ? "file" : "directory",
            editable: false,
            reason: "Символическая ссылка",
          },
          { path: "other.yaml", kind: "file", editable: true },
          {
            path: "blocked",
            kind: "directory",
            editable: false,
            reason: "Другая недоступная папка",
          },
        ],
      },
    ]);
    await act(async () => store.refreshProject(context));
    await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Символическая ссылка")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Папка blocked" })
        .hasAttribute("disabled"),
    ).toBe(true);
    if (blocked === "ancestor") click("Папка env");
    const row = screen.getByRole("button", { name: `Файл ${path}` });
    expect(row.hasAttribute("disabled")).toBe(false);
    fireEvent.click(row);
    expect(editor()!.state.doc.toString()).toBe("important: draft\n");
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
    api.saveProjectDocument.mockRejectedValueOnce(
      new Error("Конфликт сохранения: файл изменился"),
    );
    click("Сохранить");
    await screen.findByRole("alert");
    expect(store.get(source(path, "review", context))).toMatchObject({
      memoryOnly: true,
      text: "important: draft\n",
      document: { exists: false, version: "missing" },
    });
    expect(editor()!.state.doc.toString()).toBe("important: draft\n");
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ["symlink", "env", false],
  ["regular-file", "env.yaml", true],
] as const)(
  "keeps cached descendants separately reachable when Host catalogs their parent as a %s file",
  async (kind, parent, editable) => {
    const context = owner();
    const path = `${parent}/new.yaml`;
    api.listProjectTools.mockResolvedValue([
      {
        name: "review",
        entries: [{ path: parent, kind: "directory", editable: false }],
      },
    ]);
    await mount(context);
    await create(path);
    act(() =>
      store.edit(source(path, "review", context), "retained: nested\n"),
    );
    click(`Папка ${parent}`);
    await create("other.yaml");
    api.listProjectTools.mockResolvedValue([
      {
        name: "review",
        entries: [
          {
            path: parent,
            kind: "file",
            editable,
            ...(editable
              ? {}
              : { reason: "Символические ссылки не разрешены" }),
          },
          { path: "other.yaml", kind: "file", editable: true },
          { path: "sibling.yml", kind: "file", editable: true },
          { path: `${parent}/not-loaded.yml`, kind: "file", editable: true },
        ],
      },
    ]);
    await act(async () => store.refreshProject(context));
    await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
    expect(
      screen
        .getByRole("button", { name: `Файл ${parent}` })
        .hasAttribute("disabled"),
    ).toBe(!editable);
    expect(
      screen
        .getByRole("button", { name: "Файл sibling.yml" })
        .hasAttribute("disabled"),
    ).toBe(false);
    if (kind === "symlink")
      expect(
        screen.getByText("Символические ссылки не разрешены"),
      ).toBeTruthy();
    click(`Черновики в ${parent}`);
    expect(
      screen.queryByRole("button", { name: `Файл ${parent}/not-loaded.yml` }),
    ).toBeNull();
    click(`Файл ${path}`);
    expect(editor()!.state.doc.toString()).toBe("retained: nested\n");
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
    api.saveProjectDocument.mockRejectedValueOnce(
      new Error("Символические ссылки или изменённый родитель не разрешены"),
    );
    click("Сохранить");
    await screen.findByRole("alert");
    expect(store.get(source(path, "review", context))).toMatchObject({
      memoryOnly: true,
      text: "retained: nested\n",
      document: { exists: false, version: "missing" },
    });
    expect(api.readProjectDocument).not.toHaveBeenCalled();
    expect(api.saveProjectDocument).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ["memory", "missing"],
  ["memory", "editable-file"],
  ["memory", "blocked-file"],
  ["memory", "directory"],
  ["memory", "blocked-directory"],
  ["cached", "missing"],
  ["cached", "editable-file"],
  ["cached", "blocked-file"],
  ["cached", "directory"],
  ["cached", "blocked-directory"],
] as const)(
  "keeps every exact loaded %s source actionable when its live catalog shape is %s",
  async (kind, shape) => {
    const context = owner();
    const path = "new.yaml";
    api.listProjectTools.mockResolvedValue([
      {
        name: "review",
        entries:
          kind === "cached" ? [{ path, kind: "file", editable: true }] : [],
      },
    ]);
    await mount(context);
    if (kind === "memory") await create(path);
    else {
      click(`Файл ${path}`);
      await waitFor(() => expect(editor()).not.toBeNull());
    }
    act(() =>
      store.edit(source(path, "review", context), `retained: ${kind}\n`),
    );
    await create("other.yaml");
    const directory = shape === "directory" || shape === "blocked-directory";
    const blocked = shape === "blocked-file" || shape === "blocked-directory";
    api.listProjectTools.mockResolvedValue([
      {
        name: "review",
        entries: [
          ...(shape === "missing"
            ? []
            : [
                {
                  path,
                  kind: directory ? "directory" : "file",
                  editable: shape === "editable-file",
                  ...(blocked ? { reason: "Недоступный путь на диске" } : {}),
                },
              ]),
          ...(directory
            ? [{ path: `${path}/child.yml`, kind: "file", editable: true }]
            : []),
          { path: "other.yaml", kind: "file", editable: true },
        ],
      },
    ]);
    await act(async () => store.refreshProject(context));
    await waitFor(() => expect(api.listProjectTools).toHaveBeenCalledTimes(2));
    if (blocked)
      expect(screen.getByText("Недоступный путь на диске")).toBeTruthy();
    if (directory) {
      const folder = screen.getByRole("button", { name: `Папка ${path}` });
      expect(folder.hasAttribute("disabled")).toBe(blocked);
      if (!blocked) {
        fireEvent.click(folder);
        expect(
          screen
            .getByRole("button", { name: `Файл ${path}/child.yml` })
            .hasAttribute("disabled"),
        ).toBe(false);
      }
    }
    const action = screen.getByRole("button", {
      name: directory ? `Исходник в памяти ${path}` : `Файл ${path}`,
    });
    expect(action.hasAttribute("disabled")).toBe(false);
    fireEvent.click(action);
    expect(editor()!.state.doc.toString()).toBe(`retained: ${kind}\n`);
    expect(store.get(source(path, "review", context))).toMatchObject({
      text: `retained: ${kind}\n`,
      document: {
        exists: kind === "cached",
        version: kind === "memory" ? "missing" : "v1",
      },
    });
    expect(api.readProjectDocument).toHaveBeenCalledTimes(
      kind === "memory" ? 0 : 1,
    );
    expect(api.saveProjectDocument).not.toHaveBeenCalled();
  },
);
it("removes only the duplicated tools overview when a source is selected, retaining its context, hints and all actions", async () => {
  await mount();
  expect(
    screen.getByText("Файлы выбранного инструмента в проекте Fixture."),
  ).toBeTruthy();
  await create();
  expect(
    document
      .querySelector(".master-detail")
      ?.classList.contains("tool-files-detail"),
  ).toBe(true);
  expect(
    screen.queryByText("Файлы выбранного инструмента в проекте Fixture."),
  ).toBeNull();
  expect(screen.getByText(".goga/tools/review/new.yaml")).toBeTruthy();
  expect(
    screen.getByText(
      "YAML инструмента review. Сохраняется только выбранный файл.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByText(/Файл отсутствует и будет создан только после/),
  ).toBeTruthy();
  expect(
    screen.getByText(/Исходный YAML сохраняет комментарии и неизвестные поля/),
  ).toBeTruthy();
  for (const name of ["Удалить черновик", "Отменить изменения", "Сохранить"])
    expect(screen.getByRole("button", { name })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Инструмент" }), {
    target: { value: "empty" },
  });
  expect(
    screen.getByText("Файлы выбранного инструмента в проекте Fixture."),
  ).toBeTruthy();
});
