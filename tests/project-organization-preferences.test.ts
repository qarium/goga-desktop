// @vitest-environment node
import { it, expect, vi } from "vitest";
import {
  createOrganizationStore,
  organizationKey,
} from "../src/renderer/project-organization-preferences";
const saved = {
  schemaVersion: 1,
  groups: [{ id: "g", name: "Работа", collapsed: true, projectIds: ["a"] }],
  ungroupedProjectIds: ["b"],
};
function fixture(initial: string | null = null) {
  let value = initial;
  const storage = {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_k: string, v: string) => {
      value = v;
    }),
  };
  return { storage, value: () => value };
}
it("reads without writing; catalog ordering is a default, not persisted on passive first read", () => {
  const f = fixture();
  const s = createOrganizationStore(() => f.storage);
  s.setCatalog(["b", "a"], true);
  expect(s.getSnapshot().organization.ungroupedProjectIds).toEqual(["b", "a"]);
  expect(f.storage.setItem).not.toHaveBeenCalled();
  s.dispatch({ type: "createGroup", id: "g", name: " Группа " });
  s.dispatch({ type: "moveProject", id: "b", groupId: "g" });
  expect(f.storage.setItem.mock.calls[0][0]).toBe(organizationKey);
  const restored = createOrganizationStore(() => f.storage);
  restored.setCatalog([], false);
  expect(restored.getSnapshot().organization.groups[0].projectIds).toEqual([
    "b",
  ]);
  restored.setCatalog(["c", "b"], true);
  expect(restored.getSnapshot().organization.ungroupedProjectIds).toEqual([
    "c",
  ]);
  expect(JSON.parse(f.value()!).ungroupedProjectIds).toEqual(["c"]);
});
it.each([
  "{",
  JSON.stringify({ ...saved, schemaVersion: 2 }),
  JSON.stringify({ ...saved, ungroupedProjectIds: ["a"] }),
])("never silently overwrites malformed/future preferences", (text) => {
  const f = fixture(text),
    s = createOrganizationStore(() => f.storage);
  s.setCatalog(["a"], true);
  expect(s.getSnapshot().issue?.kind).toBe("protected");
  s.dispatch({ type: "createGroup", id: "new", name: "Новая" });
  s.retry();
  expect(f.storage.setItem).not.toHaveBeenCalled();
  s.recover();
  expect(JSON.parse(f.value()!).groups[0].id).toBe("new");
});
it("retains session commands when saving fails and supports retry", () => {
  const f = fixture(JSON.stringify(saved)),
    s = createOrganizationStore(() => f.storage);
  s.setCatalog(["a", "b"], true);
  f.storage.setItem.mockImplementationOnce(() => {
    throw new Error("quota");
  });
  s.dispatch({ type: "dissolveGroup", id: "g" });
  expect(s.getSnapshot().issue?.kind).toBe("unsaved");
  expect(s.getSnapshot().organization.ungroupedProjectIds).toEqual(["b", "a"]);
  s.retry();
  expect(s.getSnapshot().issue).toBeNull();
  expect(JSON.parse(f.value()!).groups).toEqual([]);
});
it("reads the current storage value on external events", () => {
  const f = fixture(),
    s = createOrganizationStore(() => f.storage);
  s.setCatalog(["a", "b"], true);
  f.storage.setItem(organizationKey, JSON.stringify(saved));
  s.reload();
  expect(s.getSnapshot().organization.groups[0].projectIds).toEqual(["a"]);
  expect(f.storage.setItem).toHaveBeenCalledTimes(1);
});
