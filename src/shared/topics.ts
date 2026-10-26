import type { GitUpdateHandoffCandidate } from "./git-update-handoff";
import type { TopicContextRef } from "./worktrees";
export interface TopicBoardRecord {
  topic: string;
  branch: string;
  statuses: string[];
  /** Safe display-only diagnostic; absent on native Goga board records. */
  statusError?: string;
  current: boolean;
  remote: boolean;
  todo: string | null;
  divergence: string | null;
}
export interface TopicBoardEntry extends TopicBoardRecord {
  hosts: string[];
}
export interface TopicTarget {
  topic: string;
  branch: string;
  remote: boolean;
}
/** Display-only primary catalog. Never a revision or authority for mutations. */
export interface TopicCatalogSnapshot {
  projectId: string;
  year: string;
  entries: TopicTarget[];
  currentTopic: TopicTarget | null;
}
/** Display-only branch inventory of the original repository, never mutation authority. */
export interface ProjectBranches {
  projectId: string;
  branches: string[];
  localBranches: string[];
}
export interface TopicBoardSnapshot {
  projectId: string;
  year: string;
  revision: string;
  currentBranch: string;
  currentTopic: TopicTarget | null;
  baseRef: string;
  branches: string[];
  /** Local destination choices; never grants host mutation authority. */
  localBranches?: string[];
  dirty: boolean;
  active: boolean;
  entries: TopicBoardEntry[];
  records: TopicBoardRecord[];
  remoteEntries: TopicBoardEntry[];
  remoteRecords: TopicBoardRecord[];
}
export interface TopicDetails {
  catalogState?: "missing-local-metadata";
  projectId: string;
  year: string;
  target: TopicTarget;
  text: string;
  exists: boolean;
  version: string;
  editable: boolean;
  reason?: string;
}
export type TopicAction =
  | "create"
  | "switch"
  | "save-task"
  | "update"
  | "publish"
  | "propagate"
  | "delete";
export interface TopicOperationRequest {
  context?: TopicContextRef;
  projectId: string;
  year: string;
  expectedRevision: string;
  action: TopicAction;
  target?: TopicTarget;
  topics?: string[];
  branch?: string;
  baseRef?: string;
  task?: string;
  taskVersion?: string;
  publish?: boolean;
  switch?: boolean;
  commit?: string;
}
export interface TopicOperationPlan {
  token: string;
  projectId: string;
  year: string;
  action: TopicAction;
  title: string;
  details: string[];
  expiresAt: number;
}
export interface TopicOperationResult {
  handoff?: GitUpdateHandoffCandidate;
  projectId: string;
  status: "success" | "partial" | "failed";
  message: string;
}
