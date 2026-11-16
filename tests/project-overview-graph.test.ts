import { expect, it } from "vitest";
import {
  makeOverviewGraph,
  prepareOverviewGraph,
  ownerForPath,
} from "../src/renderer/overview/graph";
import type { SchemaCell } from "../src/shared/project-architecture";
const cell = (
  cell: string,
  children: SchemaCell[] = [],
  deps: string[] = [],
): SchemaCell => ({
  cell,
  description: "very long description\n".repeat(100),
  types: [],
  usages: [],
  children,
  dependencies: Object.fromEntries(
    deps.map((d) => [d, { types: [], usages: [] }]),
  ),
});
const schema = [
  cell("src", [
    cell("src/a", [cell("src/a/deep")], ["src/b"]),
    cell("src/b", [], ["../outside"]),
  ]),
  cell("tools", [], ["src/a"]),
];
it("retains incoming and outgoing relationships when drilling without inventing parents", () => {
  const g = makeOverviewGraph(schema, "src/a", "src/a/deep");
  expect(
    g.edges.some((e) => e.source === "tools" && e.target === "scope::src/a"),
  ).toBe(true);
  expect(
    g.edges.some((e) => e.source === "scope::src/a" && e.target === "src/b"),
  ).toBe(true);
  expect(g.nodes.some((n) => n.id === "src/a/deep")).toBe(true);
  expect(
    g.edges.some((e) => e.source === "src/a" && e.target === "src/a/deep"),
  ).toBe(false);
});
it("finds the closest folder owner and never conflates similar names", () => {
  expect(ownerForPath(schema, "src/a/deep/file.ts")).toBe("src/a/deep");
  expect(ownerForPath(schema, "src/abc/file.ts")).toBe("src");
  expect(ownerForPath(schema, "elsewhere")).toBe(null);
});
it("keeps paths and safe external nodes without putting prose in graph labels", () => {
  const g = makeOverviewGraph(schema, "src");
  expect(g.nodes.find((n) => n.id === "src/a")?.data.name).toBe("a");
  expect(g.nodes.every((n) => !Object.hasOwn(n.data, "description"))).toBe(
    true,
  );
  expect(g.nodes.find((n) => n.id === "../outside")?.data.navigable).toBe(
    false,
  );
  for (const node of g.nodes)
    expect(Number.isFinite(node.position.x + node.position.y)).toBe(true);
});
it("keeps project-level external and parent-to-child incoming dependencies", () => {
  const g = makeOverviewGraph(
    [cell("src", [], ["../outside"]), cell("tools")],
    "@project",
  );
  expect(
    g.edges.some((e) => e.source === "src" && e.target === "../outside"),
  ).toBe(true);
  const nested = makeOverviewGraph(
    [cell("src", [cell("src/a")], ["src/a"])],
    "src/a",
  );
  expect(
    nested.edges.some((e) => e.source === "src" && e.target === "src/a"),
  ).toBe(true);
});

it("projects selection without relaying out or replacing unaffected nodes and edges", () => {
  const prepared = prepareOverviewGraph(
    [
      cell("a", [], ["b"]),
      cell("b", [], ["c"]),
      cell("c"),
      cell("d", [], ["../unknown"]),
    ],
    "@project",
  );
  const base = prepared.select(null);
  const a = prepared.select("a"),
    b = prepared.select("b");
  expect(prepared.select("not-a-node")).toBe(base);
  const node = (g: typeof base, id: string) =>
    g.nodes.find((n) => n.id === id)!;
  const edge = (g: typeof base, id: string) =>
    g.edges.find((e) => e.id === id)!;
  expect(node(a, "a").data.selected).toBe(true);
  expect(node(a, "a").position).toBe(node(base, "a").position);
  expect(node(b, "a")).toBe(node(base, "a"));
  expect(node(a, "d")).toBe(node(b, "d"));
  expect(edge(a, "a→b")).toBe(edge(b, "a→b"));
  expect(edge(a, "b→c")).toBe(edge(base, "b→c"));
  expect(edge(b, "b→c").className).toBe("ov-edge-selected");
  expect(edge(a, "d→../unknown")).toBe(edge(b, "d→../unknown"));
  expect(edge(base, "a→b").className).toBe("");
});
it("preserves selection and highlighted arrows of scope groups and dashed external links", () => {
  const prepared = prepareOverviewGraph(schema, "src/a");
  const base = prepared.select(null),
    selected = prepared.select("src/a");
  expect(
    selected.nodes.find((n) => n.id === "scope::src/a")?.data.selected,
  ).toBe(true);
  for (const e of selected.edges.filter(
    (e) => e.source === "scope::src/a" || e.target === "scope::src/a",
  )) {
    expect(e.className).toBe("ov-edge-selected");
    expect(e.style?.strokeDasharray).toBe(
      base.edges.find((x) => x.id === e.id)?.style?.strokeDasharray,
    );
    expect(e.markerEnd).toMatchObject({ color: "#7ce4cc" });
  }
});
