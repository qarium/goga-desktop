// @vitest-environment jsdom
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

it("uses one compact icon-only pattern for pipeline toolbar actions", () => {
  const css = read("RunActions.css");
  const action = rule(css, ".run-context .run-action-button");
  expect(action).toMatch(/width: 28px;/);
  expect(action).toMatch(/height: 28px;/);
  expect(action).toMatch(/min-width: 28px;/);
  expect(action).toMatch(/padding: 5px;/);
  expect(rule(css, ".run-context .run-action-button svg")).toMatch(
    /width: 15px;/,
  );
});

it("compacts Git by available editor-strip width, not by changes to the file", () => {
  // Container rules are exercised in Chromium; jsdom does not lay them out.
  const css = read("GitWorkspace.css");
  expect(rule(css, ".run-context[data-document-section]")).toMatch(
    /container:\s*document-strip \/ inline-size/,
  );
  expect(css).toMatch(
    /@container document-strip \(max-width: 700px\)\s*\{\s*\.git-workspace-controls :is\(\.git-branch-trigger, \.git-workspace-branch\)\s*\{[^}]*max-width:/s,
  );
  expect(css).toMatch(
    /@container document-strip \(max-width: 620px\)\s*\{[^@]*\.git-control-label\s*\{[^}]*display: none;/s,
  );
});

it("keeps stop neutral like its peers and puts run state colors on status text only", () => {
  const css = read("RunActions.css");
  expect(css).not.toContain(".run-context .run-action-button.stop-button");
  expect(rule(css, ".run-actions .run-state-live")).toMatch(
    /color: var\(--teal\);/,
  );
  expect(rule(css, ".run-actions .run-state-ended")).toMatch(/color: #ef856d;/);
});

it("keeps Git anchored and only separates it from a visible document status or run group", () => {
  const sheet = document.createElement("style");
  sheet.textContent = [read("style.css"), read("GitWorkspace.css")].join("\n");
  const strip = document.createElement("div");
  strip.className = "run-context";
  strip.innerHTML =
    '<span class="workspace-path">/long/path</span><div class="document-status-outlet"></div><div class="git-workspace-controls-host"></div>';
  document.head.append(sheet);
  document.body.append(strip);
  try {
    const [path, outlet, git] = Array.from(strip.children);
    // jsdom cannot paint pseudo-elements, so match the actual divider selector
    // against each DOM state rather than assuming CSS adjacency.
    const divider = Array.from(sheet.sheet!.cssRules).find(
      (r): r is CSSStyleRule =>
        "selectorText" in r &&
        String(r.selectorText).endsWith(".git-workspace-controls-host::before"),
    );
    expect(divider).toBeDefined();
    const separated = () =>
      git.matches(divider!.selectorText.replaceAll("::before", ""));
    expect(divider!.style.height).toBe("20px");
    expect(divider!.style.width).toBe("1px");
    expect(divider!.style.background).toBe("var(--line)");
    expect(getComputedStyle(outlet).display).toBe("none");
    expect(getComputedStyle(git).marginLeft).toBe("auto");
    expect(separated()).toBe(false);

    const badge = document.createElement("span");
    badge.className = "document-save-feedback";
    outlet.append(badge);
    expect(getComputedStyle(outlet).display).toBe("flex");
    expect(getComputedStyle(outlet).marginLeft).toBe("auto");
    expect(getComputedStyle(path).flexBasis).toMatch(/^0(px|%)?$/);
    expect(getComputedStyle(git).flexShrink).toBe("0");
    expect(getComputedStyle(git).marginLeft).toBe("0px");
    expect(separated()).toBe(true);

    badge.remove();
    const run = document.createElement("div");
    run.className = "run-actions";
    outlet.after(run);
    expect(getComputedStyle(outlet).display).toBe("none");
    expect(getComputedStyle(git).marginLeft).toBe("0px");
    expect(separated()).toBe(true);
  } finally {
    strip.remove();
    sheet.remove();
  }
});
