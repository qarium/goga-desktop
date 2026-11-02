/** Runs only in the isolated AFM preload. No page API or React internals. */
export function selectAFMStage(
  document: Document,
  stageId: string,
  timeoutMs = 2000,
  signal?: AbortSignal,
): Promise<boolean> {
  if (
    typeof stageId !== "string" ||
    !stageId ||
    stageId.length > 256 ||
    /[\x00-\x1f\x7f]/.test(stageId)
  )
    return Promise.resolve(false);
  return new Promise((resolve) => {
    let clicked = false,
      finished = false;
    const Observer = document.defaultView?.MutationObserver;
    const abort = () => finish(false);
    const finish = (selected: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      observer?.disconnect();
      signal?.removeEventListener("abort", abort);
      resolve(selected);
    };
    const check = () => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(".stage-item[data-stage-id]"),
      ).filter((row) => row.dataset.stageId === stageId);
      if (rows.length > 1) {
        finish(false);
        return;
      }
      const row = rows[0];
      if (!row) return;
      const buttons = Array.from(row.children).filter(
        (e): e is HTMLButtonElement =>
          e.tagName === "BUTTON" && e.classList.contains("stage-row"),
      );
      if (buttons.length !== 1 || buttons[0].disabled) {
        finish(false);
        return;
      }
      if (!clicked) {
        clicked = true;
        buttons[0].click();
      }
      if (row.classList.contains("active")) finish(true);
    };
    const observer = Observer ? new Observer(check) : null;
    const timer = setTimeout(() => finish(false), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      finish(false);
      return;
    }
    observer?.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-stage-id"],
    });
    check();
  });
}
