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
} from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo, undoDepth } from "@codemirror/commands";
import { installHistoryWorker } from "./helpers/history-worker";
import { ProjectOverview } from "../src/renderer/overview/ProjectOverview";
vi.mock("../src/renderer/overview/SchemaGraph", () => ({
  SchemaGraph: ({ onContract, scope }: any) => (
    <div>
      Граф<output aria-label="Область схемы">{scope}</output>
      <button onClick={() => onContract(".")}>Контракт узла</button>
    </div>
  ),
  IconButton: ({ label, onClick, disabled, children }: any) => (
    <button aria-label={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("../src/renderer/overview/FileTree", () => ({
  FileTree: ({ onFile, setExpanded, load, onNavigate, onContextMenu }: any) => (
    <>
      <button onClick={() => onFile("main.go")}>main.go</button>
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
it("forwards the workspace root to the full-path context menu", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  setup(schema, "/fixture/current-copy");
  fireEvent.click(screen.getByText("Меню main.go"));
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Скопировать полный путь" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("/fixture/current-copy/main.go"),
  );
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
