// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
let api: any;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = {
    listProjects: vi.fn(async () => [
      { id: "p", name: "Alpha", path: "/fixture" },
    ]),
    runs: vi.fn(async () => []),
    selectRun: vi.fn(async () => {}),
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    readProjectSettings: vi.fn(async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v",
      profiles: [],
    })),
    listSettings: vi.fn(async () => ({ profiles: [] })),
  };
  window.goga = api;
});
afterEach(cleanup);
it("opens the existing project editors as first Home tab before Topics, without duplicate project heading", async () => {
  render(<App />);
  expect(await screen.findByRole("heading", { name: "Проект" })).toBeTruthy();
  const tabs = screen.getByRole("tablist", { name: "Разделы проекта" });
  expect(
    within(tabs)
      .getAllByRole("button")
      .map((x) => x.textContent),
  ).toEqual(["Проект", "Топики"]);
  expect(await screen.findByLabelText("Исполняемый файл")).toBeTruthy();
  expect(screen.queryByText("ПРОЕКТ / Alpha")).toBeNull();
  expect(screen.getByRole("button", { name: "Запуски" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Запустить" })).toBeTruthy();
});
it("guards dirty Home edits before opening another project section", async () => {
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Исполняемый файл"), {
    target: { value: "/changed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Топики" }));
  expect(
    await screen.findByRole("heading", { name: "Сохранить изменения?" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
  expect(
    (screen.getByLabelText("Исполняемый файл") as HTMLInputElement).value,
  ).toBe("/changed");
});
it("build run shows live output without Dashboard budget and can repeat independently of forms", async () => {
  const run = {
    id: "b",
    kind: "build",
    projectId: "p",
    pipeline: "Сборка",
    topic: "topic",
    branch: "main",
    status: "exited",
    startedAt: "now",
    workflow: null,
    profile: null,
    build: {
      planPath: "plan.md",
      planVersion: "v",
      clean: false,
      update: false,
      skipManifestCheck: false,
    },
    output: { text: "Built successfully", truncated: false },
  };
  api.runs.mockResolvedValue([run]);
  api.repeatBuild = vi.fn(async () => ({
    ...run,
    id: "b2",
    status: "running",
  }));
  render(<App />);
  fireEvent.click(await screen.findByRole("tab", { name: /Сборка/ }));
  expect(await screen.findByText("Built successfully")).toBeTruthy();
  expect(screen.queryByText(/Dashboard/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Повторить сборку" }));
  await waitFor(() => expect(api.repeatBuild).toHaveBeenCalledWith("b", false));
  expect(
    await screen.findByRole("heading", { name: "Сборка выполняется" }),
  ).toBeTruthy();
  expect(api.selectRun).not.toHaveBeenCalledWith("b2");
});
