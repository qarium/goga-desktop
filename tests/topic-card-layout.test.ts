import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps both split-selector focus rings inside their own button", () => {
  const css = readFileSync("src/renderer/TopicContextPicker.css", "utf8");
  const rule = css.match(/\.topic-context-name:focus-visible,\s*\.topic-context-trigger:focus-visible\s*\{([^}]+)\}/)?.[1];
  expect(rule).toBeDefined();
  expect(rule).toMatch(/outline-offset:\s*-3px\s*;/);
  expect(rule).not.toMatch(/outline:\s*(?:none|0)\b/);
});

it("isolates document filename typography from generic dialog headings", () => {
  const css = readFileSync("src/renderer/ProjectHistory.css", "utf8");
  // Two classes override .topic-dialog h3 regardless of stylesheet order.
  const rule = css.match(/\.history-document\s+\.history-document-head\s+h3\s*\{([^}]+)\}/)?.[1];
  expect(rule).toBeDefined();
  expect(rule).toMatch(/margin:\s*0\s*;/);
  expect(rule).toMatch(/font-size:\s*16px\s*;/);
});
