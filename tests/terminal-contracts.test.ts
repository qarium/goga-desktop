import { describe, expect, it } from "vitest";
import {
  terminalContextKey,
  terminalContextSchema,
  terminalTabSchema,
  terminalRegistrySchema,
  terminalInputSchema,
  terminalResizeSchema,
  type TerminalContext,
} from "../src/shared/terminal";
const primary: TerminalContext = { kind: "primary", projectId: "p" };
const topic: TerminalContext = {
  kind: "topic",
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: `ctx-${"a".repeat(64)}`,
};
const tab = (scope: unknown) => ({
  id: "t",
  projectId: "p",
  name: "console",
  scope,
});
describe("terminal scope contracts", () => {
  it("accepts common, primary-bound and topic-bound tabs", () => {
    for (const scope of [
      { kind: "common" },
      { kind: "context", context: primary },
      { kind: "context", context: topic },
    ])
      expect(terminalTabSchema.safeParse(tab(scope)).success).toBe(true);
  });
  it("rejects conflicting owners and unknown fields rather than discarding them", () => {
    expect(
      terminalTabSchema.safeParse(
        tab({ kind: "context", context: { ...topic, projectId: "q" } }),
      ).success,
    ).toBe(false);
    for (const field of ["env", "pid", "cwd", "output", "command"])
      expect(
        terminalTabSchema.safeParse({
          ...tab({ kind: "common" }),
          [field]: "secret",
        }).success,
      ).toBe(false);
    expect(
      terminalContextSchema.safeParse({ ...topic, contextId: "made-up" })
        .success,
    ).toBe(false);
    expect(
      terminalContextSchema.safeParse({ ...topic, revision: "revision" })
        .success,
    ).toBe(false);
  });
  it.each(["", " ", "x\ny", "x\0y", "x".repeat(121)])(
    "rejects invalid name %j",
    (name) => {
      expect(
        terminalTabSchema.safeParse({ ...tab({ kind: "common" }), name })
          .success,
      ).toBe(false);
    },
  );
  it("stable context keys distinguish every ownership field and not revision", () => {
    expect(terminalContextKey(primary)).not.toBe(terminalContextKey(topic));
    for (const [field, value] of Object.entries({
      projectId: "q",
      year: "2025",
      topic: "b",
      branch: "b",
      contextId: `ctx-${"b".repeat(64)}`,
    }))
      expect(terminalContextKey({ ...topic, [field]: value })).not.toBe(
        terminalContextKey(topic),
      );
    const withRevision = { ...topic, revision: "new" };
    expect(terminalContextKey(withRevision)).toBe(terminalContextKey(topic));
    expect(
      terminalContextKey({ ...topic, topic: "a/b", branch: "c" }),
    ).not.toBe(terminalContextKey({ ...topic, topic: "a", branch: "b/c" }));
  });
  it("validates generation and UTF-8 byte size, not only string length", () => {
    const ref = {
      sessionId: "s",
      generation: "11111111-1111-4111-8111-111111111111",
    };
    expect(
      terminalInputSchema.safeParse({ ...ref, text: "Привет ✓" }).success,
    ).toBe(true);
    expect(
      terminalInputSchema.safeParse({ ...ref, text: "界".repeat(22000) })
        .success,
    ).toBe(false);
    expect(
      terminalInputSchema.safeParse({ ...ref, generation: "stale", text: "x" })
        .success,
    ).toBe(false);
    expect(
      terminalResizeSchema.safeParse({ ...ref, cols: 80, rows: 24 }).success,
    ).toBe(true);
    for (const cols of [0, 1, 1001, 2.5])
      expect(
        terminalResizeSchema.safeParse({ ...ref, cols, rows: 24 }).success,
      ).toBe(false);
  });
  it("validates registry ownership, uniqueness and selections", () => {
    const t = tab({ kind: "common" });
    const value = {
      schemaVersion: 1,
      revision: "11111111-1111-4111-8111-111111111111",
      projects: {
        p: {
          initialized: true,
          tabs: [t],
          selectedByContext: { [terminalContextKey(primary)]: "t" },
        },
      },
    };
    expect(terminalRegistrySchema.safeParse(value).success).toBe(true);
    expect(
      terminalRegistrySchema.safeParse({
        ...value,
        projects: { q: value.projects.p },
      }).success,
    ).toBe(false);
    expect(
      terminalRegistrySchema.safeParse({
        ...value,
        projects: { p: { ...value.projects.p, tabs: [t, t] } },
      }).success,
    ).toBe(false);
    expect(
      terminalRegistrySchema.safeParse({
        ...value,
        projects: {
          p: { ...value.projects.p, selectedByContext: { bad: "t" } },
        },
      }).success,
    ).toBe(false);
    expect(
      terminalRegistrySchema.safeParse({
        ...value,
        projects: {
          p: {
            ...value.projects.p,
            selectedByContext: { [terminalContextKey(primary)]: "missing" },
          },
        },
      }).success,
    ).toBe(false);
  });
});
