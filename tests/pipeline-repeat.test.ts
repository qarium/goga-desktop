import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  capturePipelineRepeat,
  pipelineRepeatSnapshotSchema,
} from "../src/shared/pipeline-repeat";
import { ContextRunsStore } from "../src/host/context-runs-store";
import type { Run } from "../src/shared/types";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const options = {
  workflow: "file:quality",
  profile: "fast",
  profileMode: "project" as const,
  skips: ["review"],
  clean: true,
  update: true,
};
const run = (): Run => ({
  id: "r",
  projectId: "p",
  pipeline: "editor",
  topic: "",
  branch: "main",
  status: "failed",
  workflow: "quality",
  profile: "fast",
  startedAt: "2026-11-08T00:00:00.000Z",
  pipelineRepeat: capturePipelineRepeat(options),
});
describe("pipeline repeat snapshot", () => {
  it("captures only detached non-secret launch choices", () => {
    const input = {
      ...options,
      skips: [...options.skips],
      task: "private task",
      previewToken: "expired",
      taskVersion: "expired",
      env: [{ key: "TOKEN", value: "secret" }],
    };
    const snapshot = capturePipelineRepeat(input);
    input.skips.push("work");
    expect(snapshot).toEqual({ version: 1, ...options });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private|expired|secret|TOKEN/,
    );
  });
  it("rejects unknown fields and malformed or inconsistent choices", () => {
    const snapshot = capturePipelineRepeat(options);
    for (const bad of [
      { ...snapshot, env: [] },
      { ...snapshot, task: "private" },
      { ...snapshot, version: 2 },
      { ...snapshot, skips: ["--unsafe"] },
      { ...snapshot, workflow: "../escape" },
      { ...snapshot, profileMode: "auto" },
      { ...snapshot, clean: "true" },
    ])
      expect(pipelineRepeatSnapshotSchema.safeParse(bad).success).toBe(false);
    expect(
      pipelineRepeatSnapshotSchema.parse({
        ...snapshot,
        profile: "",
        profileMode: "auto",
      }),
    ).toMatchObject({ profile: "", profileMode: "auto" });
  });
  it("persists the snapshot across reopening and binds it immutably to history", async () => {
    const home = await mkdtemp("/private/tmp/goga-repeat-store-");
    roots.push(home);
    const store = new ContextRunsStore(home);
    await store.save([run()]);
    const reopened = new ContextRunsStore(home);
    expect((await reopened.load())[0].pipelineRepeat).toEqual(
      run().pipelineRepeat,
    );
    await expect(
      reopened.save([
        {
          ...run(),
          pipelineRepeat: { ...run().pipelineRepeat!, clean: false },
        },
      ]),
    ).rejects.toThrow(/измен|контекст|владел/);
    const bytes = await readFile(
      path.join(home, ".goga/desktop/context-runs.json"),
      "utf8",
    );
    expect(bytes).not.toContain("previewToken");
  });
  it("retains legacy history without inventing repeat defaults", async () => {
    const home = await mkdtemp("/private/tmp/goga-repeat-legacy-");
    roots.push(home);
    await mkdir(path.join(home, "empty"));
    const { pipelineRepeat: _, ...legacy } = run();
    await new ContextRunsStore(home).save([legacy]);
    expect(
      (await new ContextRunsStore(home).load())[0].pipelineRepeat,
    ).toBeUndefined();
  });
});
