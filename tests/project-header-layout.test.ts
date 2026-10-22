import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const css = readFileSync(
  new URL("../src/renderer/style.css", import.meta.url),
  "utf8",
);
const rule = (selector: string, source = css) => {
  const start = source.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
};
const desktop = css.slice(css.indexOf("/* Identity is a separate left block."));
it("keeps identity separate with selector, repository and launch controls on one desktop row", () => {
  expect(rule(".project-heading")).not.toMatch(/display: contents/);
  expect(rule(".project-heading")).toMatch(/min-width: 0/);
  expect(rule(".project-bar")).toMatch(/display: grid/);
  expect(rule(".project-bar", desktop)).toMatch(
    /grid-template-columns: 180px minmax\(0, 1fr\) auto/,
  );
  expect(rule(".project-bar", desktop)).toMatch(/grid-template-rows: 1fr/);
  expect(rule(".project-bar", desktop)).toMatch(/column-gap: 24px/);
  expect(rule(".project-heading > .eyebrow")).toMatch(/display: block/);
  expect(rule(".project-heading > .eyebrow")).not.toMatch(/grid-column/);
  expect(rule(".project-heading-context")).toMatch(/display: flex/);
  expect(rule(".project-heading-context")).toMatch(/align-items: center/);
  expect(rule(".project-heading > h1")).toMatch(/line-height: 26px/);
  expect(rule(".project-bar > .project-actions")).toMatch(/grid-column: 3/);
  expect(rule(".project-bar > .project-actions")).toMatch(/grid-row: 1/);
});
it("preserves the fixed desktop header height used by native dashboard bounds", () => {
  expect(rule(".project-bar")).toMatch(/height: 80px/);
});
it("keeps compact desktop labels and caret readable without stacking controls", () => {
  const start = css.indexOf(
    "@media (min-width: 901px) and (max-width: 1050px)",
  );
  expect(start).toBeGreaterThan(-1);
  const compact = css.slice(
    start,
    css.indexOf("@media (max-width: 900px)", start),
  );
  expect(rule(".project-bar", compact)).toMatch(
    /grid-template-columns: 104px minmax\(0, 1fr\) auto/,
  );
  expect(compact).not.toMatch(/grid-template-rows|column-gap|flex-wrap/);
  expect(rule(".project-heading > .eyebrow", compact)).toMatch(
    /white-space: normal/,
  );
  expect(rule(".project-heading-context .topic-context-name", compact)).toMatch(
    /min-width: 96px/,
  );
  // The final trigger override reserves space for the absolutely positioned caret.
  const triggers = [
    ...compact.matchAll(/\.context-launch-trigger\s*\{([^}]+)\}/g),
  ];
  expect(triggers.at(-1)?.[1]).toMatch(/padding-right: 28px/);
  expect(
    rule(".project-bar > .project-actions .context-select-chevron", compact),
  ).toMatch(/right: 10px/);
});
