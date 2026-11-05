// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
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
import { ProjectOverview } from "../src/renderer/overview/ProjectOverview";
import { RetainedViews } from "../src/renderer/RetainedViews";
import { installHistoryWorker } from "./helpers/history-worker";
import type { ScopeRef } from "../src/shared/context";
import type {
  OverviewDirectory,
  OverviewPastePreview,
  OverviewPasteResult,
} from "../src/shared/project-overview";

vi.mock("../src/renderer/overview/SchemaGraph", () => ({
  SchemaGraph: () => <div>Граф</div>,
  IconButton: ({ label, children, ...props }: any) => (
    <button aria-label={label} {...props}>
      {children}
    </button>
  ),
}));
// jsdom has no viewport geometry; retain real tree rows and selection logic.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: any) => ({
    getTotalSize: () => count * 32,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 32,
        size: 32,
      })),
    scrollToIndex: vi.fn(),
  }),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const destination = "target/длинная-папка-назначения";
const entries = [
  { path: destination, name: "Папка назначения", kind: "directory" as const },
  { path: "a.txt", name: "a.txt", kind: "file" as const },
  { path: "b.txt", name: "b.txt", kind: "file" as const },
];
const completed: OverviewPasteResult = {
  status: "done",
  completedPaths: [destination + "/new.txt"],
  touchedPaths: [destination + "/new.txt"],
  message: "Готово",
};
const dialogMethods = ["showModal", "close"].map(
  (name) =>
    [
      name,
      Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
    ] as const,
);
beforeEach(() => {
  installHistoryWorker();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});
