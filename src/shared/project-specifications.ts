import { t as tr } from "./i18n";
import { z } from "zod";
import { isOverviewPath } from "./project-overview";
export const SPECIFICATIONS_ROOT = ".goga/usages";
export const SPECIFICATIONS_MAX_ENTRIES = 10_000;
export const specificationPathSchema = z
  .string()
  .refine(
    (p) =>
      isOverviewPath(p) &&
      isOverviewPath(`${SPECIFICATIONS_ROOT}/${p}`) &&
      /\.md$/i.test(p),
    { error: () => tr("host.invalidUsagesMarkdownFilePath") },
  );
export interface SpecificationCatalog {
  exists: boolean;
  paths: string[];
  skippedUnsupported: number;
}
export interface SpecificationDocument {
  path: string;
  exists: boolean;
  text: string;
}
