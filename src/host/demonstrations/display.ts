import { t } from "../../shared/i18n";
import { randomUUID } from "node:crypto";
import { createLiveView } from "./live-view.cjs";
import { trackPage } from "./navigation.cjs";
import type { PipeTarget } from "./transport.cjs";

type Page = {
  id: string;
  tabId: string;
  lost: boolean;
  navigation?: Awaited<ReturnType<typeof trackPage>>;
  view?: ReturnType<typeof createLiveView>;
};
type Tab = { id: string; tabId: string; title: string; url: string | null };
const cleanText = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
function cleanURL(raw: unknown): string | null {
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return null;
  try {
    const url = new URL(cleanText(raw));
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}
function cleanTitle(raw: unknown) {
  return (typeof raw === "string" ? cleanText(raw) : "")
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => cleanURL(url) ?? "")
    .slice(0, 512);
}

// One selection owns pixels, gestures and address. The raw browser target IDs
// never leave this host-owned catalogue; aliases are unique to this one show.
export async function createPageDisplay(
  pipe: PipeTarget,
  initialId: string,
  onLost: () => void,
) {
  let current: Page | undefined,
    tabs: Tab[] = [],
    neighborIndex = 0,
    closed = false,
    failed = false,
    recovering = false,
    tail: Promise<void> = Promise.resolve(),
    closing: Promise<void> | undefined;
  const retired = new Set<Promise<void>>();
  const unavailable = () => Error(t("hostTerminal.pageReplaced"));
  const requireOpen = () => {
    if (closed) throw unavailable();
  };
  const release = async (page: Page | undefined) => {
    // Hold navigation only while input needs its document fence. A stalled
    // background capture alone must not keep a retired navigation alive.
    const inputActive = page?.view?.hasInputActivity();
    const viewClosed = page?.view?.close();
    const navigationClosed = inputActive
      ? viewClosed?.catch(() => {}).then(() => page?.navigation?.close())
      : page?.navigation?.close();
    const results = await Promise.allSettled([viewClosed, navigationClosed]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  function retire(page: Page | undefined) {
    if (!page) return;
    // Closing admission and navigation is immediate. Screenshot/input cleanup
    // belongs to the host, but may not block the new selection's acknowledgement.
    const task = release(page);
    retired.add(task);
    void task.then(
      () => retired.delete(task),
      () => {}, // Retain failures for final close, without an unhandled rejection.
    );
  }
  function selected() {
    requireOpen();
    if (!current || current.lost) throw unavailable();
    return current;
  }
  function run(operation: () => Promise<void>): Promise<void> {
    if (closed) return Promise.reject(unavailable());
    const task = tail
      .catch(() => {})
      .then(async () => {
        requireOpen();
        await operation();
      });
    tail = task;
    return task;
  }
  async function catalogue() {
    requireOpen();
    const { targetInfos } = await pipe.command("Target.getTargets");
    requireOpen();
    const pages = new Map(
      targetInfos
        .filter((p) => p.type === "page" && typeof p.targetId === "string")
        .map((p) => [p.targetId, p]),
    );
    const previousIndex = tabs.findIndex((tab) => tab.id === current?.id);
    // Browser enumeration order is not stable. Keep existing aliases/order and
    // append genuinely new tabs, including those created by an attached agent.
    tabs = tabs.filter((tab) => pages.has(tab.id));
    for (const [id, page] of pages) {
      let tab = tabs.find((tab) => tab.id === id);
      if (!tab) {
        tab = { id, tabId: randomUUID(), title: "", url: null };
        tabs.push(tab);
      }
      tab.title = cleanTitle(page.title);
      tab.url = cleanURL(page.url);
    }
    if (current && !pages.has(current.id)) {
      current.lost = true;
      if (previousIndex >= 0) neighborIndex = previousIndex;
    }
  }
  async function bind(id: string) {
    requireOpen();
    if (current?.id === id && !current.lost) return;
    const tab = tabs.find((tab) => tab.id === id);
    if (!tab) throw unavailable();
    const next: Page = { id, tabId: tab.tabId, lost: false };
    try {
      next.navigation = await trackPage(pipe, id, () => {
        next.lost = true;
        // Detached sessions from retired selections never affect this show.
        if (!closed && current === next) recoverSoon();
      });
      requireOpen();
      if (next.lost) throw unavailable();
      next.view = createLiveView(pipe, {
        targetId: id,
        ownsPage: () => current === next && !next.lost && !closed,
      });
    } catch (error) {
      await release(next);
      throw error;
    }
    const previous = current;
    current = next;
    neighborIndex = tabs.findIndex((tab) => tab.id === id);
    retire(previous);
  }
  async function activate(id: string) {
    requireOpen();
    await pipe.command("Target.activateTarget", { targetId: id });
    requireOpen();
    await bind(id);
  }
  async function newPage() {
    requireOpen();
    const result = (await pipe.command("Target.createTarget", {
      url: "about:blank",
    })) as { targetId?: string };
    requireOpen();
    await catalogue();
    if (!result.targetId || !tabs.some((tab) => tab.id === result.targetId))
      throw unavailable();
    await activate(result.targetId);
  }
  async function recover() {
    requireOpen();
    const page = current;
    if (page && !page.lost && tabs.some((tab) => tab.id === page.id)) return;
    if (!tabs.length) {
      await newPage();
      return;
    }
    // The right neighbor now occupies the removed tab's old index; if it was
    // the last tab, use the nearest tab to the left. Browser target lists are
    // snapshots: make a second finite sweep for pages created during the first.
    const attempted = new Set<string>();
    let failure: unknown;
    for (let sweep = 0; sweep < 2; ++sweep) {
      const index = Math.min(neighborIndex, tabs.length - 1);
      const choices = [
        ...tabs.slice(index),
        ...tabs.slice(0, index).reverse(),
      ].filter((tab) => !attempted.has(tab.id));
      for (const tab of choices) {
        attempted.add(tab.id);
        try {
          await activate(tab.id);
          return;
        } catch (error) {
          requireOpen();
          failure = error;
        }
      }
      await catalogue();
      if (!tabs.length) {
        await newPage();
        return;
      }
      if (tabs.every((tab) => attempted.has(tab.id))) throw failure;
    }
    // Further new pages are not proven unavailable. Yield a bounded task rather
    // than chasing continuous browser churn forever or revoking a healthy show.
    // An in-progress recovery schedules this in its finally recheck below.
    recoverSoon();
  }

  function recoverSoon() {
    if (closed || failed || recovering) return;
    recovering = true;
    // Queue behind already-confirmed agent activations. A detach and activation
    // response may be delivered in one pipe chunk, with no Promise hop between.
    void run(async () => {
      await catalogue();
      await recover();
    })
      .catch(() => {
        if (!closed && !failed) {
          failed = true;
          onLost();
        }
      })
      .finally(() => {
        recovering = false;
        // A replacement can detach before the recovery task settles. Its loss
        // must not be swallowed by the in-progress recovery guard.
        if (!closed && !failed && current?.lost) recoverSoon();
      });
  }
  const unsubscribe = pipe.onPageActivated((id) =>
    run(async () => {
      await catalogue();
      await bind(id);
    }),
  );
  function close() {
    closed = true;
    unsubscribe();
    return (closing ??= tail
      .catch(() => {})
      .then(async () => {
        // All selections are fenced and drained before taking this complete set.
        const results = await Promise.allSettled([
          release(current),
          ...retired,
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }));
  }
  try {
    await run(async () => {
      await catalogue();
      await bind(initialId);
    });
  } catch (error) {
    await close();
    throw error;
  }
  function activeTabId() {
    return !closed && current && !current.lost ? current.tabId : null;
  }
  const view = {
    activeTabId,
    async nextFrame(tabId: string, after: string | null) {
      const page = selected();
      const matches = () => selected() === page && page.tabId === tabId;
      if (!matches()) throw unavailable();
      const data = await page.view!.nextFrame(after);
      if (!matches()) throw unavailable();
      return data;
    },
    async frame() {
      const page = selected();
      try {
        const data = await page.view!.frame();
        // A late capture cannot overwrite the new selection's pixels/address.
        if (selected() !== page) throw unavailable();
        return data;
      } catch (error) {
        if (closed || current !== page || page.lost) throw unavailable();
        throw error;
      }
    },
    click: (x: number, y: number) => selected().view!.click(x, y),
    pointer: (
      input: Parameters<ReturnType<typeof createLiveView>["pointer"]>[0],
    ) => selected().view!.pointer(input),
    async selection(tabId: string) {
      const page = selected();
      if (page.tabId !== tabId) throw unavailable();
      const text = await page.view!.selection();
      if (selected() !== page || page.tabId !== tabId) throw unavailable();
      return text;
    },
    scroll: (x: number, y: number, dy: number) =>
      selected().view!.scroll(x, y, dy),
    key: (key: string) => selected().view!.key(key),
    text: (text: string) => selected().view!.text(text),
    close,
  };
  return {
    view,
    navigation: {
      get url() {
        return current && !current.lost
          ? cleanURL(current.navigation?.url)
          : null;
      },
      navigate: (url: string) => selected().navigation!.navigate(url),
      close,
    },
    refreshTabs: () =>
      run(async () => {
        await catalogue();
        await recover();
      }),
    tabSnapshot() {
      const page = current;
      return {
        tabs: closed
          ? []
          : tabs.map(({ tabId, title, url, id }) => ({
              tabId,
              title,
              url:
                page && id === page.id && !page.lost
                  ? cleanURL(page.navigation?.url)
                  : url,
            })),
        activeTabId: activeTabId(),
      };
    },
    createTab: () => run(newPage),
    selectTab: (tabId: string) =>
      run(async () => {
        // Treat aliases as untrusted input, even if they were valid in an old
        // snapshot. Only this browser's current page catalogue grants access.
        await catalogue();
        const tab = tabs.find((tab) => tab.tabId === tabId);
        if (!tab) throw unavailable();
        await activate(tab.id);
      }),
    closeTab: (tabId: string) =>
      run(async () => {
        await catalogue();
        const tab = tabs.find((tab) => tab.tabId === tabId);
        if (!tab) throw unavailable();
        const result = (await pipe.command("Target.closeTarget", {
          targetId: tab.id,
        })) as { success?: boolean };
        requireOpen();
        if (result.success === false) throw unavailable();
        await catalogue();
        await recover();
      }),
    async reload() {
      const page = selected(),
        session = await pipe.attachHostPage(page.id);
      try {
        if (selected() !== page) throw unavailable();
        await session.command("Page.reload");
      } finally {
        await session.close();
      }
    },
    close,
  };
}
