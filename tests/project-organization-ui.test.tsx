// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useProjectOrganization } from "../src/renderer/useProjectOrganization";
import { organizationKey } from "../src/renderer/project-organization-preferences";
const saved = {
  schemaVersion: 1,
  groups: [
    { id: "g", name: "Работа", collapsed: true, projectIds: ["a", "b"] },
  ],
  ungroupedProjectIds: [],
};
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("honors a late merged catalog without turning pending [] into removals", () => {
  localStorage.setItem(organizationKey, JSON.stringify(saved));
  const writes = vi.spyOn(Storage.prototype, "setItem");
  const view = renderHook(
    ({ ids, ready }: { ids: string[]; ready: boolean }) =>
      useProjectOrganization(
        ids.map((id) => ({ id })),
        ready,
      ),
    { initialProps: { ids: [] as string[], ready: false } },
  );
  view.rerender({ ids: ["c"], ready: false });
  expect(view.result.current.organization.groups[0].projectIds).toEqual([
    "a",
    "b",
  ]);
  expect(writes).not.toHaveBeenCalled();
  view.rerender({ ids: ["b", "c"], ready: true });
  expect(view.result.current.organization.groups[0].projectIds).toEqual(["b"]);
  expect(view.result.current.organization.ungroupedProjectIds).toEqual(["c"]);
  expect(writes).toHaveBeenCalledTimes(1);
  view.rerender({ ids: ["b", "c", "a"], ready: true });
  expect(view.result.current.organization.ungroupedProjectIds).toEqual([
    "c",
    "a",
  ]);
});
it("reads the current preference on a storage event, not a stale event payload", () => {
  const view = renderHook(() =>
    useProjectOrganization([{ id: "a" }, { id: "b" }], true),
  );
  localStorage.setItem(organizationKey, JSON.stringify(saved));
  act(() => {
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: organizationKey,
        newValue: "stale event",
      }),
    );
  });
  expect(view.result.current.organization.groups[0]).toEqual(saved.groups[0]);
  expect(view.result.current.issue).toBeNull();
});
