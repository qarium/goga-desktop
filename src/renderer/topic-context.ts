import type { Run } from "../shared/types";

import type { TopicContextRef, WorktreeRecord } from "../shared/worktrees";

/** The host-issued contextId already binds the canonical repository identity. */
export type TopicContextIdentity = TopicContextRef &
  Partial<Pick<WorktreeRecord, "path" | "repositoryKey">>;
export type RunKind = "pipeline" | "build";
export type RunWithContext = Run & {
  context?: TopicContextIdentity;
  pipelineName?: string;
  pipelineDescription?: string;
};
export interface ContextDraft {
  context: TopicContextIdentity;
  kind: RunKind;
  value: Record<string, unknown>;
}
export interface TopicContextState {
  selection: TopicContextIdentity | null;
  viewedRunId: string | null;
  openRunIds: string[];
  viewedDraftKey: string | null;
  drafts: Record<string, ContextDraft>;
}
export type TopicContextAction =
  | { type: "select-context"; context: TopicContextIdentity | null }
  | { type: "open-run"; run: RunWithContext }
  | { type: "close-run"; runId: string }
  | { type: "open-draft"; context: TopicContextIdentity; kind: RunKind }
  | { type: "update-draft"; key: string; value: Record<string, unknown> }
  | { type: "close-draft"; key: string };

export function contextKey(context: TopicContextIdentity): string {
  return JSON.stringify([
    context.projectId,
    context.year,
    context.topic,
    context.branch,
    context.contextId,
  ]);
}
/** Read/cache freshness is separate from stable draft/history ownership. */
export function contextRequestKey(context: TopicContextIdentity): string {
  return JSON.stringify([contextKey(context), context.revision]);
}
/** Do not forward host-owned paths through strict renderer request schemas. */
export function contextRef(context: TopicContextIdentity): TopicContextRef {
  return {
    projectId: context.projectId,
    year: context.year,
    topic: context.topic,
    branch: context.branch,
    contextId: context.contextId,
    revision: context.revision,
  };
}
export function draftKey(context: TopicContextIdentity, kind: RunKind): string {
  return JSON.stringify([contextKey(context), kind]);
}

/** Missing historical context is deliberately not inferred from topic/branch. */
function ownedContext(run: RunWithContext): TopicContextIdentity | null {
  const context = run.context;
  return context &&
    context.contextId &&
    context.year &&
    context.projectId === run.projectId &&
    context.topic === run.topic &&
    context.branch === run.branch
    ? context
    : null;
}
export function runsForContext(
  runs: RunWithContext[],
  context: TopicContextIdentity | null,
): RunWithContext[] {
  if (!context) return [];
  const key = contextKey(context);
  return runs.filter((run) => {
    const owner = ownedContext(run);
    return owner !== null && contextKey(owner) === key;
  });
}
export function isActiveRun(run: Run): boolean {
  return run.status === "starting" || run.status === "running";
}
export function contextRunActivity(
  runs: RunWithContext[],
  context: TopicContextIdentity | null,
): {
  activeCount: number;
  activeBuild?: RunWithContext;
  activePipeline?: RunWithContext;
} {
  const active = runsForContext(runs, context).filter(isActiveRun);
  return {
    activeCount: active.length,
    activeBuild: active.find((run) => run.kind === "build"),
    activePipeline: active.find((run) => run.kind !== "build"),
  };
}

/** Display only: file access and path validation remain host responsibilities. */
export function relativeRunPlanPath(
  planPath?: string,
  contextPath?: string,
): string | null {
  if (!planPath?.trim()) return null;
  let relative = planPath.replaceAll("\\", "/");
  if (/^(?:\/|[A-Za-z]:\/)/.test(relative)) {
    const root = contextPath?.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!root || !relative.startsWith(`${root}/`)) return null;
    relative = relative.slice(root.length + 1);
  }
  relative = relative.replace(/^(?:\.\/)+/, "");
  if (!relative || relative.split("/").some((part) => part === ".."))
    return null;
  return relative;
}

export function createTopicContextState(
  selection: TopicContextIdentity | null = null,
): TopicContextState {
  return {
    selection,
    viewedRunId: null,
    openRunIds: [],
    viewedDraftKey: null,
    drafts: {},
  };
}

/** Navigation never starts/stops a process or prepares a missing working copy. */
export function topicContextReducer(
  state: TopicContextState,
  action: TopicContextAction,
): TopicContextState {
  switch (action.type) {
    case "select-context":
      return {
        ...state,
        selection: action.context,
        viewedRunId: null,
        viewedDraftKey: null,
      };
    case "open-run":
      return {
        ...state,
        selection: ownedContext(action.run),
        viewedRunId: action.run.id,
        viewedDraftKey: null,
        openRunIds: state.openRunIds.includes(action.run.id)
          ? state.openRunIds
          : [...state.openRunIds, action.run.id],
      };
    case "close-run":
      return {
        ...state,
        openRunIds: state.openRunIds.filter((id) => id !== action.runId),
        viewedRunId:
          state.viewedRunId === action.runId ? null : state.viewedRunId,
      };
    case "open-draft": {
      const key = draftKey(action.context, action.kind);
      const draft = state.drafts[key] ?? {
        context: action.context,
        kind: action.kind,
        value: {},
      };
      return {
        ...state,
        selection: draft.context,
        viewedRunId: null,
        viewedDraftKey: key,
        drafts: state.drafts[key]
          ? state.drafts
          : { ...state.drafts, [key]: draft },
      };
    }
    case "update-draft": {
      const draft = state.drafts[action.key];
      if (!draft) return state;
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.key]: {
            ...draft,
            value: { ...draft.value, ...action.value },
          },
        },
      };
    }
    case "close-draft": {
      const drafts = { ...state.drafts };
      delete drafts[action.key];
      return {
        ...state,
        drafts,
        viewedDraftKey:
          state.viewedDraftKey === action.key ? null : state.viewedDraftKey,
      };
    }
  }
}
