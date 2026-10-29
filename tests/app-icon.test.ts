import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { installApplicationIcon } from "../src/main/app-icon";

describe("application icon", () => {
  it("sets the macOS Dock icon and returns the same path for the window", () => {
    const setIcon = vi.fn();
    const filename = installApplicationIcon(
      { dock: { setIcon } },
      "/application/dist-electron",
      "darwin",
    );
    expect(filename).toBe(
      path.join("/application/dist-electron", "assets/icon.png"),
    );
    expect(setIcon).toHaveBeenCalledExactlyOnceWith(filename);
  });
  it("does not touch macOS Dock APIs on other platforms", () => {
    const setIcon = vi.fn();
    const filename = installApplicationIcon(
      { dock: { setIcon } },
      "/application/dist-electron",
      "linux",
    );
    expect(filename).toBe(
      path.join("/application/dist-electron", "assets/icon.png"),
    );
    expect(setIcon).not.toHaveBeenCalled();
  });
  it("supports a runtime without a Dock object", () => {
    expect(
      installApplicationIcon({}, "/application/dist-electron", "darwin"),
    ).toBe(path.join("/application/dist-electron", "assets/icon.png"));
  });
});
