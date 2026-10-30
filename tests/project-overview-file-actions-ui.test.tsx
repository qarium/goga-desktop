// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { OverviewFileActions } from "../src/renderer/overview/OverviewFileActions";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(paths = ["src/a.ts", "src/b.ts"]) {
  const api = {
    prepareOverviewFileAction: vi.fn(async (_s: any, r: any) => ({
      token: "ticket",
      kind: r.kind,
      paths: r.paths ?? [r.path],
      destination: r.destination,
    })),
    executeOverviewFileAction: vi.fn(async () => ({
      status: "done",
      completedPaths: paths,
      message: "Готово",
    })),
    revealOverviewEntry: vi.fn(async () => {}),
  };
  const store = {
    getSnapshot: () => ({
      files: { "src/a.ts": { text: "draft", document: { text: "disk" } } },
      order: ["src/a.ts"],
    }),
    applyFileAction: vi.fn(async () => {}),
    loadDirectory: vi.fn(async () => {}),
    refreshAll: vi.fn(async () => {}),
  };
  const create = vi.fn(),
    navigate = vi.fn(),
    close = vi.fn();
  const props = {
    api: api as any,
    scope: "p",
    store: store as any,
    menu: {
      paths,
      x: 20,
      y: 30,
      entry: { path: paths[0], name: "a.ts", kind: "file" as const },
      parent: "src",
    },
    onCloseMenu: close,
    onCreate: create,
    onNavigate: navigate,
    onBusy: vi.fn(),
  };
  const view = render(<OverviewFileActions {...props} />);
  return { api, store, view, props, create, navigate, close };
}
it("confirms multiple trash paths with dirty notice before executing, retaining the draft", async () => {
  const f = setup();
  fireEvent.click(screen.getByRole("menuitem", { name: /Корзину/ }));
  const dialog = await screen.findByRole("dialog", {
    name: "Переместить в Корзину?",
  });
  expect(dialog.textContent).toContain("src/a.ts");
  expect(dialog.textContent).toContain("src/b.ts");
  expect(dialog.textContent).toContain("Несохранённый текст");
  expect(f.api.executeOverviewFileAction).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Переместить в Корзину" }),
  );
  await waitFor(() =>
    expect(f.api.executeOverviewFileAction).toHaveBeenCalledWith("ticket"),
  );
  expect(f.store.applyFileAction).toHaveBeenCalledWith(
    "trash",
    ["src/a.ts", "src/b.ts"],
    undefined,
  );
});
it("opens folder creation and graph navigation at the right-clicked folder, not the current slice", () => {
  const f = setup(["src"]);
  f.view.rerender(
    <OverviewFileActions
      {...f.props}
      menu={{
        ...f.props.menu,
        entry: { path: "src", name: "src", kind: "directory" },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Создать файл" }));
  expect(f.create).toHaveBeenCalledWith("file", "src");
  fireEvent.click(screen.getByRole("menuitem", { name: "Показать на схеме" }));
  expect(f.navigate).toHaveBeenCalledWith("src");
});
it("never executes an old preview after context revision changes", async () => {
  const f = setup();
  fireEvent.click(screen.getByRole("menuitem", { name: /Корзину/ }));
  await screen.findByRole("dialog");
  f.view.rerender(
    <OverviewFileActions
      {...f.props}
      scope={{
        projectId: "p",
        year: "2026",
        topic: "t",
        branch: "t",
        contextId: "ctx-a",
        revision: "next",
      }}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(f.api.executeOverviewFileAction).not.toHaveBeenCalled();
});
it("renames only after explicit confirmation and refreshes the open draft via the successful result", async () => {
  const f = setup(["src/a.ts"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Переименовать" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Новое имя" }), {
    target: { value: "next.ts" },
  });
  expect(f.api.executeOverviewFileAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Переименовать" }));
  await waitFor(() =>
    expect(f.api.prepareOverviewFileAction).toHaveBeenCalledWith("p", {
      kind: "rename",
      path: "src/a.ts",
      destination: "src/next.ts",
    }),
  );
  await waitFor(() =>
    expect(f.store.applyFileAction).toHaveBeenCalledWith(
      "rename",
      ["src/a.ts"],
      "src/next.ts",
    ),
  );
});
it("refuses rename into an already open destination before calling Host", async () => {
  const f = setup(["src/b.ts"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Переименовать" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Новое имя" }), {
    target: { value: "a.ts" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Переименовать" }));
  await screen.findByRole("alert");
  expect(f.api.prepareOverviewFileAction).not.toHaveBeenCalled();
  expect(f.api.executeOverviewFileAction).not.toHaveBeenCalled();
});
it("copies full paths only on request, using the current workspace rather than the primary project", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const f = setup(["src/a.ts"]);
  f.view.rerender(
    <OverviewFileActions {...f.props} workspacePath="/fixture/main project/" />,
  );
  expect(writeText).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Скопировать полный путь" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(
      "/fixture/main project/src/a.ts",
    ),
  );
  f.view.rerender(
    <OverviewFileActions
      {...f.props}
      workspacePath="/fixture/clones/топик"
      scope={{
        projectId: "p",
        year: "2026",
        topic: "t",
        branch: "t",
        contextId: "ctx",
        revision: "r",
      }}
      menu={{ ...f.props.menu, paths: ["src/a.ts", "src/b.ts"] }}
    />,
  );
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Скопировать полные пути" }),
  );
  await waitFor(() =>
    expect(writeText).toHaveBeenLastCalledWith(
      "/fixture/clones/топик/src/a.ts\n/fixture/clones/топик/src/b.ts",
    ),
  );
  expect(f.api.prepareOverviewFileAction).not.toHaveBeenCalled();
  expect(f.api.executeOverviewFileAction).not.toHaveBeenCalled();
});
