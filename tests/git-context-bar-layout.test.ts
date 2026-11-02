import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(new URL("../src/renderer/" + name, import.meta.url), "utf8");
const rule = (css: string, selector: string) => {
  const start = css.indexOf(selector + " {");
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};
it("reserves vertical breathing room around both shared Git controls", () => {
  const bar = rule(read("style.css"), ".run-context");
  const control = rule(read("GitWorkspace.css"), ".git-workspace-trigger");
  expect(bar).toMatch(/height: 44px;/);
  expect(bar).toMatch(/align-items: center;/);
  expect(control).toMatch(/height: 28px;/);
  expect(control).toMatch(/min-height: 28px;/);
  expect(control).toMatch(/line-height: 18px;/);
  expect(control).toMatch(/padding: 4px 10px;/);
  expect(read("GitBranchPicker.tsx")).toContain(
    'className="git-workspace-trigger git-branch-trigger"',
  );
});
it("keeps icons compact and long branch names truncated without hiding the counter", () => {
  const css = read("GitWorkspace.css");
  expect(rule(css, ".git-workspace-trigger svg")).toMatch(/height: 16px;/);
  expect(rule(css, ".git-workspace-trigger svg")).toMatch(/flex-shrink: 0;/);
  expect(rule(css, ".git-changes-count")).toMatch(/flex-shrink: 0;/);
  expect(
    rule(
      read("GitBranchPicker.css"),
      ".git-branch-trigger > span:nth-child(2)",
    ),
  ).toMatch(/text-overflow: ellipsis;/);
});

it("groups pipeline state and stop immediately before repository controls", () => {
  const css = read("style.css");
  expect(read("App.tsx").includes('className="run-actions"')).toBe(true);
  expect(rule(css, ".run-actions")).toMatch(/align-items: center;/);
  expect(rule(css, ".run-actions")).toMatch(/gap: 8px;/);
  expect(rule(css, ".run-state")).not.toMatch(/margin-left: auto/);
  expect(
    rule(
      read("GitWorkspace.css"),
      ".run-actions + .git-workspace-controls-host",
    ),
  ).toMatch(/margin-left: 0;/);
});
it("aligns the new topic fields regardless of the task link", () => {
  const css = read("style.css");
  expect(rule(css, ".topic-new-row")).toMatch(/align-items: start;/);
  const form = read("LaunchForm.css");
  expect(rule(form, ".topic-new-row .searchable-picker > button")).toMatch(
    /height: 42px;/,
  );
  expect(rule(form, ".topic-new-row > label > input")).toMatch(
    /margin-top: 8px;/,
  );
});
