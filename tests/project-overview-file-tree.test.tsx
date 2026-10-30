// @vitest-environment jsdom
import React, { useState } from "react";
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
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
import { FileTree } from "../src/renderer/overview/FileTree";
afterEach(cleanup);
function setup(hasContract = false) {
  const folder = vi.fn(),
    file = vi.fn(),
    navigate = vi.fn(),
    menu = vi.fn(),
    contract = vi.fn();
  function Tree() {
    const [selected, setSelected] = useState<string[]>([]);
    const [expanded, setExpanded] = useState<string[]>([]);
    return (
      <FileTree
        scope=""
        directories={{
          "": {
            path: "",
            truncated: false,
            entries: [
              { path: "src", name: "src", kind: "directory" },
              { path: "a.ts", name: "a.ts", kind: "file" },
              { path: "b.ts", name: "b.ts", kind: "file" },
            ],
          },
        }}
        expanded={expanded}
        setExpanded={setExpanded}
        selection={null}
        selectedPaths={selected}
        onSelectedPaths={setSelected}
        onFile={file}
        onFolder={folder}
        onNavigate={navigate}
        onContextMenu={menu}
        onContract={contract}
        hasContract={() => hasContract}
        load={async () => {}}
        dirty={[]}
      />
    );
  }
  render(<Tree />);
  return { folder, file, navigate, menu, contract };
}
it("supports additive and range selection without opening modifier-clicked files", () => {
  const f = setup();
  fireEvent.click(screen.getByText("a.ts"));
  fireEvent.click(screen.getByText("b.ts"), { metaKey: true });
  expect(document.querySelectorAll(".ov-tree-selected")).toHaveLength(2);
  expect(f.file).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("a.ts"), { ctrlKey: true });
  expect(document.querySelectorAll(".ov-tree-selected")).toHaveLength(1);
  fireEvent.click(screen.getByText("src"));
  fireEvent.click(screen.getByText("b.ts"), { shiftKey: true });
  expect(document.querySelectorAll(".ov-tree-selected")).toHaveLength(3);
});
it("navigates folders on double click, keeps right-click selection, and exposes keyboard menu", () => {
  const f = setup();
  fireEvent.click(screen.getByText("src"));
  expect(f.folder).toHaveBeenCalledWith("src");
  expect(f.navigate).not.toHaveBeenCalled();
  fireEvent.doubleClick(screen.getByText("src"));
  expect(f.navigate).toHaveBeenCalledWith("src");
  fireEvent.click(screen.getByText("a.ts"));
  fireEvent.click(screen.getByText("b.ts"), { metaKey: true });
  fireEvent.contextMenu(screen.getByText("a.ts"), {
    clientX: 150,
    clientY: 200,
  });
  expect(f.menu).toHaveBeenLastCalledWith(
    expect.objectContaining({ paths: ["a.ts", "b.ts"], x: 150, y: 200 }),
  );
  fireEvent.keyDown(screen.getByText("src").closest(".ov-tree-row")!, {
    key: "F10",
    shiftKey: true,
  });
  expect(f.menu).toHaveBeenLastCalledWith(
    expect.objectContaining({ paths: ["src"] }),
  );
});
it.each([true, false])(
  "shows a direct graph action without toggling or opening the folder contract (contract=%s)",
  (hasContract) => {
    const f = setup(hasContract);
    const action = screen.queryByRole("button", {
      name: "Показать папку src на схеме",
    });
    if (!hasContract) {
      expect(action).toBeNull();
      return;
    }
    expect(action).toBeTruthy();
    fireEvent.click(action!);
    expect(f.navigate).toHaveBeenCalledExactlyOnceWith("src");
    expect(f.folder).not.toHaveBeenCalled();
    expect(f.contract).not.toHaveBeenCalled();
    expect(
      document.querySelector(".ov-tree-row")?.getAttribute("aria-expanded"),
    ).toBe("false");
    const contract = screen.queryByRole("button", {
      name: "Показать контракт папки src",
    });
    if (hasContract) expect(contract?.nextElementSibling).toBe(action);
    else expect(contract).toBeNull();
  },
);
