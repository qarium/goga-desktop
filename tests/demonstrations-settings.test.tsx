// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  render,
  fireEvent,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { Settings } from "../src/renderer/Settings";
afterEach(cleanup);
it("saves a port without opening a show or opening personal settings; addresses use only the saved port", async () => {
  let port = 45123;
  const execute = vi.fn(async (cmd) => {
    port = cmd.port;
  });
  const read = vi.fn(async () => ({
    port,
    shows: [],
    access: { owner: null, phase: "off", connectionId: null },
  }));
  const listSettings = vi.fn();
  window.goga = { demoState: read, demoExecute: execute, listSettings } as any;
  render(<Settings selectedTab="demonstrations" />);
  const field = await screen.findByRole("textbox", { name: "Порт агента" });
  fireEvent.change(field, { target: { value: "22" } });
  expect(
    (screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(field, { target: { value: "35120" } });
  expect(screen.getByText("http://host.docker.internal:45123")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(screen.getByText("http://host.docker.internal:35120")).toBeTruthy(),
  );
  expect(execute.mock.calls).toEqual([[{ action: "port", port: 35120 }]]);
  expect(listSettings).not.toHaveBeenCalled();
});
it("does not allow moving the port through settings when it already belongs to a show", async () => {
  window.goga = {
    demoState: async () => ({
      port: 45123,
      shows: [{ showId: "s", label: "A" }],
      access: { owner: "s", phase: "waiting", connectionId: null },
    }),
  } as any;
  render(<Settings selectedTab="demonstrations" />);
  const f = await screen.findByRole("textbox", { name: "Порт агента" });
  expect((f as HTMLInputElement).disabled).toBe(true);
});
it("can repair unreadable settings by explicitly saving even the proposed default port", async () => {
  let repaired = false;
  const execute = vi.fn(async () => {
    repaired = true;
  });
  window.goga = {
    demoState: async () => ({
      port: 45123,
      shows: [],
      access: { owner: null, phase: "off", connectionId: null },
      ...(!repaired && {
        settingsError: "Не удалось прочитать настройку порта.",
      }),
    }),
    demoExecute: execute,
  } as any;
  render(<Settings selectedTab="demonstrations" />);
  await screen.findByText("Не удалось прочитать настройку порта.");
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({ action: "port", port: 45123 }),
  );
});

it("changes the default engine with a live show without moving its port or running another show", async () => {
  let engine = "embedded";
  const execute = vi.fn(async (cmd) => {
    engine = cmd.engine;
  });
  window.goga = {
    demoState: async () => ({
      port: 45123,
      engine,
      shows: [
        {
          showId: "show",
          label: "A",
          engine: "embedded",
          scope: "one",
          url: null,
        },
      ],
      access: { owner: "show", phase: "waiting", connectionId: null },
    }),
    demoExecute: execute,
  } as any;
  render(<Settings selectedTab="demonstrations" />);
  const select = await screen.findByRole("combobox", {
    name: "Браузер демонстрации",
  });
  expect(select.textContent).toContain("Встроенный Chromium");
  fireEvent.click(select);
  fireEvent.click(screen.getByRole("option", { name: "Системный браузер" }));
  await screen.findByText("Браузер для новых показов сохранён.");
  expect(select.textContent).toContain("Системный браузер");
  expect(execute.mock.calls).toEqual([
    [{ action: "engine", engine: "system" }],
  ]);
  expect(
    (screen.getByRole("textbox", { name: "Порт агента" }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
});
