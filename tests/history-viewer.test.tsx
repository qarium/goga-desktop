import { installHistoryWorker } from "./helpers/history-worker";
// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  ProjectHistory,
  HistoryArtifacts,
} from "../src/renderer/ProjectHistory";
import { RetainedViews } from "../src/renderer/RetainedViews";
const project = { id: "p", name: "Project", path: "/fixture" };
let api: any;
const tree = [
  { path: "plan.md", kind: "file", readable: true },
  { path: "reports", kind: "directory", readable: true },
  { path: "reports/result.json", kind: "file", readable: true },
  { path: "image.png", kind: "file", readable: false, reason: "Двоичный файл" },
];
beforeEach(() => {
  installHistoryWorker();
  api = {
    listHistoryYears: vi.fn(async () => ["2026", "2025", "2024"]),
    listHistoryEntries: vi.fn(async (_s, y) =>
      y === "2024" ? [] : y === "2025" ? ["old"] : ["alpha", "beta"],
    ),
    listHistoryArtifacts: vi.fn(async () => tree),
    readHistoryArtifact: vi.fn(async (_s, y, e, p) => ({
      relativePath: `.goga/history/${y}/${e}/${p}`,
      text: p.endsWith("md")
        ? `# ${e}\n\n[Результат](reports/result.json)`
        : '{"ok":true}',
      format: p.endsWith("md") ? "markdown" : "text",
    })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function openEntry(name: string) {
  const entries = screen.queryByRole("region", { name: "История проекта" })
    ? await screen.findByLabelText("Запись истории")
    : null;
  if (entries) {
    await waitFor(() =>
      expect((entries as HTMLSelectElement).disabled).toBe(false),
    );
    fireEvent.click(entries);
    fireEvent.click(screen.getByRole("option", { name }));
  }
  fireEvent.click(await screen.findByRole("button", { name: "Файл plan.md" }));
  await screen.findByRole("heading", { name });
}
it("navigates year → entry → read-only Markdown / text, and explains unsupported files", async () => {
  render(<ProjectHistory project={project} />);
  await openEntry("alpha");
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /Сохранить/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Результат" }));
  await screen.findByText('{"ok":true}');
  fireEvent.click(screen.getByRole("button", { name: "Файл image.png" }));
  expect(screen.getByText("Двоичный файл")).toBeTruthy();
  expect(api.readHistoryArtifact).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    expect.anything(),
    "image.png",
    expect.anything(),
  );
  fireEvent.click(screen.getByLabelText("Запись истории"));
  fireEvent.click(screen.getByRole("option", { name: "beta" }));
  await openEntry("beta");
  fireEvent.click(screen.getByRole("combobox", { name: "Год" }));
  fireEvent.click(screen.getByRole("option", { name: "2025" }));
  await openEntry("old");
  fireEvent.click(screen.getByRole("combobox", { name: "Год" }));
  fireEvent.click(screen.getByRole("option", { name: "2024" }));
  await screen.findByText("За 2024 год записей нет");
});
it("settles errors and allows retry instead of an infinite loader", async () => {
  api.listHistoryYears.mockRejectedValueOnce(Error("Чтение недоступно"));
  render(<ProjectHistory project={project} />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await openEntry("alpha");
  api.readHistoryArtifact.mockRejectedValueOnce(Error("Файл изменился"));
  fireEvent.click(screen.getByRole("button", { name: "Результат" }));
  await screen.findByText("Файл изменился");
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить загрузку" }));
  await screen.findByText('{"ok":true}');
});
it("ignores a late old entry response and never shows another owner's content", async () => {
  let finish!: (v: any) => void;
  api.readHistoryArtifact.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  const view = render(<HistoryArtifacts scope="p" year="2026" entry="alpha" />);
  fireEvent.click(await screen.findByRole("button", { name: "Файл plan.md" }));
  await waitFor(() => expect(api.readHistoryArtifact).toHaveBeenCalled());
  view.rerender(<HistoryArtifacts scope="q" year="2025" entry="beta" />);
  await openEntry("beta");
  await act(async () =>
    finish({
      relativePath: ".goga/history/2026/alpha/plan.md",
      text: "# Wrong owner",
      format: "markdown",
    }),
  );
  expect(screen.queryByText("Wrong owner")).toBeNull();
});
it("fixed topic card uses its exact scope and target, without year/entry discovery", async () => {
  const target = { topic: "alpha", branch: "feature/alpha", remote: false };
  const scope = {
    projectId: "p",
    year: "2026",
    topic: "alpha",
    branch: "feature/alpha",
    contextId: "ctx-" + "a".repeat(64),
    revision: "0461b33f-4e7c-4bd2-b101-111111111111",
  };
  render(
    <HistoryArtifacts
      scope={scope}
      year="2026"
      entry="alpha"
      target={target}
    />,
  );
  await openEntry("alpha");
  expect(api.listHistoryArtifacts).toHaveBeenCalledWith(
    scope,
    "2026",
    "alpha",
    target,
  );
  expect(api.listHistoryYears).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).toBeNull();
});
it("retains selected year, entry and file when reactivated, with bounded refresh", async () => {
  const view = render(
    <RetainedViews activeKey="history">
      <ProjectHistory project={project} />
    </RetainedViews>,
  );
  await openEntry("alpha");
  fireEvent.click(screen.getByLabelText("Запись истории"));
  fireEvent.click(screen.getByRole("option", { name: "beta" }));
  await openEntry("beta");
  fireEvent.click(screen.getByRole("button", { name: "Результат" }));
  await screen.findByText('{"ok":true}');
  view.rerender(
    <RetainedViews activeKey="other">
      <p>Other section</p>
    </RetainedViews>,
  );
  view.rerender(
    <RetainedViews activeKey="history">
      <ProjectHistory project={project} />
    </RetainedViews>,
  );
  await screen.findByText('{"ok":true}');
  expect(screen.getByLabelText("Запись истории").textContent).toContain("beta");
  expect(api.listHistoryYears).toHaveBeenCalledTimes(2);
});
it("empty history and empty entries are explicit", async () => {
  api.listHistoryYears.mockResolvedValue([]);
  const view = render(<ProjectHistory project={project} />);
  await screen.findByText("История пока пуста");
  view.unmount();
  api.listHistoryArtifacts.mockResolvedValue([]);
  render(<HistoryArtifacts scope="p" year="2026" entry="alpha" />);
  await screen.findByText("Артефактов пока нет");
});
it("returning to History shows the same blocking loader while its catalog refreshes", async () => {
  const view = render(
    <RetainedViews activeKey="history">
      <ProjectHistory project={project} />
    </RetainedViews>,
  );
  await openEntry("alpha");
  view.rerender(
    <RetainedViews activeKey="other">
      <p>Other</p>
    </RetainedViews>,
  );
  let finish!: (v: string[]) => void;
  api.listHistoryYears.mockImplementationOnce(
    () => new Promise((resolve) => (finish = resolve)),
  );
  view.rerender(
    <RetainedViews activeKey="history">
      <ProjectHistory project={project} />
    </RetainedViews>,
  );
  expect(
    screen.getByRole("status", { name: "Загружаем историю…" }),
  ).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "alpha" })).toBeNull();
  await act(async () => finish(["2026"]));
  await screen.findByRole("heading", { name: "alpha" });
});
it("a stuck initial read times out and releases the loader", async () => {
  vi.useFakeTimers();
  try {
    api.listHistoryYears.mockImplementation(() => new Promise(() => {}));
    render(<ProjectHistory project={project} />);
    expect(screen.getByRole("status")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30001);
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Превышено время ожидания",
    );
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
it("rapid A → pending B → A cannot reuse a settled request with the same arguments", async () => {
  render(<HistoryArtifacts scope="p" year="2026" entry="alpha" />);
  await openEntry("alpha");
  let finishA!: (value: any) => void;
  api.readHistoryArtifact
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockImplementationOnce(
      () => new Promise((resolve) => (finishA = resolve)),
    );
  fireEvent.click(screen.getByRole("button", { name: "Результат" }));
  expect(screen.getByRole("status", { name: "Загружаем файл…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Файл plan.md" }));
  expect(screen.getByRole("status", { name: "Загружаем файл…" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "alpha" })).toBeNull();
  await act(async () =>
    finishA({
      relativePath: ".goga/history/2026/alpha/plan.md",
      text: "# Fresh A",
      format: "markdown",
    }),
  );
  await screen.findByRole("heading", { name: "Fresh A" });
});

it("starts without an entry or file, and selecting an entry only lists files", async () => {
  render(<ProjectHistory project={project} />);
  const entries = await screen.findByLabelText("Запись истории");
  await waitFor(() =>
    expect((entries as HTMLSelectElement).disabled).toBe(false),
  );
  expect(entries.textContent).toContain("Выберите запись");
  expect(api.listHistoryArtifacts).not.toHaveBeenCalled();
  expect(api.readHistoryArtifact).not.toHaveBeenCalled();
  fireEvent.click(entries);
  fireEvent.click(screen.getByRole("option", { name: "alpha" }));
  const file = await screen.findByRole("button", { name: "Файл plan.md" });
  expect(file.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByText("Выберите файл")).toBeTruthy();
  expect(api.readHistoryArtifact).not.toHaveBeenCalled();
  fireEvent.click(file);
  await screen.findByRole("heading", { name: "alpha" });
});
it("a removed selected file never silently opens another file", async () => {
  const view = render(<HistoryArtifacts scope="p" year="2026" entry="alpha" />);
  await openEntry("alpha");
  const calls = api.readHistoryArtifact.mock.calls.length;
  api.listHistoryArtifacts.mockResolvedValue(
    tree.filter((item) => item.path !== "plan.md"),
  );
  view.rerender(
    <HistoryArtifacts scope="p" year="2026" entry="alpha" refreshKey={1} />,
  );
  await screen.findByText(
    "Выбранный файл больше недоступен. Выберите другой файл.",
  );
  expect(api.readHistoryArtifact).toHaveBeenCalledTimes(calls);
  fireEvent.click(screen.getByRole("button", { name: "Папка reports" }));
  expect(
    screen
      .getByRole("button", { name: "Файл reports/result.json" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});
it("remembers explicit file selection per entry and leaves an unseen entry empty", async () => {
  render(<ProjectHistory project={project} />);
  await screen.findByLabelText("Запись истории");
  await openEntry("alpha");
  fireEvent.click(screen.getByRole("button", { name: "Результат" }));
  await screen.findByText('{"ok":true}');
  fireEvent.click(screen.getByLabelText("Запись истории"));
  fireEvent.click(screen.getByRole("option", { name: "beta" }));
  await screen.findByText("Выберите файл");
  expect(api.readHistoryArtifact).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByLabelText("Запись истории"));
  fireEvent.click(screen.getByRole("option", { name: "alpha" }));
  await screen.findByText('{"ok":true}');
  expect(
    screen
      .getByRole("button", { name: "Файл reports/result.json" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
it("remembers an explicit file separately for each context", async () => {
  const view = render(<HistoryArtifacts scope="p" year="2026" entry="alpha" />);
  await openEntry("alpha");
  view.rerender(<HistoryArtifacts scope="q" year="2026" entry="alpha" />);
  await screen.findByText("Выберите файл");
  expect(api.readHistoryArtifact).toHaveBeenCalledTimes(1);
  view.rerender(<HistoryArtifacts scope="p" year="2026" entry="alpha" />);
  await screen.findByRole("heading", { name: "alpha" });
  expect(api.readHistoryArtifact).toHaveBeenLastCalledWith(
    "p",
    "2026",
    "alpha",
    "plan.md",
    undefined,
  );
});

it("keeps tree and file positions independently, restores files and returns to top without moving the tree", async () => {
  const view = render(
    <RetainedViews activeKey="history">
      <ProjectHistory project={project} />
    </RetainedViews>,
  );
  await openEntry("alpha");
  const treePane = screen.getByRole("region", {
    name: "Прокрутка списка файлов",
  });
  const documentPane = screen.getByRole("region", {
    name: "Содержимое артефакта",
  });
  fireEvent.wheel(treePane);
  fireEvent.scroll(treePane, { target: { scrollTop: 128 } });
  fireEvent.wheel(documentPane);
  fireEvent.scroll(documentPane, { target: { scrollTop: 480 } });
  fireEvent.click(screen.getByRole("button", { name: "Результат" }));
  await screen.findByText('{"ok":true}');
  expect(
    screen.getByRole("region", { name: "Содержимое артефакта" }).scrollTop,
  ).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Файл plan.md" }));
  await screen.findByRole("heading", { name: "alpha" });
  expect(
    screen.getByRole("region", { name: "Содержимое артефакта" }).scrollTop,
  ).toBe(480);
  view.rerender(
    <RetainedViews activeKey="other">
      <p>Other</p>
    </RetainedViews>,
  );
  view.rerender(
    <RetainedViews activeKey="history">
      <ProjectHistory project={project} />
    </RetainedViews>,
  );
  await screen.findByRole("heading", { name: "alpha" });
  expect(
    screen.getByRole("region", { name: "Содержимое артефакта" }).scrollTop,
  ).toBe(480);
  expect(
    screen.getByRole("region", { name: "Прокрутка списка файлов" }).scrollTop,
  ).toBe(128);
  fireEvent.click(screen.getByRole("button", { name: "Наверх" }));
  expect(
    screen.getByRole("region", { name: "Содержимое артефакта" }).scrollTop,
  ).toBe(0);
  expect(
    screen.getByRole("region", { name: "Прокрутка списка файлов" }).scrollTop,
  ).toBe(128);
});

it("expands the loaded artifact without another host read or Markdown remount", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  render(
    <main className="main-area">
      <ProjectHistory project={project} />
    </main>,
  );
  await openEntry("alpha");
  const heading = screen.getByRole("heading", { name: "alpha" });
  const readCount = api.readHistoryArtifact.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Развернуть документ" }));
  expect(screen.getByRole("dialog", { name: "Просмотр plan.md" })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "alpha" })).toBe(heading);
  fireEvent.click(screen.getByRole("button", { name: "Свернуть документ" }));
  expect(screen.getByRole("heading", { name: "alpha" })).toBe(heading);
  expect(api.readHistoryArtifact.mock.calls.length).toBe(readCount);
});
