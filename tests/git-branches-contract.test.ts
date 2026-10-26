import { describe, expect, it } from "vitest";
import * as contract from "../src/shared/git-branches";
describe("primary branch action contract", () => {
  const base = { projectId: "project", revision: "a".repeat(64) };
  it("accepts only the explicit primary project and strict action-specific arguments", () => {
    expect(
      contract.gitBranchRequestSchema.safeParse({
        ...base,
        action: "create",
        name: "feature/a",
        switch: false,
      }).success,
    ).toBe(true);
    for (const request of [
      {
        ...base,
        projectId: { projectId: "project", contextId: "forged" },
        action: "fetch",
      },
      { ...base, action: "fetch", context: {} },
      { ...base, action: "pull", force: true },
      { ...base, action: "switch-local", ref: "main" },
      { ...base, action: "switch-local", ref: "refs/remotes/origin/main" },
      { ...base, action: "switch-remote", ref: "refs/heads/main" },
      { ...base, action: "create", name: "-evil", switch: true },
      { ...base, action: "create", name: "a\u0000b", switch: false },
    ])
      expect(contract.gitBranchRequestSchema.safeParse(request).success).toBe(
        false,
      );
  });
  it("accepts only explicit merge sources and parameter-free abort", () => {
    for (const request of [
      { ...base, action: "merge", ref: "refs/heads/source" },
      { ...base, action: "merge", ref: "refs/remotes/origin/source" },
      { ...base, action: "abort-merge" },
    ])
      expect(contract.gitBranchRequestSchema.safeParse(request).success).toBe(
        true,
      );
    for (const request of [
      { ...base, action: "merge", ref: "source" },
      { ...base, action: "merge", ref: "refs/tags/v1" },
      { ...base, action: "merge", ref: "refs/heads/source", force: true },
      { ...base, action: "abort-merge", ref: "refs/heads/source" },
      { ...base, action: "abort-merge", hard: true },
    ])
      expect(contract.gitBranchRequestSchema.safeParse(request).success).toBe(
        false,
      );
  });
  it("requires opaque fixed length confirmation tokens", () => {
    expect(
      contract.gitBranchTokenSchema.safeParse("a".repeat(64)).success,
    ).toBe(true);
    expect(contract.gitBranchTokenSchema.safeParse("project").success).toBe(
      false,
    );
  });
});
