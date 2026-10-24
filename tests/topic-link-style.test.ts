import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("topic links override the generic button hover fill with underline only", () => {
  const css = readFileSync("src/renderer/Topics.css", "utf8");
  // This selector is more specific than button:hover:not(:disabled),
  // regardless of stylesheet order. Keep the normal keyboard focus outline.
  const rule = css.match(
    /button\.topic-link:hover:not\(:disabled\)\s*\{([^}]+)\}/,
  )?.[1];
  expect(rule).toBeDefined();
  expect(rule).toMatch(/background:\s*transparent\s*;/);
  expect(rule).toMatch(/text-decoration:\s*underline\s*;/);
  expect(rule).not.toMatch(/(?:color|outline):/);
});
