// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { DemoOpenShows } from "../src/renderer/demonstrations/DemoOpenShows";
import { DemoPanel } from "../src/renderer/demonstrations/DemoPanel";
import {
  DemoDirectory,
  useDemoMonitor,
} from "../src/renderer/demonstrations/directory";
import { DemoFrame } from "../src/renderer/demonstrations/DemoFrame";
import type { DemoCommand, DemoState } from "../src/shared/demonstrations";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const s: DemoState = {
    engine: "embedded",
    port: 45678,
    shows: [
      {
        showId: "a",
        engine: "embedded",
        scope: "one",
        label: "Первый",
        url: "https://one.example/",
        activeTabId: "a-tab",
        tabs: [{ tabId: "a-tab", title: "First", url: "https://one.example/" }],
      },
      {
        showId: "b",
        engine: "embedded",
        scope: "two",
        label: "Второй",
        url: null,
      },
    ],
    access: { owner: "a", phase: "connected", connectionId: "first" },
  };
  const bridge = {
    demoState: vi.fn(async () => structuredClone(s)),
    demoFrame: vi.fn(() => new Promise<Uint8Array>(() => {})),
    demoOpenBrowser: vi.fn(async () => {}),
    demoCopyURL: vi.fn(async (_show: string, _tab: string) => {}),
    demoCopySelection: vi.fn(
      async (_show: string, _tab: string, _request: string) => true,
    ),
    demoCancelSelectionCopy: vi.fn(async (_request: string) => {}),
    demoExecute: vi.fn(async (cmd: DemoCommand) => {
      if (cmd.action === "navigate")
        s.shows.find((v) => v.showId === cmd.showId)!.url =
          cmd.url + "#redirect";
      if (cmd.action === "switch-port" || cmd.action === "handoff")
        s.access = { owner: cmd.showId, phase: "waiting", connectionId: null };
    }),
  };
  window.goga = bridge as any;
  const store = new DemoDirectory(window.goga);
  return { s, bridge, store };
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("keeps URL edits across agent navigation; sends only show-bound commands and shows the actual redirected URL", async () => {
  const { store, s, bridge } = fixture();
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  const field = () =>
    screen.getByRole("textbox", { name: "Адрес страницы" }) as HTMLInputElement;
  expect(field().value).toBe("https://one.example/");
  fireEvent.change(field(), { target: { value: "https://draft.example/" } });
  s.shows[0].url = "https://agent.example/";
  await act(() => store.refresh());
  expect(field().value).toBe("https://draft.example/");
  fireEvent.keyDown(field(), { key: "Escape" });
  expect(field().value).toBe(s.shows[0].url);
  fireEvent.change(field(), { target: { value: "https://chosen.example/" } });
  fireEvent.keyDown(field(), { key: "Enter" });
  await waitFor(() =>
    expect(field().value).toBe("https://chosen.example/#redirect"),
  );
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "navigate",
    showId: "a",
    url: "https://chosen.example/",
  });
  fireEvent.click(screen.getByRole("button", { name: "Развернуть показ" }));
  const full = screen.getByRole("dialog", { name: "Развёрнутый показ" });
  expect(within(full).queryByLabelText("Порт 45678")).toBeNull();
  fireEvent.click(
    within(full).getByRole("button", { name: "Обновить страницу" }),
  );
  await within(full).findByText("Страница обновлена.");
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "reload",
    showId: "a",
  });
  fireEvent.click(within(full).getByRole("button", { name: "Свернуть показ" }));
  fireEvent.click(screen.getByRole("button", { name: "Открыть в браузере" }));
  await waitFor(() => expect(bridge.demoOpenBrowser).toHaveBeenCalledWith("a"));
});
it("invalidates a retired client's handoff, confirms caller/target transfer, and does not switch on cancellation", async () => {
  const { store, s, bridge } = fixture();
  await store.refresh();
  const view = render(
    <DemoPanel key="a" store={store} showId="a" onSettings={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Передать управление" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  s.access.connectionId = "replacement";
  await act(() => store.refresh());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(bridge.demoExecute).not.toHaveBeenCalled();
  view.rerender(
    <DemoPanel key="b" store={store} showId="b" onSettings={() => {}} />,
  );
  const change = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Переключить порт сюда" }),
    );
  change();
  expect(screen.getByRole("dialog").textContent).toContain("Первый");
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(bridge.demoExecute).not.toHaveBeenCalled();
  change();
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Переключить порт",
    }),
  );
  await screen.findByLabelText("Ожидаем агента");
  expect(bridge.demoExecute).toHaveBeenCalledWith({
    action: "switch-port",
    showId: "b",
    fromShowId: "a",
  });
});
it("does not decode a late frame from a retired show; paints a PNG and targets manual input without re-reading host state", async () => {
  const { bridge } = fixture(),
    old = deferred<Uint8Array>(),
    next = deferred<Uint8Array>();
  bridge.demoFrame
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => next.promise);
  const drawImage = vi.fn(),
    close = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as any);
  const decode = vi.fn(async () => ({ width: 2, height: 1, close }));
  vi.stubGlobal("createImageBitmap", decode);
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0,
    0, 0, 1,
  ]);
  const view = render(
    <DemoFrame showId="old" disabled={false} onError={() => {}} />,
  );
  view.rerender(<DemoFrame showId="new" disabled={false} onError={() => {}} />);
  await act(async () => {
    old.resolve(png);
    await old.promise;
  });
  expect(decode).not.toHaveBeenCalled();
  await act(async () => {
    next.resolve(png);
    await next.promise;
  });
  await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
  expect(close).toHaveBeenCalled();
  const canvas = screen.getByRole("img", {
    name: "Интерактивный показ выбранного контекста",
  });
  fireEvent.keyDown(canvas, { key: "Q" });
  await waitFor(() =>
    expect(bridge.demoExecute).toHaveBeenCalledWith({
      action: "input",
      showId: "new",
      input: { action: "text", text: "Q" },
    }),
  );
  expect(bridge.demoState).not.toHaveBeenCalled();
  fireEvent.keyDown(canvas, { key: "Tab", shiftKey: true });
  expect(bridge.demoExecute).toHaveBeenCalledTimes(1);
});
it("does not poll an empty host repeatedly; late pre-mutation snapshots cannot replace a refreshed directory", async () => {
  const { s, store, bridge } = fixture();
  s.shows = [];
  vi.useFakeTimers();
  function Monitor() {
    useDemoMonitor(store, true, false);
    return null;
  }
  render(<Monitor />);
  await act(async () => {});
  expect(bridge.demoState).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30000);
  });
  expect(bridge.demoState).toHaveBeenCalledTimes(1);
  const old = deferred<DemoState>();
  bridge.demoState.mockImplementationOnce(() => old.promise);
  const pending = store.refresh();
  s.shows = [
    {
      showId: "fresh",
      engine: "embedded",
      scope: "one",
      label: "Первый",
      url: null,
    },
  ];
  await act(async () => {
    await store.refresh(true);
    old.resolve({ ...s, shows: [] });
    await pending;
  });
  expect(store.state?.shows[0].showId).toBe("fresh");
});

