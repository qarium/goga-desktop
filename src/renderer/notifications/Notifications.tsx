import { HintButton } from "../ActionHint";
import { getLocale, t } from "../../shared/i18n";
import { useLocale } from "../useLocale";
import { useEffect, useRef } from "react";
import {
  Bell,
  Check,
  CheckCheck,
  X,
  MessageCircleQuestion,
  CircleAlert,
  CircleCheck,
  PauseCircle,
  Info,
} from "lucide-react";
import type { Project } from "../../shared/types";
import type { NotificationRecord } from "../../shared/notifications";
import { TopicPickerPopup, dismissActiveTopicPopup } from "../TopicPickerPopup";
import type { NotificationsController } from "./useNotifications";
import "./Notifications.css";

const titleKeys = {
  question: "general.yourResponseIsNeeded",
  approval: "general.approvalRequired",
  "stage-failed": "general.stageFailed",
  paused: "general.stagePaused",
  "assistant-decision": "general.theAssistantNeedsADecision",
  "run-finished": "general.pipelineCompleted",
  "run-failed": "general.pipelineFailed",
  "process-exited": "general.pipelineProcessExited",
} as const satisfies Record<NotificationRecord["kind"], string>;
function EventIcon({ kind }: { kind: NotificationRecord["kind"] }) {
  if (
    kind === "question" ||
    kind === "assistant-decision" ||
    kind === "approval"
  )
    return <MessageCircleQuestion />;
  if (kind === "stage-failed" || kind === "run-failed") return <CircleAlert />;
  if (kind === "paused") return <PauseCircle />;
  return <CircleCheck />;
}
export function NotificationBell({
  controller: c,
  projects,
  onOpen,
}: {
  controller: NotificationsController;
  projects: Project[];
  onOpen: (id: string) => Promise<void>;
}) {
  useLocale();
  const anchor = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLElement>(null);
  const close = () => {
    c.setOpen(false);
    anchor.current?.focus();
  };
  useEffect(() => {
    if (!c.open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!anchor.current?.contains(target) && !panel.current?.contains(target))
        c.setOpen(false);
    };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", outside);
    };
  }, [c.open]);
  if (!c.available) return null;
  const { snapshot: s } = c;
  const open = async (id: string) => {
    c.setOpen(false);
    try {
      await dismissActiveTopicPopup();
      await onOpen(id);
    } catch (e) {
      c.report(e);
      c.setOpen(true);
    }
  };
  return (
    <div className="notifications-anchor">
      <HintButton
        ref={anchor}
        type="button"
        className="notification-bell"
        aria-label={t("general.notificationsUnread", { unreadCount: s.unreadCount })}
        aria-expanded={c.open}
        onClick={() => c.setOpen(!c.open)}
        hint={t("general.notifications")}
      >
        <Bell size={18} />
        {s.unreadCount > 0 && (
          <span className="notification-count">
            {s.unreadCount > 99 ? "99+" : s.unreadCount}
          </span>
        )}
      </HintButton>
      {c.open && (
        <TopicPickerPopup
          anchor={anchor}
          onClose={close}
          label={t("general.notifications")}
          width={400}
        >
          <section
            ref={panel}
            className="topic-context-popup notifications-panel"
            aria-label={t("general.notificationList")}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <header className="notifications-heading">
              <div>
                <h2>{t("general.notifications")}</h2>
                <p aria-live="polite">
                  {s.unreadCount
                    ? t("general.unread", { unreadCount: s.unreadCount })
                    : t("general.allCaughtUp")}
                </p>
              </div>
              <div className="notifications-heading-actions">
                <HintButton
                  type="button"
                  className="notification-icon"
                  aria-label={t("general.markAllAsRead")}
                  hint={t("general.markAllAsRead")}
                  disabled={c.busy || !s.unreadCount}
                  onClick={() => void c.readAll()}
                >
                  <CheckCheck size={17} />
                </HintButton>
                <HintButton
                  type="button"
                  className="notification-icon"
                  aria-label={t("general.closeNotifications")}
                  hint={t("general.closeNotifications")}
                  onClick={close}
                >
                  <X size={17} />
                </HintButton>
              </div>
            </header>
            {c.error && (
              <p className="notifications-error" role="alert">
                {c.error}
                <button type="button" onClick={() => void c.latest()}>{t("general.retry")}</button>
              </p>
            )}
            <div className="notification-events">
              {s.records.map((n) => (
                <article
                  className={`notification-event ${n.readAt ? "read" : "unread"} ${n.kind}`}
                  key={n.id}
                >
                  <button
                    type="button"
                    className="notification-event-open"
                    aria-label={t("general.openNotification", { value1: t(titleKeys[n.kind]), projectId: projects.find((p) => p.id === n.projectId)?.name ?? n.projectId, pipeline: n.pipeline })}
                    onClick={() => void open(n.id)}
                  >
                    <span className="notification-symbol">
                      <EventIcon kind={n.kind} />
                    </span>
                    <span className="notification-event-copy">
                      <strong>
                        {t(titleKeys[n.kind])}
                        {!n.readAt && <i className="notification-new-dot" />}
                      </strong>
                      <span>
                        {n.pipeline}
                        {n.stageId ? ` · ${n.stageId}` : ""}
                      </span>
                      <span className="notification-owner">
                        {projects.find((p) => p.id === n.projectId)?.name ??
                          n.projectId}{" "}
                        / {n.topic || t("general.noTopic")}
                      </span>
                      <small>
                        <time dateTime={n.occurredAt}>
                          {new Date(n.occurredAt).toLocaleString(getLocale(), {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        {n.readAt && t("general.read")}
                        {n.kind === "question" && t("general.responseRequested")}
                      </small>
                    </span>
                  </button>
                  {n.readAt ? (
                    <span
                      className="notification-read-mark"
                      aria-label={t("general.read2")}
                    >
                      <CheckCheck size={16} />
                    </span>
                  ) : (
                    <HintButton
                      type="button"
                      className="notification-icon"
                      aria-label={t("general.markAsRead", { pipeline: n.pipeline })}
                      hint={t("general.markAsRead2")}
                      disabled={c.busy}
                      onClick={() => void c.read(n.id, n.sequence)}
                    >
                      <Check size={16} />
                    </HintButton>
                  )}
                </article>
              ))}
              {!s.records.length && (
                <p className="notifications-empty">{t("general.noNotificationsYet")}</p>
              )}
            </div>
            {(s.hasMore || c.older) && (
              <div className="notifications-pagination">
                {c.older && (
                  <button type="button" onClick={() => void c.latest()}>{t("general.newer")}</button>
                )}
                {s.hasMore && (
                  <button type="button" onClick={() => void c.earlier()}>{t("general.older")}</button>
                )}
              </div>
            )}
            <footer className="notifications-footer">
              <span>
                <Info size={14} />{t("general.openingThisListDoesNotMarkNotificationsAsRead")}</span>
              <label>
                <input
                  type="checkbox"
                  checked={s.systemEnabled}
                  disabled={c.busy}
                  onChange={(e) => void c.setSystem(e.target.checked)}
                />{t("general.systemNotifications")}</label>
            </footer>
          </section>
        </TopicPickerPopup>
      )}
    </div>
  );
}
