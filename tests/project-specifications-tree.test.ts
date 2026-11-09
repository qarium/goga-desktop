import { expect, it } from "vitest";
import {
  buildTree,
  visibleRows,
  searchFiles,
  parents,
} from "../src/renderer/project-specifications-tree";
import {
  createSpecificationsState,
  specificationOwnerKey,
} from "../src/renderer/project-specifications-state";
const owner = {
  projectId: "p",
  year: "2026",
  topic: "same",
  branch: "same",
  contextId: "ctx-" + "a".repeat(64),
  revision: "r1",
};
it("includes only Markdown and its ancestors, folders first", () => {
  const tree = buildTree([
    "z.md",
    "plain.txt",
    "api/a.md",
    "archive/image.png",
    "A.MD",
    "api/a.md",
  ]);
  expect(visibleRows(tree, new Set()).map((x) => x.path)).toEqual([
    "api",
    "A.MD",
    "z.md",
  ]);
  expect(tree.files).toHaveLength(3);
  expect(tree.nodes.has("archive")).toBe(false);
});
it("represents an empty tree and empty query", () => {
  expect(buildTree(["a.txt"]).files).toEqual([]);
  expect(searchFiles(buildTree(["a.md"]), "").map((x) => x.path)).toEqual([
    "a.md",
  ]);
});
it("keeps same basename distinct and searches normalized all-word paths", () => {
  const tree = buildTree([
    "one/usage.md",
    "two/usage.md",
    "api/Авторизация.md",
    "cli/Авторизация.md",
  ]);
  expect(searchFiles(tree, "usage").map((x) => x.path)).toEqual([
    "one/usage.md",
    "two/usage.md",
  ]);
  expect(searchFiles(tree, "API автор").map((x) => x.path)).toEqual([
    "api/Авторизация.md",
  ]);
  expect(searchFiles(tree, "missing")).toEqual([]);
  expect(searchFiles(buildTree(["cafe\u0301.md"]), "café")).toHaveLength(1);
});
it("closed folder hides only its descendants", () => {
  const tree = buildTree(["a/b/spec.md", "a/root.md", "other.md"]);
  expect(visibleRows(tree, new Set(["a"])).map((x) => x.path)).toEqual([
    "a",
    "a/b",
    "a/root.md",
    "other.md",
  ]);
});
it("expands 1500 levels without recursion or truncation", () => {
  const deep =
    Array.from({ length: 1500 }, (_, i) => `d${i}`).join("/") + "/x.md";
  const rows = visibleRows(buildTree([deep]), new Set(parents(deep)));
  expect(rows).toHaveLength(1501);
  expect(rows.at(-1)).toMatchObject({ path: deep, depth: 1500 });
});
it("separates stable state ownership from request revisions", () => {
  const store = createSpecificationsState();
  const state = store.get(owner);
  store.set(owner, {
    ...state,
    selected: "a.md",
    query: "usage",
    expanded: new Set(["a"]),
  });
  expect(store.get({ ...owner, revision: "r2" }).selected).toBe("a.md");
  expect(specificationOwnerKey(owner)).toBe(
    specificationOwnerKey({ ...owner, revision: "r2" }),
  );
  for (const other of [
    "p",
    { ...owner, year: "2025" },
    { ...owner, projectId: "other" },
    { ...owner, contextId: "ctx-" + "b".repeat(64) },
  ]) {
    expect(store.get(other).selected).toBe(null);
    expect(store.get(other).expanded).not.toBe(state.expanded);
    expect(store.get(other).documentPositions).not.toBe(
      state.documentPositions,
    );
  }
});
it("disposes only removed projects and contains no file text", () => {
  const store = createSpecificationsState();
  store.set(owner, { ...store.get(owner), query: "p" });
  store.set("q", { ...store.get("q"), query: "q" });
  store.retainProjects(["q"]);
  expect(store.get(owner).query).toBe("");
  expect(store.get("q").query).toBe("q");
  expect(Object.keys(store.get("q")).sort()).toEqual(
    [
      "selected",
      "initialized",
      "query",
      "expanded",
      "treePositions",
      "documentPositions",
    ].sort(),
  );
});
