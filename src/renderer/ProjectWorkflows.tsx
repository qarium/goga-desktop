import type { TopicContextRef } from "../shared/worktrees";
import type { Project } from "../shared/types";
import type { SettingsDocuments } from "./settings-documents";
import { ProjectFlatDocuments } from "./ProjectFlatDocuments";

export function ProjectWorkflows(props: {
  project: Project;
  owner?: TopicContextRef;
  store: SettingsDocuments;
  savedSettingsVersion?: string;
}) {
  return <ProjectFlatDocuments {...props} kind="workflow" />;
}
