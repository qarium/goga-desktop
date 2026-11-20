import { t } from "../shared/i18n";
import type { DemoShow } from "../shared/demonstrations";

interface SelectionReader {
  shows(): DemoShow[];
  selection(showId: string, tabId: string): Promise<string>;
}
const MAX_BYTES = 1024 * 1024;
const stale = () => Error(t("native.selectionGone"));
function ownsPage(reader: SelectionReader, showId: string, tabId: string) {
  const show = reader.shows().find((s) => s.showId === showId);
  return (
    show?.activeTabId === tabId && show.tabs?.some((t) => t.tabId === tabId)
  );
}

// Selected text stays in the trusted main process. The UI can request a copy or
// revoke its own pending request, but cannot supply text or a browser target.
export function createDemoSelectionClipboard(
  reader: SelectionReader,
  writeText: (text: string) => Promise<void>,
) {
  let closed = false;
  const pending = new Map<string, () => void>();
  const canceled = new Set<string>(),
    used = new Set<string>();
  const remember = (set: Set<string>, id: string) => {
    set.add(id);
    if (set.size > 512) set.delete(set.values().next().value!);
  };
  return {
    async copy(
      showId: string,
      tabId: string,
      requestId: string,
    ): Promise<boolean> {
      if (closed || canceled.has(requestId)) return false;
      if (used.has(requestId) || pending.has(requestId))
        throw Error(t("native.copyRequestUsed"));
      if (!ownsPage(reader, showId, tabId)) throw stale();
      if (pending.size >= 8) throw Error(t("native.copyBusy"));
      let cancel!: () => void, timer: ReturnType<typeof setTimeout>;
      const cancellation = new Promise<null>((resolve) => {
        cancel = () => resolve(null);
      });
      pending.set(requestId, cancel);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Error(
                t("native.selectionReadFailed"),
              ),
            ),
          10000,
        );
        timer.unref?.();
      });
      try {
        const text = await Promise.race([
          reader.selection(showId, tabId),
          cancellation,
          timeout,
        ]);
        if (closed || canceled.has(requestId) || text === null) return false;
        if (!ownsPage(reader, showId, tabId)) throw stale();
        if (
          typeof text !== "string" ||
          Buffer.byteLength(text, "utf8") > MAX_BYTES
        )
          throw Error(t("native.selectionTooLarge"));
        if (!text) return false; // Preserve the existing system clipboard.
        try {
          await writeText(text);
        } catch {
          throw Error(
            t("native.selectionCopyFailed"),
          );
        }
        return true;
      } finally {
        clearTimeout(timer!);
        pending.delete(requestId);
        remember(used, requestId);
      }
    },
    cancel(requestId: string) {
      remember(canceled, requestId);
      pending.get(requestId)?.();
    },
    close() {
      closed = true;
      for (const cancel of pending.values()) cancel();
      pending.clear();
    },
  };
}
