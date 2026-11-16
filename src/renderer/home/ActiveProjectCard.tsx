import { memo } from "react";
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
import { type DisplayRun, plural } from "./model";
import type { HomeTarget, WorkspaceAddress } from "./types";

const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
});
function elapsed(start: number, now: number) {
  if (!Number.isFinite(start)) return "—";
  const sec = Math.max(0, Math.floor((now - start) / 1000));
  return sec < 60
    ? `${sec} сек`
    : sec < 3600
      ? `${Math.floor(sec / 60)} мин`
      : `${Math.floor(sec / 3600)} ч ${Math.floor(sec / 60) % 60} мин`;
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
  const start = Date.parse(run.startedAt),
    status = run.unverified
      ? "Состояние не подтверждено"
      : run.status === "starting"
        ? "Запускается"
        : "Работает";
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
        <span className="d-duration" title="Время с запуска процесса">
          <Clock3 size={12} />
          {elapsed(start, now)}
        </span>
      </div>
      <div
        className="d-owner"
        title={
          run.owner.kind === "topic"
            ? "Копия топика: " + run.topic
            : "Исходный проект"
        }
      >
        <Layers size={12} />
        <span>{run.topic || "Без топика"}</span>
      </div>
      <div className="d-state-line">
        <span
          className={
            "d-status " + (status === "Работает" ? "d-running" : "d-neutral")
          }
        >
          {status === "Работает" ? (
            <Activity size={14} />
          ) : (
            <Clock3 size={14} />
          )}{" "}
          {status}
        </span>
        <time className="d-started" dateTime={run.startedAt}>
          Старт в {Number.isFinite(start) ? timeFormatter.format(start) : "—"}
        </time>
      </div>
      <div className="d-launch-info">
        {(run.workflow || run.profile || run.planPath) && (
          <dl className="d-run-facts">
            {run.planPath && (
              <div className="d-plan-fact">
                <dt>План сборки</dt>
                <dd title={run.planPath}>{run.planPath}</dd>
              </div>
            )}
            {run.workflow && (
              <div>
                <dt>Рабочий процесс</dt>
                <dd title={run.workflow}>{run.workflow}</dd>
              </div>
            )}
            {run.profile && (
              <div className="d-profile-fact">
                <dt>Профиль</dt>
                <dd title={run.profile}>{run.profile}</dd>
              </div>
            )}
          </dl>
        )}
        {(run.clean || run.update) && (
          <div className="d-launch-flags">
            {run.update && (
              <span>
                <RotateCcw size={11} />С пересборкой
              </span>
            )}
            {run.clean && <span>С чистого состояния</span>}
          </div>
        )}
      </div>
      {run.panelError && (
        <div role="status" className="d-panel-error">
          <WifiOff size={13} />
          <span>
            {run.panelError}
            <small>Процесс не перезапускается</small>
          </span>
        </div>
      )}
      <div className="d-run-bottom">
        <span title={"Ветка на момент запуска: " + run.branch}>
          <GitBranch size={13} />
          {run.branch || "—"}
        </span>
        {run.canReconnect && onReconnect ? (
          <button onClick={() => onReconnect(run.id)} data-reconnect={run.id}>
            Восстановить панель
            <RotateCcw size={12} />
          </button>
        ) : (
          <button onClick={open} data-run={run.id}>
            Открыть
            <ArrowRight size={12} />
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
            <small>{group || "Вне групп"}</small>
          </span>
        </button>
        <div className="d-card-counters">
          <span
            className="d-card-count"
            title="Подтверждённые активные запуски в этом фильтре"
          >
            <Terminal size={12} />
            {n}
          </span>
          {!!unread && (
            <span
              className="d-project-unread"
              aria-label={`${unread} ${plural(unread, ["непрочитанное уведомление", "непрочитанных уведомления", "непрочитанных уведомлений"])} проекта ${project.name}`}
              title="Непрочитанные уведомления проекта, включая завершённые запуски"
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
