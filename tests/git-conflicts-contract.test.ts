import { describe, expect, it } from "vitest";
import { gitConflictReadRequestSchema } from "../src/shared/git-conflicts";

describe("Git conflict read contract", () => {
  const request = {
    scope: "project",
    path: "folder/Юникод\n.txt",
    revision: "a".repeat(64),
  };
  it("accepts only a scoped path and opaque repository revision", () => {
    expect(gitConflictReadRequestSchema.parse(request)).toEqual(request);
    for (const extra of [
      { oid: "a".repeat(40) },
      { rev: "HEAD" },
      { root: "/tmp" },
      { stage: 2 },
    ])
      expect(
        gitConflictReadRequestSchema.safeParse({ ...request, ...extra })
          .success,
      ).toBe(false);
  });
  it("rejects traversal and missing or invalid owner/revision", () => {
    for (const input of [
      { ...request, path: "../x" },
      { ...request, scope: {} },
      { ...request, revision: "HEAD" },
    ])
      expect(gitConflictReadRequestSchema.safeParse(input).success).toBe(false);
  });
});
