// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TopicPickerPopup } from "../src/renderer/TopicPickerPopup";

let frame: HTMLIFrameElement;
let child: { window: Window & typeof globalThis };
let closed: (id: string) => void;
let api: any;
let observer: { callback: () => void; disconnect: ReturnType<typeof vi.fn> };
const anchor = { current: null as HTMLDivElement | null };
beforeEach(() => {
  frame = document.createElement("iframe");
  document.body.append(frame);
  child = { window: frame.contentWindow as Window & typeof globalThis };
  api = {
    setTopicPopupBounds: vi.fn(async () => {}),
    closeTopicPopup: vi.fn(async () => {}),
    onTopicPopupClosed: vi.fn((fn) => {
      closed = fn;
      return vi.fn();
    }),
  };
  window.goga = api;
  vi.spyOn(window, "open").mockReturnValue(child.window as unknown as Window);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      constructor(public callback: () => void) {
        observer = this;
      }
      observe() {}
    },
  );
  anchor.current = document.createElement("div");
  anchor.current.getBoundingClientRect = () =>
    ({ left: 400, bottom: 100 }) as DOMRect;
});
afterEach(() => {
  cleanup();
  frame.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const content = (
  <div className="topic-context-popup">
    <input aria-label="Найти топик" role="combobox" />
    <button>Выбрать</button>
  </div>
);
const mount = (onClose = vi.fn()) =>
  render(
    <TopicPickerPopup anchor={anchor} onClose={onClose}>
      {content}
    </TopicPickerPopup>,
  );
it("keeps ordinary DOM rendering when the native host API is absent", () => {
  window.goga = {} as any;
  mount();
  expect(screen.getByRole("combobox")).toBeTruthy();
  expect(window.open).not.toHaveBeenCalled();
});
it("portals the same controls into a scoped native layer, focuses search, and never hides the dashboard", async () => {
  api.selectRun = vi.fn();
  mount();
  const search = await within(child.window.document.body).findByRole(
    "combobox",
  );
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(child.window.document.activeElement).toBe(search);
  expect(window.open).toHaveBeenCalledWith(
    "about:blank",
    expect.stringMatching(/^goga-topic-picker:[a-f0-9-]{36}$/),
    expect.stringContaining("width="),
  );
  expect(api.selectRun).not.toHaveBeenCalled();
});
it("ignores stale close notifications, closes the matching menu, and cleans up its exact layer", async () => {
  const onClose = vi.fn(),
    view = mount(onClose);
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  const id = api.setTopicPopupBounds.mock.calls[0][0];
  act(() => closed("another-popup"));
  expect(onClose).not.toHaveBeenCalled();
  act(() => closed(id));
  expect(onClose).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(api.closeTopicPopup).toHaveBeenCalledWith(id);
  expect(observer.disconnect).toHaveBeenCalled();
  expect(api.onTopicPopupClosed.mock.results[0].value).toHaveBeenCalled();
});
it("clamps the layer to the window and measures again when menu contents change", async () => {
  anchor.current!.getBoundingClientRect = () =>
    ({ left: 10000, bottom: 100 }) as DOMRect;
  mount();
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  const root = child.window.document.querySelector(
    ".topic-context-native-root",
  )!;
  Object.defineProperty(root, "scrollHeight", {
    value: 9000,
    configurable: true,
  });
  act(() => observer.callback());
  const bounds = api.setTopicPopupBounds.mock.calls.at(-1)[1];
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(window.innerWidth);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(window.innerHeight);
});
it("fails explicitly rather than falling back underneath the dashboard when native creation is denied", async () => {
  vi.mocked(window.open).mockReturnValue(null);
  mount();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(api.setTopicPopupBounds).not.toHaveBeenCalled();
});
it("does not reveal unstyled content before local stylesheets load", async () => {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = "file:///fixture/assets/app.css";
  document.head.append(style);
  try {
    mount();
    await within(child.window.document.body).findByRole("combobox");
    expect(api.setTopicPopupBounds).not.toHaveBeenCalled();
    const copied =
      child.window.document.querySelector<HTMLLinkElement>("link")!;
    expect(copied.href).toBe(style.href);
    await act(async () => copied.dispatchEvent(new child.window.Event("load")));
    await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  } finally {
    style.remove();
  }
});
it("reports a failed native placement and releases the layer without an unhandled rejection", async () => {
  api.setTopicPopupBounds.mockRejectedValue(Error("placement failed"));
  mount();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(api.closeTopicPopup).toHaveBeenCalled();
});

it("can grow again after filtering without using the shrunken child viewport as its height limit", async () => {
  mount();
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  const root = child.window.document.querySelector<HTMLDivElement>(
    ".topic-context-native-root",
  )!;
  const maxHeight = `${window.innerHeight - 100 - 8 - 16}px`;
  expect(root.style.getPropertyValue("--topic-popup-max-height")).toBe(
    maxHeight,
  );
  for (const height of [100, 500]) {
    Object.defineProperty(root, "scrollHeight", {
      value: height,
      configurable: true,
    });
    act(() => observer.callback());
    expect(api.setTopicPopupBounds.mock.calls.at(-1)[1].height).toBe(height);
    expect(root.style.getPropertyValue("--topic-popup-max-height")).toBe(
      maxHeight,
    );
  }
  const css = readFileSync("src/renderer/TopicPickerPopup.css", "utf8");
  expect(css).toContain("max-height: var(--topic-popup-max-height)");
  expect(css).not.toContain("100vh");
});

it("waits for fonts and two layout frames before revealing a compact menu", async () => {
  let resolve!: () => void;
  const fonts = new Promise<void>((r) => (resolve = r));
  Object.defineProperty(child.window.document, "fonts", {
    value: { ready: fonts },
    configurable: true,
  });
  const frames: Array<FrameRequestCallback> = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((fn) => {
    frames.push(fn);
    return frames.length;
  });
  render(
    <TopicPickerPopup anchor={anchor} width={254} onClose={() => {}}>
      <div role="menu">
        <button role="menuitem">Переименовать</button>
      </div>
    </TopicPickerPopup>,
  );
  await within(child.window.document.body).findByRole("menuitem");
  expect(api.setTopicPopupBounds).not.toHaveBeenCalled();
  await act(async () => {
    resolve();
    await fonts;
  });
  expect(api.setTopicPopupBounds).not.toHaveBeenCalled();
  act(() => frames.shift()!(0));
  expect(api.setTopicPopupBounds).not.toHaveBeenCalled();
  act(() => frames.shift()!(16));
  expect(api.setTopicPopupBounds).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ width: 254 }),
  );
});
it("never reveals a menu closed while its fonts were pending", async () => {
  let resolve!: () => void;
  const fonts = new Promise<void>((r) => (resolve = r));
  Object.defineProperty(child.window.document, "fonts", {
    value: { ready: fonts },
    configurable: true,
  });
  const view = mount();
  await within(child.window.document.body).findByRole("combobox");
  view.unmount();
  await act(async () => {
    resolve();
    await fonts;
  });
  expect(api.setTopicPopupBounds).not.toHaveBeenCalled();
});
it("fails with a dismissible error if font/layout readiness never resolves", async () => {
  vi.useFakeTimers();
  try {
    Object.defineProperty(child.window.document, "fonts", {
      value: { ready: new Promise(() => {}) },
      configurable: true,
    });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(api.setTopicPopupBounds).not.toHaveBeenCalled();
    expect(api.closeTopicPopup).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("waits for the old native close acknowledgement before opening its replacement", async () => {
  let acknowledge!: () => void;
  api.closeTopicPopup.mockImplementationOnce(
    () => new Promise<void>((resolve) => (acknowledge = resolve)),
  );
  const first = mount();
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  first.unmount();
  // Mirrors TopicPopup's real one-current-layer admission guard.
  vi.mocked(window.open).mockReturnValue(null);
  mount();
  expect(window.open).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("alert")).toBeNull();
  vi.mocked(window.open).mockReturnValue(child.window);
  await act(async () => acknowledge());
  expect(window.open).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retains the oldest release barrier when an intermediate replacement unmounts", async () => {
  let acknowledge!: () => void;
  api.closeTopicPopup.mockImplementationOnce(
    () => new Promise<void>((resolve) => (acknowledge = resolve)),
  );
  const first = mount();
  first.unmount();
  const intermediate = mount();
  intermediate.unmount();
  mount();
  expect(window.open).toHaveBeenCalledTimes(1);
  await act(async () => acknowledge());
  expect(window.open).toHaveBeenCalledTimes(2);
  const openedIds = vi
    .mocked(window.open)
    .mock.calls.map((call) => call[1]!.replace("goga-topic-picker:", ""));
  expect(api.closeTopicPopup).not.toHaveBeenCalledWith(openedIds[1]);
});

it("closes the previous selector when another selector claims the native layer", async () => {
  const closeFirst = vi.fn();
  mount(closeFirst);
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  const firstId = api.setTopicPopupBounds.mock.calls[0][0];
  mount();
  expect(closeFirst).toHaveBeenCalledOnce();
  await act(async () => {});
  expect(api.closeTopicPopup).toHaveBeenCalledWith(firstId);
  expect(window.open).toHaveBeenCalledTimes(2);
});

it("bounds a stalled replacement wait and never opens it after dismissal", async () => {
  vi.useFakeTimers();
  let acknowledge!: () => void;
  try {
    api.closeTopicPopup.mockImplementationOnce(
      () => new Promise<void>((resolve) => (acknowledge = resolve)),
    );
    const first = mount();
    first.unmount();
    const onClose = vi.fn();
    const replacement = mount(onClose);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Закрыть меню" }));
    expect(onClose).toHaveBeenCalledOnce();
    replacement.unmount();
    await act(async () => acknowledge());
    expect(window.open).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("releases a hidden layer if its first placement acknowledgement never arrives", async () => {
  vi.useFakeTimers();
  try {
    api.setTopicPopupBounds.mockImplementation(() => new Promise(() => {}));
    mount();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.setTopicPopupBounds).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(api.closeTopicPopup).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

it("reopens cleanly after StrictMode's setup/cleanup cycle", async () => {
  const view = render(
    <React.StrictMode>
      <TopicPickerPopup anchor={anchor} onClose={vi.fn()}>
        {content}
      </TopicPickerPopup>
    </React.StrictMode>,
  );
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(window.open).toHaveBeenCalledTimes(2);
  const latestId = vi
    .mocked(window.open)
    .mock.calls.at(-1)![1]!
    .replace("goga-topic-picker:", "");
  expect(
    api.setTopicPopupBounds.mock.calls.every(
      ([id]: [string]) => id === latestId,
    ),
  ).toBe(true);
  expect(api.closeTopicPopup).not.toHaveBeenCalledWith(latestId);
  view.unmount();
  await act(async () => {});
  expect(api.closeTopicPopup).toHaveBeenCalledWith(latestId);
});

it("does not reveal or dismiss a replacement on late callbacks from the released owner", async () => {
  const firstClose = vi.fn();
  const first = mount(firstClose);
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalled());
  const firstId = api.setTopicPopupBounds.mock.calls[0][0];
  const oldClosed = closed;
  const oldMeasure = observer.callback;
  first.unmount();
  const nextClose = vi.fn();
  mount(nextClose);
  await waitFor(() => expect(api.setTopicPopupBounds).toHaveBeenCalledTimes(2));
  act(() => {
    oldClosed(firstId);
    oldMeasure();
    closed(firstId);
  });
  expect(nextClose).not.toHaveBeenCalled();
  expect(api.setTopicPopupBounds).toHaveBeenCalledTimes(2);
});

it("reports refused predecessor cleanup without opening another native layer", async () => {
  api.closeTopicPopup.mockRejectedValueOnce(Error("host unavailable"));
  const first = mount();
  first.unmount();
  mount();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(window.open).toHaveBeenCalledTimes(1);
});
