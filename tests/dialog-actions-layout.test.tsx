// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReloadConfirmation } from "../src/renderer/TaskReloadConfirmation";
import { PopupClose } from "../src/renderer/PopupClose";
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

it("uses one surface contract in the Desktop shell, native-layer popup documents and the isolated terminal screen", () => {
  const theme = readFileSync("src/shared/overlay-theme.css", "utf8");
  for (const entry of ["src/renderer/style.css", "src/terminal/terminal.css"])
    expect(readFileSync(entry, "utf8")).toContain('@import "../shared/overlay-theme.css"');
  for (const cls of ["topic-dialog", "task-reload-dialog", "attach-panel-dialog", "repository-operation-dialog", "terminal-confirmation", "context-launch-menu", "topic-context-popup", "topic-select-popup", "git-branch-menu", "searchable-menu", "workflow-name-popup", "project-list-menu", "terminal-actions-menu", "terminal-add-menu", "home-session-menu", "launch-menu", "repository-action-tooltip", "topic-popup-error", "ov-modal", "ov-file-menu"])
    expect(theme).toContain("." + cls);
  expect(theme).toContain("--feedback-error-fg:");
  expect(theme).toContain("--feedback-warning-fg:");
  // Fullscreen readers and their deliberate transparent backdrops are not confirmation dialogs.
  expect(theme).not.toMatch(/(?:^|,)\s*(?:dialog|\[role="dialog"\])\s*[:{]/m);
});

it("keeps dismiss buttons labelled and non-submitting; destructive reload never becomes the default focus", () => {
  const cancel = vi.fn(), submit = vi.fn();
  const view = render(<ReloadConfirmation title="Discard changes?" description="Unsaved edits will be lost." confirmLabel="Discard" destructive onCancel={cancel} onConfirm={submit}/>);
  const close = document.querySelector<HTMLButtonElement>("button.popup-close")!;
  expect(close.type).toBe("button");
  expect(close.getAttribute("aria-label")).toBeTruthy();
  expect(close.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("button", {name: "Отмена"}));
  expect(screen.getByRole("button",{name:"Discard"}).classList.contains("danger")).toBe(true);
  fireEvent.click(close);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  view.unmount();
  render(<PopupClose disabled label="Close dialog" onClick={cancel}/>);
  fireEvent.click(screen.getByRole("button", {name:"Close dialog"}));
  expect(cancel).toHaveBeenCalledTimes(1);
});
