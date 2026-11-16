import { it, expect } from "vitest";
import {
  projectCreationRequestSchema,
  projectFolderName,
  repositoryFolderName,
} from "../src/shared/project-creation";
const base = {
  id: "attempt-1",
  mode: "empty",
  parent: "/tmp/projects",
  name: "new-project",
  git: true,
};
it("accepts separate empty and clone requests without extra authority", () => {
  expect(projectCreationRequestSchema.parse(base)).toEqual(base);
  for (const repository of [
    "https://example.com/t/project.git",
    "git@example.com:t/project.git",
    "ssh://git@example.com/t/project.git",
  ]) {
    expect(
      projectCreationRequestSchema.safeParse({
        id: "attempt-2",
        mode: "clone",
        parent: "/tmp",
        name: "project",
        repository,
      }).success,
    ).toBe(true);
    expect(repositoryFolderName(repository)).toBe("project");
  }
  for (const extra of [
    { force: true },
    { command: "rm" },
    { args: ["x"] },
    { git: "true" },
  ])
    expect(
      projectCreationRequestSchema.safeParse({ ...base, ...extra }).success,
    ).toBe(false);
});
it("rejects path traversal, option-like names, controls and ambiguous names", () => {
  for (const name of [
    "",
    "..",
    ".",
    "../outside",
    "a/b",
    "a\\b",
    "-bad",
    "bad ",
    " bad",
    "a\n",
    "a\0",
  ])
    expect(projectFolderName.safeParse(name).success, name).toBe(false);
  expect(projectFolderName.safeParse("проект один").success).toBe(true);
});
it("rejects embedded credentials, unsupported transports and query secrets", () => {
  for (const repository of [
    "https://user:secret@example.com/r",
    "https://user@example.com/r",
    "https://example.com/r?token=x",
    "https://example.com/r#x",
    "file:///tmp/r",
    "ext::command",
    "-oFoo",
    "git://example.com/r",
    "http://example.com/r",
    "ssh://git:secret@example.com/r",
  ])
    expect(
      projectCreationRequestSchema.safeParse({
        id: "one",
        mode: "clone",
        parent: "/tmp",
        name: "copy",
        repository,
      }).success,
      repository,
    ).toBe(false);
});
