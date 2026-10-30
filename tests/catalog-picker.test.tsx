// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchablePicker } from "../src/renderer/SearchablePicker";
afterEach(cleanup);
const props = {
  label: "Профиль",
  placeholder: "Выберите профиль",
  emptyLabel: "Нет профилей",
  searchLabel: "Найти профиль",
  searchPlaceholder: "Поиск",
  listLabel: "Профили",
  disabled: false,
  value: "",
  onChange: vi.fn(),
};
it("closes a repeated selection without changing the ready form composition", () => {
  const onChange = vi.fn();
  render(
    <SearchablePicker
      {...props}
      value="ready"
      entries={[{ value: "ready", label: "Готовый состав" }]}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("option", { name: "Готовый состав" }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("shows labels, searches by labels and submits exact values including an empty default", () => {
  const onChange = vi.fn();
  const entries = [
    { value: "", label: "По умолчанию проекта" },
    { value: "local", label: "Личный профиль" },
  ];
  const v = render(
    <SearchablePicker {...props} entries={entries} onChange={onChange} />,
  );
  expect(screen.getByRole("combobox").textContent).toContain(
    "По умолчанию проекта",
  );
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "Личный" },
  });
  fireEvent.click(screen.getByRole("option", { name: "Личный профиль" }));
  expect(onChange).toHaveBeenLastCalledWith("local");
  v.rerender(
    <SearchablePicker
      {...props}
      entries={entries}
      value="local"
      onChange={onChange}
    />,
  );
  expect(screen.getByRole("combobox").textContent).toContain("Личный профиль");
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "По умолчанию проекта" }));
  expect(onChange).toHaveBeenLastCalledWith("");
});
it("keeps unavailable options visible but refuses mouse and keyboard selection", () => {
  const onChange = vi.fn();
  render(
    <SearchablePicker
      {...props}
      onChange={onChange}
      entries={[
        { value: "unsafe", label: "Недоступен", disabled: true },
        { value: "safe", label: "Доступен" },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("combobox"));
  const option = screen.getByRole("option", {
    name: "Недоступен",
  }) as HTMLButtonElement;
  expect(option.disabled).toBe(true);
  fireEvent.click(option);
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
  expect(onChange).toHaveBeenCalledExactlyOnceWith("safe");
});
it("does not select when all matches are disabled or fieldset becomes disabled", () => {
  const onChange = vi.fn();
  const v = render(
    <fieldset>
      <SearchablePicker
        {...props}
        entries={[{ value: "x", label: "X", disabled: true }]}
        onChange={onChange}
      />
    </fieldset>,
  );
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
  v.rerender(
    <fieldset disabled>
      <SearchablePicker
        {...props}
        entries={[{ value: "x", label: "X" }]}
        onChange={onChange}
      />
    </fieldset>,
  );
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
  expect(onChange).not.toHaveBeenCalled();
});
it("retains string callers, unknown selected values, keyboard filtering and Escape", () => {
  const onChange = vi.fn();
  render(
    <SearchablePicker
      {...props}
      value="removed"
      entries={["2026", "2025"]}
      onChange={onChange}
    />,
  );
  const trigger = screen.getByRole("combobox");
  expect(trigger.textContent).toContain("removed");
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "25" } });
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
  expect(onChange).toHaveBeenCalledExactlyOnceWith("2025");
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
