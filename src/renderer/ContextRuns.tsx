import { t as tr } from "../shared/i18n";
import { useLocale } from "./useLocale";
import type {AttachedDashboard} from "../shared/attached-dashboard";
import {Cable} from "lucide-react";
import {AttachedPanelCard} from "./AttachedPanels";
import { useState } from "react";
import { RunHistoryClear } from "./RunHistoryClear";
import type { ClearRunHistoryRequest, ClearRunHistoryResult } from "../shared/run-history";
import type { Pipeline, Run } from "../shared/types";
import {
  relativeRunPlanPath,
  runsForContext,
  contextKey,
  contextRef,
  type RunKind,
  type RunWithContext,
  type TopicContextIdentity,
} from "./topic-context";
import "./ContextRuns.css";

export interface ContextRunsProps {
  runs: RunWithContext[];
  context: TopicContextIdentity | null;
  onOpen: (runId: string) => void;
  onClearHistory?: (request: ClearRunHistoryRequest) => Promise<ClearRunHistoryResult>;
  panels?: AttachedDashboard[];
  onAttach?:()=>void;
  onOpenPanel?:(id:string)=>void;
  viewErrors?:Record<string,string>;
  pipelines?: Pipeline[];
  contextLabel?: string;
  unavailableReason?: string;
  primaryProjectId?: string;
}
const statusLabels: Record<Run["status"], string> = {
  get starting() { return tr("launch.starting"); },
  get running() { return tr("launch.running"); },
  get exited() { return tr("launch.completed"); },
  get failed() { return tr("launch.error"); },
  get stopped() { return tr("launch.stopped"); },
};

type HistoryItem =
  | { kind: "run"; row: RunWithContext; time: number }
  | { kind: "panel"; row: AttachedDashboard; time: number };

