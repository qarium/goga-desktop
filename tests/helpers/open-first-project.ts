import { fireEvent, waitFor } from "@testing-library/react";

/** Workspace regressions start by entering a registered project from Home,
 * exactly as a user does. No alternate product startup route in tests. */
export async function openFirstProject() {
  const button = await waitFor(() => {
    const row = document.querySelector<HTMLButtonElement>(
      ".sidebar button.project-button",
    );
    if (!row) throw new Error("Waiting for the registered project");
    return row;
  });
  fireEvent.click(button);
}
