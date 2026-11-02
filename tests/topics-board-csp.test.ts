import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
it("allows only the three pinned DnD styles, not arbitrary inline scripts or styles", async () => {
  const html = await readFile(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  const policy = html.match(
    /http-equiv="Content-Security-Policy" content="([^"]+)"/,
  )![1];
  expect(policy).not.toContain("unsafe-inline");
  expect(policy).not.toContain("unsafe-eval");
  const style = policy
    .split(";")
    .find((v) => v.trim().startsWith("style-src"))!;
  expect(style.match(/'sha256-[^']+'/g)).toEqual([
    "'sha256-P3zrZWkaCzrI/B9T0+WLFRTTY8rvTIfnbvP5TBI9Vgo='",
    "'sha256-E7zJXfkufcgTIQG1Th6iYnoGis+rTfZd044bgiM1kr4='",
    "'sha256-YYLJe/bgx7gKdFc8dp3EM3/S8hpKeZs7JyhfBoZYPuk='",
  ]);
  expect(policy).toContain("script-src 'self'");
  expect(policy).toContain("connect-src 'none'");
});
