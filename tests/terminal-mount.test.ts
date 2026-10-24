// @vitest-environment jsdom
import { expect, it, vi, beforeEach } from "vitest";
import { mountTerminalRenderer } from "../src/terminal/index";
import type { TerminalScreenBridge } from "../src/shared/terminal-screen";
const grant = {
  sessionId: "s",
  generation: "00000000-0000-4000-8000-000000000001",
  capability: "00000000-0000-4000-8000-000000000002",
};
function fixture() {
  let command = (_v: unknown) => {},
    frame = (_v: unknown) => {};
  const bridge: TerminalScreenBridge = {
    ready: vi.fn(),
    link: vi.fn(),
    ack: vi.fn(),
    input: vi.fn(),
    resize: vi.fn(),
    fault: vi.fn(),
    onCommand: (cb) => {
      command = cb;
      return vi.fn();
    },
    onFrame: (cb) => {
      frame = cb;
      return vi.fn();
    },
  };
  const terms: any[] = [];
  class Terminal {
    options: any;
    cols = 80;
    rows = 24;
    data = (_text: string) => {};
    viewport = 11;
    buffer = { active: { viewportY: 11, baseY: 30 } };
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    open = vi.fn();
    write = vi.fn((_text, done) => done());
    focus = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    scrollToLine = vi.fn();
    resize = vi.fn((cols, rows) => {
      this.cols = cols;
      this.rows = rows;
    });
    constructor(options: any) {
      this.options = options;
      terms.push(this);
    }
    paste = vi.fn((text: string) => this.data(text));
    onData(cb: (s: string) => void) {
      this.data = cb;
      return { dispose: vi.fn() };
    }
  }
  class FitAddon {
    proposeDimensions() {
      return { cols: 100, rows: 30 };
    }
  }
  const root = document.createElement("div");
  document.body.append(root);
  const bounds = vi
    .spyOn(root, "getBoundingClientRect")
    .mockReturnValue({ width: 800, height: 600 } as DOMRect);
  const stop = mountTerminalRenderer(root, bridge, { Terminal, FitAddon });
  return {
    terms,
    bounds,
    root,
    bridge,
    stop,
    command: (v: unknown) => command(v),
    frame: (v: unknown) => frame(v),
  };
}
it("mounts once, uses scrollback 5000, preserves scrolled position, and refreshes only visible fit", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  expect(f.terms[0].options.scrollback).toBe(5000);
  expect(f.terms[0].resize).toHaveBeenCalledWith(100, 30);
  expect(f.terms[0].scrollToLine).toHaveBeenCalledWith(11);
  f.command({ kind: "select", grant: null });
  f.command({ kind: "select", grant });
  expect(f.terms).toHaveLength(1);
  expect(f.root.children).toHaveLength(1);
  f.stop();
  expect(f.terms[0].dispose).toHaveBeenCalledOnce();
  expect(f.root.children).toHaveLength(0);
});
it("blocks OSC52 and direct multiline paste; has no automatic link navigation", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  const term = f.terms[0];
  expect(term.parser.registerOscHandler).toHaveBeenCalledWith(
    52,
    expect.any(Function),
  );
  expect(term.parser.registerOscHandler.mock.calls[0][1]("clipboard")).toBe(
    true,
  );
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => "echo a\necho b" },
  });
  f.root.firstElementChild!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(
    term.options.linkHandler.activate({}, "https://example.test"),
  ).toBeUndefined();
  f.stop();
});
it("read-only on loss, disposes only explicitly, ready sent after subscription installation", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.frame({ ...grant, sequence: 1, text: "out" });
  expect(f.bridge.ack).toHaveBeenCalledWith({ ...grant, sequence: 1 });
  f.command({ kind: "lost", grant });
  expect(f.terms[0].options.disableStdin).toBe(true);
  f.terms[0].data("unsafe");
  expect(f.bridge.input).not.toHaveBeenCalled();
  expect(f.terms[0].dispose).not.toHaveBeenCalled();
  expect(f.bridge.ready).toHaveBeenCalledOnce();
  f.stop();
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
function paste(f: ReturnType<typeof fixture>, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text },
  });
  f.root.querySelector(".terminal-screen")!.dispatchEvent(event);
  return event;
}
function button(f: ReturnType<typeof fixture>, label: string) {
  const found = [...f.root.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  );
  expect(found).toBeDefined();
  return found!;
}
it("multiline paste previews plain text and cancel sends zero bytes", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  expect(paste(f, "echo a\n<script>bad</script>").defaultPrevented).toBe(true);
  expect(f.root.querySelector("dialog[open]")).not.toBeNull();
  expect(f.root.querySelector("pre")!.textContent).toBe(
    "echo a\n<script>bad</script>",
  );
  expect(f.root.querySelector("script")).toBeNull();
  expect(f.bridge.input).not.toHaveBeenCalled();
  button(f, "Отмена").click();
  expect(f.root.querySelector("dialog")).toBeNull();
  expect(f.terms[0].paste).not.toHaveBeenCalled();
  expect(f.terms[0].options.disableStdin).toBe(false);
  f.stop();
});
it("confirmation calls xterm paste exactly once (preserving its bracketed-paste handling)", () => {
  const f = fixture(),
    text = "echo a\r\necho b";
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  paste(f, text);
  const confirm = button(f, "Вставить");
  confirm.click();
  confirm.click();
  expect(f.terms[0].paste).toHaveBeenCalledExactlyOnceWith(text);
  expect(f.bridge.input).toHaveBeenCalledExactlyOnceWith({ ...grant, text });
  f.stop();
});
it.each(["hide", "exited", "lost", "remove"])(
  "pending paste is revoked on %s, never transferred to another screen",
  (kind) => {
    const f = fixture();
    f.command({ kind: "grant", grant });
    f.command({ kind: "select", grant });
    paste(f, "a\nb");
    const confirm = button(f, "Вставить");
    f.command(
      kind === "hide" ? { kind: "select", grant: null } : { kind, grant },
    );
    confirm.click();
    expect(f.terms[0].paste).not.toHaveBeenCalled();
    expect(f.bridge.input).not.toHaveBeenCalled();
    expect(f.root.querySelector("dialog")).toBeNull();
    f.stop();
  },
);
it("escape cancels, a second paste cannot replace a pending payload, and oversized paste is rejected without truncation", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  paste(f, "first\nline");
  paste(f, "second\nline");
  expect(f.root.querySelectorAll("dialog")).toHaveLength(1);
  expect(f.root.querySelector("pre")!.textContent).toBe("first\nline");
  f.root
    .querySelector("dialog")!
    .dispatchEvent(new Event("cancel", { cancelable: true }));
  expect(f.bridge.input).not.toHaveBeenCalled();
  paste(f, "x".repeat(1024 * 1024) + "\n");
  expect(f.root.textContent).toContain("слишком большой");
  expect(f.root.querySelector("pre")).toBeNull();
  expect(f.terms[0].paste).not.toHaveBeenCalled();
  f.stop();
});

