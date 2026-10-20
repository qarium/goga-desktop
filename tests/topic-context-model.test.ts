import { describe, expect, it } from "vitest";
import type { Run } from "../src/shared/types";
import {
  contextKey,
  contextRunActivity,
  createTopicContextState,
  draftKey,
  relativeRunPlanPath,
  runsForContext,
  topicContextReducer,
  type RunWithContext,
  type TopicContextIdentity,
} from "../src/renderer/topic-context";

const a: TopicContextIdentity = {
  projectId: "project-a",
  repositoryKey: "repo-a",
  revision: "202649d6-9194-4ec2-96c5-f814f2fa4586",
  year: "2026",
  topic: "feature",
  branch: "feature",
  contextId: "copy-a",
};
const b: TopicContextIdentity = {
  ...a,
  topic: "other",
  branch: "other",
  contextId: "copy-b",
};
function run(
  id: string,
  context: TopicContextIdentity = a,
  overrides: Partial<RunWithContext> = {},
): RunWithContext {
  return {
    id,
    projectId: context.projectId,
    pipeline: "develop",
    topic: context.topic,
    branch: context.branch,
    status: "exited",
    startedAt: "2026-10-19T12:00:00Z",
    workflow: null,
    profile: null,
    context,
    ...overrides,
  };
}

describe("context identity and scoped runs", () => {
  it("keeps project, year, topic, branch and canonical copy identity in its key", () => {
    for (const changed of [
      { projectId: "project-b" },
      { year: "2025" },
      { topic: "feature:2026" },
      { branch: "another-branch" },
      { contextId: "copy-b" },
    ])
      expect(contextKey({ ...a, ...changed })).not.toBe(contextKey(a));
    expect(contextKey({ ...a, topic: "x:y", branch: "z" })).not.toBe(
      contextKey({ ...a, topic: "x", branch: "y:z" }),
    );
  });
  it("does not change draft or history identity with optional record metadata or revision", () => {
    const ref = { ...a };
    delete ref.path;
    delete ref.repositoryKey;
    expect(contextKey(ref)).toBe(
      contextKey({ ...a, path: "/copies/a", revision: "new-revision" }),
    );
    expect(
      runsForContext([run("ref-only", ref)], { ...a, path: "/copies/a" }).map(
        (r) => r.id,
      ),
    ).toEqual(["ref-only"]);
  });
  it("includes only fully matching contexts, never assigning legacy records to the selection", () => {
    const legacy: Run = { ...run("legacy"), context: undefined } as Run;
    expect(
      runsForContext(
        [
          run("a"),
          run("b", b),
          run("old-year", { ...a, year: "2025" }),
          run("other-project", { ...a, projectId: "project-b" }),
          legacy,
          run("wrong-owner", a, { projectId: "other-project" }),
        ],
        a,
      ).map((r) => r.id),
    ).toEqual(["a"]);
    expect(runsForContext([run("a")], null)).toEqual([]);
  });
  it("counts starting and running in the selected copy only", () => {
    expect(
      contextRunActivity(
        [
          run("starting", a, { status: "starting" }),
          run("build", a, { kind: "build", status: "running" }),
          run("finished-build", a, { kind: "build", status: "failed" }),
          run("other", b, { status: "running" }),
        ],
        a,
      ),
    ).toMatchObject({
      activeCount: 2,
      activeBuild: { id: "build" },
      activePipeline: { id: "starting" },
    });
  });
  it("retains real relative build paths and never fabricates a missing plan", () => {
    expect(relativeRunPlanPath("./docs/plan-a.md")).toBe("docs/plan-a.md");
    expect(relativeRunPlanPath("/copies/a/docs/plan-a.md", "/copies/a")).toBe(
      "docs/plan-a.md",
    );
    expect(
      relativeRunPlanPath("/copies/ab/docs/plan.md", "/copies/a"),
    ).toBeNull();
    expect(relativeRunPlanPath("/unavailable/plan.md")).toBeNull();
    expect(relativeRunPlanPath(undefined)).toBeNull();
  });
});

