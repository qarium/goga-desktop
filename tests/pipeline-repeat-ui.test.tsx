import "./helpers/overview-browser-fixture";
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
import { App } from "../src/renderer/App";
const snapshot = {
  version: 1,
  workflow: "auto",
  profile: "",
  skips: ["review"],
  clean: false,
  update: true,
};
const source = {
  id: "source",
  projectId: "p",
  pipeline: "editor",
  topic: "",
  branch: "main",
  status: "failed",
  startedAt: "2026-11-08T00:00:00.000Z",
  workflow: null,
  profile: null,
  pipelineRepeat: snapshot,
  output: { text: "Synthetic original output", truncated: false },
};
let api: any, focusRun: (id: string) => void;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Alpha", path: "/synthetic/project" },
    ]),
    runs: vi.fn(async () => [source]),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: (cb: typeof focusRun) => {
      focusRun = cb;
      return () => {};
    },
    onViewError: () => () => {},
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
    repeatPipeline: vi.fn(async () => ({
      ...source,
      id: "new-run",
      status: "starting",
      output: { text: "Synthetic repeat output", truncated: false },
    })),
    launch: vi.fn(),
    closeRun: vi.fn(async () => true),
  };
  window.goga = api;
});
afterEach(cleanup);
async function open() {
  render(<App />);
  await screen.findByRole("button", { name: "Проект" });
  await act(async () => focusRun("source"));
  await screen.findByText("Synthetic original output");
}
it("immediately repeats by source ID without opening a form, preserving the old run", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Повторить запуск" }));
  await screen.findByText("Synthetic repeat output");
  expect(api.repeatPipeline).toHaveBeenCalledExactlyOnceWith("source");
  expect(api.launch).not.toHaveBeenCalled();
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  expect(
    screen.queryByRole("heading", { name: "Запустить конвейер" }),
  ).toBeNull();
});
it("shows the standard loader immediately and suppresses double clicks", async () => {
  let resolve!: (run: any) => void;
  api.repeatPipeline.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await open();
  const button = screen.getByRole("button", { name: "Повторить запуск" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(
    screen.getByRole("status", { name: "Подготавливаем повторный запуск…" }),
  ).toBeTruthy();
  expect(api.repeatPipeline).toHaveBeenCalledTimes(1);
  await act(async () =>
    resolve({ ...source, id: "new-run", status: "starting" }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("status", {
        name: "Подготавливаем повторный запуск…",
      }),
    ).toBeNull(),
  );
});
it("does not hijack another section when a late repeat result arrives", async () => {
  let resolve!: (run: any) => void;
  api.repeatPipeline.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Повторить запуск" }));
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await screen.findByLabelText("Исполняемый файл");
  await act(async () =>
    resolve({ ...source, id: "new-run", status: "starting" }),
  );
  expect(screen.getByLabelText("Исполняемый файл")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Проект" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen
      .getAllByRole("tab")
      .some((tab) => tab.textContent?.includes("editor")),
  ).toBe(true);
});
it("shows a readable failure, retains the source and permits an explicit retry", async () => {
  api.repeatPipeline.mockRejectedValueOnce(
    Error(
      "Error invoking remote method 'goga:repeat-pipeline': Error: synthetic admission failed",
    ),
  );
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Повторить запуск" }));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toBe("synthetic admission failed");
  fireEvent.click(screen.getByRole("button", { name: "Закрыть сообщение" }));
  expect(screen.getByText("Synthetic original output")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Повторить запуск" }));
  await screen.findByText("Synthetic repeat output");
  expect(api.repeatPipeline).toHaveBeenCalledTimes(2);
});
it.each([
  { pipelineRepeat: undefined },
  { status: "starting" },
  { status: "running" },
  { recovery: "unverified" },
  { kind: "build" },
])(
  "does not offer a blind repeat for incomplete or active records %j",
  async (change) => {
    api.runs.mockResolvedValue([{ ...source, ...change }]);
    await open();
    expect(
      screen.queryByRole("button", { name: "Повторить запуск" }),
    ).toBeNull();
    expect(api.repeatPipeline).not.toHaveBeenCalled();
  },
);
