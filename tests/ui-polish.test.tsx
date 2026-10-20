// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  within,
  fireEvent,
} from "@testing-library/react";
import { App } from "../src/renderer/App";
import { version } from "../package.json";
afterEach(cleanup);
beforeEach(() => {
  window.goga = {
    listProjects: async () => [
      { id: "fixture", name: "Synthetic project", path: "/fixture/project" },
    ],
    runs: async () => [],
    onRuns: () => () => {},
    onFocusRun: () => () => {},
    onViewError: () => () => {},
    selectRun: vi.fn(async () => {}),
    readProjectSettings: async () => ({
      value: { executable: "goga", profile: "", env: [] },
      version: "v1",
      profiles: [],
    }),
  } as any;
});
it("shows real package version only beside the footer copyright, not in titlebar", async () => {
  const { container } = render(<App />);
  await screen.findByRole("heading", { name: "Synthetic project" });
  const footer = container.querySelector(".sidebar-footer")!;
  expect(within(footer as HTMLElement).getByText(`v${version}`)).toBeTruthy();
  expect(footer.textContent).toContain("© Goga 2026");
  expect(container.querySelector(".titlebar")?.textContent).not.toContain(
    version,
  );
  expect(screen.getAllByText(`v${version}`)).toHaveLength(1);
});
it("keeps a compact project header with Runs and Launch actions and settings in Home", async () => {
  const { container } = render(<App />);
  await screen.findByRole("heading", { name: "Synthetic project" });
  const header = container.querySelector(".project-bar") as HTMLElement;
  expect(within(header).getByRole("button", { name: "Запуски" })).toBeTruthy();
  expect(
    within(header).getByRole("button", { name: "Запустить" }),
  ).toBeTruthy();
  expect(
    within(header).queryByRole("button", { name: "Настройки" }),
  ).toBeNull();
  expect(await screen.findByRole("heading", { name: "Проект" })).toBeTruthy();
  const home = screen.getByRole("button", { name: "Проект" });
  home.focus();
  expect(document.activeElement).toBe(home);
  expect(
    within(container.querySelector(".sidebar") as HTMLElement).getByRole(
      "button",
      { name: "⚙ Настройки" },
    ),
  ).toBeTruthy();
});
