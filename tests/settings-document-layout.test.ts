import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
it("wraps settings tabs rather than clipping their labels", () => {
  expect(rule(".section-tabs")).toMatch(/flex-wrap: wrap/);
});
it("allows document headings and long paths to shrink and wrap", () => {
  expect(rule(".editor-heading")).toMatch(/flex-wrap: wrap/);
  expect(rule(".editor-heading > div")).toMatch(/min-width: 0/);
  expect(rule(".context-path")).toMatch(/overflow-wrap: anywhere/);
});
