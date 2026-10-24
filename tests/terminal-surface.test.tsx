// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalSurface } from "../src/renderer/TerminalSurface";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const ref = { sessionId: "s", generation: "g" };
it("shows only a measured surface and hides on unmount without stopping the session", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    width: 400,
    height: 300,
  } as DOMRect);
  const request = vi.fn(async () => null),
    api = { request, onChanged: () => () => {} } as any;
  const f = render(
    <TerminalSurface
      api={api}
      scope="p"
      revision="v"
      tabId="t"
      session={ref}
      onError={() => {}}
    />,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "show",
        ref,
        bounds: { x: 10, y: 20, width: 400, height: 300 },
      }),
    ),
  );
  f.unmount();
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith({ kind: "hide" }),
  );
  expect(
    request.mock.calls.every(([value]: any) =>
      ["activate", "show", "hide"].includes(value.kind),
    ),
  ).toBe(true);
});
it("zero geometry never exposes a stale native surface", async () => {
  const request = vi.fn(async () => null);
  render(
    <TerminalSurface
      api={{ request } as any}
      scope="p"
      revision="v"
      tabId="t"
      session={ref}
      onError={() => {}}
    />,
  );
  await waitFor(() => expect(request).toHaveBeenCalledWith({ kind: "hide" }));
  expect(request).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "show" }),
  );
});
it("does not submit cached authorization before the workspace has revalidated its metadata", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 20,
    width: 400,
    height: 300,
  } as DOMRect);
  const request = vi.fn(async () => null),
    api = { request } as any;
  const props = {
    api,
    scope: "p",
    revision: "old",
    tabId: "t",
    session: ref,
    onError: () => {},
  };
  const view = render(<TerminalSurface {...props} enabled={false} />);
  expect(request).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "show" }),
  );
  view.rerender(<TerminalSurface {...props} revision="fresh" enabled />);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "show", revision: "fresh" }),
    ),
  );
});

it("does not expose a read-only preview while initial metadata is pending", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  const request = vi.fn(async () => null);
  render(
    <TerminalSurface
      api={{ request, onChanged: () => () => {} } as any}
      enabled={false}
      scope="p"
      revision="old"
      tabId="t"
      session={ref}
      onError={() => {}}
    />,
  );
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "activate" }),
  );
  expect(request).not.toHaveBeenCalledWith(
    expect.objectContaining({ kind: "show" }),
  );
});

