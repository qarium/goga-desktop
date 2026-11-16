import type { TopicContextRef } from "../../shared/worktrees";
export type WorkspaceAddress =
  | { kind: "primary"; projectId: string }
  | { kind: "topic"; ref: TopicContextRef };
export type HomeSection =
  | "overview"
  | "project-settings"
  | "terminal"
  | "topics"
  | "commits"
  | "context-runs";
export type HomeTarget =
  | { kind: "section"; owner: WorkspaceAddress; section: HomeSection }
  | { kind: "run"; owner: WorkspaceAddress; runId: string }
  | { kind: "changes"; owner: WorkspaceAddress }
  | {
      kind: "draft";
      owner: WorkspaceAddress;
      draftKind: "pipeline" | "build";
      key: string;
    }
  | {
      kind: "document";
      owner: WorkspaceAddress;
      source: "overview" | "project";
      key: string;
      retainedViewKey: string;
      relativePath: string;
    };
export interface ProjectVisit {
  /** The previous destination lived only in the closed renderer session. */
  previousSessionOnly?: true;
  projectId: string;
  target: HomeTarget;
  visitedAt: number;
}
export interface SessionEntry {
  id: string;
  target: Extract<HomeTarget, { kind: "draft" | "document" }>;
  dirty: boolean;
  busy: boolean;
  touchedAt: number;
}
