import { describe, expect, it } from "vitest";
import {
  gitDiffRequestSchema,
  gitFilePathSchema,
  gitRevisionSchema,
} from "../src/shared/git-workspace";

describe("Git workspace contracts", () => {
  it.each([
    "file",
    "with space/Юникод\n.txt",
    "-option",
    ":(glob)*.txt",
    "back\\slash",
    " leading ",
  ])("preserves a literal relative path %j", (name) => {
    expect(gitFilePathSchema.parse(name)).toBe(name);
  });
  it.each([
    "",
    "/etc/passwd",
    "../x",
    "x/../y",
    "./x",
    "x/./y",
    "x//y",
    "x/",
    ".git/config",
    "x/.GIT/config",
    "a\0b",
    "C:/file",
    "\\\\server\\file",
    "bad\ud800",
    "bad\ufffd",
  ])("rejects unsafe or unrepresentable path %j", (name) => {
    expect(gitFilePathSchema.safeParse(name).success).toBe(false);
  });
  it("requires a bounded opaque revision and strict request including strict owner", () => {
    const request = { scope: "project", path: "a", revision: "a".repeat(64) };
    expect(gitDiffRequestSchema.parse(request)).toEqual(request);
    expect(
      gitDiffRequestSchema.safeParse({ ...request, root: "/tmp" }).success,
    ).toBe(false);
    expect(
      gitDiffRequestSchema.safeParse({ ...request, scope: {} }).success,
    ).toBe(false);
    expect(gitRevisionSchema.safeParse("").success).toBe(false);
    expect(gitRevisionSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(gitRevisionSchema.safeParse("main").success).toBe(false);
  });
});