it.each([
  [
    "non-PNG content",
    Uint8Array.from([60, 115, 118, 103, 62, 60, 47, 115, 118, 103, 62]),
  ],
  [
    "oversized bitmap",
    Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 255, 255,
      255, 255, 0, 0, 0, 1,
    ]),
  ],
])(
  "rejects %s without handing untrusted content to the decoder or enabling input",
  async (_, bytes) => {
    const { bridge } = fixture();
    bridge.demoFrame.mockResolvedValueOnce(bytes as Uint8Array);
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    render(<DemoFrame showId="a" disabled={false} onError={() => {}} />);
    await screen.findByText("Нет изображения. Подключаемся снова…");
    fireEvent.keyDown(screen.getByRole("img"), { key: "Q" });
    expect(decode).not.toHaveBeenCalled();
    expect(bridge.demoExecute).not.toHaveBeenCalled();
  },
);

it("lists open shows only on request; confirms by exact instance with safe cancellation and recoverable error", async () => {
  const { s } = fixture();
  const stop = vi
    .fn(async (_id: string) => {})
    .mockRejectedValueOnce(new Error("Не удалось закрыть браузер."));
  const view = render(<DemoOpenShows shows={[]} stop={stop} />);
  expect(screen.queryByText(/Открытые показы/)).toBeNull();
  view.rerender(<DemoOpenShows shows={s.shows} stop={stop} />);
  const summary = screen.getByText("Открытые показы (2)");
  expect(summary.closest("details")?.open).toBe(false);
  fireEvent.click(summary);
  const close = () =>
    screen.getByRole("button", { name: "Завершить показ: Второй" });
  fireEvent.mouseEnter(close());
  expect(close().ownerDocument.getElementById(close().getAttribute("aria-describedby")!)?.textContent).toBe("Завершить показ: Второй");
  expect(screen.queryByRole("link")).toBeNull();
  fireEvent.click(close());
  const dialog = screen.getByRole("dialog", { name: "Завершить показ?" });
  expect(dialog.textContent).toContain("Второй");
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "Отмена" }),
  );
  fireEvent.click(document.activeElement!);
  expect(stop).not.toHaveBeenCalled();
  const confirm = () =>
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Завершить показ",
      }),
    );
  fireEvent.click(close());
  confirm();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Не удалось закрыть браузер.",
  );
  fireEvent.click(close());
  confirm();
  await waitFor(() => expect(stop.mock.calls).toEqual([["b"], ["b"]]));
});

it("withdraws a settings confirmation if another show replaces its instance, even under the same label", async () => {
  const { s } = fixture();
  const stop = vi.fn(async (_id: string) => {});
  const view = render(<DemoOpenShows shows={s.shows} stop={stop} />);
  fireEvent.click(screen.getByText("Открытые показы (2)"));
  fireEvent.click(
    screen.getByRole("button", { name: "Завершить показ: Первый" }),
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(
    <DemoOpenShows
      shows={[{ ...s.shows[0], showId: "replacement" }, s.shows[1]]}
      stop={stop}
    />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(stop).not.toHaveBeenCalled();

  // A detached and restored checkout can have two shows with the same name.
  view.rerender(
    <DemoOpenShows
      shows={[s.shows[0], { ...s.shows[0], showId: "replacement" }]}
      stop={stop}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Завершить показ: Первый · №1" }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Завершить показ",
    }),
  );
  await waitFor(() => expect(stop.mock.calls).toEqual([["a"]]));
});

function tabsFixture() {
  const f = fixture();
  f.s.shows[0].tabs = [
    { tabId: "first", title: "Главная", url: "https://one.example/" },
    { tabId: "second", title: "Справка", url: "https://help.example/" },
    { tabId: "blank", title: "", url: null },
  ];
  f.s.shows[0].activeTabId = "first";
  f.s.shows[1].tabs = [
    {
      tabId: "foreign",
      title: "Чужая страница",
      url: "https://other.example/",
    },
  ];
  f.s.shows[1].activeTabId = "foreign";
  f.bridge.demoExecute.mockImplementation(async (cmd: DemoCommand) => {
    if (!("showId" in cmd)) return;
    const show = f.s.shows.find((s) => s.showId === cmd.showId)!;
    if (cmd.action === "tab-select") {
      show.activeTabId = cmd.tabId;
      show.url = show.tabs!.find((tab) => tab.tabId === cmd.tabId)!.url;
    }
    if (cmd.action === "tab-create") {
      show.tabs!.push({ tabId: "created", title: "Созданная", url: null });
      show.activeTabId = "created";
      show.url = null;
    }
    if (cmd.action === "tab-close") {
      show.tabs = show.tabs!.filter((tab) => tab.tabId !== cmd.tabId);
      if (show.activeTabId === cmd.tabId) {
        show.activeTabId = show.tabs[0]?.tabId ?? null;
        show.url = show.tabs[0]?.url ?? null;
      }
    }
  });
  return f;
}

