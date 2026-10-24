let nextId = 0;
/** Dialog lives in the same sandboxed renderer as the terminal. All data is text,
 * never HTML. Native modal focus trapping keeps Enter out of the underlying PTY. */
export function terminalConfirmation(
  root: HTMLElement,
  options: {
    title: string;
    message: string;
    preview?: string;
    confirm?: string;
  },
  decide: (confirmed: boolean) => void,
): () => void {
  const dialog = document.createElement("dialog");
  dialog.className = "terminal-confirmation";
  const title = document.createElement("h2"),
    message = document.createElement("p");
  title.id = `terminal-confirmation-${++nextId}`;
  title.textContent = options.title;
  message.textContent = options.message;
  dialog.setAttribute("aria-labelledby", title.id);
  dialog.append(title, message);
  if (options.preview !== undefined) {
    const preview = document.createElement("pre");
    preview.textContent = options.preview;
    preview.tabIndex = 0;
    dialog.append(preview);
  }
  const actions = document.createElement("div");
  actions.className = "terminal-confirmation-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = options.confirm ? "Отмена" : "Закрыть";
  actions.append(cancel);
  let settled = false;
  const finish = (confirmed: boolean) => {
    if (settled) return;
    settled = true;
    dialog.close();
    dialog.remove();
    decide(confirmed);
  };
  cancel.addEventListener("click", () => finish(false));
  if (options.confirm) {
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = options.confirm;
    confirm.addEventListener("click", () => finish(true));
    actions.append(confirm);
  }
  dialog.append(actions);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(false);
  });
  dialog.addEventListener("close", () => finish(false));
  root.append(dialog);
  try {
    dialog.showModal();
    cancel.focus();
  } catch {
    finish(false);
  }
  return () => finish(false);
}
