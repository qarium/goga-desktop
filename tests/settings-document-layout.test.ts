import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(
  new URL("../src/renderer/style.css", import.meta.url),
  "utf8",
);
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
it("keeps Tool Delete/Cancel/Save on one 412px row without changing shared settings action spacing", () => {
  expect(rule(".tool-files-detail .document-save-actions")).toMatch(
    /gap:\s*8px/,
  );
  expect(rule(".tool-files-detail .document-save-primary-actions")).toMatch(
    /gap:\s*12px/,
  );
  expect(rule(".document-save-actions")).toMatch(/gap:\s*16px 28px/);
  expect(rule(".document-save-primary-actions")).toMatch(/gap:\s*12px/);
});