it("keeps tabs, address and essential icon actions in one compact toolbar in both layouts", async () => {
  const { store } = tabsFixture();
  const settings = vi.fn();
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={settings} />);
  function checkToolbar(root: HTMLElement, expanded: boolean) {
    const toolbar = within(root).getByRole("toolbar", {
      name: "Управление показом",
    });
    const controls = within(toolbar);
    expect(
      controls.getByRole("tablist", { name: "Вкладки показа" }),
    ).toBeTruthy();
    for (const tab of controls.getAllByRole("tab")) {
      expect(tab.classList.contains("workspace-tab-select")).toBe(true);
      expect(tab.closest(".workspace-tab")?.getAttribute("data-selected")).toBe(
        tab.getAttribute("aria-selected"),
      );
    }
    for (const close of controls.getAllByRole("button", {
      name: /^Закрыть вкладку:/,
    })) {
      expect(close.classList.contains("workspace-tab-close")).toBe(true);
    }
    expect(
      controls
        .getByRole("button", { name: "Создать вкладку" })
        .classList.contains("workspace-tab-create"),
    ).toBe(true);
    expect(
      controls.getByRole("textbox", { name: "Адрес страницы" }),
    ).toBeTruthy();
    expect(
      controls.getByRole("button", { name: "Обновить страницу" }),
    ).toBeTruthy();
    const transfer = controls.getByRole("button", {
      name: "Передать управление",
    });
    fireEvent.mouseEnter(transfer);
  expect(transfer.ownerDocument.getElementById(transfer.getAttribute("aria-describedby")!)?.textContent).toBe("Передать управление");
    fireEvent.keyDown(transfer, { key: "Escape" });
    expect(transfer.textContent).toBe("");
    const toggle = controls.getByRole("button", {
      name: expanded ? "Свернуть показ" : "Развернуть показ",
    });
    expect(toggle.textContent).toBe("");
    expect(toggle.getAttribute("aria-controls")).toBeTruthy();
    expect(
      document.getElementById(toggle.getAttribute("aria-controls")!),
    ).toBeTruthy();
    expect(
      controls.getByRole("status", { name: "Агент подключён" }).title,
    ).toBe("Агент подключён");
    expect(controls.queryByRole("note", { name: "Порт 45678" })).toBeNull();
    expect(
      controls.getByRole("button", { name: "Скопировать адрес страницы" }),
    ).toBeTruthy();
    expect(root.querySelectorAll(".demo-bar")).toHaveLength(1);
    expect(root.querySelector("strong")).toBeNull();
    return toggle;
  }
  fireEvent.click(checkToolbar(screen.getByRole("tabpanel"), false));
  const full = screen.getByRole("dialog", { name: "Развёрнутый показ" });
  checkToolbar(full, true);
  expect(within(full).getByTestId("demo-collapse")).toBeTruthy();
  expect(
    within(full).getByRole("button", { name: "Открыть в браузере" }),
  ).toBeTruthy();
  fireEvent.click(
    within(full).getByRole("button", { name: "Настройки порта" }),
  );
  expect(settings).toHaveBeenCalledOnce();
});

