import "./helpers/overview-browser-fixture";
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  api = {
    listOverviewDirectory: vi.fn(async (_scope, path) => ({
      path,
      entries: [],
      truncated: false,
    })),
    readOverviewSchema: vi.fn(async () => []),
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps existing Project editors after Overview and before Topics, without duplicate project heading", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
  expect(await screen.findByRole("heading", { name: "Проект" })).toBeTruthy();
  const tabs = screen.getByRole("tablist", { name: "Разделы проекта" });
  expect(
    within(tabs)
      .getAllByRole("button")
      .map((x) => x.textContent),
  ).toEqual(["Обзор", "Проект", "Топики"]);
  for (const button of within(tabs).getAllByRole("button")) {
    expect(button.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
  }
  expect(await screen.findByLabelText("Исполняемый файл")).toBeTruthy();
  expect(screen.queryByText("ПРОЕКТ / Alpha")).toBeNull();
  expect(screen.getByRole("button", { name: "Запуски" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Запустить" })).toBeTruthy();
});
it("guards dirty Home edits before opening another project section", async () => {
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Проект" }));
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

it("enters the first project through Overview without eagerly loading Project settings", async () => {
  render(<App />);
  await screen.findByRole("button", { name: "Обзор" });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Обзор" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(
    await screen.findByRole("region", { name: "Обзор проекта" }),
  ).toBeTruthy();
  expect(api.readOverviewSchema).toHaveBeenCalledWith("p");
  expect(api.readProjectSettings).not.toHaveBeenCalled();
});
it("enters unseen and added projects through Overview, but retains the last section of visited projects", async () => {
  const q = { id: "q", name: "Beta", path: "/fixture/beta" };
  api.listProjects.mockResolvedValue([
    { id: "p", name: "Alpha", path: "/fixture" },
    q,
  ]);
  api.chooseProject = vi.fn(async () => ({
    id: "r",
    name: "Gamma",
    path: "/fixture/gamma",
  }));
  render(<App />);
  await screen.findByRole("button", { name: "Alpha" });
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  await screen.findByLabelText("Исполняемый файл");
  fireEvent.click(screen.getByRole("button", { name: "Beta" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Обзор" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  expect(
    screen.getByRole("button", { name: "Проект" }).getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Добавить проект" }));
  await screen.findByRole("button", { name: "Gamma" });
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Обзор" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  api.chooseProject.mockResolvedValueOnce({
    id: "p",
    name: "Alpha",
    path: "/fixture",
  });
  fireEvent.click(screen.getByRole("button", { name: "Добавить проект" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Проект" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
});