// AFM may report no start time for an attached panel. Keep unknown dates after
// dated entries rather than substituting the time the user attached the panel.
function historyTime(value?: string) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/** Contextual history is inert until the user explicitly opens a record. */
export function ContextRuns({
  runs,
  context,
  onOpen,
  onClearHistory,
  panels=[],onAttach,onOpenPanel,viewErrors,
  pipelines = [],
  contextLabel,
  unavailableReason,
  primaryProjectId,
}: ContextRunsProps) {
  const locale = useLocale();
  const [filter, setFilter] = useState<RunKind>("pipeline");
  const scoped =
    !context && primaryProjectId
      ? runs.filter((run) => run.projectId === primaryProjectId && !run.context)
      : runsForContext(runs, context);
  const pipelineCount = scoped.filter((run) => run.kind !== "build").length + panels.length;
  const filtered = scoped.filter((run) => (run.kind ?? "pipeline") === filter);
  const history: HistoryItem[] = filtered.map(row => ({
    kind: "run", row, time: historyTime(row.startedAt),
  }));
  if (filter === "pipeline") {
    for (const row of panels)
      history.push({ kind: "panel", row, time: historyTime(row.startedAt) });
  }
  // Sort this presentation list only; equal timestamps retain their input order.
  history.sort((a, b) => a.time === b.time ? 0 : a.time > b.time ? -1 : 1);

  return (
    <section className="context-runs" aria-label={tr("launch.runsForSelectedTopic")}>
      <div className="context-runs-heading"><h2>{tr("launch.runs")}</h2><div className="context-runs-heading-actions">
        {onAttach&&<button onClick={onAttach}><Cable size={16}/>{tr("launch.attachPipeline")}</button>}
        {onClearHistory && (context || primaryProjectId) && <RunHistoryClear
          key={JSON.stringify([context ? contextKey(context) : primaryProjectId, filter])}
          scope={context ? contextRef(context) : primaryProjectId!}
          kind={filter} runs={filtered} label={context?.topic ?? tr("launch.noTopic")} clear={onClearHistory}
        />}
      </div></div>
      {contextLabel && (
        <p className="context-run-hint">{tr("launch.topicContext", { topic: contextLabel })}</p>
      )}
      {unavailableReason && (
        <p className="context-run-hint" role="status">
          {unavailableReason}
        </p>
      )}
      <div className="context-run-filters" aria-label={tr("launch.runType")}>
        <button
          type="button"
          aria-label={tr("launch.pipelinesPipelinecount", { pipelineCount: pipelineCount })}
          aria-pressed={filter === "pipeline"}
          onClick={() => setFilter("pipeline")}
        >{tr("launch.pipelines")}<span className="context-counter">{pipelineCount}</span>
        </button>
        <button
          type="button"
          aria-pressed={filter === "build"}
          onClick={() => setFilter("build")}
        >{tr("launch.build")}</button>
      </div>
      {!context && !contextLabel && (
        <p className="context-run-hint">{tr("launch.selectATopicToSeeItsRuns")}</p>
      )}
      <>
        {filter === "build" && (
          <p className="context-run-hint">{tr("launch.oneBuildCanRunInThisWorkingCopy")}</p>
        )}
        {history.length === 0 && (
          <p className="context-run-hint">
            {filter === "build"
              ? tr("launch.noBuildsYet")
              : tr("launch.noPipelineRunsYet")}
          </p>
        )}
        <div className="context-run-list">
          {history.map(item => {
            if (item.kind === "panel") {
              const panel = item.row;
              return (
                <AttachedPanelCard
                  key={`panel:${panel.id}`}
                  row={panel}
                  error={viewErrors?.[panel.id]}
                  onOpen={() => onOpenPanel?.(panel.id)}
                />
              );
            }
            const run = item.row;
            const isBuild = run.kind === "build";
            const pipeline = pipelines.find((item) => item.id === run.pipeline);
            const name = isBuild
              ? (relativeRunPlanPath(run.build?.planPath, run.context?.path) ??
                tr("launch.noPlanSpecified"))
              : run.pipelineName?.trim() || pipeline?.name || run.pipeline;
            const description =
              run.pipelineDescription ?? pipeline?.description;
            const timestamp = new Date(run.startedAt);
            const hasTime = Number.isFinite(timestamp.getTime());
            return (
              <article key={`run:${run.id}`} className="context-run-row">
                <div className="context-run-main">
                  <div className="context-run-identity">
                    <small>{isBuild ? tr("launch.build") : tr("launch.pipeline")}</small>
                    <strong>{name}</strong>
                    {!isBuild && description?.trim() && (
                      <p className="context-run-description">{description}</p>
                    )}
                    {hasTime && (
                      <time dateTime={run.startedAt}>
                        {timestamp.toLocaleString(locale)}
                      </time>
                    )}
                  </div>
                  <div className="context-run-actions">
                    <span className={`context-run-status is-${run.status}`}>
                      {run.recovery === "unverified"
                        ? tr("launch.processStateHasNotBeenVerifiedSinceRestart")
                        : statusLabels[run.status]}
                    </span>
                    <button
                      type="button"
                      aria-label={tr("launch.openRunName", { name: name })}
                      onClick={() => onOpen(run.id)}
                    >{tr("launch.openRun")}</button>
                  </div>
                </div>
                {run.syncPending && (
                  <p className="context-run-hint" role="status">{tr("launch.commitSyncIsPendingTheRunResultIs")}</p>
                )}
                {run.persistenceError && (
                  <p className="error" role="alert">{tr("launch.runHistoryCouldNotBeFullySaved")}{" "}
                    {run.persistenceError}
                  </p>
                )}
                <details className="context-run-technical">
                  <summary>{tr("launch.technicalDetails")}</summary>
                  <dl>
                    <dt>{tr("launch.runId")}</dt>
                    <dd>{run.id}</dd>
                    {run.context?.path && (
                      <>
                        <dt>{tr("launch.workingCopyFolder")}</dt>
                        <dd>{run.context.path}</dd>
                      </>
                    )}
                    {isBuild &&
                      run.build?.planPath &&
                      run.build.planPath !== name && (
                        <>
                          <dt>{tr("launch.recordedPlanPath")}</dt>
                          <dd>{run.build.planPath}</dd>
                        </>
                      )}
                  </dl>
                </details>
              </article>
            );
          })}
        </div>
      </>
    </section>
  );
}
