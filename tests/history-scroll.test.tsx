// @vitest-environment jsdom
import React from "react";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  HistoryScrollPane,
  type HistoryScrollPositions,
} from "../src/renderer/HistoryScrollPane";

const originalTop = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTop",
)!;
const originalLeft = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollLeft",
)!;
let height = 1200;
let width = 800;
let observers: Array<{
  callback: ResizeObserverCallback;
  disconnect: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
}>;
beforeEach(() => {
  height = 1200;
  width = 800;
  observers = [];
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => height,
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
    () => width,
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const tops = new WeakMap<HTMLElement, number>();
  const lefts = new WeakMap<HTMLElement, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return tops.get(this) ?? 0;
    },
    set(value: number) {
      tops.set(this, Math.max(0, Math.min(value, height - 200)));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
    configurable: true,
    get() {
      return lefts.get(this) ?? 0;
    },
    set(value: number) {
      lefts.set(this, Math.max(0, Math.min(value, width - 300)));
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      observe = vi.fn();
      constructor(public callback: ResizeObserverCallback) {
        observers.push(this);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalTop)
    Object.defineProperty(HTMLElement.prototype, "scrollTop", originalTop);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  if (originalLeft)
    Object.defineProperty(HTMLElement.prototype, "scrollLeft", originalLeft);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollLeft");
});
function resize() {
  act(() => {
    for (const observer of observers)
      observer.callback([], observer as unknown as ResizeObserver);
  });
}
function pane(
  positions: HistoryScrollPositions,
  positionKey = "A",
  active = true,
  showTopButton = true,
) {
  return (
    <HistoryScrollPane
      positions={positions}
      positionKey={positionKey}
      active={active}
      label="Документ"
      showTopButton={showTopButton}
    >
      <p>Содержимое</p>
    </HistoryScrollPane>
  );
}
function scroll(region: HTMLElement, top: number, left = 0) {
  fireEvent.wheel(region);
  region.scrollTop = top;
  region.scrollLeft = left;
  fireEvent.scroll(region);
}
it("restores the saved document position on mount without stealing focus", () => {
  const positions: HistoryScrollPositions = new Map([
    ["A", { top: 640, left: 85 }],
  ]);
  const focus = document.activeElement;
  render(pane(positions));
  const region = screen.getByRole("region", { name: "Документ" });
  expect(region.scrollTop).toBe(640);
  expect(region.scrollLeft).toBe(85);
  expect(region.tabIndex).toBe(0);
  expect(document.activeElement).toBe(focus);
});
it("keeps independent A → B → A positions and resets an unseen key", () => {
  const positions: HistoryScrollPositions = new Map();
  const view = render(pane(positions));
  const region = screen.getByRole("region");
  scroll(region, 550, 70);
  view.rerender(pane(positions, "B"));
  expect(region.scrollTop).toBe(0);
  expect(region.scrollLeft).toBe(0);
  scroll(region, 90, 20);
  view.rerender(pane(positions));
  expect(region.scrollTop).toBe(550);
  expect(region.scrollLeft).toBe(70);
  expect(positions.get("B")).toEqual({ top: 90, left: 20 });
});
it("retains unreachable offsets through asynchronous content expansion", () => {
  height = 200;
  width = 300;
  const positions: HistoryScrollPositions = new Map([
    ["A", { top: 700, left: 100 }],
  ]);
  render(pane(positions));
  const region = screen.getByRole("region");
  fireEvent.scroll(region);
  height = 500;
  resize();
  expect(region.scrollTop).toBe(300);
  fireEvent.scroll(region);
  expect(positions.get("A")).toEqual({ top: 700, left: 100 });
  height = 1200;
  width = 800;
  resize();
  expect(region.scrollTop).toBe(700);
  expect(region.scrollLeft).toBe(100);
  expect(observers[0].observe).toHaveBeenCalledTimes(2);
});
it.each(["wheel", "key", "pointer", "touch"])(
  "cancels pending restoration on manual %s input",
  (input) => {
    height = 400;
    const positions: HistoryScrollPositions = new Map([
      ["A", { top: 700, left: 0 }],
    ]);
    render(pane(positions));
    const region = screen.getByRole("region");
    if (input === "wheel") fireEvent.wheel(region);
    if (input === "key") fireEvent.keyDown(region, { key: "PageUp" });
    if (input === "pointer") fireEvent.pointerDown(region);
    if (input === "touch") fireEvent.touchStart(region);
    region.scrollTop = 65;
    fireEvent.scroll(region);
    height = 1200;
    resize();
    expect(region.scrollTop).toBe(65);
    expect(positions.get("A")).toEqual({ top: 65, left: 0 });
  },
);
it("ignores unrelated keys while waiting for content", () => {
  height = 200;
  const positions: HistoryScrollPositions = new Map([
    ["A", { top: 700, left: 0 }],
  ]);
  render(pane(positions));
  const region = screen.getByRole("region");
  fireEvent.keyDown(region, { key: "a" });
  height = 1200;
  resize();
  expect(region.scrollTop).toBe(700);
});
it("does not overwrite saved offsets on inactive events, reactivation or unmount", () => {
  const positions: HistoryScrollPositions = new Map();
  const view = render(pane(positions));
  const region = screen.getByRole("region");
  scroll(region, 620);
  view.rerender(pane(positions, "A", false));
  scroll(region, 0);
  height = 200;
  resize();
  expect(positions.get("A")).toEqual({ top: 620, left: 0 });
  view.rerender(pane(positions));
  fireEvent.scroll(region);
  view.unmount();
  expect(
    observers.every((observer) => observer.disconnect.mock.calls.length > 0),
  ).toBe(true);
  expect(positions.get("A")).toEqual({ top: 620, left: 0 });
  height = 1200;
  render(pane(positions));
  expect(screen.getByRole("region").scrollTop).toBe(620);
});
it("ignores delayed reset events after a key change", () => {
  const positions: HistoryScrollPositions = new Map([
    ["B", { top: 300, left: 0 }],
  ]);
  const view = render(pane(positions));
  const region = screen.getByRole("region");
  scroll(region, 800);
  view.rerender(pane(positions, "B"));
  region.scrollTop = 0;
  fireEvent.scroll(region);
  expect(positions.get("A")).toEqual({ top: 800, left: 0 });
  expect(positions.get("B")).toEqual({ top: 300, left: 0 });
  resize();
  expect(region.scrollTop).toBe(300);
});
it("ignores a layout clamp after user scrolling without saving zero on cleanup", () => {
  const positions: HistoryScrollPositions = new Map();
  const view = render(pane(positions));
  const region = screen.getByRole("region");
  scroll(region, 800);
  height = 200;
  region.scrollTop = 0;
  fireEvent.scroll(region);
  resize();
  view.unmount();
  expect(positions.get("A")).toEqual({ top: 800, left: 0 });
});
it("top button is outside the scroller, keeps focus and only clears its own position", async () => {
  const positions: HistoryScrollPositions = new Map([
    ["A", { top: 700, left: 40 }],
    ["tree", { top: 350, left: 0 }],
  ]);
  render(
    <>
      {pane(positions)}
      <HistoryScrollPane
        positions={positions}
        positionKey="tree"
        active
        label="Дерево"
      >
        <p>Файлы</p>
      </HistoryScrollPane>
    </>,
  );
  const documentRegion = screen.getByRole("region", { name: "Документ" });
  const treeRegion = screen.getByRole("region", { name: "Дерево" });
  const button = screen.getByRole("button", { name: "Наверх" });
  expect(documentRegion.contains(button)).toBe(false);
  button.focus();
  await userEvent.keyboard("{Enter}");
  expect(document.activeElement).toBe(button);
  expect(documentRegion.scrollTop).toBe(0);
  expect(documentRegion.scrollLeft).toBe(0);
  expect(treeRegion.scrollTop).toBe(350);
  expect(positions.get("A")).toEqual({ top: 0, left: 0 });
  expect(positions.get("tree")).toEqual({ top: 350, left: 0 });
  resize();
  expect(documentRegion.scrollTop).toBe(0);
});
it("still restores and records positions when ResizeObserver is unavailable", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  const positions: HistoryScrollPositions = new Map([
    ["A", { top: 700, left: 0 }],
  ]);
  const view = render(pane(positions));
  const region = screen.getByRole("region");
  expect(region.scrollTop).toBe(700);
  scroll(region, 200);
  view.unmount();
  expect(positions.get("A")).toEqual({ top: 200, left: 0 });
});
it("restores when a retained pane becomes active again without remounting", () => {
  const positions: HistoryScrollPositions = new Map();
  const view = render(pane(positions));
  const region = screen.getByRole("region");
  scroll(region, 610, 35);
  view.rerender(pane(positions, "A", false));
  region.scrollTop = 0;
  fireEvent.scroll(region);
  view.rerender(pane(positions));
  expect(region.scrollTop).toBe(610);
  expect(region.scrollLeft).toBe(35);
});
it("does not restore or record an initially inactive pane", () => {
  const positions: HistoryScrollPositions = new Map([
    ["A", { top: 700, left: 0 }],
  ]);
  const view = render(pane(positions, "A", false));
  const region = screen.getByRole("region");
  expect(region.scrollTop).toBe(0);
  scroll(region, 50);
  resize();
  expect(positions.get("A")).toEqual({ top: 700, left: 0 });
  view.rerender(pane(positions));
  expect(region.scrollTop).toBe(700);
});
it("manual intent cancels pending restoration even if no scroll event follows", () => {
  height = 200;
  const positions: HistoryScrollPositions = new Map([
    ["A", { top: 700, left: 0 }],
  ]);
  render(pane(positions));
  const region = screen.getByRole("region");
  fireEvent.wheel(region);
  height = 1200;
  resize();
  expect(region.scrollTop).toBe(0);
});

