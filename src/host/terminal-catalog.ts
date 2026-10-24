import { TERMINAL_SELECTION_STALE } from "../shared/terminal-catalog";
import { randomUUID } from "node:crypto";
import { scopeRefSchema, type ScopeRef } from "../shared/context";
import {
  terminalContextSchema,
  terminalContextKey,
  terminalTabSchema,
  type TerminalContext,
  type TerminalProjectTabs,
  type TerminalRegistry,
  type TerminalTab,
} from "../shared/terminal";
import {
  terminalCatalogChangeSchema,
  type TerminalCatalogChange,
  type TerminalCatalogSnapshot,
} from "../shared/terminal-catalog";
import {
  createTerminalTab,
  initializeTerminalProject,
  moveTerminalTab,
  reorderTerminalTab,
  removeTerminalTab,
  renameTerminalTab,
  selectTerminalTab,
  visibleTerminalTabs,
} from "./terminal-tabs";
import type { TerminalStore } from "./terminal-store";
const empty = (): TerminalProjectTabs => ({
  initialized: false,
  tabs: [],
  selectedByContext: {},
});
const denied = () => Error("Вкладка терминала недоступна или данные устарели.");
/** Serial host-owned catalog. Resolving ScopeRef must verify its actual project/clone,
 * identity and initial revision; no shell/environment/path comes from the UI.
 */
export class TerminalCatalog {
  private tail: Promise<unknown> = Promise.resolve();
  private frozen = new Set<string>();
  constructor(
    private store: Pick<TerminalStore, "load" | "save">,
    private resolve: (scope: ScopeRef) => Promise<TerminalContext>,
  ) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  private async context(raw: ScopeRef): Promise<TerminalContext> {
    const scope = scopeRefSchema.parse(raw);
    let expected: TerminalContext;
    if (typeof scope === "string")
      expected = { kind: "primary", projectId: scope };
    else {
      const { revision: _, ...identity } = scope;
      expected = { kind: "topic", ...identity };
    }
    const actual = terminalContextSchema.parse(await this.resolve(scope));
    if (
      ["__proto__", "constructor", "prototype"].includes(actual.projectId) ||
      terminalContextKey(actual) !== terminalContextKey(expected)
    )
      throw denied();
    return actual;
  }
  private project(
    registry: TerminalRegistry,
    context: TerminalContext,
  ): TerminalProjectTabs {
    return Object.hasOwn(registry.projects, context.projectId)
      ? registry.projects[context.projectId]
      : empty();
  }
  private snapshot(
    registry: TerminalRegistry,
    context: TerminalContext,
  ): TerminalCatalogSnapshot {
    const state = this.project(registry, context),
      tabs = visibleTerminalTabs(state.tabs, context);
    return structuredClone({
      revision: registry.revision,
      context,
      initialized: state.initialized,
      tabs,
      selectedId:
        state.selectedByContext[terminalContextKey(context)] ??
        tabs[0]?.id ??
        null,
    });
  }
  private key(tab: TerminalTab) {
    return JSON.stringify([tab.projectId, tab.id]);
  }
  private unlocked(tab: TerminalTab) {
    if (this.frozen.has(this.key(tab)))
      throw Error("Вкладка терминала закрывается или обновляется.");
  }
  private target(
    registry: TerminalRegistry,
    context: TerminalContext,
    id: string,
    revision: string,
  ): TerminalTab {
    if (registry.revision !== revision) throw denied();
    const tab = visibleTerminalTabs(
      this.project(registry, context).tabs,
      context,
    ).find((t) => t.id === id);
    if (!tab) throw denied();
    this.unlocked(tab);
    return tab;
  }
  read(
    scope: ScopeRef,
    guard: () => void = () => {},
  ): Promise<TerminalCatalogSnapshot> {
    return this.serial(async () => {
      guard();
      const context = await this.context(scope),
        registry = await this.store.load();
      guard();
      return this.snapshot(registry, context);
    });
  }
  change(
    raw: TerminalCatalogChange,
    guard: () => void = () => {},
  ): Promise<TerminalCatalogSnapshot> {
    const parsed = terminalCatalogChangeSchema.safeParse(raw);
    if (!parsed.success) return Promise.reject(denied());
    const request = parsed.data;
    return this.serial(async () => {
      guard();
      const context = await this.context(request.scope),
        registry = await this.store.load();
      guard();
      if (registry.revision !== request.revision) {
        if (request.kind === "select") throw Error(TERMINAL_SELECTION_STALE);
        throw denied();
      }
      let state = this.project(registry, context);
      if ("tabId" in request)
        this.target(registry, context, request.tabId, request.revision);
      switch (request.kind) {
        case "initialize":
          if (state.initialized) return this.snapshot(registry, context);
          state = initializeTerminalProject(state, context, randomUUID());
          break;
        case "create":
          state = createTerminalTab(state, context, request.area, randomUUID());
          break;
        case "rename":
          state = renameTerminalTab(state, request.tabId, request.name);
          break;
        case "select":
          state = selectTerminalTab(state, context, request.tabId);
          break;
        case "reorder":
          this.target(registry, context, request.targetTabId, request.revision);
          state = {
            ...state,
            tabs: reorderTerminalTab(
              state.tabs,
              context,
              request.tabId,
              request.targetTabId,
            ),
          };
          break;
        case "move":
          state = {
            ...state,
            tabs: moveTerminalTab(
              state.tabs,
              context,
              request.tabId,
              request.direction,
            ),
          };
          break;
      }
      guard();
      registry.projects[context.projectId] = state;
      return this.snapshot(await this.store.save(registry), context);
    });
  }
  authorize(
    scope: ScopeRef,
    id: string,
    revision: string,
    guard: () => void = () => {},
  ): Promise<TerminalTab> {
    return this.serial(async () => {
      guard();
      const context = await this.context(scope),
        registry = await this.store.load();
      guard();
      return structuredClone(this.target(registry, context, id, revision));
    });
  }
  /** Host lifecycle only. Hold until safe stop AND durable metadata removal finish. */
  freeze(raw: TerminalTab): () => void {
    const tab = terminalTabSchema.parse(raw),
      key = this.key(tab);
    this.unlocked(tab);
    this.frozen.add(key);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.frozen.delete(key);
      }
    };
  }
  /** Invoked by TerminalSessions.removeTab after observed completion, never an IPC operation. */
  removeTerminatedTab(raw: TerminalTab): Promise<void> {
    const tab = terminalTabSchema.parse(raw);
    return this.serial(async () => {
      const registry = await this.store.load(),
        project = registry.projects[tab.projectId];
      const current = project?.tabs.find((t) => t.id === tab.id);
      if (
        !current ||
        JSON.stringify(current.scope) !== JSON.stringify(tab.scope)
      )
        throw denied();
      registry.projects[tab.projectId] = removeTerminalTab(project, tab.id);
      await this.store.save(registry);
    });
  }
}
