// @vitest-environment jsdom
import React, { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ProjectFlatDocuments } from "../src/renderer/ProjectFlatDocuments";
import { ProjectDocuments } from "../src/renderer/ProjectDocuments";
import { SettingsTabs } from "../src/renderer/SettingsDocument";
import { createSettingsDocuments } from "../src/renderer/settings-documents";
import type { Pipeline } from "../src/shared/types";
import type { ProjectWorkflow } from "../src/shared/project-documents";

afterEach(cleanup);
const project = { id: "p", name: "Fixture", path: "/synthetic" };
const other = { id: "q", name: "Other", path: "/other" };
const pipeline = (id: string, name = id, local = false): Pipeline => ({
  id,
  name,
  project: local,
  description: "",
});
const candidates = [
  pipeline("tool:release", "Выпуск установленного инструмента"),
  pipeline("local", "Проектный конвейер", true),
];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const suggestions = vi.fn(async (): Promise<Pipeline[]> => candidates);
  const list = vi.fn(async (): Promise<ProjectWorkflow[]> => []);
  const read = vi.fn(async () => ({
    text: "# original\n",
    version: "v1",
    exists: true,
    relativePath: ".goga/workflows/existing.yml",
  }));
  const save = vi.fn(
    async (
      _id: string,
      target: { kind: string; name?: string },
      text: string,
    ) => ({
      text,
      version: "v2",
      exists: true,
      relativePath: `.goga/${target.kind}s/${target.name}.yml`,
    }),
  );
  window.goga = {
    listWorkflowSuggestions: suggestions,
    listProjectWorkflows: list,
    listProjectPipelines: list,
    readProjectDocument: read,
    saveProjectDocument: save,
  } as any;
  const store = createSettingsDocuments();
  return {
    suggestions,
    list,
    read,
    save,
    store,
    show: () =>
      render(
        <ProjectFlatDocuments
          project={project}
          store={store}
          kind="workflow"
        />,
      ),
  };
}
const input = () =>
  screen.getByRole("combobox", {
    name: "Имя рабочего процесса",
  }) as HTMLInputElement;
function change(value: string) {
  fireEvent.change(input(), { target: { value } });
}
async function open() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Создать рабочий процесс" }),
  );
  fireEvent.focus(input());
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Создать черновик",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
}
function options() {
  return screen.queryAllByRole("option").map((option) => option.textContent);
}
const key = (name: string, extra = {}) =>
  fireEvent.keyDown(input(), { key: name, ...extra });

