import { vi } from "vitest";
export const specificationProject = {
  id: "p",
  name: "Fixture",
  path: "/fixture",
};
export const specificationFiles = {
  "README.md":
    "# Спецификации\n\n[Вложенный документ](api/usage.md)\n\n[Нет файла](missing.md)\n\n[Снаружи](../outside.md)",
  "api/usage.md": "# API usage\n\n[Назад](../README.md)",
  "other/usage.md": "# Other usage",
  "blank.md": "",
};
export function specificationAPI(
  files: Record<string, string> = { ...specificationFiles },
) {
  return {
    listProjectSpecifications: vi.fn(async (_scope: unknown) => ({
      exists: true,
      paths: Object.keys(files),
      skippedUnsupported: 0,
    })),
    readProjectSpecification: vi.fn(async (_scope: unknown, p: string) => ({
      path: p,
      exists: Object.hasOwn(files, p),
      text: files[p] ?? "",
    })),
  };
}
