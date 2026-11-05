// @vitest-environment jsdom
import React, { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { OverviewFileActions } from "../src/renderer/overview/OverviewFileActions";
import { RetainedViews } from "../src/renderer/RetainedViews";
const dialogMethods = ["showModal", "close"].map(
  (name) =>
    [
      name,
      Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name),
    ] as const,
);
beforeEach(() => {
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
  for (const [name, descriptor] of dialogMethods) {
    if (descriptor)
      Object.defineProperty(HTMLDialogElement.prototype, name, descriptor);
    else delete (HTMLDialogElement.prototype as any)[name];
  }
});
function setup() {
  const api = {
    copyOverviewEntries: vi.fn(async (_s: any, _paths: any) => {}),
    prepareOverviewPaste: vi.fn(async (_s: any, _dest: any) => ({
      token: "paste-token",
      conflicts: [] as { path: string; replaceable: boolean }[],
    })),
    executeOverviewPaste: vi.fn(
      async (
        _token: string,
        _decisions: { path: string; action: string }[],
      ) => ({
        status: "done",
        completedPaths: ["target/new"],
        touchedPaths: ["target/new"],
        message: "Готово",
      }),
    ),
  };
  const store = {
    getSnapshot: () => ({
      order: [],
      files: {},
      directories: {
        "": {
          entries: [
            { path: "folder", kind: "directory" },
            { path: "file", kind: "file" },
          ],
        },
      },
    }),
    applyPaste: vi.fn(async () => {}),
    refreshAll: vi.fn(async () => {}),
  };
  const props = {
    api,
    store,
    scope: "p",
    treeScope: "slice",
    selectedPaths: ["file"],
    onCloseMenu: vi.fn(),
    onCreate: vi.fn(),
    onNavigate: vi.fn(),
    onBusy: vi.fn(),
    menu: null,
  } as any;
  function Wrapper({
    options = props,
    active = "tree",
  }: {
    options?: any;
    active?: string;
  }) {
    const filePaneRef = useRef<HTMLElement>(null);
    return (
      <RetainedViews activeKey={active}>
        {
          <div key={active}>
            {active === "tree" ? (
              <>
                {options.filePaneVisible !== false && (
                  <aside ref={filePaneRef} tabIndex={-1} data-testid="pane">
                    <div role="tree" tabIndex={0}>
                      Файлы
                    </div>
                    <input aria-label="Поиск файлов" />
                  </aside>
                )}
                <OverviewFileActions {...options} filePaneRef={filePaneRef} />
              </>
            ) : (
              <p>Другой раздел</p>
            )}
          </div>
        }
      </RetainedViews>
    );
  }
  const view = render(<Wrapper />);
  return { api, store, props, Wrapper, view };
}
it("adds actual Copy/Paste separately from text path copying, without reading clipboard on menu open", async () => {
  const f = setup();
  f.view.rerender(
    <f.Wrapper
      options={{
        ...f.props,
        workspacePath: "/clone",
        menu: {
          paths: ["file"],
          entry: { path: "file", kind: "file" },
          parent: "",
          x: 0,
          y: 0,
        },
      }}
    />,
  );
  expect(f.api.prepareOverviewPaste).not.toHaveBeenCalled();
  expect(
    screen.getByRole("menuitem", { name: "Скопировать полный путь" }),
  ).toBeDefined();
  fireEvent.click(screen.getByRole("menuitem", { name: "Копировать" }));
  await waitFor(() =>
    expect(f.api.copyOverviewEntries).toHaveBeenCalledExactlyOnceWith("p", [
      "file",
    ]),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Вставить" }));
  await waitFor(() =>
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith("p", ""),
  );
});
it.each([false, true])(
  "handles Ctrl/Meta+C,V only inside focused tree and prevents native duplicate events (meta=%s)",
  async (metaKey) => {
    const f = setup();
    const tree = screen.getByRole("tree");
    tree.focus();
    const modifiers = { metaKey, ctrlKey: !metaKey };
    expect(fireEvent.keyDown(tree, { key: "c", ...modifiers })).toBe(false);
    await waitFor(() =>
      expect(f.api.copyOverviewEntries).toHaveBeenCalledExactlyOnceWith("p", [
        "file",
      ]),
    );
    expect(fireEvent.keyDown(tree, { key: "v", ...modifiers })).toBe(false);
    await waitFor(() =>
      expect(f.api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith(
        "p",
        "",
      ),
    );
    const input = screen.getByRole("textbox");
    input.focus();
    expect(fireEvent.keyDown(input, { key: "v", ...modifiers })).toBe(true);
    expect(fireEvent.paste(input)).toBe(true);
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledOnce();
  },
);
it("supports native Edit-menu copy/paste events without a preceding keydown", async () => {
  const f = setup();
  const tree = screen.getByRole("tree");
  tree.focus();
  expect(fireEvent.copy(tree)).toBe(false);
  await waitFor(() => expect(f.api.copyOverviewEntries).toHaveBeenCalledOnce());
  expect(fireEvent.paste(tree)).toBe(false);
  await waitFor(() =>
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledOnce(),
  );
  expect(f.store.applyPaste).toHaveBeenCalledWith(["target/new"], "p");
});
it.each([
  { selectedPaths: ["folder"], dest: "folder" },
  { selectedPaths: ["file"], dest: "" },
  { selectedPaths: ["folder", "file"], dest: "slice" },
  { selectedPaths: [], dest: "slice" },
])(
  "chooses the immutable paste destination $dest",
  async ({ selectedPaths, dest }) => {
    const f = setup();
    f.view.rerender(<f.Wrapper options={{ ...f.props, selectedPaths }} />);
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.paste(tree);
    await waitFor(() =>
      expect(f.api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith(
        "p",
        dest,
      ),
    );
  },
);
it("refreshes partial/uncertain copies and displays their message instead of hiding new entries", async () => {
  const f = setup();
  f.api.executeOverviewPaste.mockResolvedValueOnce({
    status: "partial",
    completedPaths: [],
    touchedPaths: ["partial"],
    message: "Часть папки создана",
  });
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  await screen.findByRole("alert");
  expect(f.store.applyPaste).toHaveBeenCalledWith(["partial"], "p");
  expect(screen.getByRole("alert").textContent).toContain(
    "Часть папки создана",
  );
});
it("retains the submitted owner/store across late completion without refreshing another workspace", async () => {
  const f = setup();
  let release!: (v: any) => void;
  f.api.executeOverviewPaste.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  const otherStore = { ...f.store, applyPaste: vi.fn(async () => {}) };
  f.view.rerender(
    <f.Wrapper
      options={{
        ...f.props,
        scope: "other",
        store: otherStore,
        selectedPaths: ["folder"],
      }}
    />,
  );
  release({
    status: "done",
    completedPaths: ["new"],
    touchedPaths: ["new"],
    message: "done",
  });
  await waitFor(() =>
    expect(f.store.applyPaste).toHaveBeenCalledWith(["new"], "p"),
  );
  expect(otherStore.applyPaste).not.toHaveBeenCalled();
  expect(f.api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith("p", "");
});
it("does not handle paste in a retained hidden view", async () => {
  const f = setup();
  const tree = screen.getByRole("tree");
  tree.focus();
  f.view.rerender(<f.Wrapper active="other" />);
  fireEvent.paste(tree);
  fireEvent.keyDown(tree, { key: "v", ctrlKey: true });
  expect(f.api.prepareOverviewPaste).not.toHaveBeenCalled();
});

it("reattaches clipboard shortcuts after the file tree is hidden and restored", async () => {
  const f = setup();
  f.view.rerender(
    <f.Wrapper options={{ ...f.props, filePaneVisible: false }} />,
  );
  expect(screen.queryByRole("tree")).toBeNull();
  f.view.rerender(
    <f.Wrapper options={{ ...f.props, filePaneVisible: true }} />,
  );
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  await waitFor(() =>
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith("p", ""),
  );
});
it("uses current tree scope for a multi-selection menu rather than a random selected row's parent", async () => {
  const f = setup();
  f.view.rerender(
    <f.Wrapper
      options={{
        ...f.props,
        menu: {
          paths: ["other/a", "elsewhere/b"],
          entry: { path: "other/a", kind: "file" },
          parent: "other",
          x: 0,
          y: 0,
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Вставить" }));
  await waitFor(() =>
    expect(f.api.prepareOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "p",
      "slice",
    ),
  );
});

it("asks before replacement, applies file choices to all and executes the captured token once", async () => {
  const f = setup();
  f.api.prepareOverviewPaste.mockResolvedValueOnce({
    token: "captured",
    conflicts: [
      { path: "target/a", replaceable: true },
      { path: "target/b", replaceable: true },
    ],
  });
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  const dialog = await screen.findByRole("dialog", {
    name: "Файл уже существует",
  });
  expect(dialog.textContent).toContain("target/a");
  expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Применить ко всем" }));
  fireEvent.click(screen.getByRole("button", { name: "Заменить" }));
  await waitFor(() =>
    expect(f.api.executeOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "captured",
      [
        { path: "target/a", action: "replace" },
        { path: "target/b", action: "replace" },
      ],
    ),
  );
  expect(f.api.prepareOverviewPaste).toHaveBeenCalledOnce();
});
it("cancelled replacement performs no mutation and another paste is usable", async () => {
  const f = setup();
  f.api.prepareOverviewPaste.mockResolvedValueOnce({
    token: "cancelled",
    conflicts: [{ path: "target/a", replaceable: true }],
  });
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  fireEvent.click(
    await screen.findByRole("button", { name: "Отменить вставку" }),
  );
  expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
  tree.focus();
  fireEvent.paste(tree);
  await waitFor(() =>
    expect(f.api.executeOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "paste-token",
      [],
    ),
  );
});
it("skips a type collision rather than offering replacement and keeps the other file choice", async () => {
  const f = setup();
  f.api.prepareOverviewPaste.mockResolvedValueOnce({
    token: "types",
    conflicts: [
      { path: "target/folder", replaceable: false },
      { path: "target/a", replaceable: true },
    ],
  });
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  expect(
    (
      (await screen.findByRole("button", {
        name: "Заменить",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
  fireEvent.click(await screen.findByRole("button", { name: "Заменить" }));
  await waitFor(() =>
    expect(f.api.executeOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "types",
      [
        { path: "target/folder", action: "skip" },
        { path: "target/a", action: "replace" },
      ],
    ),
  );
});
it("does not show or execute a late prepared paste in a different owner", async () => {
  const f = setup();
  let release!: (v: any) => void;
  f.api.prepareOverviewPaste.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  await waitFor(() => expect(release).toBeTypeOf("function"));
  f.view.rerender(<f.Wrapper options={{ ...f.props, scope: "other" }} />);
  release({ token: "old", conflicts: [{ path: "a", replaceable: true }] });
  await waitFor(() => expect(f.props.onBusy).toHaveBeenLastCalledWith(false));
  expect(f.api.executeOverviewPaste).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("protects an open dirty target and permits skipping it without discarding the draft", async () => {
  const f = setup();
  f.api.prepareOverviewPaste.mockResolvedValueOnce({
    token: "dirty",
    conflicts: [{ path: "file", replaceable: true }],
  });
  f.store.getSnapshot = () =>
    ({
      order: ["file"],
      files: {
        file: { text: "my draft", document: { text: "disk" }, busy: false },
      },
      directories: {},
    }) as any;
  const tree = screen.getByRole("tree");
  tree.focus();
  fireEvent.paste(tree);
  expect(
    (
      (await screen.findByRole("button", {
        name: "Заменить",
      })) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByRole("dialog").textContent).toMatch(/несохран/i);
  fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
  await waitFor(() =>
    expect(f.api.executeOverviewPaste).toHaveBeenCalledExactlyOnceWith(
      "dirty",
      [{ path: "file", action: "skip" }],
    ),
  );
  expect((f.store.getSnapshot().files as any).file.text).toBe("my draft");
});