it("keeps expanded transfer confirmation scoped to the current connection and port owner", async () => {
  const { store, s, bridge } = tabsFixture();
  await store.refresh();
  const view = render(
    <DemoPanel key="a" store={store} showId="a" onSettings={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Развернуть показ" }));
  fireEvent.click(
    within(screen.getByTestId("demo-expanded")).getByRole("button", {
      name: "Передать управление",
    }),
  );
  const staleHandoff = screen.getByTestId("demo-confirm");
  // A target can retire before React commits another snapshot.
  store.state!.access.connectionId = "replacement";
  fireEvent.click(staleHandoff);
  expect(bridge.demoExecute).not.toHaveBeenCalled();
  expect(screen.queryByTestId("demo-dialog")).toBeNull();
  view.rerender(
    <DemoPanel key="b" store={store} showId="b" onSettings={() => {}} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Развернуть показ" }));
  const full = screen.getByTestId("demo-expanded");
  const transfer = within(full).getByRole("button", {
    name: "Переключить порт сюда",
  });
  expect(transfer.textContent).toBe("");
  fireEvent.click(transfer);
  expect(screen.getByTestId("demo-dialog").textContent).toContain("Первый");
  store.state!.access.owner = "b";
  fireEvent.click(screen.getByTestId("demo-confirm"));
  expect(bridge.demoExecute).not.toHaveBeenCalled();
  expect(screen.queryByTestId("demo-dialog")).toBeNull();
  s.access.owner = "a";
  await act(() => store.refresh());
  fireEvent.click(
    within(full).getByRole("button", { name: "Переключить порт сюда" }),
  );
  fireEvent.click(screen.getByTestId("demo-cancel"));
  expect(bridge.demoExecute).not.toHaveBeenCalled();
});

it("opens the narrow address overlay without losing Enter, Escape or show and tab draft isolation", async () => {
  const { store, bridge, s } = tabsFixture();
  await store.refresh();
  const view = render(
    <DemoPanel store={store} showId="a" onSettings={() => {}} />,
  );
  const address = () =>
    screen.getByRole("textbox", { name: "Адрес страницы" }) as HTMLInputElement;
  const toggle = () =>
    screen.getByRole("button", { name: "Показать адрес страницы" });
  fireEvent.click(toggle());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(address());
  expect(
    document
      .getElementById(toggle().getAttribute("aria-controls")!)
      ?.contains(address()),
  ).toBe(true);
  fireEvent.change(address(), {
    target: { value: "https://cancelled.example/" },
  });
  fireEvent.keyDown(address(), { key: "Escape" });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(address().value).toBe("https://one.example/");
  expect(document.activeElement).toBe(toggle());
  expect(bridge.demoExecute).not.toHaveBeenCalled();
  fireEvent.click(toggle());
  fireEvent.change(address(), {
    target: { value: "https://submitted.example/" },
  });
  fireEvent.keyDown(address(), { key: "Enter" });
  await waitFor(() =>
    expect(toggle().getAttribute("aria-expanded")).toBe("false"),
  );
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "navigate",
    showId: "a",
    url: "https://submitted.example/",
  });
  fireEvent.click(toggle());
  fireEvent.change(address(), {
    target: { value: "https://private-draft.example/" },
  });
  s.shows[0].activeTabId = "second";
  s.shows[0].url = "https://help.example/";
  await act(() => store.refresh());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(address().value).toBe("https://help.example/");
  fireEvent.click(toggle());
  fireEvent.change(address(), {
    target: { value: "https://foreign-draft.example/" },
  });
  view.rerender(<DemoPanel store={store} showId="b" onSettings={() => {}} />);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(address().value).toBe("");
});

it("keeps the current port owner's name accessible even while an action notice occupies the footer", async () => {
  const { store, bridge, s } = tabsFixture();
  await store.refresh();
  render(<DemoPanel store={store} showId="b" onSettings={() => {}} />);
  const status = () =>
    screen.getByRole("status", { name: "Порт привязан к показу «Первый»" });
  expect(status().title).toBe("Порт привязан к показу «Первый»");
  fireEvent.click(screen.getByRole("button", { name: "Обновить страницу" }));
  await screen.findByText("Страница обновлена.");
  expect(status().title).toContain("Первый");
  fireEvent.click(screen.getByRole("button", { name: "Открыть в браузере" }));
  await screen.findByText("Показ открыт в основном браузере.");
  expect(status().title).toContain("Первый");
  expect(bridge.demoOpenBrowser).toHaveBeenCalledWith("b");
  s.shows[0].label = "Переименованный владелец";
  await act(() => store.refresh());
  expect(
    screen.getByRole("status", {
      name: "Порт привязан к показу «Переименованный владелец»",
    }).title,
  ).toContain("Переименованный владелец");
});

it("scrolls overflowing tabs horizontally with a vertical mouse wheel without consuming zoom or horizontal gestures", async () => {
  const { store } = tabsFixture();
  await store.refresh();
  const view = render(
    <DemoPanel store={store} showId="a" onSettings={() => {}} />,
  );
  const tabs = screen.getByRole("tablist", { name: "Вкладки показа" });
  Object.defineProperties(tabs, {
    scrollWidth: { configurable: true, value: 900 },
    clientWidth: { configurable: true, value: 120 },
  });
  expect(fireEvent.wheel(tabs, { deltaY: 45, deltaX: 0 })).toBe(false);
  expect(tabs.scrollLeft).toBe(45);
  for (const gesture of [
    { deltaY: 45, ctrlKey: true },
    { deltaY: 45, metaKey: true },
    { deltaY: 5, deltaX: 20 },
    { deltaY: 0, deltaX: 20 },
  ]) {
    expect(fireEvent.wheel(tabs, gesture)).toBe(true);
    expect(tabs.scrollLeft).toBe(45);
  }
  Object.defineProperty(tabs, "scrollWidth", {
    configurable: true,
    value: 120,
  });
  expect(fireEvent.wheel(tabs, { deltaY: 45 })).toBe(true);
  expect(tabs.scrollLeft).toBe(45);
  Object.defineProperty(tabs, "scrollWidth", {
    configurable: true,
    value: 900,
  });
  view.unmount();
  expect(fireEvent.wheel(tabs, { deltaY: 45 })).toBe(true);
  expect(tabs.scrollLeft).toBe(45);
});

it("shows only the current show's tabs before the address and binds select, create and close to that show in both layouts", async () => {
  const { store, bridge } = tabsFixture();
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  const tabs = screen.getByRole("tablist", { name: "Вкладки показа" });
  expect(within(tabs).getAllByRole("tab")).toHaveLength(3);
  expect(
    within(tabs)
      .getByRole("tab", { name: "Главная" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(within(tabs).getByRole("tab", { name: "Новая вкладка" })).toBeTruthy();
  expect(screen.queryByText("Чужая страница")).toBeNull();
  expect(document.querySelector("button button")).toBeNull();
  expect(
    tabs.compareDocumentPosition(
      screen.getByRole("textbox", { name: "Адрес страницы" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);

  fireEvent.click(within(tabs).getByRole("tab", { name: "Справка" }));
  await waitFor(() =>
    expect(
      within(tabs)
        .getByRole("tab", { name: "Справка" })
        .getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "tab-select",
    showId: "a",
    tabId: "second",
  });
  fireEvent.click(
    within(tabs).getByRole("button", { name: "Закрыть вкладку: Главная" }),
  );
  await waitFor(() =>
    expect(within(tabs).queryByRole("tab", { name: "Главная" })).toBeNull(),
  );
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "tab-close",
    showId: "a",
    tabId: "first",
  });
  expect(
    within(tabs)
      .getByRole("tab", { name: "Справка" })
      .getAttribute("aria-selected"),
  ).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Создать вкладку" }));
  await screen.findByRole("tab", { name: "Созданная", selected: true });
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "tab-create",
    showId: "a",
  });
  fireEvent.click(screen.getByRole("button", { name: "Развернуть показ" }));
  const full = screen.getByRole("dialog", { name: "Развёрнутый показ" });
  const fullTabs = within(full).getByRole("tablist", {
    name: "Вкладки показа",
  });
  expect(
    fullTabs.compareDocumentPosition(
      within(full).getByRole("textbox", { name: "Адрес страницы" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  fireEvent.click(within(fullTabs).getByRole("tab", { name: "Справка" }));
  await waitFor(() =>
    expect(
      within(fullTabs).getByRole("tab", { name: "Справка", selected: true }),
    ).toBeTruthy(),
  );
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "tab-select",
    showId: "a",
    tabId: "second",
  });
  expect(
    bridge.demoExecute.mock.calls.some(([cmd]) => cmd.action === "stop"),
  ).toBe(false);
});

it("labels Chromium's empty-page snapshot as a new tab and closes only the exact owning tab id", async () => {
  const { store, bridge, s } = tabsFixture();
  s.shows[0].tabs = [
    { tabId: "blank-first", title: "about:blank", url: null },
    { tabId: "blank-second", title: "about:blank", url: null },
    {
      tabId: "literal-title",
      title: "about:blank",
      url: "https://one.example/",
    },
    {
      tabId: "normal-page",
      title: "Обычная страница",
      url: "https://help.example/",
    },
  ];
  s.shows[0].activeTabId = "blank-first";
  s.shows[0].url = null;
  s.shows[1].tabs = [{ tabId: "blank-first", title: "about:blank", url: null }];
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  expect(screen.getAllByRole("tab", { name: "Новая вкладка" })).toHaveLength(2);
  expect(screen.getByRole("tab", { name: "about:blank" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Обычная страница" })).toBeTruthy();
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "Закрыть вкладку: Новая вкладка",
    })[1],
  );
  await waitFor(() =>
    expect(bridge.demoExecute).toHaveBeenLastCalledWith({
      action: "tab-close",
      showId: "a",
      tabId: "blank-second",
    }),
  );
  expect(screen.getAllByRole("tab", { name: "Новая вкладка" })).toHaveLength(1);
  bridge.demoExecute.mockClear();
  const staleClose = screen.getByRole("button", {
    name: "Закрыть вкладку: Новая вкладка",
  });
  // The identical tab id in the other show never authorizes this stale close.
  store.state!.shows[0].tabs = store.state!.shows[0].tabs!.filter(
    (tab) => tab.tabId !== "blank-first",
  );
  fireEvent.click(staleClose);
  expect(bridge.demoExecute).not.toHaveBeenCalled();
});

it("keeps tab selection authoritative and clears address drafts when active tab or owning show changes", async () => {
  const { store, bridge, s } = tabsFixture();
  const pending = deferred<void>();
  bridge.demoExecute.mockImplementationOnce(() => pending.promise);
  await store.refresh();
  const view = render(
    <DemoPanel store={store} showId="a" onSettings={() => {}} />,
  );
  const address = () =>
    screen.getByRole("textbox", { name: "Адрес страницы" }) as HTMLInputElement;
  fireEvent.change(address(), {
    target: { value: "https://private-draft.example/" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "Справка" }));
  expect(
    screen.getByRole("tab", { name: "Главная", selected: true }),
  ).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "Справка", selected: false }),
  ).toBeTruthy();
  expect(address().value).toBe("https://private-draft.example/");
  s.shows[0].activeTabId = "second";
  s.shows[0].url = "https://help.example/";
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  await waitFor(() => expect(address().value).toBe("https://help.example/"));
  expect(
    screen.getByRole("tab", { name: "Справка", selected: true }),
  ).toBeTruthy();

  // Tab ids can repeat across browser contexts; the draft must not follow them.
  s.shows[1].tabs = [
    {
      tabId: "second",
      title: "Другой контекст",
      url: "https://other.example/",
    },
  ];
  s.shows[1].activeTabId = "second";
  s.shows[1].url = "https://other.example/";
  await act(() => store.refresh());
  fireEvent.change(address(), {
    target: { value: "https://another-draft.example/" },
  });
  view.rerender(<DemoPanel store={store} showId="b" onSettings={() => {}} />);
  expect(address().value).toBe("https://other.example/");
  expect(screen.queryByRole("tab", { name: "Справка" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть вкладку: Другой контекст" }),
  );
  await waitFor(() =>
    expect(bridge.demoExecute).toHaveBeenLastCalledWith({
      action: "tab-close",
      showId: "b",
      tabId: "second",
    }),
  );
});

it("moves focus and selects tabs with wrapping arrows, Home and End while retaining a single tab stop", async () => {
  const { store, bridge } = tabsFixture();
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  const first = screen.getByRole("tab", { name: "Главная" });
  const second = screen.getByRole("tab", { name: "Справка" });
  const last = screen.getByRole("tab", { name: "Новая вкладка" });
  expect([first.tabIndex, second.tabIndex, last.tabIndex]).toEqual([0, -1, -1]);
  first.focus();
  for (const [from, key, target, tabId] of [
    [first, "ArrowRight", second, "second"],
    [second, "End", last, "blank"],
    [last, "ArrowRight", first, "first"],
    [first, "ArrowLeft", last, "blank"],
    [last, "Home", first, "first"],
  ] as const) {
    fireEvent.keyDown(from, { key });
    await waitFor(() =>
      expect(target.getAttribute("aria-selected")).toBe("true"),
    );
    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(0);
    expect(bridge.demoExecute).toHaveBeenLastCalledWith({
      action: "tab-select",
      showId: "a",
      tabId,
    });
  }
});

it("drops a stale tab command rather than targeting a tab that now belongs only to another show", async () => {
  const { store, bridge, s } = tabsFixture();
  s.shows[1].tabs!.push({
    tabId: "second",
    title: "Другой владелец",
    url: null,
  });
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  const stale = screen.getByRole("tab", { name: "Справка" });
  // The store can retire a target before React has committed its next render.
  store.state!.shows[0].tabs = store.state!.shows[0].tabs!.filter(
    (tab) => tab.tabId !== "second",
  );
  fireEvent.click(stale);
  expect(bridge.demoExecute).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Закрыть вкладку: Справка" }),
  );
  expect(bridge.demoExecute).not.toHaveBeenCalled();
});

it("returns keyboard focus to the host-selected tab after closing, clears its address draft and focuses create when empty", async () => {
  const { store, bridge } = tabsFixture();
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  fireEvent.click(screen.getByRole("tab", { name: "Справка" }));
  await screen.findByRole("tab", { name: "Справка", selected: true });
  fireEvent.change(screen.getByRole("textbox", { name: "Адрес страницы" }), {
    target: { value: "https://closing-draft.example/" },
  });
  const closeHelp = screen.getByRole("button", {
    name: "Закрыть вкладку: Справка",
  });
  closeHelp.focus();
  fireEvent.click(closeHelp);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Главная", selected: true }),
    ),
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Адрес страницы",
      }) as HTMLInputElement
    ).value,
  ).toBe("https://one.example/");
  expect(bridge.demoExecute).toHaveBeenLastCalledWith({
    action: "tab-close",
    showId: "a",
    tabId: "second",
  });
  for (const label of ["Главная", "Новая вкладка"]) {
    const closeTab = screen.getByRole("button", {
      name: "Закрыть вкладку: " + label,
    });
    closeTab.focus();
    fireEvent.click(closeTab);
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: label })).toBeNull(),
    );
  }
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Создать вкладку" }),
    ),
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Адрес страницы",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
});

