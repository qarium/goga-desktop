import { useEffect, useRef, useState } from "react";
import {
  NotificationSnapshotSchema,
  type NotificationSnapshot,
} from "../../shared/notifications";
import { preparationErrorMessage } from "../preparation-error";

const empty: NotificationSnapshot = {
  revision: 0,
  records: [],
  throughSequence: 0,
  hasMore: false,
  unreadCount: 0,
  byProject: {},
  unreadRunIds: [],
  systemEnabled: false,
};
export function useNotifications() {
  const [snapshot, setSnapshot] = useState(empty);
  const [open, setOpen] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(false);
  const revision = useRef(-1),
    cursor = useRef<number | undefined>(undefined),
    generation = useRef(0),
    alive = useRef(true);
  const report = (e: unknown) => {
    if (alive.current) setError(preparationErrorMessage(e));
  };
  const apply = (value: unknown) => {
    const next = NotificationSnapshotSchema.parse(value);
    if (!alive.current || next.revision < revision.current) return;
    revision.current = next.revision;
    setSnapshot(next);
    setError(next.error ?? "");
  };
  const load = async (beforeSequence?: number) => {
    const request = ++generation.current;
    cursor.current = beforeSequence;
    try {
      const next = await window.goga.notifications({ beforeSequence });
      if (request === generation.current) apply(next);
    } catch (e) {
      report(e);
    }
  };
  useEffect(() => {
    alive.current = true;
    if (
      typeof window.goga.notifications !== "function" ||
      typeof window.goga.onNotifications !== "function"
    )
      return;
    setAvailable(true);
    const off = window.goga.onNotifications((next) => {
      if (cursor.current === undefined) apply(next);
      else {
        // Keep the older page in place, but update every counter immediately.
        if (next.revision >= revision.current) {
          revision.current = next.revision;
          setSnapshot((old) => ({
            ...next,
            records: old.records,
            hasMore: old.hasMore,
          }));
        }
        void load(cursor.current);
      }
    });
    void load();
    return () => {
      alive.current = false;
      generation.current++;
      off();
    };
  }, []);
  const execute = async (action: () => Promise<NotificationSnapshot>) => {
    if (busy) return;
    setBusy(true);
    try {
      const value = await action();
      if (cursor.current === undefined) apply(value);
      else await load(cursor.current);
    } catch (e) {
      report(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return {
    snapshot,
    open,
    setOpen,
    error,
    report,
    busy,
    available,
    read: (id: string, sequence?: number) =>
      execute(() => window.goga.markNotificationRead(id, sequence)),
    readAll: () =>
      execute(() =>
        window.goga.markAllNotificationsRead(snapshot.throughSequence),
      ),
    setSystem: (enabled: boolean) =>
      execute(() => window.goga.setSystemNotifications(enabled)),
    earlier: () => load(snapshot.records.at(-1)?.sequence),
    latest: () => load(),
    older: cursor.current !== undefined,
  };
}
export type NotificationsController = ReturnType<typeof useNotifications>;
