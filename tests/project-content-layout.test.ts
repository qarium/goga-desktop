import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("Project, Topics and Terminal share the responsive content grid", () => {
  for (const name of [
    "ProjectSettings",
    "TopicsWorkspace",
    "TerminalWorkspace",
  ])
    expect(readFileSync(`src/renderer/${name}.tsx`, "utf8")).toContain(
      "project-content",
    );
  const css = readFileSync("src/renderer/ProjectContent.css", "utf8");
  expect(css).toContain("max-width: 1240px");
  expect(css).toContain("padding: 26px 32px 40px");
  expect(css).toContain("padding: 20px 20px 32px");
  expect(css).toContain("padding: 18px 12px");
});
