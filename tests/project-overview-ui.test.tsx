// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import { installHistoryWorker } from "./helpers/history-worker";
import { ProjectOverview } from "../src/renderer/overview/ProjectOverview";
vi.mock("../src/renderer/overview/SchemaGraph", () => ({
  SchemaGraph: ({ onContract, onDrill, scope }: any) => (
    <div>
      Граф<output aria-label="Область схемы">{scope}</output>
      <button onClick={() => onContract(".")}>Контракт узла</button>
      <button onClick={() => onContract("B")}>Контракт области B</button>
      <button onClick={() => onDrill("B")}>Войти в область B</button>
    </div>
  ),
  IconButton: ({ label, onClick, disabled, children }: any) => (
    <button
      className="ov-icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  ),
}));
vi.mock("../src/renderer/overview/FileTree", () => ({
  FileTree: ({
    onFile,
    setExpanded,
    load,
    onNavigate,
    onContextMenu,
    scope,
  }: any) => (
    <>
      <button onClick={() => onFile("main.go")}>main.go</button>
      {scope !== "B" && (
        <button onClick={() => onFile("A/file.txt")}>Файл области A</button>
      )}
      {scope === "B" && (
        <button onClick={() => onFile("B/file.txt")}>Файл области B</button>
      )}
      <button
        onClick={() =>
          onContextMenu?.({
            paths: ["main.go"],
            entry: { path: "main.go", name: "main.go", kind: "file" },
            parent: "",
            x: 20,
            y: 30,
          })
        }
      >
        Меню main.go
      </button>
      <button onClick={() => onNavigate?.("src/api")}>В область api</button>
      <button onClick={() => onNavigate?.("src/api/internal")}>
        В папку internal
      </button>
      <button
        onClick={() =>
          onContextMenu?.({
            paths: ["src/api"],
            entry: { path: "src/api", name: "api", kind: "directory" },
            parent: "src",
            x: 20,
            y: 30,
          })
        }
      >
        Меню api
      </button>
      <button onClick={() => onFile("README.md")}>README.md</button>
      <button onClick={() => onFile("other.md")}>other.md</button>
      <button
        onClick={() => {
          setExpanded(["nested"]);
          void load("nested");
        }}
      >
        Раскрыть nested
      </button>
    </>
  ),
}));
const file = {
  text: "package main\n",
  version: "a".repeat(64),
  exists: true,
  relativePath: "main.go",
};
const schema = [
  {
    cell: ".",
    description: "Полное описание\n\nСохранён второй абзац.",
    types: ["Run"],
    usages: [],
    dependencies: {},
    children: [],
  },
];
function setup(
  schemaValue: import("../src/shared/project-architecture").SchemaCell[] = schema,
  workspacePath?: string,
) {
  const api = {
    listOverviewDirectory: vi.fn(async (_scope: string, _path: string) => ({
      path: "",
      entries: [],
      truncated: false,
    })),
    searchOverviewFiles: vi.fn(async () => ({ entries: [] })),
    readOverviewFile: vi.fn(async (_scope: string, path: string) => ({
      ...file,
      relativePath: path,
      text:
        path === "README.md"
          ? "# Readme\n\n[Local](notes.md)\n\n![pixel](https://example.invalid/pixel)\n\n<script>alert(1)</script>"
          : path === "other.md"
            ? "# Other"
            : file.text,
    })),
    copyOverviewEntries: vi.fn(async (_scope: unknown, _paths: string[]) => {}),
    copyOverviewPaths: vi.fn(
      async (_scope: unknown, _paths: string[], _absolute: boolean) => {},
    ),
    prepareOverviewPaste: vi.fn(
      async (_scope: unknown, _directory: string) => ({
        token: "paste-token",
        conflicts: [],
      }),
    ),
    executeOverviewPaste: vi.fn(async () => ({
      status: "done",
      completedPaths: [],
      touchedPaths: [],
      message: "done",
    })),
    saveOverviewFile: vi.fn(async () => file),
    createOverviewEntry: vi.fn(async () => file),
    readOverviewSchema: vi.fn(async () => schemaValue),
    readOverviewContract: vi.fn(async () => ({
      Run: {
        signature: { codemanifest: "(raw: T) -> R", implementation: null },
      },
    })),
  };
  render(
    <ProjectOverview
      scope="p"
      workspacePath={workspacePath}
      api={api as any}
    />,
  );
  return api;
}
let resizeOverview: (width: number) => void;
beforeEach(() => {
  installHistoryWorker();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeOverview = (width) =>
          callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("uses one search field without an inner focus ring even when shared styles load last", () => {
  const styles = document.createElement("style");
  styles.textContent =
    readFileSync(
      `${process.cwd()}/src/renderer/overview/overview.css`,
      "utf8",
    ) + readFileSync(`${process.cwd()}/src/renderer/style.css`, "utf8");
  document.head.appendChild(styles);
  try {
    setup();
    const input = screen.getByRole("textbox", { name: "Поиск файлов" });
    input.focus();
    expect(input.matches(":focus-visible")).toBe(true);
    // jsdom does not resolve every pseudo-class cascade like Chromium. Keep the
    // explicit scoped override, regardless of shared stylesheet load order.
    const focusRule = Array.from(styles.sheet!.cssRules).find(
      (rule) =>
        "selectorText" in rule &&
        rule.selectorText === ".ov-search input:focus-visible",
    ) as CSSStyleRule | undefined;
    expect(focusRule?.style.outline).toBe("none");
    expect(getComputedStyle(input).outline).toBe("none");
    expect(getComputedStyle(input).flexGrow).toBe("1");
    expect(getComputedStyle(input).height).toBe("100%");
    const inputRule = Array.from(styles.sheet!.cssRules).find(
      (rule) =>
        "selectorText" in rule && rule.selectorText === ".ov-search input",
    ) as CSSStyleRule | undefined;
    expect(inputRule?.style.padding).toMatch(/^0(?:px)?$/);
    expect(
      getComputedStyle(input.parentElement!.querySelector("svg")!).flexShrink,
    ).toBe("0");
    fireEvent.change(input, { target: { value: "mk" } });
    fireEvent.click(screen.getByRole("button", { name: "Очистить поиск" }));
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Очистить поиск" })).toBeNull();
  } finally {
    styles.remove();
  }
});
it("forwards the current owner to Host full-path copying without browser permission", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const api = setup(schema, "/fixture/current-copy");
  fireEvent.click(screen.getByText("Меню main.go"));
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Скопировать полный путь" }),
  );
  await waitFor(() =>
    expect(api.copyOverviewPaths).toHaveBeenCalledExactlyOnceWith(
      "p",
      ["main.go"],
      true,
    ),
  );
  expect(writeText).not.toHaveBeenCalled();
});
it("offers a graph action next to the contract for the current tree slice", async () => {
  const api = setup([{ ...schema[0], cell: "src/api", children: [] }]);
  await waitFor(() => expect(api.readOverviewSchema).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText("В область api"));
  const action = screen.getByRole("button", {
    name: "Показать текущую папку на схеме",
  });
  const contract = screen.getByRole("button", {
    name: "Показать контракт папки src/api",
  });
  expect(contract.nextElementSibling).toBe(action);
  fireEvent.click(screen.getByRole("button", { name: "Свернуть схему" }));
  fireEvent.click(action);
  expect(screen.getByRole("button", { name: "Свернуть схему" })).toBeTruthy();
  expect(screen.getByLabelText("Область схемы").textContent).toBe("src/api");
});
it("hides the current-slice graph icon for a plain folder even inside a schema cell", async () => {
  const api = setup([{ ...schema[0], cell: "src/api", children: [] }]);
  await waitFor(() => expect(api.readOverviewSchema).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText("В папку internal"));
  expect(
    screen.queryByRole("button", { name: "Показать текущую папку на схеме" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "Показать контракт папки src/api/internal",
    }),
  ).toBeNull();
});
it("opens source, exposes per-file refresh and protects closing dirty files", async () => {
  const api = setup();
  fireEvent.click(screen.getByText("main.go"));
  await screen.findByRole("button", { name: "Обновить файл с диска" });
  expect(
    screen.getByRole("button", { name: "Закрыть без сохранения" }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Обновить файл с диска" }),
  );
  await waitFor(() => expect(api.readOverviewFile).toHaveBeenCalledTimes(2));
});
it("shows full contract text separately without replacing file and closes it", async () => {
  setup();
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Показать контракт текущей папки",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Показать контракт текущей папки" }),
  );
  await screen.findByText("(raw: T) -> R");
  expect(
    screen.getByText("Полное описание Сохранён второй абзац."),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Закрыть контракт" }));
  expect(screen.queryByText("(raw: T) -> R")).toBeNull();
});
it("refreshes schema and loaded tree with one action and permits creating files", async () => {
  const api = setup();
  await waitFor(() => expect(api.readOverviewSchema).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Обновить обзор" }));
  await waitFor(() => expect(api.readOverviewSchema).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByRole("button", { name: "Создать файл" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Название" }), {
    target: { value: "new.ts" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Создать$/ }));
  await waitFor(() =>
    expect(api.createOverviewEntry).toHaveBeenCalledWith(
      "p",
      "new.ts",
      "file",
      "",
    ),
  );
});

it.each([false, true])(
  "shows incomplete or failed nested listings, with retry (failure: %s)",
  async (failure) => {
    const api = setup();
    api.listOverviewDirectory.mockImplementation(
      async (_scope: any, p: any) => {
        if (p === "nested" && failure) throw Error("Нет доступа к nested");
        return { path: p, entries: [], truncated: p === "nested" };
      },
    );
    fireEvent.click(screen.getByText("Раскрыть nested"));
    if (failure) {
      await screen.findByText("Нет доступа к nested");
      const before = api.listOverviewDirectory.mock.calls.length;
      fireEvent.click(
        screen.getByRole("button", { name: "Повторить загрузку nested" }),
      );
      await waitFor(() =>
        expect(api.listOverviewDirectory.mock.calls.length).toBeGreaterThan(
          before,
        ),
      );
    } else {
      await screen.findByText(
        "Список ограничен. Уточните поиск или выберите папку.",
      );
      expect(screen.getByText("nested:")).toBeTruthy();
    }
  },
);

const overviewEditor = () => {
  const content = document
    .querySelector(".yaml-code-editor")
    ?.shadowRoot?.querySelector(".cm-content");
  return content ? EditorView.findFromDOM(content as HTMLElement) : null;
};
it("keeps all source actions in one nonwrapping file toolbar with a truncating path", async () => {
  const styles = document.createElement("style");
  styles.textContent = readFileSync(
    `${process.cwd()}/src/renderer/overview/overview.css`,
    "utf8",
  );
  document.head.appendChild(styles);
  try {
    setup();
    fireEvent.click(screen.getByText("main.go"));
    await waitFor(() => expect(overviewEditor()?.state.readOnly).toBe(false));
    const toolbar = document.querySelector<HTMLElement>(".ov-file-toolbar")!;
    for (const name of [
      "Найти в файле",
      "Заменить в файле",
      "Обновить файл с диска",
      "Закрыть без сохранения",
      "Сохранить",
    ]) {
      const button = within(toolbar).getByRole("button", { name });
      expect(button.closest(".ov-file-toolbar")).toBe(toolbar);
      expect(button.getAttribute("title")).toBeTruthy();
    }
    expect(document.querySelector(".ov-editor-tools")).toBeNull();
    expect(getComputedStyle(toolbar).flexWrap).toBe("nowrap");
    expect(
      getComputedStyle(toolbar.querySelector(".ov-file-actions")!).flexShrink,
    ).toBe("0");
    const path = toolbar.querySelector(".ov-file-path > span")!;
    expect(path.textContent).toBe("main.go");
    expect(getComputedStyle(path).textOverflow).toBe("ellipsis");
    expect(getComputedStyle(path).whiteSpace).toBe("nowrap");
  } finally {
    styles.remove();
  }
});

it("neutralizes only the Overview host focus glow even when shared editor styles load last", async () => {
  const styles = document.createElement("style");
  styles.textContent =
    readFileSync(
      `${process.cwd()}/src/renderer/overview/overview.css`,
      "utf8",
    ) +
    readFileSync(`${process.cwd()}/src/renderer/YamlEditor.css`, "utf8") +
    readFileSync(`${process.cwd()}/src/renderer/style.css`, "utf8");
  document.head.appendChild(styles);
  try {
    setup();
    fireEvent.click(screen.getByText("main.go"));
    await waitFor(() => expect(overviewEditor()?.state.readOnly).toBe(false));
    const scoped = Array.from(styles.sheet!.cssRules).find(
      (rule) =>
        "selectorText" in rule &&
        rule.selectorText ===
          ".ov-source-editor .yaml-code-editor:focus-within",
    ) as CSSStyleRule | undefined;
    expect(scoped?.style.boxShadow).toBe("none");
    expect(scoped?.style.outline).toBe("none");
    const shared = Array.from(styles.sheet!.cssRules).find(
      (rule) =>
        "selectorText" in rule &&
        rule.selectorText === ".yaml-code-editor:focus-within",
    ) as CSSStyleRule;
    expect(shared.style.boxShadow).toBe("0 0 0 2px #6da9ff66");
    const find = screen.getByRole("button", { name: "Найти в файле" });
    fireEvent.keyDown(document, { key: "Tab", code: "Tab" });
    find.focus();
    expect(find.matches(":focus-visible")).toBe(true);
    // jsdom does not resolve the variable-based outline shorthand here.
    const buttonFocus = Array.from(styles.sheet!.cssRules).find(
      (rule) =>
        "selectorText" in rule &&
        typeof rule.selectorText === "string" &&
        rule.selectorText
          .split(",")
          .some((selector) => selector.trim() === "button:focus-visible"),
    ) as CSSStyleRule;
    expect(buttonFocus.style.outline).toBe("2px solid var(--teal)");
    expect(getComputedStyle(find).outline).not.toBe("none");
  } finally {
    styles.remove();
  }
});

it("routes toolbar search to the current file and restores source history, selection and scroll on return", async () => {
  const api = setup();
  api.readOverviewFile.mockImplementation(async (_scope, path) => ({
    ...file,
    relativePath: path,
    text: path === "README.md" ? "# readme readme" : "main main",
  }));
  fireEvent.click(screen.getByText("main.go"));
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toBe("main main"),
  );
  const toolbar = document.querySelector<HTMLElement>(".ov-file-toolbar")!;
  const first = overviewEditor()!;
  fireEvent.click(
    within(toolbar).getByRole("button", { name: "Заменить в файле" }),
  );
  fireEvent.input(first.dom.querySelector('input[name="search"]')!, {
    target: { value: "main" },
  });
  fireEvent.input(first.dom.querySelector('input[name="replace"]')!, {
    target: { value: "draft" },
  });
  fireEvent.click(first.dom.querySelector('button[name="replaceAll"]')!);
  act(() => first.dispatch({ selection: { anchor: 3 } }));
  first.scrollDOM.scrollTop = 61;
  first.scrollDOM.scrollLeft = 17;
  const depth = undoDepth(first.state);
  fireEvent.click(screen.getByText("README.md"));
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toBe("# readme readme"),
  );
  const second = overviewEditor()!;
  fireEvent.click(
    within(document.querySelector<HTMLElement>(".ov-file-toolbar")!).getByRole(
      "button",
      { name: "Найти в файле" },
    ),
  );
  fireEvent.input(second.dom.querySelector('input[name="search"]')!, {
    target: { value: "readme" },
  });
  fireEvent.click(second.dom.querySelector('button[name="next"]')!);
  expect(
    second.state.sliceDoc(
      second.state.selection.main.from,
      second.state.selection.main.to,
    ),
  ).toBe("readme");
  expect(first.state.doc.toString()).toBe("draft draft");
  fireEvent.click(screen.getByRole("tab", { name: "main.go" }));
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toBe("draft draft"),
  );
  const restored = overviewEditor()!;
  expect(restored.state.selection.main.anchor).toBe(3);
  expect(undoDepth(restored.state)).toBe(depth);
  expect(restored.scrollDOM.scrollTop).toBe(61);
  expect(restored.scrollDOM.scrollLeft).toBe(17);
  fireEvent.click(
    within(document.querySelector<HTMLElement>(".ov-file-toolbar")!).getByRole(
      "button",
      { name: "Заменить в файле" },
    ),
  );
  expect(
    (restored.dom.querySelector('input[name="search"]') as HTMLInputElement)
      .value,
  ).toBe("main");
  act(() => expect(undo(restored)).toBe(true));
  expect(restored.state.doc.toString()).toBe("main main");
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
});

