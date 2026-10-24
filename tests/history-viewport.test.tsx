// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, act } from "@testing-library/react";
import { HistoryViewport } from "../src/renderer/HistoryViewport";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("bounds the viewer by its enclosing scroll area, not by document length or parent scroll", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [{}] as any,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        top: this.classList.contains("scroll-area") ? 100 : 300,
      } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("scroll-area") ? 600 : 0;
    },
  );
  const { container } = render(
    <div className="scroll-area">
      <HistoryViewport active>
        <p>Document</p>
      </HistoryViewport>
    </div>,
  );
  const pane = screen.getByText("Document").parentElement!;
  expect(pane.style.height).toBe("376px");
  container.querySelector(".scroll-area")!.scrollTop = 50;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        top: this.classList.contains("scroll-area") ? 100 : 250,
      } as DOMRect;
    },
  );
  act(() => window.dispatchEvent(new Event("resize")));
  expect(pane.style.height).toBe("376px");
});
it("does not measure detached or inactive content and responds after reactivation", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [{}] as any,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    top: 300,
  } as DOMRect);
  const view = render(
    <HistoryViewport active={false}>Content</HistoryViewport>,
  );
  expect(screen.getByText("Content").style.height).toBe("");
  view.rerender(<HistoryViewport active>Content</HistoryViewport>);
  expect(screen.getByText("Content").style.height).not.toBe("");
});

it("reserves the project panel bottom padding so focusing the document cannot scroll the whole page", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(
    () => [{}] as any,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        top: this.classList.contains("scroll-area") ? 100 : 300,
      } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("scroll-area") ? 600 : 0;
    },
  );
  render(
    <div className="scroll-area">
      <section className="project-settings-panel" style={{ paddingBottom: 40 }}>
        <HistoryViewport active>Content</HistoryViewport>
      </section>
    </div>,
  );
  expect(screen.getByText("Content").style.height).toBe("360px");
});
