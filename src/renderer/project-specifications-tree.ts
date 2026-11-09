export interface SpecificationNode {
  path: string;
  name: string;
  parent: string;
  kind: "file" | "directory";
  depth: number;
}
export interface SpecificationTree {
  nodes: Map<string, SpecificationNode>;
  children: Map<string, SpecificationNode[]>;
  files: SpecificationNode[];
}
const collator = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base",
});
export function parents(path: string): string[] {
  const result: string[] = [],
    parts = path.split("/");
  let prefix = "";
  for (let i = 0; i < parts.length - 1; i++) {
    prefix += (i ? "/" : "") + parts[i];
    result.push(prefix);
  }
  return result;
}
export function buildTree(paths: string[]): SpecificationTree {
  const nodes = new Map<string, SpecificationNode>(),
    children = new Map<string, SpecificationNode[]>([["", []]]),
    files: SpecificationNode[] = [];
  for (const path of paths) {
    if (!/\.md$/i.test(path)) continue;
    const ancestors = parents(path);
    for (const [i, entry] of [...ancestors, path].entries()) {
      if (nodes.has(entry)) continue;
      const parent = i ? ancestors[i - 1]! : "",
        kind = entry === path ? "file" : "directory";
      const node: SpecificationNode = {
        path: entry,
        name: entry.slice(entry.lastIndexOf("/") + 1),
        parent,
        kind,
        depth: i,
      };
      nodes.set(entry, node);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(node);
      if (kind === "file") files.push(node);
    }
  }
  for (const siblings of children.values())
    siblings.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === "directory"
          ? -1
          : 1
        : collator.compare(a.name, b.name),
    );
  files.sort((a, b) => collator.compare(a.path, b.path));
  return { nodes, children, files };
}
export function visibleRows(
  tree: SpecificationTree,
  expanded: Set<string>,
): SpecificationNode[] {
  const stack = [...(tree.children.get("") ?? [])].reverse(),
    rows: SpecificationNode[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    rows.push(node);
    if (node.kind === "directory" && expanded.has(node.path)) {
      const children = tree.children.get(node.path) ?? [];
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }
  return rows;
}
export function searchFiles(
  tree: SpecificationTree,
  query: string,
): SpecificationNode[] {
  const words = query
    .normalize("NFC")
    .toLocaleLowerCase("ru")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return tree.files.filter((node) =>
    words.every((word) =>
      node.path.normalize("NFC").toLocaleLowerCase("ru").includes(word),
    ),
  );
}
