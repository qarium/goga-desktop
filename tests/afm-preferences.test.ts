// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { initializeAFM } from "../src/main/afm-preferences";
import { AFM_EMBEDDED_STYLE } from "../src/main/afm-style";
const enabled = "afm-notifications-enabled";
const origin = window.location.origin;
let cleanup: (() => void) | undefined;
function init(
  permission: string | null = "granted",
  expected = origin,
  main = true,
) {
  if (permission === null) vi.stubGlobal("Notification", undefined);
  else
    vi.stubGlobal("Notification", { permission, requestPermission: vi.fn() });
  cleanup = initializeAFM(window, expected, main);
}
beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = "light";
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it("initializes actual granted preference synchronously before AFM initial state", () => {
  init();
  expect(localStorage.getItem(enabled)).toBe("1");
  expect(Notification.requestPermission).not.toHaveBeenCalled();
});
it.each(["denied", "default", null])(
  "never leaves false enabled for %s",
  (permission) => {
    localStorage.setItem(enabled, "1");
    init(permission);
    expect(localStorage.getItem(enabled)).toBeNull();
  },
);
it("manual disable remains off on reload; manual enable stays on", () => {
  init();
  cleanup?.();
  localStorage.removeItem(enabled);
  init();
  expect(localStorage.getItem(enabled)).toBeNull();
  cleanup?.();
  localStorage.setItem(enabled, "1");
  init();
  expect(localStorage.getItem(enabled)).toBe("1");
});
it("a fresh isolated run defaults on again after consent", () => {
  init();
  cleanup?.();
  localStorage.removeItem(enabled);
  localStorage.clear();
  init();
  expect(localStorage.getItem(enabled)).toBe("1");
});
it("denied does not consume first granted initialization", () => {
  init("denied");
  cleanup?.();
  init("granted");
  expect(localStorage.getItem(enabled)).toBe("1");
});
it.each([
  ["https://other.test", true],
  [origin, false],
])("does nothing for untrusted origin or subframe", (expected, main) => {
  localStorage.setItem("afm-mode", "light");
  init("granted", expected as string, main as boolean);
  expect(localStorage.getItem(enabled)).toBeNull();
  expect(localStorage.getItem("afm-mode")).toBe("light");
  expect(document.documentElement.dataset.theme).toBe("light");
});
it("overwrites saved light before AFM restore and keeps dark through reload", async () => {
  localStorage.setItem("afm-mode", "light");
  init();
  expect(localStorage.getItem("afm-mode")).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  document.documentElement.dataset.theme = "light";
  await Promise.resolve();
  expect(document.documentElement.dataset.theme).toBe("dark");
  cleanup?.();
  localStorage.setItem("afm-mode", "light");
  init();
  expect(document.documentElement.dataset.theme).toBe("dark");
});
it("teardown stops delayed theme mutations", async () => {
  init();
  cleanup?.();
  document.documentElement.dataset.theme = "light";
  await Promise.resolve();
  expect(document.documentElement.dataset.theme).toBe("light");
});
it("hides only theme group and branding, keeping other header controls", () => {
  document.body.innerHTML = `<style>${AFM_EMBEDDED_STYLE}</style><header id="header" class="global-header"><div class="gh-left"><div class="gh-mark">Logo</div><div class="gh-wordmark">Wordmark</div><div class="gh-flow">Flow</div></div><div class="gh-right header-actions"><div class="gh-theme-seg" role="group" aria-label="Theme mode"><button>Light</button></div><button id="bell">Bell</button><button id="files">Files</button><button id="agent">Agent</button><span id="status">Online</span><div id="metrics">Metrics</div></div></header>`;
  expect(
    getComputedStyle(document.querySelector(".gh-theme-seg")!).display,
  ).toBe("none");
  for (const selector of [
    ".gh-flow",
    ".gh-right",
    "#bell",
    "#files",
    "#agent",
    "#status",
    "#metrics",
  ])
    expect(
      getComputedStyle(document.querySelector(selector)!).display,
    ).not.toBe("none");
});

it("pagehide disconnects initialization observers when view is closed", async () => {
  init();
  window.dispatchEvent(new Event("pagehide"));
  document.documentElement.dataset.theme = "light";
  await Promise.resolve();
  expect(document.documentElement.dataset.theme).toBe("light");
});
it("handles a document root created after preload without waiting for DOMContentLoaded", async () => {
  const root = document.documentElement;
  document.removeChild(root);
  try {
    init();
    root.dataset.theme = "light";
    document.appendChild(root);
    await Promise.resolve();
    expect(root.dataset.theme).toBe("dark");
  } finally {
    if (!document.documentElement) document.appendChild(root);
  }
});
it("storage failure does not break dark mode or expose false notification state", () => {
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("blocked");
  });
  try {
    expect(() => init()).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe("dark");
  } finally {
    set.mockRestore();
  }
});