it("retires the previous tab's canvas and ignores its late bitmap when the host selects a different tab", async () => {
  const { store, bridge, s } = tabsFixture();
  const old = deferred<Uint8Array>(),
    next = deferred<Uint8Array>();
  bridge.demoFrame
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => next.promise);
  const drawImage = vi.fn(),
    close = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage,
  } as any);
  const decode = vi.fn(async () => ({ width: 2, height: 1, close }));
  vi.stubGlobal("createImageBitmap", decode);
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0,
    0, 0, 1,
  ]);
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  const oldCanvas = screen.getByRole("img");
  s.shows[0].activeTabId = "second";
  s.shows[0].url = "https://help.example/";
  await act(() => store.refresh());
  expect(screen.getByRole("img")).not.toBe(oldCanvas);
  await act(async () => {
    old.resolve(png);
    await old.promise;
  });
  expect(decode).not.toHaveBeenCalled();
  await act(async () => {
    next.resolve(png);
    await next.promise;
  });
  await waitFor(() => expect(drawImage).toHaveBeenCalledTimes(1));
});

describe("active-page frame stream", () => {
  const png = Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0,
    0, 0, 1,
  ]);
  const packet = { cursor: "first-frame", pixels: png };

  it("streams only the active tab, waits for decode before requesting its successor, and does not poll screenshots on heartbeat", async () => {
    const { bridge, store } = tabsFixture();
    const decode = deferred<ImageBitmap>();
    const pending = deferred<typeof packet | null>();
    const nextFrame = vi
      .fn()
      .mockResolvedValueOnce(packet)
      .mockResolvedValueOnce(null)
      .mockReturnValue(pending.promise);
    Object.assign(window.goga, { demoNextFrame: nextFrame });
    const drawImage = vi.fn(),
      close = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as any);
    const decoder = vi.fn(() => decode.promise);
    vi.stubGlobal("createImageBitmap", decoder);
    await store.refresh();
    render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
    await waitFor(() => expect(decoder).toHaveBeenCalledOnce());
    expect(nextFrame.mock.calls).toEqual([["a", "first", null]]);
    await act(async () =>
      decode.resolve({ width: 2, height: 1, close } as ImageBitmap),
    );
    await waitFor(() => expect(nextFrame.mock.calls.length).toBe(3));
    expect(nextFrame.mock.calls.slice(1)).toEqual([
      ["a", "first", packet.cursor],
      ["a", "first", packet.cursor],
    ]);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(bridge.demoFrame).not.toHaveBeenCalled();
  });

  it("binds every manual gesture to the painted tab, rejecting input before first paint or after visibility changes", async () => {
    const { bridge } = fixture();
    const frame = deferred<typeof packet>();
    const nextFrame = vi
      .fn()
      .mockReturnValueOnce(frame.promise)
      .mockImplementation(() => new Promise(() => {}));
    Object.assign(window.goga, { demoNextFrame: nextFrame });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as any);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 2, height: 1, close() {} })),
    );
    render(
      <DemoFrame
        showId="show"
        tabId="painted-tab"
        disabled={false}
        onError={() => {}}
      />,
    );
    const canvas = screen.getByRole("img");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    } as DOMRect);
    fireEvent.keyDown(canvas, { key: "Q" });
    expect(bridge.demoExecute).not.toHaveBeenCalled();
    await act(async () => frame.resolve(packet));
    await waitFor(() => expect(drawImage).toHaveBeenCalledOnce());
    fireEvent.click(canvas, { clientX: 100, clientY: 50 });
    fireEvent.wheel(canvas, { clientX: 100, clientY: 50, deltaY: 11 });
    fireEvent.keyDown(canvas, { key: "Enter" });
    fireEvent.keyDown(canvas, { key: "a" });
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(4));
    expect(bridge.demoExecute.mock.calls.map(([cmd]) => cmd)).toEqual(
      [
        { action: "click", x: 0.5, y: 0.5 },
        { action: "scroll", x: 0.5, y: 0.5, deltaY: 11 },
        { action: "key", key: "Enter" },
        { action: "text", text: "a" },
      ].map((input) => ({
        action: "input",
        showId: "show",
        tabId: "painted-tab",
        input,
      })),
    );
    let hidden = true;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    fireEvent(document, new Event("visibilitychange"));
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.keyDown(canvas, { key: "K" });
    expect(bridge.demoExecute).toHaveBeenCalledTimes(4);
  });

  it("waits for an active tab identity and does not start a hidden stream", async () => {
    const { bridge, s, store } = tabsFixture();
    const nextFrame = vi.fn().mockResolvedValue(null);
    Object.assign(window.goga, { demoNextFrame: nextFrame });
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    s.shows[0].activeTabId = null;
    await store.refresh();
    render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
    expect(nextFrame).not.toHaveBeenCalled();
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    s.shows[0].activeTabId = "first";
    await act(() => store.refresh());
    expect(nextFrame).not.toHaveBeenCalled();
    expect(bridge.demoFrame).not.toHaveBeenCalled();
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    expect(nextFrame).toHaveBeenCalledWith("a", "first", null);
  });

  it("discards a retired tab's decoded stream bitmap and never falls back to a show-only screenshot when the new tab fails", async () => {
    const { bridge, s, store } = tabsFixture();
    const decode = deferred<ImageBitmap>();
    const nextFrame = vi
      .fn()
      .mockResolvedValueOnce(packet)
      .mockRejectedValue(new Error("stale tab"));
    Object.assign(window.goga, { demoNextFrame: nextFrame });
    const decoder = vi.fn(() => decode.promise),
      drawImage = vi.fn(),
      close = vi.fn();
    vi.stubGlobal("createImageBitmap", decoder);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as any);
    await store.refresh();
    render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
    await waitFor(() => expect(decoder).toHaveBeenCalledOnce());
    s.shows[0].activeTabId = "second";
    await act(() => store.refresh());
    await screen.findByText("Нет изображения. Подключаемся снова…");
    await act(async () =>
      decode.resolve({ width: 2, height: 1, close } as ImageBitmap),
    );
    expect(drawImage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(nextFrame).toHaveBeenLastCalledWith("a", "second", null);
    expect(bridge.demoFrame).not.toHaveBeenCalled();
  });

  it("releases demand while hidden and rejects a pre-hide response even after returning to the same tab", async () => {
    const { bridge, store } = tabsFixture();
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const old = deferred<typeof packet | null>(),
      waiting = deferred<typeof packet | null>();
    const nextFrame = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValue(waiting.promise);
    Object.assign(window.goga, { demoNextFrame: nextFrame });
    const decoder = vi.fn();
    vi.stubGlobal("createImageBitmap", decoder);
    await store.refresh();
    render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
    expect(nextFrame).toHaveBeenCalledOnce();
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    expect(nextFrame).toHaveBeenCalledOnce();
    await act(async () => old.resolve(packet));
    await waitFor(() => expect(nextFrame).toHaveBeenCalledTimes(2));
    expect(nextFrame).toHaveBeenLastCalledWith("a", "first", null);
    expect(decoder).not.toHaveBeenCalled();
    expect(bridge.demoFrame).not.toHaveBeenCalled();
  });
});

