// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HistoryDocument } from "../src/renderer/HistoryDocument";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return (this as HTMLElement).classList.contains("main-area")
        ? {
            x: 236,
            y: 52,
            left: 236,
            top: 52,
            right: 1200,
            bottom: 800,
            width: 964,
            height: 748,
            toJSON() {},
          }
        : {
            x: 0,
            y: 0,
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0,
            toJSON() {},
          };
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const positions = new Map();
function Fixture({
  active = true,
  identity = "one",
  ready = true,
  readable = true,
  error = false,
}) {
  return (
    <main className="main-area">
      <HistoryDocument
        identity={identity}
        active={active}
        ready={ready}
        readable={readable}
        positions={positions}
        title="plan.md"
        format="MARKDOWN"
        contextLabel="2026 / alpha"
      >
        {error ? <p role="alert">Нет доступа</p> : <p>Текст документа</p>}
      </HistoryDocument>
    </main>
  );
}
it("expands within main-area without replacing document DOM and returns focus on Escape", () => {
  render(<Fixture />);
  const text = screen.getByText("Текст документа");
  const expand = screen.getByRole("button", { name: "Развернуть документ" });
  fireEvent.click(expand);
  const dialog = screen.getByRole("dialog", { name: "Просмотр plan.md" });
  expect(dialog.style.left).toBe("236px");
  expect(dialog.style.top).toBe("52px");
  expect(dialog.style.width).toBe("964px");
  expect(dialog.style.height).toBe("748px");
  expect(screen.getByText("Текст документа")).toBe(text);
  fireEvent(dialog, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Текст документа")).toBe(text);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Развернуть документ" }),
  );
});
it("Escape collapses only the reader, restores the enclosing card, and cleanup releases it", () => {
  const cancelled = vi.fn();
  const view = render(
    <main className="main-area">
      <dialog open className="topic-dialog" onCancel={cancelled}>
        <Fixture />
      </dialog>
    </main>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  const reader = screen.getByRole("dialog", { name: "Просмотр plan.md" });
  const card = reader.closest(".topic-dialog")!;
  expect(card.classList.contains("history-reader-parent")).toBe(true);
  fireEvent(reader, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(cancelled).not.toHaveBeenCalled();
  expect(card.classList.contains("history-reader-parent")).toBe(false);
  expect((card as HTMLDialogElement).open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  view.unmount();
  expect(card.classList.contains("history-reader-parent")).toBe(false);
});
it("collapses on owner/file change or inactive view, never restoring an old expanded context", () => {
  const view = render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  view.rerender(<Fixture identity="two" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  view.rerender(<Fixture identity="two" active={false} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<Fixture identity="two" />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("leaves collapse available during loading/error and excludes unsupported files", () => {
  const view = render(<Fixture ready={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  view.rerender(<Fixture ready={false} error />);
  expect(screen.getByRole("alert").textContent).toBe("Нет доступа");
  const collapse = screen.getByRole("button", { name: "Свернуть документ" });
  expect((collapse as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(collapse);
  view.rerender(<Fixture readable={false} />);
  expect(
    screen.queryByRole("button", { name: "Развернуть документ" }),
  ).toBeNull();
});

it("updates bounds on resize and keeps the original geometry source", () => {
  render(<Fixture />);
  const main = document.querySelector(".main-area")!;
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  vi.spyOn(main, "getBoundingClientRect").mockReturnValue({
    left: 62,
    top: 52,
    width: 738,
    height: 548,
  } as DOMRect);
  fireEvent(window, new Event("resize"));
  const reader = screen.getByRole("dialog");
  expect(reader.style.left).toBe("62px");
  expect(reader.style.width).toBe("738px");
  expect(reader.style.height).toBe("548px");
});
it("falls back to in-flow reading if modal opening fails", () => {
  HTMLDialogElement.prototype.showModal = () => {
    throw Error("cannot open");
  };
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "Обычный просмотр доступен",
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("Текст документа")).toBeTruthy();
});

it("does not replace saved positions with detached offsets during invalidation", () => {
  positions.clear();
  const view = render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  positions.set("one", { top: 700, left: 0 });
  view.rerender(<Fixture active={false} />);
  expect(positions.get("one")).toEqual({ top: 700, left: 0 });
});

it("resolves a sibling selector card through its own app shell, never another workspace", () => {
  const view = render(
    <>
      <main className="main-area" data-testid="unrelated" />
      <div className="app-shell">
        <main className="main-area" data-testid="workspace" />
        <dialog open className="topic-dialog">
          <HistoryDocument
            identity="card"
            active
            ready
            readable
            positions={new Map()}
            title="plan.md"
            format="MARKDOWN"
            contextLabel="alpha"
          >
            Card document
          </HistoryDocument>
        </dialog>
      </div>
    </>,
  );
  vi.spyOn(
    screen.getByTestId("workspace"),
    "getBoundingClientRect",
  ).mockReturnValue({ left: 74, top: 52, width: 900, height: 600 } as DOMRect);
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  const reader = screen.getByRole("dialog", { name: "Просмотр plan.md" });
  expect(reader.style.left).toBe("74px");
  expect(reader.style.width).toBe("900px");
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent(reader, new Event("cancel", { bubbles: true, cancelable: true }));
  expect(document.querySelector(".topic-dialog")?.hasAttribute("open")).toBe(
    true,
  );
  view.unmount();
});
