import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const topics = readFileSync(
  new URL("../src/renderer/Topics.css", import.meta.url),
  "utf8",
);
const build = readFileSync(
  new URL("../src/renderer/BuildForm.css", import.meta.url),
  "utf8",
);
const sharedPath = new URL("../src/renderer/ActionReason.css", import.meta.url);
const shared = existsSync(sharedPath) ? readFileSync(sharedPath, "utf8") : "";
const rules = (css: string, selector: string) => {
  const start = css.indexOf(selector + " {");
  expect(start, `Missing reason-specific rule: ${selector}`).toBeGreaterThan(
    -1,
  );
  return css.slice(start, css.indexOf("}", start) + 1);
};
it("defines one shared amber badge with a button-height short state", () => {
  const badge = rules(shared, ".action-reason");
  expect(badge).toMatch(/align-items: center/);
  expect(badge).toMatch(/min-height: 36px/);
  expect(badge).toMatch(/line-height: 18px/);
  expect(badge).toMatch(/padding: 8px 10px/);
  expect(badge).toMatch(/border: 1px solid rgba\(232, 168, 76/);
  expect(badge).toMatch(/background: rgba\(232, 168, 76/);
  expect(badge).toMatch(/color: #edc28a/);
  expect(topics).not.toMatch(/\.topic-create-reason-(?:short|details)/);
  expect(build).not.toContain("topic-action-reason");
});
it("keeps both control groups centered and fixed-height rather than stretching with a long reason", () => {
  expect(rules(topics, ".topic-create-action")).toMatch(/align-items: center/);
  expect(rules(topics, ".topic-create-action")).toMatch(/flex: 0 0 auto/);
  expect(rules(topics, ".topic-create-action")).toMatch(/flex-wrap: nowrap/);
  expect(rules(topics, ".topic-create-action > button")).toMatch(
    /height: 36px/,
  );
  expect(rules(build, ".build-launch-action")).toMatch(/align-items: center/);
  expect(rules(build, ".build-launch-action > .split-launch")).toMatch(
    /flex: 0 0 auto/,
  );
  expect(rules(build, ".build-launch-action > .split-launch > button")).toMatch(
    /height: 36px/,
  );
});
it("allows complete badge blocks and meaningful text to wrap without fixed-width bases or clipping", () => {
  expect(rules(topics, ".topics-heading:has(.topic-create-reason)")).toMatch(
    /flex-wrap: wrap/,
  );
  expect(
    rules(
      topics,
      ".topics-heading:has(.topic-create-reason) > div:first-child",
    ),
  ).toMatch(/flex: 0 0 auto/);
  expect(
    rules(topics, ".topics-heading:has(.topic-create-reason) > .topic-actions"),
  ).toMatch(/flex-wrap: wrap/);
  expect(rules(build, ".build-launch-action")).toMatch(/flex-wrap: wrap/);
  expect(rules(shared, ".action-reason")).toMatch(/max-width: 100%/);
  expect(rules(shared, ".action-reason-text")).toMatch(
    /overflow-wrap: anywhere/,
  );
  expect(shared).not.toMatch(
    /text-overflow|line-clamp|overflow: hidden|white-space: nowrap/,
  );
  expect(build).not.toContain("flex: 0 1 300px");
  expect(topics).not.toContain("flex-basis: 100%");
});
