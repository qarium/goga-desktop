import { fireEvent, within } from "@testing-library/react";
import { flushSync } from "react-dom";

/** Open a shared catalog without toggling an already open menu. */
export function openCatalog(control: HTMLElement) {
  if (
    control.tagName !== "SELECT" &&
    control.getAttribute("aria-expanded") !== "true"
  ) {
    // Controlled native change events flush React's restore queue even inside
    // an outer act. Preserve those discrete gesture boundaries for button menus.
    flushSync(() => fireEvent.click(control));
  }
}

/** Pick an exact catalog value through the rendered native or shared control. */
export function selectCatalog(control: HTMLElement, value: string) {
  if (control.tagName === "SELECT") {
    fireEvent.change(control, { target: { value } });
    return;
  }
  openCatalog(control);
  const picker = control.closest<HTMLElement>(".searchable-picker");
  if (!picker) throw new Error("Expected a catalog picker");
  const option = within(picker)
    .getAllByRole("option", { hidden: true })
    .find((entry) => (entry as HTMLButtonElement).value === value);
  if (!option)
    throw new Error(`Catalog value not found: ${JSON.stringify(value)}`);
  flushSync(() => fireEvent.click(option));
}
