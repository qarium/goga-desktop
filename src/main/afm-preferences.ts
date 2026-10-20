/** Runs in the isolated, sandboxed preload world before AFM reads its preferences.
 * No Node/Electron bridge, permission requests, or Notification API replacement.
 */
type AFMWindow = Pick<
  Window,
  | "document"
  | "location"
  | "localStorage"
  | "addEventListener"
  | "removeEventListener"
> & {
  Notification?: Pick<typeof Notification, "permission">;
  MutationObserver: typeof MutationObserver;
};
const ENABLED = "afm-notifications-enabled";
const INITIALIZED = "goga-desktop-notifications-initialized";
export function initializeAFM(
  win: AFMWindow,
  expectedOrigin: string,
  mainFrame: boolean,
): () => void {
  if (!mainFrame || !expectedOrigin || win.location.origin !== expectedOrigin)
    return () => {};
  const document = win.document;
  // The synchronous write precedes AFM's inline theme restoration script.
  try {
    win.localStorage.setItem("afm-mode", "dark");
  } catch {
    /* DOM fallback below. */
  }
  try {
    if (win.Notification?.permission === "granted") {
      if (win.localStorage.getItem(INITIALIZED) !== "1") {
        // Mark first: a failed preference write must not re-enable a later manual opt-out.
        win.localStorage.setItem(INITIALIZED, "1");
        win.localStorage.setItem(ENABLED, "1");
      }
    } else {
      win.localStorage.removeItem(ENABLED);
    }
  } catch {
    /* Storage unavailable: never fake enabled or permission. */
  }
  let stopped = false;
  const enforceDark = () => {
    if (
      !stopped &&
      document.documentElement &&
      document.documentElement.dataset.theme !== "dark"
    )
      document.documentElement.dataset.theme = "dark";
  };
  enforceDark();
  // Also handles the root not yet existing at preload time and AFM's early restore.
  const observer = new win.MutationObserver(enforceDark);
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const cleanup = () => {
    stopped = true;
    observer.disconnect();
    win.removeEventListener("pagehide", cleanup);
  };
  win.addEventListener("pagehide", cleanup, { once: true });
  return cleanup;
}
