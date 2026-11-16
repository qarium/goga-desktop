// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  applyOrganizationCommand as apply,
  reconcileOrganization as reconcile,
  emptyOrganization,
  orderedProjectIds,
} from "../src/renderer/project-organization-model";
const original = {
  schemaVersion: 1 as const,
  groups: [
    { id: "g", name: "Работа", collapsed: true, projectIds: ["a", "b"] },
    { id: "h", name: "Дом", collapsed: false, projectIds: [] },
  ],
  ungroupedProjectIds: ["c", "d"],
};
describe("Project organization", () => {
  it("does not destroy memberships while the catalog is loading; reconciles only confirmed additions/removals", () => {
    expect(reconcile(original, [], false)).toBe(original);
    expect(reconcile(original, ["d", "a", "c", "b"], true)).toBe(original);
    const next = reconcile(original, ["a", "b", "e"], true);
    expect(next.groups).toEqual(original.groups);
    expect(next.ungroupedProjectIds).toEqual(["e"]);
    expect(reconcile(next, ["e", "b", "d"], true).ungroupedProjectIds).toEqual([
      "e",
      "d",
    ]);
    expect(
      reconcile(emptyOrganization(), ["c", "a"], true).ungroupedProjectIds,
    ).toEqual(["c", "a"]);
  });
  it("moves between groups before/after anchors, expands the destination, and never duplicates IDs", () => {
    const next = apply(original, {
      type: "moveProject",
      id: "d",
      groupId: "g",
      anchor: "b",
      side: "before",
    });
    expect(next.groups[0]).toMatchObject({
      collapsed: false,
      projectIds: ["a", "d", "b"],
    });
    expect(original.groups[0].projectIds).toEqual(["a", "b"]);
    const after = apply(next, {
      type: "moveProject",
      id: "d",
      groupId: null,
      anchor: "c",
      side: "after",
    });
    expect(after.ungroupedProjectIds).toEqual(["c", "d"]);
    expect(orderedProjectIds(after)).toEqual(["a", "b", "c", "d"]);
    expect(
      apply(after, { type: "moveProject", id: "d", groupId: "unknown" }),
    ).toBe(after);
    expect(
      apply(after, {
        type: "moveProject",
        id: "d",
        groupId: null,
        anchor: "d",
      }),
    ).toBe(after);
    expect(
      apply(after, {
        type: "moveProject",
        id: "d",
        groupId: null,
        anchor: "b",
      }),
    ).toBe(after);
  });
  it("moves groups and dissolves a group by appending members in their order", () => {
    expect(
      apply(original, {
        type: "moveGroup",
        id: "h",
        anchor: "g",
        side: "before",
      }).groups.map((g) => g.id),
    ).toEqual(["h", "g"]);
    expect(apply(original, { type: "dissolveGroup", id: "g" })).toEqual({
      ...original,
      groups: [original.groups[1]],
      ungroupedProjectIds: ["c", "d", "a", "b"],
    });
  });
  it("validates Unicode names, trim, duplicates and stable IDs", () => {
    expect(() =>
      apply(original, { type: "renameGroup", id: "h", name: "  рАБота " }),
    ).toThrow("уже есть");
    expect(() =>
      apply(original, { type: "createGroup", id: "new", name: "\0" }),
    ).toThrow();
    expect(() =>
      apply(original, { type: "createGroup", id: "new", name: "x".repeat(41) }),
    ).toThrow();
    const n = apply(original, {
      type: "createGroup",
      id: "new",
      name: " Новая ",
    });
    expect(n.groups.at(-1)).toEqual({
      id: "new",
      name: "Новая",
      collapsed: false,
      projectIds: [],
    });
    expect(
      apply(n, { type: "setCollapsed", id: "new", collapsed: true }).groups.at(
        -1,
      )?.collapsed,
    ).toBe(true);
  });
});
