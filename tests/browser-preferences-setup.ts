import { beforeEach } from "vitest";

// Independent browser fixtures must not inherit another test's selected project
// context. Remounts within a test deliberately retain storage to test restart.
beforeEach(() => {
  if (typeof window === "undefined") return;
  const storage = window.localStorage;
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key?.startsWith("goga.desktop.")) storage.removeItem(key);
  }
});
