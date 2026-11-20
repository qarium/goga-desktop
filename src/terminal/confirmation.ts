import type { MessageKey } from "../shared/locale-packs.generated";
import { subscribeLocale, t } from "../shared/i18n";
type ConfirmationText = Extract<MessageKey, `native.${string}`>;
let nextId = 0;
/** Dialog lives in the same sandboxed renderer as the terminal. All data is text,
 * never HTML. Native modal focus trapping keeps Enter out of the underlying PTY. */
export function terminalConfirmation(
  root: HTMLElement,
  options: {
    titleKey: ConfirmationText;
    messageKey: ConfirmationText;
    preview?: string;
    confirmKey?: ConfirmationText;
  },
  decide: (confirmed: boolean) => void,
): () => void {
  const dialog = document.createElement("dialog");
  dialog.className = "terminal-confirmation";
  const title = document.createElement("h2"),
    message = document.createElement("p");
  title.id = `terminal-confirmation-${++nextId}`;
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
  actions.append(cancel);
  let settled = false;
  const finish = (confirmed: boolean) => {
    if (settled) return;
    settled = true;
    offLanguage();
    dialog.close();
    dialog.remove();
    decide(confirmed);
  };
  cancel.addEventListener("click", () => finish(false));
  const confirm = options.confirmKey ? document.createElement("button") : undefined;
  if (confirm) {
    confirm.type = "button";
    confirm.className = "primary";
    confirm.addEventListener("click", () => finish(true));
    actions.append(confirm);
  }
  dialog.append(actions);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(false);
  });
  dialog.addEventListener("close", () => finish(false));
  const translate = () => {
    title.textContent = t(options.titleKey);
    message.textContent = t(options.messageKey);
    cancel.textContent = t(confirm ? "native.cancel" : "native.close");
    if (confirm && options.confirmKey) confirm.textContent = t(options.confirmKey);
  };
  translate();
  const offLanguage = subscribeLocale(translate);
  root.append(dialog);
  try {
    dialog.showModal();
    cancel.focus();
  } catch {
    finish(false);
  }
  return () => finish(false);
}