it("copies the active page through host-bound clipboard, not the address draft; confirms briefly in both layouts", async () => {
  const { store, s, bridge } = fixture();
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  expect(screen.queryByLabelText("Порт 45678")).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Адрес страницы" }), {
    target: { value: "https://unsent.example/" },
  });
  const copy = () =>
    screen.getByRole("button", { name: "Скопировать адрес страницы" });
  fireEvent.click(copy());
  await screen.findByText("Скопировано", { selector: ".demo-copy-feedback" });
  expect(bridge.demoCopyURL).toHaveBeenCalledWith("a", "a-tab");
  expect(bridge.demoExecute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Развернуть показ" }));
  fireEvent.click(copy());
  await waitFor(() => expect(bridge.demoCopyURL).toHaveBeenCalledTimes(2));
  s.shows[0].url = null;
  await act(() => store.refresh());
  expect((copy() as HTMLButtonElement).disabled).toBe(true);
});
it("reports clipboard errors without a success marker or a page reload", async () => {
  const { store, bridge } = fixture();
  await store.refresh();
  bridge.demoCopyURL.mockRejectedValueOnce(Error("Буфер недоступен"));
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Скопировать адрес страницы" }),
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toBe("Буфер недоступен");
  expect(screen.queryByText("Скопировано")).toBeNull();
  expect(bridge.demoExecute).not.toHaveBeenCalled();
});