it.each([false, true])(
  "records focus scrolling after keyboard Tab navigation (reverse=%s)",
  async (shift) => {
    const positions: HistoryScrollPositions = new Map([
      ["tree", { top: 700, left: 0 }],
    ]);
    render(
      <HistoryScrollPane
        positions={positions}
        positionKey="tree"
        active
        label="Дерево"
      >
        <button>Первый файл</button>
        <button>Второй файл</button>
      </HistoryScrollPane>,
    );
    const region = screen.getByRole("region");
    const first = screen.getByRole("button", { name: "Первый файл" });
    const second = screen.getByRole("button", { name: "Второй файл" });
    (shift ? second : first).focus();
    await userEvent.tab({ shift });
    expect(document.activeElement).toBe(shift ? first : second);
    // jsdom does not lay out focused controls; simulate the browser's focus scroll.
    region.scrollTop = 120;
    fireEvent.scroll(region);
    expect(positions.get("tree")).toEqual({ top: 120, left: 0 });
    resize();
    expect(region.scrollTop).toBe(120);
  },
);
it("does not treat programmatic focus alone as manual scrolling", () => {
  const positions: HistoryScrollPositions = new Map([
    ["tree", { top: 700, left: 0 }],
  ]);
  render(
    <HistoryScrollPane
      positions={positions}
      positionKey="tree"
      active
      label="Дерево"
    >
      <button>Файл</button>
    </HistoryScrollPane>,
  );
  const region = screen.getByRole("region");
  screen.getByRole("button", { name: "Файл" }).focus();
  region.scrollTop = 0;
  fireEvent.scroll(region);
  expect(positions.get("tree")).toEqual({ top: 700, left: 0 });
});

