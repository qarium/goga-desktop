import { t as msg } from "../shared/i18n";
// A Desktop UI preference, not a project document or part of Goga configuration.
const key = "goga.desktop.autoSaveOnLeave.v1";
const changed = "goga:auto-save-on-leave-changed";

export function readAutoSaveOnLeave(): boolean {
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false; // Storage unavailable: never silently opt in to writes.
  }
}

export function setAutoSaveOnLeave(enabled: boolean): void {
  try {
    window.localStorage.setItem(key, String(enabled));
  } catch {
    throw Error(
      msg("workspace.couldNotSaveTheAutosavePreferenceOnThisComputer"),
    );
  }
  window.dispatchEvent(new Event(changed));
}

export function subscribeAutoSaveOnLeave(notify: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) notify();
  };
  window.addEventListener(changed, notify);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(changed, notify);
    window.removeEventListener("storage", storage);
  };
}