it("expires the short copy confirmation and ignores completion for a replaced URL", async () => {
  const { store, s, bridge } = fixture();
  await store.refresh();
  render(<DemoPanel store={store} showId="a" onSettings={() => {}} />);
  vi.useFakeTimers();
  const copy = () =>
    screen.getByRole("button", { name: "Скопировать адрес страницы" });
  await act(async () => {
    fireEvent.click(copy());
  });
  expect(screen.getByText("Скопировано")).toBeTruthy();
  await act(async () => {
    vi.advanceTimersByTime(1800);
  });
  expect(screen.queryByText("Скопировано")).toBeNull();
  const pending = deferred<void>();
  bridge.demoCopyURL.mockImplementationOnce(() => pending.promise);
  fireEvent.click(copy());
  s.shows[0].url = "https://new.example/";
  await act(() => store.refresh());
  await act(async () => {
    pending.resolve();
    await pending.promise;
  });
  expect(screen.queryByText("Скопировано")).toBeNull();
  expect((copy() as HTMLButtonElement).disabled).toBe(false);
});

describe("selection gestures and host clipboard", () => {
  async function surface() {
    const { bridge } = fixture();
    class TestPointer extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: any) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "mouse";
      }
    }
    vi.stubGlobal("PointerEvent", TestPointer);
    const pixels = Uint8Array.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2,
      0, 0, 0, 1,
    ]);
    Object.assign(bridge, {
      demoNextFrame: vi
        .fn()
        .mockResolvedValueOnce({ cursor: "c", pixels })
        .mockImplementation(() => new Promise(() => {})),
    });
    const draw = vi.fn(),
      error = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: draw,
    } as any);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 2, height: 1, close() {} })),
    );
    const view = render(
      <DemoFrame
        showId="show-a"
        tabId="tab-a"
        disabled={false}
        onError={error}
      />,
    );
    await waitFor(() => expect(draw).toHaveBeenCalledOnce());
    const canvas = screen.getByRole("img");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100,
    } as DOMRect);
    Object.defineProperty(canvas, "setPointerCapture", {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(canvas, "releasePointerCapture", {
      value: vi.fn(),
      configurable: true,
    });
    return { bridge, canvas, view, error };
  }
  const pointer = (
    canvas: HTMLElement,
    phase: "down" | "move" | "up",
    x: number,
    y: number,
    detail = 1,
  ) =>
    fireEvent[
      phase === "down"
        ? "pointerDown"
        : phase === "move"
          ? "pointerMove"
          : "pointerUp"
    ](canvas, {
      pointerId: 3,
      pointerType: "mouse",
      button: 0,
      buttons: phase === "up" ? 0 : 1,
      clientX: x,
      clientY: y,
      detail,
    });
  it("serializes captured drag packets, coalesces moves, suppresses the browser click, then copies only the painted owner", async () => {
    const { bridge, canvas } = await surface(),
      down = deferred<void>();
    bridge.demoExecute.mockImplementationOnce(() => down.promise);
    pointer(canvas, "down", 20, 20);
    pointer(canvas, "move", 80, 20);
    pointer(canvas, "move", 120, 20);
    pointer(canvas, "up", 160, 20);
    fireEvent.click(canvas, { clientX: 160, clientY: 20, detail: 1 });
    fireEvent.keyDown(canvas, { key: "c", metaKey: true });
    expect(bridge.demoCopySelection).not.toHaveBeenCalled();
    await act(async () => {
      down.resolve();
      await down.promise;
    });
    await waitFor(() =>
      expect(bridge.demoCopySelection).toHaveBeenCalledTimes(1),
    );
    const packets = bridge.demoExecute.mock.calls.map(([c]) => c as any);
    expect(packets.map((c) => c.input.phase)).toEqual(["down", "move", "up"]);
    expect(
      packets.every((c) => c.showId === "show-a" && c.tabId === "tab-a"),
    ).toBe(true);
    expect(new Set(packets.map((c) => c.input.gestureId)).size).toBe(1);
    expect(packets[1].input.x).toBe(0.6);
    expect(bridge.demoCopySelection).toHaveBeenCalledWith(
      "show-a",
      "tab-a",
      expect.any(String),
    );
    expect(canvas.setPointerCapture).toHaveBeenCalledWith(3);
  });
  it("provides a themed Copy menu without sending a page right-click, and deduplicates native copy while pending", async () => {
    const { bridge, canvas } = await surface(),
      copy = deferred<boolean>();
    bridge.demoCopySelection.mockImplementationOnce(() => copy.promise);
    fireEvent.contextMenu(canvas, { clientX: 70, clientY: 40 });
    const menu = await screen.findByRole("menu", {
      name: "Действия со страницей",
    });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Копировать" }));
    fireEvent.copy(canvas);
    await waitFor(() =>
      expect(bridge.demoCopySelection).toHaveBeenCalledTimes(1),
    );
    expect(bridge.demoExecute).not.toHaveBeenCalled();
    await act(async () => copy.resolve(true));
    await screen.findByText("Скопировано");
    expect(screen.queryByRole("menu")).toBeNull();
  });
  it("releases the original gesture and revokes a pending clipboard request before replacing the page", async () => {
    const { bridge, canvas, view } = await surface(),
      copy = deferred<boolean>();
    pointer(canvas, "down", 20, 20);
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event("blur"));
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(2));
    expect((bridge.demoExecute.mock.calls[1][0] as any).input.phase).toBe(
      "cancel",
    );
    bridge.demoCopySelection.mockImplementationOnce(() => copy.promise);
    fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
    await waitFor(() =>
      expect(bridge.demoCopySelection).toHaveBeenCalledTimes(1),
    );
    const request = bridge.demoCopySelection.mock.calls[0][2];
    view.rerender(
      <DemoFrame
        showId="show-b"
        tabId="tab-b"
        disabled={false}
        onError={() => {}}
      />,
    );
    await waitFor(() =>
      expect(bridge.demoCancelSelectionCopy).toHaveBeenCalledWith(request),
    );
    await act(async () => copy.resolve(true));
    expect(screen.queryByText("Скопировано")).toBeNull();
  });
  it("preserves double-clicks and clamps a backwards drag outside the rendered page without a second synthetic click", async () => {
    const { bridge, canvas } = await surface();
    pointer(canvas, "down", 50, 30, 1);
    pointer(canvas, "up", 50, 30, 1);
    fireEvent.click(canvas, { clientX: 50, clientY: 30, detail: 1 });
    pointer(canvas, "down", 50, 30, 2);
    pointer(canvas, "up", 50, 30, 2);
    fireEvent.click(canvas, { clientX: 50, clientY: 30, detail: 2 });
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(4));
    const packets = bridge.demoExecute.mock.calls.map(
      ([c]) => (c as any).input,
    );
    expect(
      packets.filter((p) => p.phase === "down").map((p) => p.clickCount),
    ).toEqual([1, 2]);
    pointer(canvas, "down", 150, 30, 1);
    pointer(canvas, "move", -20, 120);
    pointer(canvas, "up", -20, 120);
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(7));
    expect((bridge.demoExecute.mock.calls[6][0] as any).input).toMatchObject({
      action: "pointer",
      phase: "up",
      x: 0,
      y: 1,
    });
  });
  it("sends only a cancelling release after a hidden document invalidates an unfinished drag", async () => {
    const { bridge, canvas } = await surface();
    pointer(canvas, "down", 50, 30);
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(1));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(2));
    expect((bridge.demoExecute.mock.calls[1][0] as any).input.phase).toBe(
      "cancel",
    );
    fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
    expect(bridge.demoCopySelection).not.toHaveBeenCalled();
  });
  it("does not claim copy success for an empty selection and ignores the native copy duplicate of a shortcut", async () => {
    const { bridge, canvas } = await surface();
    bridge.demoCopySelection.mockResolvedValueOnce(false);
    fireEvent.keyDown(canvas, { key: "c", ctrlKey: true });
    await screen.findByText("Нет выделенного текста");
    fireEvent.copy(canvas);
    expect(bridge.demoCopySelection).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(canvas, { key: "c" });
    fireEvent.copy(canvas);
    await waitFor(() =>
      expect(bridge.demoCopySelection).toHaveBeenCalledTimes(2),
    );
    await screen.findByText("Скопировано");
  });
  it("copies by keyboard and native copy even while its custom context menu has focus", async () => {
    const { bridge, canvas } = await surface();
    fireEvent.contextMenu(canvas, { clientX: 70, clientY: 40 });
    const item = await screen.findByRole("menuitem", { name: "Копировать" });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: "c", metaKey: true });
    await waitFor(() =>
      expect(bridge.demoCopySelection).toHaveBeenCalledTimes(1),
    );
    expect(document.activeElement).toBe(canvas);
    fireEvent.keyUp(canvas, { key: "c" });
    fireEvent.contextMenu(canvas, { clientX: 70, clientY: 40 });
    fireEvent.copy(await screen.findByRole("menuitem", { name: "Копировать" }));
    await waitFor(() =>
      expect(bridge.demoCopySelection).toHaveBeenCalledTimes(2),
    );
  });
  it.each([true, false])(
    "starts a new double-click sequence immediately after a drag when native pointer detail is zero (move event: %s)",
    async (moved) => {
      const { bridge, canvas } = await surface();
      pointer(canvas, "down", 20, 20, 0);
      if (moved) pointer(canvas, "move", 160, 20, 0);
      pointer(canvas, "up", 160, 20, 0);
      fireEvent.click(canvas, { clientX: 160, clientY: 20, detail: 1 });
      pointer(canvas, "down", 21, 20, 0);
      pointer(canvas, "up", 21, 20, 0);
      fireEvent.click(canvas, { clientX: 21, clientY: 20, detail: 1 });
      pointer(canvas, "down", 21, 20, 0);
      pointer(canvas, "up", 21, 20, 0);
      fireEvent.click(canvas, { clientX: 21, clientY: 20, detail: 2 });
      await waitFor(() =>
        expect(bridge.demoExecute).toHaveBeenCalledTimes(moved ? 7 : 6),
      );
      expect(
        bridge.demoExecute.mock.calls
          .map(([c]) => (c as any).input)
          .filter((p) => p.phase === "down")
          .map((p) => p.clickCount),
      ).toEqual([1, 1, 2]);
    },
  );

  it("preserves zero-detail double and triple clicks within the normal mouse movement threshold", async () => {
    const { bridge, canvas } = await surface();
    for (const x of [20, 21, 22]) {
      pointer(canvas, "down", x, 20, 0);
      pointer(canvas, "move", x + 1, 20, 0);
      pointer(canvas, "up", x + 1, 20, 0);
      fireEvent.click(canvas, { clientX: x + 1, clientY: 20, detail: 1 });
    }
    await waitFor(() => expect(bridge.demoExecute).toHaveBeenCalledTimes(9));
    expect(
      bridge.demoExecute.mock.calls
        .map(([c]) => (c as any).input)
        .filter((p) => p.phase === "down")
        .map((p) => p.clickCount),
    ).toEqual([1, 2, 3]);
  });
});
