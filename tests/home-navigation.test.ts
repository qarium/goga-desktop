import { it, expect, vi } from "vitest";
import { resolveHomeOwner } from "../src/renderer/home/navigation";
const project = { id: "p", name: "P", path: "/fixture/p" };
const ref = {
  projectId: "p",
  year: "2026",
  topic: "test",
  branch: "feature",
  contextId: "ctx-" + "a".repeat(64),
  revision: "00000000-0000-4000-8000-000000000001",
};
const row = {
  ...ref,
  revision: "00000000-0000-4000-8000-000000000002",
  projectPath: project.path,
  gitCommonDir: "/g",
  path: "/clone",
  repositoryKey: "b".repeat(64),
  state: "ready" as const,
  ownership: "managed" as const,
  storageKind: "clone" as const,
};
it("refreshes only the exact owner after a stale ref and validates the new revision", async () => {
  const resolve = vi
      .fn()
      .mockRejectedValueOnce(Error("changed"))
      .mockResolvedValueOnce(row),
    list = vi.fn(async () => [row]);
  expect(
    await resolveHomeOwner(project, { kind: "topic", ref }, resolve, list),
  ).toEqual(row);
  expect(resolve.mock.calls[1][0]).toEqual({ ...ref, revision: row.revision });
});
it("never falls back to another copy or primary; primary itself needs no clone reads", async () => {
  const resolve = vi.fn(async () => {
      throw Error("missing");
    }),
    list = vi.fn(async () => [{ ...row, contextId: "ctx-" + "b".repeat(64) }]);
  expect(
    await resolveHomeOwner(
      project,
      { kind: "primary", projectId: "p" },
      resolve,
      list,
    ),
  ).toBeNull();
  expect(list).not.toHaveBeenCalled();
  await expect(
    resolveHomeOwner(project, { kind: "topic", ref }, resolve, list),
  ).rejects.toThrow();
  expect(resolve).toHaveBeenCalledTimes(1);
});
