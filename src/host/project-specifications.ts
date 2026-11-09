import path from "node:path";
import { opendir } from "node:fs/promises";
import { isOverviewPath } from "../shared/project-overview";
import {
  SPECIFICATIONS_ROOT,
  SPECIFICATIONS_MAX_ENTRIES,
  specificationPathSchema,
  type SpecificationCatalog,
  type SpecificationDocument,
} from "../shared/project-specifications";
import {
  sourceDirectories,
  verifySourceDirectories,
  readSourceFile,
} from "./project-documents";
import { assertReadActive } from "./read-scope";

/** A working-tree reader, not History's year/branch snapshot or a write admission. */
export async function listProjectSpecifications(
  root: string,
): Promise<SpecificationCatalog> {
  assertReadActive();
  const start = await sourceDirectories(root, SPECIFICATIONS_ROOT, true);
  await verifySourceDirectories(start.identities);
  assertReadActive();
  if (start.missing) return { exists: false, paths: [], skippedUnsupported: 0 };
  type Identity = (typeof start.identities)[number];
  const identities = new Map<string, Identity>();
  const remember = (items: Identity[]) => {
    for (const item of items)
      if (!identities.has(item.path)) identities.set(item.path, item);
  };
  remember(start.identities);
  const pending = [SPECIFICATIONS_ROOT],
    paths: string[] = [];
  let visited = 0,
    skippedUnsupported = 0;
  while (pending.length) {
    assertReadActive();
    const relative = pending.pop()!;
    const before = await sourceDirectories(root, relative);
    remember(before.identities);
    const directory = await opendir(path.join(root, relative));
    for await (const entry of directory) {
      assertReadActive();
      if (++visited > SPECIFICATIONS_MAX_ENTRIES)
        throw Error(
          "Слишком много файлов в .goga/usages для одного чтения. Уменьшите объём каталога и повторите загрузку.",
        );
      const child = `${relative}/${entry.name}`;
      if (!isOverviewPath(child) || entry.isSymbolicLink()) {
        skippedUnsupported++;
        continue;
      }
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) {
        if (/\.md$/i.test(entry.name))
          paths.push(child.slice(SPECIFICATIONS_ROOT.length + 1));
      } else skippedUnsupported++;
    }
    await verifySourceDirectories(before.identities);
  }
  // Keep the first identity of every ancestor: later visits must not overwrite
  // evidence of a directory replacement that happened during traversal.
  await verifySourceDirectories([...identities.values()]);
  assertReadActive();
  paths.sort();
  return { exists: true, paths, skippedUnsupported };
}

export async function readProjectSpecification(
  root: string,
  relative: string,
): Promise<SpecificationDocument> {
  const selected = specificationPathSchema.parse(relative);
  const source = `${SPECIFICATIONS_ROOT}/${selected}`;
  assertReadActive();
  try {
    const document = await readSourceFile(root, source);
    assertReadActive();
    return { path: selected, exists: document.exists, text: document.text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Only absence inside this verified path is a missing document. A link,
    // non-directory or permission failure is never an empty successful read.
    const parent = await sourceDirectories(root, path.dirname(source), true);
    await verifySourceDirectories(parent.identities);
    assertReadActive();
    return { path: selected, exists: false, text: "" };
  }
}
