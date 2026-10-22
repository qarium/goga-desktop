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
it("uses a full-width breadcrumb and aligned name, selector, repository and launch controls", () => {
  expect(rule(".project-heading")).toMatch(/display: contents/);
  expect(rule(".project-bar")).toMatch(/display: grid/);
  expect(rule(".project-heading > .eyebrow")).toMatch(/grid-column: 1 \/ -1/);
  expect(rule(".project-heading-context")).toMatch(/display: flex/);
  expect(rule(".project-heading-context")).toMatch(/align-items: center/);
  expect(rule(".project-heading-context > h1")).toMatch(/margin: 0/);
  expect(rule(".project-heading-context > h1")).toMatch(/line-height: 26px/);
});
it("preserves the fixed desktop header height used by native dashboard bounds", () => {
  expect(rule(".project-bar")).toMatch(/height: 80px/);
});
