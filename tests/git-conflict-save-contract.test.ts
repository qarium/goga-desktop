import { describe, expect, it } from "vitest";

import * as api from "../src/shared/git-conflict-save";
const base = {
  scope: "project",
  path: "a",
  revision: "a".repeat(64),
  fingerprint: "b".repeat(64),
};
describe("strict single-path conflict save contract", () => {
  it("exposes explicit resolution and token schemas", () => {
    expect(api?.gitConflictSaveRequestSchema).toBeDefined();
    expect(api?.gitConflictSaveTokenSchema).toBeDefined();
  });
  it("accepts exact text and discriminated choices, including literal markers", () => {
    for (const resolution of [
      { kind: "text", text: "\ufeff<<<<<<< literal\r\nno newline" },
      { kind: "current" },
      { kind: "incoming" },
      { kind: "delete" },
    ])
      expect(
        api?.gitConflictSaveRequestSchema.safeParse({ ...base, resolution })
          .success,
      ).toBe(true);
  });
  it("rejects forged authority, stale shapes, invalid paths and non-UTF8 drafts", () => {
    for (const input of [
      { ...base, resolution: { kind: "text", text: "a" }, root: "/tmp" },
      { ...base, resolution: { kind: "current", oid: "a".repeat(40) } },
      { ...base, resolution: { kind: "text", text: "\uD800" } },
      { ...base, resolution: { kind: "text", text: "\0" } },
      { ...base, resolution: { kind: "text", text: "я".repeat(600000) } },
      { ...base, path: "../a", resolution: { kind: "delete" } },
      { ...base, resolution: { kind: "delete", text: "a" } },
      { ...base, fingerprint: "x", resolution: { kind: "delete" } },
    ])
      expect(api?.gitConflictSaveRequestSchema.safeParse(input).success).toBe(
        false,
      );
    expect(
      api?.gitConflictSaveTokenSchema.safeParse({ token: "a".repeat(64) })
        .success,
    ).toBe(false);
  });
});
