// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectSettingsConfirmation } from "../src/renderer/ProjectSettings";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);

it("gives the three-action settings confirmation its own wide layout while preserving order, focus and busy guards", () => {
  const onSave = vi.fn(),
    onCancel = vi.fn(),
    onDiscard = vi.fn();
  const view = render(
    <ProjectSettingsConfirmation
      busy={false}
      onSave={onSave}
      onCancel={onCancel}
      onDiscard={onDiscard}
    />,
  );
  expect(
    screen
      .getByRole("dialog")
      .classList.contains("project-settings-confirmation"),
  ).toBe(true);
  expect(
    screen.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["Отмена", "Не сохранять и перейти", "Сохранить и перейти"]);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Отмена" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Сохранить и перейти" }));
  expect(onSave).toHaveBeenCalledOnce();
  view.rerender(
    <ProjectSettingsConfirmation
      busy
      onSave={onSave}
      onCancel={onCancel}
      onDiscard={onDiscard}
    />,
  );
  expect(
    screen
      .getAllByRole("button")
      .every((button) => (button as HTMLButtonElement).disabled),
  ).toBe(true);
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { cancelable: true }),
  );
  expect(onCancel).not.toHaveBeenCalled();
  expect(onDiscard).not.toHaveBeenCalled();
});

it("adapts dialog actions to actual popup width instead of changing normal editor/form footers", () => {
  const css = readFileSync("src/renderer/style.css", "utf8");
  expect(css).toMatch(/container-name:\s*goga-dialog/);
  expect(css).toMatch(/@container goga-dialog \(max-width:\s*520px\)/);
  expect(css).toMatch(/@container goga-dialog \(max-width:\s*320px\)/);
  expect(css).toMatch(
    /\.task-reload-dialog\.project-settings-confirmation\s*\{[^}]*width:\s*min\(600px/,
  );
  expect(css).toMatch(
    /\.form-actions\s*\{\s*display:\s*flex;\s*justify-content:\s*space-between;/,
  );
});
