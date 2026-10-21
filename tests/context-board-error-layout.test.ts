import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("lets the catalog error wrap in normal layout without shrinking or covering run tabs", () => {
  const css = readFileSync(
    new URL("../src/renderer/style.css", import.meta.url),
    "utf8",
  );
  const rule = css.match(/\.context-board-error\s*\{([^}]+)\}/)?.[1] ?? "";
  expect(rule).toMatch(/flex-shrink:\s*0/);
  expect(rule).toMatch(/flex-wrap:\s*wrap/);
  expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  expect(rule).not.toMatch(/position:\s*(absolute|fixed)|height:\s*\d/);
});
