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
import { ProjectHistory } from "../src/renderer/ProjectHistory";
import { installHistoryWorker } from "./helpers/history-worker";
const project = { id: "p", name: "Project", path: "/fixture" };
const owner = {
  projectId: "p",
  year: "2026",
  topic: "alpha",
  branch: "alpha",
  contextId: "ctx-" + "a".repeat(64),
  revision: "0461b33f-4e7c-4bd2-b101-111111111111",
};
let api: any;
beforeEach(() => {
  installHistoryWorker();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listHistoryYears: vi.fn(async () => ["2026", "2025"]),
    listHistoryEntries: vi.fn(async () => [
      "alpha",
      "orphan",
      "Support-AFM-hooks",
    ]),
    listHistoryArtifacts: vi.fn(async () => [
      { path: "todo.md", kind: "file", readable: true },
    ]),
    readHistoryArtifact: vi.fn(async () => ({
      relativePath: ".goga/history/2026/orphan/todo.md",
      text: "# Document",
      format: "markdown",
    })),
    prepareHistoryPrune: vi.fn(async () => ({
      status: "ready",
      projectId: "p",
      year: "2026",
      entries: ["orphan"],
      token: "ticket",
      log: "dry-run",
    })),
    pruneHistory: vi.fn(async () => ({
      status: "ok",
      changed: true,
      log: "deleted",
    })),
  };
  window.goga = api;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function selector() {
  const b = await screen.findByRole("combobox", { name: "Запись истории" });
  await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(b);
  return b;
}
it("filters by case-insensitive substring locally, supports keyboard selection and preserves explicit choice", async () => {
  render(<ProjectHistory project={project} />);
  expect(api.listHistoryArtifacts).not.toHaveBeenCalled();
  await selector();
  const search = screen.getByRole("searchbox", {
    name: "Найти запись истории",
  });
  fireEvent.change(search, { target: { value: "aFm" } });
  expect(screen.queryByRole("option", { name: "alpha" })).toBeNull();
  expect(
    screen.getByRole("option", { name: "Support-AFM-hooks" }),
  ).toBeTruthy();
  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(
    screen.getByRole("combobox", { name: "Запись истории" }).textContent,
  ).toContain("Support-AFM-hooks");
  await screen.findByRole("button", { name: "Файл todo.md" });
  expect(api.readHistoryArtifact).not.toHaveBeenCalled();
  expect(api.listHistoryEntries).toHaveBeenCalledTimes(1);
  await selector();
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "nothing" },
  });
  expect(screen.getByText("Ничего не найдено")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(
    screen.getByRole("combobox", { name: "Запись истории" }).textContent,
  ).toContain("Support-AFM-hooks");
});
it("previews and cancels without deleting; explicit confirmation refreshes history and closes removed document", async () => {
  render(<ProjectHistory project={project} />);
  await selector();
  fireEvent.click(screen.getByRole("option", { name: "orphan" }));
  fireEvent.click(await screen.findByRole("button", { name: "Файл todo.md" }));
  await screen.findByRole("heading", { name: "Document" });
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  await screen.findByRole("button", { name: "Удалить записи" });
  expect(api.prepareHistoryPrune).toHaveBeenCalledWith("p", "2026");
  expect(api.pruneHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  await screen.findByRole("button", { name: "Удалить записи" });
  api.listHistoryEntries.mockResolvedValue(["alpha"]);
  fireEvent.click(screen.getByRole("button", { name: "Удалить записи" }));
  await screen.findByText("Очистка завершена");
  expect(api.pruneHistory).toHaveBeenCalledExactlyOnceWith("p", "ticket");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть карточку" }));
  await screen.findByRole("heading", { name: "Выберите запись истории" });
  expect(screen.queryByRole("heading", { name: "Document" })).toBeNull();
});
it("no topic context can display cleanup or reuse a late preview", async () => {
  const view = render(<ProjectHistory project={project} />);
  await selector();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  let finish!: (v: any) => void;
  api.prepareHistoryPrune.mockImplementation(
    () => new Promise((r) => (finish = r)),
  );
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  view.rerender(<ProjectHistory project={project} owner={owner} />);
  await act(async () =>
    finish({
      status: "ready",
      projectId: "p",
      year: "2026",
      entries: ["orphan"],
      token: "late",
      log: "",
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Очистить историю…" }),
  ).toBeNull();
  expect(api.pruneHistory).not.toHaveBeenCalled();
});
it.each(["empty", "failure", "partial"])(
  "settles %s without infinite loader or implicit retry",
  async (kind) => {
    if (kind === "empty")
      api.prepareHistoryPrune.mockResolvedValue({
        status: "ready",
        projectId: "p",
        year: "2026",
        entries: [],
        log: "",
      });
    if (kind === "failure")
      api.prepareHistoryPrune.mockRejectedValue(Error("CLI unavailable"));
    if (kind === "partial")
      api.pruneHistory.mockResolvedValue({
        status: "error",
        changed: true,
        error: "disk error",
        log: "partial log",
      });
    render(<ProjectHistory project={project} />);
    await selector();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
    if (kind === "partial") {
      fireEvent.click(
        await screen.findByRole("button", { name: "Удалить записи" }),
      );
      await screen.findByText("disk error");
      await waitFor(() =>
        expect(api.listHistoryEntries.mock.calls.length).toBeGreaterThan(1),
      );
    } else if (kind === "empty")
      await screen.findByText("Нет записей для очистки");
    else
      expect((await screen.findByRole("alert")).textContent).toBe(
        "CLI unavailable",
      );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить записи" })).toBeNull();
  },
);
it("uses the explicitly selected year and closes selector on outside click", async () => {
  render(<ProjectHistory project={project} />);
  await selector();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("searchbox")).toBeNull();
  fireEvent.change(screen.getByLabelText("Год"), { target: { value: "2025" } });
  api.prepareHistoryPrune.mockResolvedValue({
    status: "ready",
    projectId: "p",
    year: "2025",
    entries: [],
    log: "",
  });
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Очистить историю…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  await screen.findByText("Нет записей для очистки");
  expect(api.prepareHistoryPrune).toHaveBeenCalledWith("p", "2025");
});
it("finishes a timed-out preview without leaving a spinner or delete button", async () => {
  render(<ProjectHistory project={project} />);
  await selector();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  vi.useFakeTimers();
  api.prepareHistoryPrune.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300001);
  });
  expect(screen.getByRole("alert").textContent).toContain(
    "Превышено время ожидания",
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(api.pruneHistory).not.toHaveBeenCalled();
});
it("changing project cannot start a second preview or reuse an old one", async () => {
  const view = render(<ProjectHistory project={project} />);
  await selector();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  let finish!: (v: any) => void;
  api.prepareHistoryPrune.mockImplementation(
    () => new Promise((r) => (finish = r)),
  );
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  view.rerender(<ProjectHistory project={{ ...project, id: "other" }} />);
  await act(async () => {});
  expect(api.prepareHistoryPrune).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("ArrowUp from an empty cursor selects the last matching entry", async () => {
  render(<ProjectHistory project={project} />);
  await selector();
  const search = screen.getByRole("searchbox");
  fireEvent.keyDown(search, { key: "ArrowUp" });
  fireEvent.keyDown(search, { key: "Enter" });
  expect(
    screen.getByRole("combobox", { name: "Запись истории" }).textContent,
  ).toContain("Support-AFM-hooks");
});
it("limits the open menu to the visible scroll area rather than clipping its bottom", async () => {
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.classList.contains("scroll-area"))
        return {
          top: 100,
          bottom: 600,
          left: 0,
          right: 1024,
          width: 1024,
          height: 500,
          x: 0,
          y: 100,
          toJSON() {},
        };
      if (this.classList.contains("history-entry-picker"))
        return {
          top: 280,
          bottom: 350,
          left: 400,
          right: 780,
          width: 380,
          height: 70,
          x: 400,
          y: 280,
          toJSON() {},
        };
      return original.call(this);
    },
  );
  try {
    render(
      <div className="scroll-area" style={{ overflowY: "auto" }}>
        <ProjectHistory project={project} />
      </div>,
    );
    await selector();
    const menu = screen.getByRole("searchbox").parentElement!;
    expect(parseFloat(menu.style.maxHeight)).toBeLessThanOrEqual(242);
    expect(parseFloat(menu.style.maxHeight)).toBeGreaterThan(100);
  } finally {
    vi.restoreAllMocks();
  }
});
it("ignores an abandoned preview effect when React replays effects", async () => {
  render(
    <React.StrictMode>
      <ProjectHistory project={project} />
    </React.StrictMode>,
  );
  await selector();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Очистить историю…" }));
  await screen.findByRole("button", { name: "Удалить записи" });
  expect(screen.queryByRole("alert")).toBeNull();
});