describe("workflow name suggestions", () => {
  it("loads only on form mount, displays untouched titles and exact namespace IDs, without selecting or reading", async () => {
    const f = setup();
    f.show();
    await screen.findByText("В проекте пока нет рабочих процессов");
    expect(f.suggestions).not.toHaveBeenCalled();
    await open();
    await screen.findByRole("option", {
      name: /Выпуск установленного инструмента.*tool:release.yml/,
    });
    expect(options()).toEqual([
      "Выпуск установленного инструментаtool:release.yml",
      "Проектный конвейерlocal.yml",
    ]);
    expect(input().value).toBe("");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(f.suggestions).toHaveBeenCalledExactlyOnceWith("p");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
  it("filters by title or ID while leaving arbitrary typed names intact without re-fetch", async () => {
    const f = setup();
    f.show();
    await open();
    await screen.findAllByRole("option");
    change("Выпуск");
    expect(options()).toEqual([
      "Выпуск установленного инструментаtool:release.yml",
    ]);
    change("LOCAL");
    expect(options()).toEqual(["Проектный конвейерlocal.yml"]);
    change("my-new-name");
    expect(options()).toEqual([]);
    expect(input().value).toBe("my-new-name");
    fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
    expect(f.store.workflowState("p").drafts).toEqual(["my-new-name"]);
    expect(f.suggestions).toHaveBeenCalledTimes(1);
    expect(f.save).not.toHaveBeenCalled();
  });
  it("excludes unsafe IDs, occupied filenames and memory draft aliases without changing other drafts/selection", async () => {
    const f = setup();
    f.suggestions.mockResolvedValue([
      ...candidates,
      pipeline("BLOCKED"),
      pipeline("memory"),
      pipeline("bad/path"),
      pipeline("../x"),
      pipeline("Alias"),
      pipeline("alias"),
    ]);
    f.list.mockResolvedValue([
      {
        name: "not-the-stem",
        path: ".goga/workflows/blocked.YML",
        editable: false,
      },
    ]);
    f.store.createWorkflow("p", "MeMoRy", []);
    f.store.edit(
      {
        scope: "project",
        projectId: "p",
        target: { kind: "workflow", name: "MeMoRy" },
      },
      "# untouched\n",
    );
    f.show();
    await open();
    await screen.findAllByRole("option");
    expect(options()).toHaveLength(2);
    expect(f.store.workflowState("p").selected).toBe("MeMoRy");
    expect(f.store.workflowState("p").drafts).toEqual(["MeMoRy"]);
    expect(
      f.store.get({
        scope: "project",
        projectId: "p",
        target: { kind: "workflow", name: "MeMoRy" },
      }).text,
    ).toBe("# untouched\n");
  });
  it("pointer selection only sets exact ID; Create makes a memory draft and Save retains source and bytes", async () => {
    const f = setup();
    f.show();
    await open();
    const option = await screen.findByRole("option", {
      name: /tool:release.yml/,
    });
    act(() => input().focus());
    const control = input();
    expect(fireEvent.pointerDown(option)).toBe(false);
    fireEvent.click(option);
    expect(control.value).toBe("tool:release");
    expect(document.activeElement).toBe(control);
    expect(f.store.workflowState("p").drafts).toEqual([]);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
    const source = {
      scope: "project" as const,
      projectId: "p",
      target: { kind: "workflow" as const, name: "tool:release" },
    };
    expect(f.store.get(source).document?.exists).toBe(false);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
    const raw = "\uFEFF# шаблон\r\nvalue: {{ profile.value }}\r\n";
    act(() => f.store.edit(source, raw));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(f.save).toHaveBeenCalledWith("p", source.target, raw, "missing"),
    );
    expect(f.store.get(source).text).toBe(raw);
  });
  it("Enter without active option does not submit; arrows select with input focus and Enter only chooses", async () => {
    const f = setup();
    f.show();
    await open();
    await screen.findAllByRole("option");
    act(() => input().focus());
    expect(key("Enter")).toBe(false);
    expect(input().value).toBe("");
    key("ArrowDown");
    const active = input().getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)?.textContent).toContain(
      "tool:release.yml",
    );
    key("ArrowDown");
    key("ArrowUp");
    expect(key("Enter")).toBe(false);
    expect(input().value).toBe("tool:release");
    expect(document.activeElement).toBe(input());
    expect(f.store.workflowState("p").drafts).toEqual([]);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });
  it("Escape and Tab close; reopening does not reuse a previous active option", async () => {
    const f = setup();
    f.show();
    await open();
    await screen.findAllByRole("option");
    key("ArrowDown");
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input());
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    key("ArrowUp");
    expect(input().getAttribute("aria-activedescendant")).not.toBeNull();
    key("Tab");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("IME composition and legacy keyCode 229 cannot select or submit", async () => {
    const f = setup();
    f.show();
    await open();
    await screen.findAllByRole("option");
    key("ArrowDown");
    fireEvent.compositionStart(input());
    expect(key("Enter")).toBe(false);
    expect(input().value).toBe("");
    fireEvent.compositionEnd(input());
    expect(key("Enter", { keyCode: 229 })).toBe(false);
    expect(input().value).toBe("");
    expect(key("Enter", { isComposing: true })).toBe(false);
    expect(input().value).toBe("");
    expect(f.store.workflowState("p").drafts).toEqual([]);
  });
  it("query and current drafts invalidate active option before Enter can choose a different ID", async () => {
    const f = setup();
    f.show();
    await open();
    await screen.findAllByRole("option");
    key("ArrowDown");
    change("local");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(key("Enter")).toBe(false);
    expect(input().value).toBe("local");
    change("");
    key("ArrowDown");
    act(() => f.store.updateWorkflow("p", { drafts: ["tool:release"] }));
    expect(options()).toEqual(["Проектный конвейерlocal.yml"]);
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(key("Enter")).toBe(false);
    expect(input().value).toBe("");
  });
  it.each(["empty", "error", "missing"])(
    "%s suggestions are a nonblocking manual fallback",
    async (mode) => {
      const f = setup();
      if (mode === "empty") f.suggestions.mockResolvedValue([]);
      if (mode === "error")
        f.suggestions.mockRejectedValue(Error("catalog broken"));
      if (mode === "missing")
        delete (window.goga as any).listWorkflowSuggestions;
      f.show();
      await open();
      await screen.findByText(
        mode === "empty" ? /Нет доступных подсказок/ : /Подсказки недоступны/,
      );
      change("manual");
      fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
      expect(f.store.workflowState("p").drafts).toEqual(["manual"]);
    },
  );
  it("loading suggestions never overwrite typing or block manual creation", async () => {
    const f = setup(),
      request = deferred<Pipeline[]>();
    f.suggestions.mockReturnValue(request.promise);
    f.show();
    await open();
    change("local");
    await act(async () => request.resolve(candidates));
    expect(input().value).toBe("local");
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    expect(f.suggestions).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
    expect(f.store.workflowState("p").drafts).toEqual(["local"]);
  });
  it.each(["loading", "error"])(
    "unavailable workflow file list (%s) still blocks Create",
    async (mode) => {
      const f = setup();
      if (mode === "loading") f.list.mockReturnValue(new Promise(() => {}));
      else f.list.mockRejectedValue(Error("files unavailable"));
      f.show();
      if (mode === "loading") {
        expect(
          screen.queryByRole("button", { name: "Создать рабочий процесс" }),
        ).toBeNull();
        expect(await screen.findByRole("status")).toBeTruthy();
        expect(f.store.workflowState("p").drafts).toEqual([]);
        return;
      }
      fireEvent.click(
        await screen.findByRole("button", { name: "Создать рабочий процесс" }),
      );
      fireEvent.focus(input());
      await screen.findAllByRole("option");
      change("manual");
      expect(
        (
          screen.getByRole("button", {
            name: "Создать черновик",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fireEvent.submit(input().closest("form")!);
      expect(f.store.workflowState("p").drafts).toEqual([]);
    },
  );
  it.each(["success", "failure"])(
    "ignores stale %s after project changes",
    async (outcome) => {
      const f = setup(),
        first = deferred<Pipeline[]>(),
        second = deferred<Pipeline[]>();
      f.suggestions
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const view = f.show();
      await open();
      change("preserve-p");
      act(() =>
        f.store.updateWorkflow("q", { creating: true, name: "preserve-q" }),
      );
      view.rerender(
        <ProjectFlatDocuments
          project={other}
          store={f.store}
          kind="workflow"
        />,
      );
      await waitFor(() => expect(f.suggestions).toHaveBeenCalledWith("q"));
      await act(async () => second.resolve([pipeline("fresh", "Fresh")]));
      change("");
      fireEvent.focus(input());
      expect(options()).toEqual(["Freshfresh.yml"]);
      await act(async () => {
        if (outcome === "success") first.resolve(candidates);
        else first.reject(Error("old failure"));
      });
      expect(options()).toEqual(["Freshfresh.yml"]);
      expect(screen.queryByText(/Подсказки недоступны/)).toBeNull();
      expect(f.store.workflowState("p").name).toBe("preserve-p");
    },
  );
  it.each(["success", "failure"])(
    "saved settings invalidate immediately and ignore old %s while preserving typed name",
    async (outcome) => {
      const f = setup(),
        old = deferred<Pipeline[]>(),
        latest = deferred<Pipeline[]>();
      f.suggestions
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(latest.promise);
      const view = render(
        <ProjectDocuments
          project={project}
          store={f.store}
          tab="workflows"
          savedSettingsVersion="s1"
        />,
      );
      await open();
      change("typed");
      view.rerender(
        <ProjectDocuments
          project={project}
          store={f.store}
          tab="workflows"
          savedSettingsVersion="s2"
        />,
      );
      await waitFor(() => expect(f.suggestions).toHaveBeenCalledTimes(2));
      await act(async () => latest.resolve([pipeline("typed-fresh")]));
      await act(async () => {
        if (outcome === "success") old.resolve(candidates);
        else old.reject(Error("stale"));
      });
      expect(input().value).toBe("typed");
      expect(options()).toEqual(["typed-freshtyped-fresh.yml"]);
    },
  );
  it("context change hides previous options in the same commit before effect cleanup", async () => {
    const f = setup(),
      pending = deferred<Pipeline[]>();
    const inspect = vi.fn();
    function Probe({ version }: { version: string }) {
      useLayoutEffect(() => {
        if (version === "s2")
          inspect(options(), input().getAttribute("aria-activedescendant"));
      }, [version]);
      return null;
    }
    const draw = (version: string) => (
      <>
        <ProjectFlatDocuments
          project={project}
          store={f.store}
          kind="workflow"
          savedSettingsVersion={version}
        />
        <Probe version={version} />
      </>
    );
    const view = render(draw("s1"));
    await open();
    await screen.findAllByRole("option");
    key("ArrowDown");
    f.suggestions.mockReturnValueOnce(pending.promise);
    view.rerender(draw("s2"));
    expect(inspect).toHaveBeenCalledWith([], null);
    expect(input().value).toBe("");
  });
  it.each(["pipeline", "workflow"] as const)(
    "successful %s Save refreshes suggestions without resetting name",
    async (kind) => {
      const f = setup();
      f.store[kind === "pipeline" ? "createPipeline" : "createWorkflow"](
        "p",
        "existing",
        [],
      );
      const source = {
        scope: "project" as const,
        projectId: "p",
        target: { kind, name: "existing" },
      };
      f.show();
      await open();
      await screen.findAllByRole("option");
      change("typed");
      await act(async () => {
        await f.store.save(source);
      });
      await waitFor(() => expect(f.suggestions).toHaveBeenCalledTimes(2));
      expect(input().value).toBe("typed");
    },
  );
  it("ignores requests after form unmount and fetches anew when reopened", async () => {
    const f = setup(),
      old = deferred<Pipeline[]>();
    f.suggestions.mockReturnValueOnce(old.promise);
    f.show();
    await open();
    change("manual");
    fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
    await open();
    await screen.findAllByRole("option");
    await act(async () => old.reject(Error("gone")));
    expect(options()).toHaveLength(2);
    expect(f.suggestions).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Подсказки недоступны/)).toBeNull();
  });
  it("never resurrects an old highlight when the available options change away and back", async () => {
    const f = setup();
    f.show();
    await open();
    await screen.findAllByRole("option");
    key("ArrowDown");
    act(() => f.store.updateWorkflow("p", { drafts: ["tool:release"] }));
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    act(() => f.store.updateWorkflow("p", { drafts: [] }));
    expect(input().getAttribute("aria-activedescendant")).toBeNull();
    key("Enter");
    expect(input().value).toBe("");
  });
  it("does not reuse an earlier catalog while returning to a previous context", async () => {
    const f = setup();
    const view = f.show();
    await open();
    await screen.findAllByRole("option");
    f.suggestions.mockReturnValue(new Promise(() => {}));
    act(() => f.store.updateWorkflow("q", { creating: true }));
    view.rerender(
      <ProjectFlatDocuments project={other} store={f.store} kind="workflow" />,
    );
    await waitFor(() => expect(f.suggestions).toHaveBeenCalledTimes(2));
    view.rerender(
      <ProjectFlatDocuments
        project={project}
        store={f.store}
        kind="workflow"
      />,
    );
    expect(options()).toEqual([]);
    await waitFor(() => expect(f.suggestions).toHaveBeenCalledTimes(3));
  });
  it.each(["success", "failure"])(
    "a successful Save invalidates pending suggestions and ignores old %s",
    async (outcome) => {
      const f = setup(),
        old = deferred<Pipeline[]>(),
        fresh = deferred<Pipeline[]>();
      f.store.createPipeline("p", "existing", []);
      f.suggestions
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      f.show();
      await open();
      change("typed");
      await act(async () => {
        await f.store.save({
          scope: "project",
          projectId: "p",
          target: { kind: "pipeline", name: "existing" },
        });
      });
      await waitFor(() => expect(f.suggestions).toHaveBeenCalledTimes(2));
      await act(async () => fresh.resolve([pipeline("typed-fresh")]));
      await act(async () => {
        if (outcome === "success") old.resolve(candidates);
        else old.reject(Error("stale"));
      });
      expect(input().value).toBe("typed");
      expect(options()).toEqual(["typed-freshtyped-fresh.yml"]);
      expect(screen.queryByText(/Подсказки недоступны/)).toBeNull();
    },
  );
  it.each([
    {
      width: 920,
      height: 700,
      bottom: 620,
      inputTop: 365,
      placement: "below",
      maxHeight: 214,
    },
    {
      width: 920,
      height: 700,
      bottom: 600,
      inputTop: 500,
      placement: "above",
      maxHeight: 250,
    },
    {
      width: 1320,
      height: 900,
      bottom: 840,
      inputTop: 350,
      placement: "below",
      maxHeight: 280,
    },
  ])(
    "bounds a long popup below the project's tabs at $width×$height ($placement)",
    async (geometry) => {
      const f = setup();
      f.suggestions.mockResolvedValue(
        Array.from({ length: 40 }, (_, index) =>
          pipeline(
            `tool:release-${index}`,
            "Длинное название конвейера ".repeat(8),
          ),
        ),
      );
      const tabs = [
        ["launch", "Запуск"],
        ["config", "Конфигурация"],
        ["tools", "Инструменты"],
        ["workflows", "Рабочие процессы"],
        ["pipelines", "Конвейеры"],
      ] as const;
      const { container } = render(
        <div className="scroll-area">
          <nav className="section-tabs" data-testid="unrelated-tabs" />
          <section className="project-settings-panel">
            <SettingsTabs
              label="Разделы настроек проекта"
              tabs={tabs}
              current="workflows"
              onChange={() => {}}
            />
            <ProjectFlatDocuments
              project={project}
              store={f.store}
              kind="workflow"
            />
          </section>
        </div>,
      );
      const rect = (top: number, bottom: number) => ({
        top,
        bottom,
        left: 20,
        right: geometry.width - 20,
        width: geometry.width - 40,
        height: bottom - top,
        x: 20,
        y: top,
        toJSON() {},
      });
      const viewport = container.querySelector(".scroll-area")!;
      const projectTabs = screen.getByRole("navigation", {
        name: "Разделы настроек проекта",
      });
      const stubs = [
        vi.spyOn(window, "innerHeight", "get").mockReturnValue(geometry.height),
        vi
          .spyOn(viewport, "getBoundingClientRect")
          .mockReturnValue(rect(100, geometry.bottom)),
        vi
          .spyOn(projectTabs, "getBoundingClientRect")
          .mockReturnValue(rect(180, 240)),
        vi
          .spyOn(screen.getByTestId("unrelated-tabs"), "getBoundingClientRect")
          .mockReturnValue(rect(480, 550)),
      ];
      try {
        fireEvent.click(
          await screen.findByRole("button", {
            name: "Создать рабочий процесс",
          }),
        );
        stubs.push(
          vi
            .spyOn(input(), "getBoundingClientRect")
            .mockReturnValue(rect(geometry.inputTop, geometry.inputTop + 36)),
        );
        stubs.push(
          vi
            .spyOn(
              input().closest(".workflow-name-input")!,
              "getBoundingClientRect",
            )
            .mockReturnValue(
              rect(geometry.inputTop - 22, geometry.inputTop + 90),
            ),
        );
        fireEvent.focus(input());
        await screen.findAllByRole("option");
        const popup = screen.getByRole("listbox");
        expect(popup.getAttribute("data-placement")).toBe(geometry.placement);
        expect(popup.style.maxHeight).toBe(`${geometry.maxHeight}px`);
        const popupTop =
          geometry.placement === "above"
            ? geometry.inputTop - 5 - geometry.maxHeight
            : geometry.inputTop + 36 + 5;
        expect(popupTop).toBeGreaterThanOrEqual(245);
        expect(popupTop + geometry.maxHeight).toBeLessThanOrEqual(
          geometry.bottom,
        );
        expect(projectTabs.querySelectorAll("button")).toHaveLength(5);
        expect(screen.getAllByRole("option")).toHaveLength(40);
      } finally {
        stubs.forEach((stub) => stub.mockRestore());
      }
    },
  );
  it("pipeline creation remains an ordinary input and never requests workflow suggestions", async () => {
    const f = setup();
    render(
      <ProjectFlatDocuments
        project={project}
        store={f.store}
        kind="pipeline"
      />,
    );
    await screen.findByText("В проекте пока нет конвейеров");
    fireEvent.click(screen.getByRole("button", { name: "Создать конвейер" }));
    const field = screen.getByRole("textbox", { name: "Имя конвейера" });
    fireEvent.change(field, { target: { value: "plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Создать черновик" }));
    expect(f.store.pipelineState("p").drafts).toEqual(["plain"]);
    expect(f.suggestions).not.toHaveBeenCalled();
  });
});
