import { expect, it } from "vitest";
import {
  SPECIFICATIONS_ROOT,
  SPECIFICATIONS_MAX_ENTRIES,
  specificationPathSchema,
} from "../src/shared/project-specifications";
it.each([
  "README.md",
  "nested/usage.MD",
  "раздел/Мой файл.md",
  `${"a/".repeat(100)}x.md`,
])("accepts Markdown path %s without a depth cap", (p) => {
  expect(specificationPathSchema.parse(p)).toBe(p);
});
it.each([
  "",
  "../secret.md",
  "/tmp/x.md",
  "C:/x.md",
  "a/../x.md",
  "./x.md",
  "a//x.md",
  "a\\x.md",
  "a/\0x.md",
  ".git/x.md",
  "x.yml",
  "x.markdown",
  `${"a".repeat(4090)}.md`,
])("rejects unsafe or unsupported path %s", (p) => {
  expect(specificationPathSchema.safeParse(p).success).toBe(false);
});
it("has a fixed host root and a volume, not depth, budget", () => {
  expect(SPECIFICATIONS_ROOT).toBe(".goga/usages");
  expect(SPECIFICATIONS_MAX_ENTRIES).toBe(10000);
});
