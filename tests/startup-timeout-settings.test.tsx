// @vitest-environment jsdom
import React, { createRef } from "react";
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
  ProjectSettings,
  type ProjectSettingsGuard,
} from "../src/renderer/ProjectSettings";
import type { ProjectSettingsView } from "../src/shared/types";

vi.mock("../src/renderer/ProjectDocuments", () => ({
  ProjectDocuments: () => null,
}));
const project = { id: "p", name: "Example", path: "/example" };
const initial: ProjectSettingsView = {
  value: { executable: "goga", profile: "", env: [] },
  profiles: [],
  version: "v1",
};
let api: any;
beforeEach(() => {
  api = {
    readProjectSettings: vi.fn(async () => structuredClone(initial)),
    saveProjectSettings: vi.fn(
      async (_id: string, value: ProjectSettingsView["value"]) => ({
        ...initial,
        value,
        version: "v2",
      }),
    ),
  };
  window.goga = api;
});
afterEach(cleanup);
async function open() {
  const guard = createRef<ProjectSettingsGuard | null>();
  const onSaved = vi.fn();
  const onBusy = vi.fn();
  render(
    <ProjectSettings
      project={project}
      onBack={vi.fn()}
      onSaved={onSaved}
      guard={guard}
      onBusy={onBusy}
    />,
  );
  const input = (await screen.findByLabelText(
    "Тайм-аут запуска конвейера",
  )) as HTMLInputElement;
  return { input, guard, onSaved, onBusy };
}
it("shows the implicit 10 minute default without marking legacy settings dirty or saving them", async () => {
  const { input, guard } = await open();
  expect(input.value).toBe("10");
  expect(guard.current?.dirty).toBe(false);
  expect(screen.getByText(/От 1 до 120 минут/)).toBeTruthy();
  expect(screen.getByText(/Docker/)).toBeTruthy();
  await act(async () => expect(await guard.current!.save()).toBe(true));
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
});
it.each(["", " ", "0", "121", "-1", "1.5", "NaN", "Infinity", "1e999"])(
  "retains invalid draft %j and blocks guarded save until corrected or discarded",
  async (draft) => {
    const { input, guard } = await open();
    fireEvent.change(input, { target: { value: draft } });
    expect(input.value).toBe(draft);
    expect(guard.current?.dirty).toBe(true);
    await act(async () => expect(await guard.current!.save()).toBe(false));
    expect(api.saveProjectSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(
      /целое число.*1.*120/,
    );
    expect(input.value).toBe(draft);
    act(() => guard.current!.discard());
    expect(input.value).toBe("10");
    expect(guard.current?.dirty).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  },
);
it.each([1, 120])(
  "saves valid %s minutes as a number and marks saved draft clean",
  async (minutes) => {
    const { input, guard, onSaved } = await open();
    fireEvent.change(input, { target: { value: String(minutes) } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("v2"));
    expect(api.saveProjectSettings).toHaveBeenCalledWith(
      "p",
      { ...initial.value, startupTimeoutMinutes: minutes },
      "v1",
    );
    expect(guard.current?.dirty).toBe(false);
    expect(input.value).toBe(String(minutes));
  },
);
it("does not add the default property when saving an unrelated legacy setting", async () => {
  await open();
  fireEvent.change(screen.getByLabelText("Исполняемый файл"), {
    target: { value: "goga-new" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() => expect(api.saveProjectSettings).toHaveBeenCalledTimes(1));
  expect(api.saveProjectSettings.mock.calls[0][1]).toEqual({
    ...initial.value,
    executable: "goga-new",
  });
});
it("uses an explicit saved timeout and restores it when discarding a draft", async () => {
  api.readProjectSettings.mockResolvedValue({
    ...initial,
    value: { ...initial.value, startupTimeoutMinutes: 27 },
  });
  const { input, guard } = await open();
  expect(input.value).toBe("27");
  fireEvent.change(input, { target: { value: "30" } });
  act(() => guard.current!.discard());
  expect(input.value).toBe("27");
  expect(guard.current?.dirty).toBe(false);
});
it("blocks duplicate saves and changes/discard while timeout save is pending", async () => {
  let finish!: (value: ProjectSettingsView) => void;
  api.saveProjectSettings.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { input, guard, onBusy } = await open();
  fireEvent.change(input, { target: { value: "20" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(guard.current?.busy).toBe(true);
  expect(onBusy).toHaveBeenCalledWith(true);
  await act(async () => expect(await guard.current!.save()).toBe(false));
  fireEvent.change(input, { target: { value: "30" } });
  act(() => guard.current!.discard());
  expect(input.value).toBe("20");
  expect(api.saveProjectSettings).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      ...initial,
      value: { ...initial.value, startupTimeoutMinutes: 20 },
      version: "v2",
    }),
  );
  expect(guard.current?.busy).toBe(false);
  expect(guard.current?.dirty).toBe(false);
  expect(onBusy).toHaveBeenLastCalledWith(false);
});
it("reveals timeout validation when guarded save starts in another section", async () => {
  const { input, guard } = await open();
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Конфигурация" }));
  await act(async () => expect(await guard.current!.save()).toBe(false));
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Тайм-аут запуска конвейера" }),
  ).toBeTruthy();
  expect(api.saveProjectSettings).not.toHaveBeenCalled();
});
