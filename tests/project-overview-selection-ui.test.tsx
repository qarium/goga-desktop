// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectOverview } from "../src/renderer/overview/ProjectOverview";
vi.mock("../src/renderer/overview/SchemaGraph", () => ({
  SchemaGraph: () => <div>Граф</div>,
  IconButton: ({ label, children, ...props }: any) => (
    <button aria-label={label} {...props}>
      {children}
    </button>
  ),
}));
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const entries = ["a.txt", "b.txt", "c.txt"].map((path) => ({
  path,
  name: path,
  kind: "file",
}));
function setup() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const api = {
    listOverviewDirectory: vi.fn(async (_scope: unknown, path: string) => ({
      path,
      entries,
      truncated: false,
    })),
    readOverviewSchema: vi.fn(async () => []),
    readOverviewFile: vi.fn(async (_scope: unknown, path: string) => ({
      relativePath: path,
      text: path,
      version: "a".repeat(64),
      exists: true,
    })),
    searchOverviewFiles: vi.fn(async () => ({ entries, truncated: false })),
    copyOverviewEntries: vi.fn(async () => {}),
  };
  render(<ProjectOverview scope="p" api={api as any} />);
  return { api, user: userEvent.setup() };
}
it.each([false, true])(
  "preserves range/additive group through native right click and copy (search=%s)",
  async (search) => {
    const { api, user } = setup();
    if (search)
      fireEvent.change(screen.getByRole("textbox", { name: "Поиск файлов" }), {
        target: { value: "txt" },
      });
    const row = async (name: string) =>
      search
        ? screen.findByRole("button", {
            name: new RegExp("^" + name.replaceAll(".", "\\.")),
          })
        : screen.findByRole("treeitem", { name });
    const a = await row("a.txt"),
      b = await row("b.txt"),
      c = await row("c.txt");
    await user.click(a);
    await user.keyboard("{Meta>}");
    await user.click(c);
    await user.keyboard("{/Meta}");
    const selected = () =>
      search
        ? document.querySelectorAll('.ov-search-results [aria-pressed="true"]')
        : document.querySelectorAll('[role="treeitem"][aria-selected="true"]');
    expect(selected()).toHaveLength(2);
    expect(api.readOverviewFile).toHaveBeenCalledTimes(1);
    await user.pointer({ target: a, keys: "[MouseRight]" });
    await user.click(screen.getByRole("menuitem", { name: "Копировать" }));
    await waitFor(() =>
      expect(api.copyOverviewEntries).toHaveBeenLastCalledWith("p", [
        "a.txt",
        "c.txt",
      ]),
    );
    await user.keyboard("{Meta>}");
    await user.click(c);
    await user.keyboard("{/Meta}");
    expect(selected()).toHaveLength(1);
    await user.click(a);
    await user.keyboard("{Shift>}");
    await user.click(c);
    await user.keyboard("{/Shift}");
    expect(selected()).toHaveLength(3);
    expect(
      api.readOverviewFile.mock.calls.some(([, path]) => path === "b.txt"),
    ).toBe(false);
    await user.pointer({ target: b, keys: "[MouseRight]" });
    await user.click(screen.getByRole("menuitem", { name: "Копировать" }));
    await waitFor(() =>
      expect(api.copyOverviewEntries).toHaveBeenLastCalledWith("p", [
        "a.txt",
        "b.txt",
        "c.txt",
      ]),
    );
  },
);

it.each([false, true])(
  "starts the next range at an unselected context-clicked row (search=%s)",
  async (search) => {
    const { user } = setup();
    if (search)
      fireEvent.change(screen.getByRole("textbox", { name: "Поиск файлов" }), {
        target: { value: "txt" },
      });
    const row = async (name: string) =>
      screen.findByRole(search ? "button" : "treeitem", {
        name: search ? new RegExp("^" + name.replaceAll(".", "\\.")) : name,
      });
    const a = await row("a.txt"),
      b = await row("b.txt"),
      c = await row("c.txt");
    await user.click(a);
    await user.pointer({ target: c, keys: "[MouseRight]" });
    await user.keyboard("{Escape}");
    await user.keyboard("{Shift>}");
    await user.click(b);
    await user.keyboard("{/Shift}");
    const selected = document.querySelectorAll(
      search
        ? '.ov-search-results [aria-pressed="true"]'
        : '[role="treeitem"][aria-selected="true"]',
    );
    expect(selected).toHaveLength(2);
    expect([...selected].some((e) => e.textContent?.startsWith("a.txt"))).toBe(
      false,
    );
  },
);
