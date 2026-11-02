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

export const notificationTitles: Record<NotificationRecord["kind"], string> = {
  question: "Нужен ваш ответ",
  approval: "Нужно подтверждение",
  "stage-failed": "Стадия завершилась с ошибкой",
  paused: "Стадия приостановлена",
  "assistant-decision": "Помощнику нужно решение",
  "run-finished": "Конвейер завершён",
  "run-failed": "Конвейер завершился с ошибкой",
  "process-exited": "Процесс конвейера завершён",
};
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
      <button
        ref={anchor}
        type="button"
        className="notification-bell"
        aria-label={`Уведомления: ${s.unreadCount} непрочитанных`}
        aria-expanded={c.open}
        onClick={() => c.setOpen(!c.open)}
        title="Уведомления"
      >
        <Bell size={18} />
        {s.unreadCount > 0 && (
          <span className="notification-count">
            {s.unreadCount > 99 ? "99+" : s.unreadCount}
          </span>
        )}
      </button>
      {c.open && (
        <TopicPickerPopup
          anchor={anchor}
          onClose={close}
          label="Уведомления"
          width={400}
        >
          <section
            ref={panel}
            className="topic-context-popup notifications-panel"
            aria-label="Список уведомлений"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <header className="notifications-heading">
              <div>
                <h2>Уведомления</h2>
                <p aria-live="polite">
                  {s.unreadCount
                    ? `Непрочитанных: ${s.unreadCount}`
                    : "Всё прочитано"}
                </p>
              </div>
              <div className="notifications-heading-actions">
                <button
                  type="button"
                  className="notification-icon"
                  aria-label="Отметить все прочитанными"
                  title="Отметить все прочитанными"
                  disabled={c.busy || !s.unreadCount}
                  onClick={() => void c.readAll()}
                >
                  <CheckCheck size={17} />
                </button>
                <button
                  type="button"
                  className="notification-icon"
                  aria-label="Закрыть уведомления"
                  title="Закрыть уведомления"
                  onClick={close}
                >
                  <X size={17} />
                </button>
              </div>
            </header>
            {c.error && (
              <p className="notifications-error" role="alert">
                {c.error}
                <button type="button" onClick={() => void c.latest()}>
                  Повторить
                </button>
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
                    aria-label={`Открыть уведомление: ${notificationTitles[n.kind]}, ${projects.find((p) => p.id === n.projectId)?.name ?? n.projectId}, ${n.pipeline}`}
                    onClick={() => void open(n.id)}
                  >
                    <span className="notification-symbol">
                      <EventIcon kind={n.kind} />
                    </span>
                    <span className="notification-event-copy">
                      <strong>
                        {notificationTitles[n.kind]}
                        {!n.readAt && <i className="notification-new-dot" />}
                      </strong>
                      <span>
                        {n.pipeline}
                        {n.stageId ? ` · ${n.stageId}` : ""}
                      </span>
                      <span className="notification-owner">
                        {projects.find((p) => p.id === n.projectId)?.name ??
                          n.projectId}{" "}
                        / {n.topic || "Без топика"}
                      </span>
                      <small>
                        <time dateTime={n.occurredAt}>
                          {new Date(n.occurredAt).toLocaleString("ru-RU", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        {n.readAt && " · Прочитано"}
                        {n.kind === "question" && " · Запрос ответа"}
                      </small>
                    </span>
                  </button>
                  {n.readAt ? (
                    <span
                      className="notification-read-mark"
                      aria-label="Прочитано"
                    >
                      <CheckCheck size={16} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="notification-icon"
                      aria-label={`Отметить ${n.pipeline} прочитанным`}
                      title="Отметить прочитанным"
                      disabled={c.busy}
                      onClick={() => void c.read(n.id, n.sequence)}
                    >
                      <Check size={16} />
                    </button>
                  )}
                </article>
              ))}
              {!s.records.length && (
                <p className="notifications-empty">Уведомлений пока нет</p>
              )}
            </div>
            {(s.hasMore || c.older) && (
              <div className="notifications-pagination">
                {c.older && (
                  <button type="button" onClick={() => void c.latest()}>
                    К новым
                  </button>
                )}
                {s.hasMore && (
                  <button type="button" onClick={() => void c.earlier()}>
                    Более ранние
                  </button>
                )}
              </div>
            )}
            <footer className="notifications-footer">
              <span>
                <Info size={14} />
                Открытие списка не отмечает уведомления прочитанными.
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={s.systemEnabled}
                  disabled={c.busy}
                  onChange={(e) => void c.setSystem(e.target.checked)}
                />
                Системные уведомления
              </label>
            </footer>
          </section>
        </TopicPickerPopup>
      )}
    </div>
  );
}