it("preserves the visible Markdown block across a layout transaction and updates restoration", () => {
  const ref =
    React.createRef<
      import("../src/renderer/HistoryScrollPane").HistoryScrollHandle
    >();
  const positions = new Map();
  render(
    <HistoryScrollPane
      ref={ref}
      positionKey="read"
      positions={positions}
      active
      label="Reader"
    >
      <div className="history-markdown">
        <p>First</p>
        <p>Second</p>
      </div>
    </HistoryScrollPane>,
  );
  const region = screen.getByRole("region", { name: "Reader" });
  region.scrollTop = 100;
  const first = screen.getByText("First"),
    second = screen.getByText("Second");
  vi.spyOn(region, "getBoundingClientRect").mockReturnValue({
    top: 0,
  } as DOMRect);
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue({
    top: -80,
    bottom: -10,
  } as DOMRect);
  let y = -10;
  vi.spyOn(second, "getBoundingClientRect").mockImplementation(
    () => ({ top: y, bottom: 100 }) as DOMRect,
  );
  ref.current!.preserveReadingPosition(() => {
    region.scrollTop = 0;
    y = 240;
  });
  expect(region.scrollTop).toBe(250);
  expect(positions.get("read")).toEqual({ top: 250, left: 0 });
  // The existing resize observer must not reapply the pre-expansion offset.
  for (const o of observers) o.callback([], {} as ResizeObserver);
  expect(region.scrollTop).toBe(250);
});
