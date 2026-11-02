import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { NotificationDelivery } from "../src/main/notification-delivery";
const n: any = {
  id: "n",
  sequence: 1,
  kind: "question",
  projectId: "p",
  runId: "r",
  pipeline: "editor",
  stageId: "worker",
  topic: "topic",
  branch: "feat",
  occurredAt: "2026-11-01T12:00:00.000Z",
  readAt: null,
};
const snapshot: any = {
  revision: 1,
  records: [n],
  throughSequence: 1,
  hasMore: false,
  unreadCount: 1,
  byProject: { p: 1 },
  unreadRunIds: ["r"],
  systemEnabled: true,
};
function setup() {
  const notices: any[] = [];
  const d = {
    create: vi.fn(() => {
      const notice = Object.assign(new EventEmitter(), {
        show: vi.fn(),
        close: vi.fn(),
      });
      notices.push(notice);
      return notice;
    }),
    badge: vi.fn(),
    open: vi.fn(),
    isViewing: vi.fn(() => false),
    find: () => n,
    onError: vi.fn(),
  };
  return { delivery: new NotificationDelivery(d), d, notices };
}
it("restores badge without replaying system notifications and attempts a new event once", () => {
  const { delivery, d, notices } = setup();
  delivery.update(snapshot);
  expect(d.badge).toHaveBeenCalledWith("1");
  expect(d.create).not.toHaveBeenCalled();
  delivery.update(snapshot, n);
  delivery.update(snapshot, n);
  expect(d.create).toHaveBeenCalledOnce();
  notices[0].emit("click");
  expect(d.open).toHaveBeenCalledWith("n");
});
it("disabled delivery and a visible run retain unread counts without banners", () => {
  const { delivery, d } = setup();
  delivery.update({ ...snapshot, systemEnabled: false }, n);
  expect(d.create).not.toHaveBeenCalled();
  d.isViewing.mockReturnValue(true);
  delivery.update({ ...snapshot, revision: 2 }, { ...n, id: "n2" });
  expect(d.create).not.toHaveBeenCalled();
  expect(d.badge).toHaveBeenCalledWith("1");
});
it("clears only its own banner on read and reports failed delivery without changing unread", () => {
  const { delivery, d, notices } = setup();
  delivery.update(snapshot, n);
  notices[0].emit("failed", {}, "secret external detail");
  expect(d.onError).toHaveBeenCalledWith(expect.not.stringContaining("secret"));
  notices[0].emit("show");
  expect(d.onError).toHaveBeenLastCalledWith("");
  d.find = () => ({ ...n, readAt: "2026-11-01T13:00:00.000Z" });
  delivery.update({
    ...snapshot,
    revision: 2,
    unreadCount: 0,
    records: [d.find()],
  });
  expect(d.badge).toHaveBeenLastCalledWith("");
  expect(notices[0].close).toHaveBeenCalled();
});
it("reattaches only known unread OS history without showing it again", () => {
  const { delivery, d } = setup();
  const restored = Object.assign(new EventEmitter(), {
    id: "n",
    show: vi.fn(),
    close: vi.fn(),
  });
  delivery.restore([restored]);
  restored.emit("click");
  expect(d.open).toHaveBeenCalledWith("n");
  expect(restored.show).not.toHaveBeenCalled();
});

it("never sends a banner for an arrival already read while viewing, even after focus changes", () => {
  const { delivery, d } = setup();
  const read = { ...n, readAt: "2026-11-02T12:00:00.000Z" };
  delivery.update({ ...snapshot, unreadCount: 0, records: [read] }, read);
  expect(d.create).not.toHaveBeenCalled();
});
