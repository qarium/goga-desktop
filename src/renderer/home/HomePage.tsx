import type { MessageKey } from "../../shared/locale-packs.generated";
import { t as msg } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import {AttachedPanelCard} from "../AttachedPanels";
import type {AttachedDashboard} from "../../shared/attached-dashboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Folder, Hammer, Layers, Terminal } from "lucide-react";
import type { Project, Run } from "../../shared/types";
import type { NotificationSnapshot } from "../../shared/notifications";
import { ActiveProjectCard } from "./ActiveProjectCard";
import { RecentProjectCard } from "./RecentProjectCard";
import {
  activeSummary,
  createRunProjection,
  groupActive,
  ownerProject,
  type Filter,
  type OrganizationView,
} from "./model";
import type {
  HomeTarget,
  ProjectVisit,
  SessionEntry,
  WorkspaceAddress,
} from "./types";
import "./HomePage.css";

// Keep the number visually distinct without hard-coding word order or a plural rule.
function metric(key: MessageKey, count: number, atLeast = false) {
  const marker = "\uFFFC";
  const [before, after] = msg(key, { count, number: marker }).split(marker);
  return <>{before}<b>{atLeast ? "≥" : ""}{count}</b>{after}</>;
}

const noEntries: readonly SessionEntry[] = [];
export interface HomePageProps {
  projects: readonly Project[];
  runs: readonly Run[];
  organization: OrganizationView;
  visits: readonly ProjectVisit[];
  sessionEntries: readonly SessionEntry[];
  notifications?: Pick<NotificationSnapshot, "byProject" | "error"> | null;
  viewErrors?: Readonly<Record<string, string>>;
  attached?:AttachedDashboard[];
  onDetachPanel?:(row:AttachedDashboard)=>void;
  catalogReady: boolean;
  catalogError?: string;
  onRetry?: () => void;
  runsReady?: boolean;
  runsError?: string;
  onRetryRuns?: () => void;
  onAdd: (anchor: HTMLElement) => void;
  onNavigate: (t: HomeTarget) => void;
  onReconnect?: (runId: string) => void;
  operations?: Readonly<Record<string, string>>;
}
export function HomePage(props: HomePageProps) {
  useLocale();
  const {
    projects,
    runs,
    organization,
    visits,
    sessionEntries,
    notifications,
    catalogReady,
    catalogError,
    runsReady = true,
    runsError,
  } = props;
  const [filter, setFilter] = useState<Filter>("all");
  const projectRuns = useMemo(createRunProjection, []),
    rows = projectRuns(runs, props.viewErrors);
  const catalog = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );
  const visible = useMemo(
    () => rows.filter((r) => catalog.has(r.projectId)),
    [rows, catalog],
  );
  const summary = useMemo(() => activeSummary(visible), [visible]);
  const groups = useMemo(
    () => groupActive(projects, visible, organization, filter),
    [projects, visible, organization, filter],
  );
  const owners = useMemo(
    () =>
      new Map(
        projects.map((p) => [
          p.id,
          visits.find((v) => v.projectId === p.id)?.target.owner ??
            ({ kind: "primary", projectId: p.id } as WorkspaceAddress),
        ]),
      ),
    [projects, visits],
  );
  const recent = useMemo(() => {
    const seen = new Set();
    return visits
      .filter(
        (v) =>
          ownerProject(v.target.owner) === v.projectId &&
          catalog.has(v.projectId) &&
          !seen.has(v.projectId) &&
          seen.add(v.projectId),
      )
      .slice(0, 3);
  }, [visits, catalog]);
  const sessionsByProject = useMemo(() => {
    const byId = new Map<string, SessionEntry[]>();
    for (const entry of sessionEntries) {
      const pid = ownerProject(entry.target.owner);
      let list = byId.get(pid);
      if (!list) byId.set(pid, (list = []));
      list.push(entry);
    }
    return byId;
  }, [sessionEntries]);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!visible.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      const n = Date.now();
      setNow(n);
      timer = setTimeout(
        tick,
        visible.some((r) => n - Date.parse(r.startedAt) < 60000) ? 1000 : 30000,
      );
    };
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [visible]);
  const callbacks = useRef(props);
  callbacks.current = props;
  const go = useCallback(
      (t: HomeTarget) => callbacks.current.onNavigate(t),
      [],
    ),
    reconnect = useCallback(
      (id: string) => callbacks.current.onReconnect?.(id),
      [],
    );
  return (
    <div className="home-workspace" data-home-page>
      <div className="home-dashboard">
        <header className="home-heading">
          <div>
            <span className="eyebrow">{msg("shell.myCOMPUTERWORKSPACE")}</span>
            <h1>{msg("shell.home")}</h1>
            <p>{msg("shell.pickUpARecentProjectOrFollowAnActiveRun")}</p>
          </div>
          <div className="d-local">
            <span>
              <i />{msg("shell.desktopStatus")}</span>
            <small>{msg("shell.gitSummariesUpdateInTheBackground")}</small>
          </div>
        </header>
        {catalogError && (
          <div role="alert" className="home-notice">
            {catalogError}{" "}
            {props.onRetry && (
              <button onClick={props.onRetry}>{msg("shell.retryLoadingProjects")}</button>
            )}
          </div>
        )}
        {notifications?.error && (
          <p role="status" className="home-notice">{msg("shell.couldNotRefreshNotificationsShowingTheLastKnownData")}</p>
        )}
        {!catalogReady ? (
          <p role="status">
            {catalogError
              ? msg("shell.projectCatalogUnavailable")
              : msg("shell.loadingProjects")}
          </p>
        ) : !projects.length ? (
          <section className="home-empty">
            <Folder size={34} />
            <h2>{msg("shell.roomForYourNextIdea")}</h2>
            <p>{msg("shell.addAProjectToSeeItsPipelinesAndBuildsOn")}</p>
            <button
              className="primary"
              onClick={(e) => props.onAdd(e.currentTarget)}
            >{msg("shell.addProject")}</button>
          </section>
        ) : (
          <>
            {recent.length > 0 && (
              <section
                className="d-recent-projects"
                aria-label={msg("shell.recentProjects")}
              >
                <header className="d-section-head">
                  <h2>{msg("shell.recentProjects")}</h2>
                  <p>{msg("shell.pickUpWhereYouLeftOff")}</p>
                </header>
                <div className="d-recent-row">
                  {recent.map((v) => (
                    <RecentProjectCard
                      key={v.projectId}
                      project={catalog.get(v.projectId)!}
                      visit={v}
                      entries={sessionsByProject.get(v.projectId) ?? noEntries}
                      active={
                        runsReady
                          ? visible.filter(
                              (r) =>
                                r.projectId === v.projectId && !r.unverified,
                            ).length
                          : undefined
                      }
                      unread={notifications?.byProject[v.projectId]}
                      operation={props.operations?.[v.projectId]}
                      onNavigate={go}
                    />
                  ))}
                </div>
              </section>
            )}
            {!!props.attached?.some(r=>catalog.has(r.owner.projectId))&&<section className="d-work-section" aria-label={msg("shell.attachedPanels")}>
              <header className="d-section-head"><h2>{msg("shell.attachedPanels")}</h2><p>{msg("shell.externalPipelinesReadOnly")}</p></header>
              <div className="context-run-list">{props.attached.filter(r=>catalog.has(r.owner.projectId)).map(row=><AttachedPanelCard key={row.id} row={row}
                error={props.viewErrors?.[row.id]} label={[catalog.get(row.owner.projectId)?.name,row.owner.context?.topic].filter(Boolean).join(" · ")}
                onDetach={props.onDetachPanel?()=>props.onDetachPanel!(row):undefined}
                onOpen={()=>go({kind:"run",runId:row.id,owner:row.owner.context?{kind:"topic",ref:row.owner.context}:{kind:"primary",projectId:row.owner.projectId}})}/>)}</div>
            </section>}
            <section className="d-work-section" aria-label={msg("shell.inProgress")}>
              <header className="d-section-head">
                <h2>{msg("shell.inProgress")}{" "}
                  {runsReady && (
                    <small>{summary.pipelines + summary.builds}</small>
                  )}
                </h2>
                <p>{msg("shell.pipelinesAndBuildsByProject")}</p>
              </header>
              {runsError && (
                <p className="home-notice" role="alert">
                  {runsError}{" "}
                  {props.onRetryRuns && (
                    <button onClick={props.onRetryRuns}>{msg("shell.retryLoadingRuns")}</button>
                  )}
                </p>
              )}
              {!runsReady ? (
                <p role="status">
                  {runsError
                    ? msg("shell.runInformationUnavailable")
                    : msg("shell.loadingRuns")}
                </p>
              ) : (
                <>
                  <div className="d-work-toolbar">
                    <div
                      className="d-filters"
                      aria-label={msg("shell.filterActiveRuns")}
                    >
                      {(
                        [
                          ["all", msg("shell.all")],
                          ["pipeline", msg("shell.pipelines")],
                          ["build", msg("shell.builds")],
                        ] as const
                      ).map(([f, label]) => (
                        <button
                          key={f}
                          data-filter={f}
                          aria-pressed={filter === f}
                          onClick={() => setFilter(f)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div
                      className="d-overview"
                      aria-label={msg("shell.activeRunSummary")}
                    >
                      <span>
                        <Terminal size={13} />
                        {metric("shell.activeSummary.pipeline", summary.pipelines)}
                      </span>
                      <span>
                        <Hammer size={13} />
                        {metric("shell.activeSummary.build", summary.builds)}
                      </span>
                      <span>
                        <Folder size={13} />
                        {metric("shell.activeSummary.project", summary.projects)}
                      </span>
                      <span
                        data-topic-count
                        title={
                          summary.unknownTopics
                            ? msg("shell.confirmedRunsHaveIncompleteContext", { topics: String(summary.topics), unknownTopics: String(summary.unknownTopics) })
                            : msg("shell.distinctTopicsWithActiveRunsRunsWithoutATopicAre")
                        }
                      >
                        <Layers size={13} />
                        {metric("shell.activeSummary.topic", summary.topics, summary.unknownTopics > 0)}
                      </span>
                      {summary.unverified > 0 && (
                        <span>{msg("shell.needVerification")}{summary.unverified}</span>
                      )}
                    </div>
                  </div>
                  <div className="d-project-grid">
                    {groups.map((g) => (
                      <ActiveProjectCard
                        key={g.project.id}
                        {...g}
                        unread={notifications?.byProject[g.project.id]}
                        owner={owners.get(g.project.id)!}
                        now={now}
                        onNavigate={go}
                        onReconnect={props.onReconnect ? reconnect : undefined}
                      />
                    ))}
                  </div>
                  {!groups.length && (
                    <div className="d-no-active">
                      <CheckCircle2 size={25} />
                      <h3>
                        {visible.length
                          ? msg("shell.noRunsMatchThisFilter")
                          : msg("shell.noActiveRuns")}
                      </h3>
                      <p>
                        {visible.length
                          ? msg("shell.otherFiltersHaveRuns")
                          : msg("shell.returnToARecentProjectOrOpenAnotherFromThe")}
                      </p>
                      {filter !== "all" && (
                        <button onClick={() => setFilter("all")}>{msg("shell.showAll")}</button>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
