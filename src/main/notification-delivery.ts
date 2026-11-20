import type { MessageKey } from "../shared/locale-packs.generated";
import { t } from "../shared/i18n";
import type {
  NotificationRecord,
  NotificationSnapshot,
} from "../shared/notifications";
interface NativeNotice {
  show(): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeAllListeners?(): unknown;
}
const titles: Record<NotificationRecord["kind"], Extract<MessageKey, `native.${string}`>> = {
  question: "native.noticeQuestion",
  approval: "native.noticeApproval",
  "stage-failed": "native.noticeStageFailed",
  paused: "native.noticePaused",
  "assistant-decision": "native.noticeAssistant",
  "run-finished": "native.noticeFinished",
  "run-failed": "native.noticeFailed",
  "process-exited": "native.noticeProcessExited",
};
/** Native delivery is a consumer, never the source of unread state. */
export class NotificationDelivery {
  private notices = new Map<string, NativeNotice>();
  private attempted = new Map<string, number>();
  private revision = -1;
  constructor(
    private d: {
      create: (options: {
        id: string;
        title: string;
        body: string;
      }) => NativeNotice;
      badge: (count: string) => void;
      open: (id: string) => void;
      isViewing: (runId: string) => boolean;
      find: (id: string) => NotificationRecord | undefined;
      onError: (message: string) => void;
    },
  ) {}
  restore(history: (NativeNotice & { id: string })[]) {
    for (const notice of history) {
      const record = this.d.find(notice.id);
      if (!record || this.notices.has(notice.id)) continue;
      if (record.readAt) {
        try {
          notice.close();
        } catch {}
        continue;
      }
      this.notices.set(notice.id, notice);
      this.attempted.set(notice.id, record.sequence);
      notice.on("click", () => this.d.open(notice.id));
    }
  }
  update(s: NotificationSnapshot, added?: NotificationRecord) {
    if (s.revision < this.revision) return;
    this.revision = s.revision;
    try {
      this.d.badge(s.unreadCount ? String(s.unreadCount) : "");
    } catch {
      this.d.onError(
        t("native.badgeFailed"),
      );
    }
    for (const [id, n] of this.notices)
      if (this.d.find(id)?.readAt || !s.systemEnabled) {
        try {
          n.close();
        } catch {
          /* Delivery cannot undo read state. */
        }
        this.notices.delete(id);
      }
    if (!added || this.attempted.get(added.id) === added.sequence) return;
    this.attempted.set(added.id, added.sequence);
    if (
      added.readAt !== null ||
      !s.systemEnabled ||
      this.d.isViewing(added.runId)
    )
      return;
    try {
      this.notices.get(added.id)?.close();
      // No task/question/agent text or executable paths are copied to the OS.
      const body = [added.pipeline, added.stageId, added.topic || t("native.noTopic")]
        .filter(Boolean)
        .join(" · ")
        .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
        .slice(0, 160);
      const notice = this.d.create({
        id: added.id,
        title: t(titles[added.kind]),
        body,
      });
      this.notices.set(added.id, notice);
      notice.on("click", () => this.d.open(added.id));
      notice.on("show", () => this.d.onError(""));
      notice.on("failed", () =>
        this.d.onError(
          t("native.bannerFailed"),
        ),
      );
      notice.show();
    } catch {
      this.d.onError(
        t("native.bannersUnavailable"),
      );
    }
  }
  dispose() {
    for (const n of this.notices.values()) n.removeAllListeners?.();
    this.notices.clear();
    this.attempted.clear();
  }
}
