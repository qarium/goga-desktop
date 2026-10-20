import { screen } from "@testing-library/react";
/** A retained DOM reference for concurrency/guard assertions, NOT a visible UI query.
 * Whole-form loading intentionally hides these controls. Tests may send stale
 * events to the retained node to verify the handler's independent safety guards. */
export function retainedButton(name: string | RegExp): HTMLButtonElement {
  const found = screen.getAllByRole("button", { hidden: true }).find((e) => {
    const value = (e.getAttribute("aria-label") || e.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    return typeof name === "string" ? value === name : name.test(value);
  });
  if (!found) throw Error("Retained button absent: " + name);
  return found as HTMLButtonElement;
}