it("hides zero geometry and does not reshow after an obsolete response", async () => {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ x: 0, y: 0, width: 400, height: 300 } as DOMRect);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const request = vi.fn((r: any) =>
    r.kind === "show" ? gate : Promise.resolve(null),
  );
  render(
    <TerminalSurface
      api={{ request } as any}
      scope="p"
      revision="v"
      tabId="t"
      session={ref}
      onError={() => {}}
    />,
  );
  rect.mockReturnValue({ x: 0, y: 0, width: 0, height: 0 } as DOMRect);
  fireEvent.resize(window);
  await act(async () => {
    release();
    await gate;
  });
  expect(request).toHaveBeenLastCalledWith({ kind: "hide" });
});
it("ignores a rejected obsolete show after a newer measurement succeeds", async () => {
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ x: 0, y: 0, width: 400, height: 300 } as DOMRect);
  let reject!: (error: Error) => void;
  const gate = new Promise((_, fail) => {
    reject = fail;
  });
  const report = vi.fn();
  const request = vi.fn((r: any) =>
    r.kind === "show" && r.bounds.width === 400 ? gate : Promise.resolve(null),
  );
  render(
    <TerminalSurface
      api={{ request } as any}
      scope="p"
      revision="v"
      tabId="t"
      session={ref}
      onError={report}
    />,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "show" }),
    ),
  );
  rect.mockReturnValue({ x: 0, y: 0, width: 500, height: 300 } as DOMRect);
  fireEvent.resize(window);
  await waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "show",
        bounds: expect.objectContaining({ width: 500 }),
      }),
    ),
  );
  await act(async () => {
    reject(Error("old"));
    await gate.catch(() => {});
  });
  expect(report).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalledWith({ kind: "hide" });
});
it("does not touch the live screen when selection metadata revision changes", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  const request = vi.fn(async () => null),
    api = { request } as any;
  const props = {
    api,
    scope: "p",
    revision: "old",
    tabId: "t",
    session: ref,
    onError: () => {},
  };
  const view = render(<TerminalSurface {...props} />);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "show" }),
    ),
  );
  request.mockClear();
  view.rerender(<TerminalSurface {...props} revision="new" />);
  expect(request).not.toHaveBeenCalled();
  view.rerender(<TerminalSurface {...props} revision="new" visible={false} />);
  expect(request).toHaveBeenCalledWith({ kind: "hide" });
});
it("unmounting an inactive retained surface cannot hide another active terminal", () => {
  const request = vi.fn(async () => null),
    api = { request } as any;
  const view = render(
    <TerminalSurface
      api={api}
      visible={false}
      scope="p"
      revision="v"
      tabId="t"
      session={ref}
      onError={() => {}}
    />,
  );
  view.unmount();
  expect(request).not.toHaveBeenCalled();
});
it("activates previously opened screens with input, without preview, hide or reauthorization", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  const seen = new Set<string>();
  const request = vi.fn(async (r: any) => {
      if (r.kind === "activate") return seen.has(r.tabId);
      if (r.kind === "show") seen.add(r.tabId);
      return null;
    }),
    api = { request } as any;
  const props = {
    api,
    scope: "p",
    revision: "v",
    tabId: "a",
    session: ref,
    onError: () => {},
  };
  const view = render(<TerminalSurface {...props} />);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "show" }),
    ),
  );
  request.mockClear();
  view.rerender(
    <TerminalSurface
      {...props}
      tabId="b"
      session={{ sessionId: "b", generation: "g" }}
      enabled
    />,
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "show", tabId: "b" }),
    ),
  );
  request.mockClear();
  view.rerender(<TerminalSurface {...props} revision="updated" />);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "activate", tabId: "a" }),
  );
  expect(request.mock.calls.every(([r]: any) => r.kind === "activate")).toBe(
    true,
  );
  view.unmount();
  expect(request).toHaveBeenCalledWith({ kind: "hide" });
});

it("switches a granted console with input while selection metadata is still saving", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  } as DOMRect);
  const request = vi.fn(async () => true);
  render(
    <TerminalSurface
      api={{ request } as any}
      enabled={false}
      scope="p"
      revision="old"
      tabId="t"
      session={ref}
      onError={() => {}}
    />,
  );
  await act(async () => {});
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "activate", ref }),
  );
});

it("follows a centered terminal when its workspace shifts without resizing the terminal", async () => {
  const observed = new Set<Element>();
  let notify!: ResizeObserverCallback;
  const disconnect = vi.fn(() => observed.clear());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        notify = callback;
      }
      observe(element: Element) {
        observed.add(element);
      }
      disconnect = disconnect;
    },
  );
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({ x: 300, y: 200, width: 600, height: 400 } as DOMRect);
  const request = vi.fn(async () => true);
  const api = { request } as any;
  try {
    const view = render(
      <div className="scroll-area" data-testid="workspace">
        <section className="project-content">
          <TerminalSurface
            api={api}
            scope="p"
            revision="v"
            tabId="t"
            session={ref}
            onError={() => {}}
          />
        </section>
      </div>,
    );
    await act(async () => {});
    request.mockClear();
    const workspace = view.getByTestId("workspace");
    // The max-width content stays 600px wide; only its ancestor resizes.
    rect.mockReturnValue({
      x: 180,
      y: 200,
      width: 600,
      height: 400,
    } as DOMRect);
    await act(async () => {
      if (observed.has(workspace)) notify([], {} as ResizeObserver);
    });
    expect(request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "activate",
        ref,
        bounds: { x: 180, y: 200, width: 600, height: 400 },
      }),
    );
    request.mockClear();
    await act(async () => {
      notify([], {} as ResizeObserver);
    });
    expect(request).not.toHaveBeenCalled();
    rect.mockReturnValue({
      x: 300,
      y: 200,
      width: 600,
      height: 400,
    } as DOMRect);
    await act(async () => {
      notify([], {} as ResizeObserver);
    });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "activate",
        ref,
        bounds: { x: 300, y: 200, width: 600, height: 400 },
      }),
    );
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    request.mockClear();
    await act(async () => notify([], {} as ResizeObserver));
    expect(request).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
