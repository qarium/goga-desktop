import { t as msg } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import { memo, useMemo } from "react";
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Clock3,
  GitBranch,
  Hammer,
  Layers,
  RotateCcw,
  Terminal,
  WifiOff,
} from "lucide-react";
import type { Project } from "../../shared/types";
import { type DisplayRun } from "./model";
import type { HomeTarget, WorkspaceAddress } from "./types";


function elapsed(start: number, now: number) {
  if (!Number.isFinite(start)) return "—";
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  return sec < 60
    ? msg("shell.s", { sec: String(sec) })
    : sec < 3600
      ? msg("shell.m", { value1: String(Math.floor(sec / 60)) })
      : msg("shell.hM", { value1: String(Math.floor(sec / 3600)), value2: String(Math.floor(sec / 60) % 60) });
}
const RunTile = memo(function RunTile({
  run,
  now,
  onNavigate,
  onReconnect,
}: {
  run: DisplayRun;
  now: number;
  onNavigate: (t: HomeTarget) => void;
  onReconnect?: (id: string) => void;
}) {
  const locale = useLocale();
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale, {hour: "2-digit", minute: "2-digit"}), [locale]);
  const start = Date.parse(run.startedAt),
    status = run.unverified
      ? msg("shell.statusUnverified")
      : run.status === "starting"
        ? msg("shell.starting")
        : msg("shell.running");
  const open = () =>
    onNavigate({ kind: "run", runId: run.id, owner: run.owner });
  return (
    <article data-live-run={run.id} className="d-live-run">
      <div className="d-run-heading">
        <button className="d-run-name" data-run={run.id} onClick={open}>
          {run.kind === "build" ? <Hammer size={16} /> : <Terminal size={16} />}
          <strong>{run.name}</strong>
          <ArrowUpRight size={14} />
        </button>
        <span className="d-duration" title={msg("shell.timeSinceTheProcessStarted")}>
          <Clock3 size={12} />
          {elapsed(start, now)}
        </span>
      </div>
      <div
        className="d-owner"
        title={
          run.owner.kind === "topic"
            ? msg("shell.topicWorkingCopy") + run.topic
            : msg("shell.originalProject")
        }
      >
        <Layers size={12} />
        <span>{run.topic || msg("shell.noTopic")}</span>
      </div>
      <div className="d-state-line">
        <span
          className={
            "d-status " + ((!run.unverified && run.status === "running") ? "d-running" : "d-neutral")
          }
        >
          {(!run.unverified && run.status === "running") ? (
            <Activity size={14} />
          ) : (
            <Clock3 size={14} />
          )}{" "}
          {status}
        </span>
        <time className="d-started" dateTime={run.startedAt}>{msg("shell.startedAt")}{Number.isFinite(start) ? formatter.format(start) : "—"}
        </time>
      </div>
      <div className="d-launch-info">
        {(run.workflow || run.profile || run.planPath) && (
          <dl className="d-run-facts">
            {run.planPath && (
              <div className="d-plan-fact">
                <dt>{msg("shell.buildPlan")}</dt>
                <dd title={run.planPath}>{run.planPath}</dd>
              </div>
            )}
            {run.workflow && (
              <div>
                <dt>{msg("shell.workflow")}</dt>
                <dd title={run.workflow}>{run.workflow}</dd>
              </div>
            )}
            {run.profile && (
              <div className="d-profile-fact">
                <dt>{msg("shell.profile")}</dt>
                <dd title={run.profile}>{run.profile}</dd>
              </div>
            )}
          </dl>
        )}
        {(run.clean || run.update) && (
          <div className="d-launch-flags">
            {run.update && (
              <span>
                <RotateCcw size={11} />{msg("shell.withRebuild2")}</span>
            )}
            {run.clean && <span>{msg("shell.cleanStart")}</span>}
          </div>
        )}
      </div>
      {run.panelError && (
        <div role="status" className="d-panel-error">
          <WifiOff size={13} />
          <span>
            {run.panelError}
            <small>{msg("shell.theProcessWillNotBeRestarted")}</small>
          </span>
        </div>
      )}
      <div className="d-run-bottom">
        <span title={msg("shell.branchAtLaunch") + run.branch}>
          <GitBranch size={13} />
          {run.branch || "—"}
        </span>
        {run.canReconnect && onReconnect ? (
          <button onClick={() => onReconnect(run.id)} data-reconnect={run.id}>{msg("shell.reconnectPanel")}<RotateCcw size={12} />
          </button>
        ) : (
          <button onClick={open} data-run={run.id}>{msg("shell.open")}<ArrowRight size={12} />
          </button>
        )}
      </div>
    </article>
  );
});
export const ActiveProjectCard = memo(function ActiveProjectCard({
  project,
  group,
  runs,
  unread,
  owner,
  now,
  onNavigate,
  onReconnect,
}: {
  project: Project;
  group: string | null;
  runs: readonly DisplayRun[];
  unread?: number;
  owner: WorkspaceAddress;
  now: number;
  onNavigate: (t: HomeTarget) => void;
  onReconnect?: (id: string) => void;
}) {
  useLocale();
  const n = runs.filter((r) => !r.unverified).length;
  return (
    <section
      data-project-card={project.id}
      className={"d-project-card" + (runs.length > 1 ? " has-multiple" : "")}
    >
      <header>
        <button
          className="d-project-link"
          onClick={() =>
            onNavigate({ kind: "section", owner, section: "overview" })
          }
        >
          <span className="d-project-initial">
            {project.name[0]?.toLocaleUpperCase()}
          </span>
          <span>
            <strong>{project.name}</strong>
            <small>{group || msg("shell.ungrouped")}</small>
          </span>
        </button>
        <div className="d-card-counters">
          <span
            className="d-card-count"
            title={msg("shell.verifiedActiveRunsInThisFilter")}
          >
            <Terminal size={12} />
            {n}
          </span>
          {!!unread && (
            <span
              className="d-project-unread"
              aria-label={msg("shell.projectUnreadCount", { count: unread, project: project.name })}
              title={msg("shell.unreadProjectNotificationsIncludingCompletedRuns")}
            >
              <Bell size={13} />
              <span className="unread-badge" data-project-unread={project.id}>
                {unread}
              </span>
            </span>
          )}
        </div>
      </header>
      {runs.map((r) => (
        <RunTile
          run={r}
          now={now}
          key={r.id}
          onNavigate={onNavigate}
          onReconnect={onReconnect}
        />
      ))}
    </section>
  );
});
