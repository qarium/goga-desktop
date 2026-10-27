import { describe, expect, it } from "vitest";
import {
  gitHistoryRefSchema,
  gitOidSchema,
  gitHistoryRequestSchema,
} from "../src/shared/git-history";

describe("commit history request contracts", () => {
  it.each([40, 64])("accepts a complete %i-character object ID", (length) => {
    expect(gitOidSchema.parse("a".repeat(length))).toBe("a".repeat(length));
  });
  it.each([
    "main",
    "abc",
    "a".repeat(41),
    "a".repeat(65),
    "g".repeat(40),
    "HEAD~1",
  ])("rejects a non-OID %j", (value) => {
    expect(gitOidSchema.safeParse(value).success).toBe(false);
  });
  it.each([
    "HEAD",
    "refs/heads/main",
    "refs/heads/feature/задача",
    "refs/remotes/origin/main",
  ])("accepts exact ref %j", (ref) => {
    expect(gitHistoryRefSchema.parse(ref)).toBe(ref);
  });
  it.each([
    "",
    "main",
    "main~1",
    "--all",
    "refs/tags/v1",
    "refs/goga/topic",
    "../path",
    "refs/heads/../x",
    "refs/heads/x~1",
    "refs/heads/x^{commit}",
    "refs/heads/a:b",
    "refs/heads/a@{1}",
    "refs/heads/.hidden",
    "refs/heads/a.lock",
    "refs/heads/a//b",
    "refs/heads/a\nb",
    "refs/heads/a b",
    "refs/heads/a\\b",
    "refs/heads/*",
    "refs/heads/a.",
    "refs/heads/a/",
  ])("rejects revision expressions and malformed refs %j", (ref) => {
    expect(gitHistoryRefSchema.safeParse(ref).success).toBe(false);
  });
  it("bounds paging and requires a pinned tip after the first page", () => {
    const request = { scope: "project", ref: "HEAD", offset: 0 };
    expect(gitHistoryRequestSchema.parse(request)).toEqual(request);
    expect(
      gitHistoryRequestSchema.parse({
        ...request,
        offset: 50,
        tip: "a".repeat(40),
      }).offset,
    ).toBe(50);
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity, 50]) {
      expect(
        gitHistoryRequestSchema.safeParse({ ...request, offset }).success,
      ).toBe(false);
    }
    for (const extra of [
      { root: "/tmp" },
      { argv: ["status"] },
      { scope: {} },
    ]) {
      expect(
        gitHistoryRequestSchema.safeParse({ ...request, ...extra }).success,
      ).toBe(false);
    }
  });
});

describe("commit comparison contracts", () => {
  it("accepts strict parent and path requests, not arbitrary revisions or paths", async () => {
    const { gitCommitReadRequestSchema, gitCommitDiffRequestSchema } =
      await import("../src/shared/git-history");
    const request = {
      scope: "project",
      ref: "HEAD",
      tip: "a".repeat(40),
      commit: "b".repeat(40),
      parentIndex: 0,
      fileOffset: 0,
    };
    expect(gitCommitReadRequestSchema.parse(request)).toEqual(request);
    for (const change of [
      { parentIndex: -1 },
      { parentIndex: 0.2 },
      { fileOffset: -1 },
      { commit: "HEAD~1" },
      { tip: "main" },
      { cwd: "/tmp" },
    ])
      expect(
        gitCommitReadRequestSchema.safeParse({ ...request, ...change }).success,
      ).toBe(false);
    const { fileOffset: _, ...diff } = request;
    expect(
      gitCommitDiffRequestSchema.parse({
        ...diff,
        path: "new\nЮникод",
        originalPath: "old",
      }).path,
    ).toBe("new\nЮникод");
    for (const change of [
      { path: "../x" },
      { path: ".git/config" },
      { path: "/tmp/x" },
      { originalPath: "../x" },
      { fileOffset: 0 },
    ])
      expect(
        gitCommitDiffRequestSchema.safeParse({ ...diff, path: "a", ...change })
          .success,
      ).toBe(false);
  });
});
