import "./helpers/overview-browser-fixture";
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
  fireEvent.click(screen.getByRole("button", { name: "Проект" }));
  expect(await screen.findByRole("heading", { name: "Проект" })).toBeTruthy();
  const home = screen.getByRole("button", { name: "Проект" });
  home.focus();
  expect(document.activeElement).toBe(home);
  expect(
    within(container.querySelector(".sidebar") as HTMLElement).getByRole(
      "button",
      { name: "Настройки" },
    ),
  ).toBeTruthy();
});

it.each(["button", "escape"])(
  "shows global failure outside the header and dismisses it by %s without blocking navigation",
  async (method) => {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
    const failure =
      "Хранилище занято. " + "Полная диагностика без обрезания. ".repeat(80);
    window.goga.runs = vi.fn(async () => {
      throw Error(failure);
    });
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: "Synthetic project" });
    const dialog = await screen.findByRole("dialog", {
      name: "Не удалось выполнить операцию",
    });
    expect(within(dialog).getByRole("alert").textContent).toBe(failure);
    expect(container.querySelector(".project-bar")?.contains(dialog)).toBe(
      false,
    );
    expect(container.querySelector(".project-bar .close-error")).toBeNull();
    const close = within(dialog).getByRole("button", {
      name: "Закрыть сообщение",
    });
    expect((close as HTMLButtonElement).disabled).toBe(false);
    if (method === "button") fireEvent.click(close);
    else
      fireEvent(
        dialog,
        new Event("cancel", { bubbles: true, cancelable: true }),
      );
    expect(
      screen.queryByRole("dialog", { name: "Не удалось выполнить операцию" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Топики" }));
    expect(
      screen
        .getByRole("button", { name: "Топики" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  },
);
