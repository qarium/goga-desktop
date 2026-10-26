// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { FitAddon } from "@xterm/addon-fit";
import { afterEach, expect, it, vi } from "vitest";
import { mountTerminalRenderer } from "../src/terminal/index";
import type { TerminalScreenBridge } from "../src/shared/terminal-screen";

const grant = {
  sessionId: "geometry",
  generation: "00000000-0000-4000-8000-000000000001",
  capability: "00000000-0000-4000-8000-000000000002",
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.restoreAllMocks();
});

it.each([
  { width: 800, height: 600, cols: 96, rows: 29 },
  { width: 320, height: 201, cols: 36, rows: 9 },
])(
  "fits the padded viewport without clipping the last row at $width x $height",
  ({ width, height, cols, rows }) => {
    const style = document.createElement("style");
    style.textContent = readFileSync("src/terminal/terminal.css", "utf8");
    document.head.append(style);
    cleanup.push(() => style.remove());
    const root = document.createElement("div");
    root.style.cssText = `position:relative;width:${width}px;height:${height}px`;
    document.body.append(root);
    cleanup.push(() => root.remove());
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      width,
      height,
    } as DOMRect);

    // JSDOM has no layout engine. Supply only resolved absolute-box dimensions;
    // padding, box sizing, and insets still come from the real renderer stylesheet.
    // The installed FitAddon itself computes the grid, not a duplicate fit formula.
    const computedStyle = window.getComputedStyle.bind(window);
    const boxDimension = (
      element: Element,
      dimension: "width" | "height",
    ): number => {
      const css = computedStyle(element);
      const explicit = parseFloat(css.getPropertyValue(dimension));
      if (Number.isFinite(explicit)) return explicit;
      const inset = parseFloat(css.inset) || 0;
      const start = parseFloat(dimension === "width" ? css.left : css.top);
      const end = parseFloat(dimension === "width" ? css.right : css.bottom);
      return (
        boxDimension(element.parentElement!, dimension) -
        (Number.isFinite(start) ? start : inset) -
        (Number.isFinite(end) ? end : inset)
      );
    };
    vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
      const css = computedStyle(element);
      const getPropertyValue = css.getPropertyValue.bind(css);
      css.getPropertyValue = (property) =>
        property === "width" || property === "height"
          ? `${boxDimension(element, property)}px`
          : getPropertyValue(property);
      return css;
    });

    let terminal: Terminal;
    class Terminal {
      cols = 80;
      rows = 24;
      element?: HTMLElement;
      options: any;
      buffer = { active: { viewportY: 0, baseY: 0 } };
      parser = { registerOscHandler: () => ({ dispose() {} }) };
      // Font metrics are the only xterm internals supplied by this fixture.
      _core = {
        _renderService: {
          dimensions: { css: { cell: { width: 8, height: 20 } } },
        },
      };
      constructor(options: any) {
        this.options = options;
        terminal = this;
      }
      open(parent: HTMLElement) {
        this.element = document.createElement("div");
        this.element.className = "xterm";
        this.element.style.padding = "0px";
        parent.append(this.element);
      }
      loadAddon(addon: FitAddon) {
        addon.activate(this as any);
      }
      resize(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      }
      write(_text: string, done: () => void) {
        done();
      }
      onData() {
        return { dispose() {} };
      }
      focus() {}
      paste() {}
      scrollToLine() {}
      dispose() {}
    }
    let command = (_value: unknown) => {};
    const bridge: TerminalScreenBridge = {
      ready: vi.fn(),
      link: vi.fn(),
      ack: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
      fault: vi.fn(),
      onFrame: () => () => {},
      onCommand: (callback) => {
        command = callback;
        return () => {};
      },
    };
    cleanup.push(mountTerminalRenderer(root, bridge, { Terminal, FitAddon }));
    command({ kind: "grant", grant });
    command({ kind: "select", grant });

    expect(bridge.fault).not.toHaveBeenCalled();
    expect(bridge.resize).toHaveBeenLastCalledWith({ ...grant, cols, rows });
    expect(terminal!.rows * 20).toBeLessThanOrEqual(height - 16);
    expect(terminal!.cols * 8 + 14).toBeLessThanOrEqual(width - 16);
  },
);
