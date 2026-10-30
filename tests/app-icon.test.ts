import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  it("preserves the approved icon background", () => {
    const svg = readFileSync(
      new URL("../resources/icon.svg", import.meta.url),
      "utf8",
    );
    expect(svg).toContain(
      '<rect x="64" y="64" width="896" height="896" rx="210.560" fill="#0d1323"/>',
    );
  });
  it("keeps the approved icon without an added frame", () => {
    const svg = readFileSync(
      new URL("../resources/icon.svg", import.meta.url),
      "utf8",
    );
    expect(svg).not.toMatch(/\bstroke(?:-width)?=/);
    expect(svg.match(/<rect /g)).toHaveLength(1);
  });
  it("preserves all four approved wordmark outlines and their colors", () => {
    const svg = readFileSync(
      new URL("../resources/icon.svg", import.meta.url),
      "utf8",
    );
    const outlines = svg
      .match(
        /<g transform="translate\(0 1024\) scale\(1 -1\)">([\s\S]*?)<\/g>/,
      )?.[1]
      .trim();
    expect(outlines?.match(/<path /g)).toHaveLength(4);
    // Approved geometry and fills, independent of future system-font changes.
    expect(
      createHash("sha256")
        .update(outlines ?? "")
        .digest("hex"),
    ).toBe("ee2c9346d20e71f1b8c06131d8bb01d47dd1a641c9de64cd82d84e443ef28754");
  });
});
