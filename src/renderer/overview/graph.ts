import dagre from "@dagrejs/dagre";
import { MarkerType, type Node, type Edge } from "@xyflow/react";
import {
  buildArchitectureIndex,
  type SchemaCell,
} from "../../shared/project-architecture";
export type GraphData = {
  name: string;
  cell: string;
  scope?: boolean;
  external?: boolean;
  navigable: boolean;
  selected: boolean;
  children: number;
  direction?: string;
  onContract?: (cell: string) => void;
  [key: string]: unknown;
};
export const projectScope = "@project";
export const basename = (p: string) =>
  p === "." ? "Проект" : p.split("/").at(-1) || "Проект";
export function ownerForPath(schema: SchemaCell[], p: string) {
  const cells = buildArchitectureIndex(schema).cells;
  return (
    Object.keys(cells)
      .filter((c) => c === "." || p === c || p.startsWith(c + "/"))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}
export function makeOverviewGraph(
  schema: SchemaCell[],
  scope: string,
  selected: string | null = null,
) {
  const index = buildArchitectureIndex(schema),
    parent = index.cells[scope];
  const ids = parent
    ? parent.children.length
      ? parent.children.map((c) => c.cell)
      : [scope]
    : index.roots;
  const group = !!parent?.children.length,
    container = "scope::" + scope,
    central = new Set(ids);
  const owner = (id: string) =>
    central.has(id)
      ? id
      : ids.find((c) => id.startsWith(c + "/")) ||
        (id === scope && group ? container : null);
  const external = new Map<string, string>(),
    edgeMap = new Map<string, Edge>();
  for (const relation of index.edges) {
    const a = owner(relation.source),
      b = owner(relation.target);
    let source = a,
      target = b;
    if (a && !b) {
      external.set(relation.target, "Зависимость");
      target = relation.target;
    }
    if (b && !a) {
      external.set(relation.source, "Входящая");
      source = relation.source;
    }
    if (!source || !target || source === target) continue;
    const context = !central.has(source) || !central.has(target);
    const active =
      source === selected ||
      target === selected ||
      source === "scope::" + selected ||
      target === "scope::" + selected;
    edgeMap.set(source + "→" + target, {
      id: source + "→" + target,
      source,
      target,
      type: "smoothstep",
      className: active ? "ov-edge-selected" : "",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: active ? "#7ce4cc" : context ? "#7897b9" : "#35b9ab",
      },
      style: {
        stroke: active ? "#7ce4cc" : context ? "#7897b9" : "#35b9ab",
        strokeWidth: active ? 2.5 : 1.7,
        strokeDasharray: context ? "5 5" : undefined,
      },
    });
  }
  if (ids.length + external.size > 200)
    return {
      nodes: [] as Node<GraphData>[],
      edges: [] as Edge[],
      tooLarge: true,
    };
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 24, ranksep: 48 });
  g.setDefaultEdgeLabel(() => ({}));
  ids.forEach((id) => g.setNode(id, { width: 200, height: 80 }));
  [...edgeMap.values()]
    .filter((e) => central.has(e.source) && central.has(e.target))
    .forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  const incoming = [...external].filter(([, d]) => d === "Входящая"),
    outgoing = [...external].filter(([, d]) => d !== "Входящая");
  const gx = incoming.length ? 225 : 24,
    gy = 20,
    w = (g.graph().width || 200) + 48,
    h = Math.max((g.graph().height || 80) + 78, 180);
  const data = (id: string, extra: Partial<GraphData> = {}): GraphData => ({
    name: basename(id),
    cell: id,
    navigable: Object.hasOwn(index.cells, id),
    selected: id === selected,
    children: index.cells[id]?.children.length || 0,
    ...extra,
  });
  const nodes: Node<GraphData>[] = [];
  if (group)
    nodes.push({
      id: container,
      type: "scope",
      position: { x: gx, y: gy },
      data: data(scope, { scope: true }),
      style: { width: w, height: h },
      selectable: false,
      draggable: false,
      zIndex: -1,
    });
  ids.forEach((id) =>
    nodes.push({
      id,
      type: "cell",
      position: {
        x: g.node(id).x - 100 + (group ? 24 : gx),
        y: g.node(id).y - 40 + (group ? 56 : gy),
      },
      ...(group ? { parentId: container, extent: "parent" as const } : {}),
      data: data(id),
      draggable: false,
    }),
  );
  const add = (entries: [string, string][], left: boolean) =>
    entries.forEach(([id, direction], i) =>
      nodes.push({
        id,
        type: "cell",
        position: {
          x: left ? 0 : gx + w + 54,
          y:
            gy +
            (group ? h : g.graph().height || 80) / 2 -
            (entries.length * 108 - 20) / 2 +
            i * 108,
        },
        data: data(id, { external: true, direction }),
        draggable: false,
      }),
    );
  add(incoming, true);
  add(outgoing, false);
  return { nodes, edges: [...edgeMap.values()], tooLarge: false };
}
