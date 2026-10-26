import { expect, it } from "vitest";
import {
  gitDiscardRequestSchema,
  gitDiscardTokenSchema,
} from "../src/shared/git-discard";
it("accepts only exact scope, freshness and literal unique selected paths", () => {
  const valid = {
    scope: "p",
    revision: "a".repeat(64),
    paths: ["file.txt", "dir/file.txt"],
  };
  expect(gitDiscardRequestSchema.parse(valid)).toEqual(valid);
  for (const change of [
    { paths: [] },
    { paths: ["../x"] },
    { paths: [".git/config"] },
    { paths: ["a", "a"] },
    { force: true },
    { root: "/tmp/other" },
    { revision: "old" },
    { scope: { projectId: "p" } },
  ])
    expect(
      gitDiscardRequestSchema.safeParse({ ...valid, ...change }).success,
    ).toBe(false);
  expect(gitDiscardTokenSchema.safeParse("x").success).toBe(false);
  expect(gitDiscardTokenSchema.parse("b".repeat(64))).toBe("b".repeat(64));
});
