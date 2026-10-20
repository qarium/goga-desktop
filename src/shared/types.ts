import type { BuildRepeatSnapshot } from "./build-repeat";
import type { TopicContextRef } from "./worktrees";
import type { BuildSummary } from "./build";
export interface Project {
  id: string;
  name: string;
  path: string;
}
export interface Pipeline {
  id: string;
  name: string;
  description: string;
  project: boolean;
}
export interface Topic {
  topic: string;
  branch: string;
  current: boolean;
  remote: boolean;
  todo: string;
  statuses: string[];
}
export interface ProjectEnvironment {
  key: string;
  value: string;
  secret: boolean;
  runtime: boolean;
}
export interface ProjectSettings {
  startupTimeoutMinutes?: number;
  executable: string;
  profile: string;
  env: ProjectEnvironment[];
}
export interface ProjectSettingsDocument {
  value: ProjectSettings;
  version: string;
}
export interface ProjectSettingsView extends ProjectSettingsDocument {
  profiles: { name: string; source: "home" | "project" }[];
}
export interface Discovery {
  projectSettings?: { version: string; profile: string; executable: string };
  pipelines: Pipeline[];
  topics: Topic[];
  branches: string[];
  currentBranch: string;
  baseRef?: string;
  workflows: string[];
  profiles: {
    name: string;
    source: "home" | "project";
  }[];
}
export interface PipelineRequest {
  context?: TopicContextRef;
  projectId: string;
  pipeline: string;
  workflow: string;
  profile: string;
  profileMode?: "project" | "auto";
  skips: string[];
}
export interface Stage {
  id: string;
  title: string;
}
export interface Preview {
  token: string;
  stages: Stage[];
  workflow: string | null;
  profile: string | null;
}
export type TopicSelection =
  | {
      mode: "existing";
      branch: string;
      topic: string;
    }
  | {
      mode: "new";
      name: string;
      baseRef: string;
    };
export interface LaunchRequest extends PipelineRequest {
  expectedBranch: string;
  confirmBranchSwitch: boolean;
  clean: boolean;
  update?: boolean;
  topic: TopicSelection;
  task: string;
  taskVersion?: string;
  confirmEmptyTask: boolean;
  previewToken: string;
}
export interface RunOutput {
  text: string;
  truncated: boolean;
}
export interface Run {
  /** Private host journal only; stripped from all renderer responses. */
  process?: {
    version: 1;
    runId: string;
    ownerHash: string;
    cwd: string;
    nonce: string;
    rootHash: string;
  };
  buildRepeat?: BuildRepeatSnapshot;
  recovery?: "unverified" | "confirmed";
  syncPending?: boolean;
  persistenceError?: string;
  recoveryMessage?: string;
  context?: TopicContextRef & { path?: string; repositoryKey?: string };
  pipelineName?: string;
  pipelineDescription?: string;
  kind?: "pipeline" | "build";
  build?: BuildSummary;
  taskSnapshot?: { text: string; year: string; topic: string; branch: string };
  output?: RunOutput;
  startupTimeoutMs?: number;
  update?: boolean;
  dashboardOpened?: boolean;
  id: string;
  projectId: string;
  pipeline: string;
  topic: string;
  branch: string;
  status: "starting" | "running" | "exited" | "failed" | "stopped";
  url?: string;
  error?: string;
  workflow: string | null;
  profile: string | null;
  startedAt: string;
  endedAt?: string;
}
export type SettingsKind = "config" | "profile";
export interface SettingsDocument {
  text: string;
  version: string;
}
export interface SettingsMetadata {
  configExists: boolean;
  profiles: string[];
}

export interface TopicTaskRequest {
  context?: TopicContextRef;
  projectId: string;
  branch: string;
  topic: string;
}
export interface TopicTaskDocument {
  catalogState?: "missing-local-metadata";
  text: string;
  exists: boolean;
  version: string;
  path: string;
}
