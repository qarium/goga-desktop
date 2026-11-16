import { randomUUID } from "node:crypto";
import {
  DEMO_DEFAULT_PORT,
  DEMO_DEFAULT_ENGINE,
  DEMO_EMBEDDED_START_ERROR,
  type DemoEngine,
  demoScopeKey,
  type DemoCommand,
  type DemoState,
} from "../../shared/demonstrations";
import { scopeProjectId, type ScopeRef } from "../../shared/context";
import {
  launchEmbeddedBrowser,
  launchBrowser,
  type DemoBrowser,
} from "./browser";
import { createAgentBroker } from "./transport.cjs";
import {
  InvalidDemoPreferences,
  readPreferences,
  saveEngine,
  savePort,
  type DemoPreferences,
} from "./preferences";

type Show = {
  id: string;
  key: string;
  scope: ScopeRef;
  engine: DemoEngine;
  label: string;
  browser?: DemoBrowser;
  close?: () => Promise<void>;
  closing: boolean;
  published: boolean;
};
type Options = {
  settingsFile: string;
  chromePath?: string;
  launchEmbedded?: typeof launchEmbeddedBrowser;
};
const stale = () => new Error("Показ уже закрыт или заменён.");
export class Demonstrations {
  private readonly activeShows = new Map<string, Show>();
  private readonly opening = new Map<string, number>();
  private readonly shutdown = new AbortController();
  private readonly broker = createAgentBroker({
    resolveUpstream: (id) => {
      const s = this.activeShows.get(id);
      return s?.published && !s.closing ? s.browser?.pipe : undefined;
    },
  });
  private done: Promise<void> | undefined;
  private preferences: Promise<DemoPreferences> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: Options) {}
  private configured() {
    return (this.preferences ??= readPreferences(this.options.settingsFile));
  }
  private queue<T>(f: () => Promise<T>): Promise<T> {
    const p = this.tail.catch(() => {}).then(f);
    this.tail = p;
    return p;
  }
  hasProject(id: string): boolean {
    return (
      this.opening.has(id) ||
      [...this.activeShows.values()].some((s) => scopeProjectId(s.scope) === id)
    );
  }
  shows(): DemoState["shows"] {
    return [...this.activeShows.values()]
      .filter((s) => s.published || s.closing)
      .map((s) => ({
        showId: s.id,
        engine: s.engine,
        scope: structuredClone(s.scope),
        label: s.label,
        url: s.closing ? null : (s.browser?.navigation.url ?? null),
        ...(s.closing
          ? { tabs: [], activeTabId: null }
          : s.browser?.tabSnapshot()),
      }));
  }
  async showState(id: string): Promise<DemoState["shows"][number] | null> {
    const s = this.activeShows.get(id);
    if (!s?.published || s.closing || !s.browser) return null;
    try {
      await s.browser.refreshTabs();
    } catch (error) {
      if (this.activeShows.get(id) !== s || s.closing) return null;
      throw error;
    }
    if (this.activeShows.get(id) !== s || s.closing) return null;
    return this.shows().find((show) => show.showId === id) ?? null;
  }
  async state(): Promise<DemoState> {
    // Read only each show's own browser pipe; no shared/global page discovery.
    // Browser events and UI commands remain serialized by that display.
    await Promise.all(
      [...this.activeShows.values()]
        .filter((s) => s.published && !s.closing && s.browser)
        .map(async (s) => {
          try {
            await s.browser!.refreshTabs();
          } catch (error) {
            // Stop fences/terminates its own pipe. Don't turn that expected
            // lifecycle race into a global error for unrelated live shows.
            if (this.activeShows.get(s.id) === s && !s.closing) throw error;
          }
        }),
    );
    let port = DEMO_DEFAULT_PORT,
      engine: DemoEngine = DEMO_DEFAULT_ENGINE,
      settingsError: string | undefined;
    try {
      ({ port, engine } = await this.configured());
    } catch (error) {
      if (error instanceof InvalidDemoPreferences) ({ port, engine } = error);
      settingsError =
        "Не удалось прочитать настройки демонстрации. Проверьте и сохраните порт в настройках.";
    }
    const b = this.broker.state();
    return {
      port,
      engine,
      ...(settingsError ? { settingsError } : {}),
      shows: this.shows(),
      access:
        b.slotId &&
        this.activeShows.get(b.slotId)?.published &&
        !this.activeShows.get(b.slotId)?.closing
          ? {
              owner: b.slotId,
              connectionId: b.connectionId,
              phase:
                b.phase === "connecting"
                  ? "connecting"
                  : b.phase === "connected"
                    ? "connected"
                    : "waiting",
            }
          : { owner: null, phase: "off", connectionId: null },
    };
  }
  private async open(scope: ScopeRef, label?: string, once?: "system") {
    const key = demoScopeKey(scope);
    const existing = [...this.activeShows.values()].find((s) => s.key === key);
    if (existing) {
      if (existing.closing)
        throw Error("Сначала завершите закрытие этого показа.");
      return;
    }
    const preferences = await this.configured(),
      port = preferences.port,
      engine = once ?? preferences.engine,
      id = randomUUID();
    const slot: Show = {
      id,
      key,
      scope,
      engine,
      label: label || (typeof scope === "string" ? "Без топика" : scope.topic),
      published: false,
      closing: false,
    };
    this.activeShows.set(id, slot);
    try {
      const onExit = () => {
        if (this.activeShows.get(id) !== slot || slot.closing) return;
        slot.closing = true;
        // Finish delivering the CDP detach batch, then revoke this show's
        // listener without waiting for another show's slow startup/teardown.
        queueMicrotask(() => {
          void this.broker.release(id).catch(() => {});
        });
        void this.queue(async () => {
          if (this.activeShows.get(id) === slot) await this.stop(id);
        }).catch(() => {});
      };
      const own = (close: () => Promise<void>) => {
        slot.close = close;
      };
      let browser: DemoBrowser;
      if (engine === "embedded") {
        try {
          browser = await (
            this.options.launchEmbedded ?? launchEmbeddedBrowser
          )(onExit, this.shutdown.signal, own);
        } catch (error) {
          if (this.shutdown.signal.aborted) throw stale();
          throw Error(
            DEMO_EMBEDDED_START_ERROR +
              (error instanceof Error ? error.message : "ошибка запуска."),
          );
        }
      } else {
        browser = await launchBrowser(
          this.options.chromePath,
          onExit,
          this.shutdown.signal,
          own,
        );
      }
      slot.browser = browser;
      if (this.shutdown.signal.aborted || !browser.alive()) throw stale();
      if (!this.broker.state().slotId) await this.broker.arm(id, port);
      if (this.shutdown.signal.aborted || !browser.alive()) throw stale();
      slot.published = true;
    } catch (error) {
      await this.stop(id);
      throw error;
    }
  }
  private async stop(id: string) {
    const s = this.activeShows.get(id);
    if (!s) throw stale();
    // Fence admission/snapshots before waiting, but retain ownership until both
    // the OS process and private profile actually go away. Retry is always safe.
    s.closing = true;
    await Promise.all([this.broker.release(id), s.close?.()]);
    this.activeShows.delete(id);
  }
  async execute(cmd: DemoCommand, label?: string): Promise<void> {
    if (this.shutdown.signal.aborted) throw stale();
    const project =
      cmd.action === "open" ? scopeProjectId(cmd.scope) : undefined;
    if (project)
      this.opening.set(project, (this.opening.get(project) ?? 0) + 1);
    try {
      const wait = await this.queue(async () => {
        if (this.shutdown.signal.aborted) throw stale();
        if (cmd.action === "port") {
          if (this.broker.state().slotId)
            throw new Error(
              "Сначала завершите показ, за которым закреплён порт.",
            );
          this.preferences = Promise.resolve(
            await savePort(this.options.settingsFile, cmd.port),
          );
          return;
        }
        if (cmd.action === "engine") {
          this.preferences = Promise.resolve(
            await saveEngine(this.options.settingsFile, cmd.engine),
          );
          return;
        }
        if (cmd.action === "open") {
          await this.open(structuredClone(cmd.scope), label, cmd.engine);
          return;
        }
        const s = this.activeShows.get(cmd.showId);
        if (!s) throw stale();
        if (cmd.action === "stop") {
          await this.stop(s.id);
          return;
        }
        if (s.closing || !s.published || !s.browser) throw stale();
        const { view, navigation } = s.browser,
          owner = this.broker.state();
        switch (cmd.action) {
          case "handoff":
            if (
              owner.slotId !== s.id ||
              owner.phase !== "connected" ||
              !owner.connectionId ||
              owner.connectionId !== cmd.connectionId
            )
              throw new Error("Агент уже отключился или сменился.");
            await this.broker.handoff(s.id, s.id);
            return;
          case "switch-port":
            if (owner.slotId === s.id || owner.slotId !== cmd.fromShowId)
              throw new Error("Владелец порта изменился.");
            if (owner.slotId) await this.broker.handoff(owner.slotId, s.id);
            else await this.broker.arm(s.id, (await this.configured()).port);
            return;
          // Dispatch under the generation guard, then wait outside the ownership queue.
          case "navigate":
            return { s, p: navigation.navigate(cmd.url) };
          case "reload":
            return { s, p: s.browser.reload() };
          case "tab-create":
            return { s, p: s.browser.createTab() };
          case "tab-select":
            return { s, p: s.browser.selectTab(cmd.tabId) };
          case "tab-close":
            return { s, p: s.browser.closeTab(cmd.tabId) };
          case "input": {
            // Page ownership comes from the live display selection, not the last
            // state sent to a viewer. No re-enumeration on the gesture hot path.
            if (cmd.tabId !== undefined && cmd.tabId !== view.activeTabId())
              throw stale();
            const i = cmd.input;
            switch (i.action) {
              case "pointer":
                return { s, p: view.pointer(i) };
              case "click":
                return { s, p: view.click(i.x, i.y) };
              case "scroll":
                return { s, p: view.scroll(i.x, i.y, i.deltaY) };
              case "text":
                return { s, p: view.text(i.text) };
              case "key":
                return { s, p: view.key(i.key) };
            }
          }
        }
      });
      if (wait)
        try {
          await wait.p;
        } finally {
          if (wait.s.closing || this.activeShows.get(wait.s.id) !== wait.s)
            throw stale();
        }
    } finally {
      if (project) {
        const remaining = this.opening.get(project)! - 1;
        if (remaining) this.opening.set(project, remaining);
        else this.opening.delete(project);
      }
    }
  }
  async selection(id: string, tabId: string): Promise<string> {
    const s = this.activeShows.get(id);
    if (
      !s?.browser ||
      s.closing ||
      !s.published ||
      this.shutdown.signal.aborted ||
      s.browser.view.activeTabId() !== tabId
    )
      throw stale();
    const text = await s.browser.view.selection(tabId);
    if (
      s.closing ||
      this.activeShows.get(id) !== s ||
      this.shutdown.signal.aborted ||
      s.browser.view.activeTabId() !== tabId
    )
      throw stale();
    return text;
  }
  async nextFrame(id: string, tabId: string, after: string | null) {
    const s = this.activeShows.get(id);
    if (
      !s?.browser ||
      s.closing ||
      !s.published ||
      this.shutdown.signal.aborted
    )
      throw stale();
    const frame = await s.browser.view.nextFrame(tabId, after);
    if (
      s.closing ||
      this.activeShows.get(id) !== s ||
      this.shutdown.signal.aborted
    )
      throw stale();
    // Do not expose Buffer's pooled backing store through Electron's bridge.
    return (
      frame && { cursor: frame.cursor, pixels: Uint8Array.from(frame.pixels) }
    );
  }
  async frame(id: string): Promise<Uint8Array> {
    const s = this.activeShows.get(id);
    if (
      !s?.browser ||
      s.closing ||
      !s.published ||
      this.shutdown.signal.aborted
    )
      throw stale();
    const pixels = await s.browser.view.frame();
    if (
      s.closing ||
      this.activeShows.get(id) !== s ||
      this.shutdown.signal.aborted
    )
      throw stale();
    // Electron serializes the whole backing store. Never expose a Node Buffer pool.
    return Uint8Array.from(pixels);
  }
  close(): Promise<void> {
    this.shutdown.abort();
    return (this.done ??= this.queue(async () => {
      const stopped = await Promise.allSettled(
        [...this.activeShows.keys()].map((id) => this.stop(id)),
      );
      await this.broker.close();
      if (stopped.some((r) => r.status === "rejected"))
        throw new Error("Не удалось полностью закрыть демонстрацию.");
    }).catch((error) => {
      this.done = undefined;
      throw error;
    }));
  }
}