it("link activation requests host confirmation only for the visible live screen, never on output", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  const term = f.terms[0],
    url = "https://example.test/path";
  f.frame({ ...grant, sequence: 1, text: url });
  term.options.linkHandler.activate({}, url);
  expect(f.bridge.link).not.toHaveBeenCalled();
  f.command({ kind: "select", grant });
  term.options.linkHandler.activate({}, url);
  expect(f.bridge.link).toHaveBeenCalledExactlyOnceWith({ ...grant, url });
  f.command({ kind: "exited", grant });
  term.options.linkHandler.activate({}, url);
  expect(f.bridge.link).toHaveBeenCalledTimes(1);
  f.stop();
});

it("never fits an unlaid-out native viewport to a destructive 2x1 size", () => {
  const f = fixture();
  f.bounds.mockReturnValue({ width: 0, height: 0 } as DOMRect);
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  expect(f.terms[0].resize).not.toHaveBeenCalled();
  expect(f.bridge.resize).not.toHaveBeenCalled();
  f.bounds.mockReturnValue({ width: 800, height: 600 } as DOMRect);
  window.dispatchEvent(new Event("resize"));
  expect(f.terms[0].resize).toHaveBeenCalledExactlyOnceWith(100, 30);
  f.stop();
});
it("paste confirmation keeps parser replies enabled while the native modal traps user focus", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  paste(f, "a\nb");
  expect(f.terms[0].options.disableStdin).toBe(false);
  f.terms[0].data("\x1b[1;1R");
  expect(f.bridge.input).toHaveBeenCalledExactlyOnceWith({
    ...grant,
    text: "\x1b[1;1R",
  });
  f.stop();
});
it("a failed modal opening does not leave the screen stuck and cannot send paste", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  const modal = vi
    .spyOn(HTMLDialogElement.prototype, "showModal")
    .mockImplementationOnce(() => {
      throw Error("failed");
    });
  paste(f, "a\nb");
  expect(f.terms[0].paste).not.toHaveBeenCalled();
  paste(f, "new\ntext");
  expect(f.root.querySelector("dialog[open]")).not.toBeNull();
  modal.mockRestore();
  f.stop();
});

it("allows reviewing the entire accepted payload, including commands beyond the first 4000 characters", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant });
  const text = "#" + "x".repeat(5000) + "\nprintf tail\n";
  paste(f, text);
  expect(f.root.querySelector("pre")!.textContent).toBe(text);
  expect(f.bridge.input).not.toHaveBeenCalled();
  f.stop();
});

it("selects a visible screen without stealing focus when a host overlay is open", () => {
  const f = fixture();
  f.command({ kind: "grant", grant });
  f.command({ kind: "select", grant, focus: false });
  expect((f.root.firstElementChild as HTMLElement).style.display).toBe("block");
  expect(f.terms[0].focus).not.toHaveBeenCalled();
  expect(f.bridge.resize).toHaveBeenCalled();
  f.stop();
});