afterEach(() => {
  cleanup();
  document
    .querySelectorAll("style[data-feedback-test]")
    .forEach((s) => s.remove());
  vi.unstubAllGlobals();
  for (const [name, descriptor] of dialogMethods) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else delete (HTMLDialogElement.prototype as any)[name];
  }
});
function injectStyles() {
  const styles = document.createElement("style");
  styles.dataset.feedbackTest = "";
  // jsdom resolves conflicting declarations by order, not Chromium specificity.
  // Native Electron QA separately verifies the full browser cascade.
  styles.textContent = [
    "src/renderer/style.css",
    "src/renderer/Topics.css",
    "src/renderer/overview/overview.css",
  ]
    .map((p) => readFileSync(`${process.cwd()}/${p}`, "utf8"))
    .join("\n");
  document.head.appendChild(styles);
}
async function setup(initialScope: ScopeRef = "p") {
  const preparation = deferred<OverviewPastePreview>(),
    copying = deferred<OverviewPasteResult>(),
    refreshing = deferred<OverviewDirectory>();
  const api = {
    listOverviewDirectory: vi.fn(
      async (_scope: ScopeRef, path: string): Promise<OverviewDirectory> => ({
        path,
        entries: path ? [] : entries,
        truncated: false,
      }),
    ),
    readOverviewSchema: vi.fn(async () => []),
    readOverviewFile: vi.fn(async (_scope: ScopeRef, path: string) => ({
      relativePath: path,
      text: "Содержимое файла",
      version: "a".repeat(64),
      exists: true,
    })),
    searchOverviewFiles: vi.fn(async () => ({ entries, truncated: false })),
    prepareOverviewPaste: vi.fn(
      (_scope: ScopeRef, _destination: string) => preparation.promise,
    ),
    executeOverviewPaste: vi.fn(
      (_token: string, _decisions: unknown[]) => copying.promise,
    ),
    copyOverviewEntries: vi.fn(async () => {}),
    copyOverviewPaths: vi.fn(async () => {}),
  };
  function Wrapper({
    scope = initialScope,
    active = "overview",
  }: {
    scope?: ScopeRef;
    active?: string;
  }) {
    return (
      <RetainedViews activeKey={active}>
        <div key={active}>
          {active === "overview" ? (
            <ProjectOverview api={api as any} scope={scope} />
          ) : (
            <p>Другой раздел</p>
          )}
        </div>
      </RetainedViews>
    );
  }
  const view = render(<Wrapper />);
  await screen.findByRole("treeitem", { name: "Папка назначения" });
  await waitFor(() => expect(api.readOverviewSchema).toHaveBeenCalledOnce());
  await act(async () => {});
  const chooseTarget = () => {
    const row = screen.getByRole("treeitem", { name: "Папка назначения" });
    fireEvent.contextMenu(row);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    row.focus();
    return row;
  };
  const start = (method: "ctrl" | "meta" | "menu" = "ctrl") => {
    const row = chooseTarget();
    if (method === "menu") {
      fireEvent.contextMenu(row);
      fireEvent.click(screen.getByRole("menuitem", { name: "Вставить" }));
    } else
      fireEvent.keyDown(row, {
        key: "v",
        ctrlKey: method === "ctrl",
        metaKey: method === "meta",
      });
    return row;
  };
  return {
    api,
    preparation,
    copying,
    refreshing,
    view,
    Wrapper,
    start,
    chooseTarget,
  };
}
function activity(phase: string, target = destination) {
  const node = screen.getByRole("status", { name: "Вставка файлов" });
  expect(node.textContent).toContain(phase);
  expect(node.textContent).toContain(target);
  expect(node.textContent).not.toMatch(/\d+%/);
  expect(node.getAttribute("aria-live")).toBe("polite");
  expect(node.querySelector("svg.ov-spin")).not.toBeNull();
  const search = screen
    .getByRole("textbox", { name: "Поиск файлов" })
    .closest(".ov-search")!;
  expect(search.nextElementSibling).toBe(node);
  expect(node.closest("aside.ov-files")).not.toBeNull();
  return node;
}
it.each(["ctrl", "meta", "menu"] as const)(
  "shows immediate owner-bound paste phases below search via %s and guards duplicates",
  async (method) => {
    const f = await setup();
    const row = f.start(method);
    activity("Подготавливаем вставку");
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "p",
      destination,
    );
    row.focus();
    fireEvent.keyDown(row, { key: "v", ctrlKey: true });
    fireEvent.paste(row);
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledOnce();
    await act(async () =>
      f.preparation.resolve({ token: "captured", conflicts: [] }),
    );
    activity("Копируем файлы");
    expect(f.api.executeOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "captured",
      [],
    );
    f.api.listOverviewDirectory.mockImplementationOnce((_scope, path) => {
      expect(path).toBe(destination);
      return f.refreshing.promise;
    });
    await act(async () => f.copying.resolve(completed));
    activity("Обновляем дерево");
    expect(screen.getByRole("tree")).toBeDefined();
    expect(
      (
        screen.getByRole("textbox", {
          name: "Поиск файлов",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
    await act(async () =>
      f.refreshing.resolve({
        path: destination,
        entries: [],
        truncated: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("status", { name: "Вставка файлов" }),
      ).toBeNull(),
    );
  },
);
it.each([false, true])(
  "waits for conflict confirmation without spinning (cancel=%s)",
  async (cancel) => {
    const f = await setup();
    f.start();
    activity("Подготавливаем вставку");
    await act(async () =>
      f.preparation.resolve({
        token: "confirmed",
        conflicts: [{ path: destination + "/a.txt", replaceable: true }],
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Файл уже существует",
    });
    expect(screen.queryByRole("status", { name: "Вставка файлов" })).toBeNull();
    expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: cancel ? "Отменить вставку" : "Заменить",
      }),
    );
    if (cancel) {
      expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("status", { name: "Вставка файлов" }),
      ).toBeNull();
    } else {
      activity("Копируем файлы");
      expect(f.api.executeOverviewPaste).toHaveBeenCalledExactlyOnceWith(
        "confirmed",
        [{ path: destination + "/a.txt", action: "replace" }],
      );
      await act(async () => f.copying.resolve(completed));
      await waitFor(() =>
        expect(
          screen.queryByRole("status", { name: "Вставка файлов" }),
        ).toBeNull(),
      );
    }
  },
);
it.each(["preparing", "copying"] as const)(
  "clears paste activity after %s errors and keeps the message readable",
  async (phase) => {
    const f = await setup();
    f.start();
    activity("Подготавливаем вставку");
    if (phase === "copying") {
      await act(async () =>
        f.preparation.resolve({ token: "failed", conflicts: [] }),
      );
      activity("Копируем файлы");
      f.api.listOverviewDirectory.mockImplementationOnce((_scope, path) => {
        expect(path).toBe("");
        return f.refreshing.promise;
      });
      await act(async () =>
        f.copying.reject(
          new Error("Не удалось скопировать файлы: доступ запрещён."),
        ),
      );
      activity("Обновляем дерево");
      await act(async () =>
        f.refreshing.resolve({ path: "", entries, truncated: false }),
      );
    } else
      await act(async () =>
        f.preparation.reject(
          new Error("Не удалось скопировать файлы: доступ запрещён."),
        ),
      );
    expect(screen.queryByRole("status", { name: "Вставка файлов" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Не удалось скопировать файлы: доступ запрещён.",
    );
  },
);
it.each(["preparing", "copying"] as const)(
  "does not re-display an old owner target or clear another view activity after late %s",
  async (phase) => {
    const owner = {
      projectId: "p",
      year: "2026",
      topic: "topic",
      branch: "topic",
      contextId: "ctx-" + "a".repeat(64),
      revision: "00000000-0000-4000-8000-000000000001",
    };
    const f = await setup(owner);
    f.start();
    activity("Подготавливаем вставку");
    if (phase === "copying")
      await act(async () =>
        f.preparation.resolve({ token: "old", conflicts: [] }),
      );
    f.view.rerender(
      <f.Wrapper
        scope={{ ...owner, revision: "00000000-0000-4000-8000-000000000002" }}
      />,
    );
    expect(screen.queryByRole("status", { name: "Вставка файлов" })).toBeNull();
    const foreignPreparation = deferred<OverviewPastePreview>();
    f.api.prepareOverviewPaste.mockImplementationOnce(
      () => foreignPreparation.promise,
    );
    // The original duplicate guard remains until the prior operation settles.
    const row = await screen.findByRole("treeitem", {
      name: "Папка назначения",
    });
    row.focus();
    fireEvent.keyDown(row, { key: "v", ctrlKey: true });
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledOnce();
    const foreign = render(
      <ProjectOverview api={f.api as any} scope="foreign" />,
    );
    const otherRow = await within(foreign.container).findByRole("treeitem", {
      name: "Папка назначения",
    });
    fireEvent.contextMenu(otherRow);
    fireEvent.click(screen.getByRole("menuitem", { name: "Вставить" }));
    const foreignStatus = within(foreign.container).getByRole("status", {
      name: "Вставка файлов",
    });
    if (phase === "copying")
      await act(async () => f.copying.resolve(completed));
    else
      await act(async () =>
        f.preparation.resolve({
          token: "old",
          conflicts: [{ path: "old/secret.txt", replaceable: true }],
        }),
      );
    expect(
      within(foreign.container).getByRole("status", { name: "Вставка файлов" }),
    ).toBe(foreignStatus);
    expect(
      within(f.view.container).queryByRole("status", {
        name: "Вставка файлов",
      }),
    ).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    if (phase === "preparing")
      expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
    await act(async () =>
      foreignPreparation.resolve({
        token: "new",
        conflicts: [{ path: "new.txt", replaceable: true }],
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить вставку" }),
    );
  },
);
it("does not resurrect paste activity when a retained view reactivates or after unmount", async () => {
  const f = await setup();
  f.start();
  activity("Подготавливаем вставку");
  f.view.rerender(<f.Wrapper active="other" />);
  expect(screen.queryByRole("status", { name: "Вставка файлов" })).toBeNull();
  await act(async () => f.preparation.resolve({ token: "old", conflicts: [] }));
  f.view.rerender(<f.Wrapper />);
  expect(screen.queryByRole("status", { name: "Вставка файлов" })).toBeNull();
  expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
  const pending = deferred<OverviewPastePreview>();
  f.api.prepareOverviewPaste.mockImplementationOnce(() => pending.promise);
  f.start();
  activity("Подготавливаем вставку");
  f.view.unmount();
  await act(async () => pending.resolve({ token: "unmounted", conflicts: [] }));
  expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
});
it("never labels ordinary copy/path-copy/refresh operations as paste", async () => {
  const f = await setup();
  const row = f.chooseTarget();
  for (const label of [
    "Копировать",
    "Скопировать относительный путь",
    "Обновить",
  ]) {
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: label }));
    expect(screen.queryByRole("status", { name: "Вставка файлов" })).toBeNull();
    await act(async () => {});
  }
  expect(f.api.copyOverviewEntries).toHaveBeenCalledOnce();
  expect(f.api.copyOverviewPaths).toHaveBeenCalledOnce();
  expect(f.api.prepareOverviewPaste).not.toHaveBeenCalled();
});
it("scopes non-selectable CSS to actual tree/search rows, not search or editor text", async () => {
  injectStyles();
  const f = await setup();
  const row = screen.getByRole("treeitem", { name: "a.txt" });
  expect(getComputedStyle(row).userSelect).toBe("none");
  fireEvent.click(row);
  const editor = await waitFor(() => {
    const el = f.view.container
      .querySelector(".yaml-code-editor")
      ?.shadowRoot?.querySelector<HTMLElement>(".cm-content");
    expect(el).not.toBeNull();
    return el!;
  });
  const input = screen.getByRole("textbox", { name: "Поиск файлов" });
  expect(getComputedStyle(input).userSelect).not.toBe("none");
  expect(getComputedStyle(editor).userSelect).not.toBe("none");
  expect(
    getComputedStyle(f.view.container.querySelector(".yaml-code-editor")!)
      .userSelect,
  ).not.toBe("none");
  fireEvent.change(input, { target: { value: "txt" } });
  const searchResults = await waitFor(() => {
    const result =
      f.view.container.querySelector<HTMLElement>(".ov-search-results");
    expect(result).not.toBeNull();
    return result!;
  });
  const searchRow = await within(searchResults).findByRole("button", {
    name: /^a\.txt/,
  });
  expect(getComputedStyle(searchRow).userSelect).toBe("none");
  expect(getComputedStyle(input).userSelect).not.toBe("none");
  expect(getComputedStyle(editor).userSelect).not.toBe("none");
});
it("spaces replacement text in explicit groups while preserving checkbox and footer controls", async () => {
  injectStyles();
  const f = await setup();
  f.start();
  await act(async () =>
    f.preparation.resolve({
      token: "spacing",
      conflicts: [
        { path: destination + "/very-long-file-name.txt", replaceable: true },
      ],
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Файл уже существует",
  });
  const text = within(dialog).getByText(
    "Объект с таким именем уже есть в папке назначения:",
  );
  const intro = text.parentElement!;
  const body = intro.parentElement!;
  expect(getComputedStyle(intro).gap).toBe("8px");
  expect(getComputedStyle(body).gap).toBe("16px");
  expect(getComputedStyle(text).lineHeight).toBe("1.55");
  for (const p of body.querySelectorAll("p"))
    expect(getComputedStyle(p).margin).toMatch(/^0(?:px)?$/);
  expect(getComputedStyle(dialog.querySelector("header")!).marginBottom).toBe(
    "18px",
  );
  const label = within(dialog)
    .getByRole("checkbox", { name: "Применить ко всем" })
    .closest("label")!;
  expect(getComputedStyle(label).display).toBe("flex");
  expect(getComputedStyle(label).gap).toBe("8px");
  expect(getComputedStyle(label).marginTop).toBe("20px");
  const footer = dialog.querySelector("footer")!;
  expect(getComputedStyle(footer).display).toBe("flex");
  expect(getComputedStyle(footer).gap).toBe("12px");
  expect(getComputedStyle(footer).marginTop).toBe("24px");
  expect(getComputedStyle(footer).flexWrap).toBe("wrap");
  expect(getComputedStyle(footer).justifyContent).toBe("flex-end");
  expect(within(footer).getAllByRole("button")).toHaveLength(3);
});
