// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest";
import {
  readCatalogCache,
  writeCatalogCache,
  readWorkspaceSelection,
  writeWorkspaceSelection,
} from "../src/renderer/topic-display-cache";
const project = { id: "p", name: "P", path: "/fixture/p" };
const owner = {
  projectId: "p",
  year: "2026",
  topic: "alpha",
  branch: "alpha",
  contextId: `ctx-${"a".repeat(64)}`,
  revision: "00000000-0000-4000-8000-000000000001",
  repositoryKey: "b".repeat(64),
  projectPath: project.path,
  gitCommonDir: "/fixture/copy/.git",
  path: "/fixture/copy",
  ownership: "managed",
  storageKind: "clone",
  state: "ready",
} as const;
beforeEach(() => localStorage.clear());
it("stores only catalog identities and isolates project path and year", () => {
  const catalog = {
    projectId: "p",
    year: "2026",
    entries: [
      { topic: "alpha", branch: "alpha", remote: false, todo: "not cached" },
    ],
    currentTopic: null,
  };
  writeCatalogCache(project, catalog);
  expect(readCatalogCache(project, "2026")?.entries).toEqual([
    { topic: "alpha", branch: "alpha", remote: false },
  ]);
  expect(readCatalogCache({ ...project, path: "/other" }, "2026")).toBeNull();
  expect(readCatalogCache(project, "2025")).toBeNull();
  expect(JSON.stringify(localStorage)).not.toContain("not cached");
});
it("rejects foreign and corrupt catalog instead of granting cached authority", () => {
  writeCatalogCache(project, {
    projectId: "q",
    year: "2026",
    entries: [],
    currentTopic: null,
  });
  expect(readCatalogCache(project, "2026")).toBeNull();
  writeCatalogCache(project, {
    projectId: project.id,
    year: "2026",
    entries: [],
    currentTopic: null,
  });
  expect(localStorage.length).toBe(1);
  for (let i = 0; i < localStorage.length; i++)
    localStorage.setItem(localStorage.key(i)!, "{broken");
  expect(readCatalogCache(project, "2026")).toBeNull();
});
it("persists exact owner as unavailable until host validates it and preserves explicit primary", () => {
  writeWorkspaceSelection(project, owner);
  expect(readWorkspaceSelection(project)).toMatchObject({
    contextId: owner.contextId,
    branch: "alpha",
    state: "conflict",
    preparation: "pending",
  });
  expect(
    readWorkspaceSelection({ ...project, path: "/other" }),
  ).toBeUndefined();
  writeWorkspaceSelection(project, null);
  expect(readWorkspaceSelection(project)).toBeNull();
});
it("never persists a foreign or unresolved owner over an existing choice", () => {
  writeWorkspaceSelection(project, owner);
  writeWorkspaceSelection(project, { ...owner, projectId: "q" });
  writeWorkspaceSelection(project, {
    ...owner,
    topic: "pending",
    preparation: "pending",
  });
  expect(readWorkspaceSelection(project)?.contextId).toBe(owner.contextId);
});
it("remembers an explicitly selected missing clone rather than restoring the previous primary", () => {
  writeWorkspaceSelection(project, null);
  writeWorkspaceSelection(project, { ...owner, state: "missing" });
  expect(readWorkspaceSelection(project)).toMatchObject({
    contextId: owner.contextId,
    state: "conflict",
    preparation: "pending",
  });
});
it("persists a missing history-only reference without requiring unavailable runtime paths", () => {
  writeWorkspaceSelection(project, null);
  writeWorkspaceSelection(project, {
    ...owner,
    state: "missing",
    projectPath: "",
    gitCommonDir: "",
    repositoryKey: "",
    path: "",
  });
  expect(readWorkspaceSelection(project)).toMatchObject({
    projectId: project.id,
    projectPath: project.path,
    contextId: owner.contextId,
    revision: owner.revision,
    state: "conflict",
    preparation: "pending",
  });
});