describe("explicit topic context navigation", () => {
  it("changes A to B without selecting any run and keeps explicitly open tabs", () => {
    let state = createTopicContextState(a);
    state = topicContextReducer(state, { type: "open-run", run: run("a") });
    state = topicContextReducer(state, { type: "select-context", context: b });
    expect(state.selection).toEqual(b);
    expect(state.viewedRunId).toBeNull();
    expect(state.openRunIds).toEqual(["a"]);
    expect(state.viewedDraftKey).toBeNull();
  });
  it("opens a concrete run once and synchronizes its owning context", () => {
    let state = createTopicContextState(a);
    state = topicContextReducer(state, { type: "open-run", run: run("b", b) });
    state = topicContextReducer(state, { type: "open-run", run: run("b", b) });
    expect(state.selection).toEqual(b);
    expect(state.viewedRunId).toBe("b");
    expect(state.openRunIds).toEqual(["b"]);
  });
  it("opens legacy history without claiming that it belongs to the current context", () => {
    const state = topicContextReducer(createTopicContextState(a), {
      type: "open-run",
      run: { ...run("legacy"), context: undefined },
    });
    expect(state.selection).toBeNull();
    expect(state.viewedRunId).toBe("legacy");
    expect(state.openRunIds).toEqual(["legacy"]);
  });
  it("closes only the requested tab without selecting another run or stopping it", () => {
    const original = run("a", a, { status: "running" });
    let state = topicContextReducer(createTopicContextState(a), {
      type: "open-run",
      run: original,
    });
    state = topicContextReducer(state, { type: "open-run", run: run("b", b) });
    state = topicContextReducer(state, { type: "close-run", runId: "a" });
    expect(state.viewedRunId).toBe("b");
    state = topicContextReducer(state, { type: "close-run", runId: "b" });
    expect(state.openRunIds).toEqual([]);
    expect(state.viewedRunId).toBeNull();
    expect(original.status).toBe("running");
  });
  it("stores independent drafts per context and kind and restores their context", () => {
    let state = createTopicContextState(a);
    state = topicContextReducer(state, {
      type: "open-draft",
      context: a,
      kind: "pipeline",
    });
    const aPipeline = draftKey(a, "pipeline");
    state = topicContextReducer(state, {
      type: "update-draft",
      key: aPipeline,
      value: { task: "Task A", clean: true },
    });
    state = topicContextReducer(state, {
      type: "open-draft",
      context: a,
      kind: "build",
    });
    state = topicContextReducer(state, {
      type: "update-draft",
      key: draftKey(a, "build"),
      value: { planPath: "docs/a.md" },
    });
    state = topicContextReducer(state, {
      type: "open-draft",
      context: b,
      kind: "pipeline",
    });
    expect(state.drafts[draftKey(b, "pipeline")].value).toEqual({});
    state = topicContextReducer(state, {
      type: "open-draft",
      context: a,
      kind: "pipeline",
    });
    expect(state.selection).toEqual(a);
    expect(state.viewedDraftKey).toBe(aPipeline);
    expect(state.viewedRunId).toBeNull();
    expect(state.drafts[aPipeline].value).toEqual({
      task: "Task A",
      clean: true,
    });
    expect(state.drafts[draftKey(a, "build")].value).toEqual({
      planPath: "docs/a.md",
    });
  });
  it("explicit draft close only removes that preparation and preserves the other drafts", () => {
    let state = topicContextReducer(createTopicContextState(a), {
      type: "open-draft",
      context: a,
      kind: "pipeline",
    });
    state = topicContextReducer(state, {
      type: "open-draft",
      context: b,
      kind: "build",
    });
    state = topicContextReducer(state, {
      type: "close-draft",
      key: draftKey(a, "pipeline"),
    });
    expect(state.viewedDraftKey).toBe(draftKey(b, "build"));
    expect(Object.keys(state.drafts)).toEqual([draftKey(b, "build")]);
    state = topicContextReducer(state, {
      type: "close-draft",
      key: draftKey(b, "build"),
    });
    expect(state.viewedDraftKey).toBeNull();
    expect(state.selection).toEqual(b);
  });
  it("ignores updates for missing drafts rather than recreating closed preparation", () => {
    const state = createTopicContextState(a);
    expect(
      topicContextReducer(state, {
        type: "update-draft",
        key: draftKey(a, "pipeline"),
        value: { task: "late" },
      }),
    ).toBe(state);
  });
});
