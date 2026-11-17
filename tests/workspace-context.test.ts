import { expect, it } from "vitest";
import {
  saveLeaveFiles,
  type WorkspaceLeaveFile,
} from "../src/renderer/workspace-leave";

it("checks the whole group before writing, including the last file and overlapping editors", async () => {
  const writes: string[] = [];
  const entry = (path: string, text: string): WorkspaceLeaveFile => ({
    path,
    readText: () => text,
    save: async () => {
      writes.push(path);
    },
  });
  const a = entry("a", "one"),
    b = entry("b", "two");
  await expect(
    saveLeaveFiles([
      a,
      {
        ...b,
        preflight: async () => {
          throw Error("changed");
        },
      },
    ]),
  ).rejects.toMatchObject({ file: b, message: "changed" });
  await expect(
    saveLeaveFiles([b, a, entry("a", "other")]),
  ).rejects.toMatchObject({ file: { path: "a" } });
  expect(writes).toEqual([]);
  await saveLeaveFiles([
    a,
    {
      ...a,
      acceptSavedText: async () => {
        writes.push("accepted");
      },
    },
    b,
  ]);
  expect(writes).toEqual(["a", "accepted", "b"]);
});
import {
  matchesWorkspace,
  runMatchesWorkspace,
  workspacePath,
  workspaceLaunchBlockReason,
} from "../src/renderer/workspace-context";
const owner = {
  projectId: "p",
  year: "2026",
  topic: "a",
  branch: "a",
  contextId: "copy-a",
  revision: "r",
  path: "/Users/fixture/.goga/desktop/clones/a",
  storageKind: "clone",
  ownership: "managed",
} as any;
it("matches full stable owner identity, not names or revision", () => {
  expect(matchesWorkspace("p", owner, "p", { ...owner, revision: "new" })).toBe(
    true,
  );
  for (const changed of [
    { projectId: "q" },
    { year: "2025" },
    { topic: "other" },
    { branch: "other" },
    { contextId: "copy-b" },
  ])
    expect(matchesWorkspace("p", owner, "p", { ...owner, ...changed })).toBe(
      false,
    );
  expect(matchesWorkspace("p", undefined, "p", null)).toBe(true);
  expect(matchesWorkspace("q", undefined, "p", null)).toBe(false);
  expect(matchesWorkspace("p", owner, "p", null)).toBe(false);
});
it("does not expose malformed or ownerless runs under a clone", () => {
  const run = {
    projectId: "p",
    topic: "a",
    branch: "a",
    context: owner,
  } as any;
  expect(runMatchesWorkspace(run, "p", owner)).toBe(true);
  expect(runMatchesWorkspace({ ...run, branch: "other" }, "p", owner)).toBe(
    false,
  );
  expect(runMatchesWorkspace({ ...run, context: undefined }, "p", owner)).toBe(
    false,
  );
});
it("shows the selected owner's path without substituting the primary for a missing copy", () => {
  const project = { id: "p", name: "P", path: "/Users/fixture/project" };
  expect(workspacePath(project, null)).toEqual({
    full: project.path,
    display: project.path,
  });
  expect(workspacePath(project, owner)).toEqual({
    full: owner.path,
    display: "~/.goga/desktop/clones/a",
  });
  expect(workspacePath(project, { ...owner, path: "" }).display).toBe(
    "Путь рабочей копии недоступен",
  );
  expect(
    workspacePath(project, { ...owner, path: "/srv/custom-clone" }).display,
  ).toBe("/srv/custom-clone");
  expect(
    workspacePath(project, { ...owner, ownership: "external" }).display,
  ).toBe(owner.path);
});

it("limits builds only in the exact workspace and retains uncertain recovery protection", () => {
  const pipeline = {
    projectId: "p",
    topic: "a",
    branch: "a",
    context: owner,
    status: "running",
  } as any;
  const build = { ...pipeline, kind: "build" };
  expect(
    workspaceLaunchBlockReason([pipeline, pipeline], "p", owner, "pipeline"),
  ).toBe("");
  expect(
    workspaceLaunchBlockReason([pipeline, pipeline], "p", owner, "build"),
  ).toBe("");
  expect(
    workspaceLaunchBlockReason([pipeline, build], "p", owner, "pipeline"),
  ).toBe("");
  expect(
    workspaceLaunchBlockReason([pipeline, build], "p", owner, "build"),
  ).toMatch(/сборка/);
  expect(workspaceLaunchBlockReason([build], "p", null, "build")).toBe("");
  expect(
    workspaceLaunchBlockReason(
      [build],
      "p",
      { ...owner, year: "2025" },
      "build",
    ),
  ).toBe("");
  expect(
    workspaceLaunchBlockReason(
      [{ ...build, context: undefined }],
      "p",
      null,
      "build",
    ),
  ).toMatch(/сборка/);
  for (const kind of ["pipeline", "build"] as const)
    expect(
      workspaceLaunchBlockReason(
        [{ ...pipeline, recovery: "unverified" }],
        "p",
        owner,
        kind,
      ),
    ).toMatch(/проверьте состояние/);
});
