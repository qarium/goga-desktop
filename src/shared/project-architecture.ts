import { z } from "zod";

export interface SchemaDependency {
  types: string[];
  usages: string[];
}
export interface SchemaCell extends SchemaDependency {
  cell: string;
  description: string;
  dependencies: Record<string, SchemaDependency>;
  children: SchemaCell[];
}
export interface ContractPair {
  codemanifest: string | null;
  implementation: string | null;
}
export interface TypeContract {
  signature?: ContractPair;
  properties?: Record<string, ContractPair>;
  methods?: Record<string, ContractPair>;
}
export type CellContract = Record<string, TypeContract>;
export interface ArchitectureEdge extends SchemaDependency {
  source: string;
  target: string;
  navigable: boolean;
}
export interface ArchitectureIndex {
  roots: string[];
  cells: Record<string, SchemaCell>;
  parents: Record<string, string | null>;
  edges: ArchitectureEdge[];
}
export const OVERVIEW_ARCHITECTURE_LIMITS = {
  outputBytes: 8 * 1024 * 1024,
  cells: 10000,
  depth: 64,
  pathLength: 4096,
  entries: 10000,
  stringLength: 1024 * 1024,
} as const;
/** A schema path is display data, never filesystem authority. Host rechecks it. */
export function isNavigableArchitecturePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > OVERVIEW_ARCHITECTURE_LIMITS.pathLength ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    value.startsWith("/") ||
    /^[a-z]:/i.test(value)
  )
    return false;
  return (
    value === "." ||
    value
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          part.toLowerCase() !== ".git",
      )
  );
}

const name = z.string().min(1).max(OVERVIEW_ARCHITECTURE_LIMITS.pathLength);
const rawString = z.string().max(OVERVIEW_ARCHITECTURE_LIMITS.stringLength);
const pathLabel = name.refine((value) => !/[\x00-\x1f\x7f]/.test(value));
const localCell = pathLabel.refine(isNavigableArchitecturePath);

/** Unlike z.record, preserve literal '__proto__' keys as inert own data. */
function boundedRecord<S extends z.ZodType>(key: z.ZodType<string>, value: S) {
  return z.preprocess(
    (input) =>
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? Object.entries(input)
        : undefined,
    z
      .array(z.tuple([key, value]))
      .max(OVERVIEW_ARCHITECTURE_LIMITS.entries)
      .transform((entries): Record<string, z.infer<S>> =>
        Object.assign(Object.create(null), Object.fromEntries(entries)),
      ),
  );
}

const names = z.array(name).max(OVERVIEW_ARCHITECTURE_LIMITS.entries);
const dependencySchema = z.object({ types: names, usages: names });
const cellSchema: z.ZodType<SchemaCell> = z.lazy(() =>
  z.object({
    cell: localCell,
    description: rawString,
    types: names,
    usages: names,
    dependencies: boundedRecord(pathLabel, dependencySchema),
    children: z.array(cellSchema).max(OVERVIEW_ARCHITECTURE_LIMITS.cells),
  }),
);

/** The public CLI's tree, without private CODEMANIFEST or language parsing. */
export const overviewSchemaSchema = z
  .array(cellSchema)
  .max(OVERVIEW_ARCHITECTURE_LIMITS.cells);
const pairSchema = z.object({
  codemanifest: rawString.nullable(),
  implementation: rawString.nullable(),
});
const typeSchema = z.object({
  signature: pairSchema.optional(),
  properties: boundedRecord(name, pairSchema).optional(),
  methods: boundedRecord(name, pairSchema).optional(),
});
export const cellContractSchema = boundedRecord(name, typeSchema);
/** goga contract wraps comparisons in the normalized cell path. */
export const overviewContractSchema = boundedRecord(
  localCell,
  cellContractSchema,
);

/** Iterative preflight prevents recursive Zod validation from overflowing. */
export function assertOverviewSchemaBounds(value: unknown): void {
  if (!Array.isArray(value)) return; // Zod supplies the shape error.
  if (value.length > OVERVIEW_ARCHITECTURE_LIMITS.cells)
    throw Error("Схема превышает лимит количества узлов.");
  const pending = value.map((node) => ({ node, depth: 1 }));
  const paths = new Set<string>();
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > OVERVIEW_ARCHITECTURE_LIMITS.cells)
      throw Error("Схема превышает лимит количества узлов.");
    if (depth > OVERVIEW_ARCHITECTURE_LIMITS.depth)
      throw Error("Схема превышает лимит глубины.");
    if (node === null || typeof node !== "object" || Array.isArray(node))
      continue;
    if (typeof node.cell === "string") {
      if (paths.has(node.cell))
        throw Error("Схема содержит повторяющийся путь.");
      paths.add(node.cell);
    }
    if (Array.isArray(node.children)) {
      if (
        count + pending.length + node.children.length >
        OVERVIEW_ARCHITECTURE_LIMITS.cells
      )
        throw Error("Схема превышает лимит количества узлов.");
      for (const child of node.children)
        pending.push({ node: child, depth: depth + 1 });
    }
  }
}

/** One flat, serializable index; dependency cycles are edges, not recursion. */
export function buildArchitectureIndex(
  schema: SchemaCell[],
): ArchitectureIndex {
  assertOverviewSchemaBounds(schema);
  const cells: ArchitectureIndex["cells"] = Object.create(null);
  const parents: ArchitectureIndex["parents"] = Object.create(null);
  const pending = schema
    .slice()
    .reverse()
    .map((node) => ({ node, parent: null as string | null }));
  while (pending.length) {
    const { node, parent } = pending.pop()!;
    cells[node.cell] = node;
    parents[node.cell] = parent;
    for (let index = node.children.length - 1; index >= 0; index--)
      pending.push({ node: node.children[index], parent: node.cell });
  }
  const edges: ArchitectureEdge[] = [];
  for (const node of Object.values(cells))
    for (const [target, dependency] of Object.entries(node.dependencies))
      edges.push({
        source: node.cell,
        target,
        types: dependency.types,
        usages: dependency.usages,
        navigable:
          isNavigableArchitecturePath(target) && Object.hasOwn(cells, target),
      });
  return { roots: schema.map((node) => node.cell), cells, parents, edges };
}
