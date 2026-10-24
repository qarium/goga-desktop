// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, cleanup, screen, act } from "@testing-library/react";
import { SettingsDocument } from "../src/renderer/SettingsDocument";
import { RetainedViews } from "../src/renderer/RetainedViews";
vi.mock("../src/renderer/YamlEditor", () => ({
  YamlEditor: () => <div className="yaml-code-editor">Editor</div>,
}));
const source = {
  scope: "project",
  projectId: "p",
  target: { kind: "workflow", name: "development" },
} as const;
const draft = {
  document: { text: "long source", exists: true, version: "v" },
  text: "long source",
  busy: false,
};
const store = {
  get: () => draft,
  subscribe: () => () => {},
  cancelDeletion: vi.fn(),
} as any;
let top: number, footer: number, scroll: number;
function content() {
  return (
    <SettingsDocument
      store={store}
      source={source}
      title="development.yml"
      path=".goga/workflows/development.yml"
      description="Workflow"
    />
  );
}
beforeEach(() => {
  top = 350;
  footer = 140;
  scroll = 0;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as any);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return {
        top: this.classList.contains("scroll-area")
          ? 100
          : this.classList.contains("yaml-code-editor")
            ? top
            : 0,
        height: this.classList.contains("document-editor-footer") ? footer : 0,
        bottom: this.classList.contains("scroll-area") ? 700 : 0,
      } as DOMRect;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.classList.contains("scroll-area") ? 600 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
    () => scroll,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("reserves measured hint/actions space within the enclosing viewport for a long document", () => {
  render(<div className="scroll-area">{content()}</div>);
  const pane = screen.getByRole("region", { name: "development.yml" });
  expect(pane.style.getPropertyValue("--settings-editor-height")).toBe("192px");
  expect(
    pane
      .querySelector(".document-editor-footer")
      ?.contains(screen.getByRole("button", { name: "Сохранить" })),
  ).toBe(true);
});
it("recomputes when controls wrap and does not grow the editor while the parent scrolls", () => {
  render(<div className="scroll-area">{content()}</div>);
  const pane = screen.getByRole("region", { name: "development.yml" });
  footer = 190;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(pane.style.getPropertyValue("--settings-editor-height")).toBe("142px");
  top = 300;
  scroll = 50;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(pane.style.getPropertyValue("--settings-editor-height")).toBe("142px");
});
it("measures again after a retained view is reactivated", () => {
  const v = render(
    <div className="scroll-area">
      <RetainedViews activeKey="editor">{content()}</RetainedViews>
    </div>,
  );
  v.rerender(
    <div className="scroll-area">
      <RetainedViews activeKey="other">
        <p>Other</p>
      </RetainedViews>
    </div>,
  );
  top = 300;
  v.rerender(
    <div className="scroll-area">
      <RetainedViews activeKey="editor">{content()}</RetainedViews>
    </div>,
  );
  expect(
    screen
      .getByRole("region", { name: "development.yml" })
      .style.getPropertyValue("--settings-editor-height"),
  ).toBe("242px");
});
it("reserves additional footer space when ResizeObserver reports an error or wrapped actions", () => {
  let resized: () => void = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  try {
    const view = render(<div className="scroll-area">{content()}</div>);
    const pane = screen.getByRole("region", { name: "development.yml" });
    expect(observe).toHaveBeenCalledWith(
      pane.querySelector(".document-editor-footer"),
    );
    footer = 220;
    act(() => resized());
    expect(pane.style.getPropertyValue("--settings-editor-height")).toBe(
      "112px",
    );
    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
