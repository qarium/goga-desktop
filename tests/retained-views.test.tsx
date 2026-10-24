// @vitest-environment jsdom
import React, { useEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RetainedViews, useViewActive } from "../src/renderer/RetainedViews";
afterEach(cleanup);
it("retains DOM, draft and mount lifetime across projects without mounting unseen pages", () => {
  const mount = vi.fn(),
    dispose = vi.fn();
  function Page({ name }: { name: string }) {
    const [text, setText] = useState(name);
    useEffect(() => {
      mount(name);
      return () => dispose(name);
    }, []);
    return (
      <input
        aria-label={name}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    );
  }
  const view = (key: string | null) => (
    <RetainedViews activeKey={key}>
      <Page name={key ?? "none"} />
    </RetainedViews>
  );
  const f = render(view("A"));
  const a = screen.getByRole("textbox", { name: "A" });
  fireEvent.change(a, { target: { value: "draft" } });
  f.rerender(view("B"));
  expect(screen.queryByRole("textbox", { name: "A" })).toBeNull();
  expect(a.closest("[inert]")).toBeTruthy();
  f.rerender(view("A"));
  expect(screen.getByRole("textbox", { name: "A" })).toBe(a);
  expect((a as HTMLInputElement).value).toBe("draft");
  expect(mount.mock.calls).toEqual([["A"], ["B"]]);
  expect(dispose).not.toHaveBeenCalled();
  f.unmount();
  expect(dispose).toHaveBeenCalledTimes(2);
});
it("inherits inactive state through nested outlets and restores scroll", () => {
  function Page() {
    return <span>{useViewActive() ? "active" : "inactive"}</span>;
  }
  const view = (key: string) => (
    <div className="scroll-area">
      <RetainedViews activeKey={key}>
        {key === "A" ? (
          <RetainedViews activeKey="nested">
            <Page />
          </RetainedViews>
        ) : (
          <p>B</p>
        )}
      </RetainedViews>
    </div>
  );
  const f = render(view("A"));
  const scroller = f.container.firstElementChild!;
  scroller.scrollTop = 123;
  fireEvent.scroll(scroller);
  f.rerender(view("B"));
  expect(screen.queryByText("active")).toBeNull();
  scroller.scrollTop = 50;
  fireEvent.scroll(scroller);
  f.rerender(view("A"));
  expect(screen.getByText("active")).toBeTruthy();
  expect(scroller.scrollTop).toBe(123);
});
it("explicit owner removal disposes cached pages and never eagerly loads an inactive page", () => {
  const dispose = vi.fn(),
    mount = vi.fn();
  function Page() {
    useEffect(() => {
      mount();
      return dispose;
    }, []);
    return <input aria-label="owner" />;
  }
  const f = render(
    <RetainedViews activeKey={null}>
      <Page />
    </RetainedViews>,
  );
  expect(mount).not.toHaveBeenCalled();
  f.rerender(
    <RetainedViews activeKey="p">
      <Page />
    </RetainedViews>,
  );
  expect(mount).toHaveBeenCalledTimes(1);
  f.rerender(
    <RetainedViews activeKey={null} retain={() => false}>
      <Page />
    </RetainedViews>,
  );
  expect(dispose).toHaveBeenCalledTimes(1);
});
it("does not repeatedly recreate a removed active owner", () => {
  const { container } = render(
    <RetainedViews activeKey="removed" retain={() => false}>
      <input />
    </RetainedViews>,
  );
  expect(container.querySelector("input")).toBeNull();
});
it("restores nested scrolling reset by browser detachment without requiring a scroll event", () => {
  const view = (key: string) => (
    <RetainedViews activeKey={key}>
      <div data-testid={key}>
        <div data-testid={`${key}-scroll`} />
      </div>
    </RetainedViews>
  );
  const f = render(view("A"));
  const inner = screen.getByTestId("A-scroll");
  inner.scrollTop = 120;
  inner.scrollLeft = 45;
  f.rerender(view("B"));
  // Chromium resets detached elements' scroll offsets (native fixture covers this).
  inner.scrollTop = 0;
  inner.scrollLeft = 0;
  f.rerender(view("A"));
  expect(screen.getByTestId("A-scroll")).toBe(inner);
  expect(inner.scrollTop).toBe(120);
  expect(inner.scrollLeft).toBe(45);
});
it("does not reinsert an attached portal after child scroll/layout restoration", () => {
  const append = vi.spyOn(HTMLElement.prototype, "appendChild");
  const view = (key: string) => (
    <RetainedViews activeKey={key}>
      <div data-testid={key} />
    </RetainedViews>
  );
  const f = render(view("A"));
  const portal = screen.getByTestId("A").parentElement!;
  f.rerender(view("B"));
  append.mockClear();
  f.rerender(view("A"));
  expect(append.mock.calls.filter(([node]) => node === portal)).toHaveLength(1);
  append.mockRestore();
});
