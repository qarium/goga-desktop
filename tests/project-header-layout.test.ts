import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(new URL("../src/renderer/style.css", import.meta.url), "utf8");
const rule = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
it("uses explicit two-row heading layout instead of mixed inline baselines", () => {
  expect(rule(".project-heading")).toMatch(/display: flex/);
  expect(rule(".project-heading")).toMatch(/flex-direction: column/);
  expect(rule(".project-heading")).toMatch(/gap: 4px/);
  expect(rule(".project-heading-context")).toMatch(/display: flex/);
  expect(rule(".project-heading-context")).toMatch(/align-items: center/);
  expect(rule(".project-heading-context > .topic-context-picker")).toMatch(/margin-left: 0/);
  expect(rule(".project-heading > h1")).toMatch(/margin: 0/);
  expect(rule(".project-heading > h1")).toMatch(/line-height: 26px/);
});
it("preserves the fixed desktop header height used by native dashboard bounds", () => {
  expect(rule(".project-bar")).toMatch(/height: 80px/);
});
