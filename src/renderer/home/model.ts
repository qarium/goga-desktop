import { t as msg } from "../../shared/i18n";
import { canRestoreRunDashboard } from "../run-dashboard-state";
import type { Run, Project } from "../../shared/types";
import { contextRef, relativeRunPlanPath } from "../topic-context";
import type { HomeTarget, WorkspaceAddress } from "./types";
export type Filter = "all" | "pipeline" | "build";
export interface OrganizationView {
  groups: readonly {
    id: string;
    name: string;
    projectIds: readonly string[];
  }[];
  ungroupedProjectIds: readonly string[];
}
export const ownerProject = (o: WorkspaceAddress) =>
  o.kind === "primary" ? o.projectId : o.ref.projectId;
export const ownerLabel = (o: WorkspaceAddress) =>
  o.kind === "primary" ? msg("shell.noTopic") : o.ref.topic;
export function contextSuffix(a: WorkspaceAddress, b: WorkspaceAddress) {
  if (ownerProject(a) !== ownerProject(b))
    return ownerLabel(b) + " · " + ownerProject(b);
  if (a.kind !== b.kind || ownerLabel(a) !== ownerLabel(b))
    return ownerLabel(b);
  if (a.kind === "topic" && b.kind === "topic") {
    if (a.ref.year !== b.ref.year) return ownerLabel(b) + " · " + b.ref.year;
    if (a.ref.contextId !== b.ref.contextId)
      return ownerLabel(b) + msg("shell.differentWorkingCopy");
    if (a.ref.branch !== b.ref.branch)
      return ownerLabel(b) + " · " + b.ref.branch;
  }
  return null;
}
export const targetLabel = (t: HomeTarget) =>
  t.kind === "section"
    ? {
        overview: msg("shell.overview"),
        "project-settings": msg("shell.project2"),
        terminal: msg("shell.terminal"),
        topics: msg("shell.topics"),
        commits: msg("shell.commits"),
        "context-runs": msg("shell.runs"),
      }[t.section]
    : t.kind === "run"
      ? msg("shell.launch")
      : t.kind === "changes"
        ? msg("shell.changes")
        : t.kind === "draft"
          ? t.draftKind === "build"
            ? msg("shell.buildDraft")
            : msg("shell.pipelineDraft")
          : msg("shell.editor");
function projectRun(r: Run, viewError?: string) {
  const c = r.context;
  const bound = !!(
    c &&
    c.projectId === r.projectId &&
    c.topic === r.topic &&
    c.branch === r.branch
  );
  const owner: WorkspaceAddress = bound
    ? { kind: "topic", ref: contextRef(c!) }
    : { kind: "primary", projectId: r.projectId };
  const metadata = r.taskSnapshot;
  const year = c
    ? bound
      ? c.year
      : undefined
    : metadata && metadata.topic === r.topic && metadata.branch === r.branch
      ? metadata.year
      : undefined;
  const kind = r.kind ?? "pipeline";
  return {
    id: r.id,
    projectId: r.projectId,
    kind,
    name: r.pipelineName || r.pipeline,
    topic: r.topic,
    year: year && /^\d{4}$/.test(year) ? year : null,
    owner,
    branch: r.branch,
    status: r.status,
    unverified: r.recovery === "unverified",
    startedAt: r.startedAt,
    workflow: r.workflow,
    profile: r.profile,
    planPath:
      kind === "build" && r.build
        ? (relativeRunPlanPath(r.build.planPath, c?.path) ??
          r.build.planPath.split(/[\\/]/).pop())
        : undefined,
    update: r.build?.update ?? r.pipelineRepeat?.update ?? r.update,
    clean: r.build?.clean ?? r.pipelineRepeat?.clean,
    panelError: viewError || r.dashboardMessage || undefined,
    canReconnect:
      canRestoreRunDashboard(r, viewError) &&
      !!(viewError || r.dashboardMessage),
  };
}
export type DisplayRun = ReturnType<typeof projectRun>;
/** Stable references for unchanged display facts. No output, task, URL or environment in projection. */
export function createRunProjection() {
  let previous = new Map<string, { fingerprint: string; row: DisplayRun }>(),
    rows: DisplayRun[] = [];
  return (
    runs: readonly Run[],
    errors: Readonly<Record<string, string>> = {},
  ): readonly DisplayRun[] => {
    const next = new Map<string, { fingerprint: string; row: DisplayRun }>(),
      result: DisplayRun[] = [];
    for (const r of runs) {
      if (
        r.status !== "starting" &&
        r.status !== "running" &&
        r.recovery !== "unverified"
      )
        continue;
      const row = projectRun(r, errors[r.id]);
      const fingerprint = JSON.stringify(row),
        old = previous.get(r.id);
      const entry =
        old?.fingerprint === fingerprint ? old : { fingerprint, row };
      next.set(r.id, entry);
      result.push(entry.row);
    }
    previous = next;
    if (result.length !== rows.length || result.some((r, i) => r !== rows[i]))
      rows = result;
    return rows;
  };
}
export function activeSummary(rows: readonly DisplayRun[]) {
  let pipelines = 0,
    builds = 0,
    unknownTopics = 0,
    unverified = 0;
  const projects = new Set<string>(),
    topics = new Set<string>();
  for (const r of rows) {
    if (r.unverified) {
      unverified++;
      continue;
    }
    r.kind === "build" ? builds++ : pipelines++;
    projects.add(r.projectId);
    if (r.topic) {
      if (r.year) topics.add(JSON.stringify([r.projectId, r.year, r.topic]));
      else unknownTopics++;
    }
  }
  return {
    pipelines,
    builds,
    projects: projects.size,
    topics: topics.size,
    unknownTopics,
    unverified,
  };
}
export function groupActive(
  projects: readonly Project[],
  rows: readonly DisplayRun[],
  organization: OrganizationView,
  filter: Filter,
) {
  const catalog = new Map(projects.map((p) => [p.id, p])),
    order = new Map<string, string | null>();
  for (const g of organization.groups)
    for (const id of g.projectIds) order.set(id, g.name);
  for (const id of organization.ungroupedProjectIds) order.set(id, null);
  for (const p of projects) if (!order.has(p.id)) order.set(p.id, null);
  const owned = new Map<string, DisplayRun[]>();
  for (const r of rows) {
    if (filter !== "all" && filter !== r.kind) continue;
    const list = owned.get(r.projectId) ?? [];
    list.push(r);
    owned.set(r.projectId, list);
  }
  return [...order].flatMap(([id, group]) => {
    const project = catalog.get(id),
      runs = owned.get(id);
    return project && runs?.length
      ? [
          {
            project,
            group,
            runs: runs.sort(
              (a, b) =>
                a.startedAt.localeCompare(b.startedAt) ||
                a.id.localeCompare(b.id),
            ),
          },
        ]
      : [];
  });
}