it("disables source search while loading or previewing and binds the replacement editor after refresh", async () => {
  const api = setup();
  let finish!: (value: typeof file) => void;
  api.readOverviewFile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  fireEvent.click(screen.getByText("README.md"));
  await waitFor(() => expect(api.readOverviewFile).toHaveBeenCalledTimes(1));
  for (const name of ["Найти в файле", "Заменить в файле"])
    expect(
      (
        within(
          document.querySelector<HTMLElement>(".ov-file-toolbar")!,
        ).getByRole("button", { name }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  await act(async () =>
    finish({ ...file, text: "# initial", relativePath: "README.md" }),
  );
  await waitFor(() => expect(overviewEditor()?.state.readOnly).toBe(false));
  const initial = overviewEditor()!;
  fireEvent.click(
    screen.getByRole("button", { name: "Предпросмотр Markdown" }),
  );
  await screen.findByRole("heading", { name: "initial" });
  for (const name of ["Найти в файле", "Заменить в файле"])
    expect(
      (
        within(
          document.querySelector<HTMLElement>(".ov-file-toolbar")!,
        ).getByRole("button", { name }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Показать исходник Markdown" }),
  );
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toBe("# initial"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Обновить файл с диска" }),
  );
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toContain("# Readme"),
  );
  const reloaded = overviewEditor()!;
  expect(reloaded).not.toBe(initial);
  fireEvent.click(
    within(document.querySelector<HTMLElement>(".ov-file-toolbar")!).getByRole(
      "button",
      { name: "Заменить в файле" },
    ),
  );
  expect(reloaded.dom.querySelector('input[name="replace"]')).not.toBeNull();
  expect(initial.dom.querySelector('input[name="search"]')).toBeNull();
});

it("collapses the schema to its heading without closing the file and restores it", async () => {
  setup();
  fireEvent.click(screen.getByText("main.go"));
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Свернуть схему" }));
  expect(document.querySelector(".ov-map.ov-collapsed")).toBeTruthy();
  expect(document.querySelector(".ov-map-body")?.hasAttribute("hidden")).toBe(
    true,
  );
  expect(overviewEditor()?.state.doc.toString()).toBe("package main\n");
  fireEvent.click(screen.getByRole("button", { name: "Показать схему" }));
  expect(document.querySelector(".ov-map.ov-collapsed")).toBeNull();
  expect(document.querySelector(".ov-map-body")?.hasAttribute("hidden")).toBe(
    false,
  );
});
it.each([700, 1000, 1400])(
  "opens a contract beside the expanded graph without its tree, and restores navigation and the draft at %s px",
  async (width) => {
    setup();
    await act(async () => {
      resizeOverview(width);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    });
    fireEvent.click(screen.getByText("main.go"));
    await waitFor(() => expect(overviewEditor()).toBeTruthy());
    act(() =>
      overviewEditor()!.dispatch({
        changes: { from: 0, insert: "// draft\n" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Развернуть схему" }));
    expect(document.querySelector(".ov-full-graph")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Контракт узла" }));
    await screen.findByText("(raw: T) -> R");
    expect(document.querySelector(".ov-full-graph.ov-docked")).toBeTruthy();
    expect(document.querySelector(".ov-files")).toBeNull();
    expect(document.querySelector(".ov-map.ov-hidden")).toBeNull();
    expect(document.querySelector(".ov-contract")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Вернуть схему" })).toBeTruthy();
    expect(overviewEditor()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть контракт" }));
    expect(document.querySelector(".ov-full-graph")).toBeTruthy();
    expect(document.querySelector(".ov-files")).toBeNull();
    expect(document.querySelector(".ov-contract")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Контракт узла" }));
    await screen.findByText("(raw: T) -> R");
    fireEvent.click(screen.getByRole("button", { name: "Вернуть схему" }));
    expect(document.querySelector(".ov-full-graph")).toBeNull();
    expect(document.querySelector(".ov-files")).toBeTruthy();
    expect(document.querySelector(".ov-contract")).toBeTruthy();
    await waitFor(() =>
      expect(overviewEditor()?.state.doc.toString()).toContain("// draft"),
    );
    // Compact normal layouts switch between graph/contract without closing either.
    if (!screen.queryByRole("button", { name: "Развернуть схему" }))
      fireEvent.click(screen.getByRole("button", { name: "Схема" }));
    // The same contract must also remain available when re-expanding the graph.
    fireEvent.click(screen.getByRole("button", { name: "Развернуть схему" }));
    expect(document.querySelector(".ov-full-graph.ov-docked")).toBeTruthy();
    expect(document.querySelector(".ov-contract")).toBeTruthy();
    expect(document.querySelector(".ov-files")).toBeNull();
  },
);
it("opens an explicitly requested contract source in the editor from an expanded graph", async () => {
  setup();
  await screen.findByRole("button", { name: "Контракт узла" });
  fireEvent.click(screen.getByRole("button", { name: "Развернуть схему" }));
  fireEvent.click(screen.getByRole("button", { name: "Контракт узла" }));
  await screen.findByText("(raw: T) -> R");
  expect(document.querySelector(".ov-full-graph")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Открыть CODEMANIFEST в редакторе" }),
  );
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  expect(document.querySelector(".ov-full-graph")).toBeNull();
  expect(document.querySelector(".ov-files")).toBeTruthy();
  expect(document.querySelector(".ov-contract")).toBeTruthy();
  expect(screen.getByRole("tab", { name: /CODEMANIFEST/ })).toBeTruthy();
});
it("previews unsaved Markdown, never activates HTML/resources, and preserves editor undo and selection", async () => {
  const api = setup();
  fireEvent.click(screen.getByText("README.md"));
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  const before = overviewEditor()!.state.doc.toString();
  act(() =>
    overviewEditor()!.dispatch({
      changes: { from: before.length, insert: "\n\n## Draft" },
      selection: { anchor: 3 },
    }),
  );
  const depth = undoDepth(overviewEditor()!.state);
  fireEvent.click(
    screen.getByRole("button", { name: "Предпросмотр Markdown" }),
  );
  await screen.findByRole("heading", { name: "Draft" });
  expect(overviewEditor()).toBeNull();
  expect(
    document.querySelector(
      ".ov-markdown-preview script,.ov-markdown-preview img,.ov-markdown-preview iframe,.ov-markdown-preview a[href]",
    ),
  ).toBeNull();
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Показать исходник Markdown" }),
  );
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  expect(overviewEditor()!.state.doc.toString()).toContain("## Draft");
  expect(overviewEditor()!.state.selection.main.anchor).toBe(3);
  expect(undoDepth(overviewEditor()!.state)).toBe(depth);
  act(() => {
    expect(undo(overviewEditor()!)).toBe(true);
  });
  expect(overviewEditor()!.state.doc.toString()).toBe(before);
});
it("keeps preview mode per Markdown file, and local links open through the overview API", async () => {
  const api = setup();
  fireEvent.click(screen.getByText("README.md"));
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  fireEvent.click(
    screen.getByRole("button", { name: "Предпросмотр Markdown" }),
  );
  await screen.findByRole("heading", { name: "Readme" });
  fireEvent.click(screen.getByText("other.md"));
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toBe("# Other"),
  );
  expect(
    screen.getByRole("button", { name: "Предпросмотр Markdown" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "README.md" }));
  await screen.findByRole("heading", { name: "Readme" });
  fireEvent.click(screen.getByRole("button", { name: "Local" }));
  await waitFor(() =>
    expect(api.readOverviewFile).toHaveBeenCalledWith("p", "notes.md"),
  );
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
});
it("does not offer Markdown preview for a programming-language file", async () => {
  setup();
  fireEvent.click(screen.getByText("main.go"));
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  expect(
    screen.queryByRole("button", { name: "Предпросмотр Markdown" }),
  ).toBeNull();
});

it.each(["clean", "discard", "save"] as const)(
  "restores overview after closing the last fullscreen file (%s)",
  async (mode) => {
    const api = setup();
    api.saveOverviewFile.mockImplementation(async () => ({
      ...file,
      text: "// draft\n" + file.text,
    }));
    fireEvent.click(screen.getByText("main.go"));
    await waitFor(() => expect(overviewEditor()).toBeTruthy());
    if (mode !== "clean")
      act(() =>
        overviewEditor()!.dispatch({
          changes: { from: 0, insert: "// draft\n" },
        }),
      );
    fireEvent.click(
      screen.getByRole("button", { name: "Развернуть документ" }),
    );
    expect(document.querySelector(".ov-full-file")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть main.go" }));
    if (mode !== "clean") {
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(
        [...dialog.querySelectorAll("button")].find(
          (e) =>
            e.textContent ===
            (mode === "save"
              ? "Сохранить и закрыть"
              : "Закрыть без сохранения"),
        )!,
      );
    }
    await waitFor(() =>
      expect(document.querySelector(".ov-document")).toBeNull(),
    );
    expect(document.querySelector(".ov-full-file")).toBeNull();
    expect(document.querySelector(".ov-files")).toBeTruthy();
    expect(document.querySelector(".ov-map.ov-hidden")).toBeNull();
    expect(screen.getByRole("button", { name: "Обновить обзор" })).toBeTruthy();
    fireEvent.click(screen.getByText("main.go"));
    await waitFor(() => expect(overviewEditor()).toBeTruthy());
    expect(document.querySelector(".ov-full-file")).toBeNull();
  },
);

it("keeps fullscreen and other drafts when another file remains, and keeps a cancelled close intact", async () => {
  const api = setup();
  fireEvent.click(screen.getByText("README.md"));
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  const first = overviewEditor()!.state.doc.toString();
  act(() =>
    overviewEditor()!.dispatch({ changes: { from: 0, insert: "Draft\n" } }),
  );
  fireEvent.click(screen.getByText("main.go"));
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toBe(file.text),
  );
  act(() =>
    overviewEditor()!.dispatch({ changes: { from: 0, insert: "// change\n" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  fireEvent.click(screen.getByRole("button", { name: "Закрыть main.go" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(
    [...dialog.querySelectorAll("button")].find(
      (e) => e.textContent === "Отмена",
    )!,
  );
  expect(document.querySelector(".ov-full-file")).toBeTruthy();
  expect(overviewEditor()?.state.doc.toString()).toContain("// change");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть main.go" }));
  const next = await screen.findByRole("dialog");
  fireEvent.click(
    [...next.querySelectorAll("button")].find(
      (e) => e.textContent === "Закрыть без сохранения",
    )!,
  );
  await waitFor(() =>
    expect(overviewEditor()?.state.doc.toString()).toBe("Draft\n" + first),
  );
  expect(document.querySelector(".ov-full-file")).toBeTruthy();
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
});

it("shows command-specific schema and contract errors without the Electron wrapper, and retries without losing the editor draft", async () => {
  const api = setup();
  fireEvent.click(screen.getByText("main.go"));
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  act(() =>
    overviewEditor()!.dispatch({ changes: { from: 0, insert: "// draft\n" } }),
  );
  api.readOverviewSchema.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:read-request': Error: Команда «goga schema» завершилась с кодом 1.",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Обновить обзор" }));
  await screen.findByText("Команда «goga schema» завершилась с кодом 1.");
  expect(screen.queryByText(/Error invoking remote/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() =>
    expect(screen.queryByText(/Команда «goga schema»/)).toBeNull(),
  );
  api.readOverviewContract.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:read-request': Error: Команда «goga contract -- .» завершилась с кодом 2.",
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Показать контракт текущей папки" }),
  );
  await screen.findByText(
    "Команда «goga contract -- .» завершилась с кодом 2.",
  );
  expect(screen.queryByText(/Error invoking remote/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await screen.findByText("(raw: T) -> R");
  expect(overviewEditor()?.state.doc.toString()).toContain("// draft");
  expect(api.saveOverviewFile).not.toHaveBeenCalled();
});

it("navigates from the file tree into a graph scope and uses the nearest schema parent for ordinary folders", async () => {
  const api = setup([
    {
      cell: "src",
      description: "",
      types: [],
      usages: [],
      dependencies: {},
      children: [
        {
          cell: "src/api",
          description: "",
          types: [],
          usages: [],
          dependencies: {},
          children: [],
        },
      ],
    },
  ]);
  await waitFor(() =>
    expect(screen.getByLabelText("Область схемы").textContent).toBe("src"),
  );
  fireEvent.click(screen.getByRole("button", { name: "В область api" }));
  expect(screen.getByLabelText("Область схемы").textContent).toBe("src/api");
  expect(api.listOverviewDirectory).toHaveBeenCalledWith("p", "src/api");
  fireEvent.click(screen.getByRole("button", { name: "В папку internal" }));
  expect(screen.getByLabelText("Область схемы").textContent).toBe("src/api");
  expect(api.listOverviewDirectory).toHaveBeenCalledWith(
    "p",
    "src/api/internal",
  );
});
it("creates a file inside the context-clicked folder, independently of the current tree slice", async () => {
  const api = setup();
  fireEvent.click(screen.getByRole("button", { name: "Меню api" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Создать файл" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Название" }), {
    target: { value: "new.ts" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Создать" }));
  await waitFor(() =>
    expect(api.createOverviewEntry).toHaveBeenCalledWith(
      "p",
      "src/api/new.ts",
      "file",
      "",
    ),
  );
});

it("retains a trashed draft visibly but disables in-place saving and offers a copy", async () => {
  const api = setup() as any;
  api.prepareOverviewFileAction = vi.fn(async () => ({
    token: "ticket",
    kind: "trash",
    paths: ["main.go"],
  }));
  api.executeOverviewFileAction = vi.fn(async () => ({
    status: "done",
    completedPaths: ["main.go"],
    message: "done",
  }));
  fireEvent.click(screen.getByText("main.go"));
  await waitFor(() => expect(overviewEditor()).toBeTruthy());
  act(() =>
    overviewEditor()!.dispatch({ changes: { from: 0, insert: "// draft\n" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Меню main.go" }));
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Переместить в Корзину" }),
  );
  await screen.findByRole("dialog");
  fireEvent.click(
    screen.getByRole("button", { name: "Переместить в Корзину" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(overviewEditor()?.state.doc.toString()).toContain("// draft");
  expect(
    screen.getByRole<HTMLButtonElement>("button", { name: "Сохранить" })
      .disabled,
  ).toBe(true);
  expect(screen.getByRole("button", { name: "Сохранить копию…" })).toBeTruthy();
});

const clipboardNavigationSchema = [
  { ...schema[0], children: [{ ...schema[0], cell: "B", children: [] }] },
];
it.each(["contract", "graph"])(
  "routes paste to the visible scope after %s navigation, not a hidden old selection",
  async (kind) => {
    const api = setup(clipboardNavigationSchema);
    fireEvent.click(
      await screen.findByRole("button", { name: "Файл области A" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: kind === "contract" ? "Контракт области B" : "Войти в область B",
      }),
    );
    await waitFor(() =>
      expect(api.listOverviewDirectory).toHaveBeenCalledWith("p", "B"),
    );
    expect(screen.queryByRole("button", { name: "Файл области A" })).toBeNull();
    const pane = document.querySelector<HTMLElement>(".ov-files")!;
    pane.focus();
    fireEvent.copy(pane);
    await act(async () => {});
    fireEvent.paste(pane);
    await waitFor(() =>
      expect(api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith(
        "p",
        "B",
      ),
    );
    expect(api.copyOverviewEntries).not.toHaveBeenCalled();
  },
);
it.each(["breadcrumb", "scope-chip"])(
  "clears a hidden folder's selection on root navigation via %s",
  async (kind) => {
    const api = setup(clipboardNavigationSchema);
    fireEvent.click(
      await screen.findByRole("button", { name: "Войти в область B" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Файл области B" }),
    );
    if (kind === "breadcrumb")
      fireEvent.click(screen.getByRole("button", { name: "Корень проекта" }));
    else
      fireEvent.click(
        document.querySelector<HTMLButtonElement>(".ov-file-scope > button")!,
      );
    const pane = document.querySelector<HTMLElement>(".ov-files")!;
    pane.focus();
    fireEvent.copy(pane);
    await act(async () => {});
    fireEvent.paste(pane);
    await waitFor(() =>
      expect(api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith("p", ""),
    );
    expect(api.copyOverviewEntries).not.toHaveBeenCalled();
  },
);
it("clears selection when a file filter changes, so hidden entries cannot be copied or chosen as paste target", async () => {
  const api = setup(clipboardNavigationSchema);
  api.searchOverviewFiles.mockResolvedValue({
    entries: [{ path: "B/new.txt", name: "new.txt", kind: "file" }],
    truncated: false,
  } as any);
  fireEvent.click(
    await screen.findByRole("button", { name: "Файл области A" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Поиск файлов" }), {
    target: { value: "new" },
  });
  await screen.findByRole("button", { name: /new.txt/ });
  expect(screen.queryByRole("button", { name: "Файл области A" })).toBeNull();
  const pane = document.querySelector<HTMLElement>(".ov-files")!;
  pane.focus();
  fireEvent.copy(pane);
  await act(async () => {});
  fireEvent.paste(pane);
  await waitFor(() =>
    expect(api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith("p", ""),
  );
  expect(api.copyOverviewEntries).not.toHaveBeenCalled();
});
it("keeps an explicitly navigated current directory as a valid clipboard selection", async () => {
  const api = setup(clipboardNavigationSchema);
  fireEvent.click(await screen.findByRole("button", { name: "В область api" }));
  const pane = document.querySelector<HTMLElement>(".ov-files")!;
  pane.focus();
  fireEvent.copy(pane);
  await act(async () => {});
  expect(api.copyOverviewEntries).toHaveBeenCalledExactlyOnceWith("p", [
    "src/api",
  ]);
  fireEvent.paste(pane);
  await waitFor(() =>
    expect(api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "p",
      "src/api",
    ),
  );
});
it("does not turn an editor tab's graph highlight into a hidden file-tree clipboard selection", async () => {
  const api = setup(clipboardNavigationSchema);
  fireEvent.click(
    await screen.findByRole("button", { name: "Файл области A" }),
  );
  await waitFor(() =>
    expect(
      document.querySelector('[role="tab"][title="A/file.txt"]'),
    ).not.toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Войти в область B" }));
  fireEvent.click(screen.getByRole("button", { name: "Файл области B" }));
  await waitFor(() =>
    expect(
      document.querySelector('[role="tab"][title="B/file.txt"]'),
    ).not.toBeNull(),
  );
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(
      '[role="tab"][title="A/file.txt"]',
    )!,
  );
  const pane = document.querySelector<HTMLElement>(".ov-files")!;
  pane.focus();
  fireEvent.copy(pane);
  await act(async () => {});
  fireEvent.paste(pane);
  await waitFor(() =>
    expect(api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith("p", "B"),
  );
  expect(api.copyOverviewEntries).toHaveBeenCalledExactlyOnceWith("p", [
    "B/file.txt",
  ]);
  expect(api.copyOverviewEntries).not.toHaveBeenCalledWith("p", ["A/file.txt"]);
});
it("explicit show-file-in-tree navigation selects the shown file's parent rather than the previous scope", async () => {
  const api = setup(clipboardNavigationSchema);
  fireEvent.click(
    await screen.findByRole("button", { name: "Файл области A" }),
  );
  await waitFor(() =>
    expect(
      document.querySelector('[role="tab"][title="A/file.txt"]'),
    ).not.toBeNull(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Войти в область B" }));
  fireEvent.click(screen.getByRole("button", { name: "A/file.txt" }));
  const pane = document.querySelector<HTMLElement>(".ov-files")!;
  pane.focus();
  fireEvent.copy(pane);
  await act(async () => {});
  fireEvent.paste(pane);
  await waitFor(() =>
    expect(api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith("p", "A"),
  );
  expect(api.copyOverviewEntries).toHaveBeenCalledExactlyOnceWith("p", [
    "A/file.txt",
  ]);
});
