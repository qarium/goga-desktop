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

it("admits only a scoped fresh recovery request, not force flags or writable paths", async () => {
  const contract = await import("../src/shared/git-discard");
  const schema = (contract as any).gitDiscardRecoveryRequestSchema;
  expect(schema).toBeDefined();
  const request = { scope: "p", revision: "a".repeat(64) };
  expect(schema.parse(request)).toEqual(request);
  for (const extra of [
    { force: true },
    { root: "/other" },
    { paths: ["other"] },
    { revision: "old" },
  ])
    expect(schema.safeParse({ ...request, ...extra }).success).toBe(false);
});
